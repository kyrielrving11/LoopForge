/** VaultBackend — storage abstraction interface.
 *
 * 9 methods that define the storage contract. All engine I/O goes through
 * this interface — no direct filesystem access outside of backend implementations.
 */

export interface VaultEntry {
  id?: string;
  task_id?: string;
  version_tag?: string;
  is_active?: boolean;
  timestamp?: string;
  user_intent?: string;
  task_type?: string;
  quality_score?: number;
  skill_used?: string;
  technique_used?: string;
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

export interface VaultBackend {
  // JSON vault
  readVault(): Record<string, unknown>;
  writeVault(data: Record<string, unknown>): void;

  // Entry queries
  queryEntries(opts?: {
    prefix?: string;
    taskIdPattern?: string;
    feedbackOnly?: boolean;
  }): VaultEntry[];

  appendEntry(entry: VaultEntry): void;
  appendEntries(entries: VaultEntry[]): number;

  // Markdown lineage
  writeLineageMd(
    loopId: string,
    roundNum: number,
    content: string,
    metadata: Record<string, unknown>,
  ): string | null;

  readLineageMd(loopId: string, roundNum: number): string | null;
  scanLineageMd(loopId: string): VaultEntry[];
}
