/** In-process policy effectiveness metrics with no runtime dependency. */
import { derivationRounds } from "./committed-round.js";
function empty(loopId) {
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
        vaultWriteErrors: 0,
        vaultWriteReasons: {},
        levels: {},
    };
}
function increment(target, key) {
    target[key] = (target[key] ?? 0) + 1;
}
export class PolicyMetricsCollector {
    loops = new Map();
    aggregate = empty();
    targets(loopId) {
        if (!loopId)
            return [this.aggregate];
        let metric = this.loops.get(loopId);
        if (!metric) {
            metric = empty(loopId);
            this.loops.set(loopId, metric);
        }
        return [this.aggregate, metric];
    }
    recordRound(loopId, result, replayed = false) {
        for (const metric of this.targets(loopId)) {
            if (replayed) {
                metric.replayedTransactions++;
                continue;
            }
            metric.roundAttempts++;
            if (result.action === "reject")
                metric.rejectedAttempts++;
            // v3.3.1: only continue/stop decisions commit a round outcome —
            // terminates never commit (v2.14 invariant) and backtracks are
            // roll-back directives whose redo replaces the round document, so
            // neither may inflate committedRounds/acceptanceRate. This mirrors
            // the vault-derived side, which already excludes backtrack entries.
            else if (result.action === "continue" || result.action === "stop") {
                metric.committedRounds++;
            }
            if (result.action === "terminate")
                metric.terminatedRounds++;
            if (result.action === "stop")
                metric.stoppedRounds++;
            if (result.roundSuccess)
                metric.successfulRounds++;
            if (result.gateContradicted)
                metric.contradictedRounds++;
            for (const flag of result.verificationFlags) {
                increment(metric.verificationFlags, flag.check);
            }
            if (result.enforcementReason) {
                increment(metric.enforcementReasons, result.enforcementReason);
            }
        }
    }
    recordEvidence(provider, outcome, latencyMs, loopId) {
        for (const metric of this.targets(loopId)) {
            metric.evidenceCaptures++;
            metric.evidenceLatencyMs += Math.max(0, latencyMs);
            if (outcome === "available")
                metric.evidenceAvailable++;
            if (outcome === "unavailable")
                metric.evidenceUnavailable++;
            if (outcome === "failure")
                metric.evidenceFailures++;
            if (outcome === "timeout")
                metric.evidenceTimeouts++;
            increment(metric.evidenceOutcomesByProvider, `${provider}:${outcome}`);
        }
    }
    /** Record a vault write failure. The reason distinguishes feedback_persist,
     *  lineage_persist, and delegation_persist so operators can identify which
     *  write path is failing. */
    recordVaultWriteError(reason, loopId) {
        for (const metric of this.targets(loopId)) {
            metric.vaultWriteErrors++;
            increment(metric.vaultWriteReasons, reason);
        }
    }
    recordStrategy(loopId, level) {
        for (const metric of this.targets(loopId)) {
            if (level)
                increment(metric.levels, level);
        }
    }
    snapshot(loopId) {
        const source = loopId ? this.loops.get(loopId) ?? empty(loopId) : this.aggregate;
        return snapshotFrom(source);
    }
    reset(loopId) {
        if (loopId) {
            this.loops.delete(loopId);
            return;
        }
        this.loops.clear();
        this.aggregate = empty();
    }
}
/** Render a mutable counter set as a public snapshot with derived rates. */
function snapshotFrom(source) {
    const attempts = source.roundAttempts;
    const evidence = source.evidenceCaptures;
    return {
        ...source,
        verificationFlags: { ...source.verificationFlags },
        enforcementReasons: { ...source.enforcementReasons },
        evidenceOutcomesByProvider: { ...source.evidenceOutcomesByProvider },
        levels: { ...source.levels },
        acceptanceRate: attempts === 0 ? 0 : source.committedRounds / attempts,
        evidenceAvailabilityRate: evidence === 0 ? 0 : source.evidenceAvailable / evidence,
        // evidenceLatencyMs is a raw sum; derive the average for consumers
        evidenceLatencyAvgMs: evidence === 0 ? 0 : source.evidenceLatencyMs / evidence,
    };
}
/** v2.12: Derive a metrics snapshot from durable vault entries (3.x A4 port).
 *  Committed round decisions, verification flags, and prompt levels are
 *  replayed into the same counters the live collector maintains, so a
 *  restarted process reports nonzero metrics for persisted loops. */
export function derivePolicyMetrics(loopId, entries) {
    const metric = empty(loopId);
    for (const round of derivationRounds(entries)) {
        if (round.loopId !== loopId)
            continue;
        const result = round.result;
        if (!result)
            continue;
        metric.roundAttempts++;
        metric.committedRounds++;
        if (result.action === "stop")
            metric.stoppedRounds++;
        if (result.action === "terminate")
            metric.terminatedRounds++;
        if (result.roundSuccess === true)
            metric.successfulRounds++;
        if (result.gateContradicted === true)
            metric.contradictedRounds++;
        for (const flag of round.verificationFlags) {
            increment(metric.verificationFlags, flag.check);
        }
        if (typeof result.enforcementReason === "string" && result.enforcementReason.length > 0) {
            increment(metric.enforcementReasons, result.enforcementReason);
        }
        if (round.promptArtifact?.level) {
            increment(metric.levels, round.promptArtifact.level);
        }
    }
    return snapshotFrom(metric);
}
/** v2.12: Fold live in-process observations over a vault-derived snapshot
 *  without double-counting committed rounds — the derived snapshot already
 *  includes rounds this process committed. Only non-durable fields are
 *  overlaid: evidence captures, vault write errors, replays, rejections. */
export function mergePolicyMetrics(derived, live) {
    const merged = {
        loopId: derived.loopId,
        // v2.14: attempts = committed rounds (durable, all processes) + this
        // process's uncommitted decisions. Rejects and terminates never commit
        // (round-transaction early-returns), so they exist only in the live
        // snapshot — derived can never see them. Previously roundAttempts came
        // from derived alone, making acceptanceRate read 1.0 after any
        // rejections (3 rejects + 1 commit → 1/1 instead of 1/4).
        roundAttempts: derived.roundAttempts + live.rejectedAttempts + live.terminatedRounds,
        committedRounds: derived.committedRounds,
        rejectedAttempts: live.rejectedAttempts,
        // v2.14: terminates never commit, so derived.terminatedRounds is
        // structurally 0; the live count is the only source. Max keeps the
        // count honest if a future version commits terminal rounds.
        terminatedRounds: Math.max(derived.terminatedRounds, live.terminatedRounds),
        stoppedRounds: derived.stoppedRounds,
        replayedTransactions: live.replayedTransactions,
        successfulRounds: derived.successfulRounds,
        contradictedRounds: derived.contradictedRounds,
        verificationFlags: { ...derived.verificationFlags },
        enforcementReasons: { ...derived.enforcementReasons },
        evidenceOutcomesByProvider: { ...live.evidenceOutcomesByProvider },
        evidenceCaptures: live.evidenceCaptures,
        evidenceAvailable: live.evidenceAvailable,
        evidenceUnavailable: live.evidenceUnavailable,
        evidenceFailures: live.evidenceFailures,
        evidenceTimeouts: live.evidenceTimeouts,
        evidenceLatencyMs: live.evidenceLatencyMs,
        vaultWriteErrors: live.vaultWriteErrors,
        vaultWriteReasons: { ...live.vaultWriteReasons },
        levels: { ...derived.levels },
    };
    return snapshotFrom(merged);
}
export const policyMetrics = new PolicyMetricsCollector();
export function getPolicyMetrics(loopId) {
    return policyMetrics.snapshot(loopId);
}
export function resetPolicyMetrics(loopId) {
    policyMetrics.reset(loopId);
}
//# sourceMappingURL=policy-metrics.js.map