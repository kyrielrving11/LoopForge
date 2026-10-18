/** ReplayBackend — time-travel queries over loop lineage.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */
import type { LoopStore, VaultEntry } from "./loop-store.js";
import type { LegacyRound } from "./committed-round.js";
export declare class ReplayBackend {
    private readonly store;
    constructor(store: LoopStore);
    getRound(loopId: string, roundNum: number): VaultEntry | null;
    replay(loopId: string, opts?: {
        start?: number;
        end?: number;
    }): VaultEntry[];
    timeline(loopId: string): Record<string, unknown>[];
    /** v3.9.1: explicit legacy-envelope report for the tool envelope. */
    legacyRounds(loopId: string): LegacyRound[];
    private maxRound;
}
//# sourceMappingURL=replay.d.ts.map