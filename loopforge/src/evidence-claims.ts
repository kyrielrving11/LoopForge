/** v2.12/v4.0.3: Derived claim provenance — the runtime's honest view of
 *  which Agent-reported criteria completions are backed by machine evidence.
 *
 *  v4.0.3 changes the ONLY upgrade path: a claim becomes `verified` when its
 *  criterion id is in the machine-verified set. Agent-reported test counts
 *  (`tests_reported`) are never evidence and can no longer upgrade a claim.
 *
 *  Pure functions, no persistence. The inputs (evaluation, machine criterion
 *  facts, verification flags) are already committed, so every claim view can
 *  be re-derived deterministically for audit and handoff purposes.
 */

import type { VaultEntry } from "./loop-store.js";
import { readOnlyRounds } from "./committed-round.js";
import type { ActiveContractView } from "./round-contract.js";
import type { ContractItemStatusView } from "./contract-items.js";
import type { CriterionMachineFact } from "./round-facts.js";
import { gitRoundFacts } from "./git-facts.js";
import { claimedMetCriteria } from "./self-eval.js";
import type { SelfEvaluation, VerificationFlag } from "./protocol.js";
import { deriveCriterionId, isCriterionId } from "./token-utils.js";

export interface DerivedClaim {
  /** Criterion text or id as reported by the Agent. */
  targetId: string;
  status: "verified" | "claimed" | "contradicted";
  source: "agent" | "machine" | "verification";
  /** Machine evidence reference, e.g. "criterion:cr-xxxxxxxx". */
  ref?: string;
  detail?: string;
}

export interface ClaimView {
  claims: DerivedClaim[];
  verifiedCount: number;
  contradictedCount: number;
  /** True when ANY machine-verified criterion exists for this round. */
  hasMachineEvidence: boolean;
}

/** Contradicting error flags that invalidate Agent claims. */
// NOTE: keep these as literals — importing the CHECK_* constants here would
// create a verification-gate ⇄ evidence-claims import cycle.
const CONTRADICTING_CHECKS = new Set([
  "required_command_failed",
  "command_evidence_mismatch",
  "success_with_remaining_criteria",
]);

/** v4.0.3: the ONLY criterion ids a claim may upgrade to `verified`.
 *
 *  Sources are the machine criterion facts (latest-wins over committed
 *  history) and the CURRENT active contract's verified items. Agent claims,
 *  self-reported tests and passing commands without a contract reference
 *  never enter this set. */
export function machineVerifiedCriterionIds(input: {
  criterionFacts: ReadonlyArray<CriterionMachineFact>;
  activeContract: ActiveContractView | null;
  itemStatuses: ContractItemStatusView;
}): Set<string> {
  const ids = new Set<string>();
  for (const fact of input.criterionFacts) {
    if (fact.status === "verified") ids.add(fact.criterion_id);
  }
  if (input.activeContract) {
    const statusById = new Map(
      input.itemStatuses.items.map((item) => [item.itemId, item.status] as const),
    );
    for (const item of input.activeContract.items) {
      if (statusById.get(item.id) !== "verified") continue;
      for (const ref of item.criterion_refs) {
        if (isCriterionId(ref)) ids.add(ref);
      }
    }
  }
  return ids;
}

function claimCriterionId(target: string): string {
  return isCriterionId(target) ? target : deriveCriterionId(target);
}

/** Derive the runtime claim view for a round. */
export function deriveClaimView(
  selfEval: SelfEvaluation,
  machineVerifiedIds: ReadonlySet<string>,
): ClaimView {
  const met = claimedMetCriteria(selfEval.execution_report);
  const claims: DerivedClaim[] = met.map((targetId) => {
    const verified = machineVerifiedIds.has(claimCriterionId(targetId));
    return {
      targetId,
      status: verified ? "verified" : "claimed",
      source: verified ? "machine" : "agent",
      ...(verified ? { ref: `criterion:${claimCriterionId(targetId)}` } : {}),
    };
  });
  return {
    claims,
    verifiedCount: claims.filter((claim) => claim.status === "verified").length,
    contradictedCount: 0,
    hasMachineEvidence: machineVerifiedIds.size > 0,
  };
}

/** Re-derive a claim view including the contradiction downgrade driven by
 *  verification flags. Used by read-only snapshots. */
export function rederiveClaimViewWithFlags(
  selfEval: SelfEvaluation,
  machineVerifiedIds: ReadonlySet<string>,
  flags: VerificationFlag[],
): ClaimView {
  const view = deriveClaimView(selfEval, machineVerifiedIds);
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

/** Files actually changed in a committed round — the shared Git union delta.
 *  Returns null when the round has no observable Git boundary. */
export function resolveRoundFiles(
  vaultEntries: VaultEntry[],
  loopId: string,
  round: number,
): string[] | null {
  const committed = readOnlyRounds(vaultEntries)
    .find((view) => view.loopId === loopId && view.round === round);
  if (!committed) return null;
  const git = gitRoundFacts(committed.observationDelta);
  if (git.changedFiles === null) return null;
  return [...git.changedFiles];
}
