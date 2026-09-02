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

function committedFeedback(
  round: number,
  result: Record<string, unknown>,
  level?: string,
): VaultEntry {
  return {
    id: `loop:metrics-loop:r${round}:feedback`,
    task_id: `loop:metrics-loop:r${round}:feedback`,
    task_type: "feedback",
    loop_id: "metrics-loop",
    timestamp: new Date().toISOString(),
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: 1,
        round_id: `loop:metrics-loop:round:${round}`,
        snapshot: {
          schemaVersion: 1,
          roundId: `loop:metrics-loop:round:${round}`,
          loopId: "metrics-loop",
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: [],
          afterEvidence: [],
          result,
          promptArtifact: level
            ? { schemaVersion: 1, roundId: "", attempt: 1, level, renderedPrompt: "", promptHash: "h", stateHash: "s" }
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
      newLastSelfEval: undefined,
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
      committedFeedback(1, { action: "backtrack", roundSuccess: false, gateContradicted: false, verificationFlags: [] }, "l2"),
      committedFeedback(2, { action: "continue", roundSuccess: true, gateContradicted: false, verificationFlags: [] }, "l1"),
    ];
    const metrics = derivePolicyMetrics("metrics-loop", entries);
    assert.equal(metrics.committedRounds, 1);
    assert.equal(metrics.successfulRounds, 1);
    assert.equal(metrics.levels.l2, undefined, "rolled-back round's level must not count");
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
      newLastSelfEval: undefined,
    } as never);
    policyMetrics.recordRound("metrics-loop", {
      action: "reject",
      verificationFlags: [],
      roundSuccess: false,
      gateContradicted: false,
      newConsecutiveRejections: 2,
      shouldPushSuccessTrajectory: false,
      newLastSelfEval: undefined,
    } as never);
    policyMetrics.recordRound("metrics-loop", {
      action: "terminate",
      verificationFlags: [],
      roundSuccess: false,
      gateContradicted: false,
      newConsecutiveRejections: 3,
      shouldPushSuccessTrajectory: false,
      newLastSelfEval: undefined,
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
      newLastSelfEval: undefined,
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
