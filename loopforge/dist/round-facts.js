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
/** v3.8.1: criterion → machine status, derived over the WHOLE committed
 *  history exactly like the contract walk. A verified item is machine history
 *  that survives its contract closing. Statuses fold by STRENGTH across the
 *  items that reference a criterion (a machine denial outranks a verification,
 *  which outranks insufficient), and a `pending` item contributes nothing. */
function deriveCriterionFacts(input) {
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
        for (const item of contract.items) {
            const itemStatus = statusByItem.get(item.id);
            for (const ref of item.criterion_refs) {
                if (!isCriterionId(ref))
                    continue;
                const existing = byCriterion.get(ref);
                const machineStatus = itemStatus && itemStatus !== "pending"
                    ? strongestStatus(existing?.status, itemStatus)
                    : existing?.status;
                byCriterion.set(ref, {
                    criterion_id: ref,
                    ...(machineStatus ? { status: machineStatus } : {}),
                });
            }
        }
    }
    return [...byCriterion.values()];
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