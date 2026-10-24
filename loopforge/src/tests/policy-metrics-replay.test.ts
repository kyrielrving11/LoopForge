/** v2.12: Policy metrics survive restarts — vault replay (3.x A4 port). */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  derivePolicyMetrics,
  mergePolicyMetrics,
  policyMetrics,
  resetPolicyMetrics,
} from "../policy-metrics.js";
import type { VaultEntry } from "../loop-store.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "../protocol.js";
import { committedBacktrackRound, fixtureBeforeCheckpointError } from "./_helpers.js";

function committedFeedback(
  round: number,
  result: Record<string, unknown>,
  level?: string,
  submittedFields?: string[],
  evaluation?: Record<string, unknown>,
  normalizationDiagnostics?: Array<Record<string, unknown>>,
  beforeEvidence?: unknown[],
  afterEvidence?: unknown[],
): VaultEntry {
  const fields = submittedFields ?? [
    "success", "output_summary", "constraint_violations", "should_continue",
  ];
  return {
    id: `loop:metrics-loop:r${round}:feedback`,
    task_id: `loop:metrics-loop:r${round}:feedback`,
    task_type: "feedback",
    loop_id: "metrics-loop",
    timestamp: new Date().toISOString(),
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: 6,
        round_id: `loop:metrics-loop:round:${round}`,
        snapshot: {
          schemaVersion: 6,
          kind: "evaluation",
          branchId: "loop:metrics-loop:branch:root",
          transactionId: `tx-metrics-loop-${round}-1`,
          roundId: `loop:metrics-loop:round:${round}`,
          loopId: "metrics-loop",
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: beforeEvidence ?? [],
          ...fixtureBeforeCheckpointError(beforeEvidence ?? []),
          afterEvidence: afterEvidence ?? [],
          operatorAcceptance: {
            task: "Metrics task",
            success_criteria: [],
            hard_constraints: [],
          },
          compiled: {
            task: "Metrics task",
            goalId: "metrics-loop:metrics-task",
            constraintsActive: [],
            constraintsRetired: [],
          },
          result,
          ...(evaluation ? { evaluation } : {}),
          ...(normalizationDiagnostics ? { normalizationDiagnostics } : {}),
          submittedFields: fields,
          promptArtifact: level
            ? {
                schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION, roundId: "", round: 1,
                attempt: 1, level, renderedPrompt: "", promptHash: "h", stateHash: "s",
                sections: [], droppedSections: [], protectedOverflow: false,
                budget: 0, renderedChars: 0,
                coverage: { active: [], rendered: [], omitted: [], complete: true },
              }
            : undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        result,
      },
    },
  };
}

describe("derivePolicyMetrics", () => {
  it("replays committed rounds from vault entries", () => {
    const entries = [
      committedFeedback(1, { action: "continue", roundSuccess: false, gateContradicted: false, verificationFlags: [] }, "l2"),
      committedFeedback(2, { action: "continue", roundSuccess: true, gateContradicted: false, verificationFlags: [{ severity: "warn", check: "evidence_integrity" }] }, "l1"),
      committedFeedback(3, { action: "stop", stopReason: "completed", roundSuccess: true, gateContradicted: false, verificationFlags: [] }, "l1"),
    ];
    const metrics = derivePolicyMetrics("metrics-loop", entries);
    assert.equal(metrics.committedRounds, 3);
    assert.equal(metrics.successfulRounds, 2);
    assert.equal(metrics.stoppedRounds, 1);
    assert.equal(metrics.verificationFlags.evidence_integrity, 1);
    assert.equal(metrics.levels.l2, 1);
    assert.equal(metrics.levels.l1, 2);
  });

  it("counts attempted and retained optional field usage (excluding core)", () => {
    const entries = [
      committedFeedback(1, {
        action: "continue",
        roundSuccess: true,
        gateContradicted: false,
        verificationFlags: [],
      }, "l1", [
        "success", "output_summary", "constraint_violations", "should_continue",
        "discovered_constraints", "execution_report.files_changed",
        "worker_results",
      ], {
        success: false,
        output_summary: "made progress",
        constraint_violations: [],
        should_continue: true,
        discovered_constraints: ["commands must not touch prod"],
        execution_report: {
          files_changed: ["src/a.ts"],
          tests_reported: null,
          criterion_claims: [],
          contract_item_claims: [],
        },
        worker_results: [{
          agentId: "w1",
          subAgentType: "general-purpose",
          subTask: "scan",
          resultSummary: "found the seam",
          outcome: "success",
          discoveredConstraints: [],
        }],
      }),
    ];
    const metrics = derivePolicyMetrics("metrics-loop", entries);
    assert.equal(metrics.attemptedFieldUsage.discovered_constraints, 1);
    assert.equal(metrics.attemptedFieldUsage["execution_report.files_changed"], 1);
    assert.equal(metrics.attemptedFieldUsage.worker_results, 1);
    assert.equal(metrics.attemptedFieldUsage.success, undefined,
      "core fields are not field-usage counts");
    assert.equal(metrics.retainedFieldUsage.discovered_constraints, 1);
    assert.equal(metrics.retainedFieldUsage["execution_report.files_changed"], 1);
    assert.equal(metrics.retainedFieldUsage.worker_results, 1);
    assert.equal(metrics.fieldAccountingRounds, 1);
    assert.equal(metrics.fieldAccountingIncompleteRounds, 0);
  });

  it("does not count a whole-field drop as retained", () => {
    const entries = [
      committedFeedback(1, {
        action: "continue",
        roundSuccess: true,
        gateContradicted: false,
        verificationFlags: [],
      }, "l1", [
        "success", "output_summary", "constraint_violations", "should_continue",
        "compression_checkpoint",
      ], {
        success: false,
        output_summary: "made progress",
        constraint_violations: [],
        should_continue: true,
        compression_checkpoint: false,
      }, [{
        path: "compression_checkpoint",
        code: "invalid_value",
        handling: "dropped",
        detail: "expected a boolean; normalized to false",
      }]),
    ];
    const metrics = derivePolicyMetrics("metrics-loop", entries);
    assert.equal(metrics.attemptedFieldUsage.compression_checkpoint, 1);
    assert.equal(metrics.retainedFieldUsage.compression_checkpoint, undefined);
    assert.equal(metrics.fieldAccountingRounds, 1);
    assert.equal(metrics.fieldAccountingIncompleteRounds, 0);
  });

  it("ignores non-feedback entries and rounds of other loops", () => {
    const entries = [
      { id: "loop:metrics-loop:session", task_id: "loop:metrics-loop:session", task_type: "session_state", loop_id: "metrics-loop", timestamp: "", loop_lineage: {} },
      committedFeedback(1, { action: "continue", verificationFlags: [] }),
      { ...committedFeedback(1, { action: "continue", verificationFlags: [] }), task_id: "loop:other-loop:r1:feedback", loop_id: "other-loop" },
    ];
    const metrics = derivePolicyMetrics("metrics-loop", entries);
    assert.equal(metrics.committedRounds, 1);
  });
});

describe("mergePolicyMetrics", () => {
  afterEach(() => resetPolicyMetrics());

  it("keeps vault-derived round counts and overlays live-only fields", () => {
    const derived = derivePolicyMetrics("metrics-loop", [
      committedFeedback(1, { action: "continue", roundSuccess: true, gateContradicted: false, verificationFlags: [] }),
    ]);
    policyMetrics.recordRound("metrics-loop", {
      action: "continue",
      verificationFlags: [],
      roundSuccess: true,
      gateContradicted: false,
      newConsecutiveRejections: 0,
      shouldPushSuccessTrajectory: true,
    } as never);
    const live = policyMetrics.snapshot("metrics-loop");
    const merged = mergePolicyMetrics(derived, live);
    // committed rounds come from the vault exactly once — no double count.
    assert.equal(merged.committedRounds, 1);
    assert.equal(merged.successfulRounds, 1);
    // live-only observations are preserved.
    assert.equal(merged.rejectedAttempts, live.rejectedAttempts);
  });

  it("excludes rolled-back rounds from committed statistics", () => {
    const entries = [
      committedFeedback(1, { action: "continue", roundSuccess: true, gateContradicted: false, verificationFlags: [] }, "l1"),
      committedBacktrackRound(2, "metrics-loop", 1),
    ];
    const metrics = derivePolicyMetrics("metrics-loop", entries);
    assert.equal(metrics.committedRounds, 1);
    assert.equal(metrics.successfulRounds, 1);
    assert.equal(metrics.levels.l1, 1);
  });

  it("merges uncommitted decisions into attempts and terminatedRounds", () => {
    const derived = derivePolicyMetrics("metrics-loop", [
      committedFeedback(1, { action: "continue", roundSuccess: true, gateContradicted: false, verificationFlags: [] }),
    ]);
    policyMetrics.recordRound("metrics-loop", {
      action: "reject",
      verificationFlags: [],
      roundSuccess: false,
      gateContradicted: false,
      newConsecutiveRejections: 1,
      shouldPushSuccessTrajectory: false,
    } as never);
    policyMetrics.recordRound("metrics-loop", {
      action: "reject",
      verificationFlags: [],
      roundSuccess: false,
      gateContradicted: false,
      newConsecutiveRejections: 2,
      shouldPushSuccessTrajectory: false,
    } as never);
    policyMetrics.recordRound("metrics-loop", {
      action: "terminate",
      verificationFlags: [],
      roundSuccess: false,
      gateContradicted: false,
      newConsecutiveRejections: 3,
      shouldPushSuccessTrajectory: false,
    } as never);
    const live = policyMetrics.snapshot("metrics-loop");
    const merged = mergePolicyMetrics(derived, live);
    // v2.14: attempts = committed + this process's rejects + terminates
    // (rejects/terminates never commit, so no double count).
    assert.equal(merged.roundAttempts, 4);
    assert.equal(merged.terminatedRounds, 1, "terminatedRounds comes from live, not 0");
  });
});

describe("live collector — commit semantics (v3.3.1)", () => {
  it("does not count terminate or backtrack decisions as committed rounds", () => {
    // Regression: recordRound's else branch counted EVERY non-reject action
    // (terminate, backtrack) as a committed round, so the live snapshot that
    // backs getPolicyMetrics before the first vault-derived value inflated
    // acceptanceRate for loops that terminated pre-commit.
    resetPolicyMetrics();
    const decision = (action: string): never => ({
      action, verificationFlags: [], roundSuccess: false, gateContradicted: false,
      newConsecutiveRejections: 1, shouldPushSuccessTrajectory: false,
    } as never);
    policyMetrics.recordRound("metrics-live-bucket", decision("terminate"));
    policyMetrics.recordRound("metrics-live-bucket", decision("backtrack"));
    policyMetrics.recordRound("metrics-live-bucket", decision("continue"));
    policyMetrics.recordRound("metrics-live-bucket", decision("stop"));
    const live = policyMetrics.snapshot("metrics-live-bucket");
    assert.equal(live.roundAttempts, 4);
    assert.equal(live.committedRounds, 2,
      "only continue/stop decisions commit — terminate/backtrack must not inflate it");
    assert.equal(live.terminatedRounds, 1);
    assert.equal(live.rejectedAttempts, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.2 — file reconciliation metrics
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.2 — files reconciliation metrics", () => {
  const git = (
    phase: "before" | "after",
    files: string[],
    fingerprints: Record<string, string>,
  ) => ({
    schemaVersion: 2 as const,
    providerId: "git",
    kind: "git" as const,
    phase,
    startedAt: 0,
    finishedAt: 0,
    status: "observed" as const,
    files,
    data: {
      dirty: files,
      fingerprints,
      coverage: "tracked_and_non_ignored_untracked" as const,
    },
  });
  const fields = [
    "success", "output_summary", "constraint_violations", "should_continue",
    "execution_report.files_changed",
  ];
  const evaluation = (filesChanged: string[]) => ({
    success: false,
    output_summary: "made progress",
    constraint_violations: [],
    should_continue: true,
    execution_report: {
      files_changed: filesChanged,
      tests_reported: null,
      criterion_claims: [],
      contract_item_claims: [],
    },
  });
  const result = {
    action: "continue",
    roundSuccess: true,
    gateContradicted: false,
    verificationFlags: [],
  };

  it("counts reconciliation statuses from the shared delta", () => {
    const entries = [
      committedFeedback(
        1, result, "l1", fields, evaluation(["a.ts"]), [],
        [git("before", [], {})],
        [git("after", ["a.ts"], { "a.ts": "m:1" })],
      ),
      committedFeedback(
        2, result, "l1", fields, evaluation(["a.ts", "ghost.ts"]), [],
        [git("before", ["a.ts"], { "a.ts": "m:1" })],
        [git("after", ["a.ts"], { "a.ts": "m:1" })],
      ),
    ];
    const metrics = derivePolicyMetrics("metrics-loop", entries);
    assert.equal(metrics.filesChangedRounds, 1);
    assert.equal(metrics.filesChangedTotal, 1);
    assert.equal(metrics.filesReconciliation.match, 1);
    assert.equal(metrics.filesReconciliation.mismatch, 1);
    assert.equal(metrics.filesReconciliation.unknown, 0);
    assert.equal(metrics.filesReconciliation.not_applicable, 0);
  });
});
