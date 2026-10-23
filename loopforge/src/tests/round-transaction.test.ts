import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import {
  makeRoundId,
  prepareRoundTransaction,
  parseRoundTransactionSnapshot,
  RoundTransactionCoordinator,
} from "../round-transaction.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import type { SelfEvaluation } from "../protocol.js";
import { queryLoopEntries } from "../loop-store.js";
import { MemoryLoopStore, criterionClaims } from "./_helpers.js";
import { getPolicyMetrics, resetPolicyMetrics } from "../policy-metrics.js";

function continuingEvaluation(): SelfEvaluation {
  return {
    success: false,
    output_summary: "partial progress",
    constraint_violations: [],
    should_continue: true,
    execution_report: {
      files_changed: [],
      tests_reported: null,
      criterion_claims: criterionClaims([], ["remaining"]),
    },
  };
}

function rejectedEvaluation(): SelfEvaluation {
  return {
    success: true,
    output_summary: "claimed completion",
    constraint_violations: [],
    should_continue: true,
    execution_report: {
      files_changed: ["src/change.ts"],
      tests_reported: { passed: 1, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims([], ["still open"]),
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
    const store = new MemoryLoopStore();
    const engine = new LoopForgeEngine(store);
    const coordinator = new RoundTransactionCoordinator(engine, store);
    const prepared = prepareRoundTransaction("tx-retry", 1, []);

    const rejected = coordinator.process({
      snapshot: prepared,
      task: "Transaction retry",
      maxRounds: 3,
      selfEval: rejectedEvaluation(),
      consecutiveRejections: 0,
      actualEvidence: [],
    });

    assert.equal(rejected.result.action, "reject");
    assert.equal(rejected.snapshot.phase, "rejected");
    assert.equal(rejected.snapshot.roundId, prepared.roundId);
    assert.equal(
      queryLoopEntries(store, "tx-retry", { prefix: "loop:tx-retry:r1", feedbackOnly: true }).length,
      0,
    );

    const committed = coordinator.process({
      snapshot: rejected.snapshot,
      task: "Transaction retry",
      maxRounds: 3,
      selfEval: continuingEvaluation(),
      consecutiveRejections: 1,
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
      consecutiveRejections: 1,
      actualEvidence: [],
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.result.action, "continue");
    assert.equal(
      queryLoopEntries(store, "tx-retry", { prefix: "loop:tx-retry:r1", feedbackOnly: true }).length,
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

// ═══════════════════════════════════════════════════════════════════════════
// Backtrack commit replay (v2.10 — regression guard)
// ═══════════════════════════════════════════════════════════════════════════

describe("backtrack commit replay", () => {
  it("parseRoundTransactionSnapshot accepts backtrack action", () => {
    const base = prepareRoundTransaction("bt-loop", 3, []);
    const snapshot: RoundTransactionSnapshot = {
      ...base,
      phase: "committed",
      afterEvidence: [],
      evaluation: {
        success: false,
        output_summary: "stalled",
        constraint_violations: [],
        should_continue: true,
      },
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
      ],
      result: {
        action: "backtrack",
        verificationStatus: "trusted",
        roundSuccess: false,
        gateContradicted: false,
        newConsecutiveRejections: 0,
        shouldPushSuccessTrajectory: false,
        verificationFlags: [],
      },
    };

    const parsed = parseRoundTransactionSnapshot(
      snapshot as unknown as Record<string, unknown>,
    );
    assert.ok(parsed !== null,
      "parseRoundTransactionSnapshot must accept backtrack result");
    assert.equal(parsed!.result!.action, "backtrack");
    assert.equal(parsed!.phase, "committed");
  });

  it("recover replays committed backtrack without re-evaluating", () => {
    const store = new MemoryLoopStore();
    const engine = new LoopForgeEngine(store);
    const coordinator = new RoundTransactionCoordinator(engine, store);

    // 1. Create a committed backtrack transaction
    const before = prepareRoundTransaction("bt-recover", 5, []);
    const committed: RoundTransactionSnapshot = {
      ...before,
      phase: "committed",
      attempt: 1,
      afterEvidence: [],
      evaluation: continuingEvaluation(),
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
      ],
      result: {
        action: "backtrack",
        verificationStatus: "trusted",
        recovery: {
          origin: "machine",
          reason: "progress_stall",
          trigger_rule: "progress_stall",
          target: {
            checkpoint_id: "ck-aaaaaaaaaaaaaaaaaaaaaaaa",
            content_hash: "a".repeat(64),
            role: "before",
            round: 3,
            round_id: "loop:bt-recover:round:3",
            transaction_id: "tx-bt-recover-3-1",
            redo_round: 3,
          },
          skipped_files: [],
          skipped_discoveries: [],
          failed_rounds: [3, 4, 5],
          approaches: [],
          wrong_assumptions: [],
          transaction_id: "tx-rollback-bt-recover-5",
        },
        roundSuccess: false,
        gateContradicted: false,
        newConsecutiveRejections: 0,
        shouldPushSuccessTrajectory: false,
        verificationFlags: [],
      },
      updatedAt: Date.now(),
    };

    // Write the committed transaction to the store
    engine.autoFeedback(
      committed.evaluation!,
      "bt-recover",
      5,
      "test task",
      {
        schema_version: 3,
        round_id: committed.roundId,
        snapshot: committed,
        result: committed.result!,
      },
    );

    // 2. Recover via new coordinator (simulating crash restart)
    const recovered = coordinator.recover(before);
    assert.ok(recovered !== null,
      "recover must find the committed backtrack transaction");
    assert.equal(recovered!.replayed, true);
    assert.equal(recovered!.result.action, "backtrack");
    assert.equal(recovered!.result.recovery?.target, 2);
    assert.equal(recovered!.result.recovery?.trigger_rule, "progress_stall");
  });

  it("does not replay an abandoned commit with the same roundId on another branch", () => {
    const store = new MemoryLoopStore();
    const engine = new LoopForgeEngine(store);
    const coordinator = new RoundTransactionCoordinator(engine, store);
    const root = prepareRoundTransaction("tx-branch", 2, []);
    const committed = coordinator.process({
      snapshot: root,
      task: "branch identity",
      maxRounds: 3,
      selfEval: continuingEvaluation(),
      consecutiveRejections: 0,
      actualEvidence: [],
    });
    assert.equal(committed.result.action, "continue");
    assert.equal(committed.replayed, false);

    const child = prepareRoundTransaction("tx-branch", 2, [], undefined, {
      branchId: "loop:tx-branch:branch:child",
    });
    assert.notEqual(child.transactionId, root.transactionId);
    assert.equal(
      coordinator.recover(child),
      null,
      "the redo identity is the transaction, not the numeric round",
    );
    assert.equal(
      coordinator.recover(root)?.replayed,
      true,
      "the exact transaction still replays",
    );
  });
});
