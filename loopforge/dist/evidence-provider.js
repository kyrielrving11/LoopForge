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
import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawn, execFile, } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { containInWorkspace } from "./workspace.js";
import { commandConfigHash, deriveConfiguredCapability, getPolicy } from "./policy.js";
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
 *  are the baseline and never evidence. When no git delta is available the
 *  entrypoint arm fails open (matching the historical behaviour).
 *
 *  v3.8 replaced two divergent implementations (the gate excluded tampered
 *  commands, evidence-claims did not) with this single function. */
export function isPassedAfterObservation(observation, gitChangedFiles) {
    if (observation.kind !== "command")
        return false;
    if (observation.phase !== "after")
        return false;
    if (observation.status !== "passed")
        return false;
    const entrypoints = observation.data.entrypointFiles ?? [];
    if (!gitChangedFiles || gitChangedFiles.size === 0)
        return true;
    return !entrypoints.some((file) => gitChangedFiles.has(file));
}
/** v3.8: The changed-file set of a round's git observation, or null when no
 *  git observation exists (entrypoint checks then fail open). */
export function gitChangedFiles(observations) {
    const git = observations.find((observation) => observation.providerId === "git");
    return git ? new Set(git.files) : null;
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
 *  recorded as `insufficient` instead of `verified`. */
export function capabilityWarnings(configured, observed) {
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
        warnings: capabilityWarnings(configured, observed),
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
        schemaVersion: 1,
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
                    loopId: options.loopId,
                    phase,
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
                    return syntheticObservation(provider.name, provider.kind, phase, startedAt, "timeout", `provider exceeded ${timeoutMs}ms`);
                }
                if (!observation) {
                    policyMetrics.recordEvidence(provider.name, "unavailable", Date.now() - startedAt, options.loopId);
                    return syntheticObservation(provider.name, provider.kind, phase, startedAt, "unavailable", "provider reported no observation");
                }
                policyMetrics.recordEvidence(provider.name, observation.status === "timeout" ? "timeout" : "available", Date.now() - startedAt, options.loopId);
                return observation;
            }
            catch (error) {
                policyMetrics.recordEvidence(provider.name, "failure", Date.now() - startedAt, options.loopId);
                logEvent("evidence_provider_error", { provider: provider.name, error: String(error) });
                return syntheticObservation(provider.name, provider.kind, phase, startedAt, "error", String(error));
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
function resolveEntrypointFiles(executable, args, cwd) {
    // v3.3.1: entrypoint containment uses the shared workspace check.
    const workspace = process.cwd();
    const candidates = [...args];
    if (executable.includes("/") || executable.includes("\\")) {
        candidates.unshift(executable);
    }
    candidates.push("package.json");
    const found = [];
    for (const candidate of candidates) {
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
export async function captureGitFileStateAsync(signal, timeoutMs,
/** Workspace root; injectable so tests can capture against a temp repo.
 *  Defaults to the process cwd, matching the evidence providers. */
cwd = process.cwd()) {
    const timeout = timeoutMs ?? 15000;
    const runGit = (args) => {
        return new Promise((resolveGit, reject) => {
            // M1: core.quotePath=false — git otherwise octal-escapes every path
            // with bytes >= 0x80 (Chinese and other non-ASCII filenames become
            // "\346\226\207..."). Escaped names can't be stat/hash'd, so content
            // changes to such files were invisible to the evidence fingerprints.
            const child = execFile("git", ["-c", "core.quotePath=false", ...args], {
                cwd,
                encoding: "utf-8",
                timeout,
                signal,
                windowsHide: true,
            });
            let stdout = "";
            child.stdout?.on("data", (chunk) => {
                stdout += chunk;
            });
            child.on("close", (code) => {
                code === 0
                    ? resolveGit(stdout)
                    : reject(new Error(`git ${args[0]} exited ${code}`));
            });
            child.on("error", reject);
        });
    };
    try {
        const [tracked, staged, untracked] = await Promise.all([
            runGit(["diff", "--name-only"]),
            runGit(["diff", "--cached", "--name-only"]),
            runGit(["ls-files", "--others", "--exclude-standard"]),
        ]);
        // v2.13: Capture HEAD commit for backtrack restore (best-effort)
        let head;
        try {
            const headOut = await runGit(["rev-parse", "HEAD"]);
            head = headOut.trim() || undefined;
        }
        catch {
            // Detached HEAD or non-repo — head stays undefined
        }
        return {
            tracked: tracked.trim().split("\n").filter((f) => f.length > 0).sort(),
            staged: staged.trim().split("\n").filter((f) => f.length > 0).sort(),
            untracked: untracked.trim().split("\n").filter((f) => f.length > 0).sort(),
            head,
        };
    }
    catch {
        return null;
    }
}
// ── Built-in: GitEvidenceProvider ──────────────────────────────────────────
export class GitEvidenceProvider {
    name = "git";
    kind = "git";
    capture(context) {
        const workspace = context?.cwd ?? process.cwd();
        const startedAt = Date.now();
        return captureGitFileStateAsync(context?.signal, context?.timeoutMs, workspace).then((state) => {
            if (!state)
                return null;
            const files = [...new Set([
                    ...state.tracked,
                    ...state.staged,
                    ...state.untracked,
                ])].sort();
            // v3.7.1: paths from git are workspace-relative; the capture runs with
            // the workspace as cwd, so relative stat/read resolve there naturally.
            // An injectable cwd (tests) must resolve explicitly.
            const fingerprints = {};
            for (const file of files) {
                try {
                    const target = isAbsolute(file) ? file : resolve(workspace, file);
                    const stat = statSync(target);
                    const hash = createHash("sha256").update(readFileSync(target)).digest("hex");
                    fingerprints[file] = `${stat.mode}:${hash}`;
                }
                catch {
                    // Deleted files are evidence too. A stable sentinel lets the diff
                    // distinguish deleted/restored transitions across a round.
                    fingerprints[file] = "missing";
                }
            }
            return {
                schemaVersion: 1,
                providerId: "git",
                kind: "git",
                phase: context?.phase ?? "after",
                startedAt,
                finishedAt: Date.now(),
                status: "observed",
                files,
                data: {
                    tracked: state.tracked,
                    staged: state.staged,
                    untracked: state.untracked,
                    fingerprints,
                    head: state.head,
                },
            };
        });
    }
}
registerEvidenceProvider("git", () => new GitEvidenceProvider());
// ── Utility ────────────────────────────────────────────────────────────────
/** Extract merged file list from observations for backward compat with
 *  runtimeFilesChanged (string[] | null).
 *
 *  Looks for the "git" provider first; falls back to merging all providers'
 *  files arrays (deduplicated). */
export function extractFilesFromSnapshots(observations) {
    if (observations.length === 0)
        return null;
    const gitObservation = observations.find((item) => item.providerId === "git");
    if (gitObservation)
        return [...gitObservation.files].sort();
    const allFiles = new Set();
    for (const item of observations) {
        for (const file of item.files)
            allFiles.add(file);
    }
    return [...allFiles].sort();
}
/** v3.8: The round delta of two observation collections (before → after):
 *  files that appeared, disappeared, or changed content. The full payload of
 *  each after-observation is preserved; only `files` is narrowed. This is the
 *  single derivation the transaction persists and every reader consumes. */
export function diffSnapshotCollections(before, after) {
    return after.map((observation) => {
        const baseline = before.find((item) => item.providerId === observation.providerId);
        if (!baseline)
            return observation;
        return {
            ...observation,
            files: diffProviderSnapshot(baseline, observation),
        };
    });
}
/** Compute a diff between two observation collections (before → after). */
export function diffSnapshots(before, after) {
    return extractFilesFromSnapshots(diffSnapshotCollections(before, after));
}
function snapshotFingerprints(observation) {
    if (observation.kind !== "git")
        return null;
    const value = observation.data.fingerprints;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const fingerprints = {};
    for (const [file, fingerprint] of Object.entries(value)) {
        if (typeof fingerprint === "string")
            fingerprints[file] = fingerprint;
    }
    return fingerprints;
}
function diffProviderSnapshot(before, after) {
    const beforeSet = new Set(before.files);
    const afterSet = new Set(after.files);
    const beforeFingerprints = snapshotFingerprints(before);
    const afterFingerprints = snapshotFingerprints(after);
    const candidates = new Set([...before.files, ...after.files]);
    return [...candidates].filter((file) => {
        if (beforeSet.has(file) !== afterSet.has(file))
            return true;
        if (!beforeFingerprints || !afterFingerprints)
            return false;
        return beforeFingerprints[file] !== afterFingerprints[file];
    }).sort();
}
//# sourceMappingURL=evidence-provider.js.map