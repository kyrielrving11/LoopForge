/** FSBackend — filesystem implementation of VaultBackend.
 *
 * Wraps Node.js fs for JSON vault read/write and Markdown lineage I/O.
 * All file I/O is contained in this single module — engine.ts never
 * touches the filesystem directly.
 */
import type { VaultBackend, VaultEntry } from "./interface.js";
export declare function readLineageMd(loopId: string, roundNum: number, vaultPath?: string): {
    full_prompt: string;
    metadata: Record<string, unknown>;
} | null;
export declare function writeLineageMd(loopId: string, roundNum: number, content: string, metadata: Record<string, unknown>, vaultPath?: string): string | null;
export declare function scanLineageMd(loopId: string, vaultPath?: string): VaultEntry[];
export declare class FSBackend implements VaultBackend {
    private readonly vaultPath;
    private readonly globalVaultPath;
    /** Re-entrant lock depth — >0 means this process holds the lock. */
    private lockDepth;
    constructor(vaultPath?: string, globalVaultPath?: string);
    /** File-system mutex via mkdir (atomic on POSIX and Windows).
     *  Re-entrant: nested calls from the same process bypass the lock. */
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
    writeLineageMd(loopId: string, roundNum: number, content: string, metadata: Record<string, unknown>): string | null;
    readLineageMd(loopId: string, roundNum: number): string | null;
    scanLineageMd(loopId: string): VaultEntry[];
}
//# sourceMappingURL=fs.d.ts.map