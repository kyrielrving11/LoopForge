/** v2.12/v4.0.3: Read-only, replayable end-of-loop audit — the verification
 *  view.
 *
 *  Positioning vs loopforge_replay: replay is the factual timeline (what
 *  happened per round); audit is the assessment layer (which claims are
 *  machine-verified, which gates were decided, is the sequence intact).
 *  Everything is derived from committed vault entries — audit never writes.
 *
 *  v4.0.3: every round reports the SAME persisted evidence posture. A claim is
 *  `verified` only when a machine criterion fact backs its criterion; Agent
 *  reports never upgrade themselves. `evidenceVerdict` is the terminal
 *  posture, while `verdict` is the verification view over structure + posture.
 */
import type { LoopStore } from "./loop-store.js";
import type { VaultEntry } from "./loop-store.js";
import type { ContractItemStatus, EvidencePosture, EvidencePostureStatus, FilesReconciliation, SubmissionDiagnostic } from "./protocol.js";
import type { SubmissionReceipt } from "./protocol.js";
export interface AuditRound {
    round: number;
    /** v4.0.3: Agent claim; never a machine verdict. */
    agentSuccessClaim: boolean;
    agentOutcome: string;
    machineBackedSuccess: boolean;
    evidencePosture: EvidencePosture | null;
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
    /** v4.0.3: committed recovery material that history can still discover. */
    checkpoints: Array<{
        checkpoint_id: string;
        role: "before" | "mid";
        round: number;
        content_hash: string;
    }>;
    restore: {
        directive_transaction_id: string;
        redo_round: number;
        verified_at: number;
    } | null;
    restore_verified: boolean;
    /** v3.9.1/v4.0.3: compact submission accounting. */
    submission: {
        record: SubmissionReceipt["record"];
        entered_history: boolean;
        diagnostics: SubmissionDiagnostic[];
        saved_not_expanded: string[];
        effects: SubmissionReceipt["effects"];
        verification: {
            evidence_posture: EvidencePosture;
            checks: SubmissionReceipt["verification"]["checks"];
        };
        files_reconciliation: FilesReconciliation;
        recovery_checkpoint: SubmissionReceipt["recovery_checkpoint"] | null;
        prompt: {
            level: string;
            dropped_sections: string[];
        } | null;
    };
}
export interface AuditGate {
    gateId: string;
    kind: "user" | "agent";
    actionHash: string;
    approved: boolean;
    decidedAt: string;
    round: number;
}
/** v3.8: One contract's outcome over the loop, keyed by its content-addressed
 *  id. Re-declaring the same contract later extends the same entry — the
 *  identity says it IS the same contract. */
export interface AuditContract {
    contract_id: string;
    declared_at_round: number;
    first_active_round: number;
    last_active_round: number;
    closure: "open" | "verified" | "blocked" | "superseded";
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
    /** v3.9.9: contracts the Agent explicitly abandoned via a transition. */
    superseded: number;
    verifiedItems: number;
    insufficientItems: number;
    contradictedItems: number;
    pendingItems: number;
}
export interface AuditResult {
    loopId: string;
    /** Verification-view verdict: `passed` requires the structure to be intact
     *  AND the terminal evidence posture to be verified/not_applicable. */
    verdict: "passed" | "incomplete" | "contradicted";
    /** v4.0.3: the terminal posture itself, unmodified. */
    evidenceVerdict: EvidencePostureStatus | null;
    rounds: AuditRound[];
    /** v3.9.6: committed rollback directives — events, never normal rounds. */
    rollbacks: Array<{
        round: number;
        transactionId: string;
        origin: "agent" | "machine";
        redoRound: number;
        targetCheckpointId: string;
        reason: string;
        observedSkippedFiles: string[];
        reportedSkippedFiles: string[];
        skippedFiles: string[];
        abandonedRounds: number[];
        failedRounds: number[];
        /** v4.0.3: Agent reports preserved by the rollback. */
        preservedDiscoveries: string[];
        approaches: string[];
        wrongAssumptions: string[];
    }>;
    gates: AuditGate[];
    unresolvedUserGates: string[];
    /** v3.8: the verification skeleton — the primary completion basis. */
    contracts: AuditContractSummary;
    /** Advisory second axis: criterion claims, not the completion signal.
     *  `declared` comes from the immutable operator objective; `evidenced` is the
     *  machine-verified set. Both are distinct-id counts. */
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