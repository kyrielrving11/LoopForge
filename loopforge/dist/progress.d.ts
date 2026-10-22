/** v3.9.7: the ONE provider-neutral progress derivation.
 *
 *  Progress means only "a provider observed a change in its own state".
 *  It never means goal achievement, semantic value, or acceptance. The Git arm
 *  keeps its complete-boundary/HEAD/restore-point rule; a custom provider
 *  supplies a persisted fingerprint snapshot. Command observations are not
 *  progress providers.
 *
 *  Every consumer — stall, prompt freshness, machine-status display, replay,
 *  metrics — reads these functions. No consumer may derive a second notion of
 *  progress.
 */
import type { ProgressState } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { CommittedRoundView } from "./committed-round.js";
export { gitMotionSignal, observedGitHead } from "./git-motion.js";
export interface RoundProgress {
    state: ProgressState;
    /** Every provider that participated in this round's verdict. */
    providers: string[];
    /** Machine reason when state is unknown. */
    detail?: string;
}
export interface ProgressWindow {
    state: ProgressState;
    /** One entry per round in the requested window, ascending. */
    roundStates: Array<{
        round: number;
        state: ProgressState;
    }>;
    providers: string[];
    /** True when the requested window was not fully present on the branch. */
    incomplete: boolean;
    lookback: number;
}
/** Aggregate one round's per-provider deltas. Any proven change wins; a
 *  comparable unknown blocks an "unchanged" verdict; no applicable provider
 *  is not_applicable. */
export declare function deriveRoundProgress(deltas: ReadonlyArray<ObservationDelta>, restoreTargetHead?: string): RoundProgress;
/** The committed window verdict. A full contiguous window is required for a
 *  definite verdict; any missing/legacy round is `unknown`, never "no
 *  progress". */
export declare function deriveProgressWindow(rounds: ReadonlyArray<CommittedRoundView>, currentRound: number, lookback: number): ProgressWindow;
/** Git-only compatibility helpers for callers/tests that need the raw
 *  boolean series. They are thin wrappers over the same Git rule. */
export declare function inFlightGitMotion(deltas: ReadonlyArray<ObservationDelta>, restoreTargetHead?: string): boolean | null;
export declare function committedRoundGitMotion(view: CommittedRoundView): boolean | null;
export declare function machineGitMotionSeries(rounds: ReadonlyArray<CommittedRoundView>, currentRound: number, lookback: number): boolean[] | null;
//# sourceMappingURL=progress.d.ts.map