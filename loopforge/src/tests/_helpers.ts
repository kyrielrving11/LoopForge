/** Shared test utilities — in-memory store, test data factories.
 *
 * Imported by replay.test.ts and mcp.test.ts to avoid ~50 lines of
 * duplicated MemoryLoopStore implementation.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LoopStore,
  LoopSessionDocument,
  LoopRoundDocument,
  LoopStoreMigrationResult,
  VaultEntry,
} from "../loop-store.js";
import { LOOP_STORE_SCHEMA_VERSION } from "../loop-store.js";
import { getPolicy } from "../policy.js";

/** v3.3: Install a real after-phase verification command on the current
 *  policy so end-to-end tests exercise the machine-backed-success path.
 *  The command passes (exit 0) with output that cannot be parsed into test
 *  counts — commandVerified=true (so R8 / success_unverified / criteria
 *  claims stay silent) while count-comparison checks have nothing to match
 *  against. Call after any resetPolicy() in the same test setup.
 *  Mutates the cached policy singleton; the per-file process isolation of
 *  `node --test` keeps this scoped to the test file. */
export function installTestCommandProvider(): void {
  getPolicy().evidence.commands = [testCommandProvider()];
}

/** Shared command-provider policy shape (executable + args + limits). */
export function testCommandProvider(): {
  name: string; enabled: boolean; executable: string; args: string[];
  phase: "after"; required: boolean; timeout_ms: number;
  max_output_chars: number; success_exit_codes: number[];
} {
  return {
    name: "verify",
    enabled: true,
    executable: process.execPath,
    args: ["-e", "console.log('verification ok')"],
    phase: "after",
    required: false,
    timeout_ms: 5000,
    max_output_chars: 2000,
    success_exit_codes: [0],
  };
}

/** v3.3: Write a loop_policy.json (with a passing verification command) into
 *  a subprocess working directory — the CLI child loads policy from its own
 *  cwd, so in-process policy injection does not reach spawned servers. */
export function writeMachineBackedPolicy(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "loop_policy.json"), JSON.stringify({
    version: "2",
    evidence: {
      providers: ["git"],
      timeout_ms: 120000,
      commands: [testCommandProvider()],
      machine_backed_success: "required",
    },
  }, null, 2));
}

/** In-memory LoopStore for testing — implements LoopStore without filesystem. */
export class MemoryLoopStore implements LoopStore {
  sessions = new Map<string, LoopSessionDocument>();
  rounds = new Map<string, LoopRoundDocument>();
  entries: VaultEntry[] = [];

  withLock<T>(fn: () => T): T { return fn(); }
  listLoopIds(): string[] {
    const ids = new Set<string>(this.sessions.keys());
    // Round keys are "<loopId>:<round>" — strip the numeric round suffix.
    // Loop IDs may themselves contain colons, so take the LAST ":digits".
    for (const key of this.rounds.keys()) {
      const match = key.match(/^(.*):\d+$/);
      if (match) ids.add(match[1]);
    }
    return [...ids].sort();
  }
  /** Flat entry view. Mirrors FileLoopStore.listEntries: typed session
   *  documents are included alongside raw appended entries. In production
   *  the session document IS the storage for a session entry (writeEntry
   *  routes session_state to session.json and writeSession overwrites the
   *  same file), so a session document replaces any raw entry with the same
   *  task_id instead of appearing twice. */
  listEntries(loopId?: string, opts?: { sinceRound?: number }): VaultEntry[] {
    const result = [...this.entries];
    // v3.0.1: mirror FileLoopStore.listEntries — sinceRound drops entries
    // from round documents older than the window (session entries have no
    // round and are always kept).
    if (opts?.sinceRound !== undefined) {
      const since = opts.sinceRound;
      for (let i = result.length - 1; i >= 0; i--) {
        const entry = result[i];
        const lineage = entry.loop_lineage as Record<string, unknown> | undefined;
        let round: number | null = null;
        if (lineage && typeof lineage.round === "number") round = lineage.round;
        else {
          const match = String(entry.task_id ?? "").match(/:r(\d+)(?::|$)/);
          if (match) round = Number(match[1]);
        }
        if (round !== null && round < since) result.splice(i, 1);
      }
    }
    for (const [id, doc] of this.sessions) {
      if (loopId && id !== loopId) continue;
      const taskId = String(doc.entry.task_id ?? "");
      const index = result.findIndex((e) => String(e.task_id ?? "") === taskId);
      if (index >= 0) result[index] = doc.entry;
      else result.push(doc.entry);
    }
    return result;
  }
  appendEntry(entry: VaultEntry): void { this.entries.push(entry); }
  appendEntries(entries: VaultEntry[]): number { this.entries.push(...entries); return entries.length; }
  readSession(loopId: string): LoopSessionDocument | null {
    return this.sessions.get(loopId) ?? null;
  }
  writeSession(loopId: string, document: LoopSessionDocument): void {
    this.sessions.set(loopId, document);
  }
  readRound(loopId: string, round: number): LoopRoundDocument | null {
    return this.rounds.get(`${loopId}:${round}`) ?? null;
  }
  /** Direct round-document write for sequence/corruption fixtures. */
  writeRound(loopId: string, document: LoopRoundDocument): void {
    this.rounds.set(`${loopId}:${document.round}`, document);
  }
  listRoundSequences(loopId: string): Array<{ round: number; sequence?: number }> {
    return [...this.rounds.entries()]
      .filter(([key]) => key.startsWith(`${loopId}:`))
      .map(([key, doc]) => ({ round: doc.round, sequence: doc.sequence }))
      .sort((a, b) => a.round - b.round);
  }
  migrateLegacyVault(_path?: string): LoopStoreMigrationResult {
    return { source: _path ?? "memory", imported: 0, skipped: 0, alreadyMigrated: true };
  }
}
