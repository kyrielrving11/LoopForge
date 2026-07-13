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

type MutableMetrics = Omit<
  PolicyMetricsSnapshot,
  "acceptanceRate" | "evidenceAvailabilityRate" | "strategyEffectiveness"
> & {
  strategyEffectiveness: Record<string, {
    attempts: number;
    successes: number;
    rejections: number;
  }>;
};

function empty(loopId?: string): MutableMetrics {
  return {
    loopId,
    roundAttempts: 0,
    committedRounds: 0,
    rejectedAttempts: 0,
    terminatedRounds: 0,
    stoppedRounds: 0,
    replayedTransactions: 0,
    successfulRounds: 0,
    contradictedRounds: 0,
    verificationFlags: {},
    enforcementReasons: {},
    evidenceOutcomesByProvider: {},
    evidenceCaptures: 0,
    evidenceAvailable: 0,
    evidenceUnavailable: 0,
    evidenceFailures: 0,
    evidenceTimeouts: 0,
    evidenceLatencyMs: 0,
    levels: {},
    strategyEffectiveness: {},
  };
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

export class PolicyMetricsCollector {
  private readonly loops = new Map<string, MutableMetrics>();
  private aggregate = empty();

  private targets(loopId?: string): MutableMetrics[] {
    if (!loopId) return [this.aggregate];
    let metric = this.loops.get(loopId);
    if (!metric) {
      metric = empty(loopId);
      this.loops.set(loopId, metric);
    }
    return [this.aggregate, metric];
  }

  recordRound(loopId: string, result: RoundProcessResult, replayed = false): void {
    for (const metric of this.targets(loopId)) {
      if (replayed) {
        metric.replayedTransactions++;
        continue;
      }
      metric.roundAttempts++;
      if (result.action === "reject") metric.rejectedAttempts++;
      else metric.committedRounds++;
      if (result.action === "terminate") metric.terminatedRounds++;
      if (result.action === "stop") metric.stoppedRounds++;
      if (result.roundSuccess) metric.successfulRounds++;
      if (result.gateContradicted) metric.contradictedRounds++;
      for (const flag of result.verificationFlags) {
        increment(metric.verificationFlags, flag.check);
      }
      if (result.enforcementReason) {
        increment(metric.enforcementReasons, result.enforcementReason);
      }
    }
  }

  recordEvidence(
    provider: string,
    outcome: "available" | "unavailable" | "failure" | "timeout",
    latencyMs: number,
    loopId?: string,
  ): void {
    for (const metric of this.targets(loopId)) {
      metric.evidenceCaptures++;
      metric.evidenceLatencyMs += Math.max(0, latencyMs);
      if (outcome === "available") metric.evidenceAvailable++;
      if (outcome === "unavailable") metric.evidenceUnavailable++;
      if (outcome === "failure") metric.evidenceFailures++;
      if (outcome === "timeout") metric.evidenceTimeouts++;
      increment(metric.evidenceOutcomesByProvider, `${provider}:${outcome}`);
    }
  }

  recordStrategy(loopId: string, level?: string): void {
    for (const metric of this.targets(loopId)) {
      if (level) increment(metric.levels, level);
    }
  }

  recordStrategyOutcome(
    loopId: string,
    level: string | undefined,
    result: RoundProcessResult,
    replayed = false,
  ): void {
    if (replayed) return;
    const key = level ?? "unknown";
    for (const metric of this.targets(loopId)) {
      const current = metric.strategyEffectiveness[key] ?? {
        attempts: 0,
        successes: 0,
        rejections: 0,
      };
      current.attempts++;
      if (result.roundSuccess && result.action !== "reject") current.successes++;
      if (result.action === "reject") current.rejections++;
      metric.strategyEffectiveness[key] = current;
    }
  }

  snapshot(loopId?: string): PolicyMetricsSnapshot {
    const source = loopId ? this.loops.get(loopId) ?? empty(loopId) : this.aggregate;
    const attempts = source.roundAttempts;
    const evidence = source.evidenceCaptures;
    const strategyEffectiveness: PolicyMetricsSnapshot["strategyEffectiveness"] = {};
    for (const [key, value] of Object.entries(source.strategyEffectiveness)) {
      strategyEffectiveness[key] = {
        ...value,
        successRate: value.attempts === 0 ? 0 : value.successes / value.attempts,
      };
    }
    return {
      ...source,
      verificationFlags: { ...source.verificationFlags },
      enforcementReasons: { ...source.enforcementReasons },
      evidenceOutcomesByProvider: { ...source.evidenceOutcomesByProvider },
      levels: { ...source.levels },
      strategyEffectiveness,
      acceptanceRate: attempts === 0 ? 0 : source.committedRounds / attempts,
      evidenceAvailabilityRate: evidence === 0 ? 0 : source.evidenceAvailable / evidence,
    };
  }

  reset(loopId?: string): void {
    if (loopId) {
      this.loops.delete(loopId);
      return;
    }
    this.loops.clear();
    this.aggregate = empty();
  }
}

export const policyMetrics = new PolicyMetricsCollector();

export function getPolicyMetrics(loopId?: string): PolicyMetricsSnapshot {
  return policyMetrics.snapshot(loopId);
}

export function resetPolicyMetrics(loopId?: string): void {
  policyMetrics.reset(loopId);
}
