/** Shared cognitive facts used by typed projections and handoff views. */

import type { CommittedRoundView } from "./committed-round.js";
import { deriveTodoId } from "./cognitive-governance.js";
import type {
  LoopForgeResponse,
  LoopProjection,
  SubGoal,
  VerifiedSubGoalFact,
} from "./protocol.js";
import { deriveActiveRoundContract, deriveRoundContractView } from "./round-contract.js";
import { deriveContractItemStatuses } from "./contract-items.js";
import { getPolicy } from "./policy.js";
import type { CommandEvidencePolicy } from "./policy.js";
import type { ContractItemStatusView } from "./contract-items.js";

export interface DerivedCognitiveFacts {
  focus: LoopProjection["focus"];
  todo: LoopProjection["todo"];
  phase: LoopProjection["phase"];
  delegation: LoopProjection["delegation"];
  handoff: LoopProjection["handoff"];
  /** v3.8: forwarded, not re-derived — the same facts the canonical state
   *  embeds, so the projection and the prompt cannot disagree. */
  verified_subgoals: LoopProjection["verified_subgoals"];
}

const TODO_LIMIT = 10;

/** v3.8: Machine-verified sub-goal facts. DERIVED, never persisted. It never
 *  writes `SubGoal.status`: `done` stays the agent's declaration, and the fact
 *  is the machine's separate statement about it.
 *
 *  Derived from the WHOLE committed history, not from the currently-open
 *  contract. A verified item is machine history — once proven, it stays
 *  proven — while the active contract necessarily disappears the moment its
 *  last item verifies. Deriving from the active contract alone made the fact
 *  vanish at exactly the moment it became fully true, and turned the
 *  verification-debt view into a false accusation ("agent reported done,
 *  machine verification absent") against a sub-goal the machine had just
 *  verified. Each round is read through `deriveRoundContractView`, the same
 *  derivation the coordinator, explain and audit use — one history
 *  interpretation, no second read model. That re-derivation is quadratic in the
 *  round count (≈40ms at 120 rounds) and is deliberately bought: an incremental
 *  walker would be a second implementation of the closure rule, which is the
 *  one thing this module must never grow.
 *
 *  Attribution is per ITEM (`ContractItemProposal.subgoal_refs`), not per
 *  contract: an item backs exactly the sub-goals it references, so a contract
 *  whose item A verifies SubGoal 1 and whose item B verifies SubGoal 2 yields
 *  two facts with disjoint `contract_item_ids` instead of both sub-goals
 *  claiming every verified item. */
export function deriveVerifiedSubGoals(input: {
  subGoals: ReadonlyArray<SubGoal>;
  /** Committed rounds (rollback-excluded), ascending. */
  rounds: ReadonlyArray<CommittedRoundView>;
  commands: ReadonlyArray<CommandEvidencePolicy>;
}): VerifiedSubGoalFact[] {
  const known = new Set(input.subGoals.map((subGoal) => subGoal.id));
  if (known.size === 0) return [];

  // First-reference order across the history — deterministic, and independent
  // of which item happened to verify first.
  const order: string[] = [];
  const itemIdsBySubGoal = new Map<string, string[]>();
  const verifiedAt = new Map<string, number>();

  for (const round of input.rounds) {
    const { contract, statuses } = deriveRoundContractView({
      rounds: input.rounds,
      round: round.round,
      report: round.executionReport,
      observations: round.observationDelta,
      outcome: round.outcome,
      commands: input.commands,
    });
    if (!contract) continue;
    const statusAt = new Map(statuses.items.map((item) => [item.itemId, item] as const));
    for (const item of contract.items) {
      if (statusAt.get(item.id)?.status !== "verified") continue;
      for (const ref of item.subgoal_refs) {
        if (!known.has(ref)) continue;
        const itemIds = itemIdsBySubGoal.get(ref) ?? [];
        if (!itemIds.includes(item.id)) itemIds.push(item.id);
        itemIdsBySubGoal.set(ref, itemIds);
        if (!order.includes(ref)) order.push(ref);
        const at = statusAt.get(item.id)?.status_at_round ?? round.round;
        verifiedAt.set(ref, Math.max(verifiedAt.get(ref) ?? 0, at));
      }
    }
  }

  return order.map((subgoalId) => ({
    subgoal_id: subgoalId,
    contract_item_ids: itemIdsBySubGoal.get(subgoalId) ?? [],
    verified_at_round: verifiedAt.get(subgoalId) ?? 0,
  }));
}

/** v3.8: Sub-goals the agent declared `done` that no verified contract item
 *  backs — verification debt, surfaced in the handoff's open risks. */
export function deriveVerificationDebt(
  subGoals: ReadonlyArray<SubGoal>,
  verified: ReadonlyArray<VerifiedSubGoalFact>,
  statuses: ContractItemStatusView,
): string[] {
  const debt: string[] = [];
  const verifiedIds = new Set(verified.map((fact) => fact.subgoal_id));
  for (const subGoal of subGoals) {
    if (subGoal.status !== "done" || verifiedIds.has(subGoal.id)) continue;
    debt.push(
      `sub-goal ${subGoal.id} "${subGoal.description.slice(0, 120)}": ` +
      "agent reported done, machine verification absent",
    );
  }
  for (const item of statuses.items) {
    if (item.status !== "insufficient") continue;
    debt.push(
      `contract item ${item.itemId}: claimed met but not machine-verified` +
      (item.reasons.length > 0 ? ` (${item.reasons[0]})` : ""),
    );
  }
  return debt;
}

function deriveTodo(
  compileResponse: LoopForgeResponse | null,
  rounds: ReadonlyArray<CommittedRoundView>,
  contractItemStatuses: ContractItemStatusView | null,
): LoopProjection["todo"] {
  const candidates: LoopProjection["todo"] = [];
  const seen = new Set<string>();
  const push = (
    item: string,
    reason: string,
    source: "derived",
    priority: number,
  ): void => {
    const text = item.trim().slice(0, 200);
    if (!text) return;
    const id = deriveTodoId(text);
    if (seen.has(id)) return;
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
    } else if (item.status === "pending") {
      push(item.description, "pending contract item", "derived", 8);
    }
  }
  for (const subGoal of compileResponse?.sub_goals ?? []) {
    const goal = subGoal as SubGoal;
    if (goal.status === "blocked") {
      push(goal.description, "blocked sub-goal", "derived", 9);
    } else if (goal.status === "pending") {
      push(goal.description, "pending sub-goal", "derived", goal.priority ?? 5);
    }
  }

  return candidates
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, TODO_LIMIT);
}

export function deriveCognitiveFacts(input: {
  compileResponse: LoopForgeResponse | null;
  rounds: ReadonlyArray<CommittedRoundView>;
  verifiedClaims?: string[];
  openGates?: string[];
}): DerivedCognitiveFacts {
  const { compileResponse, rounds } = input;
  const latestFocus = [...rounds].reverse().find((round) =>
    round.outcome !== "failed" &&
    typeof round.evaluation?.output_summary === "string" &&
    round.evaluation.output_summary.length > 0,
  );
  const milestones = compileResponse?.rolling_summary?.milestones ?? [];
  const boundaries = milestones
    .filter((milestone) => typeof milestone.round_range?.end === "number")
    .map((milestone) => ({ label: milestone.label, round: milestone.round_range.end }));
  const lastBoundary = boundaries[boundaries.length - 1];
  const workerRounds = rounds.filter((round) =>
    (round.evaluation?.worker_results?.length ?? 0) > 0,
  );
  const latestWorkerRound = workerRounds[workerRounds.length - 1];
  const workerResults = latestWorkerRound?.evaluation?.worker_results ?? [];
  const rolling = compileResponse?.rolling_summary;
  const activeContract = deriveActiveRoundContract(rounds);
  // v3.8: the same reducer every other view consumes — no second history.
  const contractItemStatuses = deriveContractItemStatuses({
    contract: activeContract,
    rounds,
    currentRound: (rounds[rounds.length - 1]?.round ?? 0) + 1,
    currentReport: null,
    currentObservations: [],
    commands: getPolicy().evidence.commands ?? [],
  });
  const verifiedSubGoals = deriveVerifiedSubGoals({
    subGoals: compileResponse?.sub_goals ?? [],
    rounds,
    commands: getPolicy().evidence.commands ?? [],
  });
  const verificationDebt = deriveVerificationDebt(
    compileResponse?.sub_goals ?? [],
    verifiedSubGoals,
    contractItemStatuses,
  );
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
      ? { what: latestFocus.evaluation!.output_summary.slice(0, 200), since_round: latestFocus.round }
      : null,
    todo: deriveTodo(compileResponse, rounds, contractItemStatuses),
    phase: lastBoundary
      ? { current: lastBoundary.label, label: lastBoundary.label, boundaries }
      : null,
    delegation: {
      pending: workerResults.filter((worker) =>
        worker.outcome === "partial" || worker.outcome === "failed",
      ).length,
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
        ...(rolling?.recurring_issues ?? []).slice(0, 5),
        ...(input.openGates ?? []).slice(0, 3).map((gate) => `user gate pending: ${gate}`),
      ])],
    },
    verified_subgoals: verifiedSubGoals,
  };
}
