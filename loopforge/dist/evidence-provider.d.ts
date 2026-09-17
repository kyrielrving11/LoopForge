/** EvidenceProvider — Pluggable machine-observation capture (v1.18 / v3.8).
 *
 * v3.8: providers produce `MachineObservation`s, not ad-hoc snapshots. A
 * configured provider ALWAYS yields an observation: unavailability, timeouts,
 * errors and aborts are recorded as observations with the matching status and
 * are never silently filtered out of the round's factual record. Only
 * observations can create a `verified` fact — agent self-reports never can.
 *
 * Built-in: GitEvidenceProvider — git file state capture with parallel async
 * execution (v2.0.1), plus explicitly configured shell-free command providers.
 */
import type { CommandObservation, ConfiguredCapability, EvidenceCapability, GitObservation, MachineObservation, ObservedCapability } from "./protocol.js";
import type { CommandEvidencePolicy, LoopPolicy } from "./policy.js";
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
export type EvidenceCaptureResult = MachineObservation | null | Promise<MachineObservation | null>;
export interface EvidenceProvider {
    /** Unique provider name. Used in policy to enable/disable. */
    readonly name: string;
    /** Observation kind this provider produces (used for the synthetic
     *  unavailable/timeout/error observations too). */
    readonly kind: MachineObservation["kind"];
    /** Capture an observation. Returns null when the provider is structurally
     *  unavailable (e.g. not a git repository); the collector converts that
     *  into an explicit `unavailable` observation rather than dropping it. */
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
/** v3.8: Whether a provider factory is registered for this name. Readiness
 *  of the RUNTIME (PATH resolution, executables) is a `doctor` concern and is
 *  deliberately not part of the hashed capability. */
export declare function isProviderRegistered(name: string): boolean;
/** v3.8: The ONE machine-backed predicate. A command observation proves a
 *  claim only when it is an after-phase command that PASSED and whose
 *  entrypoint was not modified in the same round. Before-phase observations
 *  are the baseline and never evidence. When no git delta is available the
 *  entrypoint arm fails open (matching the historical behaviour).
 *
 *  v3.8 replaced two divergent implementations (the gate excluded tampered
 *  commands, evidence-claims did not) with this single function. */
export declare function isPassedAfterObservation(observation: MachineObservation, gitChangedFiles: ReadonlySet<string> | null): boolean;
/** v3.8: The changed-file set of a round's git observation, or null when no
 *  git observation exists (entrypoint checks then fail open). */
export declare function gitChangedFiles(observations: ReadonlyArray<MachineObservation>): Set<string> | null;
/** v3.8: Live capability derived from observations. Rendered only — never
 *  hashed, never persisted independently (it is a pure function of the
 *  observations it is given). */
export declare function deriveObservedCapability(observations: ReadonlyArray<MachineObservation>, configured: ConfiguredCapability): ObservedCapability;
/** v3.8: Human-readable capability warnings for start/resume/status. A loop
 *  with no machine verification can still run — its success claims are simply
 *  recorded as `insufficient` instead of `verified`.
 *
 *  v3.8.2: `policy` is read for the per-command entrypoint warning. The three
 *  checks above it speak only when capability is ABSENT (no provider, no
 *  command, a dead provider); this one speaks when a command IS configured but
 *  its true entrypoint is unobservable — the case where a reader would
 *  otherwise believe the runtime is watching files it cannot see. Derived from
 *  policy alone (no probing): the predicate is the same `isPackageManager-
 *  Command` the entrypoint resolver uses, so the warning and the check that
 *  would (not) fire can never disagree. */
export declare function capabilityWarnings(configured: ConfiguredCapability, policy: LoopPolicy, observed?: ObservedCapability): string[];
/** v3.8: The ONE capability derivation. Everything that speaks about
 *  capability — `RoundDriver.prepare()`, MCP start/resume/next/status, the
 *  capability warnings — reads this, so the surfaces cannot drift into
 *  different stories about what the runtime can observe.
 *
 *  `available` is provider-REGISTRY state (code, not policy): it is rendered
 *  and reported by `doctor`, never hashed. The hashed half stays
 *  `deriveConfiguredCapability(policy)` inside the canonical state. */
export declare function deriveEvidenceCapability(policy: LoopPolicy, observations?: ReadonlyArray<MachineObservation>): EvidenceCapability;
/** Collects observations from all configured providers (always async).
 *
 * v3.8: every configured provider produces exactly one observation per
 * collection. A provider that returns null, throws, times out, or is aborted
 * yields an observation with `unavailable` / `error` / `timeout` / `aborted`
 * — the round's factual record keeps the gap instead of hiding it. */
export declare class EvidenceCollector {
    private providers;
    constructor(providers: EvidenceProvider[]);
    /** Build the collector described by loop_policy.json. Every configured name
     *  yields exactly one provider, in configuration order: a name with no
     *  registered factory gets `unregisteredProvider`, which records
     *  `unavailable` rather than letting a configured provider vanish without a
     *  trace. */
    static fromProviderNames(providerNames: string[]): EvidenceCollector;
    /** Build built-ins and explicitly configured command providers. */
    static fromPolicy(): EvidenceCollector;
    /** Capture all providers concurrently with per-provider timeout isolation. */
    collectAsync(options?: EvidenceCollectOptions): Promise<MachineObservation[]>;
}
/** v3.8.3: The round-start state of every enabled after-capable command's
 *  entrypoint files — the TRUSTED baseline the tamper check compares against.
 *
 *  Taken from the filesystem, not from a git observation: `git diff` lists
 *  only tracked-and-dirty files, so an entrypoint that is gitignored would be
 *  absent from BOTH sides of a git-based comparison and a script created this
 *  round would read as "unchanged". Absent candidates are recorded as
 *  `"missing"` rather than dropped — that absence is exactly what makes
 *  "created during this round" detectable.
 *
 *  Captured when a round is PREPARED, never when tampering is detected: a
 *  baseline written at detection time could never catch its own first
 *  occurrence. */
export declare function captureEntrypointTrust(policy: LoopPolicy, workspace?: string): Record<string, string>;
/** v3.8.3: One entrypoint file that no longer matches its round-start state,
 *  with the state it must return to for the round to be verifiable.
 *
 *  `absent` is the case the old delta rule could not describe: the file did
 *  not exist when the round started, so it was CREATED by this round and
 *  cannot back a claim in it. There is nothing to restore — "keep it stable"
 *  is not an instruction the agent can carry out — which is why the recovery
 *  message must distinguish the two. */
export interface EntrypointDrift {
    file: string;
    roundStart: "present" | "absent";
}
/** v3.8.3: The entrypoint files whose content no longer matches the trusted
 *  round-start baseline — the ONE derivation of "this command's script was
 *  changed during the round". The delta rule (does the file appear in the
 *  round's git change set?) cannot answer this on its own: a gitignored
 *  entrypoint is invisible to it, and a baseline re-derived from the current
 *  tree would launder the change. This comparison does not read git at all. */
export declare function driftedEntrypoints(trust: Record<string, string> | undefined, workspace?: string): EntrypointDrift[];
/** The workspace files a command's execution depends on, resolved
 *  statically: the script it names on its own command line, plus package.json
 *  when a package manager is what runs it. Exported for the pure-function
 *  test — spawning a real package manager is not portable (a bare `npm`
 *  cannot be spawned without a shell, and the runtime uses `shell: false`). */
export declare function resolveEntrypointFiles(executable: string, args: string[], cwd: string): string[];
/** Explicit, shell-free verification command. Disabled unless configured. */
export declare class CommandEvidenceProvider implements EvidenceProvider {
    readonly name: string;
    readonly kind: "command";
    private readonly config;
    private readonly configHash;
    constructor(config: CommandEvidencePolicy);
    capture(context?: EvidenceCaptureContext): Promise<CommandObservation | null>;
    private observation;
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
export declare class GitEvidenceProvider implements EvidenceProvider {
    readonly name = "git";
    readonly kind: "git";
    capture(context?: EvidenceCaptureContext): Promise<GitObservation | null>;
}
/** Extract merged file list from observations for backward compat with
 *  runtimeFilesChanged (string[] | null).
 *
 *  Looks for the "git" provider first; falls back to merging all providers'
 *  files arrays (deduplicated). */
export declare function extractFilesFromSnapshots(observations: MachineObservation[]): string[] | null;
/** v3.8: The round delta of two observation collections (before → after):
 *  files that appeared, disappeared, or changed content. The full payload of
 *  each after-observation is preserved; only `files` is narrowed. This is the
 *  single derivation the transaction persists and every reader consumes. */
export declare function diffSnapshotCollections(before: MachineObservation[], after: MachineObservation[]): MachineObservation[];
/** Compute a diff between two observation collections (before → after). */
export declare function diffSnapshots(before: MachineObservation[], after: MachineObservation[]): string[] | null;
//# sourceMappingURL=evidence-provider.d.ts.map