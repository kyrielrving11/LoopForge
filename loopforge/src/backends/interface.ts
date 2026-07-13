/** Internal projection used while engine query code moves onto typed LoopStore APIs. */

export interface VaultEntry {
  id?: string;
  task_id?: string;
  version_tag?: string;
  is_active?: boolean;
  timestamp?: string;
  user_intent?: string;
  task_type?: string;
  /** @deprecated Use `success` field instead. Kept for reading old vault data. */
  quality_score?: number;
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

export interface VaultBackend {
  /** Optional atomic critical section used by storage adapters. */
  withLock?<T>(fn: () => T): T;
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

}
