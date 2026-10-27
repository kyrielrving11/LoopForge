/** The ONE criterion-status derivation over committed history.
 *
 *  The compiler and the submission boundary/guidance used to reach this fact
 *  through different inputs: the compiler re-read the caller's compile
 *  context, while `submission-guidance` read `criterion_statuses` off the
 *  session's cached compile response. That cache does not survive a restart
 *  and could disagree with the Vault after a replay. This module takes
 *  committed round views only, so both surfaces derive the same rows.
 *
 *  It deliberately lives outside `loop-compiler.ts`: `loop-compiler.ts` imports
 *  `submission-guidance.ts`, so the reverse import would be a cycle. */
import { criterionRefMatches, deriveCriterionId, } from "./token-utils.js";
function claimsFor(view, text) {
    return (view.executionReport?.criterion_claims ?? [])
        .filter((claim) => criterionRefMatches(claim.criterion_id, text))
        .map((claim) => claim.outcome);
}
/** v3.2/v4.0.3: Derive per-criterion status — the "goal → criteria →
 *  evidence" vertical view.
 *
 *  Without a machine fact the LATEST claim wins (a criterion claimed met in
 *  R2 and reported remaining in R4 is `remaining`), and the row records that
 *  claim round with `status_source: "agent"`. A machine fact from a verified
 *  contract item outranks every claim and records its own round/source. Zero
 *  persistence — re-derived from committed facts every time. */
export function deriveCriterionStatuses(input) {
    const objectiveCriteria = input.objective?.success_criteria ?? [];
    if (objectiveCriteria.length === 0)
        return [];
    const rounds = input.rounds
        .filter((round) => round.round >= 1 && round.round < input.currentRound)
        .sort((a, b) => a.round - b.round);
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
        // Latest-claim wins: scan ascending and keep the last claim seen.
        let latestOutcome = null;
        let latestClaimRound = null;
        for (const round of rounds) {
            const claims = claimsFor(round, text);
            if (claims.length === 0)
                continue;
            const outcome = claims[claims.length - 1];
            if (outcome !== latestOutcome) {
                latestOutcome = outcome;
                latestClaimRound = round.round;
            }
            else {
                // A repeated same-direction claim still advances the claim round.
                latestClaimRound = round.round;
            }
        }
        const fact = factsByCriterion.get(id);
        if (fact?.status) {
            statuses.push({
                id,
                text,
                status: fact.status,
                ...(fact.status_at_round !== undefined
                    ? { status_at_round: fact.status_at_round }
                    : {}),
                status_source: "machine",
            });
            continue;
        }
        statuses.push({
            id,
            text,
            status: latestOutcome === "met"
                ? "claimed"
                : latestOutcome === "remaining"
                    ? "remaining"
                    : "unknown",
            ...(latestOutcome !== null && latestClaimRound !== null
                ? { status_at_round: latestClaimRound, status_source: "agent" }
                : {}),
        });
    }
    return statuses;
}
//# sourceMappingURL=criterion-status.js.map