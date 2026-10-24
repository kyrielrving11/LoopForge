/** Persistence adapters for session state and committed round lookup. */
import type { LoopStore, VaultEntry } from "./loop-store.js";
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
    /** Reject the write when ANY session document already exists. This is the
     *  atomic "create only" gate: the preflight read is not enough under a
     *  concurrent start. */
    expectAbsent?: boolean;
}
export declare class SessionLeaseConflictError extends Error {
    readonly loopId: string;
    constructor(loopId: string);
}
export interface RoundTransactionEnvelope {
    schema_version: number;
    round_id: string;
    snapshot: unknown;
    result: unknown;
}
export interface RoundCommitStore {
    find(loopId: string, round: number): VaultEntry[];
    findRollback(loopId: string, round: number, transactionId: string): VaultEntry | null;
    appendFeedback(loopId: string, round: number, envelope: RoundTransactionEnvelope): VaultEntry;
    appendRollbackDirective(loopId: string, round: number, transactionId: string, envelope: RoundTransactionEnvelope): VaultEntry;
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
    private readonly store;
    constructor(store: LoopStore);
    find(loopId: string, round: number): VaultEntry[];
    findRollback(loopId: string, round: number, transactionId: string): VaultEntry | null;
    appendFeedback(loopId: string, round: number, envelope: RoundTransactionEnvelope): VaultEntry;
    appendRollbackDirective(loopId: string, round: number, transactionId: string, envelope: RoundTransactionEnvelope): VaultEntry;
}
//# sourceMappingURL=storage.d.ts.map