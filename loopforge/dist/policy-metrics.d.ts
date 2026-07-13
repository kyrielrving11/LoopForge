/** In-process policy effectiveness metrics with no runtime dependency. */
import type { RoundProcessResult } from "./round-coordinator.js";
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
    recordStrategy(loopId: string, level?: string): void;
    recordStrategyOutcome(loopId: string, level: string | undefined, result: RoundProcessResult, replayed?: boolean): void;
    snapshot(loopId?: string): PolicyMetricsSnapshot;
    reset(loopId?: string): void;
}
export declare const policyMetrics: PolicyMetricsCollector;
export declare function getPolicyMetrics(loopId?: string): PolicyMetricsSnapshot;
export declare function resetPolicyMetrics(loopId?: string): void;
//# sourceMappingURL=policy-metrics.d.ts.map