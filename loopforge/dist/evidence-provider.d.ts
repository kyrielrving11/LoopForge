/** EvidenceProvider — Pluggable evidence capture interface (v1.18).
 *
 * Before this module, evidence capture was hardcoded to git via
 * captureGitModifiedFiles() in two places (runtime.ts, session.ts).
 * This module defines an abstract EvidenceProvider interface so
 * additional evidence sources (test runners, linters, bundle analysis)
 * can be added without touching the verification pipeline.
 *
 * Built-in provider: GitEvidenceProvider — git file state capture with
 * parallel async execution (v2.0.1) and a synchronous fallback.
 */
import type { CommandEvidencePolicy } from "./policy.js";
/** A snapshot of evidence captured by a single provider. */
export interface ProviderSnapshot {
    /** Provider name (e.g. "git", "jest", "eslint"). */
    provider: string;
    /** Unix-ms timestamp of capture. */
    timestamp: number;
    /** File paths relevant to this evidence (for backward compat with
     *  runtimeFilesChanged). */
    files: string[];
    /** Provider-specific structured data. */
    data: Record<string, unknown>;
}
/** Interface for evidence capture providers.
 *
 * Implementations may be synchronous or asynchronous. Async implementations
 * should observe context.signal so timed-out work can release resources. */
export interface EvidenceCaptureContext {
    /** Aborted when the provider exceeds its configured deadline. */
    signal: AbortSignal;
    timeoutMs: number;
    loopId?: string;
    phase: "before" | "after";
}
export type EvidenceCaptureResult = ProviderSnapshot | null | Promise<ProviderSnapshot | null>;
export interface EvidenceProvider {
    /** Unique provider name. Used in policy to enable/disable. */
    readonly name: string;
    /** Capture evidence. Returns null if the provider is unavailable
     *  (e.g. git not installed, no test config found). */
    capture(context?: EvidenceCaptureContext): EvidenceCaptureResult;
}
export interface EvidenceCollectOptions {
    timeoutMs?: number;
    loopId?: string;
    phase?: "before" | "after";
}
export type EvidenceProviderFactory = () => EvidenceProvider;
/** Register a provider factory used by policy-driven collectors. */
export declare function registerEvidenceProvider(name: string, factory: EvidenceProviderFactory): void;
export declare function unregisterEvidenceProvider(name: string): boolean;
/** Collects evidence from all configured providers.
 *
 * Usage:
 *   const collector = new EvidenceCollector([new GitEvidenceProvider()]);
 *   const snapshots = collector.collect();
 *   // snapshots = [{ provider: "git", files: [...], data: {...} }]
 */
export declare class EvidenceCollector {
    private providers;
    constructor(providers: EvidenceProvider[]);
    /** Build the collector described by loop_policy.json. Unknown provider
     *  names are ignored so newer configs remain backward compatible. */
    static fromProviderNames(providerNames: string[]): EvidenceCollector;
    /** Build built-ins and explicitly configured command providers. */
    static fromPolicy(): EvidenceCollector;
    /** Run all providers and return non-null snapshots.
     *  Providers that return null (e.g. git not available) are silently
     *  skipped — the caller handles missing evidence. */
    collect(options?: EvidenceCollectOptions): ProviderSnapshot[];
    /** Capture all providers concurrently with per-provider timeout isolation. */
    collectAsync(options?: EvidenceCollectOptions): Promise<ProviderSnapshot[]>;
}
export interface CommandEvidenceData extends Record<string, unknown> {
    kind: "command";
    commandName: string;
    required: boolean;
    phase: "before" | "after";
    status: "passed" | "failed" | "timeout" | "missing" | "invalid_cwd" | "aborted";
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    truncated: boolean;
}
/** Explicit, shell-free verification command. Disabled unless configured. */
export declare class CommandEvidenceProvider implements EvidenceProvider {
    readonly name: string;
    private readonly config;
    constructor(config: CommandEvidencePolicy);
    capture(context?: EvidenceCaptureContext): Promise<ProviderSnapshot | null>;
    private snapshot;
}
/** v1.17: Result of capturing git file state across all three categories. */
export interface GitFileState {
    /** Tracked files modified but unstaged (git diff --name-only). */
    tracked: string[];
    /** Files in the staging area (git diff --cached --name-only). */
    staged: string[];
    /** Untracked files not yet known to git (git ls-files --others --exclude-standard). */
    untracked: string[];
}
/** v2.0.1: Capture git file state using parallel async execFile.
 *
 * Runs three git commands concurrently via Promise.all. Uses a single
 * timeout (shared across all commands) and an optional AbortSignal for
 * early cancellation. Shell-free (execFile, not exec).
 *
 * On any command failure, returns null — the caller should treat git
 * evidence as unavailable and degrade gracefully.
 *
 * Performance: wall-clock time is max(single-command), not sum(3).
 * On a normal repo (~200ms/command): ~200ms vs ~600ms sequential.
 * On Windows with antivirus (~4s/command): ~4s vs ~12s sequential. */
export declare function captureGitFileStateAsync(signal?: AbortSignal, timeoutMs?: number): Promise<GitFileState | null>;
/** v1.17 (sync): Capture git file state using sequential execFileSync.
 *
 * @deprecated Use captureGitFileStateAsync() for the primary path.
 * This sync fallback exists for legacy callers that cannot be made async
 * (e.g. reconstructSession during startup). Uses execFileSync — shell-free,
 * unlike the old execSync-based implementation. */
export declare function captureGitFileState(): GitFileState | null;
/** v1.16: Capture modified files as a flat sorted array.
 *  @deprecated v1.17 — Use captureGitFileState() for full coverage. */
export declare function captureGitModifiedFiles(): string[] | null;
/** Captures git file state (tracked, staged, untracked) via the async
 *  captureGitFileStateAsync() when a context is provided, falling back
 *  to the synchronous captureGitFileState() for legacy callers. */
export declare class GitEvidenceProvider implements EvidenceProvider {
    readonly name = "git";
    capture(context?: EvidenceCaptureContext): ProviderSnapshot | null | Promise<ProviderSnapshot | null>;
}
/** Extract merged file list from evidence snapshots for backward compat
 *  with runtimeFilesChanged (string[] | null).
 *
 *  Looks for the "git" provider first; falls back to merging all
 *  providers' files arrays (deduplicated). */
export declare function extractFilesFromSnapshots(snapshots: ProviderSnapshot[]): string[] | null;
/** Return provider snapshots narrowed to evidence produced during this round.
 *  The full provider payload remains available in data, while files contains
 *  only added/removed/content-changed paths. */
export declare function diffSnapshotCollections(before: ProviderSnapshot[], after: ProviderSnapshot[]): ProviderSnapshot[];
export declare function diffSnapshots(before: ProviderSnapshot[], after: ProviderSnapshot[]): string[] | null;
//# sourceMappingURL=evidence-provider.d.ts.map