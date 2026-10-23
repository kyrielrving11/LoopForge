/** Workspace checkpoints: content-addressed recovery material.
 *
 * A checkpoint is NOT history and NOT progress. It is the before-image of a
 * transaction (role `before`) or an Agent-created savepoint (role `mid`).
 * The manifest records the exact Git boundary; blobs hold only the content
 * HEAD cannot reproduce (dirty/untracked regular files and symlinks). The
 * transaction snapshot's `CheckpointRef` is the authority for visibility,
 * ownership and the redo round.
 */
import type { CheckpointRef, CheckpointRole, WorkspaceCheckpointManifest } from "./protocol.js";
import type { BoundaryCapture, BoundaryMaterializer } from "./git-boundary.js";
export declare const CHECKPOINT_SCHEMA_VERSION: 1;
export declare const CHECKPOINT_ID_RE: RegExp;
export declare const CONTENT_HASH_RE: RegExp;
/** Module constants, not policy knobs. A checkpoint that exceeds them is
 *  explicitly unavailable; the boundary is never truncated. */
export declare const CHECKPOINT_MAX_PATHS = 200000;
export declare const CHECKPOINT_MAX_NEW_BYTES: number;
export declare class CheckpointError extends Error {
    readonly code: "checkpoint_invalid" | "checkpoint_unavailable" | "checkpoint_failed" | "checkpoint_limit";
    readonly reasonCode: string;
    constructor(code: "checkpoint_invalid" | "checkpoint_unavailable" | "checkpoint_failed" | "checkpoint_limit", reasonCode: string, message: string);
}
/** Deterministic JSON for the content hash. Only the restore-relevant fields
 *  are covered; `createdAt`/`dirty` are metadata and never authoritative.
 *  JSON encoding makes newline/NUL-containing Git paths unambiguous. */
export declare function checkpointContentHash(input: {
    head?: string;
    fingerprints: Record<string, string>;
    contents: string[];
    coverage: "tracked_and_non_ignored_untracked";
}): string;
export declare function deriveCheckpointId(input: {
    loopId: string;
    round: number;
    role: CheckpointRole;
    contentHash: string;
}): string;
/** Validate a persisted manifest without trusting arbitrary disk data. */
export declare function parseCheckpointManifest(value: unknown): WorkspaceCheckpointManifest | null;
/** Per-loop content-addressed checkpoint store.
 *
 *  Layout (under the loop's runtime directory):
 *    checkpoints/<checkpointId>/manifest.json
 *    objects/<sha256>
 *
 *  The store must live under the runtime state directory (or outside the
 *  workspace), so its writes never enter the Git boundary. */
export declare class FileWorkspaceCheckpointStore implements BoundaryMaterializer {
    readonly loopDir: string;
    readonly loopId: string;
    readonly checkpointsDir: string;
    readonly objectsDir: string;
    private newBytes;
    constructor(loopDir: string, loopId: string);
    hasBlob(hash: string): boolean;
    tempPath(): string;
    commitBlob(hash: string, tempPath: string): void;
    discardTemp(tempPath: string): void;
    blobPath(hash: string): string;
    manifestPath(checkpointId: string): string;
    readManifest(checkpointId: string): WorkspaceCheckpointManifest | null;
    writeManifest(manifest: WorkspaceCheckpointManifest): void;
    /** Capture a checkpoint using the shared Git boundary. The boundary's
     *  fingerprints are exactly the manifest's fingerprints. */
    capture(input: {
        round: number;
        role: CheckpointRole;
        cwd: string;
        signal?: AbortSignal;
        timeoutMs?: number;
        exclude?: (path: string) => boolean;
        maxPaths?: number;
    }): Promise<WorkspaceCheckpointManifest>;
    persistManifest(round: number, role: CheckpointRole, boundary: BoundaryCapture): WorkspaceCheckpointManifest;
}
/** Build the transaction-snapshot reference for a manifest. */
export declare function buildCheckpointRef(manifest: WorkspaceCheckpointManifest, input: {
    transactionId: string;
    branchId: string;
    roundId?: string;
    createdAt?: number;
}): CheckpointRef;
//# sourceMappingURL=workspace-checkpoint.d.ts.map