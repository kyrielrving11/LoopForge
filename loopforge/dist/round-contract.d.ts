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
import type { ContractItemProposal, ContractTransition, ExecutionReport, RoundContractProposal } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { CommittedRoundView } from "./committed-round.js";
import type { CommandEvidencePolicy } from "./policy.js";
import type { ContractItemStatusView } from "./contract-items.js";
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
export declare function activateContract(proposal: RoundContractProposal, declaredAtRound: number, binding: {
    config_hash_by_command: Record<string, string>;
} | null, loopId: string): ActiveContractView;
/** v3.8: Content equality — restating a contract unchanged is the same
 *  contract. Never compare by id (8 hex = 32 bits; a collision must not merge
 *  two different contracts). */
export declare function sameContract(left: RoundContractProposal, right: RoundContractProposal): boolean;
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
export declare const NO_CURRENT_ROUND_FACTS: CurrentRoundFacts;
/** Read a committed view's current-round facts. Read views (audit/explain/
 *  receipt/round-facts) use this instead of hand-building `outcome`-only
 *  blocked flags. */
export declare function committedRoundFacts(view: CommittedRoundView): CurrentRoundFacts;
/** v3.8: The active contract after replaying committed rounds in order. */
export declare function deriveActiveRoundContract(rounds: ReadonlyArray<CommittedRoundView>, commands?: ReadonlyArray<CommandEvidencePolicy>): ActiveContractView | null;
/** v3.8: Every criterion id referenced by the contract's items. */
export declare function contractCriterionIds(contract: ActiveContractView): string[];
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
export declare function deriveRoundContractView(input: {
    /** Committed rounds (rollback-excluded), ascending. */
    rounds: ReadonlyArray<CommittedRoundView>;
    round: number;
    /** The single bundle for the round being evaluated. */
    current: CurrentRoundFacts;
    commands: ReadonlyArray<CommandEvidencePolicy>;
}): {
    contract: ActiveContractView | null;
    statuses: ContractItemStatusView;
};
//# sourceMappingURL=round-contract.d.ts.map