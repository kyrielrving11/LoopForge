/** ReplayBackend — time-travel queries over committed rounds.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Every query loads the same committed history once and reads the branch's
 * `CommittedRoundView`s; there is no second decode pass and no synthesized
 * lineage-shaped entry.
 */
import type { LoopStore } from "./loop-store.js";
import type { CommittedRoundView, LegacyRound } from "./committed-round.js";
export declare class ReplayBackend {
    private readonly store;
    constructor(store: LoopStore);
    getRound(loopId: string, roundNum: number): CommittedRoundView | null;
    replay(loopId: string, opts?: {
        start?: number;
        end?: number;
    }): CommittedRoundView[];
    timeline(loopId: string): Record<string, unknown>[];
    /** v3.9.1: explicit legacy-envelope report for the tool envelope. */
    legacyRounds(loopId: string): LegacyRound[];
}
//# sourceMappingURL=replay.d.ts.map