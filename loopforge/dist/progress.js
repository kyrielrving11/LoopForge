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
import { coverageKey } from "./evidence-provider.js";
export { gitMotionSignal, observedGitHead } from "./git-motion.js";
export { GIT_WORKSPACE_COVERAGE } from "./git-motion.js";
function uniqueSorted(values) {
    return [...new Set(values)].sort();
}
/** The Git progress verdict for one round's observation deltas. */
export function deriveRoundProgress(deltas) {
    const facts = deltas
        .map((delta) => delta.progress)
        .filter((fact) => fact !== null);
    const providers = uniqueSorted(deltas
        .filter((delta) => delta.progress !== null)
        .map((delta) => delta.providerId));
    const coverages = uniqueSorted(facts.map((fact) => coverageKey(fact.coverage)));
    if (facts.length === 0) {
        return { state: "not_applicable", providers: [], coverages: [] };
    }
    if (facts.some((fact) => fact.state === "changed")) {
        return { state: "changed", providers, coverages };
    }
    const unknown = facts.find((fact) => fact.state === "unknown");
    if (unknown) {
        return {
            state: "unknown",
            providers,
            coverages,
            ...(unknown.detail ? { detail: unknown.detail } : {}),
        };
    }
    return { state: "unchanged", providers, coverages };
}
/** The committed window verdict over the same Git facts. A full contiguous
 *  window is required for a definite verdict; any missing/legacy round is
 *  `unknown`, never "no progress". */
export function deriveProgressWindow(rounds, currentRound, lookback) {
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
        const progress = deriveRoundProgress(view.observationDelta);
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
    if (incomplete || unknown) {
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