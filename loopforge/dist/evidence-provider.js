/** EvidenceProvider — Pluggable evidence capture interface (v1.18).
 *
 * This module defines an abstract EvidenceProvider interface so
 * additional evidence sources (test runners, linters, bundle analysis)
 * can be added without touching the verification pipeline.
 *
 * Built-in provider: GitEvidenceProvider — git file state capture with
 * parallel async execution (v2.0.1) and a synchronous fallback.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { spawn, execFile, } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import { containInWorkspace } from "./workspace.js";
import { getPolicy } from "./policy.js";
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
// ── EvidenceCollector ──────────────────────────────────────────────────────
/** Collects evidence from all configured providers (always async — the
 *  synchronous collect() was removed in v3.7).
 *
 * Usage:
 *   const collector = new EvidenceCollector([new GitEvidenceProvider()]);
 *   const snapshots = await collector.collectAsync({ phase: "before" });
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
    // v3.7: the synchronous collect() was removed with the sync lifecycle
    // (prepareSync / captureGitFileState) — evidence collection is always
    // async (collectAsync). It never worked for async providers anyway: they
    // were silently skipped and recorded as failures.
    /** Capture all providers concurrently with per-provider timeout isolation. */
    async collectAsync(options = {}) {
        const timeoutMs = options.timeoutMs ?? getPolicy().evidence.timeout_ms;
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
                if (timedOut) {
                    logEvent("evidence_provider_timeout", { provider: provider.name, timeoutMs });
                }
                return timedOut ? null : snapshot;
            }
            catch (error) {
                policyMetrics.recordEvidence(provider.name, "failure", Date.now() - startedAt, options.loopId);
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
            return Promise.resolve(this.snapshot(phase, "missing", null, null, "", "Command executable is empty", false, 0, []));
        }
        try {
            cwd = commandCwd(this.config.cwd);
        }
        catch (error) {
            return Promise.resolve(this.snapshot(phase, "invalid_cwd", null, null, "", String(error), false, Date.now() - startedAt, []));
        }
        // v3.3: Workspace entrypoint files for tamper detection at the gate.
        const entrypointFiles = resolveEntrypointFiles(this.config.executable, this.config.args, cwd);
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
                resolveCapture(this.snapshot(phase, status, exitCode, signal, stdout, stderr, truncated, Date.now() - startedAt, entrypointFiles));
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
    snapshot(phase, status, exitCode, signal, stdout, stderr, truncated, durationMs, entrypointFiles) {
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
export async function captureGitFileStateAsync(signal, timeoutMs) {
    const timeout = timeoutMs ?? 15000;
    const runGit = (args) => {
        return new Promise((resolve, reject) => {
            const child = execFile("git", [...args], {
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
                    ? resolve(stdout)
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
/** v3.7: async capture only — the synchronous captureGitFileState() fallback
 *  was removed together with the sync lifecycle (prepareSync). */
export class GitEvidenceProvider {
    name = "git";
    capture(context) {
        return captureGitFileStateAsync(context?.signal, context?.timeoutMs).then((state) => {
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
                    // v2.13: HEAD commit hash for backtrack workspace restore
                    head: state.head,
                },
            };
        });
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
// ═══════════════════════════════════════════════════════════════════════════
// v3.3.1: Backtrack auto-restore (engine.backtrack_auto_restore)
// ═══════════════════════════════════════════════════════════════════════════
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
export async function runBacktrackAutoRestore(gitHead, round,
/** v3.3.1: workspace root; injectable so tests can run against a temp
 *  repo. Defaults to the process cwd, matching the evidence providers. */
cwd = process.cwd()) {
    const run = (args) => new Promise((resolvePromise) => {
        execFile("git", args, {
            cwd,
            shell: false,
            timeout: 30_000,
        }, (error, stdout, stderr) => {
            if (error) {
                resolvePromise({ ok: false, out: String(stderr || error.message) });
                return;
            }
            resolvePromise({ ok: true, out: String(stdout) });
        });
    });
    const steps = [];
    const stash = await run(["stash", "push", "-u", "-m", `loopforge-backtrack-round-${round}`]);
    const workspaceWasClean = stash.out.includes("No local changes");
    steps.push(`stash: ${workspaceWasClean ? "clean (nothing to stash)" : stash.ok ? "ok" : `failed — ${stash.out.trim()}`}`);
    if (gitHead) {
        const reset = await run(["reset", "--hard", gitHead]);
        steps.push(`reset --hard ${gitHead.slice(0, 12)}: ${reset.ok ? "ok" : `failed — ${reset.out.trim()}`}`);
        return { ok: reset.ok, detail: steps.join("; ") };
    }
    return { ok: workspaceWasClean || stash.ok, detail: steps.join("; ") };
}
//# sourceMappingURL=evidence-provider.js.map