/** Shared cognitive facts used by typed projections and handoff views. */
import { deriveTodoId } from "./cognitive-governance.js";
const TODO_LIMIT = 10;
/** Re-exported from round-facts.ts. The contract-fact derivation (walker,
 *  item reducer, verified sub-goals, verification debt) lives with the bundle
 *  every consumer reads — one implementation, one history window. */
export { deriveVerifiedSubGoals, deriveVerificationDebt } from "./round-facts.js";
function deriveTodo(compileResponse, contractItemStatuses) {
    const candidates = [];
    const seen = new Set();
    const push = (item, reason, source, priority) => {
        const text = item.trim().slice(0, 200);
        if (!text)
            return;
        const id = deriveTodoId(text);
        if (seen.has(id))
            return;
        seen.add(id);
        candidates.push({ id, item: text, reason, source, priority });
    };
    // v3.8: the only sources are machine/cognitive derivations — the agent's
    // own next_action and emerged_subtasks are no longer projection inputs
    // (emerged items already surface through their compiled sub-goals).
    //
    // The ACTIVE contract's unresolved items come first: they are the bounded
    // work this round executes under, and `insufficient` items are the
    // verification debt the agent must close.
    for (const item of contractItemStatuses?.items ?? []) {
        if (item.status === "insufficient") {
            push(item.description, "contract item claimed met, not machine-verified", "derived", 10);
        }
        else if (item.status === "pending") {
            push(item.description, "pending contract item", "derived", 8);
        }
    }
    for (const subGoal of compileResponse?.sub_goals ?? []) {
        const goal = subGoal;
        if (goal.status === "blocked") {
            push(goal.description, "blocked sub-goal", "derived", 9);
        }
        else if (goal.status === "pending") {
            push(goal.description, "pending sub-goal", "derived", goal.priority ?? 5);
        }
    }
    return candidates
        .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
        .slice(0, TODO_LIMIT);
}
export function deriveCognitiveFacts(input) {
    const { compileResponse, rounds } = input;
    const latestFocus = [...rounds].reverse().find((round) => round.outcome !== "failed" &&
        typeof round.evaluation?.output_summary === "string" &&
        round.evaluation.output_summary.length > 0);
    const milestones = compileResponse?.rolling_summary?.milestones ?? [];
    const boundaries = milestones
        .filter((milestone) => typeof milestone.round_range?.end === "number")
        .map((milestone) => ({ label: milestone.label, round: milestone.round_range.end }));
    const lastBoundary = boundaries[boundaries.length - 1];
    const workerRounds = rounds.filter((round) => (round.evaluation?.worker_results?.length ?? 0) > 0);
    const latestWorkerRound = workerRounds[workerRounds.length - 1];
    const workerResults = latestWorkerRound?.evaluation?.worker_results ?? [];
    const rolling = compileResponse?.rolling_summary;
    // v3.8.1: read from the caller's derivation — do NOT re-run the reducers
    // here. Two derivations of the same fact is how the projection and the
    // prompt start disagreeing.
    const { activeContract, itemStatuses: contractItemStatuses, verifiedSubGoals, verificationDebt, } = input.facts;
    const currentTask = activeContract?.work_item ??
        compileResponse?.loop_objective?.objective ?? "";
    const latestOutcome = rolling?.key_outcomes[rolling.key_outcomes.length - 1] ??
        latestFocus?.evaluation?.output_summary ?? "";
    const remainingCriteria = (compileResponse?.criterion_statuses ?? [])
        .filter((criterion) => criterion.status !== "verified" && criterion.status !== "claimed")
        .map((criterion) => criterion.text)
        .slice(0, 5);
    const summary = [
        currentTask ? `Current task: ${currentTask.slice(0, 200)}` : "",
        latestOutcome ? `Latest outcome: ${latestOutcome.slice(0, 200)}` : "",
        remainingCriteria.length > 0
            ? `Remaining criteria: ${remainingCriteria.join("; ").slice(0, 300)}`
            : "",
    ].filter(Boolean).join(" | ");
    const latestBlocker = [...rounds].reverse()
        .find((round) => round.outcome === "blocked")?.evaluation?.blocker;
    return {
        focus: latestFocus
            ? { what: latestFocus.evaluation.output_summary.slice(0, 200), since_round: latestFocus.round }
            : null,
        todo: deriveTodo(compileResponse, contractItemStatuses),
        phase: lastBoundary
            ? { current: lastBoundary.label, label: lastBoundary.label, boundaries }
            : null,
        delegation: {
            pending: workerResults.filter((worker) => worker.outcome === "partial" || worker.outcome === "failed").length,
            last_results: workerResults.slice(-5).map((worker) => ({
                agentId: worker.agentId,
                outcome: worker.outcome,
                round: latestWorkerRound?.round ?? 0,
                summary: worker.resultSummary.slice(0, 200),
            })),
        },
        handoff: {
            summary,
            verified: [...(input.verifiedClaims ?? [])],
            open_risks: [...new Set([
                    ...(latestBlocker ? [latestBlocker] : []),
                    ...verificationDebt,
                    ...(input.openGates ?? []).slice(0, 3).map((gate) => `user gate pending: ${gate}`),
                ])],
        },
        verified_subgoals: verifiedSubGoals,
    };
}
//# sourceMappingURL=cognitive-facts.js.map