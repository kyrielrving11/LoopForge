/** v3.8.1: THE contract-fact derivation.
 *
 * The contract walker, the item reducer, the verified sub-goal facts and the
 * verification debt are one pass over one history window. Before this module
 * the compile path and the projection each ran the same reducers over their
 * own window, so the prompt and the projection could tell different stories
 * about what the machine had verified — and nothing stopped a third caller
 * from picking a third window.
 *
 * Every caller passes `derivationRounds(entries, currentRound)` (the shared
 * window from committed-round.ts) and receives the same bundle, so "one fact,
 * one derivation" is a property of the types rather than a convention.
 */

import type { CommittedRoundView } from "./committed-round.js";
import type { ContractItemStatusView } from "./contract-items.js";
import { deriveContractItemStatuses } from "./contract-items.js";
import type { CommandEvidencePolicy } from "./policy.js";
import type {
  ExecutionReport,
  MachineObservation,
  SubGoal,
  VerifiedSubGoalFact,
} from "./protocol.js";
import type { ActiveContractView } from "./round-contract.js";
import { deriveActiveRoundContract, deriveRoundContractView } from "./round-contract.js";

export interface RoundFacts {
  /** The contract the NEXT round executes under — derived from committed
   *  rounds only, so a retry / resume / backtrack compile keeps showing it. */
  activeContract: ActiveContractView | null;
  /** Per-item status of `activeContract`. */
  itemStatuses: ContractItemStatusView;
  /** v3.8: machine-verified sub-goals. Never writes `SubGoal.status`. */
  verifiedSubGoals: VerifiedSubGoalFact[];
  /** `done` sub-goals no verified item backs, plus `insufficient` items. */
  verificationDebt: string[];
}

/** The in-flight slice of a round that is being decided but is not yet
 *  committed. A pure committed-history replay passes null / [] — the reducer
 *  then sees committed facts only, which is exactly what the compile path
 *  wants. */
export interface InFlightRoundSlice {
  currentReport: ExecutionReport | null;
  currentObservations: ReadonlyArray<MachineObservation>;
  /** The in-flight round's own effective outcome. A `blocked` round CLOSES its
   *  contract, so closure cannot be derived from committed slices alone. */
  currentOutcome?: string | null;
}

export const NO_IN_FLIGHT_ROUND: InFlightRoundSlice = {
  currentReport: null,
  currentObservations: [],
  currentOutcome: null,
};

export function deriveRoundFacts(input: {
  /** `derivationRounds(entries, currentRound)` — the shared window. */
  rounds: ReadonlyArray<CommittedRoundView>;
  currentRound: number;
  inFlight: InFlightRoundSlice;
  subGoals: ReadonlyArray<SubGoal>;
  commands: ReadonlyArray<CommandEvidencePolicy>;
}): RoundFacts {
  const activeContract = deriveActiveRoundContract(input.rounds, input.commands);
  const itemStatuses = deriveContractItemStatuses({
    contract: activeContract,
    rounds: input.rounds,
    currentRound: input.currentRound,
    currentReport: input.inFlight.currentReport,
    currentObservations: input.inFlight.currentObservations,
    currentOutcome: input.inFlight.currentOutcome ?? null,
    commands: input.commands,
  });
  const verifiedSubGoals = deriveVerifiedSubGoals({
    subGoals: input.subGoals,
    rounds: input.rounds,
    commands: input.commands,
  });
  return {
    activeContract,
    itemStatuses,
    verifiedSubGoals,
    verificationDebt: deriveVerificationDebt(
      input.subGoals,
      verifiedSubGoals,
      itemStatuses,
    ),
  };
}

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
