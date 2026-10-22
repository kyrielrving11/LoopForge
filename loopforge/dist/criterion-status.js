/** The ONE criterion-status derivation over committed history.
 *
 *  The compiler and the submission boundary/guidance used to reach this fact
 *  through different inputs: the compiler re-read the caller's compile
 *  context, while `submission-guidance` read `criterion_statuses` off the
 *  session's cached compile response. That cache does not survive a restart
 *  and could disagree with the Vault after a replay. This module takes
 *  committed entries only, so both surfaces derive the same rows.
 *
 *  It deliberately lives outside `loop-compiler.ts`: `loop-compiler.ts` imports
 *  `submission-guidance.ts`, so the reverse import would be a cycle. */
import { entryCriteriaMet, entryCriteriaRemaining, } from "./committed-round.js";
import { criterionRefMatches, deriveCriterionId, entryRound, } from "./token-utils.js";
/** Read one outcome arm of an execution report's criterion claims. Kept here
 *  (not imported from self-eval) so this module does not add an edge into the
 *  `self-eval ⇄ submission-guidance` import graph. */
function claimedCriteria(report, outcome) {
    return (report?.criterion_claims ?? [])
        .filter((claim) => claim.outcome === outcome)
        .map((claim) => claim.criterion_id);
}
/** v3.2: Derive per-criterion status — the "goal → criteria → evidence"
 *  vertical view. Each criterion gets: claimed/remaining/unknown (from
 *  per-round `criterion_claims`, ID-first or normalized-exact matching), the
 *  round it was first reported met, and the sub-goals a contract item
 *  referencing it also names (explicit `subgoal_refs`, never a text guess).
 *  A machine fact from a contract item outranks the claim. Zero persistence —
 *  re-derived from committed facts every time. */
export function deriveCriterionStatuses(input) {
    const objectiveCriteria = input.objective?.success_criteria ?? [];
    if (objectiveCriteria.length === 0)
        return [];
    const entries = input.entries
        .filter((entry) => {
        const round = entryRound(entry);
        return round >= 1 && round < input.currentRound;
    })
        .sort((a, b) => entryRound(a) - entryRound(b));
    // The previous round's report, resolved from the committed view (or the
    // library fallback), is treated as the report for round currentRound - 1.
    const lastEv = input.lastRoundResult?.execution_report;
    const lastMet = claimedCriteria(lastEv, "met");
    const lastRemaining = claimedCriteria(lastEv, "remaining");
    const lastEntry = entries[entries.length - 1] ?? null;
    const lastEntryRemaining = lastEntry ? entryCriteriaRemaining(lastEntry) : [];
    const factsByCriterion = new Map((input.criterionFacts ?? []).map((fact) => [fact.criterion_id, fact]));
    // v3.9.4: one row per derived id. The objective is authored text; a case or
    // whitespace variant derives the same cr-* and must not produce a second
    // row (nor a second contract reference space).
    const seenIds = new Set();
    const statuses = [];
    for (const text of objectiveCriteria) {
        const id = deriveCriterionId(text);
        if (seenIds.has(id))
            continue;
        seenIds.add(id);
        let metAtRound = null;
        for (const entry of entries) {
            const rnd = entryRound(entry);
            if (entryCriteriaMet(entry).some((met) => criterionRefMatches(met, text))) {
                metAtRound = rnd;
                break; // first report wins — chronological scan
            }
        }
        if (metAtRound === null && lastMet.some((met) => criterionRefMatches(met, text))) {
            metAtRound = input.currentRound - 1;
        }
        // v3.8: a claim reaches `claimed` at most. Only a machine fact about a
        // contract item that references this criterion can go further.
        const claimedStatus = metAtRound !== null
            ? "claimed"
            : lastRemaining.some((remaining) => criterionRefMatches(remaining, text)) ||
                lastEntryRemaining.some((remaining) => criterionRefMatches(remaining, text))
                ? "remaining"
                : "unknown";
        const fact = factsByCriterion.get(id);
        const status = fact?.status ?? claimedStatus;
        statuses.push({
            id,
            text,
            status,
            ...(metAtRound !== null ? { met_at_round: metAtRound } : {}),
            // v3.8.1: explicit refs only — empty when no contract item links this
            // criterion to a sub-goal.
            related_subgoal_ids: fact?.related_subgoal_ids ?? [],
        });
    }
    return statuses;
}
//# sourceMappingURL=criterion-status.js.map