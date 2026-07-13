/** Persistence adapters for session state and committed round lookup. */

import type { VaultBackend, VaultEntry } from "./backends/interface.js";

function isLeaseOwnerAlive(ownerId: string): boolean {
  const match = ownerId.match(/^(\d+):/);
  if (!match) return true;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SessionStateStore {
  load(loopId: string): VaultEntry | undefined;
  list(): VaultEntry[];
  save(entry: VaultEntry, options?: SessionSaveOptions): void;
  acquireLease?(
    loopId: string,
    ownerId: string,
    leaseMs: number,
    now?: number,
  ): VaultEntry | undefined;
  renewLease?(
    loopId: string,
    ownerId: string,
    leaseMs: number,
    now?: number,
  ): boolean;
  releaseLease?(loopId: string, ownerId: string): boolean;
}

export interface SessionSaveOptions {
  /** Reject a write if another process owns the existing session entry. */
  expectedLeaseOwner?: string;
}

export class SessionLeaseConflictError extends Error {
  constructor(readonly loopId: string) {
    super(`Session lease is owned by another process: ${loopId}`);
    this.name = "SessionLeaseConflictError";
  }
}

export interface RoundCommitStore {
  find(loopId: string, round: number): VaultEntry[];
}

export class VaultSessionStateStore implements SessionStateStore {
  constructor(private readonly backend: VaultBackend) {}

  load(loopId: string): VaultEntry | undefined {
    return this.backend.queryEntries({ prefix: `loop:${loopId}:session` }).find(
      (entry) =>
        entry.task_type === "session_state" &&
        entry.loop_id === loopId &&
        entry.task_id === `loop:${loopId}:session`,
    );
  }

  list(): VaultEntry[] {
    return this.backend.queryEntries().filter(
      (entry) => entry.task_type === "session_state",
    );
  }

  save(entry: VaultEntry, options: SessionSaveOptions = {}): void {
    const loopId = entry.loop_id;
    if (typeof loopId !== "string" || !loopId) {
      throw new Error("Session state entry requires loop_id");
    }
    const write = () => {
      const vault = this.backend.readVault();
      const entries = Array.isArray(vault.entries)
        ? vault.entries as VaultEntry[]
        : [];
      const existing = entries.find(
        (item) => item.task_type === "session_state" && item.loop_id === loopId,
      );
      if (existing && options.expectedLeaseOwner) {
        const lineage = this.lineage(existing);
        const owner = typeof lineage.lease_owner === "string"
          ? lineage.lease_owner
          : "";
        if (owner && owner !== options.expectedLeaseOwner) {
          throw new SessionLeaseConflictError(loopId);
        }
      }
      vault.entries = [
        ...entries.filter(
          (item) => !(item.task_type === "session_state" && item.loop_id === loopId),
        ),
        entry,
      ];
      this.backend.writeVault(vault);
    };
    if (typeof this.backend.withLock === "function") {
      this.backend.withLock(write);
    } else {
      write();
    }
  }

  acquireLease(
    loopId: string,
    ownerId: string,
    leaseMs: number,
    now = Date.now(),
  ): VaultEntry | undefined {
    let claimed: VaultEntry | undefined;
    const write = () => {
      const vault = this.backend.readVault();
      const entries = Array.isArray(vault.entries)
        ? vault.entries as VaultEntry[]
        : [];
      const index = entries.findIndex(
        (entry) => entry.task_type === "session_state" && entry.loop_id === loopId,
      );
      if (index < 0) return;
      const entry = entries[index];
      const lineage = this.lineage(entry);
      const owner = typeof lineage.lease_owner === "string"
        ? lineage.lease_owner
        : "";
      const expiresAt = typeof lineage.lease_expires_at === "number"
        ? lineage.lease_expires_at
        : 0;
      if (
        owner &&
        owner !== ownerId &&
        expiresAt > now &&
        isLeaseOwnerAlive(owner)
      ) return;
      const previousEpoch = typeof lineage.lease_epoch === "number"
        ? lineage.lease_epoch
        : 0;
      const updated: VaultEntry = {
        ...entry,
        timestamp: new Date(now).toISOString(),
        loop_lineage: {
          ...lineage,
          lease_owner: ownerId,
          lease_expires_at: now + Math.max(1, leaseMs),
          lease_epoch: owner === ownerId ? previousEpoch : previousEpoch + 1,
        },
      };
      entries[index] = updated;
      vault.entries = entries;
      this.backend.writeVault(vault);
      claimed = updated;
    };
    if (typeof this.backend.withLock === "function") this.backend.withLock(write);
    else write();
    return claimed;
  }

  renewLease(
    loopId: string,
    ownerId: string,
    leaseMs: number,
    now = Date.now(),
  ): boolean {
    let renewed = false;
    const write = () => {
      const vault = this.backend.readVault();
      const entries = Array.isArray(vault.entries)
        ? vault.entries as VaultEntry[]
        : [];
      const index = entries.findIndex(
        (entry) => entry.task_type === "session_state" && entry.loop_id === loopId,
      );
      if (index < 0) return;
      const entry = entries[index];
      const lineage = this.lineage(entry);
      if (lineage.lease_owner !== ownerId) return;
      entries[index] = {
        ...entry,
        loop_lineage: {
          ...lineage,
          lease_expires_at: now + Math.max(1, leaseMs),
        },
      };
      vault.entries = entries;
      this.backend.writeVault(vault);
      renewed = true;
    };
    if (typeof this.backend.withLock === "function") this.backend.withLock(write);
    else write();
    return renewed;
  }

  releaseLease(loopId: string, ownerId: string): boolean {
    let released = false;
    const write = () => {
      const vault = this.backend.readVault();
      const entries = Array.isArray(vault.entries)
        ? vault.entries as VaultEntry[]
        : [];
      const index = entries.findIndex(
        (entry) => entry.task_type === "session_state" && entry.loop_id === loopId,
      );
      if (index < 0) return;
      const entry = entries[index];
      const lineage = this.lineage(entry);
      if (lineage.lease_owner !== ownerId) return;
      entries[index] = {
        ...entry,
        loop_lineage: {
          ...lineage,
          lease_owner: "",
          lease_expires_at: 0,
        },
      };
      vault.entries = entries;
      this.backend.writeVault(vault);
      released = true;
    };
    if (typeof this.backend.withLock === "function") this.backend.withLock(write);
    else write();
    return released;
  }

  private lineage(entry: VaultEntry): Record<string, unknown> {
    return entry.loop_lineage &&
      typeof entry.loop_lineage === "object" &&
      !Array.isArray(entry.loop_lineage)
      ? entry.loop_lineage
      : {};
  }
}

export class VaultRoundCommitStore implements RoundCommitStore {
  constructor(private readonly backend: VaultBackend) {}

  find(loopId: string, round: number): VaultEntry[] {
    return this.backend.queryEntries({
      prefix: `loop:${loopId}:r${round}:feedback`,
      feedbackOnly: true,
    });
  }
}
