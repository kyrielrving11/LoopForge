/** In-process policy effectiveness metrics with no runtime dependency.
 *
 *  v4.0.3: Agent claims and machine-backed success are separate counters.
 *  Evidence posture counts come from the persisted posture, never from a
 *  read-time re-derivation. Git file/head facts use the shared union selector.
 */

import type { RoundProcessResult } from "./round-coordinator.js";
import type { VaultEntry } from "./loop-store.js";
import { readOnlyRounds } from "./committed-round.js";
import { deriveFieldAccounting } from "./field-accounting.js";
import { deriveFilesReconciliation } from "./files-reconciliation.js";
import { gitRoundFacts } from "./git-facts.js";
import { CORE_SELF_EVALUATION_FIELDS } from "./submission-guidance.js";
import type {
  EvidencePostureStatus,
  FilesReconciliation,
  ObservationStatus,
} from "./protocol.js";

const EVIDENCE_POSTURE_STATUSES: EvidencePostureStatus[] = [
  "verified", "insufficient", "contradicted", "unknown", "not_applicable",
];

const OBSERVATION_STATUSES: ObservationStatus[] = [
  "observed", "passed", "failed", "timeout", "unavailable", "error", "aborted",
];

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

type MutableMetrics = Omit<
  PolicyMetricsSnapshot,
  "acceptanceRate" | "evidenceAvailabilityRate" | "evidenceLatencyAvgMs"
>;

function zeroPostureCounts(): Record<EvidencePostureStatus, number> {
  return {
    verified: 0,
    insufficient: 0,
    contradicted: 0,
    unknown: 0,
    not_applicable: 0,
  };
}

function zeroObservationCounts(): Record<ObservationStatus, number> {
  return {
    observed: 0,
    passed: 0,
    failed: 0,
    timeout: 0,
    unavailable: 0,
    error: 0,
    aborted: 0,
  };
}

function empty(loopId?: string): MutableMetrics {
  return {
    loopId,
    roundAttempts: 0,
    committedRounds: 0,
    rejectedAttempts: 0,
    terminatedRounds: 0,
    stoppedRounds: 0,
    replayedTransactions: 0,
    agentClaimedSuccessRounds: 0,
    machineBackedSuccessRounds: 0,
    gateContradictedRounds: 0,
    evidenceStatusCounts: zeroPostureCounts(),
    observationStatusCounts: zeroObservationCounts(),
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
    filesChangedRounds: 0,
    filesChangedTotal: 0,
    workspaceUnknownRounds: 0,
    headMoveRounds: 0,
    attemptedFieldUsage: {},
    retainedFieldUsage: {},
    fieldAccountingRounds: 0,
    fieldAccountingIncompleteRounds: 0,
    filesReconciliation: {
      match: 0,
      mismatch: 0,
      unknown: 0,
      not_applicable: 0,
    },
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
      // Only continue/stop decisions commit a round outcome — terminates never
      // commit and backtracks are roll-back directives whose redo replaces the
      // round document.
      else if (result.action === "continue" || result.action === "stop") {
        metric.committedRounds++;
      }
      if (result.action === "terminate") metric.terminatedRounds++;
      if (result.action === "stop") metric.stoppedRounds++;
      if (result.agentOutcome === "success") metric.agentClaimedSuccessRounds++;
      if (result.gateContradicted) metric.gateContradictedRounds++;
      const posture = result.evidencePosture;
      if (posture) {
        if (posture.machineBackedSuccess) metric.machineBackedSuccessRounds++;
        increment(metric.evidenceStatusCounts, posture.status);
      }
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

  recordVaultWriteError(reason: string, loopId?: string): void {
    for (const metric of this.targets(loopId)) {
      metric.vaultWriteErrors++;
      increment(metric.vaultWriteReasons, reason);
    }
  }

  recordStrategy(loopId: string, level?: string): void {
    for (const metric of this.targets(loopId)) {
      if (level) increment(metric.levels, level);
    }
  }

  snapshot(loopId?: string): PolicyMetricsSnapshot {
    const source = loopId ? this.loops.get(loopId) ?? empty(loopId) : this.aggregate;
    return snapshotFrom(source);
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

/** Render a mutable counter set as a public snapshot with derived rates. */
function snapshotFrom(source: MutableMetrics): PolicyMetricsSnapshot {
  const attempts = source.roundAttempts;
  const evidence = source.evidenceCaptures;
  return {
    ...source,
    evidenceStatusCounts: { ...source.evidenceStatusCounts },
    observationStatusCounts: { ...source.observationStatusCounts },
    verificationFlags: { ...source.verificationFlags },
    enforcementReasons: { ...source.enforcementReasons },
    evidenceOutcomesByProvider: { ...source.evidenceOutcomesByProvider },
    levels: { ...source.levels },
    filesReconciliation: { ...source.filesReconciliation },
    acceptanceRate: attempts === 0 ? 0 : source.committedRounds / attempts,
    evidenceAvailabilityRate: evidence === 0 ? 0 : source.evidenceAvailable / evidence,
    evidenceLatencyAvgMs: evidence === 0 ? 0 : source.evidenceLatencyMs / evidence,
  };
}

/** v2.12: Derive a metrics snapshot from durable vault entries. Committed
 *  round decisions, verification flags and prompt levels are replayed into the
 *  same counters the live collector maintains. */
export function derivePolicyMetrics(
  loopId: string,
  entries: VaultEntry[],
): PolicyMetricsSnapshot {
  const metric = empty(loopId);
  for (const round of readOnlyRounds(entries)) {
    if (round.loopId !== loopId) continue;
    const result = round.result;
    if (!result) continue;
    metric.roundAttempts++;
    metric.committedRounds++;
    if (result.action === "stop") metric.stoppedRounds++;
    if (result.action === "terminate") metric.terminatedRounds++;
    if ((result.agentOutcome ?? (result.agentSuccessClaim ? "success" : "failed")) === "success") {
      metric.agentClaimedSuccessRounds++;
    }
    if (result.gateContradicted === true) metric.gateContradictedRounds++;
    const posture = round.evidencePosture;
    if (posture) {
      increment(metric.evidenceStatusCounts, posture.status);
      if (posture.machineBackedSuccess) metric.machineBackedSuccessRounds++;
      if (posture.workspace.status === "unknown") metric.workspaceUnknownRounds++;
    }
    for (const observation of round.afterEvidence) {
      increment(metric.observationStatusCounts, observation.status);
    }
    for (const flag of round.verificationFlags) {
      increment(metric.verificationFlags, flag.check);
    }
    if (typeof result.enforcementReason === "string" && result.enforcementReason.length > 0) {
      increment(metric.enforcementReasons, result.enforcementReason);
    }
    if (round.promptArtifact?.level) {
      increment(metric.levels, round.promptArtifact.level);
    }
    const git = gitRoundFacts(round.observationDelta);
    if (git.changedFiles !== null && git.changedFiles.length > 0) {
      metric.filesChangedRounds++;
      metric.filesChangedTotal += git.changedFiles.length;
    }
    if (git.headBefore !== null && git.headAfter !== null &&
        git.headBefore !== git.headAfter) {
      metric.headMoveRounds++;
    }
    const reconciliation = deriveFilesReconciliation(
      round.executionReport,
      round.observationDelta,
      {
        attempted: round.submittedFields.includes(
          "execution_report.files_changed"),
      },
    );
    metric.filesReconciliation[reconciliation.status]++;
    for (const path of round.submittedFields) {
      if (!CORE_SELF_EVALUATION_FIELDS.has(path)) {
        increment(metric.attemptedFieldUsage, path);
      }
    }
    const accounting = deriveFieldAccounting({
      submittedFields: round.submittedFields,
      normalizationDiagnostics: round.normalizationDiagnostics,
      evaluation: round.evaluation,
    });
    if (accounting.incomplete) {
      metric.fieldAccountingIncompleteRounds++;
    } else {
      metric.fieldAccountingRounds++;
      for (const path of accounting.retained) {
        if (!CORE_SELF_EVALUATION_FIELDS.has(path)) {
          increment(metric.retainedFieldUsage, path);
        }
      }
    }
  }
  return snapshotFrom(metric);
}

/** v2.12: Fold live in-process observations over a vault-derived snapshot
 *  without double-counting committed rounds. Only non-durable fields are
 *  overlaid: evidence captures, vault write errors, replays, rejections. */
export function mergePolicyMetrics(
  derived: PolicyMetricsSnapshot,
  live: PolicyMetricsSnapshot,
): PolicyMetricsSnapshot {
  const merged: MutableMetrics = {
    loopId: derived.loopId,
    roundAttempts:
      derived.roundAttempts + live.rejectedAttempts + live.terminatedRounds,
    committedRounds: derived.committedRounds,
    rejectedAttempts: live.rejectedAttempts,
    terminatedRounds: Math.max(derived.terminatedRounds, live.terminatedRounds),
    stoppedRounds: derived.stoppedRounds,
    replayedTransactions: live.replayedTransactions,
    agentClaimedSuccessRounds: derived.agentClaimedSuccessRounds,
    machineBackedSuccessRounds: derived.machineBackedSuccessRounds,
    gateContradictedRounds: derived.gateContradictedRounds,
    evidenceStatusCounts: { ...derived.evidenceStatusCounts },
    observationStatusCounts: { ...derived.observationStatusCounts },
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
    filesChangedRounds: derived.filesChangedRounds,
    filesChangedTotal: derived.filesChangedTotal,
    workspaceUnknownRounds: derived.workspaceUnknownRounds,
    headMoveRounds: derived.headMoveRounds,
    attemptedFieldUsage: { ...derived.attemptedFieldUsage },
    retainedFieldUsage: { ...derived.retainedFieldUsage },
    fieldAccountingRounds: derived.fieldAccountingRounds,
    fieldAccountingIncompleteRounds: derived.fieldAccountingIncompleteRounds,
    filesReconciliation: { ...derived.filesReconciliation },
  };
  return snapshotFrom(merged);
}

export const policyMetrics = new PolicyMetricsCollector();

export function getPolicyMetrics(loopId?: string): PolicyMetricsSnapshot {
  return policyMetrics.snapshot(loopId);
}

export function resetPolicyMetrics(loopId?: string): void {
  policyMetrics.reset(loopId);
}
