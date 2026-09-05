/** Typed per-loop persistence.
 *
 * Layout:
 *   .loopforge/loops/<sha256(loopId)>/session.json
 *   .loopforge/loops/<sha256(loopId)>/rounds/<round>.json
 *
 * Markdown state files are derived views. These JSON documents are the only
 * durable transaction truth.
 */
import type { PromptArtifact } from "./protocol.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
/** Loose per-loop entry shape shared by session documents, round documents,
 *  and the flat list views (listEntries/queryLoopEntries). The single
 *  durable truth is the typed per-loop documents; entries are what the
 *  runtime writes into them. */
export interface VaultEntry {
    id?: string;
    task_id?: string;
    version_tag?: string;
    is_active?: boolean;
    timestamp?: string;
    user_intent?: string;
    task_type?: string;
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
export declare const LOOP_STORE_SCHEMA_VERSION: 1;
/** v2.12: Storage corruption taxonomy. Only sequence gaps/duplicates are
 *  recoverable (manual file deletion etc.); structural corruption is not. */
export type StorageCorruptionKind = "invalid_json" | "invalid_format" | "sequence_gap" | "sequence_duplicate" | "sequence_cross_loop" | "sequence_invalid";
export type StorageCorruptionSeverity = "recoverable" | "corrupted";
/** v2.12: Typed corruption error carrying a severity class. Callers may
 *  recover from `recoverable` errors (record and continue) but must surface
 *  `corrupted` errors — the runtime never silently repairs storage. */
export declare class StorageCorruptionError extends Error {
    readonly code: "storage_corruption";
    readonly kind: StorageCorruptionKind;
    readonly severity: StorageCorruptionSeverity;
    constructor(kind: StorageCorruptionKind, message: string);
    get recoverable(): boolean;
}
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
    /** v2.12: Monotonic round stamp distinguishing new-format loops (strict
     *  continuity checked) from legacy loops (no stamp → exempt). */
    sequence?: number;
    updatedAt: string;
    lineage?: VaultEntry;
    feedback?: VaultEntry;
    transaction?: RoundTransactionSnapshot;
    promptArtifact?: PromptArtifact;
    events: VaultEntry[];
}
export interface LoopStore {
    withLock<T>(fn: () => T): T;
    listLoopIds(): string[];
    /** Flat entry view over the durable documents. v3.0.1: `sinceRound` skips
     *  round documents older than the given round (the session document is
     *  always included) — used by incremental compile hydration. */
    listEntries(loopId?: string, opts?: {
        sinceRound?: number;
    }): VaultEntry[];
    appendEntry(entry: VaultEntry): void;
    /** Append several entries in one call. Part of the public store contract
     *  (implementers may batch atomically); the LoopForge runtime itself
     *  always goes through appendEntry — per-entry error isolation keeps one
     *  bad write from masking the others, so callers of the library should
     *  prefer the single-entry path too. */
    appendEntries(entries: VaultEntry[]): number;
    readSession(loopId: string): LoopSessionDocument | null;
    writeSession(loopId: string, document: LoopSessionDocument): void;
    readRound(loopId: string, round: number): LoopRoundDocument | null;
    /** v2.12: Per-round sequence stamps for continuity checking. Backends
     *  without round documents return []. v3.7: all loops are stamped — the
     *  legacy exemption and the vault migration API were removed. */
    listRoundSequences(loopId: string): Array<{
        round: number;
        sequence?: number;
    }>;
}
/** Filter a loop's flat entry view with the legacy VaultBackend query
 *  options. Derived read-only view over the single durable truth (typed
 *  session/round documents) — never a separate write path. Feedback
 *  entries are excluded by default, mirroring the historical
 *  queryEntries({ feedbackOnly }) semantics. */
export declare function queryLoopEntries(store: LoopStore, loopId: string, opts?: {
    prefix?: string;
    feedbackOnly?: boolean;
    /** v3.0.1: only entries from round documents >= this round. Passed
     *  through to listEntries so incremental hydration skips old docs. */
    sinceRound?: number;
}): VaultEntry[];
/** v2.12: Ordered round sequence for a loop. Throws StorageCorruptionError
 *  on gaps (recoverable) or mixed-format corruption; returns [] for loops
 *  with no rounds. Consumed by audit (sequenceComplete) and resume. */
export declare function eventSequence(store: LoopStore, loopId: string): number[];
/** v2.12/v3.7: Validate that a loop's round documents form a contiguous
 *  sequence 1..max where every document carries a valid stamp
 *  (sequence === round). An unstamped/mismatched document is corrupted
 *  (sequence_invalid); missing rounds are a recoverable gap (sequence_gap,
 *  autoResumeAll skips the loop gracefully). v3.7: the legacy exemptions
 *  (all-unstamped loops, monotonic upgrade from an unstamped prefix) were
 *  removed together with the legacy vault migration API — all loops are
 *  new-format and stamping is mandatory. Throws StorageCorruptionError. */
export declare function checkRoundSequence(store: LoopStore, loopId: string): {
    complete: true;
};
export declare class FileLoopStore implements LoopStore {
    readonly root: string;
    private lockDepth;
    constructor(root?: string);
    withLock<T>(fn: () => T): T;
    listLoopIds(): string[];
    readSession(loopId: string): LoopSessionDocument | null;
    writeSession(loopId: string, document: LoopSessionDocument): void;
    readRound(loopId: string, round: number): LoopRoundDocument | null;
    listRoundSequences(loopId: string): Array<{
        round: number;
        sequence?: number;
    }>;
    listEntries(loopId?: string, opts?: {
        sinceRound?: number;
    }): VaultEntry[];
    appendEntry(entry: VaultEntry): void;
    appendEntries(entries: VaultEntry[]): number;
    private writeEntry;
    private loopDir;
    /** Read a JSON document, distinguishing missing from corrupt.
     *  ENOENT → null (missing); parse failure → StorageCorruptionError
     *  (corrupted) — the runtime never silently repairs storage. */
    private readJson;
    private atomicWrite;
}
//# sourceMappingURL=loop-store.d.ts.map