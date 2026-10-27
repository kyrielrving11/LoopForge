/** ReplayBackend — time-travel queries over committed rounds.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Every query loads the same committed history once and reads the branch's
 * `CommittedRoundView`s; there is no second decode pass and no synthesized
 * lineage-shaped entry.
 */
import type { LoopStore } from "./loop-store.js";
import type { CommittedRoundView, LegacyRound } from "./committed-round.js";
export declare const REPLAY_DEFAULT_ROUNDS = 10;
export declare const REPLAY_MAX_WINDOW_ROUNDS = 50;
/** Invalid explicit replay window. The MCP boundary maps this to
 *  `invalid_argument`. */
export declare class ReplayWindowError extends Error {
    readonly code = "invalid_argument";
    constructor(message: string);
}
export interface ReplayWindowOptions {
    start?: number;
    end?: number;
}
export interface ReplayWindow {
    /** First round POSITION returned (legacy rows included); 0 when empty. */
    start: number;
    /** Last round POSITION returned (legacy rows included); 0 when empty. */
    end: number;
    /** Distinct committed round positions on the branch, INCLUDING legacy
     *  envelopes that are not parseable history. The loss stays counted. */
    totalRounds: number;
    /** Round positions exist before this window. */
    hasBefore: boolean;
    /** Round positions exist after this window. */
    hasAfter: boolean;
}
export interface ReplayPage {
    timeline: Record<string, unknown>[];
    window: ReplayWindow;
}
export declare class ReplayBackend {
    private readonly store;
    constructor(store: LoopStore);
    getRound(loopId: string, roundNum: number): CommittedRoundView | null;
    replay(loopId: string, opts?: {
        start?: number;
        end?: number;
    }): CommittedRoundView[];
    /** v4.0.2: the paged timeline. The returned `window` tells the Agent
     *  whether more committed rounds exist before/after this page. */
    page(loopId: string, opts?: ReplayWindowOptions): ReplayPage;
    /** Backwards-compatible array view. Defaults to the same bounded page. */
    timeline(loopId: string, opts?: ReplayWindowOptions): Record<string, unknown>[];
    /** v3.9.1: explicit legacy-envelope report for the tool envelope. */
    legacyRounds(loopId: string): LegacyRound[];
}
//# sourceMappingURL=replay.d.ts.map