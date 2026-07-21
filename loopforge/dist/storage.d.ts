/** Persistence adapters for session state and committed round lookup. */
import type { VaultBackend, VaultEntry } from "./backends/interface.js";
import type { LoopStore } from "./loop-store.js";
export interface SessionStateStore {
    load(loopId: string): VaultEntry | undefined;
    list(): VaultEntry[];
    save(entry: VaultEntry, options?: SessionSaveOptions): void;
    acquireLease?(loopId: string, ownerId: string, leaseMs: number, now?: number): VaultEntry | undefined;
    renewLease?(loopId: string, ownerId: string, leaseMs: number, now?: number): boolean;
    releaseLease?(loopId: string, ownerId: string): boolean;
}
export interface SessionSaveOptions {
    /** Reject a write if another process owns the existing session entry. */
    expectedLeaseOwner?: string;
}
export declare class SessionLeaseConflictError extends Error {
    readonly loopId: string;
    constructor(loopId: string);
}
export interface RoundCommitStore {
    find(loopId: string, round: number): VaultEntry[];
}
export declare class VaultSessionStateStore implements SessionStateStore {
    private readonly store;
    constructor(store: LoopStore);
    load(loopId: string): VaultEntry | undefined;
    list(): VaultEntry[];
    save(entry: VaultEntry, options?: SessionSaveOptions): void;
    acquireLease(loopId: string, ownerId: string, leaseMs: number, now?: number): VaultEntry | undefined;
    renewLease(loopId: string, ownerId: string, leaseMs: number, now?: number): boolean;
    releaseLease(loopId: string, ownerId: string): boolean;
    private lineage;
}
export declare class VaultRoundCommitStore implements RoundCommitStore {
    private readonly backend;
    constructor(backend: VaultBackend);
    find(loopId: string, round: number): VaultEntry[];
}
//# sourceMappingURL=storage.d.ts.map