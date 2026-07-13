/** EvidenceProvider — Pluggable evidence capture interface (v1.18).
 *
 * Before this module, evidence capture was hardcoded to git via
 * captureGitModifiedFiles() in two places (runtime.ts, session.ts).
 * This module defines an abstract EvidenceProvider interface so
 * additional evidence sources (test runners, linters, bundle analysis)
 * can be added without touching the verification pipeline.
 *
 * Built-in provider: GitEvidenceProvider — wraps existing
 * captureGitFileState() logic.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { captureGitFileState } from "./verification-gate.js";
import { getPolicy } from "./policy.js";
import { logEvent, startSpan } from "./observability.js";
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
// ── EvidenceCollector ──────────────────────────────────────────────────────
/** Collects evidence from all configured providers.
 *
 * Usage:
 *   const collector = new EvidenceCollector([new GitEvidenceProvider()]);
 *   const snapshots = collector.collect();
 *   // snapshots = [{ provider: "git", files: [...], data: {...} }]
 */
export class EvidenceCollector {
    providers;
    constructor(providers) {
        this.providers = providers;
    }
    /** Build the collector described by loop_policy.json. Unknown provider
     *  names are ignored so newer configs remain backward compatible. */
    static fromProviderNames(providerNames) {
        const providers = [];
        for (const name of providerNames) {
            const factory = providerFactories.get(name);
            if (factory)
                providers.push(factory());
        }
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
    /** Run all providers and return non-null snapshots.
     *  Providers that return null (e.g. git not available) are silently
     *  skipped — the caller handles missing evidence. */
    collect(options = {}) {
        const results = [];
        for (const p of this.providers) {
            const startedAt = Date.now();
            const controller = new AbortController();
            try {
                const snapshot = p.capture({
                    signal: controller.signal,
                    timeoutMs: options.timeoutMs ?? getPolicy().evidence.timeout_ms,
                    loopId: options.loopId,
                    phase: options.phase ?? "after",
                });
                if (snapshot && typeof snapshot.then === "function") {
                    // Async providers are not awaitable in the synchronous collect()
                    // path. Log and skip — callers who need async providers must use
                    // collectAsync() instead. Session recovery via reconstructSession()
                    // uses collect() as a fallback; the unpause() path replaces it
                    // with async evidence after reconstruction.
                    void snapshot.catch(() => undefined);
                    policyMetrics.recordEvidence(p.name, "failure", Date.now() - startedAt, options.loopId);
                    logEvent("evidence_async_provider_in_sync_collect", { provider: p.name });
                    continue;
                }
                const syncSnapshot = snapshot;
                policyMetrics.recordEvidence(p.name, syncSnapshot ? "available" : "unavailable", Date.now() - startedAt, options.loopId);
                if (syncSnapshot)
                    results.push(syncSnapshot);
            }
            catch (error) {
                policyMetrics.recordEvidence(p.name, "failure", Date.now() - startedAt, options.loopId);
                logEvent("evidence_provider_error", { provider: p.name, error: String(error) });
            }
        }
        return results;
    }
    /** Capture all providers concurrently with per-provider timeout isolation. */
    async collectAsync(options = {}) {
        const timeoutMs = options.timeoutMs ?? getPolicy().evidence.timeout_ms;
        const captures = this.providers.map(async (provider) => {
            const span = startSpan("evidence.capture", {
                provider: provider.name,
                loopId: options.loopId,
                timeoutMs,
            });
            const startedAt = Date.now();
            const controller = new AbortController();
            let timer;
            let timedOut = false;
            try {
                const capture = Promise.resolve(provider.capture({
                    signal: controller.signal,
                    timeoutMs,
                    loopId: options.loopId,
                    phase: options.phase ?? "after",
                }));
                const snapshot = timeoutMs > 0
                    ? await Promise.race([
                        capture,
                        new Promise((resolve) => {
                            timer = setTimeout(() => {
                                timedOut = true;
                                controller.abort(new Error(`Evidence provider timed out after ${timeoutMs}ms`));
                                resolve(null);
                            }, timeoutMs);
                        }),
                    ])
                    : await capture;
                const outcome = timedOut
                    ? "timeout"
                    : snapshot ? "available" : "unavailable";
                policyMetrics.recordEvidence(provider.name, outcome, Date.now() - startedAt, options.loopId);
                span.end(timedOut ? "cancelled" : "ok", { outcome });
                if (timedOut) {
                    logEvent("evidence_provider_timeout", { provider: provider.name, timeoutMs });
                }
                return timedOut ? null : snapshot;
            }
            catch (error) {
                policyMetrics.recordEvidence(provider.name, "failure", Date.now() - startedAt, options.loopId);
                span.end("error", { error: String(error) });
                logEvent("evidence_provider_error", { provider: provider.name, error: String(error) });
                return null;
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
        });
        return (await Promise.all(captures)).filter((snapshot) => snapshot !== null);
    }
}
function commandCwd(configured) {
    const workspace = realpathSync(process.cwd());
    const lexical = resolve(workspace, configured ?? ".");
    const lexicalRelative = relative(workspace, lexical);
    if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(lexicalRelative)) {
        throw new Error("command cwd must stay within the workspace");
    }
    const actual = realpathSync(lexical);
    const actualRelative = relative(workspace, actual);
    if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`) ||
        isAbsolute(actualRelative) || !statSync(actual).isDirectory()) {
        throw new Error("command cwd resolves outside the workspace");
    }
    return actual;
}
/** Explicit, shell-free verification command. Disabled unless configured. */
export class CommandEvidenceProvider {
    name;
    config;
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
        this.name = `command:${name}`;
    }
    capture(context) {
        const phase = context?.phase ?? "after";
        if (phase === "before" && this.config.phase === "after") {
            return Promise.resolve(null);
        }
        const startedAt = Date.now();
        const cap = Math.max(0, Math.min(20_000, this.config.max_output_chars));
        const timeoutMs = Math.max(1, Math.min(this.config.timeout_ms, context?.timeoutMs || this.config.timeout_ms));
        let cwd;
        if (!this.config.executable) {
            return Promise.resolve(this.snapshot(phase, "missing", null, null, "", "Command executable is empty", false, 0));
        }
        try {
            cwd = commandCwd(this.config.cwd);
        }
        catch (error) {
            return Promise.resolve(this.snapshot(phase, "invalid_cwd", null, null, "", String(error), false, Date.now() - startedAt));
        }
        return new Promise((resolveCapture) => {
            let stdout = "";
            let stderr = "";
            let truncated = false;
            let retained = 0;
            let settled = false;
            const append = (current, chunk) => {
                const text = String(chunk);
                if (retained >= cap) {
                    if (text.length > 0)
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
            const finish = (status, exitCode, signal) => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                context?.signal.removeEventListener("abort", abort);
                resolveCapture(this.snapshot(phase, status, exitCode, signal, stdout, stderr, truncated, Date.now() - startedAt));
            };
            const abort = () => {
                child.kill();
                finish("aborted", null, null);
            };
            child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
            child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
            child.once("error", (error) => {
                stderr = append(stderr, error.message);
                finish(error.code === "ENOENT" ? "missing" : "failed", null, null);
            });
            child.once("close", (code, signal) => {
                const passed = code !== null && this.config.success_exit_codes.includes(code);
                finish(passed ? "passed" : "failed", code, signal);
            });
            timer = setTimeout(() => {
                child.kill();
                finish("timeout", null, null);
            }, timeoutMs);
            timer.unref?.();
            if (context?.signal.aborted)
                abort();
            else
                context?.signal.addEventListener("abort", abort, { once: true });
        });
    }
    snapshot(phase, status, exitCode, signal, stdout, stderr, truncated, durationMs) {
        return {
            provider: this.name,
            timestamp: Date.now(),
            files: [],
            data: {
                kind: "command",
                commandName: this.config.name,
                required: this.config.required,
                phase,
                status,
                exitCode,
                signal,
                durationMs,
                stdout,
                stderr,
                truncated,
            },
        };
    }
}
// ── Built-in: GitEvidenceProvider ──────────────────────────────────────────
/** Captures git file state (tracked, staged, untracked) via existing
 *  captureGitFileState() logic. */
export class GitEvidenceProvider {
    name = "git";
    capture() {
        const state = captureGitFileState();
        if (!state)
            return null;
        const files = [...new Set([
                ...state.tracked,
                ...state.staged,
                ...state.untracked,
            ])].sort();
        const fingerprints = {};
        for (const file of files) {
            try {
                const stat = statSync(file);
                const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
                fingerprints[file] = `${stat.mode}:${hash}`;
            }
            catch {
                // Deleted files are evidence too.  A stable sentinel lets the diff
                // distinguish deleted/restored transitions across a round.
                fingerprints[file] = "missing";
            }
        }
        return {
            provider: "git",
            timestamp: Date.now(),
            files,
            data: {
                tracked: state.tracked,
                staged: state.staged,
                untracked: state.untracked,
                fingerprints,
            },
        };
    }
}
registerEvidenceProvider("git", () => new GitEvidenceProvider());
// ── Utility ────────────────────────────────────────────────────────────────
/** Extract merged file list from evidence snapshots for backward compat
 *  with runtimeFilesChanged (string[] | null).
 *
 *  Looks for the "git" provider first; falls back to merging all
 *  providers' files arrays (deduplicated). */
export function extractFilesFromSnapshots(snapshots) {
    if (snapshots.length === 0)
        return null;
    // Prefer the git provider for backward compat
    const gitSnapshot = snapshots.find((s) => s.provider === "git");
    if (gitSnapshot)
        return [...gitSnapshot.files].sort();
    // Fallback: merge all providers
    const allFiles = new Set();
    for (const s of snapshots) {
        for (const f of s.files)
            allFiles.add(f);
    }
    return [...allFiles].sort();
}
/** Compute a diff between two evidence collections (before → after).
 *  Returns files that appeared in the after-snapshot but not the before.
 *  Used by runtime.ts to compute runtimeFilesChanged. */
function snapshotFingerprints(snapshot) {
    const value = snapshot.data.fingerprints;
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
/** Return provider snapshots narrowed to evidence produced during this round.
 *  The full provider payload remains available in data, while files contains
 *  only added/removed/content-changed paths. */
export function diffSnapshotCollections(before, after) {
    return after.map((snapshot) => {
        const baseline = before.find((item) => item.provider === snapshot.provider);
        if (!baseline)
            return snapshot;
        return {
            ...snapshot,
            files: diffProviderSnapshot(baseline, snapshot),
        };
    });
}
export function diffSnapshots(before, after) {
    return extractFilesFromSnapshots(diffSnapshotCollections(before, after));
}
//# sourceMappingURL=evidence-provider.js.map