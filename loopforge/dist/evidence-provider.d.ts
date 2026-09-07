/** EvidenceProvider — Pluggable evidence capture interface (v1.18).
 *
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
    /** Workspace root override (tests capture against temp repos). */
    cwd?: string;
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
/** Collects evidence from all configured providers (always async — the
 *  synchronous collect() was removed in v3.7).
 *
 * Usage:
 *   const collector = new EvidenceCollector([new GitEvidenceProvider()]);
 *   const snapshots = await collector.collectAsync({ phase: "before" });
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
    /** v3.3: Workspace files this command depends on (resolved at capture
     *  time from executable + args, plus package.json). The verification gate
     *  cross-checks these against the round's git diff to detect verification
     *  domain tampering — a command whose entrypoint changed this round is not
     *  trustworthy. Forward-slash paths (git convention). Empty = unresolvable
     *  (external command like `bash -c`) — the gate fails open. */
    entrypointFiles: string[];
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
    /** v2.13: HEAD commit hash for backtrack restore point.
     *  undefined when git is unavailable or not a repository. */
    head?: string;
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
export declare function captureGitFileStateAsync(signal?: AbortSignal, timeoutMs?: number,
/** Workspace root; injectable so tests can capture against a temp repo.
 *  Defaults to the process cwd, matching the evidence providers. */
cwd?: string): Promise<GitFileState | null>;
/** v3.7: async capture only — the synchronous captureGitFileState() fallback
 *  was removed together with the sync lifecycle (prepareSync). */
export declare class GitEvidenceProvider implements EvidenceProvider {
    readonly name = "git";
    capture(context?: EvidenceCaptureContext): Promise<ProviderSnapshot | null>;
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
/** v3.3.1: Implement the v2.13 policy switch `engine.backtrack_auto_restore` —
 *  automatically restore the workspace after a backtrack:
 *  1. `git stash push -u` — every uncommitted change (tracked + untracked)
 *     is preserved in a stash, never destroyed (an untracked file the agent
 *     created in the failed rounds is not silently deleted).
 *  2. `git reset --hard <restoreHead>` — when the failed rounds created
 *     commits, discard them back to the clean round's commit (the v2.12
 *     restore-point HEAD).
 *
 *  Runs only inside the workspace (cwd, shell: false, 30s timeout), and the
 *  caller gates it behind the policy flag — DANGEROUS by design, off by
 *  default. Failures are reported, never thrown: the verification gate still
 *  checks workspace cleanliness afterwards, and the backtrack prompt already
 *  instructs manual restore as the fallback. An empty workspace ("No local
 *  changes") is not a failure. */
export declare function runBacktrackAutoRestore(gitHead: string | undefined, round: number,
/** v3.3.1: workspace root; injectable so tests can run against a temp
 *  repo. Defaults to the process cwd, matching the evidence providers. */
cwd?: string): Promise<{
    ok: boolean;
    detail: string;
}>;
//# sourceMappingURL=evidence-provider.d.ts.map