/** Round Contract derivation — the ACTIVE contract a round executes under.
 *
 *  A submission's `round_contract` is a PROPOSAL for the next round. It
 *  becomes ACTIVE only after the declaring round commits; the active contract
 *  is then derived from committed rounds on every compile path (retry,
 *  resume, backtrack). It closes when every item is machine-verified, or when
 *  the agent reports `outcome: "blocked"`; while it is open a different
 *  proposal is ignored.
 *
 *  v3.8 identity: `rc-` / `rci-` are derived from CONTENT ONLY (loop id +
 *  canonical proposal), so restating an unchanged contract keeps the same
 *  identity and the item ids the agent already cited. This is deliberately
 *  the opposite of a SubGoal, whose id includes its declaration round.
 */

import type {
  ContractItemProposal,
  ExecutionReport,
  MachineObservation,
  RoundContractProposal,
} from "./protocol.js";
import type { CommittedRoundView } from "./committed-round.js";
import type { CommandEvidencePolicy } from "./policy.js";
import {
  canonicalContractText,
  deriveContractId,
  deriveContractItemIds,
} from "./token-utils.js";
import { deriveContractItemStatuses } from "./contract-items.js";
import type { ContractItemStatusView } from "./contract-items.js";
import { getPolicy } from "./policy.js";

export interface ActiveContractItem extends ContractItemProposal {
  /** rci-XXXXXXXX — derived from the item's own content. */
  id: string;
}

export interface ActiveContractView {
  /** rc-XXXXXXXX — derived from loopId + canonical proposal content. */
  id: string;
  /** The round that declared the proposal that became active (a fact, not
   *  part of the identity hash). */
  declared_at_round: number;
  work_item?: string;
  scope: string[];
  items: ActiveContractItem[];
  /** The command configuration in force at declaration (machine-stamped at
   *  commit — see ContractBinding). */
  config_hash_by_command: Record<string, string>;
}

/** v3.8: Build the derived active contract from a committed proposal plus the
 *  binding the runtime stamped when that round committed. */
export function activateContract(
  proposal: RoundContractProposal,
  declaredAtRound: number,
  binding: { config_hash_by_command: Record<string, string> } | null,
  loopId: string,
): ActiveContractView {
  const itemIds = deriveContractItemIds(proposal.items);
  return {
    id: deriveContractId(loopId, proposal),
    declared_at_round: declaredAtRound,
    work_item: proposal.work_item,
    scope: [...proposal.scope],
    items: proposal.items.map((item, index) => ({
      description: item.description,
      criterion_refs: [...item.criterion_refs],
      subgoal_refs: [...item.subgoal_refs],
      verify_with: [...item.verify_with],
      id: itemIds[index],
    })),
    config_hash_by_command: { ...(binding?.config_hash_by_command ?? {}) },
  };
}

/** v3.8: Content equality — restating a contract unchanged is the same
 *  contract. Never compare by id (8 hex = 32 bits; a collision must not merge
 *  two different contracts). */
export function sameContract(
  left: RoundContractProposal,
  right: RoundContractProposal,
): boolean {
  return canonicalContractText(left) === canonicalContractText(right);
}

/** v3.8: The active contract after replaying committed rounds in order. */
export function deriveActiveRoundContract(
  rounds: ReadonlyArray<CommittedRoundView>,
  commands: ReadonlyArray<CommandEvidencePolicy> = getPolicy().evidence.commands ?? [],
): ActiveContractView | null {
  let active: ActiveContractView | null = null;
  for (let index = 0; index < rounds.length; index++) {
    const round = rounds[index];
    const proposal = round.contractProposal;
    const activate = (): ActiveContractView | null => proposal
      ? activateContract(proposal, round.round, round.contractBinding, round.loopId)
      : null;

    if (active === null) {
      active = activate();
      continue;
    }
    // A blocked round closes the active contract (existing semantics), and a
    // fully verified one does too. Order matters: blocked is checked first,
    // mirroring the historical walker.
    if (round.outcome === "blocked") {
      active = activate();
      continue;
    }
    const statuses = deriveContractItemStatuses({
      contract: active,
      rounds: rounds.slice(0, index + 1),
      currentRound: round.round + 1,
      currentReport: null,
      currentObservations: [],
      commands,
    });
    if (statuses.closure === "verified") {
      active = activate();
      continue;
    }
    // Otherwise the active contract stays; a different proposal is ignored.
  }
  return active;
}

/** v3.8: Every criterion id referenced by the contract's items. */
export function contractCriterionIds(contract: ActiveContractView): string[] {
  const ids = new Set<string>();
  for (const item of contract.items) {
    for (const ref of item.criterion_refs) {
      if (/^cr-[a-f0-9]{8}$/.test(ref)) ids.add(ref);
    }
  }
  return [...ids];
}

/** v3.8: The contract a round EXECUTED under, plus every item's status as of
 *  that round — the ONE derivation the live coordinator, explain and audit
 *  share, so the three can never disagree about what a round ran under.
 *
 *  Two things make this different from "derive from every round up to and
 *  including this one":
 *
 *  - The executed contract comes from the rounds BEFORE this one. A proposal
 *    declared in round R becomes active in R+1, and a contract round R CLOSES
 *    must still be reported as round R's contract — folding R's own proposal
 *    into the walker would hand the round the successor (or nothing).
 *  - The round's own report and observations enter as the in-flight slice, so
 *    its claims and its bound commands are judged with the same reducer the
 *    coordinator uses before the round commits. */
export function deriveRoundContractView(input: {
  /** Committed rounds (rollback-excluded), ascending. */
  rounds: ReadonlyArray<CommittedRoundView>;
  round: number;
  report: ExecutionReport | null;
  observations: ReadonlyArray<MachineObservation>;
  /** The round's committed/effective outcome — `blocked` closes its contract. */
  outcome: string | null;
  commands: ReadonlyArray<CommandEvidencePolicy>;
}): { contract: ActiveContractView | null; statuses: ContractItemStatusView } {
  const prior = input.rounds.filter((candidate) => candidate.round < input.round);
  const contract = deriveActiveRoundContract(prior, input.commands);
  return {
    contract,
    statuses: deriveContractItemStatuses({
      contract,
      rounds: prior,
      currentRound: input.round,
      currentReport: input.report,
      currentObservations: input.observations,
      currentOutcome: input.outcome,
      commands: input.commands,
    }),
  };
}
