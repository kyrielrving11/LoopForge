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
import type { CommittedRoundView } from "./committed-round.js";
import type { ContractItemStatusView } from "./contract-items.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { CommandEvidencePolicy } from "./policy.js";
import type { ContractItemStatus, ContractTransition, ExecutionReport } from "./protocol.js";
import type { ActiveContractView } from "./round-contract.js";
export interface RoundFacts {
    /** The contract the NEXT round executes under — derived from committed
     *  rounds only, so a retry / resume / backtrack compile keeps showing it. */
    activeContract: ActiveContractView | null;
    /** Per-item status of `activeContract`. */
    itemStatuses: ContractItemStatusView;
    /** v3.8.1: the machine fact about each criterion a contract item referenced,
     *  over the WHOLE committed history. */
    criterionFacts: CriterionMachineFact[];
}
/** v3.8.1: ONE criterion's machine fact. `status` is absent while every item
 *  referencing the criterion is still `pending` — "no claim yet" says nothing
 *  about the criterion, so the criterion keeps its claim-derived status.
 *
 *  v4.0.3: `status_at_round` is the round the CURRENT status was first
 *  reached (not the claim round). It is a machine fact, so a later
 *  verification can supersede an earlier contradiction. */
export interface CriterionMachineFact {
    criterion_id: string;
    status?: Exclude<ContractItemStatus, "pending">;
    status_at_round?: number;
}
/** The in-flight slice of a round that is being decided but is not yet
 *  committed. A pure committed-history replay passes null / [] — the reducer
 *  then sees committed facts only, which is exactly what the compile path
 *  wants. */
export interface InFlightRoundSlice {
    currentReport: ExecutionReport | null;
    currentDeltas: ReadonlyArray<ObservationDelta>;
    /** The in-flight round's own blocked declaration. A `blocked` round CLOSES
     *  its contract, so closure cannot be derived from committed slices alone. */
    currentBlocked?: boolean;
    /** v3.9.9: the in-flight round's explicit contract redirect. */
    currentTransition?: ContractTransition | null;
    /** Legacy shape accepted by library callers; `blocked` wins when present. */
    currentOutcome?: string | null;
}
export declare const NO_IN_FLIGHT_ROUND: InFlightRoundSlice;
export declare function deriveRoundFacts(input: {
    /** `derivationRounds(entries, currentRound)` — the shared window. */
    rounds: ReadonlyArray<CommittedRoundView>;
    currentRound: number;
    inFlight: InFlightRoundSlice;
    commands: ReadonlyArray<CommandEvidencePolicy>;
}): RoundFacts;
/** v3.8.1/v4.0.3: criterion → machine status, derived over the WHOLE committed
 *  history exactly like the contract walk.
 *
 *  Within one round the strongest item fact wins (contradicted > verified >
 *  insufficient); a `pending` item contributes nothing. Across rounds the
 *  LATEST authoritative fact wins: a later `verified` or `contradicted` may
 *  supersede an earlier one (so a contradiction can be re-verified), while an
 *  `insufficient` round never erases an existing verified/contradicted fact.
 *  `status_at_round` records when the current status was first reached. */
export declare function deriveCriterionFacts(input: {
    rounds: ReadonlyArray<CommittedRoundView>;
    commands: ReadonlyArray<CommandEvidencePolicy>;
}): CriterionMachineFact[];
//# sourceMappingURL=round-facts.d.ts.map