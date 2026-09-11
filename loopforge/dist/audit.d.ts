/** v2.12: Read-only, replayable end-of-loop audit — the verification view.
 *
 *  Positioning vs loopforge_replay: replay is the factual timeline (what
 *  happened per round); audit is the assessment layer (which claims are
 *  machine-verified, which gates were decided, is the sequence intact).
 *  Everything is derived from committed vault entries — audit never writes.
 *
 *  v3.8: the CONTRACT ITEM axis is the primary completion basis. The criterion
 *  claims stay as an advisory second view — a criterion claim is an agent
 *  statement whose machine backing is mediated by the contract items, so it
 *  cannot be the completion signal. Both axes read the same committed-round
 *  model and the same item reducer the coordinator and explain use.
 */
import type { LoopStore } from "./loop-store.js";
import type { VaultEntry } from "./loop-store.js";
import type { ContractItemStatus } from "./protocol.js";
export interface AuditRound {
    round: number;
    outcome: string;
    claims: Array<{
        text: string;
        status: "verified" | "unverified";
    }>;
    checks: Array<{
        check: string;
        severity: string;
        verdict: "failed" | "warn" | "info";
    }>;
    /** v3.8: the contract this round EXECUTED under and each item's status as of
     *  this round — the same derivation `explain` renders. */
    contract: {
        id: string;
        declared_at_round: number;
        closure: string;
        items: Array<{
            itemId: string;
            status: ContractItemStatus;
        }>;
    } | null;
}
export interface AuditGate {
    gateId: string;
    kind: "user" | "agent";
    actionHash: string;
    approved: boolean;
    decidedAt: string;
    round: number;
}
/** v3.8: One contract's outcome over the loaned loop, keyed by its content-
 *  addressed id. Re-declaring the same contract later extends the same entry —
 *  the identity says it IS the same contract. */
export interface AuditContract {
    contract_id: string;
    declared_at_round: number;
    first_active_round: number;
    last_active_round: number;
    closure: "open" | "verified" | "blocked";
    closed_at_round: number | null;
    /** Item statuses as of the last round the contract was execution-relevant. */
    items: Array<{
        itemId: string;
        description: string;
        status: ContractItemStatus;
    }>;
}
export interface AuditContractSummary {
    contracts: AuditContract[];
    /** Contracts whose final closure is still `open`. */
    open: number;
    verifiedItems: number;
    insufficientItems: number;
    contradictedItems: number;
    pendingItems: number;
}
export interface AuditResult {
    loopId: string;
    verdict: "passed" | "incomplete" | "contradicted";
    rounds: AuditRound[];
    gates: AuditGate[];
    unresolvedUserGates: string[];
    /** v3.8: the verification skeleton — the primary completion basis. */
    contracts: AuditContractSummary;
    /** Advisory second axis: criterion claims, not the completion signal.
     *  `declared` and `evidenced` are both DISTINCT-id counts, so they compare. */
    criteria: {
        declared: number;
        evidenced: number;
        missing: number;
    };
    sequenceComplete: boolean;
    /** False when no LoopStore was provided (sequence/provenance degraded). */
    provenanceAvailable: boolean;
    /** v3.8: rounds whose persisted transaction carries a legacy schema
     *  version. They are NOT part of history (the version break is hard) — this
     *  list makes the loss visible instead of letting the loop look complete. */
    legacyRounds: number[];
}
/** Build the audit from committed vault entries. Pure, read-only.
 *  @param store Optional LoopStore — when provided, sequence integrity is
 *  checked and provenanceAvailable becomes true. */
export declare function buildAudit(loopId: string, entries: VaultEntry[], store?: LoopStore): AuditResult;
//# sourceMappingURL=audit.d.ts.map