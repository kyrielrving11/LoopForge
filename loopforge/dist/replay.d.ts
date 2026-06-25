/** ReplayBackend — time-travel queries over vault lineage.
 *
 * Depends on VaultBackend interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */
import type { VaultBackend, VaultEntry } from "./backends/interface.js";
export declare class ReplayBackend {
    private readonly backend;
    constructor(backend: VaultBackend);
    getRound(loopId: string, roundNum: number): VaultEntry | null;
    replay(loopId: string, opts?: {
        start?: number;
        end?: number;
    }): VaultEntry[];
    timeline(loopId: string): Record<string, unknown>[];
    diff(loopId: string, roundA: number, roundB: number): Record<string, unknown>;
    private maxRound;
}
//# sourceMappingURL=replay.d.ts.map