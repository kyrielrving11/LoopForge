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
import { coverageKey } from "./evidence-provider.js";
import { GIT_WORKSPACE_COVERAGE } from "./git-motion.js";
export { gitMotionSignal, observedGitHead } from "./git-motion.js";
export { GIT_WORKSPACE_COVERAGE } from "./git-motion.js";
/** v3.9.9: the ONE selector the stall rule, the in-flight round and prompt
 *  freshness share. Fixed in code this release; no policy key is added. */
export const STALL_PROGRESS_COVERAGE = [
    { kind: "git", coverage: GIT_WORKSPACE_COVERAGE },
];
function coverageEquals(left, right) {
    return left.domain === right.domain &&
        left.object === right.object &&
        left.scope === right.scope &&
        left.version === right.version;
}
function factMatches(fact, selector) {
    return fact.kind === selector.kind &&
        coverageEquals(fact.coverage, selector.coverage);
}
function factsOf(deltas) {
    const facts = [];
    for (const delta of deltas) {
        if (delta.progress)
            facts.push(delta.progress);
    }
    return facts;
}
function uniqueSorted(values) {
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
export function deriveRoundProgress(deltas, selector) {
    const allFacts = factsOf(deltas);
    const selected = selector === "any"
        ? allFacts
        : allFacts.filter((fact) => selector.some((entry) => factMatches(fact, entry)));
    const providers = uniqueSorted(deltas
        .filter((delta) => delta.progress !== null &&
        (selector === "any" || selected.includes(delta.progress)))
        .map((delta) => delta.providerId));
    const coverages = uniqueSorted(selected.map((fact) => coverageKey(fact.coverage)));
    if (selected.some((fact) => fact.state === "changed")) {
        return { state: "changed", providers, coverages };
    }
    if (selector !== "any") {
        const missing = selector.filter((required) => !selected.some((fact) => factMatches(fact, required)));
        if (missing.length > 0 && selected.length > 0) {
            return {
                state: "unknown",
                providers,
                coverages,
                detail: "required progress coverage has no fact: " +
                    missing.map((entry) => `${entry.kind}:${coverageKey(entry.coverage)}`).join(", "),
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
export function deriveProgressWindow(rounds, currentRound, lookback, selector) {
    const window = Number.isInteger(lookback) && lookback >= 1 ? lookback : 1;
    const byRound = new Map();
    for (const round of rounds) {
        if (round.round >= 1 && round.round < currentRound) {
            byRound.set(round.round, round);
        }
    }
    const roundStates = [];
    const providers = new Set();
    const coverages = new Set();
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
        for (const provider of progress.providers)
            providers.add(provider);
        for (const coverage of progress.coverages)
            coverages.add(coverage);
        if (progress.state === "changed")
            changed = true;
        if (progress.state === "unknown")
            unknown = true;
        if (progress.state === "not_applicable")
            notApplicableCount++;
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
//# sourceMappingURL=progress.js.map