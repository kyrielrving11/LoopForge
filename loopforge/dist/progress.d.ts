/** The ONE machine-progress derivation.
 *
 * Progress is a Git workspace fact: a round either moved (file boundary or
 * HEAD), did not move, or could not be observed. Custom and command
 * observations are reports; they never participate in stall or prompt
 * freshness. A missing/unobservable signal is `unknown`, never "no progress".
 *
 * Every consumer — stall, prompt freshness, machine-status display, replay —
 * reads these functions.
 */
import type { ProgressState } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { CommittedRoundView } from "./committed-round.js";
export { gitMotionSignal, observedGitHead } from "./git-motion.js";
export { GIT_WORKSPACE_COVERAGE } from "./git-motion.js";
export interface RoundProgress {
    state: ProgressState;
    /** Every provider that participated in this round's verdict. */
    providers: string[];
    /** Stable coverage keys selected by this derivation (display only). */
    coverages: string[];
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
    /** Stable coverage keys selected across the window (display only). */
    coverages: string[];
    /** True when the requested window was not fully present on the branch. */
    incomplete: boolean;
    lookback: number;
}
/** The Git progress verdict for one round's observation deltas. */
export declare function deriveRoundProgress(deltas: ReadonlyArray<ObservationDelta>): RoundProgress;
/** The committed window verdict over the same Git facts. A full contiguous
 *  window is required for a definite verdict; any missing/legacy round is
 *  `unknown`, never "no progress". */
export declare function deriveProgressWindow(rounds: ReadonlyArray<CommittedRoundView>, currentRound: number, lookback: number): ProgressWindow;
//# sourceMappingURL=progress.d.ts.map