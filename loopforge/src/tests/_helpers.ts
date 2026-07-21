/** Shared test utilities — in-memory backend, test data factories.
 *
 * Imported by replay.test.ts and mcp.test.ts to avoid ~50 lines of
 * duplicated MemoryBackend implementation.
 */

import { randomUUID } from "node:crypto";
import type { VaultBackend, VaultEntry } from "../backends/interface.js";
import type {
  LoopStore,
  LoopSessionDocument,
  LoopRoundDocument,
  LoopStoreMigrationResult,
} from "../loop-store.js";
import { LOOP_STORE_SCHEMA_VERSION } from "../loop-store.js";

/** In-memory LoopStore for testing — implements LoopStore without filesystem. */
export class MemoryLoopStore implements LoopStore {
  sessions = new Map<string, LoopSessionDocument>();
  rounds = new Map<string, LoopRoundDocument>();
  entries: VaultEntry[] = [];

  withLock<T>(fn: () => T): T { return fn(); }
  listLoopIds(): string[] {
    return [...new Set([...this.sessions.keys(), ...this.rounds.keys()])].sort();
  }
  listEntries(_loopId?: string): VaultEntry[] { return [...this.entries]; }
  appendEntry(entry: VaultEntry): void { this.entries.push(entry); }
  appendEntries(entries: VaultEntry[]): number { this.entries.push(...entries); return entries.length; }
  replaceEntries(entries: VaultEntry[]): void { this.entries = [...entries]; }
  readSession(loopId: string): LoopSessionDocument | null {
    return this.sessions.get(loopId) ?? null;
  }
  writeSession(loopId: string, document: LoopSessionDocument): void {
    this.sessions.set(loopId, document);
  }
  readRound(loopId: string, round: number): LoopRoundDocument | null {
    return this.rounds.get(`${loopId}:${round}`) ?? null;
  }
  migrateLegacyVault(_path?: string): LoopStoreMigrationResult {
    return { source: _path ?? "memory", imported: 0, skipped: 0, alreadyMigrated: true };
  }
}

/** In-memory backend for testing — implements VaultBackend without filesystem. */
export class MemoryBackend implements VaultBackend {
  entries: VaultEntry[] = [];

  /** @deprecated compat bridge for VaultBackendLoopStore. */
  readVault(): Record<string, unknown> {
    return { entries: this.entries };
  }
  /** @deprecated compat bridge for VaultBackendLoopStore. */
  writeVault(data: Record<string, unknown>): void {
    this.entries = (data.entries as VaultEntry[]) || [];
  }

  queryEntries(opts?: {
    prefix?: string;
    taskIdPattern?: string;
    feedbackOnly?: boolean;
  }): VaultEntry[] {
    return this.entries.filter((entry) => {
      const taskId = String(entry.task_id ?? "");
      if (opts?.feedbackOnly && !taskId.endsWith(":feedback")) return false;
      if (!opts?.feedbackOnly && taskId.endsWith(":feedback")) return false;
      if (opts?.prefix && !taskId.startsWith(opts.prefix)) return false;
      return true;
    });
  }
  appendEntry(entry: VaultEntry): void {
    this.entries.push(entry);
  }
  appendEntries(entries: VaultEntry[]): number {
    this.entries.push(...entries);
    return entries.length;
  }
}
