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
import type { VaultBackend, VaultEntry } from "./backends/interface.js";
import type { PromptArtifact } from "./protocol.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
import { parseRoundTransactionSnapshot } from "./round-transaction.js";
import { validateLoopId } from "./policy.js";
import { isRecord } from "./token-utils.js";

export const LOOP_STORE_SCHEMA_VERSION = 3 as const;

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
  updatedAt: string;
  lineage?: VaultEntry;
  feedback?: VaultEntry;
  transaction?: RoundTransactionSnapshot;
  promptArtifact?: PromptArtifact;
  events: VaultEntry[];
}

export interface LoopStoreMigrationResult {
  source: string;
  imported: number;
  skipped: number;
  alreadyMigrated: boolean;
}

export interface LoopStoreIntegrity {
  code: "session_not_found" | "session_version_unsupported" | "session_corrupt" | "store_incomplete" | "store_unreadable" | null;
  missingRounds: number[];
  corruptRounds: number[];
  metadataRebuilt: boolean;
  foundSchemaVersion: number | null;
}

export interface LoopStore {
  withLock<T>(fn: () => T): T;
  listLoopIds(): string[];
  listEntries(loopId?: string): VaultEntry[];
  appendEntry(entry: VaultEntry): void;
  appendEntries(entries: VaultEntry[]): number;
  replaceEntries(entries: VaultEntry[]): void;
  readSession(loopId: string): LoopSessionDocument | null;
  inspectLoop?(loopId: string): LoopStoreIntegrity;
  writeSession(loopId: string, document: LoopSessionDocument): void;
  readRound(loopId: string, round: number): LoopRoundDocument | null;
  migrateLegacyVault(path?: string): LoopStoreMigrationResult;
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
        try {
          const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as { pid?: unknown };
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > 5000 && typeof owner.pid === "number") {
            try { process.kill(owner.pid, 0); }
            catch (error) {
              // On Windows, EPERM may be returned for dead cross-user
              // processes. Treat as stale when the lock is old regardless.
              const code = (error as NodeJS.ErrnoException).code;
              stale = code === "ESRCH"
                || (code === "EPERM" && age > 10_000); // Windows safety: EPERM + old lock → stale
            }
          }
        } catch { stale = false; }
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
      const metadata = this.readJson(join(loops, name, "metadata.json"));
      if (isRecord(metadata) && typeof metadata.loopId === "string") {
        result.push(metadata.loopId);
      }
    }
    return result.sort();
  }

  readSession(loopId: string): LoopSessionDocument | null {
    validateLoopId(loopId);
    const value = this.readJson(join(this.loopDir(loopId), "session.json"));
    if (!isRecord(value) || value.schemaVersion !== LOOP_STORE_SCHEMA_VERSION ||
        value.loopId !== loopId || !isRecord(value.entry)) return null;
    return value as unknown as LoopSessionDocument;
  }

  inspectLoop(loopId: string): LoopStoreIntegrity {
    validateLoopId(loopId);
    const dir = this.loopDir(loopId);
    const sessionPath = join(dir, "session.json");
    if (!existsSync(sessionPath)) return { code: "session_not_found", missingRounds: [], corruptRounds: [], metadataRebuilt: false, foundSchemaVersion: null };
    try { readFileSync(sessionPath, "utf8"); } catch { return { code: "store_unreadable", missingRounds: [], corruptRounds: [], metadataRebuilt: false, foundSchemaVersion: null }; }
    const rawSession = this.readJson(sessionPath);
    if (!isRecord(rawSession)) return { code: "session_corrupt", missingRounds: [], corruptRounds: [], metadataRebuilt: false, foundSchemaVersion: null };
    if (rawSession.schemaVersion !== LOOP_STORE_SCHEMA_VERSION) {
      return {
        code: "session_version_unsupported",
        missingRounds: [],
        corruptRounds: [],
        metadataRebuilt: false,
        foundSchemaVersion: typeof rawSession.schemaVersion === "number" ? rawSession.schemaVersion : null,
      };
    }
    const session = this.readSession(loopId);
    if (!session) return { code: "session_corrupt", missingRounds: [], corruptRounds: [], metadataRebuilt: false, foundSchemaVersion: LOOP_STORE_SCHEMA_VERSION };
    let metadataRebuilt = false;
    const metadataPath = join(dir, "metadata.json");
    if (!existsSync(metadataPath)) {
      this.atomicWrite(metadataPath, { schemaVersion: LOOP_STORE_SCHEMA_VERSION, loopId });
      metadataRebuilt = true;
    }
    const roundsDir = join(dir, "rounds");
    if (!existsSync(roundsDir)) return { code: null, missingRounds: [], corruptRounds: [], metadataRebuilt, foundSchemaVersion: LOOP_STORE_SCHEMA_VERSION };
    const numbers = readdirSync(roundsDir).filter((name) => /^\d+\.json$/.test(name)).map((name) => Number(name.slice(0, -5))).sort((a, b) => a - b);
    const corruptRounds = numbers.filter((round) => this.readRound(loopId, round) === null);
    const missingRounds: number[] = [];
    if (numbers.length > 0) for (let round = 1; round <= numbers[numbers.length - 1]; round++) if (!numbers.includes(round)) missingRounds.push(round);
    return { code: corruptRounds.length || missingRounds.length ? "store_incomplete" : null, missingRounds, corruptRounds, metadataRebuilt, foundSchemaVersion: LOOP_STORE_SCHEMA_VERSION };
  }

  writeSession(loopId: string, document: LoopSessionDocument): void {
    validateLoopId(loopId);
    this.atomicWrite(join(this.loopDir(loopId), "session.json"), document);
  }

  readRound(loopId: string, round: number): LoopRoundDocument | null {
    validateLoopId(loopId);
    if (!Number.isInteger(round) || round < 1) return null;
    const value = this.readJson(join(this.loopDir(loopId), "rounds", `${round}.json`));
    if (!isRecord(value) || value.schemaVersion !== LOOP_STORE_SCHEMA_VERSION ||
        value.loopId !== loopId || value.round !== round) return null;
    const events = Array.isArray(value.events)
      ? value.events.filter(isRecord) as VaultEntry[]
      : [];
    const transaction = parseRoundTransactionSnapshot(value.transaction);
    return {
      schemaVersion: LOOP_STORE_SCHEMA_VERSION,
      loopId,
      round,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
      lineage: isRecord(value.lineage) ? value.lineage as VaultEntry : undefined,
      feedback: isRecord(value.feedback) ? value.feedback as VaultEntry : undefined,
      transaction: transaction ?? undefined,
      promptArtifact: transaction?.promptArtifact,
      events,
    };
  }

  listEntries(loopId?: string): VaultEntry[] {
    const ids = loopId ? [loopId] : this.listLoopIds();
    const result: VaultEntry[] = [];
    for (const id of ids) {
      const session = this.readSession(id);
      if (session) result.push(session.entry);
      const roundsDir = join(this.loopDir(id), "rounds");
      if (!existsSync(roundsDir)) continue;
      for (const file of readdirSync(roundsDir).filter((name) => /^\d+\.json$/.test(name))) {
        const round = this.readRound(id, Number(file.slice(0, -5)));
        if (!round) continue;
        if (round.lineage) {
          result.push({
            ...round.lineage,
            full_prompt: round.promptArtifact?.renderedPrompt ?? round.lineage.full_prompt,
          });
        }
        if (round.feedback) result.push(round.feedback);
        result.push(...round.events);
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

  replaceEntries(entries: VaultEntry[]): void {
    this.withLock(() => {
      for (const entry of entries) this.writeEntry(entry);
    });
  }

  migrateLegacyVault(path = ".promptcraft/prompt_vault.json"): LoopStoreMigrationResult {
    const source = resolve(path);
    const marker = join(this.root, "migrations", "promptcraft-v1.json");
    if (existsSync(marker)) {
      return { source, imported: 0, skipped: 0, alreadyMigrated: true };
    }
    let imported = 0;
    let skipped = 0;
    const raw = this.readJson(source);
    const entries = isRecord(raw) && Array.isArray(raw.entries)
      ? raw.entries.filter(isRecord) as VaultEntry[]
      : [];
    this.withLock(() => {
      const existing = new Set(this.listEntries().map((entry) => String(entry.task_id ?? "")));
      for (const entry of entries) {
        if (!loopIdFromEntry(entry) || existing.has(String(entry.task_id ?? ""))) {
          skipped++;
          continue;
        }
        this.writeEntry(entry);
        imported++;
      }
      this.atomicWrite(marker, {
        schemaVersion: LOOP_STORE_SCHEMA_VERSION,
        source,
        imported,
        skipped,
        migratedAt: new Date().toISOString(),
      });
    });
    return { source, imported, skipped, alreadyMigrated: false };
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
    const current = this.readRound(loopId, round) ?? {
      schemaVersion: LOOP_STORE_SCHEMA_VERSION,
      loopId,
      round,
      updatedAt: now,
      events: [],
    };
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

  private readJson(path: string): unknown {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  }

  private atomicWrite(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${randomUUID().slice(0, 8)}`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    renameSync(temporary, path);
  }
}

/** @deprecated Use LoopStore directly.
 *
 *  Compatibility adapter so modules that still accept VaultBackend can
 *  operate on a LoopStore. Persistent truth is the typed per-loop
 *  documents; no Markdown lineage is written. */
export class LoopStoreBackend implements VaultBackend {
  constructor(readonly store: LoopStore = new FileLoopStore()) {}

  withLock<T>(fn: () => T): T { return this.store.withLock(fn); }
  queryEntries(opts?: {
    prefix?: string;
    taskIdPattern?: string;
    feedbackOnly?: boolean;
  }): VaultEntry[] {
    return this.store.listEntries().filter((entry) => {
      const taskId = String(entry.task_id ?? "");
      if (opts?.feedbackOnly && !taskId.endsWith(":feedback")) return false;
      if (!opts?.feedbackOnly && taskId.endsWith(":feedback")) return false;
      if (opts?.prefix && !taskId.startsWith(opts.prefix)) return false;
      if (opts?.taskIdPattern && !taskId.includes(opts.taskIdPattern)) return false;
      return true;
    });
  }
  appendEntry(entry: VaultEntry): void { this.store.appendEntry(entry); }
  appendEntries(entries: VaultEntry[]): number { return this.store.appendEntries(entries); }
}

/** Adapter that presents an injected VaultBackend through the LoopStore API.
 *
 *  SessionManager uses this when a VaultBackend is provided directly so
 *  VaultSessionStateStore can operate on typed session documents while
 *  the underlying storage remains VaultBackend entries. */
export class VaultBackendLoopStore implements LoopStore {
  constructor(private readonly backend: VaultBackend) {}

  withLock<T>(fn: () => T): T {
    return typeof this.backend.withLock === "function"
      ? this.backend.withLock(fn)
      : fn();
  }

  listLoopIds(): string[] {
    return [...new Set(
      this.backend.queryEntries()
        .filter((e) => typeof e.loop_id === "string")
        .map((e) => e.loop_id as string),
    )].sort();
  }

  listEntries(loopId?: string): VaultEntry[] {
    if (loopId) return this.backend.queryEntries({ prefix: `loop:${loopId}` });
    return this.backend.queryEntries();
  }

  appendEntry(entry: VaultEntry): void { this.backend.appendEntry(entry); }
  appendEntries(entries: VaultEntry[]): number { return this.backend.appendEntries(entries); }
  replaceEntries(_entries: VaultEntry[]): void {
    throw new Error(
      "VaultBackendLoopStore.replaceEntries is not supported. " +
      "Use LoopStore (FileLoopStore) directly for bulk replace operations.",
    );
  }

  readSession(loopId: string): LoopSessionDocument | null {
    const entry = this.backend.queryEntries({ prefix: `loop:${loopId}:session` })
      .find((e) => e.task_type === "session_state" && e.loop_id === loopId);
    if (!entry) return null;
    return {
      schemaVersion: LOOP_STORE_SCHEMA_VERSION,
      loopId,
      updatedAt: typeof entry.timestamp === "string"
        ? entry.timestamp
        : new Date().toISOString(),
      entry,
    };
  }

  writeSession(loopId: string, document: LoopSessionDocument): void {
    const entry = document.entry;
    // Ensure the entry carries identifying fields expected by queryEntries.
    entry.task_type = "session_state";
    entry.loop_id = loopId;
    entry.task_id = `loop:${loopId}:session`;
    // Session state lives in the vault entries list. The backend may
    // provide readVault/writeVault as optional adapter methods; if not,
    // we fall back to appendEntry (which may create duplicates, but
    // VaultSessionStateStore.load returns the first match).
    const be = this.backend as unknown as Record<string, unknown>;
    if (typeof be.readVault === "function" &&
        typeof be.writeVault === "function") {
      // Call via .call(be) so methods that reference `this` (e.g.
      // MemoryBackend.readVault) keep their receiver.
      const data = (be.readVault as () => Record<string, unknown>).call(be);
      const entries = Array.isArray(data.entries)
        ? data.entries as VaultEntry[]
        : [];
      const filtered = entries.filter(
        (item) => !(item.task_type === "session_state" && item.loop_id === loopId),
      );
      (be.writeVault as (data: Record<string, unknown>) => void).call(
        be,
        { entries: [...filtered, entry] },
      );
      return;
    }
    this.backend.appendEntry(entry);
  }

  readRound(loopId: string, round: number): LoopRoundDocument | null {
    const prefix = `loop:${loopId}:r${round}:`;
    const entries = this.backend.queryEntries({ prefix });
    if (entries.length === 0) return null;

    // Separate lineage, feedback, and raw events — same structure as
    // FileLoopStore.readRound so callers get consistent round documents
    // regardless of backend.
    const lineage = entries.find(
      (e) => e.task_type === "loop_lineage" || e.task_id === `loop:${loopId}:r${round}`,
    );
    const feedback = entries.find(
      (e) => String(e.task_id ?? "").endsWith(":feedback"),
    );
    const events = entries.filter(
      (e) => e !== lineage && e !== feedback,
    );

    let transaction: RoundTransactionSnapshot | undefined;
    const transactionRaw = feedback?.loop_lineage?.round_transaction ??
      lineage?.loop_lineage?.round_transaction;
    const transactionParsed = parseRoundTransactionSnapshot(
      isRecord(transactionRaw) ? (transactionRaw as Record<string, unknown>).snapshot : undefined,
    );
    if (transactionParsed) {
      transaction = transactionParsed;
    }

    return {
      schemaVersion: LOOP_STORE_SCHEMA_VERSION,
      loopId,
      round,
      updatedAt: entries[0].timestamp ?? new Date().toISOString(),
      lineage: lineage as VaultEntry | undefined,
      feedback: feedback as VaultEntry | undefined,
      transaction,
      promptArtifact: transaction?.promptArtifact,
      events,
    };
  }

  migrateLegacyVault(_path?: string): LoopStoreMigrationResult {
    return { source: _path ?? "vault", imported: 0, skipped: 0, alreadyMigrated: true };
  }
}
