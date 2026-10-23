/** v3.9.9: the ONE coverage-selected progress derivation.
 *
 *  A provider reports a FACT about the range it observed. A rule selects the
 *  exact facts it consumes via an explicit `(kind, coverage)` selector; there
 *  is no global vote, no wildcard, and no subset inference. The Git arm keeps
 *  its complete-boundary/HEAD rule; a custom provider reports its own
 *  persisted fingerprint snapshot. Command observations are not progress
 *  providers.
 *
 *  Every consumer — stall, prompt freshness, machine-status display, replay —
 *  reads these functions. Only replay/explain/display may pass `"any"`;
 *  governance rules always name their coverage.
 */
import type { ProgressCoverage, ProgressState } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { CommittedRoundView } from "./committed-round.js";
export { gitMotionSignal, observedGitHead } from "./git-motion.js";
export { GIT_WORKSPACE_COVERAGE } from "./git-motion.js";
/** v3.9.9: the explicit selection a rule makes. `kind` is the machine type of
 *  the observation, not a provider-supplied string, so a custom provider that
 *  mimics the Git coverage strings still cannot participate in a Git rule. */
export interface ProgressCoverageSelector {
    kind: "git" | "custom";
    coverage: ProgressCoverage;
}
/** `"any"` selects every fact — replay/explain/display only. It must never be
 *  used by a governance or prompt-density rule. */
export type ProgressSelector = "any" | readonly ProgressCoverageSelector[];
/** v3.9.9: the ONE selector the stall rule, the in-flight round and prompt
 *  freshness share. Fixed in code this release; no policy key is added. */
export declare const STALL_PROGRESS_COVERAGE: readonly ProgressCoverageSelector[];
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
/** Aggregate facts with ALL-selector semantics.
 *
 *  - any selected `changed` wins;
 *  - a required coverage with NO fact while another required coverage has one
 *    is `unknown` (a missing signal must never read as `unchanged`);
 *  - any selected `unknown` is `unknown`;
 *  - every required coverage present and all `unchanged` is `unchanged`;
 *  - no selected fact at all is `not_applicable`.
 *
 *  A provider that exists but cannot be observed produces an `unknown` fact —
 *  that is different from a provider that does not exist. */
export declare function deriveRoundProgress(deltas: ReadonlyArray<ObservationDelta>, selector: ProgressSelector): RoundProgress;
/** The committed window verdict under the SAME selector. A full contiguous
 *  window is required for a definite verdict; any missing/legacy round is
 *  `unknown`, never "no progress". */
export declare function deriveProgressWindow(rounds: ReadonlyArray<CommittedRoundView>, currentRound: number, lookback: number, selector: ProgressSelector): ProgressWindow;
//# sourceMappingURL=progress.d.ts.map