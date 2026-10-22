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
import type { CommandObservation, ConfiguredCapability, EvidenceCapability, MachineObservation, ObservedCapability, ProgressState } from "./protocol.js";
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
    /** v3.9.7: a custom provider opts into progress by emitting a stable
     *  fingerprint snapshot. The collector persists this capability on every
     *  observation, including failures, so replay never depends on the live
     *  registry. */
    readonly progressCapable?: boolean;
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
 *  are the baseline and never evidence.
 *
 *  `not_applicable` (no Git provider participated) leaves the entrypoint arm
 *  out; `unknown` (a Git boundary existed but its change set is unobservable)
 *  is NOT a pass — the boundary cannot rule out entrypoint tampering.
 *
 *  v3.8 replaced two divergent implementations (the gate excluded tampered
 *  commands, evidence-claims did not) with this single function. */
export declare function isPassedAfterObservation(observation: MachineObservation, git: GitDeltaState): boolean;
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
/** A tracked index entry. `mode` is the stage mode (100644, 100755, 120000,
 *  160000); `object` is the index blob/commit id. */
export interface GitTrackedEntry {
    path: string;
    mode: string;
    object: string;
}
/** v3.9.1: the complete workspace boundary at one instant. */
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
/** An explicit capture failure. The collector records the status; null is no
 *  longer used as an ambiguous "unavailable". */
export type GitCaptureResult = {
    ok: true;
    state: GitFileState;
} | {
    ok: false;
    status: "timeout" | "unavailable" | "aborted" | "error";
    detail: string;
};
/** v3.9.1: capture the complete boundary. All required git commands run in
 *  one parallel batch; HEAD is best-effort (a repository with no commit is a
 *  valid boundary with no head). Any required-command failure returns an
 *  explicit status — never an empty-but-observed boundary. */
export declare function captureGitFileStateAsync(signal?: AbortSignal, timeoutMs?: number,
/** Workspace root; injectable so tests can capture against a temp repo.
 *  Defaults to the process cwd, matching the evidence providers. */
cwd?: string): Promise<GitCaptureResult>;
export declare class GitEvidenceProvider implements EvidenceProvider {
    readonly name = "git";
    readonly kind: "git";
    capture(context?: EvidenceCaptureContext): Promise<MachineObservation | null>;
}
/** v3.9.1: One provider's derived before→after view. `before`/`after` are
 *  references to the persisted observations — never copies, never mutated.
 *  Only `changedFiles` is a derived fact; it is null for every non-Git
 *  provider (command entrypoints are not a change set) and for any Git pair
 *  whose boundary cannot be compared. */
export interface ObservationDelta {
    providerId: string;
    kind: MachineObservation["kind"];
    before: MachineObservation | null;
    after: MachineObservation | null;
    /** Git only. [] = observed no change; null = unknown.
     *  command/custom always null (no file-change concept). */
    changedFiles: string[] | null;
    /** v3.9.7: this provider's before→after progress verdict. Git uses the
     *  existing complete-boundary rule; a custom provider compares its
     *  persisted progress fingerprints; command is not applicable. */
    progress: ProgressState;
}
/** The Git change set for a round, with applicability kept distinct from
 *  observability: no Git provider is `not_applicable`; a Git provider whose
 *  boundary cannot be compared is `unknown` (never an empty set). */
export type GitDeltaState = {
    state: "not_applicable";
} | {
    state: "unknown";
} | {
    state: "observed";
    changedFiles: ReadonlySet<string>;
};
/** The ONE before→after derivation. Delta entries are one per
 *  kind+providerId in the union of both collections, in deterministic order.
 *  Missing sides and duplicate keys are explicit; they never masquerade as an
 *  observed no-change. */
export declare function deriveObservationDeltas(before: readonly MachineObservation[], after: readonly MachineObservation[]): ObservationDelta[];
/** Resolve the round's Git change state once. No Git provider =
 *  not_applicable; any Git delta with an unknown change set = unknown; else
 *  the union of every observed Git change set. */
export declare function gitDeltaState(deltas: readonly ObservationDelta[]): GitDeltaState;
/** The after-phase observations referenced by a delta collection. */
export declare function afterObservations(deltas: readonly ObservationDelta[]): MachineObservation[];
//# sourceMappingURL=evidence-provider.d.ts.map