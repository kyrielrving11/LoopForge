/** Internal append/query entry shape used by compiler, replay, and adapters. */

export interface VaultEntry {
  id?: string;
  task_id?: string;
  version_tag?: string;
  is_active?: boolean;
  timestamp?: string;
  user_intent?: string;
  task_type?: string;
  success?: boolean;
  loop_id?: string;
  loop_lineage?: Record<string, unknown>;
  loop_objective?: Record<string, unknown> | null;
  task?: string;
  tags?: string[];
  full_prompt?: string;
  [key: string]: unknown;
}

export interface VaultBackend {
  /** Optional atomic critical section used by storage adapters. */
  withLock?<T>(fn: () => T): T;

  // Entry queries
  queryEntries(opts?: {
    prefix?: string;
    taskIdPattern?: string;
    feedbackOnly?: boolean;
  }): VaultEntry[];

  appendEntry(entry: VaultEntry): void;
  appendEntries(entries: VaultEntry[]): number;

}
