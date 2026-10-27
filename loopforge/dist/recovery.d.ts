/** v3.9.7: checkpoint selection and committed rollback-directive facts.
 *
 * The Agent owns the decision to abandon a branch and the checkpoint it
 * selects. This module only resolves a checkpoint reference against the
 * current branch, validates the reference/manifest binding, and derives the
 * rollback directive facts. It never chooses a target, never judges a reason,
 * and never mutates the workspace. Restore execution lives in
 * `workspace-restore.ts`.
 */
import type { CheckpointRef, MachineObservation, RecoveryDirective, SelfEvaluation, VerificationFlag, WorkspaceCheckpointManifest } from "./protocol.js";
import { type CommittedRoundView } from "./committed-round.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
export interface CheckpointTargetResult {
    ok: true;
    ref: CheckpointRef;
}
export type CheckpointTargetFailure = {
    ok: false;
    code: "recovery_invalid" | "recovery_unavailable";
    reason: string;
    detail: string;
};
/** Resolve a checkpoint id against the held transaction and the current
 *  branch's committed evaluation transactions. The held reference wins when
 *  the same state also appears in committed history (retry re-binding).
 *
 *  This function is pure: it only uses committed read models and the held
 *  snapshot. The caller loads and validates the manifest. */
export declare function findCheckpointRef(input: {
    entries: ReadonlyArray<unknown>;
    held?: RoundTransactionSnapshot | null;
    checkpointId: string;
}): CheckpointTargetResult | CheckpointTargetFailure;
/** Validate the manifest against its reference. Content/blob/HEAD checks
 *  belong to the restore preflight (they need the workspace and object store). */
export declare function validateCheckpointManifest(ref: CheckpointRef, manifest: WorkspaceCheckpointManifest | null): {
    ok: true;
    manifest: WorkspaceCheckpointManifest;
} | CheckpointTargetFailure;
/** The before-image that represents the state at the start of `redoRound`.
 *  Used by machine backtrack: the state after round T is the before-image of
 *  round T+1. Returns null when that image was never materialized. */
export declare function checkpointForRoundBoundary(input: {
    entries: ReadonlyArray<unknown>;
    /** The in-flight transaction's round and before-image, when available. */
    heldRound?: number;
    heldBeforeCheckpoint?: CheckpointRef | null;
    redoRound: number;
}): CheckpointRef | null;
/** Derive the committed directive. Pure: the caller has validated the target
 *  and collected the abandoned/current evidence. `skipped_files` is report
 *  data (never a restore gate); discoveries are preserved only from committed
 *  abandoned rounds, never from a rejected/in-flight trigger attempt. */
export declare function deriveRecoveryDirective(input: {
    origin: "agent" | "machine";
    reason: string;
    triggerRule?: string;
    transactionId: string;
    targetRef: CheckpointRef;
    targetManifest: WorkspaceCheckpointManifest;
    abandonedRounds: ReadonlyArray<CommittedRoundView>;
    currentAfterEvidence: ReadonlyArray<MachineObservation>;
    triggerEvaluation?: SelfEvaluation | null;
    triggerRound?: number;
    /** v4.0.3: the machine findings that triggered this directive. */
    triggerFindings?: ReadonlyArray<VerificationFlag>;
}): RecoveryDirective;
//# sourceMappingURL=recovery.d.ts.map