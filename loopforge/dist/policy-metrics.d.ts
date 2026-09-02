/** In-process policy effectiveness metrics with no runtime dependency. */
import type { RoundProcessResult } from "./round-coordinator.js";
import type { VaultEntry } from "./loop-store.js";
export interface PolicyMetricsSnapshot {
    loopId?: string;
    roundAttempts: number;
    committedRounds: number;
    rejectedAttempts: number;
    terminatedRounds: number;
    stoppedRounds: number;
    replayedTransactions: number;
    successfulRounds: number;
    contradictedRounds: number;
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
    strategyEffectiveness: Record<string, {
        attempts: number;
        successes: number;
        rejections: number;
        successRate: number;
    }>;
    acceptanceRate: number;
    evidenceAvailabilityRate: number;
}
export declare class PolicyMetricsCollector {
    private readonly loops;
    private aggregate;
    private targets;
    recordRound(loopId: string, result: RoundProcessResult, replayed?: boolean): void;
    recordEvidence(provider: string, outcome: "available" | "unavailable" | "failure" | "timeout", latencyMs: number, loopId?: string): void;
    /** Record a vault write failure. The reason distinguishes feedback_persist,
     *  lineage_persist, and delegation_persist so operators can identify which
     *  write path is failing. */
    recordVaultWriteError(reason: string, loopId?: string): void;
    recordStrategy(loopId: string, level?: string): void;
    recordStrategyOutcome(loopId: string, level: string | undefined, result: RoundProcessResult, replayed?: boolean): void;
    snapshot(loopId?: string): PolicyMetricsSnapshot;
    reset(loopId?: string): void;
}
/** v2.12: Derive a metrics snapshot from durable vault entries (3.x A4 port).
 *  Committed round decisions, verification flags, and prompt levels are
 *  replayed into the same counters the live collector maintains, so a
 *  restarted process reports nonzero metrics for persisted loops. */
export declare function derivePolicyMetrics(loopId: string, entries: VaultEntry[]): PolicyMetricsSnapshot;
/** v2.12: Fold live in-process observations over a vault-derived snapshot
 *  without double-counting committed rounds — the derived snapshot already
 *  includes rounds this process committed. Only non-durable fields are
 *  overlaid: evidence captures, vault write errors, replays, rejections. */
export declare function mergePolicyMetrics(derived: PolicyMetricsSnapshot, live: PolicyMetricsSnapshot): PolicyMetricsSnapshot;
export declare const policyMetrics: PolicyMetricsCollector;
export declare function getPolicyMetrics(loopId?: string): PolicyMetricsSnapshot;
export declare function resetPolicyMetrics(loopId?: string): void;
//# sourceMappingURL=policy-metrics.d.ts.map