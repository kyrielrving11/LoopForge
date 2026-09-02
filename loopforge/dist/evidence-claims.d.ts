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
/** Derive the runtime claim view for a round. No file-level or text-level
 *  guessing: git observations only serve the evidence_integrity warn. */
export declare function deriveClaimView(selfEval: SelfEvaluation, evidenceSnapshots: ProviderSnapshot[]): ClaimView;
/** Re-derive a claim view including the contradiction downgrade driven by
 *  verification flags. Used by audit and listVerifiedClaims on persisted
 *  snapshots; the live round path uses deriveClaimView only. */
export declare function rederiveClaimViewWithFlags(selfEval: SelfEvaluation, evidenceSnapshots: ProviderSnapshot[], flags: VerificationFlag[]): ClaimView;
/** Files actually changed in a committed round (git provider, after evidence
 *  preferred). Returns null when the round has no observable git snapshot. */
export declare function resolveRoundFiles(vaultEntries: VaultEntry[], loopId: string, round: number): string[] | null;
/** Stable cr-IDs (and criterion texts) backed by verified claims across all
 *  committed rounds. Criterion texts are mapped to cr-IDs by callers that
 *  know the objective; this returns the raw verified targets. */
export declare function listVerifiedClaims(vaultEntries: VaultEntry[], loopId: string): string[];
//# sourceMappingURL=evidence-claims.d.ts.map