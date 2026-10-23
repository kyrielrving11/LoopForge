/** v3.9.8: deterministic workspace restore.
 *
 * This module is the ONLY place LoopForge mutates the working tree. It runs
 * only after a typed rollback directive has been committed, restores the
 * declared Git boundary (content + HEAD), and verifies the result exactly.
 * It never chooses a target and never interprets the Agent's reason.
 *
 * Preconditions are checked before the destructive part: manifest/content
 * hashes, path containment, index state, target HEAD reachability, and
 * directory/type conflicts. File-by-file restore is not atomic; every retry
 * re-plans from the directive + manifest and is idempotent.
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { captureBoundary, runGitCommandStatus } from "./git-boundary.js";
import { containInWorkspace } from "./workspace.js";
import { EvidenceCollector } from "./evidence-provider.js";
export class RestoreFailure extends Error {
    reasonCode;
    details;
    constructor(reasonCode, message, details) {
        super(message);
        this.reasonCode = reasonCode;
        this.details = details;
        this.name = "RestoreFailure";
    }
}
function sha256File(path) {
    return new Promise((resolveHash, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolveHash(hash.digest("hex")));
    });
}
function isRuntimePath(abs, workspace, stateDir, exclude) {
    if (exclude?.(abs))
        return true;
    if (!stateDir)
        return false;
    const stateAbs = resolve(workspace, stateDir);
    const rel = relative(stateAbs, abs);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}
function safeTargetPath(path, context) {
    if (!path || path.includes("\0")) {
        throw new RestoreFailure("unsafe_path", "path is empty or contains NUL");
    }
    if (path === ".git" || path.startsWith(".git/") || path === ".git\\" ||
        path.startsWith(".git\\")) {
        throw new RestoreFailure("unsafe_path", `refusing to restore .git path ${path}`);
    }
    // Validate the lexical parent and its realpath ancestors, but return the
    // LEXICAL path: the final component may be a symlink that must be replaced,
    // not followed. A symlink whose link text points outside is a valid target
    // state; writing THROUGH a symlinked parent is what must be refused.
    const parent = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/")) || "."
        : ".";
    try {
        containInWorkspace(context.workspace, parent);
    }
    catch (error) {
        throw new RestoreFailure("unsafe_path", `path ${path} leaves the workspace: ${String(error)}`);
    }
    const abs = resolve(context.workspace, path);
    if (isRuntimePath(abs, context.workspace, context.stateDir, context.exclude)) {
        throw new RestoreFailure("unsafe_path", `refusing to restore runtime path ${path}`);
    }
    return abs;
}
function fingerprintKind(fingerprint) {
    if (fingerprint === "missing")
        return { kind: "missing" };
    if (fingerprint.startsWith("link:")) {
        return { kind: "symlink", hash: fingerprint.slice(5) };
    }
    if (fingerprint.startsWith("gitlink:"))
        return { kind: "gitlink" };
    if (fingerprint.startsWith("dir:"))
        return { kind: "dir" };
    const match = /^(\d+):([a-f0-9]{64})$/.exec(fingerprint);
    if (match) {
        return { kind: "file", mode: Number(match[1]), hash: match[2] };
    }
    return { kind: "unsupported" };
}
async function verifyBlobs(manifest, store) {
    for (const path of manifest.contents) {
        const fingerprint = manifest.fingerprints[path];
        const parsed = fingerprintKind(fingerprint);
        if (parsed.kind !== "file" && parsed.kind !== "symlink") {
            throw new RestoreFailure("manifest_invalid", `content path ${path} has unsupported fingerprint ${fingerprint}`);
        }
        const blob = store.blobPath(parsed.hash);
        if (!existsSync(blob)) {
            throw new RestoreFailure("blob_missing", `content blob for ${path} is missing`);
        }
        const actual = await sha256File(blob);
        if (actual !== parsed.hash) {
            throw new RestoreFailure("blob_corrupt", `content blob for ${path} failed its hash check`);
        }
    }
}
function assertSafeAncestors(abs, context) {
    const rel = relative(context.workspace, abs);
    const parts = rel.split(sep);
    let current = context.workspace;
    for (let i = 0; i < parts.length - 1; i++) {
        current = resolve(current, parts[i]);
        try {
            const stat = lstatSync(current);
            if (stat.isSymbolicLink()) {
                throw new RestoreFailure("unsafe_path", `refusing to write through symlink parent ${current}`);
            }
            if (!stat.isDirectory()) {
                throw new RestoreFailure("path_conflict", `parent ${current} is not a directory`);
            }
        }
        catch (error) {
            if (error.code === "ENOENT") {
                mkdirSync(current);
                continue;
            }
            throw error;
        }
    }
}
function removePath(abs, context, allowDir = false) {
    let stat;
    try {
        stat = lstatSync(abs);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw new RestoreFailure("restore_io_error", `cannot stat ${abs}: ${String(error)}`);
    }
    if (stat.isDirectory()) {
        if (!allowDir) {
            throw new RestoreFailure("path_conflict", `refusing to delete non-empty directory ${abs}`);
        }
        try {
            if (readdirSync(abs).length > 0) {
                throw new RestoreFailure("path_conflict", `directory ${abs} contains out-of-boundary content`);
            }
            rmdirSync(abs);
            return true;
        }
        catch (error) {
            if (error instanceof RestoreFailure)
                throw error;
            throw new RestoreFailure("restore_io_error", `cannot remove ${abs}: ${String(error)}`);
        }
    }
    try {
        if (stat.isFile() || stat.isSymbolicLink()) {
            try {
                unlinkSync(abs);
            }
            catch (error) {
                if (error.code === "EPERM" ||
                    error.code === "EACCES") {
                    chmodSync(abs, 0o666);
                    unlinkSync(abs);
                }
                else {
                    throw error;
                }
            }
            return true;
        }
        throw new RestoreFailure("restore_io_error", `unsupported file type at ${abs}`);
    }
    catch (error) {
        if (error instanceof RestoreFailure)
            throw error;
        throw new RestoreFailure("restore_io_error", `cannot remove ${abs}: ${String(error)}`);
    }
}
function planDeletions(target, current, context) {
    const targetPaths = new Set(Object.keys(target.fingerprints));
    const deletions = Object.keys(current.fingerprints)
        .filter((path) => !targetPaths.has(path))
        .sort((a, b) => b.length - a.length);
    // Preflight type conflicts before any mutation: a target file/missing path
    // that is currently a directory may only be removed when every entry in it
    // is also scheduled for deletion.
    const deletionSet = new Set(deletions);
    for (const path of Object.keys(target.fingerprints)) {
        const kind = fingerprintKind(target.fingerprints[path]);
        if (kind.kind === "dir" || kind.kind === "gitlink")
            continue;
        const abs = safeTargetPath(path, context);
        let stat;
        try {
            stat = lstatSync(abs);
        }
        catch {
            continue;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink())
            continue;
        for (const entry of readdirSync(abs)) {
            const childRel = `${path}/${entry}`;
            if (!deletionSet.has(childRel) && !targetPaths.has(childRel)) {
                throw new RestoreFailure("path_conflict", `target ${path} is a directory containing ${childRel}, which is outside the restore boundary`);
            }
        }
    }
    return deletions;
}
function shortHead(head) {
    return head ? head.slice(0, 12) : null;
}
async function gitStatus(args, context) {
    return runGitCommandStatus(args, {
        cwd: context.workspace,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
    });
}
async function headRelation(targetHead, currentHead, context) {
    if (targetHead === currentHead)
        return "equal";
    const backward = await gitStatus(["merge-base", "--is-ancestor", targetHead, currentHead], context);
    if (backward.code === 0)
        return "backward";
    const forward = await gitStatus(["merge-base", "--is-ancestor", currentHead, targetHead], context);
    if (forward.code === 0)
        return "forward";
    return "diverged";
}
/** Read-only restore preflight. Throws RestoreFailure with a stable reason. */
export async function preflightRestore(input) {
    const context = {
        workspace: input.workspace,
        store: input.store,
        ...(input.stateDir ? { stateDir: input.stateDir } : {}),
        ...(input.exclude ? { exclude: input.exclude } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };
    // Paths first: never hash content for a target that could escape.
    const resolved = new Map();
    const caseInsensitive = process.platform === "win32";
    for (const path of Object.keys(input.manifest.fingerprints)) {
        const abs = safeTargetPath(path, context);
        const key = caseInsensitive ? abs.toLowerCase() : abs;
        if (resolved.has(key) && resolved.get(key) !== abs) {
            throw new RestoreFailure("path_conflict", `duplicate path after normalization: ${path}`);
        }
        resolved.set(key, abs);
        const kind = fingerprintKind(input.manifest.fingerprints[path]);
        if (kind.kind === "unsupported") {
            throw new RestoreFailure("unsupported_boundary", `path ${path} has an unrestorable fingerprint`);
        }
    }
    if (input.manifest.head !== undefined &&
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.manifest.head)) {
        throw new RestoreFailure("target_head_invalid", "checkpoint HEAD is not a Git hash");
    }
    await verifyBlobs(input.manifest, input.store);
    const unmerged = await gitStatus(["ls-files", "-u", "-z"], context);
    if (unmerged.code !== 0) {
        throw new RestoreFailure("git_unavailable", "cannot read the Git index");
    }
    if (unmerged.stdout.length > 0) {
        throw new RestoreFailure("index_unmerged", "the Git index has unmerged entries");
    }
    const verbose = await gitStatus(["ls-files", "-v", "-z"], context);
    if (verbose.code !== 0) {
        throw new RestoreFailure("git_unavailable", "cannot read Git index flags");
    }
    for (const record of verbose.stdout.split("\0").filter(Boolean)) {
        const tag = record[0] ?? "";
        const path = record.slice(2);
        if (tag === "S" || (tag >= "a" && tag <= "z")) {
            throw new RestoreFailure("index_unsupported", `path ${path} has skip-worktree/assume-unchanged state a checkpoint cannot represent`);
        }
    }
    if (input.manifest.head) {
        const exists = await gitStatus(["rev-parse", "--verify", `${input.manifest.head}^{commit}`], context);
        if (exists.code !== 0) {
            throw new RestoreFailure("target_head_missing", `checkpoint HEAD ${input.manifest.head} is not present in this repository`);
        }
    }
    if (input.stateDir) {
        const rel = relative(input.workspace, resolve(input.workspace, input.stateDir));
        if (rel && !rel.startsWith("..") && !resolve(rel).startsWith("..")) {
            const tracked = await gitStatus(["ls-files", "-z", "--", rel], context);
            if (tracked.code === 0 && tracked.stdout.length > 0) {
                throw new RestoreFailure("state_dir_tracked", "the runtime state directory is tracked by Git; refusing a destructive restore");
            }
        }
    }
    const current = await captureBoundary({
        cwd: input.workspace,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.exclude ? { exclude: input.exclude } : {}),
    });
    if (!current.ok) {
        throw new RestoreFailure("git_unavailable", `cannot observe the current workspace: ${current.detail}`);
    }
    if (current.boundary.materializationError) {
        // No materializer was requested; a leftover error means an index/model
        // problem that makes the current boundary unsafe to mutate.
        throw new RestoreFailure("current_boundary_unsupported", current.boundary.materializationError.detail);
    }
    const currentHead = current.boundary.head;
    if (input.manifest.head === undefined && currentHead !== undefined) {
        throw new RestoreFailure("target_head_invalid", "the checkpoint has no HEAD but the workspace has commits");
    }
    let backward = false;
    if (input.manifest.head && currentHead) {
        const relation = await headRelation(input.manifest.head, currentHead, context);
        if (relation === "diverged") {
            throw new RestoreFailure("head_diverged", `checkpoint HEAD ${shortHead(input.manifest.head)} is not an ancestor/descendant of current HEAD ${shortHead(currentHead)}`);
        }
        backward = relation === "backward";
    }
    // Type-conflict planning is part of the preflight: no mutation yet.
    planDeletions(input.manifest, current.boundary, context);
    return {
        manifest: input.manifest,
        currentBoundary: current.boundary,
        ...(input.manifest.head ? { targetHead: input.manifest.head } : {}),
        ...(currentHead ? { currentHead } : {}),
        backward,
    };
}
function sameBoundary(manifest, actual) {
    const expectedHead = manifest.head ?? null;
    const actualHead = actual.head ?? null;
    if (expectedHead !== actualHead) {
        return {
            ok: false,
            detail: `HEAD mismatch: expected ${expectedHead ?? "<none>"}, got ${actualHead ?? "<none>"}`,
        };
    }
    const expectedKeys = Object.keys(manifest.fingerprints).sort();
    const actualKeys = Object.keys(actual.fingerprints).sort();
    if (expectedKeys.length !== actualKeys.length ||
        expectedKeys.some((key, index) => key !== actualKeys[index])) {
        const missing = expectedKeys.filter((key) => !(key in actual.fingerprints)).slice(0, 10);
        const extra = actualKeys.filter((key) => !(key in manifest.fingerprints)).slice(0, 10);
        return {
            ok: false,
            detail: `boundary key mismatch; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`,
        };
    }
    const mismatched = expectedKeys.filter((key) => manifest.fingerprints[key] !== actual.fingerprints[key]);
    if (mismatched.length > 0) {
        return {
            ok: false,
            detail: `fingerprint mismatch at ${mismatched.slice(0, 10).join(", ")}`,
        };
    }
    return { ok: true };
}
function writeTarget(path, fingerprint, abs, context) {
    const parsed = fingerprintKind(fingerprint);
    if (parsed.kind === "unsupported") {
        throw new RestoreFailure("unsupported_boundary", `cannot restore ${path}`);
    }
    assertSafeAncestors(abs, context);
    if (parsed.kind === "missing") {
        removePath(abs, context, true);
        return "written";
    }
    if (parsed.kind === "gitlink" || parsed.kind === "dir") {
        try {
            const stat = lstatSync(abs);
            if (stat.isSymbolicLink() || stat.isFile())
                removePath(abs, context);
            else if (!stat.isDirectory()) {
                throw new RestoreFailure("path_conflict", `${path} has an unsupported type`);
            }
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                if (error instanceof RestoreFailure)
                    throw error;
                throw new RestoreFailure("restore_io_error", `cannot inspect ${path}: ${String(error)}`);
            }
        }
        mkdirSync(abs, { recursive: true });
        return "written";
    }
    // A regular file or symlink replaces any existing non-directory entry.
    try {
        const stat = lstatSync(abs);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
            // An empty directory may be replaced by a file/symlink; a non-empty one
            // was rejected by planDeletions.
            removePath(abs, context, true);
        }
    }
    catch (error) {
        if (error.code !== "ENOENT") {
            if (error instanceof RestoreFailure)
                throw error;
        }
    }
    if (parsed.kind === "symlink") {
        removePath(abs, context);
        const text = readFileSync(context.store.blobPath(parsed.hash), "utf8");
        try {
            symlinkSync(text, abs);
        }
        catch (error) {
            throw new RestoreFailure("symlink_failed", `cannot create symlink ${path}: ${String(error)}`);
        }
        return "written";
    }
    // Regular file: copy the verified blob to a temp sibling, then rename.
    removePath(abs, context);
    const temp = `${abs}.lf-restore-${process.pid}-${Date.now()}`;
    try {
        copyFileSync(context.store.blobPath(parsed.hash), temp);
        const fd = openSync(temp, "r+");
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        chmodSync(temp, parsed.mode & 0o7777);
        renameSync(temp, abs);
    }
    catch (error) {
        try {
            rmSync(temp, { force: true });
        }
        catch { /* best effort */ }
        throw new RestoreFailure("restore_io_error", `cannot write ${path}: ${String(error)}`);
    }
    return "written";
}
/** Execute the restore. The caller must have committed the directive first. */
export async function executeRestore(input) {
    const context = {
        workspace: input.workspace,
        store: input.store,
        ...(input.stateDir ? { stateDir: input.stateDir } : {}),
        ...(input.exclude ? { exclude: input.exclude } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    };
    const preflight = input.preflight ?? await preflightRestore({
        manifest: input.manifest,
        workspace: input.workspace,
        store: input.store,
        ...(input.stateDir ? { stateDir: input.stateDir } : {}),
        ...(input.exclude ? { exclude: input.exclude } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    const { manifest, currentBoundary } = preflight;
    const targetHead = manifest.head;
    const currentHead = currentBoundary.head;
    let safetyRef;
    if (preflight.backward && currentHead) {
        safetyRef = `refs/loopforge/restore-backup/${input.directiveTransactionId}`;
        const created = await gitStatus(["update-ref", safetyRef, currentHead], context);
        if (created.code !== 0) {
            throw new RestoreFailure("safety_ref_failed", `cannot preserve the pre-restore HEAD: ${created.stderr || created.error || "git update-ref failed"}`);
        }
    }
    if (targetHead) {
        const reset = await gitStatus(["reset", "--hard", targetHead], context);
        if (reset.code !== 0) {
            throw new RestoreFailure("reset_failed", `git reset --hard ${shortHead(targetHead)} failed: ${reset.stderr || reset.error || "unknown error"}`);
        }
    }
    else {
        const empty = await gitStatus(["read-tree", "--empty"], context);
        if (empty.code !== 0) {
            throw new RestoreFailure("reset_failed", "cannot normalize the index to an unborn HEAD");
        }
    }
    const deletions = planDeletions(manifest, currentBoundary, context);
    let filesDeleted = 0;
    for (const path of deletions) {
        const abs = safeTargetPath(path, context);
        // Only boundary file/symlink paths are deleted here; a directory path
        // (gitlink) is out-of-boundary content and fails rather than recursing.
        if (removePath(abs, context, fingerprintKind(currentBoundary.fingerprints[path]).kind === "gitlink" || fingerprintKind(currentBoundary.fingerprints[path]).kind === "dir")) {
            filesDeleted++;
        }
    }
    let filesWritten = 0;
    const materialized = new Set(manifest.contents);
    for (const path of Object.keys(manifest.fingerprints).sort()) {
        const kind = fingerprintKind(manifest.fingerprints[path]);
        // Clean tracked regular files/symlinks were restored by `reset --hard`;
        // only dirty content (stored blobs), missing paths and directory/gitlink
        // entries need explicit handling. Writing a clean file would need a blob
        // we deliberately never stored.
        if (kind.kind !== "missing" && kind.kind !== "dir" && kind.kind !== "gitlink" &&
            !materialized.has(path)) {
            continue;
        }
        const abs = safeTargetPath(path, context);
        if (writeTarget(path, manifest.fingerprints[path], abs, context) === "written") {
            filesWritten++;
        }
    }
    // Post-restore evidence is the verification AND the redo's before baseline.
    // One pass; the boundary sink receives the same boundary for the redo's own
    // before checkpoint.
    let baselineBoundary;
    const baseline = await EvidenceCollector.fromPolicy().collectAsync({
        phase: "before",
        cwd: input.workspace,
        materializer: input.store,
        boundarySink: (boundary) => { baselineBoundary = boundary; },
    });
    const gitObservation = baseline.find((observation) => observation.kind === "git");
    let verificationBoundary;
    if (gitObservation && gitObservation.kind === "git" && gitObservation.status === "observed") {
        verificationBoundary = {
            ...(gitObservation.data.head ? { head: gitObservation.data.head } : {}),
            dirty: [...gitObservation.data.dirty],
            fingerprints: gitObservation.data.fingerprints,
            contents: baselineBoundary?.contents ?? [],
            ...(baselineBoundary?.materializationError
                ? { materializationError: baselineBoundary.materializationError }
                : {}),
        };
    }
    else {
        const direct = await captureBoundary({
            cwd: input.workspace,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
            ...(input.exclude ? { exclude: input.exclude } : {}),
        });
        if (!direct.ok) {
            throw new RestoreFailure("restore_unobservable", `post-restore Git boundary is unavailable: ${direct.detail}`);
        }
        verificationBoundary = direct.boundary;
    }
    const same = sameBoundary(manifest, verificationBoundary);
    if (!same.ok) {
        throw new RestoreFailure("restore_verification_failed", same.detail);
    }
    return {
        status: "verified",
        checkpointId: manifest.checkpointId,
        redoRound: manifest.round,
        ...(manifest.head ? { head: manifest.head } : {}),
        ...(currentHead ? { previousHead: currentHead } : {}),
        ...(safetyRef ? { safetyRef } : {}),
        filesWritten,
        filesDeleted,
        verifiedAt: Date.now(),
        baseline,
        ...(baselineBoundary ? { baselineBoundary } : {}),
    };
}
//# sourceMappingURL=workspace-restore.js.map