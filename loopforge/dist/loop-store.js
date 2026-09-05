/** Typed per-loop persistence.
 *
 * Layout:
 *   .loopforge/loops/<sha256(loopId)>/session.json
 *   .loopforge/loops/<sha256(loopId)>/rounds/<round>.json
 *
 * Markdown state files are derived views. These JSON documents are the only
 * durable transaction truth.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseRoundTransactionSnapshot } from "./round-transaction.js";
import { validateLoopId } from "./policy.js";
import { isRecord } from "./token-utils.js";
export const LOOP_STORE_SCHEMA_VERSION = 1;
const SEVERITY_MAP = {
    sequence_gap: "recoverable",
    sequence_duplicate: "recoverable",
    invalid_json: "corrupted",
    invalid_format: "corrupted",
    sequence_cross_loop: "corrupted",
    sequence_invalid: "corrupted",
};
/** v2.12: Typed corruption error carrying a severity class. Callers may
 *  recover from `recoverable` errors (record and continue) but must surface
 *  `corrupted` errors — the runtime never silently repairs storage. */
export class StorageCorruptionError extends Error {
    code = "storage_corruption";
    kind;
    severity;
    constructor(kind, message) {
        super(message);
        this.name = "StorageCorruptionError";
        this.kind = kind;
        this.severity = SEVERITY_MAP[kind];
    }
    get recoverable() {
        return this.severity === "recoverable";
    }
}
/** Zero-dependency synchronous sleep (Atomics.wait on a shared slot). */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** Filter a loop's flat entry view with the legacy VaultBackend query
 *  options. Derived read-only view over the single durable truth (typed
 *  session/round documents) — never a separate write path. Feedback
 *  entries are excluded by default, mirroring the historical
 *  queryEntries({ feedbackOnly }) semantics. */
export function queryLoopEntries(store, loopId, opts) {
    return store.listEntries(loopId, { sinceRound: opts?.sinceRound }).filter((entry) => {
        const taskId = String(entry.task_id ?? "");
        if (opts?.feedbackOnly && !taskId.endsWith(":feedback"))
            return false;
        if (!opts?.feedbackOnly && taskId.endsWith(":feedback"))
            return false;
        if (opts?.prefix) {
            if (!taskId.startsWith(opts.prefix))
                return false;
            // Guard against ambiguous prefix matches: "loop:x:r1" must not
            // match "loop:x:r10" or "loop:x:r11". Only check when the prefix
            // itself ends with a digit (indicating a specific round number).
            // Prefixes ending in non-digits (e.g. "loop:x:r") match any round
            // and should NOT be filtered.
            const lastChar = opts.prefix[opts.prefix.length - 1];
            if (lastChar !== undefined && /^\d$/.test(lastChar)) {
                const after = taskId[opts.prefix.length];
                if (after !== undefined && /^\d$/.test(after))
                    return false;
            }
        }
        return true;
    });
}
/** v2.12: Ordered round sequence for a loop. Throws StorageCorruptionError
 *  on gaps (recoverable) or mixed-format corruption; returns [] for loops
 *  with no rounds. Consumed by audit (sequenceComplete) and resume. */
export function eventSequence(store, loopId) {
    checkRoundSequence(store, loopId);
    return store.listRoundSequences(loopId).map((doc) => doc.round);
}
/** v2.12/v3.7: Validate that a loop's round documents form a contiguous
 *  sequence 1..max where every document carries a valid stamp
 *  (sequence === round). An unstamped/mismatched document is corrupted
 *  (sequence_invalid); missing rounds are a recoverable gap (sequence_gap,
 *  autoResumeAll skips the loop gracefully). v3.7: the legacy exemptions
 *  (all-unstamped loops, monotonic upgrade from an unstamped prefix) were
 *  removed together with the legacy vault migration API — all loops are
 *  new-format and stamping is mandatory. Throws StorageCorruptionError. */
export function checkRoundSequence(store, loopId) {
    const docs = store.listRoundSequences(loopId);
    for (const doc of docs) {
        if (doc.sequence !== doc.round) {
            throw new StorageCorruptionError("sequence_invalid", `Loop ${loopId}: round ${doc.round} is missing or has an invalid ` +
                `sequence stamp (expected ${doc.round}, got ${String(doc.sequence)})`);
        }
    }
    const rounds = docs.map((doc) => doc.round).sort((a, b) => a - b);
    const max = rounds.length > 0 ? rounds[rounds.length - 1] : 0;
    const present = new Set(rounds);
    for (let round = 1; round <= max; round++) {
        if (!present.has(round)) {
            throw new StorageCorruptionError("sequence_gap", `Loop ${loopId}: round sequence gap at ${round} (max ${max})`);
        }
    }
    return { complete: true };
}
function loopIdFromEntry(entry) {
    if (typeof entry.loop_id === "string" && entry.loop_id)
        return entry.loop_id;
    const taskId = String(entry.task_id ?? "");
    if (!taskId.startsWith("loop:"))
        return null;
    const session = taskId.match(/^loop:(.+):session$/);
    if (session)
        return session[1];
    const round = taskId.match(/^loop:(.+):r\d+(?::.+)?$/);
    return round?.[1] ?? null;
}
function roundFromEntry(entry) {
    const data = entry.loop_lineage;
    if (data && typeof data.round === "number" && Number.isInteger(data.round)) {
        return data.round;
    }
    const match = String(entry.task_id ?? "").match(/:r(\d+)(?::|$)/);
    return match ? Number(match[1]) : null;
}
function promptFromSnapshot(snapshot) {
    return snapshot?.promptArtifact;
}
export class FileLoopStore {
    root;
    lockDepth = 0;
    constructor(root = ".loopforge") {
        this.root = resolve(root);
    }
    withLock(fn) {
        if (this.lockDepth > 0) {
            this.lockDepth++;
            try {
                return fn();
            }
            finally {
                this.lockDepth--;
            }
        }
        mkdirSync(this.root, { recursive: true });
        const lockPath = join(this.root, ".store.lock");
        const ownerPath = join(lockPath, "owner.json");
        const token = randomUUID();
        const deadline = Date.now() + 1000;
        for (;;) {
            try {
                mkdirSync(lockPath);
                writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
                break;
            }
            catch {
                let stale = false;
                let age = 0;
                try {
                    age = Date.now() - statSync(lockPath).mtimeMs;
                }
                catch {
                    age = 0;
                }
                let owner = null;
                try {
                    owner = JSON.parse(readFileSync(ownerPath, "utf8"));
                }
                catch {
                    // v2.14: a crash between mkdir(lock) and write(owner.json) leaves
                    // a lock directory without an owner. That window is microseconds,
                    // so after a short grace the lock is provably stale — previously
                    // this state caused a permanent lock until manual deletion.
                    stale = age > 500;
                }
                if (!stale && owner && age > 5000 && typeof owner.pid === "number") {
                    try {
                        process.kill(owner.pid, 0);
                    }
                    catch (error) {
                        // On Windows, EPERM may be returned for dead cross-user
                        // processes. Treat as stale when the lock is old regardless.
                        const code = error.code;
                        stale = code === "ESRCH"
                            || (code === "EPERM" && age > 10_000); // Windows safety: EPERM + old lock → stale
                    }
                }
                if (stale) {
                    try {
                        rmSync(lockPath, { recursive: true });
                    }
                    catch { /* race */ }
                    continue;
                }
                if (Date.now() >= deadline)
                    throw new Error("LoopStore lock timeout (1000ms)");
            }
        }
        this.lockDepth = 1;
        try {
            return fn();
        }
        finally {
            this.lockDepth = 0;
            try {
                const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
                if (owner.token === token)
                    rmSync(lockPath, { recursive: true });
            }
            catch { /* never delete an unowned lock */ }
        }
    }
    listLoopIds() {
        const loops = join(this.root, "loops");
        if (!existsSync(loops))
            return [];
        const result = [];
        for (const name of readdirSync(loops)) {
            const dir = join(loops, name);
            const metadata = this.readJson(join(dir, "metadata.json"));
            if (isRecord(metadata) && typeof metadata.loopId === "string") {
                result.push(metadata.loopId);
                continue;
            }
            // v2.14: orphaned loop dirs (sessions written before metadata
            // stamping) recover their loopId from the session document itself.
            const session = this.readJson(join(dir, "session.json"));
            if (isRecord(session) && typeof session.loopId === "string") {
                result.push(session.loopId);
            }
        }
        return result.sort();
    }
    readSession(loopId) {
        validateLoopId(loopId);
        const value = this.readJson(join(this.loopDir(loopId), "session.json"));
        // readJson returns null only for a missing file; an existing document
        // with an unexpected shape is structural corruption, never silently
        // treated as "missing" (which would let a later write overwrite it).
        if (value === null)
            return null;
        if (!isRecord(value) || value.schemaVersion !== LOOP_STORE_SCHEMA_VERSION ||
            value.loopId !== loopId || !isRecord(value.entry)) {
            throw new StorageCorruptionError("invalid_format", `Loop ${loopId}: session.json has an unexpected document shape`);
        }
        return value;
    }
    writeSession(loopId, document) {
        validateLoopId(loopId);
        const dir = this.loopDir(loopId);
        // v2.14: stamp metadata alongside the session document — a session with
        // no committed rounds yet (created, then crashed before round 1) must
        // still be discoverable via listLoopIds / auto-resume.
        this.atomicWrite(join(dir, "metadata.json"), {
            schemaVersion: LOOP_STORE_SCHEMA_VERSION,
            loopId,
        });
        this.atomicWrite(join(dir, "session.json"), document);
    }
    readRound(loopId, round) {
        validateLoopId(loopId);
        if (!Number.isInteger(round) || round < 1)
            return null;
        const value = this.readJson(join(this.loopDir(loopId), "rounds", `${round}.json`));
        // readJson returns null only for a missing file; an existing document
        // with an unexpected shape is structural corruption — surfacing it
        // (rather than returning null) prevents silent overwrite by writeEntry.
        if (value === null)
            return null;
        if (!isRecord(value) || value.schemaVersion !== LOOP_STORE_SCHEMA_VERSION ||
            value.loopId !== loopId || value.round !== round) {
            throw new StorageCorruptionError("invalid_format", `Loop ${loopId}: round ${round} document has an unexpected shape`);
        }
        // v2.12: a stamped document whose stamp disagrees with its filename is
        // structural corruption, never silently repaired.
        if (typeof value.sequence === "number" && value.sequence !== round) {
            throw new StorageCorruptionError("sequence_invalid", `Loop ${loopId}: round ${round} document carries sequence ${value.sequence}`);
        }
        const events = Array.isArray(value.events)
            ? value.events.filter(isRecord)
            : [];
        const transaction = parseRoundTransactionSnapshot(value.transaction);
        return {
            schemaVersion: LOOP_STORE_SCHEMA_VERSION,
            loopId,
            round,
            sequence: typeof value.sequence === "number" ? value.sequence : undefined,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
            lineage: isRecord(value.lineage) ? value.lineage : undefined,
            feedback: isRecord(value.feedback) ? value.feedback : undefined,
            transaction: transaction ?? undefined,
            promptArtifact: transaction?.promptArtifact,
            events,
        };
    }
    listRoundSequences(loopId) {
        validateLoopId(loopId);
        const roundsDir = join(this.loopDir(loopId), "rounds");
        if (!existsSync(roundsDir))
            return [];
        const result = [];
        for (const file of readdirSync(roundsDir).filter((name) => /^\d+\.json$/.test(name))) {
            const round = Number(file.slice(0, -5));
            const value = this.readJson(join(roundsDir, file));
            if (!isRecord(value) || value.loopId !== loopId || value.round !== round)
                continue;
            result.push({
                round,
                sequence: typeof value.sequence === "number" ? value.sequence : undefined,
            });
        }
        return result.sort((a, b) => a.round - b.round);
    }
    listEntries(loopId, opts) {
        const ids = loopId ? [loopId] : this.listLoopIds();
        const result = [];
        for (const id of ids) {
            const session = this.readSession(id);
            if (session)
                result.push(session.entry);
            const roundsDir = join(this.loopDir(id), "rounds");
            if (!existsSync(roundsDir))
                continue;
            // Numeric sort — readdirSync order is filesystem-dependent and must
            // not leak into the flat entry view (rounds 1, 10, 2 … would be).
            for (const file of readdirSync(roundsDir)
                .filter((name) => /^\d+\.json$/.test(name))
                .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))) {
                const round = Number(file.slice(0, -5));
                // v3.0.1: incremental reads skip older round documents entirely —
                // this is what bounds per-compile I/O in long loops.
                if (opts?.sinceRound !== undefined && round < opts.sinceRound)
                    continue;
                const doc = this.readRound(id, round);
                if (!doc)
                    continue;
                if (doc.lineage) {
                    result.push({
                        ...doc.lineage,
                        full_prompt: doc.promptArtifact?.renderedPrompt ?? doc.lineage.full_prompt,
                    });
                }
                if (doc.feedback)
                    result.push(doc.feedback);
                result.push(...doc.events);
            }
        }
        return result;
    }
    appendEntry(entry) {
        this.withLock(() => this.writeEntry(entry));
    }
    appendEntries(entries) {
        return this.withLock(() => {
            for (const entry of entries)
                this.writeEntry(entry);
            return entries.length;
        });
    }
    writeEntry(entry) {
        const loopId = loopIdFromEntry(entry);
        if (!loopId)
            throw new Error("LoopStore only accepts loop-scoped entries");
        validateLoopId(loopId);
        const now = new Date().toISOString();
        const dir = this.loopDir(loopId);
        this.atomicWrite(join(dir, "metadata.json"), {
            schemaVersion: LOOP_STORE_SCHEMA_VERSION,
            loopId,
        });
        if (entry.task_type === "session_state" || entry.task_id === `loop:${loopId}:session`) {
            this.atomicWrite(join(dir, "session.json"), {
                schemaVersion: LOOP_STORE_SCHEMA_VERSION,
                loopId,
                updatedAt: now,
                entry,
            });
            return;
        }
        const round = roundFromEntry(entry);
        if (!round)
            throw new Error(`Loop entry has no round: ${entry.task_id ?? "unknown"}`);
        // v2.12: monotonic write-time check — a stamped loop may not skip its
        // predecessor. v3.7: the legacy-import (allowGap) bypass was removed
        // with migrateLegacyVault; the load-time scan in checkRoundSequence
        // remains the backstop.
        if (round > 1) {
            const previous = this.readRound(loopId, round - 1);
            if (!previous && this.listRoundSequences(loopId).some((doc) => doc.sequence !== undefined)) {
                throw new StorageCorruptionError("sequence_gap", `Loop ${loopId}: cannot write round ${round}; round ${round - 1} is missing`);
            }
        }
        const current = this.readRound(loopId, round) ?? {
            schemaVersion: LOOP_STORE_SCHEMA_VERSION,
            loopId,
            round,
            sequence: round,
            updatedAt: now,
            events: [],
        };
        if (current.sequence === undefined)
            current.sequence = round;
        const taskId = String(entry.task_id ?? "");
        if (taskId.endsWith(":feedback"))
            current.feedback = entry;
        else if (entry.task_type === "loop_lineage" || taskId === `loop:${loopId}:r${round}`) {
            current.lineage = entry;
        }
        else {
            current.events = [
                ...current.events.filter((event) => event.task_id !== entry.task_id),
                entry,
            ];
        }
        const transactionRaw = current.feedback?.loop_lineage?.round_transaction ??
            entry.loop_lineage?.round_transaction;
        const transaction = parseRoundTransactionSnapshot(isRecord(transactionRaw) ? transactionRaw.snapshot : undefined);
        if (transaction) {
            current.transaction = transaction;
            current.promptArtifact = promptFromSnapshot(transaction);
        }
        current.updatedAt = now;
        this.atomicWrite(join(dir, "rounds", `${round}.json`), current);
    }
    loopDir(loopId) {
        const hash = createHash("sha256").update(loopId).digest("hex");
        return join(this.root, "loops", hash);
    }
    /** Read a JSON document, distinguishing missing from corrupt.
     *  ENOENT → null (missing); parse failure → StorageCorruptionError
     *  (corrupted) — the runtime never silently repairs storage. */
    readJson(path) {
        try {
            return JSON.parse(readFileSync(path, "utf8"));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw new StorageCorruptionError("invalid_json", `Corrupt JSON at ${path}: ${error.message}`);
        }
    }
    atomicWrite(path, value) {
        mkdirSync(dirname(path), { recursive: true });
        const writeOnce = () => {
            const temporary = `${path}.tmp.${randomUUID().slice(0, 8)}`;
            writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
            renameSync(temporary, path);
        };
        // v2.12: transient I/O failures (Windows rename EPERM/EACCES) are
        // retried once after a short backoff; a second failure bubbles.
        try {
            writeOnce();
        }
        catch (first) {
            sleepSync(500);
            try {
                writeOnce();
            }
            catch (second) {
                throw second;
            }
        }
    }
}
//# sourceMappingURL=loop-store.js.map