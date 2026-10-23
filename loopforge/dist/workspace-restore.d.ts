/** v3.9.8: deterministic workspace restore.
 *
 * This module is the ONLY place LoopForge mutates the working tree. It runs
 * only after a typed rollback directive has been committed, restores the
 * declared Git boundary (content + HEAD), and verifies the result exactly.
 * It never chooses a target and never interprets the Agent's reason.
 *
 * Preconditions are checked before the destructive part: manifest/content
 * hashes, path containment, index state, target HEAD reachability, and
 * directory/type conflicts. File-by-file restore is not atomic; every retry
 * re-plans from the directive + manifest and is idempotent.
 */
import type { MachineObservation, WorkspaceCheckpointManifest } from "./protocol.js";
import type { BoundaryCapture } from "./git-boundary.js";
import type { FileWorkspaceCheckpointStore } from "./workspace-checkpoint.js";
export declare class RestoreFailure extends Error {
    readonly reasonCode: string;
    readonly details?: Record<string, unknown> | undefined;
    constructor(reasonCode: string, message: string, details?: Record<string, unknown> | undefined);
}
export interface RestorePreflight {
    manifest: WorkspaceCheckpointManifest;
    currentBoundary: BoundaryCapture;
    targetHead?: string;
    currentHead?: string;
    /** Target HEAD is an ancestor of current HEAD (moving backwards). */
    backward: boolean;
}
export interface RestoreResult {
    status: "verified";
    checkpointId: string;
    redoRound: number;
    head?: string;
    previousHead?: string;
    safetyRef?: string;
    filesWritten: number;
    filesDeleted: number;
    verifiedAt: number;
    /** The post-restore evidence, reused as the redo transaction's before
     *  baseline. */
    baseline: MachineObservation[];
    /** The boundary captured by the same pass, when a Git provider was active.
     *  Used to build the redo's own before checkpoint. */
    baselineBoundary?: BoundaryCapture;
}
/** Read-only restore preflight. Throws RestoreFailure with a stable reason. */
export declare function preflightRestore(input: {
    manifest: WorkspaceCheckpointManifest;
    workspace: string;
    store: FileWorkspaceCheckpointStore;
    stateDir?: string;
    exclude?: (path: string) => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<RestorePreflight>;
/** Execute the restore. The caller must have committed the directive first. */
export declare function executeRestore(input: {
    manifest: WorkspaceCheckpointManifest;
    workspace: string;
    store: FileWorkspaceCheckpointStore;
    directiveTransactionId: string;
    stateDir?: string;
    exclude?: (path: string) => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
    preflight?: RestorePreflight;
}): Promise<RestoreResult>;
//# sourceMappingURL=workspace-restore.d.ts.map