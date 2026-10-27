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
import type { ActiveContractView } from "./round-contract.js";
import type { ContractItemStatusView } from "./contract-items.js";
import type { CriterionMachineFact } from "./round-facts.js";
import type { SelfEvaluation, VerificationFlag } from "./protocol.js";
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
/** v4.0.3: the ONLY criterion ids a claim may upgrade to `verified`.
 *
 *  Sources are the machine criterion facts (latest-wins over committed
 *  history) and the CURRENT active contract's verified items. Agent claims,
 *  self-reported tests and passing commands without a contract reference
 *  never enter this set. */
export declare function machineVerifiedCriterionIds(input: {
    criterionFacts: ReadonlyArray<CriterionMachineFact>;
    activeContract: ActiveContractView | null;
    itemStatuses: ContractItemStatusView;
}): Set<string>;
/** Derive the runtime claim view for a round. */
export declare function deriveClaimView(selfEval: SelfEvaluation, machineVerifiedIds: ReadonlySet<string>): ClaimView;
/** Re-derive a claim view including the contradiction downgrade driven by
 *  verification flags. Used by read-only snapshots. */
export declare function rederiveClaimViewWithFlags(selfEval: SelfEvaluation, machineVerifiedIds: ReadonlySet<string>, flags: VerificationFlag[]): ClaimView;
/** Files actually changed in a committed round — the shared Git union delta.
 *  Returns null when the round has no observable Git boundary. */
export declare function resolveRoundFiles(vaultEntries: VaultEntry[], loopId: string, round: number): string[] | null;
//# sourceMappingURL=evidence-claims.d.ts.map