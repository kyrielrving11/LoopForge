/** v3.9.6: recovery facts and the restore checkpoint.
 *
 * The Agent owns the decision to abandon a branch. This module only turns
 * committed facts into a rollback directive and proves that a redo returned
 * the workspace to the selected restore point. It never chooses a target for
 * the Agent and never mutates the workspace.
 */
import type { MachineObservation, RecoveryDirective, SelfEvaluation } from "./protocol.js";
import { type CommittedRoundView } from "./committed-round.js";
import type { ObservationDelta } from "./evidence-provider.js";
export interface RecoveryTarget {
    view: CommittedRoundView;
    head: string;
    dirty: string[];
    fingerprints: Record<string, string>;
}
export type RecoveryTargetResult = {
    ok: true;
    target: RecoveryTarget;
} | {
    ok: false;
    code: "recovery_invalid" | "recovery_unavailable";
    reason: string;
    detail: string;
};
/** Resolve an Agent-requested target against the CURRENT branch. This is the
 *  ONLY target-selection predicate. It never falls back to before evidence and
 *  never replaces an invalid target with a "nearest safe" one. */
export declare function resolveRecoveryTarget(entries: ReadonlyArray<unknown>, currentRound: number, targetRound: number): RecoveryTargetResult;
/** Derive the committed directive facts from the target, the abandoned branch
 *  and the in-flight recovery attempt. Pure; the caller has already validated
 *  the target and collected the current after evidence. */
export declare function deriveRecoveryDirective(input: {
    origin: "agent" | "machine";
    reason: string;
    triggerRule?: string;
    transactionId: string;
    target: RecoveryTarget;
    abandonedRounds: ReadonlyArray<CommittedRoundView>;
    currentRound: number;
    beforeEvidence: ReadonlyArray<MachineObservation>;
    afterEvidence: ReadonlyArray<MachineObservation>;
    triggerEvaluation?: SelfEvaluation | null;
}): RecoveryDirective;
/** v3.9.6: the one restore checkpoint. A pending directive requires a
 *  machine-observed workspace at the target HEAD with no dirty file outside
 *  the target's own baseline and no skipped file still at its failed-round
 *  fingerprint. Unknown Git is NOT a pass. */
export declare function verifyRecoveryCheckpoint(input: {
    directive: RecoveryDirective;
    beforeEvidence: ReadonlyArray<MachineObservation>;
    evidenceDeltas: ReadonlyArray<ObservationDelta>;
}): {
    ok: true;
} | {
    ok: false;
    reason: string;
    detail: string;
};
//# sourceMappingURL=recovery.d.ts.map