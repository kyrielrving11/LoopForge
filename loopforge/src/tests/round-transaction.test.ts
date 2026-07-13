import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import {
  makeRoundId,
  prepareRoundTransaction,
  RoundTransactionCoordinator,
} from "../round-transaction.js";
import type { SelfEvaluation } from "../protocol.js";
import { MemoryBackend } from "./_helpers.js";
import { getPolicyMetrics, resetPolicyMetrics } from "../policy-metrics.js";

function continuingEvaluation(): SelfEvaluation {
  return {
    success: false,
    output_summary: "partial progress",
    constraint_violations: [],
    should_continue: true,
    execution_evidence: {
      files_changed: [],
      test_results: null,
      success_criteria_met: [],
      success_criteria_remaining: ["remaining"],
      progress_estimate: 0.4,
    },
  };
}

function rejectedEvaluation(): SelfEvaluation {
  return {
    success: true,
    output_summary: "claimed completion",
    constraint_violations: [],
    should_continue: true,
    execution_evidence: {
      files_changed: ["src/change.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: [],
      success_criteria_remaining: ["still open"],
      progress_estimate: 0.5,
    },
  };
}

describe("RoundTransactionCoordinator", () => {
  it("keeps one stable round ID across rejected attempts", () => {
    assert.equal(makeRoundId("stable", 2), makeRoundId("stable", 2));
    assert.notEqual(makeRoundId("stable", 2), makeRoundId("stable", 3));
  });

  it("rejects with zero commit, then commits and replays exactly once", () => {
    resetPolicyMetrics();
    const backend = new MemoryBackend();
    const engine = new LoopForgeEngine(backend);
    const coordinator = new RoundTransactionCoordinator(engine, backend);
    const prepared = prepareRoundTransaction("tx-retry", 1, []);

    const rejected = coordinator.process({
      snapshot: prepared,
      task: "Transaction retry",
      maxRounds: 3,
      selfEval: rejectedEvaluation(),
      extractionSucceeded: true,
      consecutiveRejections: 0,
      successTrajectory: [],
      actualEvidence: [],
    });

    assert.equal(rejected.result.action, "reject");
    assert.equal(rejected.snapshot.phase, "rejected");
    assert.equal(rejected.snapshot.roundId, prepared.roundId);
    assert.equal(
      backend.queryEntries({ prefix: "loop:tx-retry:r1", feedbackOnly: true }).length,
      0,
    );

    const committed = coordinator.process({
      snapshot: rejected.snapshot,
      task: "Transaction retry",
      maxRounds: 3,
      selfEval: continuingEvaluation(),
      extractionSucceeded: true,
      consecutiveRejections: 1,
      successTrajectory: [],
      actualEvidence: [],
    });
    assert.equal(committed.result.action, "continue");
    assert.equal(committed.snapshot.phase, "committed");
    assert.equal(committed.snapshot.attempt, 2);
    assert.equal(committed.snapshot.roundId, prepared.roundId);

    const replayed = coordinator.process({
      snapshot: rejected.snapshot,
      task: "Transaction retry",
      maxRounds: 3,
      selfEval: rejectedEvaluation(),
      extractionSucceeded: true,
      consecutiveRejections: 1,
      successTrajectory: [],
      actualEvidence: [],
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.result.action, "continue");
    assert.equal(
      backend.queryEntries({ prefix: "loop:tx-retry:r1", feedbackOnly: true }).length,
      1,
    );
    const metrics = getPolicyMetrics("tx-retry");
    assert.equal(metrics.roundAttempts, 2);
    assert.equal(metrics.rejectedAttempts, 1);
    assert.equal(metrics.committedRounds, 1);
    assert.equal(metrics.replayedTransactions, 1);
    assert.equal(metrics.acceptanceRate, 0.5);
  });
});
