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
  ContractItemStatus,
  ExecutionReport,
  MachineObservation,
  SubGoal,
  VerifiedSubGoalFact,
} from "./protocol.js";
import type { ActiveContractView } from "./round-contract.js";
import { deriveActiveRoundContract, deriveRoundContractView } from "./round-contract.js";
import { deriveCriterionId, isCriterionId } from "./token-utils.js";

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
  /** v3.8.1: the machine fact about each criterion a contract item referenced,
   *  over the WHOLE committed history — the criterion-side twin of
   *  `verifiedSubGoals`, and read by the same callers. */
  criterionFacts: CriterionMachineFact[];
}

/** v3.8.1: ONE criterion's machine fact. `status` is absent while every item
 *  referencing the criterion is still `pending` — "no claim yet" says nothing
 *  about the criterion, so the criterion keeps its claim-derived status. The
 *  links are explicit `subgoal_refs` only, and they survive their item's
 *  contract closing just like the status does. */
export interface CriterionMachineFact {
  criterion_id: string;
  status?: Exclude<ContractItemStatus, "pending">;
  related_subgoal_ids: string[];
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
    criterionFacts: deriveCriterionFacts({
      activeContract,
      rounds: input.rounds,
      commands: input.commands,
    }),
  };
}

/** v3.8.1: criterion → machine status + explicit sub-goal links, derived over
 *  the WHOLE committed history, exactly like `deriveVerifiedSubGoals` below
 *  and for the same reason: a verified item is machine history that survives
 *  its contract closing. Reading only the ACTIVE contract made the criterion's
 *  machine status vanish at the moment the contract became fully true — the
 *  state file's Goal → Criteria row fell from ✅ back to 🟡 and its
 *  `(related: sg-…)` links disappeared, while the sub-goal side of the same
 *  fact correctly survived.
 *
 *  Statuses fold by STRENGTH across the items that reference a criterion (a
 *  machine denial outranks a verification, which outranks insufficient), and a
 *  `pending` item contributes links but no status. */
function deriveCriterionFacts(input: {
  /** The contract the NEXT round executes under — its items are declared
   *  machine knowledge, so their links exist before any round has executed
   *  under it (a proposal declared in round R is active from R+1, and the
   *  compile of R+1 reads this bundle). */
  activeContract: ActiveContractView | null;
  rounds: ReadonlyArray<CommittedRoundView>;
  commands: ReadonlyArray<CommandEvidencePolicy>;
}): CriterionMachineFact[] {
  const byCriterion = new Map<string, CriterionMachineFact>();
  // Seed with the active contract's items: links are declarations, so they do
  // not need a round to have executed under the contract. Statuses are only
  // ever machine facts from the history walk below (`pending` says nothing).
  for (const item of input.activeContract?.items ?? []) {
    for (const ref of item.criterion_refs) {
      const criterionId = isCriterionId(ref) ? ref : deriveCriterionId(ref);
      const existing = byCriterion.get(criterionId);
      const links = existing?.related_subgoal_ids ?? [];
      for (const subgoalId of item.subgoal_refs) {
        if (!links.includes(subgoalId)) links.push(subgoalId);
      }
      byCriterion.set(criterionId, {
        criterion_id: criterionId,
        ...(existing?.status ? { status: existing.status } : {}),
        related_subgoal_ids: links,
      });
    }
  }
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
    const statusByItem = new Map(
      statuses.items.map((item) => [item.itemId, item.status] as const),
    );
    for (const item of contract.items) {
      const itemStatus = statusByItem.get(item.id);
      for (const ref of item.criterion_refs) {
        const criterionId = isCriterionId(ref) ? ref : deriveCriterionId(ref);
        const existing = byCriterion.get(criterionId);
        const links = existing?.related_subgoal_ids ?? [];
        for (const subgoalId of item.subgoal_refs) {
          if (!links.includes(subgoalId)) links.push(subgoalId);
        }
        const machineStatus = itemStatus && itemStatus !== "pending"
          ? strongestStatus(existing?.status, itemStatus)
          : existing?.status;
        byCriterion.set(criterionId, {
          criterion_id: criterionId,
          ...(machineStatus ? { status: machineStatus } : {}),
          related_subgoal_ids: links,
        });
      }
    }
  }
  return [...byCriterion.values()];
}

/** Rank item statuses so the strongest machine fact wins when several items
 *  reference the same criterion. */
function strongestStatus(
  left: Exclude<ContractItemStatus, "pending"> | undefined,
  right: Exclude<ContractItemStatus, "pending">,
): Exclude<ContractItemStatus, "pending"> {
  const rank: Record<Exclude<ContractItemStatus, "pending">, number> = {
    contradicted: 3,
    verified: 2,
    insufficient: 1,
  };
  if (!left) return right;
  return rank[right] > rank[left] ? right : left;
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
