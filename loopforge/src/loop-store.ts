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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PromptArtifact } from "./protocol.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
import { parseRoundTransactionSnapshot } from "./round-transaction.js";
import { validateLoopId } from "./policy.js";
import { isRecord } from "./token-utils.js";

/** Loose per-loop entry shape shared by session documents, round documents,
 *  and the flat list views (listEntries/queryLoopEntries). The single
 *  durable truth is the typed per-loop documents; entries are what the
 *  runtime writes into them. */
export interface VaultEntry {
  id?: string;
  task_id?: string;
  version_tag?: string;
  is_active?: boolean;
  timestamp?: string;
  user_intent?: string;
  task_type?: string;
  success?: boolean;
  skill_used?: string;
  loop_id?: string;
  loop_lineage?: Record<string, unknown>;
  loop_objective?: Record<string, unknown> | null;
  execution_feedback?: string;
  task?: string;
  output_summary?: string;
  constraint_violations?: string[];
  tags?: string[];
  full_prompt?: string;
  [key: string]: unknown;
}

export const LOOP_STORE_SCHEMA_VERSION = 1 as const;

/** v2.12: Storage corruption taxonomy. Only sequence gaps/duplicates are
 *  recoverable (manual file deletion etc.); structural corruption is not. */
export type StorageCorruptionKind =
  | "invalid_json"
  | "invalid_format"
  | "sequence_gap"
  | "sequence_duplicate"
  | "sequence_cross_loop"
  | "sequence_invalid";

export type StorageCorruptionSeverity = "recoverable" | "corrupted";

const SEVERITY_MAP: Record<StorageCorruptionKind, StorageCorruptionSeverity> = {
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
  readonly code = "storage_corruption" as const;
  readonly kind: StorageCorruptionKind;
  readonly severity: StorageCorruptionSeverity;

  constructor(kind: StorageCorruptionKind, message: string) {
    super(message);
    this.name = "StorageCorruptionError";
    this.kind = kind;
    this.severity = SEVERITY_MAP[kind];
  }

  get recoverable(): boolean {
    return this.severity === "recoverable";
  }
}

/** Zero-dependency synchronous sleep (Atomics.wait on a shared slot). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface LoopSessionDocument {
  schemaVersion: typeof LOOP_STORE_SCHEMA_VERSION;
  loopId: string;
  updatedAt: string;
  entry: VaultEntry;
}

export interface LoopRoundDocument {
  schemaVersion: typeof LOOP_STORE_SCHEMA_VERSION;
  loopId: string;
  round: number;
  /** v2.12: Monotonic round stamp distinguishing new-format loops (strict
   *  continuity checked) from legacy loops (no stamp → exempt). */
  sequence?: number;
  updatedAt: string;
  lineage?: VaultEntry;
  feedback?: VaultEntry;
  transaction?: RoundTransactionSnapshot;
  promptArtifact?: PromptArtifact;
  events: VaultEntry[];
}

export interface LoopStore {
  withLock<T>(fn: () => T): T;
  listLoopIds(): string[];
  /** Flat entry view over the durable documents. v3.0.1: `sinceRound` skips
   *  round documents older than the given round (the session document is
   *  always included) — used by incremental compile hydration. */
  listEntries(loopId?: string, opts?: { sinceRound?: number }): VaultEntry[];
  appendEntry(entry: VaultEntry): void;
  /** Append several entries in one call. Part of the public store contract
   *  (implementers may batch atomically); the LoopForge runtime itself
   *  always goes through appendEntry — per-entry error isolation keeps one
   *  bad write from masking the others, so callers of the library should
   *  prefer the single-entry path too. */
  appendEntries(entries: VaultEntry[]): number;
  readSession(loopId: string): LoopSessionDocument | null;
  writeSession(loopId: string, document: LoopSessionDocument): void;
  readRound(loopId: string, round: number): LoopRoundDocument | null;
  /** v2.12: Per-round sequence stamps for continuity checking. Backends
   *  without round documents return []. v3.7: all loops are stamped — the
   *  legacy exemption and the vault migration API were removed. */
  listRoundSequences(loopId: string): Array<{ round: number; sequence?: number }>;
}

/** Filter a loop's flat entry view with the legacy VaultBackend query
 *  options. Derived read-only view over the single durable truth (typed
 *  session/round documents) — never a separate write path. Feedback
 *  entries are excluded by default, mirroring the historical
 *  queryEntries({ feedbackOnly }) semantics. */
export function queryLoopEntries(
  store: LoopStore,
  loopId: string,
  opts?: {
    prefix?: string;
    feedbackOnly?: boolean;
    /** v3.0.1: only entries from round documents >= this round. Passed
     *  through to listEntries so incremental hydration skips old docs. */
    sinceRound?: number;
  },
): VaultEntry[] {
  return store.listEntries(loopId, { sinceRound: opts?.sinceRound }).filter((entry) => {
    const taskId = String(entry.task_id ?? "");
    if (opts?.feedbackOnly && !taskId.endsWith(":feedback")) return false;
    if (!opts?.feedbackOnly && taskId.endsWith(":feedback")) return false;
    if (opts?.prefix) {
      if (!taskId.startsWith(opts.prefix)) return false;
      // Guard against ambiguous prefix matches: "loop:x:r1" must not
      // match "loop:x:r10" or "loop:x:r11". Only check when the prefix
      // itself ends with a digit (indicating a specific round number).
      // Prefixes ending in non-digits (e.g. "loop:x:r") match any round
      // and should NOT be filtered.
      const lastChar = opts.prefix[opts.prefix.length - 1];
      if (lastChar !== undefined && /^\d$/.test(lastChar)) {
        const after = taskId[opts.prefix.length];
        if (after !== undefined && /^\d$/.test(after)) return false;
      }
    }
    return true;
  });
}

/** v2.12: Ordered round sequence for a loop. Throws StorageCorruptionError
 *  on gaps (recoverable) or mixed-format corruption; returns [] for loops
 *  with no rounds. Consumed by audit (sequenceComplete) and resume. */
export function eventSequence(store: LoopStore, loopId: string): number[] {
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
export function checkRoundSequence(
  store: LoopStore,
  loopId: string,
): { complete: true } {
  const docs = store.listRoundSequences(loopId);
  for (const doc of docs) {
    if (doc.sequence !== doc.round) {
      throw new StorageCorruptionError(
        "sequence_invalid",
        `Loop ${loopId}: round ${doc.round} is missing or has an invalid ` +
        `sequence stamp (expected ${doc.round}, got ${String(doc.sequence)})`,
      );
    }
  }
  const rounds = docs.map((doc) => doc.round).sort((a, b) => a - b);
  const max = rounds.length > 0 ? rounds[rounds.length - 1] : 0;
  const present = new Set(rounds);
  for (let round = 1; round <= max; round++) {
    if (!present.has(round)) {
      throw new StorageCorruptionError(
        "sequence_gap",
        `Loop ${loopId}: round sequence gap at ${round} (max ${max})`,
      );
    }
  }
  return { complete: true };
}

function loopIdFromEntry(entry: VaultEntry): string | null {
  if (typeof entry.loop_id === "string" && entry.loop_id) return entry.loop_id;
  const taskId = String(entry.task_id ?? "");
  if (!taskId.startsWith("loop:")) return null;
  const session = taskId.match(/^loop:(.+):session$/);
  if (session) return session[1];
  const round = taskId.match(/^loop:(.+):r\d+(?::.+)?$/);
  return round?.[1] ?? null;
}

function roundFromEntry(entry: VaultEntry): number | null {
  const data = entry.loop_lineage;
  if (data && typeof data.round === "number" && Number.isInteger(data.round)) {
    return data.round;
  }
  const match = String(entry.task_id ?? "").match(/:r(\d+)(?::|$)/);
  return match ? Number(match[1]) : null;
}

function promptFromSnapshot(snapshot: RoundTransactionSnapshot | null): PromptArtifact | undefined {
  return snapshot?.promptArtifact;
}

export class FileLoopStore implements LoopStore {
  readonly root: string;
  private lockDepth = 0;

  constructor(root = ".loopforge") {
    this.root = resolve(root);
  }

  withLock<T>(fn: () => T): T {
    if (this.lockDepth > 0) {
      this.lockDepth++;
      try { return fn(); } finally { this.lockDepth--; }
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
      } catch {
        let stale = false;
        let age = 0;
        try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { age = 0; }
        let owner: { pid?: unknown } | null = null;
        try {
          owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
        } catch {
          // v2.14: a crash between mkdir(lock) and write(owner.json) leaves
          // a lock directory without an owner. That window is microseconds,
          // so after a short grace the lock is provably stale — previously
          // this state caused a permanent lock until manual deletion.
          stale = age > 500;
        }
        if (!stale && owner && age > 5000 && typeof owner.pid === "number") {
          try { process.kill(owner.pid, 0); }
          catch (error) {
            // On Windows, EPERM may be returned for dead cross-user
            // processes. Treat as stale when the lock is old regardless.
            const code = (error as NodeJS.ErrnoException).code;
            stale = code === "ESRCH"
              || (code === "EPERM" && age > 10_000); // Windows safety: EPERM + old lock → stale
          }
        }
        if (stale) {
          try { rmSync(lockPath, { recursive: true }); } catch { /* race */ }
          continue;
        }
        if (Date.now() >= deadline) throw new Error("LoopStore lock timeout (1000ms)");
      }
    }
    this.lockDepth = 1;
    try {
      return fn();
    } finally {
      this.lockDepth = 0;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { token?: unknown };
        if (owner.token === token) rmSync(lockPath, { recursive: true });
      } catch { /* never delete an unowned lock */ }
    }
  }

  listLoopIds(): string[] {
    const loops = join(this.root, "loops");
    if (!existsSync(loops)) return [];
    const result: string[] = [];
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

  readSession(loopId: string): LoopSessionDocument | null {
    validateLoopId(loopId);
    const value = this.readJson(join(this.loopDir(loopId), "session.json"));
    // readJson returns null only for a missing file; an existing document
    // with an unexpected shape is structural corruption, never silently
    // treated as "missing" (which would let a later write overwrite it).
    if (value === null) return null;
    if (!isRecord(value) || value.schemaVersion !== LOOP_STORE_SCHEMA_VERSION ||
        value.loopId !== loopId || !isRecord(value.entry)) {
      throw new StorageCorruptionError(
        "invalid_format",
        `Loop ${loopId}: session.json has an unexpected document shape`,
      );
    }
    return value as unknown as LoopSessionDocument;
  }

  writeSession(loopId: string, document: LoopSessionDocument): void {
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

  readRound(loopId: string, round: number): LoopRoundDocument | null {
    validateLoopId(loopId);
    if (!Number.isInteger(round) || round < 1) return null;
    const value = this.readJson(join(this.loopDir(loopId), "rounds", `${round}.json`));
    // readJson returns null only for a missing file; an existing document
    // with an unexpected shape is structural corruption — surfacing it
    // (rather than returning null) prevents silent overwrite by writeEntry.
    if (value === null) return null;
    if (!isRecord(value) || value.schemaVersion !== LOOP_STORE_SCHEMA_VERSION ||
        value.loopId !== loopId || value.round !== round) {
      throw new StorageCorruptionError(
        "invalid_format",
        `Loop ${loopId}: round ${round} document has an unexpected shape`,
      );
    }
    // v2.12: a stamped document whose stamp disagrees with its filename is
    // structural corruption, never silently repaired.
    if (typeof value.sequence === "number" && value.sequence !== round) {
      throw new StorageCorruptionError(
        "sequence_invalid",
        `Loop ${loopId}: round ${round} document carries sequence ${value.sequence}`,
      );
    }
    const events = Array.isArray(value.events)
      ? value.events.filter(isRecord) as VaultEntry[]
      : [];
    const transaction = parseRoundTransactionSnapshot(value.transaction);
    return {
      schemaVersion: LOOP_STORE_SCHEMA_VERSION,
      loopId,
      round,
      sequence: typeof value.sequence === "number" ? value.sequence : undefined,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
      lineage: isRecord(value.lineage) ? value.lineage as VaultEntry : undefined,
      feedback: isRecord(value.feedback) ? value.feedback as VaultEntry : undefined,
      transaction: transaction ?? undefined,
      promptArtifact: transaction?.promptArtifact,
      events,
    };
  }

  listRoundSequences(loopId: string): Array<{ round: number; sequence?: number }> {
    validateLoopId(loopId);
    const roundsDir = join(this.loopDir(loopId), "rounds");
    if (!existsSync(roundsDir)) return [];
    const result: Array<{ round: number; sequence?: number }> = [];
    for (const file of readdirSync(roundsDir).filter((name) => /^\d+\.json$/.test(name))) {
      const round = Number(file.slice(0, -5));
      const value = this.readJson(join(roundsDir, file));
      if (!isRecord(value) || value.loopId !== loopId || value.round !== round) continue;
      result.push({
        round,
        sequence: typeof value.sequence === "number" ? value.sequence : undefined,
      });
    }
    return result.sort((a, b) => a.round - b.round);
  }

  listEntries(loopId?: string, opts?: { sinceRound?: number }): VaultEntry[] {
    const ids = loopId ? [loopId] : this.listLoopIds();
    const result: VaultEntry[] = [];
    for (const id of ids) {
      const session = this.readSession(id);
      if (session) result.push(session.entry);
      const roundsDir = join(this.loopDir(id), "rounds");
      if (!existsSync(roundsDir)) continue;
      // Numeric sort — readdirSync order is filesystem-dependent and must
      // not leak into the flat entry view (rounds 1, 10, 2 … would be).
      for (const file of readdirSync(roundsDir)
        .filter((name) => /^\d+\.json$/.test(name))
        .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))) {
        const round = Number(file.slice(0, -5));
        // v3.0.1: incremental reads skip older round documents entirely —
        // this is what bounds per-compile I/O in long loops.
        if (opts?.sinceRound !== undefined && round < opts.sinceRound) continue;
        const doc = this.readRound(id, round);
        if (!doc) continue;
        if (doc.lineage) {
          result.push({
            ...doc.lineage,
            full_prompt: doc.promptArtifact?.renderedPrompt ?? doc.lineage.full_prompt,
          });
        }
        if (doc.feedback) result.push(doc.feedback);
        result.push(...doc.events);
      }
    }
    return result;
  }

  appendEntry(entry: VaultEntry): void {
    this.withLock(() => this.writeEntry(entry));
  }

  appendEntries(entries: VaultEntry[]): number {
    return this.withLock(() => {
      for (const entry of entries) this.writeEntry(entry);
      return entries.length;
    });
  }

  private writeEntry(entry: VaultEntry): void {
    const loopId = loopIdFromEntry(entry);
    if (!loopId) throw new Error("LoopStore only accepts loop-scoped entries");
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
      } satisfies LoopSessionDocument);
      return;
    }
    const round = roundFromEntry(entry);
    if (!round) throw new Error(`Loop entry has no round: ${entry.task_id ?? "unknown"}`);
    // v2.12: monotonic write-time check — a stamped loop may not skip its
    // predecessor. v3.7: the legacy-import (allowGap) bypass was removed
    // with migrateLegacyVault; the load-time scan in checkRoundSequence
    // remains the backstop.
    if (round > 1) {
      const previous = this.readRound(loopId, round - 1);
      if (!previous && this.listRoundSequences(loopId).some((doc) => doc.sequence !== undefined)) {
        throw new StorageCorruptionError(
          "sequence_gap",
          `Loop ${loopId}: cannot write round ${round}; round ${round - 1} is missing`,
        );
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
    if (current.sequence === undefined) current.sequence = round;
    const taskId = String(entry.task_id ?? "");
    if (taskId.endsWith(":feedback")) current.feedback = entry;
    else if (entry.task_type === "loop_lineage" || taskId === `loop:${loopId}:r${round}`) {
      current.lineage = entry;
    } else {
      current.events = [
        ...current.events.filter((event) => event.task_id !== entry.task_id),
        entry,
      ];
    }
    const transactionRaw = current.feedback?.loop_lineage?.round_transaction ??
      entry.loop_lineage?.round_transaction;
    const transaction = parseRoundTransactionSnapshot(
      isRecord(transactionRaw) ? transactionRaw.snapshot : undefined,
    );
    if (transaction) {
      current.transaction = transaction;
      current.promptArtifact = promptFromSnapshot(transaction);
    }
    current.updatedAt = now;
    this.atomicWrite(join(dir, "rounds", `${round}.json`), current);
  }

  private loopDir(loopId: string): string {
    const hash = createHash("sha256").update(loopId).digest("hex");
    return join(this.root, "loops", hash);
  }

  /** Read a JSON document, distinguishing missing from corrupt.
   *  ENOENT → null (missing); parse failure → StorageCorruptionError
   *  (corrupted) — the runtime never silently repairs storage. */
  private readJson(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StorageCorruptionError(
        "invalid_json",
        `Corrupt JSON at ${path}: ${(error as Error).message}`,
      );
    }
  }

  private atomicWrite(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const writeOnce = (): void => {
      const temporary = `${path}.tmp.${randomUUID().slice(0, 8)}`;
      writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
      renameSync(temporary, path);
    };
    // v2.12: transient I/O failures (Windows rename EPERM/EACCES) are
    // retried once after a short backoff; a second failure bubbles.
    try {
      writeOnce();
    } catch (first) {
      sleepSync(500);
      try {
        writeOnce();
      } catch (second) {
        throw second;
      }
    }
  }
}
