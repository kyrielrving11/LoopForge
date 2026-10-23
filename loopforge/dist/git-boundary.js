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
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, lstatSync, readlinkSync, writeFileSync, } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { containInWorkspace } from "./workspace.js";
export class GitCaptureFailure extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "GitCaptureFailure";
    }
}
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** Bounded file-hash concurrency. A module constant, not a policy knob. */
export const BOUNDARY_HASH_CONCURRENCY = 16;
function splitNul(text) {
    return text.split("\0").filter((entry) => entry.length > 0);
}
function uniqueSorted(values) {
    return [...new Set(values)].sort();
}
/** Parse `git ls-files --stage -z`. A conflicted path can have several
 *  stages; stage 0 wins when present, otherwise the first entry is kept. The
 *  worktree fingerprint is what matters, so this is only used to recognise
 *  gitlinks and to carry the index object id. */
function parseStageEntries(text) {
    const byPath = new Map();
    for (const record of splitNul(text)) {
        const tab = record.indexOf("\t");
        if (tab < 0)
            continue;
        const [mode, object, stage] = record.slice(0, tab).split(" ");
        if (!mode || !object || !stage)
            continue;
        const path = record.slice(tab + 1);
        if (!path)
            continue;
        const existing = byPath.get(path);
        if (!existing || stage === "0") {
            byPath.set(path, { entry: { path, mode, object }, stage });
        }
    }
    return [...byPath.values()]
        .map((item) => item.entry)
        .sort((a, b) => a.path.localeCompare(b.path));
}
/** Run one fixed-argument, shell-free Git command. Callers must never pass
 *  user-controlled path/ref text through a shell; arguments stay an array. */
export function runGitCommand(args, options) {
    const timeout = options.timeoutMs ?? 15_000;
    return new Promise((resolveGit, reject) => {
        let settled = false;
        const succeed = (stdout) => {
            if (settled)
                return;
            settled = true;
            resolveGit(stdout);
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        };
        const child = execFile("git", ["-c", "core.quotePath=false", ...args], {
            cwd: options.cwd,
            encoding: "utf-8",
            timeout,
            signal: options.signal,
            maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr?.on("data", (chunk) => {
            stderr += chunk;
        });
        child.on("close", (code) => {
            if (code === 0)
                succeed(stdout);
            else if (code === null) {
                fail(new GitCaptureFailure("timeout", `git ${args[0]} was killed`));
            }
            else if (/not a git repository|not a repository/i.test(stderr)) {
                fail(new GitCaptureFailure("unavailable", stderr.trim() || "not a git repository"));
            }
            else {
                fail(new GitCaptureFailure("error", `git ${args[0]} exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`));
            }
        });
        child.on("error", (error) => {
            if (options.signal?.aborted) {
                fail(new GitCaptureFailure("aborted", `git ${args[0]} aborted`));
            }
            else if (error.code === "ENOENT") {
                fail(new GitCaptureFailure("unavailable", "git executable was not found"));
            }
            else if (error.killed || error.signal) {
                fail(new GitCaptureFailure("timeout", `git ${args[0]} timed out after ${timeout}ms`));
            }
            else if (/not a git repository/i.test(error.message)) {
                fail(new GitCaptureFailure("unavailable", error.message));
            }
            else {
                fail(new GitCaptureFailure("error", error.message));
            }
        });
    });
}
/** Run a fixed-argument Git command and preserve its exit status. Used by the
 *  restore executor for commands whose non-zero exit is a meaningful answer
 *  (`merge-base --is-ancestor`). */
export function runGitCommandStatus(args, options) {
    const timeout = options.timeoutMs ?? 15_000;
    return new Promise((resolveStatus) => {
        execFile("git", ["-c", "core.quotePath=false", ...args], {
            cwd: options.cwd,
            encoding: "utf-8",
            timeout,
            signal: options.signal,
            maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            const code = error && typeof error.code === "number"
                ? error.code
                : error
                    ? null
                    : 0;
            resolveStatus({
                code,
                stdout: String(stdout ?? ""),
                stderr: String(stderr ?? ""),
                ...(error ? { error: error.message } : {}),
            });
        });
    });
}
/** Capture the complete boundary state. All required git commands run in one
 *  parallel batch; HEAD is best-effort (a repository with no commit is a
 *  valid boundary with no head). Any required-command failure returns an
 *  explicit status — never an empty-but-observed boundary. */
export async function captureGitFileStateAsync(signal, timeoutMs,
/** Workspace root; injectable so tests can capture against a temp repo.
 *  Defaults to the process cwd, matching the evidence providers. */
cwd = process.cwd()) {
    const runGit = (args) => runGitCommand(args, { cwd, signal, timeoutMs });
    try {
        // allSettled, not all: on failure the other children must still finish
        // before this capture returns, or Windows keeps the workspace directory
        // locked (and every caller would leak child-process handles).
        const settled = await Promise.allSettled([
            runGit(["ls-files", "--stage", "-z"]),
            runGit(["ls-files", "--others", "--exclude-standard", "-z"]),
            runGit(["diff", "--name-only", "-z"]),
            runGit(["diff", "--cached", "--name-only", "-z"]),
        ]);
        const failures = settled
            .filter((item) => item.status === "rejected")
            .map((item) => item.reason)
            .filter((error) => error instanceof GitCaptureFailure);
        if (failures.length > 0) {
            const failure = failures.find((item) => item.status === "aborted" || item.status === "timeout") ?? failures[0];
            throw failure;
        }
        const rejected = settled.find((item) => item.status === "rejected");
        if (rejected) {
            throw new GitCaptureFailure("error", String(rejected.reason));
        }
        const [stageOut, untrackedOut, unstagedOut, stagedOut] = settled.map((item) => item.value);
        let head;
        try {
            head = (await runGit(["rev-parse", "--verify", "HEAD"])).trim() || undefined;
        }
        catch (error) {
            // A repository with no commit has no HEAD. Abort still propagates.
            if (error instanceof GitCaptureFailure && error.status === "aborted")
                throw error;
        }
        const untracked = uniqueSorted(splitNul(untrackedOut));
        return {
            ok: true,
            state: {
                tracked: parseStageEntries(stageOut),
                untracked,
                dirty: uniqueSorted([
                    ...splitNul(unstagedOut),
                    ...splitNul(stagedOut),
                    ...untracked,
                ]),
                head,
            },
        };
    }
    catch (error) {
        if (error instanceof GitCaptureFailure) {
            return { ok: false, status: error.status, detail: error.message };
        }
        return { ok: false, status: "error", detail: String(error) };
    }
}
function hashText(text) {
    return createHash("sha256").update(text).digest("hex");
}
/** Stream a regular file through SHA-256 without loading it into memory. */
function hashFileStream(abs, signal) {
    return new Promise((resolveHash, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(abs, { highWaterMark: 64 * 1024 });
        let settled = false;
        const cleanup = () => {
            if (signal)
                signal.removeEventListener("abort", onAbort);
        };
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            if (error)
                reject(error);
            else
                resolveHash(hash.digest("hex"));
        };
        const onAbort = () => {
            stream.destroy();
            finish(new GitCaptureFailure("aborted", "boundary hashing aborted"));
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", (error) => finish(error));
        stream.on("end", () => finish());
    });
}
/** Hash a regular file while optionally copying it to a temp blob. The hash
 *  and the copied bytes come from the SAME stream, so a checkpoint can never
 *  reference content it did not fingerprint. */
function hashAndMaybeMaterialize(abs, materializer, signal) {
    if (!materializer) {
        return hashFileStream(abs, signal).then((hash) => ({ hash }));
    }
    return new Promise((resolveResult, reject) => {
        const hash = createHash("sha256");
        const temp = materializer.tempPath();
        const source = createReadStream(abs, { highWaterMark: 64 * 1024 });
        const sink = createWriteStream(temp, { mode: 0o600 });
        let settled = false;
        let sourceEnded = false;
        const cleanup = () => {
            if (signal)
                signal.removeEventListener("abort", onAbort);
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            source.destroy();
            sink.destroy();
            try {
                materializer.discardTemp(temp);
            }
            catch { /* best effort */ }
            reject(error);
        };
        const succeed = () => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolveResult({ hash: hash.digest("hex"), temp });
        };
        const onAbort = () => {
            fail(new GitCaptureFailure("aborted", "boundary content capture aborted"));
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        source.on("data", (chunk) => {
            const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            hash.update(bytes);
            if (!sink.write(bytes))
                source.pause();
        });
        sink.on("drain", () => source.resume());
        source.on("error", (error) => fail(error));
        sink.on("error", (error) => fail(error));
        source.on("end", () => {
            sourceEnded = true;
            sink.end();
        });
        sink.on("finish", () => {
            if (sourceEnded)
                succeed();
        });
    });
}
/** Fingerprint one boundary path.
 *  - symlinks hash their LINK TEXT; the target is never read
 *  - regular files stream their content
 *  - gitlinks record the index commit (submodule contents are not covered)
 *  A per-file read/containment failure is an explicit `unreadable:<mode>`
 *  sentinel, not an omitted path. */
async function boundaryFingerprint(workspace, path, tracked, signal) {
    const abs = resolve(workspace, path);
    let stat;
    try {
        stat = lstatSync(abs);
    }
    catch (error) {
        return error.code === "ENOENT" ? "missing" : "unreadable";
    }
    const mode = stat.mode;
    if (stat.isSymbolicLink()) {
        try {
            // The parent must be contained; the final link target is NOT followed.
            const parent = path.includes("/")
                ? path.slice(0, path.lastIndexOf("/")) || "."
                : ".";
            containInWorkspace(workspace, parent);
            return `link:${hashText(readlinkSync(abs))}`;
        }
        catch {
            return `unreadable:${mode}`;
        }
    }
    if (stat.isDirectory()) {
        if (tracked?.mode === "160000")
            return `gitlink:${tracked.object}`;
        return `dir:${mode}`;
    }
    if (!stat.isFile())
        return `other:${mode}`;
    try {
        containInWorkspace(workspace, path);
        const digest = await hashFileStream(abs, signal);
        return `${mode}:${digest}`;
    }
    catch (error) {
        if (error instanceof GitCaptureFailure)
            throw error;
        return `unreadable:${mode}`;
    }
}
/** Hash the complete boundary with bounded concurrency. When a materializer
 *  and a dirty-path set are supplied, dirty regular files/symlink texts are
 *  copied into the content store while they are hashed. */
async function fingerprintBoundary(workspace, entries, dirty, materializer, signal) {
    const paths = [...entries.keys()].sort();
    const fingerprints = {};
    const contents = [];
    let materializationError;
    let next = 0;
    const worker = async () => {
        for (;;) {
            if (signal?.aborted) {
                throw new GitCaptureFailure("aborted", "boundary hashing aborted");
            }
            const index = next++;
            if (index >= paths.length)
                return;
            const path = paths[index];
            const tracked = entries.get(path);
            const shouldMaterialize = Boolean(materializer) && dirty.has(path);
            if (!shouldMaterialize) {
                const fingerprint = await boundaryFingerprint(workspace, path, tracked, signal);
                fingerprints[path] = fingerprint;
                // A checkpoint cannot be complete when a boundary path is unreadable
                // or is not a file/symlink/gitlink/dir. Evidence itself stays
                // observed, but the materializer records why recovery is unavailable.
                if (materializer && fingerprint.startsWith("unreadable")) {
                    materializationError ??= {
                        code: "unreadable_path",
                        detail: `cannot read ${path}`,
                    };
                }
                else if (materializer && fingerprint.startsWith("other:")) {
                    materializationError ??= {
                        code: "unsupported_file_type",
                        detail: `${path} is not a regular file`,
                    };
                }
                continue;
            }
            const abs = resolve(workspace, path);
            let stat;
            try {
                stat = lstatSync(abs);
            }
            catch (error) {
                fingerprints[path] = error.code === "ENOENT"
                    ? "missing"
                    : "unreadable";
                if (fingerprints[path] === "unreadable") {
                    materializationError ??= {
                        code: "unreadable_path",
                        detail: `cannot read ${path}`,
                    };
                }
                continue;
            }
            if (stat.isSymbolicLink()) {
                try {
                    const parent = path.includes("/")
                        ? path.slice(0, path.lastIndexOf("/")) || "."
                        : ".";
                    containInWorkspace(workspace, parent);
                    const text = readlinkSync(abs);
                    const hash = hashText(text);
                    fingerprints[path] = `link:${hash}`;
                    if (materializer.hasBlob(hash)) {
                        contents.push(path);
                        continue;
                    }
                    const temp = materializer.tempPath();
                    try {
                        writeFileSync(temp, text, { mode: 0o600 });
                        materializer.commitBlob(hash, temp);
                        contents.push(path);
                    }
                    catch (error) {
                        try {
                            materializer.discardTemp(temp);
                        }
                        catch { /* best effort */ }
                        materializationError ??= {
                            code: "content_write_failed",
                            detail: `symlink ${path}: ${String(error)}`,
                        };
                    }
                }
                catch {
                    fingerprints[path] = `unreadable:${stat.mode}`;
                    materializationError ??= {
                        code: "unreadable_path",
                        detail: `cannot read symlink ${path}`,
                    };
                }
                continue;
            }
            if (stat.isDirectory()) {
                fingerprints[path] = tracked?.mode === "160000"
                    ? `gitlink:${tracked.object}`
                    : `dir:${stat.mode}`;
                continue;
            }
            if (!stat.isFile()) {
                fingerprints[path] = `other:${stat.mode}`;
                materializationError ??= {
                    code: "unsupported_file_type",
                    detail: `${path} is not a regular file`,
                };
                continue;
            }
            try {
                containInWorkspace(workspace, path);
                const result = await hashAndMaybeMaterialize(abs, materializer, signal);
                fingerprints[path] = `${stat.mode}:${result.hash}`;
                if (result.temp) {
                    try {
                        if (materializer.hasBlob(result.hash))
                            materializer.discardTemp(result.temp);
                        else
                            materializer.commitBlob(result.hash, result.temp);
                        contents.push(path);
                    }
                    catch (error) {
                        try {
                            materializer.discardTemp(result.temp);
                        }
                        catch { /* best effort */ }
                        materializationError ??= {
                            code: "content_write_failed",
                            detail: `file ${path}: ${String(error)}`,
                        };
                    }
                }
            }
            catch (error) {
                if (error instanceof GitCaptureFailure)
                    throw error;
                // The combined hash+copy stream can fail on the STORE side (disk
                // full, permission) while the file itself is readable. Never let a
                // materialization failure downgrade the evidence fingerprint: retry
                // the hash without the content sink.
                try {
                    fingerprints[path] = `${stat.mode}:${await hashFileStream(abs, signal)}`;
                }
                catch {
                    fingerprints[path] = `unreadable:${stat.mode}`;
                    materializationError ??= {
                        code: "unreadable_path",
                        detail: `cannot read ${path}`,
                    };
                    continue;
                }
                materializationError ??= {
                    code: "content_write_failed",
                    detail: `file ${path}: ${String(error)}`,
                };
            }
        }
    };
    const workers = Math.min(BOUNDARY_HASH_CONCURRENCY, Math.max(1, paths.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return { fingerprints, contents: contents.sort(), materializationError };
}
// ── The shared capture ─────────────────────────────────────────────────────
/** Refresh the index stat cache and reject index states a delta checkpoint
 *  cannot represent. Non-zero from `update-index --refresh` is normal for a
 *  modified worktree; only a real Git failure is an error. */
async function prepareIndexForCheckpoint(cwd, signal, timeoutMs) {
    try {
        await runGitCommand(["update-index", "--refresh", "-q"], { cwd, signal, timeoutMs });
    }
    catch (error) {
        if (error instanceof GitCaptureFailure &&
            (error.status === "aborted" || error.status === "timeout" ||
                error.status === "unavailable")) {
            throw error;
        }
        // exit 1 means "files need refresh"; the index was still refreshed.
    }
    const unmerged = await runGitCommand(["ls-files", "-u", "-z"], { cwd, signal, timeoutMs });
    if (unmerged.length > 0) {
        throw new GitCaptureFailure("error", "unmerged index entries cannot be represented by a checkpoint");
    }
    // Sparse checkout / skip-worktree (`S`) and assume-unchanged (lowercase
    // tags) make the worktree an incomplete view of the index. A checkpoint
    // cannot represent that boundary; fail before writing recovery material.
    const flagged = await runGitCommand(["ls-files", "-v", "-z"], { cwd, signal, timeoutMs });
    for (const record of flagged.split("\0").filter(Boolean)) {
        const tag = record[0] ?? "";
        if (tag === "S" || (tag >= "a" && tag <= "z")) {
            throw new GitCaptureFailure("error", "skip-worktree/assume-unchanged index entries cannot be represented by a checkpoint");
        }
    }
}
/** Capture the full boundary, optionally materializing dirty content.
 *
 *  The fingerprint map is always complete. Materialization failures are
 *  reported on the boundary as `materializationError` and never downgrade the
 *  evidence: the caller can still use the fingerprints/head. */
export async function captureBoundary(options) {
    const { cwd, signal, timeoutMs, exclude } = options;
    let materializer = options.materializer;
    let materializationError;
    if (materializer && options.refreshIndex !== false) {
        try {
            await prepareIndexForCheckpoint(cwd, signal, timeoutMs);
        }
        catch (error) {
            if (error instanceof GitCaptureFailure &&
                (error.status === "aborted" || error.status === "timeout" ||
                    error.status === "unavailable")) {
                return { ok: false, status: error.status, detail: error.message };
            }
            // Index state is unsupported for a delta checkpoint. Evidence can still
            // be captured in full; content materialization is disabled.
            materializationError = {
                code: "unsupported_index",
                detail: String(error instanceof Error ? error.message : error),
            };
            materializer = undefined;
        }
    }
    const result = await captureGitFileStateAsync(signal, timeoutMs, cwd);
    if (!result.ok)
        return result;
    const state = result.state;
    const isExcluded = exclude ?? (() => false);
    const tracked = state.tracked.filter((entry) => !isExcluded(entry.path));
    const untracked = state.untracked.filter((file) => !isExcluded(file));
    const dirty = state.dirty.filter((file) => !isExcluded(file));
    const boundary = new Map();
    for (const entry of tracked)
        boundary.set(entry.path, entry);
    for (const file of untracked) {
        if (!boundary.has(file)) {
            boundary.set(file, { path: file, mode: "", object: "" });
        }
    }
    if (options.maxPaths !== undefined && boundary.size > options.maxPaths) {
        materializationError = {
            code: "too_many_paths",
            detail: `boundary has ${boundary.size} paths (max ${options.maxPaths})`,
        };
        materializer = undefined;
    }
    const fingerprints = await fingerprintBoundary(cwd, boundary, new Set(dirty), materializer, signal);
    materializationError ??= fingerprints.materializationError;
    return {
        ok: true,
        boundary: {
            ...(state.head ? { head: state.head } : {}),
            dirty,
            fingerprints: fingerprints.fingerprints,
            contents: fingerprints.contents,
            ...(materializationError ? { materializationError } : {}),
        },
    };
}
//# sourceMappingURL=git-boundary.js.map