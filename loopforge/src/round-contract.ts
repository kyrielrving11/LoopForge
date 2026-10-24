/** Round Contract derivation — the ACTIVE contract a round executes under.
 *
 *  v3.9.5 semantics: `work_item` is the bounded deliverable this slice
 *  produces (an outcome, not an activity); `items[]` are acceptance
 *  conditions inside that slice; each item binds its own `verify_with`
 *  commands. The contract is verified only when every item is verified, so
 *  there is no work_item-level claim. A command may back several conditions.
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
 *  identity and the item ids the agent already cited. `rci-` is deliberately
 *  independent of `work_item`/`scope`, which stay slice-level labels. This is
 *  the opposite of a SubGoal, whose id includes its declaration round.
 */

import type {
  ContractItemProposal,
  ContractTransition,
  ExecutionReport,
  RoundContractProposal,
} from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { CommittedRoundView } from "./committed-round.js";
import type { CommandEvidencePolicy } from "./policy.js";
import {
  canonicalContractItemText,
  canonicalContractText,
  deriveContractId,
  deriveContractItemIds,
} from "./token-utils.js";
import { deriveContractItemStatuses } from "./contract-items.js";
import type { ContractItemStatusView } from "./contract-items.js";
import { getPolicy } from "./policy.js";
import { declaresBlocked } from "./round-outcome.js";

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
  /** The bounded deliverable label. Optional only for legacy committed
   *  contracts; new declarations require it at the strict boundary. */
  work_item?: string;
  /** Report-only intended files/directories for this slice. It grants no
   *  permission and is never enforced; drift is an info fact. */
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
    scope: [...(proposal.scope ?? [])],
    items: proposal.items.map((item, index) => ({
      description: item.description,
      criterion_refs: [...item.criterion_refs],
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

/** v3.9.9: the ONE current-round fact bundle for contract derivations. Every
 *  caller passes report/deltas/blocked/transition together, so a consumer can
 *  no longer forget `stop_reason: "blocked"` or the transition while another
 *  consumer sees them. */
export interface CurrentRoundFacts {
  report: ExecutionReport | null;
  deltas: ReadonlyArray<ObservationDelta>;
  /** The round's ONE blocked declaration (outcome OR stop_reason). */
  blocked: boolean;
  /** The round's explicit contract redirect, if it declared one. */
  transition: ContractTransition | null;
}

export const NO_CURRENT_ROUND_FACTS: CurrentRoundFacts = {
  report: null,
  deltas: [],
  blocked: false,
  transition: null,
};

/** Read a committed view's current-round facts. Read views (audit/explain/
 *  receipt/round-facts) use this instead of hand-building `outcome`-only
 *  blocked flags. */
export function committedRoundFacts(view: CommittedRoundView): CurrentRoundFacts {
  return {
    report: view.executionReport,
    deltas: view.observationDelta,
    blocked: view.evaluation
      ? declaresBlocked(view.evaluation)
      : view.outcome === "blocked",
    transition: view.contractTransition,
  };
}

/** The successor's acceptance CONTENT must actually change. A new work_item
 *  or scope label alone is not a new slice. */
function acceptanceItemsDiffer(
  proposal: RoundContractProposal,
  active: ActiveContractView,
): boolean {
  const next = new Set(proposal.items.map((item) =>
    canonicalContractItemText(item)));
  const current = new Set(active.items.map((item) =>
    canonicalContractItemText(item)));
  if (next.size !== current.size) return true;
  for (const identity of next) {
    if (!current.has(identity)) return true;
  }
  return false;
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
    // The round's item closure under the same reducer every other consumer
    // uses. The current slice is this committed round's own facts, so a
    // blocked/superseded closure is attributed to the round that caused it.
    const statuses = deriveContractItemStatuses({
      contract: active,
      rounds: rounds.slice(0, index),
      currentRound: round.round,
      currentReport: round.executionReport,
      currentDeltas: round.observationDelta,
      currentBlocked: round.evaluation
        ? declaresBlocked(round.evaluation)
        : round.outcome === "blocked",
      currentTransition: round.contractTransition,
      commands,
    });
    if (statuses.closure === "blocked" || statuses.closure === "verified") {
      active = activate();
      continue;
    }
    if (statuses.closure === "superseded") {
      // The reducer already matched the transition target to THIS contract.
      // Activate only a real successor with different acceptance content;
      // abnormal data keeps the original active contract rather than losing it.
      if (proposal && acceptanceItemsDiffer(proposal, active)) {
        active = activate();
      }
      continue;
    }
    // Otherwise the active contract stays; a different proposal is ignored.
  }
  return active;
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
 *  - The round's own report and deltas enter as the in-flight slice, so its
 *    claims and its bound commands are judged with the same reducer the
 *    coordinator uses before the round commits. */
export function deriveRoundContractView(input: {
  /** Committed rounds (rollback-excluded), ascending. */
  rounds: ReadonlyArray<CommittedRoundView>;
  round: number;
  /** The single bundle for the round being evaluated. */
  current: CurrentRoundFacts;
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
      currentReport: input.current.report,
      currentDeltas: input.current.deltas,
      currentBlocked: input.current.blocked,
      currentTransition: input.current.transition,
      commands: input.commands,
    }),
  };
}
