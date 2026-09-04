/** Shared cognitive facts used by typed projections and handoff views. */
import { deriveTodoId } from "./cognitive-governance.js";
import { contractRoundEvaluations, deriveActiveRoundContract, } from "./round-contract.js";
const TODO_LIMIT = 10;
function deriveTodo(compileResponse, rounds) {
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
    for (const subGoal of compileResponse?.sub_goals ?? []) {
        const goal = subGoal;
        if (goal.status === "blocked") {
            push(goal.description, "blocked sub-goal", "derived", 9);
        }
        else if (goal.status === "pending") {
            push(goal.description, "pending sub-goal", "derived", goal.priority ?? 5);
        }
    }
    const latest = rounds[rounds.length - 1]?.evaluation;
    if (latest?.next_action) {
        push(latest.next_action, "agent-declared next action", "agent_intent", 0);
    }
    for (const task of latest?.emerged_subtasks ?? []) {
        push(task, "agent-declared emerged work", "agent_intent", 6);
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
    const activeContract = deriveActiveRoundContract(contractRoundEvaluations(rounds));
    const currentTask = activeContract?.work_item ??
        compileResponse?.loop_objective?.objective ?? "";
    const latestOutcome = rolling?.key_outcomes[rolling.key_outcomes.length - 1] ??
        latestFocus?.evaluation?.output_summary ?? "";
    const remainingCriteria = (compileResponse?.criterion_statuses ?? [])
        .filter((criterion) => criterion.status !== "met")
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
        todo: deriveTodo(compileResponse, rounds),
        phase: lastBoundary
            ? { current: lastBoundary.label, label: lastBoundary.label, boundaries }
            : null,
        delegation: {
            pending: workerResults.filter((worker) => worker.outcome === "partial" || worker.outcome === "failed" ||
                (worker.outcome === undefined && worker.success !== true)).length,
            last_results: workerResults.slice(-5).map((worker) => ({
                agentId: worker.agentId,
                outcome: worker.outcome ?? (worker.success ? "success" : "failed"),
                round: latestWorkerRound?.round ?? 0,
                summary: worker.resultSummary.slice(0, 200),
            })),
        },
        handoff: {
            summary,
            verified: [...(input.verifiedClaims ?? [])],
            open_risks: [...new Set([
                    ...(latestBlocker ? [latestBlocker] : []),
                    ...(rolling?.recurring_issues ?? []).slice(0, 5),
                    ...(input.openGates ?? []).slice(0, 3).map((gate) => `user gate pending: ${gate}`),
                ])],
        },
    };
}
//# sourceMappingURL=cognitive-facts.js.map