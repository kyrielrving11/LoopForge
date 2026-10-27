/** v3.8.1: THE contract-fact derivation.
 *
 * The contract walker, the item reducer and the criterion machine facts are
 * one pass over one history window. Every caller passes
 * `derivationRounds(entries, currentRound)` (the shared window from
 * committed-round.ts) and receives the same bundle.
 *
 * v4.0.1: the sub-goal verification link (`subgoal_refs`,
 * `VerifiedSubGoalFact`, verification debt) was removed. It never rendered in
 * a prompt or state file; it only fed stateHash. Sub-goals remain the Agent's
 * plan report, not a machine acceptance surface.
 */
import { deriveContractItemStatuses } from "./contract-items.js";
import { committedRoundFacts, deriveActiveRoundContract, deriveRoundContractView, } from "./round-contract.js";
import { isCriterionId } from "./token-utils.js";
export const NO_IN_FLIGHT_ROUND = {
    currentReport: null,
    currentDeltas: [],
    currentBlocked: false,
    currentTransition: null,
    currentOutcome: null,
};
export function deriveRoundFacts(input) {
    const activeContract = deriveActiveRoundContract(input.rounds, input.commands);
    const itemStatuses = deriveContractItemStatuses({
        contract: activeContract,
        rounds: input.rounds,
        currentRound: input.currentRound,
        currentReport: input.inFlight.currentReport,
        currentDeltas: input.inFlight.currentDeltas,
        currentBlocked: input.inFlight.currentBlocked ??
            input.inFlight.currentOutcome === "blocked",
        currentTransition: input.inFlight.currentTransition ?? null,
        commands: input.commands,
    });
    return {
        activeContract,
        itemStatuses,
        criterionFacts: deriveCriterionFacts({
            rounds: input.rounds,
            commands: input.commands,
        }),
    };
}
/** v3.8.1/v4.0.3: criterion → machine status, derived over the WHOLE committed
 *  history exactly like the contract walk.
 *
 *  Within one round the strongest item fact wins (contradicted > verified >
 *  insufficient); a `pending` item contributes nothing. Across rounds the
 *  LATEST authoritative fact wins: a later `verified` or `contradicted` may
 *  supersede an earlier one (so a contradiction can be re-verified), while an
 *  `insufficient` round never erases an existing verified/contradicted fact.
 *  `status_at_round` records when the current status was first reached. */
export function deriveCriterionFacts(input) {
    const byCriterion = new Map();
    for (const round of input.rounds) {
        const { contract, statuses } = deriveRoundContractView({
            rounds: input.rounds,
            round: round.round,
            current: committedRoundFacts(round),
            commands: input.commands,
        });
        if (!contract)
            continue;
        const statusByItem = new Map(statuses.items.map((item) => [item.itemId, item.status]));
        // One round can reference a criterion from several items; fold them to
        // the strongest fact THIS round states.
        const roundBest = new Map();
        for (const item of contract.items) {
            const itemStatus = statusByItem.get(item.id);
            if (!itemStatus || itemStatus === "pending")
                continue;
            for (const ref of item.criterion_refs) {
                if (!isCriterionId(ref))
                    continue;
                roundBest.set(ref, strongestStatus(roundBest.get(ref), itemStatus));
            }
        }
        for (const [ref, status] of roundBest) {
            const existing = byCriterion.get(ref);
            if (!existing) {
                byCriterion.set(ref, { status, status_at_round: round.round });
                continue;
            }
            // A later insufficient observation is not a new conclusion; it cannot
            // erase a machine-supported status. The same status keeps its first
            // round.
            if (status === "insufficient" || existing.status === status)
                continue;
            byCriterion.set(ref, { status, status_at_round: round.round });
        }
    }
    return [...byCriterion.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([criterion_id, fact]) => ({
        criterion_id,
        status: fact.status,
        status_at_round: fact.status_at_round,
    }));
}
/** Rank item statuses so the strongest machine fact wins when several items
 *  reference the same criterion. */
function strongestStatus(left, right) {
    const rank = {
        contradicted: 3,
        verified: 2,
        insufficient: 1,
    };
    if (!left)
        return right;
    return rank[right] > rank[left] ? right : left;
}
//# sourceMappingURL=round-facts.js.map