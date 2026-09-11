/** Round Contract item status — the v3.8 verification skeleton.
 *
 *  A contract declares ITEMS; each item binds evidence commands. The agent
 *  may only CLAIM `met` / `remaining`; whether an item is `verified`,
 *  `contradicted`, or `insufficient` is derived here from committed
 *  observations and the in-flight round. Nothing in this module writes state:
 *  it is a pure function of the committed round views, the current report,
 *  the current observations, and policy.
 */
import type { ContractItemStatus, ExecutionReport, MachineObservation } from "./protocol.js";
import type { ActiveContractView } from "./round-contract.js";
import type { CommittedRoundView } from "./committed-round.js";
import type { CommandEvidencePolicy } from "./policy.js";
export interface ItemStatusHistoryEntry {
    round: number;
    status: ContractItemStatus;
    refs: string[];
}
export interface ItemStatusRecord {
    itemId: string;
    description: string;
    status: ContractItemStatus;
    /** Round the current status was first reached. */
    status_at_round: number | null;
    history: ItemStatusHistoryEntry[];
    reasons: string[];
}
export interface ContractItemStatusView {
    contractId: string;
    closure: "open" | "verified" | "blocked";
    closed_at_round: number | null;
    items: ItemStatusRecord[];
    verifiedCount: number;
    contradictedCount: number;
    insufficientCount: number;
}
export interface ContractItemInput {
    contract: ActiveContractView | null;
    /** Committed rounds below `currentRound`, ascending, rollback-excluded. */
    rounds: ReadonlyArray<CommittedRoundView>;
    currentRound: number;
    currentReport: ExecutionReport | null;
    currentObservations: ReadonlyArray<MachineObservation>;
    /** The in-flight round's own effective outcome. A `blocked` round CLOSES its
     *  contract, so the closure cannot be derived from the committed slices
     *  alone — the round being decided is not committed yet. Leave null where no
     *  in-flight round exists (a pure committed-history replay). */
    currentOutcome?: string | null;
    commands: ReadonlyArray<CommandEvidencePolicy>;
}
/** v3.8: Derive every item's status plus the contract's closure. */
export declare function deriveContractItemStatuses(input: ContractItemInput): ContractItemStatusView;
/** v3.8: The round-level verification posture. */
export declare function roundVerificationStatus(view: ContractItemStatusView, report: ExecutionReport | null): "trusted" | "insufficient" | "contradicted";
//# sourceMappingURL=contract-items.d.ts.map