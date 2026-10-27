/** In-process policy effectiveness metrics with no runtime dependency.
 *
 *  v4.0.3: Agent claims and machine-backed success are separate counters.
 *  Evidence posture counts come from the persisted posture, never from a
 *  read-time re-derivation. Git file/head facts use the shared union selector.
 */
import type { RoundProcessResult } from "./round-coordinator.js";
import type { VaultEntry } from "./loop-store.js";
import type { EvidencePostureStatus, FilesReconciliation, ObservationStatus } from "./protocol.js";
export interface PolicyMetricsSnapshot {
    loopId?: string;
    roundAttempts: number;
    committedRounds: number;
    rejectedAttempts: number;
    terminatedRounds: number;
    stoppedRounds: number;
    replayedTransactions: number;
    /** Rounds whose Agent-declared outcome is `success` (claim only). */
    agentClaimedSuccessRounds: number;
    /** Rounds whose persisted posture has machineBackedSuccess=true. */
    machineBackedSuccessRounds: number;
    /** Rounds whose verification gate verdict was `contradicted`. */
    gateContradictedRounds: number;
    /** Per-status counts from the committed posture. */
    evidenceStatusCounts: Record<EvidencePostureStatus, number>;
    /** Per-status counts of after-phase observations. */
    observationStatusCounts: Record<ObservationStatus, number>;
    verificationFlags: Record<string, number>;
    enforcementReasons: Record<string, number>;
    evidenceOutcomesByProvider: Record<string, number>;
    evidenceCaptures: number;
    evidenceAvailable: number;
    evidenceUnavailable: number;
    evidenceFailures: number;
    evidenceTimeouts: number;
    evidenceLatencyMs: number;
    evidenceLatencyAvgMs: number;
    /** Persistence errors — vault writes that failed silently. */
    vaultWriteErrors: number;
    /** Per-reason breakdown of persistence failures. */
    vaultWriteReasons: Record<string, number>;
    levels: Record<string, number>;
    /** v3.9.1: file-delta / Git boundary counts, all derived from the shared
     *  round delta. Display only — never a gate. */
    filesChangedRounds: number;
    filesChangedTotal: number;
    /** v4.0.3: rounds whose persisted workspace boundary is `unknown`. */
    workspaceUnknownRounds: number;
    headMoveRounds: number;
    /** Optional-field counts (core fields excluded). */
    attemptedFieldUsage: Record<string, number>;
    retainedFieldUsage: Record<string, number>;
    fieldAccountingRounds: number;
    fieldAccountingIncompleteRounds: number;
    /** v3.9.2: read-only file-report reconciliation counts. */
    filesReconciliation: Record<FilesReconciliation["status"], number>;
    acceptanceRate: number;
    evidenceAvailabilityRate: number;
}
export declare class PolicyMetricsCollector {
    private readonly loops;
    private aggregate;
    private targets;
    recordRound(loopId: string, result: RoundProcessResult, replayed?: boolean): void;
    recordEvidence(provider: string, outcome: "available" | "unavailable" | "failure" | "timeout", latencyMs: number, loopId?: string): void;
    recordVaultWriteError(reason: string, loopId?: string): void;
    recordStrategy(loopId: string, level?: string): void;
    snapshot(loopId?: string): PolicyMetricsSnapshot;
    reset(loopId?: string): void;
}
/** v2.12: Derive a metrics snapshot from durable vault entries. Committed
 *  round decisions, verification flags and prompt levels are replayed into the
 *  same counters the live collector maintains. */
export declare function derivePolicyMetrics(loopId: string, entries: VaultEntry[]): PolicyMetricsSnapshot;
/** v2.12: Fold live in-process observations over a vault-derived snapshot
 *  without double-counting committed rounds. Only non-durable fields are
 *  overlaid: evidence captures, vault write errors, replays, rejections. */
export declare function mergePolicyMetrics(derived: PolicyMetricsSnapshot, live: PolicyMetricsSnapshot): PolicyMetricsSnapshot;
export declare const policyMetrics: PolicyMetricsCollector;
export declare function getPolicyMetrics(loopId?: string): PolicyMetricsSnapshot;
export declare function resetPolicyMetrics(loopId?: string): void;
//# sourceMappingURL=policy-metrics.d.ts.map