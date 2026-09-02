/** v2.12: Derived claim provenance — the runtime's honest view of which
 *  agent-reported criteria completions are backed by machine evidence.
 *
 *  Pure functions, no persistence. The inputs (evaluation + round evidence +
 *  verification flags) are already committed in the round transaction
 *  snapshot, so every claim view can be re-derived deterministically for
 *  audit and handoff purposes.
 *
 *  Rules (honesty first — machine evidence is the only upgrade path):
 *  - every `success_criteria_met` entry is a claim, `claimed` by default;
 *  - upgraded to `verified` only when a machine-verifiable test pass is
 *    observed (test results with 0 failures AND a passed after-phase
 *    command snapshot);
 *  - downgraded to `contradicted` when error-level verification flags say
 *    the machine contradicted the claim.
 */

import type { VaultEntry } from "./loop-store.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { SelfEvaluation, VerificationFlag } from "./protocol.js";
import { isRecord } from "./token-utils.js";
export interface DerivedClaim {
  /** Success criterion text as reported by the agent. */
  targetId: string;
  status: "verified" | "claimed" | "contradicted";
  source: "agent" | "command" | "provider" | "verification";
  /** Machine evidence reference, e.g. "command:npm-test". */
  ref?: string;
  detail?: string;
}

export interface ClaimView {
  claims: DerivedClaim[];
  verifiedCount: number;
  contradictedCount: number;
  /** True when any machine-observable test evidence exists this round. */
  hasMachineEvidence: boolean;
}

/** Contradicting error flags that invalidate agent claims. */
// NOTE: keep these as literals — importing the CHECK_* constants here would
// create a verification-gate ⇄ evidence-claims import cycle.
const CONTRADICTING_CHECKS = new Set([
  "required_command_failed",
  "command_evidence_mismatch",
  "success_with_remaining_criteria",
]);

function hasPassingTestEvidence(selfEval: SelfEvaluation): boolean {
  const results = selfEval.execution_evidence?.test_results;
  return results !== null &&
    results !== undefined &&
    results.failed === 0 &&
    results.passed > 0;
}

function hasPassedAfterCommand(snapshots: ProviderSnapshot[]): boolean {
  return snapshots.some((snapshot) =>
    isRecord(snapshot.data) &&
    snapshot.data.kind === "command" &&
    snapshot.data.phase === "after" &&
    snapshot.data.status === "passed");
}

/** Derive the runtime claim view for a round. No file-level or text-level
 *  guessing: git observations only serve the evidence_integrity warn. */
export function deriveClaimView(
  selfEval: SelfEvaluation,
  evidenceSnapshots: ProviderSnapshot[],
): ClaimView {
  const met = selfEval.execution_evidence?.success_criteria_met ?? [];
  const machineVerified = hasPassingTestEvidence(selfEval) &&
    hasPassedAfterCommand(evidenceSnapshots);
  const claims: DerivedClaim[] = met.map((targetId) => ({
    targetId,
    status: machineVerified ? "verified" : "claimed",
    source: machineVerified ? "command" : "agent",
  }));
  return {
    claims,
    verifiedCount: claims.filter((claim) => claim.status === "verified").length,
    contradictedCount: 0,
    // v3.3: machine evidence requires a passed after-phase command observed
    // by the runtime itself — the agent's self-reported test_results are a
    // claim, not evidence. Without a passed command, R8 and the
    // criteria-claims check can no longer be satisfied by fabrication.
    hasMachineEvidence: hasPassingTestEvidence(selfEval) &&
      hasPassedAfterCommand(evidenceSnapshots),
  };
}

/** Re-derive a claim view including the contradiction downgrade driven by
 *  verification flags. Used by audit and listVerifiedClaims on persisted
 *  snapshots; the live round path uses deriveClaimView only. */
export function rederiveClaimViewWithFlags(
  selfEval: SelfEvaluation,
  evidenceSnapshots: ProviderSnapshot[],
  flags: VerificationFlag[],
): ClaimView {
  const view = deriveClaimView(selfEval, evidenceSnapshots);
  const contradicted = flags.some((flag) =>
    flag.severity === "error" && CONTRADICTING_CHECKS.has(flag.check));
  if (contradicted) {
    view.claims = view.claims.map((claim) => ({
      ...claim,
      status: "contradicted" as const,
      source: "verification" as const,
    }));
    view.verifiedCount = 0;
    view.contradictedCount = view.claims.length;
  }
  return view;
}

function committedTransaction(entry: VaultEntry): Record<string, unknown> | null {
  if (!isRecord(entry.loop_lineage)) return null;
  const transaction = entry.loop_lineage.round_transaction;
  if (!isRecord(transaction) || !isRecord(transaction.snapshot)) return null;
  return transaction;
}

/** Files actually changed in a committed round (git provider, after evidence
 *  preferred). Returns null when the round has no observable git snapshot. */
export function resolveRoundFiles(
  vaultEntries: VaultEntry[],
  loopId: string,
  round: number,
): string[] | null {
  const feedback = vaultEntries.find((entry) =>
    String(entry.task_id ?? "") === `loop:${loopId}:r${round}:feedback`);
  const transaction = feedback ? committedTransaction(feedback) : null;
  if (!transaction) return null;
  const snapshot = transaction.snapshot as Record<string, unknown>;
  const evidence = Array.isArray(snapshot.afterEvidence)
    ? snapshot.afterEvidence as unknown[]
    : Array.isArray(snapshot.roundEvidence)
      ? snapshot.roundEvidence as unknown[]
      : Array.isArray(snapshot.beforeEvidence)
        ? snapshot.beforeEvidence as unknown[]
        : [];
  const git = evidence.find((item) =>
    isRecord(item) && item.provider === "git" && Array.isArray(item.files)) as
    Record<string, unknown> | undefined;
  if (!git) return null;
  return (git.files as unknown[]).filter((file): file is string => typeof file === "string");
}

/** Stable cr-IDs (and criterion texts) backed by verified claims across all
 *  committed rounds. Criterion texts are mapped to cr-IDs by callers that
 *  know the objective; this returns the raw verified targets. */
export function listVerifiedClaims(
  vaultEntries: VaultEntry[],
  loopId: string,
): string[] {
  const verified = new Set<string>();
  for (const entry of vaultEntries) {
    const taskId = String(entry.task_id ?? "");
    if (!taskId.startsWith(`loop:${loopId}:r`) || !taskId.endsWith(":feedback")) continue;
    const transaction = committedTransaction(entry);
    if (!transaction) continue;
    const snapshot = transaction.snapshot as Record<string, unknown>;
    const evaluation = isRecord(snapshot.evaluation)
      ? snapshot.evaluation as unknown as SelfEvaluation
      : null;
    const result = isRecord(snapshot.result) ? snapshot.result : null;
    if (!evaluation || !result || !Array.isArray(result.verificationFlags)) continue;
    const evidence = Array.isArray(snapshot.afterEvidence)
      ? snapshot.afterEvidence as ProviderSnapshot[]
      : Array.isArray(snapshot.roundEvidence)
        ? snapshot.roundEvidence as ProviderSnapshot[]
        : [];
    const view = rederiveClaimViewWithFlags(
      evaluation,
      evidence,
      result.verificationFlags as VerificationFlag[],
    );
    for (const claim of view.claims) {
      if (claim.status === "verified") verified.add(claim.targetId);
    }
  }
  return [...verified];
}
