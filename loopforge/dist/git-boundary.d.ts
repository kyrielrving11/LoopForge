/** The ONE Git boundary capture.
 *
 * Evidence and workspace checkpoints must see exactly the same boundary:
 * every tracked path plus every non-ignored untracked path, with the same
 * fingerprint encoding. This module owns the read-only Git commands, the
 * fingerprint algorithm, and the optional content materializer used by
 * checkpoints. `evidence-provider.ts` consumes it for observations; the
 * checkpoint store consumes it for before-images/savepoints.
 *
 * It deliberately has no dependency on policy, the loop store, or the
 * evidence provider so both callers can share one implementation without a
 * cycle.
 */
export interface GitTrackedEntry {
    path: string;
    mode: string;
    object: string;
}
/** The complete workspace boundary at one instant. */
export interface GitFileState {
    /** Every path in the index, including paths deleted from the worktree. */
    tracked: GitTrackedEntry[];
    /** Non-ignored untracked paths. */
    untracked: string[];
    /** Dirty-since-HEAD paths, for display only. */
    dirty: string[];
    /** HEAD at this boundary; absent in a repository with no commit. */
    head?: string;
}
export type GitCaptureStatus = "timeout" | "unavailable" | "aborted" | "error";
export type GitCaptureResult = {
    ok: true;
    state: GitFileState;
} | {
    ok: false;
    status: GitCaptureStatus;
    detail: string;
};
export declare class GitCaptureFailure extends Error {
    readonly status: GitCaptureStatus;
    constructor(status: GitCaptureStatus, message: string);
}
export declare const GIT_MAX_BUFFER: number;
/** Bounded file-hash concurrency. A module constant, not a policy knob. */
export declare const BOUNDARY_HASH_CONCURRENCY = 16;
export interface GitCommandOptions {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Maximum stdout/stderr bytes. */
    maxBuffer?: number;
}
/** Run one fixed-argument, shell-free Git command. Callers must never pass
 *  user-controlled path/ref text through a shell; arguments stay an array. */
export declare function runGitCommand(args: readonly string[], options: GitCommandOptions): Promise<string>;
export interface GitCommandStatus {
    code: number | null;
    stdout: string;
    stderr: string;
    error?: string;
}
/** Run a fixed-argument Git command and preserve its exit status. Used by the
 *  restore executor for commands whose non-zero exit is a meaningful answer
 *  (`merge-base --is-ancestor`). */
export declare function runGitCommandStatus(args: readonly string[], options: GitCommandOptions): Promise<GitCommandStatus>;
/** Capture the complete boundary state. All required git commands run in one
 *  parallel batch; HEAD is best-effort (a repository with no commit is a
 *  valid boundary with no head). Any required-command failure returns an
 *  explicit status — never an empty-but-observed boundary. */
export declare function captureGitFileStateAsync(signal?: AbortSignal, timeoutMs?: number, 
/** Workspace root; injectable so tests can capture against a temp repo.
 *  Defaults to the process cwd, matching the evidence providers. */
cwd?: string): Promise<GitCaptureResult>;
/** The checkpoint store's content sink. The boundary function owns the bytes
 *  and the hash; the materializer owns the content-addressed location.
 *  A single-fetch interface is enough: the boundary function streams a
 *  regular file into `tempPath`, then commits or discards it by hash. */
export interface BoundaryMaterializer {
    /** True when the content-addressed blob already exists. */
    hasBlob(hash: string): boolean;
    /** A unique temporary path in the object store's directory. */
    tempPath(): string;
    /** Publish `tempPath` as the blob named by `hash`. */
    commitBlob(hash: string, tempPath: string): void;
    /** Remove a temporary file after a failure or duplicate. */
    discardTemp(tempPath: string): void;
}
export interface BoundaryMaterializationError {
    code: string;
    detail: string;
}
export interface BoundaryCapture {
    head?: string;
    dirty: string[];
    fingerprints: Record<string, string>;
    /** Paths whose content was materialized (regular files / symlink text). */
    contents: string[];
    materializationError?: BoundaryMaterializationError;
}
export type BoundaryCaptureResult = {
    ok: true;
    boundary: BoundaryCapture;
} | {
    ok: false;
    status: GitCaptureStatus;
    detail: string;
};
export interface BoundaryCaptureOptions {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Exclude runtime-owned paths (the state directory) from the boundary. */
    exclude?: (path: string) => boolean;
    /** When present, dirty regular files and symlinks are materialized. */
    materializer?: BoundaryMaterializer;
    /** Checkpoint captures refresh the index stat cache before reading dirty
     *  state. Evidence-only captures skip it. */
    refreshIndex?: boolean;
    /** Hard cap on the number of boundary paths. */
    maxPaths?: number;
}
/** Capture the full boundary, optionally materializing dirty content.
 *
 *  The fingerprint map is always complete. Materialization failures are
 *  reported on the boundary as `materializationError` and never downgrade the
 *  evidence: the caller can still use the fingerprints/head. */
export declare function captureBoundary(options: BoundaryCaptureOptions): Promise<BoundaryCaptureResult>;
//# sourceMappingURL=git-boundary.d.ts.map