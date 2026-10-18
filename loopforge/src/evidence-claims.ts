/** v2.12: Derived claim provenance — the runtime's honest view of which
 *  agent-reported criteria completions are backed by machine evidence.
 *
 *  Pure functions, no persistence. The inputs (evaluation + round evidence +
 *  verification flags) are already committed in the round transaction
 *  snapshot, so every claim view can be re-derived deterministically for
 *  audit and handoff purposes.
 *
 *  Rules (honesty first — machine evidence is the only upgrade path):
 *  - every met `criterion_claims` entry is a claim, `claimed` by default;
 *  - upgraded to `verified` only when a machine-verifiable test pass is
 *    observed (test results with 0 failures AND a passed after-phase
 *    command snapshot);
 *  - downgraded to `contradicted` when error-level verification flags say
 *    the machine contradicted the claim.
 */

import type { VaultEntry } from "./loop-store.js";
import { readOnlyRounds } from "./committed-round.js";
import type { ObservationDelta } from "./evidence-provider.js";
import {
  afterObservations,
  gitDeltaState,
  isPassedAfterObservation,
} from "./evidence-provider.js";
import { claimedMetCriteria } from "./self-eval.js";
import type { SelfEvaluation, VerificationFlag } from "./protocol.js";
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
  const results = selfEval.execution_report?.tests_reported;
  return results !== null &&
    results !== undefined &&
    results.failed === 0 &&
    results.passed > 0;
}

function hasPassedAfterCommand(deltas: ReadonlyArray<ObservationDelta>): boolean {
  // v3.8: ONE predicate — the gate's entrypoint-tamper exclusion and this
  // module's check were two divergent definitions of "machine-backed".
  const git = gitDeltaState(deltas);
  return afterObservations(deltas)
    .some((observation) => isPassedAfterObservation(observation, git));
}

/** Derive the runtime claim view for a round. No file-level or text-level
 *  guessing: git observations only serve the evidence_integrity warn. */
export function deriveClaimView(
  selfEval: SelfEvaluation,
  evidenceDeltas: ReadonlyArray<ObservationDelta>,
): ClaimView {
  const met = claimedMetCriteria(selfEval.execution_report);
  const machineVerified = hasPassingTestEvidence(selfEval) &&
    hasPassedAfterCommand(evidenceDeltas);
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
    // by the runtime itself — the agent's self-reported tests_reported are a
    // claim, not evidence. Without a passed command, R8 and the
    // criteria-claims check can no longer be satisfied by fabrication.
    hasMachineEvidence: hasPassingTestEvidence(selfEval) &&
      hasPassedAfterCommand(evidenceDeltas),
  };
}

/** Re-derive a claim view including the contradiction downgrade driven by
 *  verification flags. Used by audit and listVerifiedClaims on persisted
 *  snapshots; the live round path uses deriveClaimView only. */
export function rederiveClaimViewWithFlags(
  selfEval: SelfEvaluation,
  evidenceDeltas: ReadonlyArray<ObservationDelta>,
  flags: VerificationFlag[],
): ClaimView {
  const view = deriveClaimView(selfEval, evidenceDeltas);
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

/** Files actually changed in a committed round — the shared observation
 *  delta, not the full after snapshot. Returns null when the round has no
 *  observable Git boundary. */
export function resolveRoundFiles(
  vaultEntries: VaultEntry[],
  loopId: string,
  round: number,
): string[] | null {
  const committed = readOnlyRounds(vaultEntries)
    .find((view) => view.loopId === loopId && view.round === round);
  if (!committed || committed.evidenceIncomplete) return null;
  const git = committed.observationDelta.find((delta) => delta.kind === "git");
  if (!git || git.changedFiles === null) return null;
  return [...git.changedFiles];
}

/** Stable cr-IDs (and criterion texts) backed by verified claims across all
 *  committed rounds. Criterion texts are mapped to cr-IDs by callers that
 *  know the objective; this returns the raw verified targets. */
export function listVerifiedClaims(
  vaultEntries: VaultEntry[],
  loopId: string,
): string[] {
  const verified = new Set<string>();
  for (const round of readOnlyRounds(vaultEntries)) {
    if (round.loopId !== loopId || !round.evaluation) continue;
    // v3.9.1: claims are checked against what THAT round changed, not the
    // whole after-snapshot (which would include pre-existing dirt).
    const view = rederiveClaimViewWithFlags(
      round.evaluation,
      round.observationDelta,
      round.verificationFlags,
    );
    for (const claim of view.claims) {
      if (claim.status === "verified") verified.add(claim.targetId);
    }
  }
  return [...verified];
}
