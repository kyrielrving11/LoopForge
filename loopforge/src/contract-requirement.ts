/** v4.0.6: contract coverage — the ONE shared requirement derivation.
 *
 *  A round that continues with contract capability must leave an ACTIVE
 *  contract for the next round. This module answers only that structural
 *  question: does the next round have a contract, and where does the current
 *  proposal leave it? It never judges whether the slice is a real
 *  deliverable, whether an item is a good acceptance condition, or whether a
 *  command is the right test.
 *
 *  It is a PURE function of facts the caller already derived — it reads no
 *  store, no session and no policy global. The compile-time caller, the
 *  pre-advance submission boundary and the post-evidence coordinator all pass
 *  the same facts through this one rule, so they cannot disagree about
 *  whether a contract was required.
 *
 *  The active contract is the one derived from committed rounds
 *  (`ActiveContractView`); `closure` is the item reducer's verdict for the
 *  round being decided (or `"open"` before evidence exists).
 */

import type { ContractItemStatusView } from "./contract-items.js";
import type { ActiveContractView } from "./round-contract.js";

export type ContractRequirementReason =
  | "not_continuing"
  | "blocked"
  | "no_successor_round"
  | "no_contract_capability"
  | "no_active_contract"
  | "active_contract_continues"
  | "active_contract_closed"
  | "satisfied_by_proposal"
  | "satisfied_by_successor";

export interface ContractRequirement {
  /** The next round must have an active contract when this round commits. */
  required: boolean;
  reason: ContractRequirementReason;
  activeContractId: string | null;
}

export interface ContractRequirementInput {
  shouldContinue: boolean;
  /** The round declares `outcome: "blocked"`. Defensive: blocked normally
   *  also means `shouldContinue === false`. */
  blocked: boolean;
  /** `round_contract` is present in this submission. */
  proposalPresent: boolean;
  activeContract: ActiveContractView | null;
  /** The active contract's closure for the round being decided. */
  closure: ContractItemStatusView["closure"];
  /** At least one enabled, after-capable evidence command exists. Without it
   *  no contract can ever be machine-verified, so no contract is required. */
  contractCapability: boolean;
  /** Whether the state machine permits another round after this submission.
   *  A terminal max-round boundary has no consumer for a proposal. */
  successorRoundAvailable?: boolean;
}

export function deriveContractRequirement(
  input: ContractRequirementInput,
): ContractRequirement {
  const activeContractId = input.activeContract?.id ?? null;
  if (!input.shouldContinue) {
    return { required: false, reason: "not_continuing", activeContractId };
  }
  if (input.blocked) {
    return { required: false, reason: "blocked", activeContractId };
  }
  if (!input.contractCapability) {
    return { required: false, reason: "no_contract_capability", activeContractId };
  }
  if (input.successorRoundAvailable === false) {
    return { required: false, reason: "no_successor_round", activeContractId };
  }
  if (!input.activeContract) {
    return input.proposalPresent
      ? { required: false, reason: "satisfied_by_proposal", activeContractId }
      : { required: true, reason: "no_active_contract", activeContractId };
  }
  if (input.closure === "open") {
    // Omitting the proposal continues the same contract. A different proposal
    // is a separate structural question (`contract_premature`); coverage
    // itself is already satisfied by the continuing contract.
    return { required: false, reason: "active_contract_continues", activeContractId };
  }
  // verified / superseded / blocked: the current contract will not govern the
  // next round, so a successor proposal must be present.
  return input.proposalPresent
    ? { required: false, reason: "satisfied_by_successor", activeContractId }
    : { required: true, reason: "active_contract_closed", activeContractId };
}
