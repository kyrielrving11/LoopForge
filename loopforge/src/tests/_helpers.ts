/** Shared test utilities — in-memory backend, test data factories.
 *
 * Imported by replay.test.ts and mcp.test.ts to avoid ~50 lines of
 * duplicated MemoryBackend implementation.
 */

import type { VaultBackend, VaultEntry } from "../backends/interface.js";

/** In-memory backend for testing — implements VaultBackend without filesystem. */
export class MemoryBackend implements VaultBackend {
  entries: VaultEntry[] = [];
  markdownFiles = new Map<string, string>();
  markdownScans = new Map<string, VaultEntry[]>();

  readVault(): Record<string, unknown> {
    return { entries: this.entries };
  }
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
  writeLineageMd(
    _loopId: string,
    roundNum: number,
    content: string,
    _metadata: Record<string, unknown>,
  ): string | null {
    this.markdownFiles.set(`${_loopId}:r${roundNum}`, content);
    return `/fake/${_loopId}/r${roundNum}.md`;
  }
  readLineageMd(loopId: string, roundNum: number): string | null {
    return this.markdownFiles.get(`${loopId}:r${roundNum}`) ?? null;
  }
  scanLineageMd(loopId: string): VaultEntry[] {
    return this.markdownScans.get(loopId) ?? [];
  }
}
