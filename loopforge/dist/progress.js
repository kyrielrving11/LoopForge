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
import { gitMotionSignal, observedGitHead, observedGitObservation, } from "./git-motion.js";
export { gitMotionSignal, observedGitHead } from "./git-motion.js";
function gitDeltaProgress(delta, restoreTargetHead) {
    const after = observedGitObservation(delta.after);
    if (!after)
        return null;
    const before = observedGitObservation(delta.before);
    // No before baseline is still enough for the restore-point arm: landing on
    // the rollback's restore commit is motion even when the baseline is absent.
    return gitMotionSignal({
        changedFiles: delta.changedFiles,
        headBefore: observedGitHead(before ?? undefined),
        headAfter: observedGitHead(after),
        restoreTargetHead: restoreTargetHead ?? null,
    });
}
/** Aggregate one round's per-provider deltas. Any proven change wins; a
 *  comparable unknown blocks an "unchanged" verdict; no applicable provider
 *  is not_applicable. */
export function deriveRoundProgress(deltas, restoreTargetHead) {
    const providers = [];
    let changed = false;
    let unknown = false;
    let applicable = false;
    let detail;
    for (const delta of deltas) {
        if (delta.kind === "git") {
            applicable = true;
            providers.push(delta.providerId);
            const signal = gitDeltaProgress(delta, restoreTargetHead);
            if (signal === true)
                changed = true;
            else if (signal === null) {
                unknown = true;
                detail ??= `git boundary is not comparable for ${delta.providerId}`;
            }
            continue;
        }
        if (delta.kind === "custom") {
            if (delta.progress === "not_applicable")
                continue;
            applicable = true;
            providers.push(delta.providerId);
            if (delta.progress === "changed")
                changed = true;
            else if (delta.progress === "unknown") {
                unknown = true;
                detail ??= `progress snapshot is not comparable for ${delta.providerId}`;
            }
            continue;
        }
        // Command observations are verification evidence, not progress.
    }
    const uniqueProviders = [...new Set(providers)].sort();
    if (changed)
        return { state: "changed", providers: uniqueProviders };
    if (unknown) {
        return { state: "unknown", providers: uniqueProviders, ...(detail ? { detail } : {}) };
    }
    if (applicable)
        return { state: "unchanged", providers: uniqueProviders };
    return { state: "not_applicable", providers: [] };
}
/** The committed window verdict. A full contiguous window is required for a
 *  definite verdict; any missing/legacy round is `unknown`, never "no
 *  progress". */
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
    let incomplete = false;
    let changed = false;
    let unknown = false;
    let notApplicable = true;
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
        if (progress.state === "changed")
            changed = true;
        if (progress.state === "unknown")
            unknown = true;
        if (progress.state !== "not_applicable")
            notApplicable = false;
    }
    const providerList = [...providers].sort();
    if (incomplete) {
        return {
            state: "unknown",
            roundStates,
            providers: providerList,
            incomplete,
            lookback: window,
        };
    }
    if (changed) {
        return {
            state: "changed",
            roundStates,
            providers: providerList,
            incomplete,
            lookback: window,
        };
    }
    if (roundStates.length > 0 && roundStates.every((entry) => entry.state === "unchanged")) {
        return {
            state: "unchanged",
            roundStates,
            providers: providerList,
            incomplete,
            lookback: window,
        };
    }
    if (notApplicable || roundStates.every((entry) => entry.state === "not_applicable")) {
        return {
            state: "not_applicable",
            roundStates,
            providers: [],
            incomplete,
            lookback: window,
        };
    }
    return {
        state: "unknown",
        roundStates,
        providers: providerList,
        incomplete,
        lookback: window,
    };
}
/** Git-only compatibility helpers for callers/tests that need the raw
 *  boolean series. They are thin wrappers over the same Git rule. */
export function inFlightGitMotion(deltas, restoreTargetHead) {
    const gitDeltas = deltas.filter((delta) => delta.kind === "git");
    if (gitDeltas.length === 0)
        return null;
    let sawUnknown = false;
    for (const delta of gitDeltas) {
        const signal = gitDeltaProgress(delta, restoreTargetHead);
        if (signal === true)
            return true;
        if (signal === null)
            sawUnknown = true;
    }
    return sawUnknown ? null : false;
}
export function committedRoundGitMotion(view) {
    return inFlightGitMotion(view.observationDelta);
}
export function machineGitMotionSeries(rounds, currentRound, lookback) {
    if (!Number.isInteger(lookback) || lookback < 1 || currentRound <= lookback)
        return null;
    const byRound = new Map();
    for (const round of rounds) {
        if (round.round >= 1 && round.round < currentRound)
            byRound.set(round.round, round);
    }
    const series = [];
    for (let round = currentRound - lookback; round < currentRound; round++) {
        const view = byRound.get(round);
        if (!view)
            return null;
        const gitDeltas = view.observationDelta.filter((delta) => delta.kind === "git");
        if (gitDeltas.length === 0)
            return null;
        let sawUnknown = false;
        let moved = false;
        for (const delta of gitDeltas) {
            const signal = gitDeltaProgress(delta);
            if (signal === true)
                moved = true;
            else if (signal === null)
                sawUnknown = true;
        }
        if (!moved) {
            if (sawUnknown)
                return null;
            series.push(false);
        }
        else {
            series.push(true);
        }
    }
    return series;
}
//# sourceMappingURL=progress.js.map