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
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GIT_OBSERVATION_SCHEMA_VERSION } from "./protocol.js";
import { gitMotionSignal, observedGitHead, } from "./git-motion.js";
import { containInWorkspace } from "./workspace.js";
import { captureBoundary, GitCaptureFailure } from "./git-boundary.js";
// v3.9.8: the Git boundary implementation moved to git-boundary.ts so evidence
// and workspace checkpoints share ONE scan. These re-exports keep the existing
// test/library surface stable.
export { captureGitFileStateAsync } from "./git-boundary.js";
import { commandConfigHash, deriveConfiguredCapability, getPolicy, resolveStateDirectory } from "./policy.js";
import { logEvent } from "./observability.js";
import { policyMetrics } from "./policy-metrics.js";
const providerFactories = new Map();
/** Register a provider factory used by policy-driven collectors. */
export function registerEvidenceProvider(name, factory) {
    if (!name.trim())
        throw new Error("Evidence provider name must not be empty");
    providerFactories.set(name, factory);
}
export function unregisterEvidenceProvider(name) {
    if (name === "git")
        return false;
    return providerFactories.delete(name);
}
/** v3.8: Whether a provider factory is registered for this name. Readiness
 *  of the RUNTIME (PATH resolution, executables) is a `doctor` concern and is
 *  deliberately not part of the hashed capability. */
export function isProviderRegistered(name) {
    return providerFactories.has(name);
}
// ── The single machine-backed predicate ────────────────────────────────────
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
export function isPassedAfterObservation(observation, git) {
    if (observation.kind !== "command")
        return false;
    if (observation.phase !== "after")
        return false;
    if (observation.status !== "passed")
        return false;
    if (git.state === "unknown")
        return false;
    const entrypoints = Array.isArray(observation.data.entrypointFiles)
        ? observation.data.entrypointFiles.filter((file) => typeof file === "string")
        : [];
    if (git.state === "observed" && entrypoints.some((file) => git.changedFiles.has(file))) {
        return false;
    }
    return true;
}
/** v3.8: Live capability derived from observations. Rendered only — never
 *  hashed, never persisted independently (it is a pure function of the
 *  observations it is given). */
export function deriveObservedCapability(observations, configured) {
    const latest = new Map();
    const latestCommand = new Map();
    for (const observation of observations) {
        latest.set(observation.providerId, observation.status);
        if (observation.kind === "command") {
            latestCommand.set(observation.data.commandId, {
                status: observation.status,
                configHash: observation.data.configHash,
            });
        }
    }
    return {
        providers: configured.providers.map((provider) => ({
            providerId: provider.providerId,
            status: latest.get(provider.providerId) ?? "unavailable",
        })),
        commands: configured.commands.map((command) => {
            const seen = latestCommand.get(command.commandId);
            return {
                commandId: command.commandId,
                status: seen?.status ?? "unavailable",
                configHash: seen?.configHash ?? command.configHash,
            };
        }),
    };
}
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
export function capabilityWarnings(configured, policy, observed) {
    const warnings = [];
    if (!configured.observationConfigured) {
        warnings.push("No evidence provider is configured — the runtime can observe nothing " +
            "this loop; success claims will be recorded as insufficient.");
    }
    if (!configured.contractVerificationAvailable) {
        warnings.push("No enabled verification command is configured — Round Contract items " +
            "cannot be machine-verified; contract closure will require an explicit " +
            "blocked outcome.");
    }
    // v3.8.2: a configured command whose harness is named in package.json. The
    // entrypoint set for `npm test` is ["package.json"], so the test files the
    // script actually runs are never in it: editing one is a warning, not a
    // machine fact. Stated as fact + consequence — the operator owns the policy,
    // so this never reads as an instruction the Agent should carry out.
    for (const command of policy.evidence.commands) {
        if (command.enabled !== true)
            continue;
        if (!isPackageManagerCommand(command.executable))
            continue;
        warnings.push(`Command "${command.name}" runs through a package manager — what it ` +
            "actually executes is named in package.json, so the scripts or test " +
            "files it invokes are not entrypoint-protected: changing one in the " +
            "same round is recorded as a warning and does not invalidate the " +
            "command's result.");
    }
    if (observed) {
        const dead = observed.providers.filter((provider) => provider.status === "unavailable" || provider.status === "error");
        if (dead.length > 0) {
            warnings.push(`Evidence provider(s) unavailable: ${dead.map((p) => p.providerId).join(", ")}.`);
        }
    }
    return warnings;
}
/** v3.8: The ONE capability derivation. Everything that speaks about
 *  capability — `RoundDriver.prepare()`, MCP start/resume/next/status, the
 *  capability warnings — reads this, so the surfaces cannot drift into
 *  different stories about what the runtime can observe.
 *
 *  `available` is provider-REGISTRY state (code, not policy): it is rendered
 *  and reported by `doctor`, never hashed. The hashed half stays
 *  `deriveConfiguredCapability(policy)` inside the canonical state. */
export function deriveEvidenceCapability(policy, observations = []) {
    const configured = deriveConfiguredCapability(policy);
    const observed = deriveObservedCapability(observations, configured);
    const statusByProvider = new Map(observed.providers.map((provider) => [provider.providerId, provider.status]));
    return {
        schemaVersion: 1,
        providers: configured.providers.map((provider) => ({
            providerId: provider.providerId,
            available: isProviderRegistered(provider.providerId),
            status: statusByProvider.get(provider.providerId) ?? "unavailable",
        })),
        commands: configured.commands.map((command) => ({
            commandId: command.commandId,
            enabled: command.enabled,
            phase: command.phase,
            configHash: command.configHash,
            ready: command.enabled && (command.phase === "after" || command.phase === "both"),
        })),
        contractVerificationAvailable: configured.contractVerificationAvailable,
        warnings: capabilityWarnings(configured, policy, observed),
    };
}
// ── EvidenceCollector ──────────────────────────────────────────────────────
/** v3.8: The stand-in for a name in `policy.evidence.providers` that no
 *  registered factory answers. Configuring a provider is a factual claim that
 *  it observes something; when the runtime has no such provider the claim must
 *  still leave a record, so this one captures `unavailable` instead of the
 *  name vanishing from the round. Registration is code state (a `doctor`
 *  concern), so the observation is the only place the gap can legitimately
 *  appear in the Vault. */
function unregisteredProvider(name) {
    return {
        name,
        kind: "custom",
        capture(context) {
            return syntheticObservation(name, "custom", context?.phase ?? "after", Date.now(), "unavailable", "provider is not registered in this runtime (see `loopforge doctor`)");
        },
    };
}
/** v3.8: Build the observation a failed capture resolves to. The status names
 *  the machine fact; `detail` explains it for the audit trail. */
function syntheticObservation(providerId, kind, phase, startedAt, status, detail) {
    return {
        // v3.9.1: a failed Git capture still carries the current Git observation
        // schema so the committed snapshot can be parsed; its non-observed status
        // is what tells consumers the boundary is unavailable.
        schemaVersion: kind === "git" ? GIT_OBSERVATION_SCHEMA_VERSION : 1,
        providerId,
        kind,
        phase,
        startedAt,
        finishedAt: Date.now(),
        status,
        files: [],
        data: { detail },
    };
}
const PROGRESS_FINGERPRINT_RE = /^[a-f0-9]{64}$/;
function isValidProgressSnapshot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const snapshot = value;
    return snapshot.schemaVersion === 1 &&
        typeof snapshot.fingerprint === "string" &&
        PROGRESS_FINGERPRINT_RE.test(snapshot.fingerprint);
}
function progressErrorObservation(provider, phase, startedAt, detail) {
    return {
        schemaVersion: 1,
        providerId: provider.name,
        kind: "custom",
        phase,
        startedAt,
        finishedAt: Date.now(),
        status: "error",
        files: [],
        data: { detail, progressCapable: true, progress: null },
    };
}
/** Persist the provider's progress capability on every observation and reject
 *  a contract violation instead of silently reading it as "no progress". */
function normalizeProgressObservation(provider, observation, phase, startedAt) {
    if (!provider.progressCapable) {
        if (observation.kind === "custom" &&
            (observation.data.progressCapable === true ||
                observation.data.progress !== undefined)) {
            return {
                schemaVersion: 1,
                providerId: provider.name,
                kind: "custom",
                phase,
                startedAt,
                finishedAt: Date.now(),
                status: "error",
                files: [],
                data: {
                    detail: "provider emitted progress data without declaring progressCapable",
                    progressCapable: true,
                    progress: null,
                },
            };
        }
        return observation;
    }
    if (provider.kind !== "custom" || observation.kind !== "custom") {
        return progressErrorObservation(provider, phase, startedAt, "progressCapable is only supported for custom observations");
    }
    if (observation.status === "observed") {
        const snapshot = observation.data.progress;
        if (!isValidProgressSnapshot(snapshot)) {
            return progressErrorObservation(provider, phase, startedAt, "progress-capable provider did not emit a valid progress snapshot");
        }
        return {
            ...observation,
            data: { ...observation.data, progressCapable: true, progress: snapshot },
        };
    }
    return {
        ...observation,
        data: { ...observation.data, progressCapable: true, progress: null },
    };
}
/** Collects observations from all configured providers (always async).
 *
 * v3.8: every configured provider produces exactly one observation per
 * collection. A provider that returns null, throws, times out, or is aborted
 * yields an observation with `unavailable` / `error` / `timeout` / `aborted`
 * — the round's factual record keeps the gap instead of hiding it. */
export class EvidenceCollector {
    providers;
    constructor(providers) {
        this.providers = providers;
    }
    /** Build the collector described by loop_policy.json. Every configured name
     *  yields exactly one provider, in configuration order: a name with no
     *  registered factory gets `unregisteredProvider`, which records
     *  `unavailable` rather than letting a configured provider vanish without a
     *  trace. */
    static fromProviderNames(providerNames) {
        const providers = providerNames
            .map((name) => providerFactories.get(name)?.() ?? unregisteredProvider(name));
        return new EvidenceCollector(providers);
    }
    /** Build built-ins and explicitly configured command providers. */
    static fromPolicy() {
        const policy = getPolicy().evidence;
        const providerNames = Array.isArray(policy.providers)
            ? policy.providers.filter((name) => typeof name === "string")
            : [];
        const providers = EvidenceCollector.fromProviderNames(providerNames).providers;
        const commands = Array.isArray(policy.commands) ? policy.commands : [];
        for (const command of commands) {
            if (command?.enabled)
                providers.push(new CommandEvidenceProvider(command));
        }
        return new EvidenceCollector(providers);
    }
    /** Capture all providers concurrently with per-provider timeout isolation. */
    async collectAsync(options = {}) {
        const timeoutMs = options.timeoutMs ?? getPolicy().evidence.timeout_ms;
        const phase = options.phase ?? "after";
        const captures = this.providers.map(async (provider) => {
            const startedAt = Date.now();
            const controller = new AbortController();
            let timer;
            let timedOut = false;
            try {
                const capture = Promise.resolve(provider.capture({
                    signal: controller.signal,
                    timeoutMs,
                    ...(options.loopId !== undefined ? { loopId: options.loopId } : {}),
                    phase,
                    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
                    ...(options.materializer
                        ? { materializer: options.materializer }
                        : {}),
                    ...(options.boundarySink
                        ? { boundarySink: options.boundarySink }
                        : {}),
                    ...(options.maxPaths !== undefined
                        ? { maxPaths: options.maxPaths }
                        : {}),
                }));
                const observation = timeoutMs > 0
                    ? await Promise.race([
                        capture,
                        new Promise((resolveRace) => {
                            timer = setTimeout(() => {
                                timedOut = true;
                                controller.abort(new Error(`Evidence provider timed out after ${timeoutMs}ms`));
                                resolveRace(null);
                            }, timeoutMs);
                        }),
                    ])
                    : await capture;
                if (timedOut) {
                    policyMetrics.recordEvidence(provider.name, "timeout", Date.now() - startedAt, options.loopId);
                    logEvent("evidence_provider_timeout", { provider: provider.name, timeoutMs });
                    return normalizeProgressObservation(provider, syntheticObservation(provider.name, provider.kind, phase, startedAt, "timeout", `provider exceeded ${timeoutMs}ms`), phase, startedAt);
                }
                if (!observation) {
                    policyMetrics.recordEvidence(provider.name, "unavailable", Date.now() - startedAt, options.loopId);
                    const unavailable = syntheticObservation(provider.name, provider.kind, phase, startedAt, "unavailable", "provider reported no observation");
                    return normalizeProgressObservation(provider, unavailable, phase, startedAt);
                }
                const normalized = normalizeProgressObservation(provider, observation, phase, startedAt);
                policyMetrics.recordEvidence(provider.name, normalized.status === "timeout" ? "timeout" : "available", Date.now() - startedAt, options.loopId);
                return normalized;
            }
            catch (error) {
                policyMetrics.recordEvidence(provider.name, "failure", Date.now() - startedAt, options.loopId);
                logEvent("evidence_provider_error", { provider: provider.name, error: String(error) });
                return normalizeProgressObservation(provider, syntheticObservation(provider.name, provider.kind, phase, startedAt, "error", String(error)), phase, startedAt);
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
        });
        return await Promise.all(captures);
    }
}
function commandCwd(configured) {
    // v3.3.1: delegated to the shared containment check (workspace.ts) — the
    // command execution boundary must use the same double check as every
    // other workspace path, not a private copy. The cwd must additionally be
    // an existing directory (commands spawn inside it).
    const actual = containInWorkspace(process.cwd(), configured ?? ".");
    if (!statSync(actual).isDirectory()) {
        throw new Error("command cwd resolves outside the workspace");
    }
    return actual;
}
/** v3.3: Resolve the workspace files a verification command depends on.
 *  Candidates: every arg that resolves to an existing file inside the
 *  workspace, a path-shaped executable (e.g. "./scripts/verify.mjs"), and
 *  package.json (npm test / script indirection). Directories and non-workspace
 *  paths are skipped. Returns forward-slash paths (git convention) so the
 *  gate can intersect them with the round's git diff. Empty result = the
 *  command's entrypoint cannot be observed (external command) — fail open. */
/** Package-manager executables, whose own configuration IS the command's
 *  harness: `npm test` runs whatever `scripts.test` names, so an edit there
 *  changes what the machine will execute. Any other command's harness is what
 *  its own command line names. */
const PACKAGE_MANAGER_EXECUTABLES = new Set([
    "npm", "npm.cmd", "npm.exe",
    "npx", "npx.cmd", "npx.exe",
    "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "yarnpkg",
    "bun", "bunx",
]);
function isPackageManagerCommand(executable) {
    const base = executable.split(/[\\/]/).pop() ?? executable;
    return PACKAGE_MANAGER_EXECUTABLES.has(base.trim().toLowerCase());
}
/** The candidate workspace paths a command's execution depends on: the script
 *  it names on its own command line, plus package.json when a package manager
 *  is what runs it. Whether each candidate EXISTS is the caller's question —
 *  `resolveEntrypointFiles` keeps only the ones that do, while
 *  `captureEntrypointTrust` must also record the absent ones. */
function entrypointCandidates(executable, args) {
    const candidates = [...args];
    if (executable.includes("/") || executable.includes("\\")) {
        candidates.unshift(executable);
    }
    // v3.8.1: `package.json` is a candidate only for a package-manager
    // invocation, which is the only case where it defines what runs. Adding it
    // unconditionally made EVERY command's entrypoint set include it, so a round
    // that touched package.json — for any reason at all, with any command — was
    // reported as "the verification entrypoint changed" and rejected, however
    // unrelated the file was to what actually executed.
    if (isPackageManagerCommand(executable))
        candidates.push("package.json");
    return candidates;
}
/** v3.8.3: The content fingerprint of one workspace file — `"<mode>:<sha256>"`,
 *  or the `"missing"` sentinel when it cannot be read. ONE definition, shared
 *  by the git provider's per-file map and the entrypoint trust baseline, so a
 *  value captured at round start is literally comparable to one captured later
 *  (and to a value inside a git observation). */
function fileFingerprint(absolutePath) {
    try {
        const stat = statSync(absolutePath);
        const hash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
        return `${stat.mode}:${hash}`;
    }
    catch {
        // Deleted files are evidence too. A stable sentinel lets the diff
        // distinguish deleted/restored transitions across a round.
        return "missing";
    }
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
export function captureEntrypointTrust(policy, workspace = process.cwd()) {
    const trust = {};
    for (const command of policy.evidence.commands ?? []) {
        if (command.enabled !== true)
            continue;
        if (command.phase !== "after" && command.phase !== "both")
            continue;
        if (!command.executable)
            continue;
        const cwd = command.cwd ?? workspace;
        for (const candidate of entrypointCandidates(command.executable, command.args ?? [])) {
            try {
                const actual = containInWorkspace(workspace, resolve(cwd, candidate));
                const rel = relative(realpathSync(workspace), actual).split(sep).join("/");
                if (trust[rel] === undefined)
                    trust[rel] = fileFingerprint(actual);
            }
            catch {
                // Outside the workspace or unresolvable — not an entrypoint fact.
            }
        }
    }
    return trust;
}
/** v3.8.3: The entrypoint files whose content no longer matches the trusted
 *  round-start baseline — the ONE derivation of "this command's script was
 *  changed during the round". The delta rule (does the file appear in the
 *  round's git change set?) cannot answer this on its own: a gitignored
 *  entrypoint is invisible to it, and a baseline re-derived from the current
 *  tree would launder the change. This comparison does not read git at all. */
export function driftedEntrypoints(trust, workspace = process.cwd()) {
    if (!trust)
        return [];
    const drifted = [];
    for (const [file, trusted] of Object.entries(trust)) {
        let current;
        try {
            current = fileFingerprint(containInWorkspace(workspace, resolve(workspace, file)));
        }
        catch {
            current = "missing";
        }
        if (current !== trusted) {
            drifted.push({ file, roundStart: trusted === "missing" ? "absent" : "present" });
        }
    }
    return drifted.sort((a, b) => a.file.localeCompare(b.file));
}
/** The workspace files a command's execution depends on, resolved
 *  statically: the script it names on its own command line, plus package.json
 *  when a package manager is what runs it. Exported for the pure-function
 *  test — spawning a real package manager is not portable (a bare `npm`
 *  cannot be spawned without a shell, and the runtime uses `shell: false`). */
export function resolveEntrypointFiles(executable, args, cwd) {
    // v3.3.1: entrypoint containment uses the shared workspace check.
    const workspace = process.cwd();
    const found = [];
    for (const candidate of entrypointCandidates(executable, args)) {
        try {
            const actual = containInWorkspace(workspace, resolve(cwd, candidate));
            if (statSync(actual).isDirectory())
                continue;
            const rel = relative(realpathSync(workspace), actual).split(sep).join("/");
            if (!found.includes(rel))
                found.push(rel);
        }
        catch {
            // Not a resolvable workspace file (absent or outside) — not an
            // entrypoint candidate.
        }
    }
    return found;
}
/** Explicit, shell-free verification command. Disabled unless configured. */
export class CommandEvidenceProvider {
    name;
    kind = "command";
    config;
    configHash;
    constructor(config) {
        const name = typeof config.name === "string" && config.name.trim()
            ? config.name.trim()
            : "invalid-config";
        const executable = typeof config.executable === "string"
            ? config.executable.trim()
            : "";
        const args = Array.isArray(config.args)
            ? config.args.filter((arg) => typeof arg === "string")
            : [];
        const successExitCodes = Array.isArray(config.success_exit_codes)
            ? config.success_exit_codes.filter((code) => Number.isInteger(code))
            : [0];
        this.config = {
            ...config,
            name,
            executable,
            args,
            phase: config.phase === "both" ? "both" : "after",
            required: config.required === true,
            timeout_ms: Number.isFinite(config.timeout_ms) ? config.timeout_ms : 120_000,
            max_output_chars: Number.isFinite(config.max_output_chars)
                ? config.max_output_chars
                : 20_000,
            success_exit_codes: successExitCodes,
        };
        this.configHash = commandConfigHash(this.config);
        this.name = `command:${name}`;
    }
    capture(context) {
        const phase = context?.phase ?? "after";
        if (phase === "before" && this.config.phase === "after") {
            return Promise.resolve(null);
        }
        const startedAt = Date.now();
        const cap = Math.max(0, this.config.max_output_chars);
        const timeoutMs = Math.max(1, Math.min(this.config.timeout_ms, context?.timeoutMs || this.config.timeout_ms));
        let cwd;
        if (!this.config.executable) {
            return Promise.resolve(this.observation(phase, "error", null, null, "", "", false, 0, [], "command executable is empty"));
        }
        try {
            cwd = commandCwd(this.config.cwd);
        }
        catch (error) {
            return Promise.resolve(this.observation(phase, "error", null, null, "", "", false, Date.now() - startedAt, [], String(error)));
        }
        // v3.3: Workspace entrypoint files for tamper detection at the gate.
        const entrypointFiles = resolveEntrypointFiles(this.config.executable, this.config.args, cwd);
        return new Promise((resolveCapture) => {
            // v3.8: the FULL streams are hashed; the retained excerpt is capped.
            const stdoutHash = createHash("sha256");
            const stderrHash = createHash("sha256");
            let stdout = "";
            let stderr = "";
            let truncated = false;
            let retained = 0;
            let settled = false;
            const append = (current, chunk) => {
                const text = String(chunk);
                if (text.length === 0)
                    return current;
                if (retained >= cap) {
                    truncated = true;
                    return current;
                }
                const remaining = cap - retained;
                if (text.length > remaining)
                    truncated = true;
                const accepted = text.slice(0, remaining);
                retained += accepted.length;
                return current + accepted;
            };
            const child = spawn(this.config.executable, this.config.args, {
                cwd,
                shell: false,
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });
            let timer;
            const finish = (status, exitCode, signal, failureDetail) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                context?.signal.removeEventListener("abort", abort);
                resolveCapture(this.observation(phase, status, exitCode, signal, stdout, stderr, truncated, Date.now() - startedAt, entrypointFiles, failureDetail, stdoutHash.digest("hex"), stderrHash.digest("hex")));
            };
            const abort = () => {
                child.kill();
                finish("aborted", null, null, "aborted by the collector deadline");
            };
            child.stdout.on("data", (chunk) => {
                stdoutHash.update(String(chunk));
                stdout = append(stdout, chunk);
            });
            child.stderr.on("data", (chunk) => {
                stderrHash.update(String(chunk));
                stderr = append(stderr, chunk);
            });
            child.once("error", (error) => {
                stderrHash.update(error.message);
                stderr = append(stderr, error.message);
                finish(error.code === "ENOENT" ? "unavailable" : "error", null, null, error.code ?? error.message);
            });
            child.once("close", (code, signal) => {
                const passed = code !== null && this.config.success_exit_codes.includes(code);
                finish(passed ? "passed" : "failed", code, signal);
            });
            timer = setTimeout(() => {
                child.kill();
                finish("timeout", null, null, `command exceeded ${timeoutMs}ms`);
            }, timeoutMs);
            timer.unref?.();
            if (context?.signal.aborted)
                abort();
            else
                context?.signal.addEventListener("abort", abort, { once: true });
        });
    }
    observation(phase, status, exitCode, signal, stdout, stderr, truncated, durationMs, entrypointFiles, failureDetail, stdoutSha256, stderrSha256) {
        const finishedAt = Date.now();
        return {
            schemaVersion: 1,
            providerId: this.name,
            kind: "command",
            phase,
            startedAt: finishedAt - durationMs,
            finishedAt,
            status,
            files: [],
            data: {
                commandId: this.config.name,
                argv: [this.config.executable, ...this.config.args],
                cwd: this.config.cwd ?? ".",
                configHash: this.configHash,
                required: this.config.required,
                exitCode,
                signal,
                durationMs,
                ...(failureDetail ? { failureDetail } : {}),
                stdoutSha256: stdoutSha256 ?? createHash("sha256").update(stdout).digest("hex"),
                stderrSha256: stderrSha256 ?? createHash("sha256").update(stderr).digest("hex"),
                stdoutExcerpt: stdout,
                stderrExcerpt: stderr,
                truncated,
                entrypointFiles,
            },
        };
    }
}
// The Git boundary capture/fingerprint implementation lives in
// git-boundary.ts (shared with workspace checkpoints).
// ── Built-in: GitEvidenceProvider ──────────────────────────────────────────
/** The runtime's resolved state directory, or null when it cannot be observed
 *  (configured outside the workspace, or an unresolvable path). */
function stateDirectory(workspace) {
    try {
        return resolveStateDirectory(workspace, getPolicy().backend.root_dir);
    }
    catch {
        return null;
    }
}
/** True when a workspace-relative or absolute file path is the state directory
 *  or lives inside it. */
function isInsideDirectory(file, workspace, dir) {
    const absolute = isAbsolute(file) ? file : resolve(workspace, file);
    const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
    return absolute === dir || absolute.startsWith(prefix);
}
export class GitEvidenceProvider {
    name = "git";
    kind = "git";
    async capture(context) {
        const workspace = context?.cwd ?? process.cwd();
        const phase = context?.phase ?? "after";
        const startedAt = Date.now();
        // v3.8.1: the runtime's OWN state directory is not the agent's work. The
        // vault lives inside the workspace by default, so every round's
        // bookkeeping writes would otherwise read as machine-observed motion —
        // the very signal the stall evaluator and the restore checks consume. The
        // exclusion lives here, at the fact, and not in the workspace's
        // .gitignore (which the runtime does not own and a user may not have).
        const stateDir = stateDirectory(workspace);
        const isRuntimeState = (file) => stateDir !== null && isInsideDirectory(file, workspace, stateDir);
        // The collector already races providers, but a library caller has no
        // such guard. Enforce the same budget here: abort the child commands and
        // the hashing loop, and report a TIMEOUT rather than a partial boundary.
        const controller = new AbortController();
        const external = context?.signal;
        let timedOut = false;
        const onExternalAbort = () => controller.abort(external?.reason);
        if (external?.aborted)
            controller.abort(external.reason);
        else
            external?.addEventListener("abort", onExternalAbort, { once: true });
        const budget = context?.timeoutMs ?? 0;
        const timer = budget > 0
            ? setTimeout(() => {
                timedOut = true;
                controller.abort(new Error("boundary capture timed out"));
            }, budget)
            : undefined;
        try {
            const result = await captureBoundary({
                cwd: workspace,
                signal: controller.signal,
                ...(context?.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
                exclude: isRuntimeState,
                ...(context?.materializer ? { materializer: context.materializer } : {}),
                ...(context?.maxPaths !== undefined ? { maxPaths: context.maxPaths } : {}),
            });
            if (timedOut) {
                return syntheticObservation(this.name, this.kind, phase, startedAt, "timeout", `boundary capture exceeded ${budget}ms`);
            }
            if (!result.ok) {
                return syntheticObservation(this.name, this.kind, phase, startedAt, result.status, result.detail);
            }
            const boundary = result.boundary;
            context?.boundarySink?.(boundary);
            return {
                schemaVersion: GIT_OBSERVATION_SCHEMA_VERSION,
                providerId: "git",
                kind: "git",
                phase,
                startedAt,
                finishedAt: Date.now(),
                status: "observed",
                // `files` is the dirty display list; the complete boundary lives in
                // data.fingerprints and the round delta is derived from it.
                files: [...boundary.dirty],
                data: {
                    dirty: [...boundary.dirty],
                    fingerprints: boundary.fingerprints,
                    ...(boundary.head ? { head: boundary.head } : {}),
                    coverage: "tracked_and_non_ignored_untracked",
                },
            };
        }
        catch (error) {
            const status = timedOut
                ? "timeout"
                : error instanceof GitCaptureFailure
                    ? error.status
                    : "error";
            return syntheticObservation(this.name, this.kind, phase, startedAt, status, String(error instanceof Error ? error.message : error));
        }
        finally {
            if (timer)
                clearTimeout(timer);
            external?.removeEventListener("abort", onExternalAbort);
        }
    }
}
registerEvidenceProvider("git", () => new GitEvidenceProvider());
function customProgressCapable(observation) {
    return observation?.kind === "custom" &&
        observation.data.progressCapable === true;
}
function customProgress(observation) {
    if (observation?.kind !== "custom")
        return null;
    const value = observation.data.progress;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    if (value.schemaVersion !== 1 || typeof value.fingerprint !== "string")
        return null;
    return value;
}
function deltaProgress(observation, beforeObservation, afterObservation, changedFiles, ambiguous) {
    if (ambiguous)
        return "unknown";
    if (observation.kind === "git") {
        if (beforeObservation?.kind !== "git" || afterObservation?.kind !== "git") {
            return "unknown";
        }
        if (beforeObservation.status !== "observed" ||
            afterObservation.status !== "observed" ||
            changedFiles === null) {
            return "unknown";
        }
        const signal = gitMotionSignal({
            changedFiles,
            headBefore: observedGitHead(beforeObservation),
            headAfter: observedGitHead(afterObservation),
        });
        return signal === null ? "unknown" : signal ? "changed" : "unchanged";
    }
    if (observation.kind === "custom") {
        const beforeCapable = customProgressCapable(beforeObservation);
        const afterCapable = customProgressCapable(afterObservation);
        if (!beforeCapable && !afterCapable)
            return "not_applicable";
        if (beforeObservation?.status !== "observed" ||
            afterObservation?.status !== "observed" ||
            !beforeCapable || !afterCapable) {
            return "unknown";
        }
        const beforeSnapshot = customProgress(beforeObservation);
        const afterSnapshot = customProgress(afterObservation);
        if (!beforeSnapshot || !afterSnapshot)
            return "unknown";
        return beforeSnapshot.fingerprint === afterSnapshot.fingerprint
            ? "unchanged"
            : "changed";
    }
    return "not_applicable";
}
const DELTA_KIND_ORDER = {
    git: 0,
    command: 1,
    custom: 2,
};
function deltaKey(observation) {
    return `${observation.kind}\u0000${observation.providerId}`;
}
function snapshotFingerprints(observation) {
    if (observation.kind !== "git")
        return null;
    const value = observation.data.fingerprints;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const entries = Object.entries(value);
    // A partial map cannot produce a sound diff: an unsupported value could be
    // the one real change. Unknown is null, never a filtered subset.
    if (!entries.every(([, fingerprint]) => typeof fingerprint === "string")) {
        return null;
    }
    return Object.fromEntries(entries);
}
function diffFingerprints(before, after) {
    const candidates = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...candidates]
        .filter((file) => before[file] !== after[file])
        .sort();
}
/** The ONE before→after derivation. Delta entries are one per
 *  kind+providerId in the union of both collections, in deterministic order.
 *  Missing sides and duplicate keys are explicit; they never masquerade as an
 *  observed no-change. */
export function deriveObservationDeltas(before, after) {
    const beforeByKey = new Map();
    const afterByKey = new Map();
    for (const observation of before) {
        const key = deltaKey(observation);
        const bucket = beforeByKey.get(key);
        if (bucket)
            bucket.push(observation);
        else
            beforeByKey.set(key, [observation]);
    }
    for (const observation of after) {
        const key = deltaKey(observation);
        const bucket = afterByKey.get(key);
        if (bucket)
            bucket.push(observation);
        else
            afterByKey.set(key, [observation]);
    }
    const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])];
    const deltas = keys.map((key) => {
        const beforeList = beforeByKey.get(key) ?? [];
        const afterList = afterByKey.get(key) ?? [];
        const beforeObservation = beforeList[0] ?? null;
        const afterObservation = afterList[0] ?? null;
        const observation = afterObservation ?? beforeObservation;
        const ambiguous = beforeList.length > 1 || afterList.length > 1;
        let changedFiles = null;
        if (!ambiguous &&
            observation.kind === "git" &&
            beforeObservation?.kind === "git" &&
            afterObservation?.kind === "git" &&
            beforeObservation.status === "observed" &&
            afterObservation.status === "observed") {
            const beforeFingerprints = snapshotFingerprints(beforeObservation);
            const afterFingerprints = snapshotFingerprints(afterObservation);
            if (beforeFingerprints && afterFingerprints) {
                changedFiles = diffFingerprints(beforeFingerprints, afterFingerprints);
            }
        }
        return {
            providerId: observation.providerId,
            kind: observation.kind,
            before: beforeObservation,
            after: afterObservation,
            changedFiles,
            progress: deltaProgress(observation, beforeObservation, afterObservation, changedFiles, ambiguous),
        };
    });
    return deltas.sort((left, right) => DELTA_KIND_ORDER[left.kind] - DELTA_KIND_ORDER[right.kind] ||
        left.providerId.localeCompare(right.providerId));
}
/** Resolve the round's Git change state once. No Git provider =
 *  not_applicable; any Git delta with an unknown change set = unknown; else
 *  the union of every observed Git change set. */
export function gitDeltaState(deltas) {
    const git = deltas.filter((delta) => delta.kind === "git");
    if (git.length === 0)
        return { state: "not_applicable" };
    if (git.some((delta) => delta.changedFiles === null))
        return { state: "unknown" };
    const changedFiles = new Set();
    for (const delta of git) {
        for (const file of delta.changedFiles)
            changedFiles.add(file);
    }
    return { state: "observed", changedFiles };
}
/** The after-phase observations referenced by a delta collection. */
export function afterObservations(deltas) {
    return deltas
        .map((delta) => delta.after)
        .filter((observation) => observation !== null);
}
//# sourceMappingURL=evidence-provider.js.map