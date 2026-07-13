/** Typed per-loop persistence.
 *
 * Layout:
 *   .loopforge/loops/<sha256(loopId)>/session.json
 *   .loopforge/loops/<sha256(loopId)>/rounds/<round>.json
 *
 * Markdown state files are derived views. These JSON documents are the only
 * durable transaction truth.
 */
import type { VaultBackend, VaultEntry } from "./backends/interface.js";
import type { PromptArtifact } from "./protocol.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
export declare const LOOP_STORE_SCHEMA_VERSION: 1;
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
export interface LoopStore {
    withLock<T>(fn: () => T): T;
    listLoopIds(): string[];
    listEntries(loopId?: string): VaultEntry[];
    appendEntry(entry: VaultEntry): void;
    appendEntries(entries: VaultEntry[]): number;
    replaceEntries(entries: VaultEntry[]): void;
    readSession(loopId: string): LoopSessionDocument | null;
    readRound(loopId: string, round: number): LoopRoundDocument | null;
    migrateLegacyVault(path?: string): LoopStoreMigrationResult;
}
export declare class FileLoopStore implements LoopStore {
    readonly root: string;
    private lockDepth;
    constructor(root?: string);
    withLock<T>(fn: () => T): T;
    listLoopIds(): string[];
    readSession(loopId: string): LoopSessionDocument | null;
    readRound(loopId: string, round: number): LoopRoundDocument | null;
    listEntries(loopId?: string): VaultEntry[];
    appendEntry(entry: VaultEntry): void;
    appendEntries(entries: VaultEntry[]): number;
    replaceEntries(entries: VaultEntry[]): void;
    migrateLegacyVault(path?: string): LoopStoreMigrationResult;
    private writeEntry;
    private loopDir;
    private readJson;
    private atomicWrite;
}
/** Compatibility adapter for legacy internal query code. Persistent truth is
 * still the typed per-loop documents above; no Markdown lineage is written. */
export declare class LoopStoreBackend implements VaultBackend {
    readonly store: LoopStore;
    constructor(store?: LoopStore);
    withLock<T>(fn: () => T): T;
    readVault(): Record<string, unknown>;
    writeVault(data: Record<string, unknown>): void;
    queryEntries(opts?: {
        prefix?: string;
        taskIdPattern?: string;
        feedbackOnly?: boolean;
    }): VaultEntry[];
    appendEntry(entry: VaultEntry): void;
    appendEntries(entries: VaultEntry[]): number;
}
//# sourceMappingURL=loop-store.d.ts.map