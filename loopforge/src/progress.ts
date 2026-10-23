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
import type { ObservationDelta, ObservationProgress } from "./evidence-provider.js";
import type { CommittedRoundView } from "./committed-round.js";
import { coverageKey } from "./evidence-provider.js";
import { GIT_WORKSPACE_COVERAGE } from "./git-motion.js";

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
export const STALL_PROGRESS_COVERAGE: readonly ProgressCoverageSelector[] = [
  { kind: "git", coverage: GIT_WORKSPACE_COVERAGE },
];

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
  roundStates: Array<{ round: number; state: ProgressState }>;
  providers: string[];
  /** Stable coverage keys selected across the window (display only). */
  coverages: string[];
  /** True when the requested window was not fully present on the branch. */
  incomplete: boolean;
  lookback: number;
}

function coverageEquals(
  left: ProgressCoverage,
  right: ProgressCoverage,
): boolean {
  return left.domain === right.domain &&
    left.object === right.object &&
    left.scope === right.scope &&
    left.version === right.version;
}

function factMatches(
  fact: ObservationProgress,
  selector: ProgressCoverageSelector,
): boolean {
  return fact.kind === selector.kind &&
    coverageEquals(fact.coverage, selector.coverage);
}

function factsOf(
  deltas: ReadonlyArray<ObservationDelta>,
): ObservationProgress[] {
  const facts: ObservationProgress[] = [];
  for (const delta of deltas) {
    if (delta.progress) facts.push(delta.progress);
  }
  return facts;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
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
export function deriveRoundProgress(
  deltas: ReadonlyArray<ObservationDelta>,
  selector: ProgressSelector,
): RoundProgress {
  const allFacts = factsOf(deltas);
  const selected = selector === "any"
    ? allFacts
    : allFacts.filter((fact) =>
        selector.some((entry) => factMatches(fact, entry)));

  const providers = uniqueSorted(
    deltas
      .filter((delta) =>
        delta.progress !== null &&
        (selector === "any" || selected.includes(delta.progress)))
      .map((delta) => delta.providerId),
  );
  const coverages = uniqueSorted(selected.map((fact) => coverageKey(fact.coverage)));

  if (selected.some((fact) => fact.state === "changed")) {
    return { state: "changed", providers, coverages };
  }

  if (selector !== "any") {
    const missing = selector.filter((required) =>
      !selected.some((fact) => factMatches(fact, required)));
    if (missing.length > 0 && selected.length > 0) {
      return {
        state: "unknown",
        providers,
        coverages,
        detail:
          "required progress coverage has no fact: " +
          missing.map((entry) =>
            `${entry.kind}:${coverageKey(entry.coverage)}`).join(", "),
      };
    }
    if (missing.length === selector.length) {
      return { state: "not_applicable", providers: [], coverages: [] };
    }
  }

  const unknown = selected.find((fact) => fact.state === "unknown");
  if (unknown) {
    return {
      state: "unknown",
      providers,
      coverages,
      ...(unknown.detail ? { detail: unknown.detail } : {}),
    };
  }
  if (selected.length > 0) {
    return { state: "unchanged", providers, coverages };
  }
  return { state: "not_applicable", providers: [], coverages: [] };
}

/** The committed window verdict under the SAME selector. A full contiguous
 *  window is required for a definite verdict; any missing/legacy round is
 *  `unknown`, never "no progress". */
export function deriveProgressWindow(
  rounds: ReadonlyArray<CommittedRoundView>,
  currentRound: number,
  lookback: number,
  selector: ProgressSelector,
): ProgressWindow {
  const window = Number.isInteger(lookback) && lookback >= 1 ? lookback : 1;
  const byRound = new Map<number, CommittedRoundView>();
  for (const round of rounds) {
    if (round.round >= 1 && round.round < currentRound) {
      byRound.set(round.round, round);
    }
  }

  const roundStates: ProgressWindow["roundStates"] = [];
  const providers = new Set<string>();
  const coverages = new Set<string>();
  let incomplete = false;
  let changed = false;
  let unknown = false;
  let notApplicableCount = 0;

  for (let round = currentRound - window; round < currentRound; round++) {
    if (round < 1) {
      incomplete = true;
      continue;
    }
    const view = byRound.get(round);
    if (!view) {
      incomplete = true;
      continue;
    }
    const progress = deriveRoundProgress(view.observationDelta, selector);
    roundStates.push({ round, state: progress.state });
    for (const provider of progress.providers) providers.add(provider);
    for (const coverage of progress.coverages) coverages.add(coverage);
    if (progress.state === "changed") changed = true;
    if (progress.state === "unknown") unknown = true;
    if (progress.state === "not_applicable") notApplicableCount++;
  }

  const providerList = [...providers].sort();
  const coverageList = [...coverages].sort();
  if (incomplete) {
    return {
      state: "unknown",
      roundStates,
      providers: providerList,
      coverages: coverageList,
      incomplete,
      lookback: window,
    };
  }
  if (changed) {
    return {
      state: "changed",
      roundStates,
      providers: providerList,
      coverages: coverageList,
      incomplete,
      lookback: window,
    };
  }
  if (roundStates.length > 0 &&
      roundStates.every((entry) => entry.state === "unchanged")) {
    return {
      state: "unchanged",
      roundStates,
      providers: providerList,
      coverages: coverageList,
      incomplete,
      lookback: window,
    };
  }
  if (roundStates.length > 0 && notApplicableCount === roundStates.length) {
    return {
      state: "not_applicable",
      roundStates,
      providers: [],
      coverages: [],
      incomplete,
      lookback: window,
    };
  }
  return {
    state: "unknown",
    roundStates,
    providers: providerList,
    coverages: coverageList,
    incomplete,
    lookback: window,
  };
}
