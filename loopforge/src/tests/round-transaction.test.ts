import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import {
  makeRoundId,
  prepareRejectedAttempt,
  prepareRoundTransaction,
  parseRoundTransactionSnapshot,
  RoundTransactionCoordinator,
} from "../round-transaction.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "../protocol.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import type { SelfEvaluation } from "../protocol.js";
import { queryLoopEntries } from "../loop-store.js";
import { decodeCommittedRound } from "../committed-round.js";
import { VaultRoundCommitStore } from "../storage.js";
import {
  MemoryLoopStore,
  committedBacktrackRound,
  committedFeedbackRound,
  criterionClaims,
  fixtureEvidencePosture,
  fixtureRollbackEvidencePosture,
} from "./_helpers.js";
import { getPolicyMetrics, resetPolicyMetrics } from "../policy-metrics.js";

const ACCEPTANCE = {
  task: "Transaction test",
  success_criteria: ["Task goal achieved with verifiable evidence"],
  hard_constraints: [],
};

function compiled(loopId: string, round: number) {
  return {
    task: "Transaction test",
    goalId: `${loopId}:test`,
    constraintsActive: [],
    constraintsRetired: [],
  };
}

function prepare(
  loopId: string,
  round: number,
  before: Parameters<typeof prepareRoundTransaction>[2] = [],
  artifact?: Parameters<typeof prepareRoundTransaction>[3],
  opts: Parameters<typeof prepareRoundTransaction>[4] = {},
): RoundTransactionSnapshot {
  return prepareRoundTransaction(loopId, round, before, artifact, {
    operatorAcceptance: ACCEPTANCE,
    compiled: compiled(loopId, round),
    ...opts,
  });
}

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

describe("schema 6 structural invariants", () => {
  it("rejects a submitted evaluation without compile facts or acceptance", () => {
    const base: RoundTransactionSnapshot = {
      ...prepare("schema-six", 1, []),
      phase: "committed",
      afterEvidence: [],
      evaluation: continuingEvaluation(),
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
      ],
      result: {
        action: "continue",
        evidencePosture: fixtureEvidencePosture(1),
        agentSuccessClaim: false,
        agentOutcome: null,
        gateContradicted: false,
        newConsecutiveRejections: 0,
        shouldPushSuccessTrajectory: false,
        verificationFlags: [],
      },
    };
    const asRecord = (value: unknown) => value as Record<string, unknown>;
    assert.ok(parseRoundTransactionSnapshot(asRecord(base)) !== null);

    assert.equal(
      parseRoundTransactionSnapshot(asRecord({ ...base, compiled: undefined })),
      null,
      "a committed evaluation must carry its compile facts",
    );
    assert.equal(
      parseRoundTransactionSnapshot(asRecord({ ...base, operatorAcceptance: undefined })),
      null,
      "a committed evaluation must carry the immutable operator surface",
    );
  });

  it("a retry stamps the retry compile facts and the same acceptance", () => {
    const loopId = "retry-compiled";
    const rejected: RoundTransactionSnapshot = {
      ...prepare(loopId, 1, []),
      phase: "rejected",
    };
    const artifact = {
      schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
      roundId: rejected.roundId,
      round: rejected.round,
      attempt: rejected.attempt + 1,
      level: "l0" as const,
      contextMode: "same_round_retry" as const,
      contextReason: "enforcement_retry" as const,
      renderedPrompt: "retry prompt",
      promptHash: "retry-hash",
      stateHash: "retry-state",
      sections: [],
      droppedSections: [],
      protectedOverflow: false,
      budget: 0,
      renderedChars: 12,
      coverage: { active: [], rendered: [], omitted: [], complete: true },
    };
    const retryCompiled = {
      task: "Retry task",
      goalId: "retry-goal",
      constraintsActive: ["retry constraint"],
      constraintsRetired: ["old constraint"],
    };
    const retryAcceptance = {
      task: "Operator task",
      success_criteria: ["ship it"],
      hard_constraints: ["no deps"],
    };
    const next = prepareRejectedAttempt(
      rejected,
      artifact,
      retryCompiled,
      retryAcceptance,
    );
    assert.equal(next.phase, "prompted");
    assert.equal(next.attempt, 2);
    assert.deepEqual(next.compiled, retryCompiled,
      "the retry transaction carries the retry compile facts");
    assert.deepEqual(next.operatorAcceptance, retryAcceptance);
    assert.equal(next.evaluation, undefined);
    assert.equal(next.result, undefined);
  });

  it("requires acceptance and forbids compile facts on a rollback directive", () => {
    const envelope = committedBacktrackRound(2, "schema-six-rollback");
    const snapshot = (envelope.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    const value = snapshot.snapshot as Record<string, unknown>;
    assert.ok(parseRoundTransactionSnapshot(value) !== null);

    assert.equal(
      parseRoundTransactionSnapshot({ ...value, operatorAcceptance: undefined }),
      null,
      "a rollback directive must preserve the operator surface",
    );
    assert.equal(
      parseRoundTransactionSnapshot({ ...value, compiled: compiled("schema-six-rollback", 2) }),
      null,
      "a rollback directive never carries compile facts",
    );
  });
});

describe("RoundTransactionCoordinator", () => {
  it("refuses to persist a directive under a different loop or transaction identity", () => {
    const store = new MemoryLoopStore();
    const source = committedBacktrackRound(2, "identity-source", 0);
    const envelope = source.loop_lineage!.round_transaction as never;
    const adapter = new VaultRoundCommitStore(store);

    assert.throws(
      () => adapter.appendRollbackDirective("identity-target", 2, "tx-other", envelope),
      /Refusing invalid rollback transaction/,
    );
    assert.equal(store.rounds.size, 0);
  });

  it("keeps one stable round ID across rejected attempts", () => {
    assert.equal(makeRoundId("stable", 2), makeRoundId("stable", 2));
    assert.notEqual(makeRoundId("stable", 2), makeRoundId("stable", 3));
  });

  it("rejects with zero commit, then commits and replays exactly once", () => {
    resetPolicyMetrics();
    const store = new MemoryLoopStore();
    const engine = new LoopForgeEngine(store);
    const coordinator = new RoundTransactionCoordinator(store);
    const prepared = prepare("tx-retry", 1, []);

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
    const base = prepare("bt-loop", 3, []);
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
        evidencePosture: fixtureRollbackEvidencePosture(1),
        agentSuccessClaim: false,
        agentOutcome: null,
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
    const coordinator = new RoundTransactionCoordinator(store);

    // 1. Create a committed backtrack transaction
    const before = prepare("bt-recover", 5, []);
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
        evidencePosture: fixtureRollbackEvidencePosture(1),
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
        agentSuccessClaim: false,
        agentOutcome: null,
        gateContradicted: false,
        newConsecutiveRejections: 0,
        shouldPushSuccessTrajectory: false,
        verificationFlags: [],
      },
      updatedAt: Date.now(),
    };

    // Write the committed transaction to the store
    new VaultRoundCommitStore(store).appendFeedback("bt-recover", 5, {
      schema_version: committed.schemaVersion,
      round_id: committed.roundId,
      snapshot: committed,
      result: committed.result!,
    });

    // 2. Recover via new coordinator (simulating crash restart)
    const recovered = coordinator.recover(before);
    assert.ok(recovered !== null,
      "recover must find the committed backtrack transaction");
    assert.equal(recovered!.replayed, true);
    assert.equal(recovered!.result.action, "backtrack");
    assert.equal(recovered!.result.recovery?.target.redo_round, 3);
    assert.equal(recovered!.result.recovery?.trigger_rule, "progress_stall");
  });

  it("v4.0.3: a committed result without a posture is a HARD break", () => {
    const entry = committedFeedbackRound(1, { loopId: "posture-break" });
    const transaction = (entry.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    const result = { ...(transaction.result as Record<string, unknown>) };
    delete result.evidencePosture;
    const snapshot = {
      ...(transaction.snapshot as Record<string, unknown>),
      result,
    };
    const broken = {
      ...entry,
      loop_lineage: {
        ...(entry.loop_lineage as Record<string, unknown>),
        round_transaction: { ...transaction, result, snapshot },
      },
    };
    assert.equal(parseRoundTransactionSnapshot(snapshot), null,
      "a schema-7 committed result must carry a well-formed posture");
    assert.equal(decodeCommittedRound(broken as never), null,
      "the committed view never fabricates a missing posture");
  });

  it("v4.0.3: a malformed posture is rejected, not repaired", () => {
    const entry = committedFeedbackRound(1, { loopId: "posture-corrupt" });
    const transaction = (entry.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    const result = {
      ...(transaction.result as Record<string, unknown>),
      evidencePosture: {
        ...fixtureEvidencePosture(1),
        status: "bogus",
      },
    };
    assert.equal(parseRoundTransactionSnapshot({
      ...(transaction.snapshot as Record<string, unknown>),
      result,
    }), null);
  });

  it("v4.0.3: the committed view exposes the persisted posture", () => {
    const entry = committedFeedbackRound(1, { loopId: "posture-view" });
    const view = decodeCommittedRound(entry);
    assert.ok(view);
    assert.equal(view!.evidencePosture?.round, 1);
    assert.equal(view!.evidencePosture?.kind, "evaluation");
    assert.deepEqual(view!.evidencePosture, fixtureEvidencePosture(1));
  });

  it("v4.0.3: retryContext is legal only on a rejected/retry prompt", () => {
    const retryContext = {
      attempt: 2,
      rejectedAttempt: 1,
      rejectionNotice: "redo it",
      verificationFlags: [],
      evidencePosture: fixtureEvidencePosture(1),
      rejectedAt: 1,
    };
    const rejected: RoundTransactionSnapshot = {
      ...prepare("retry-context", 1, []),
      phase: "rejected",
      retryContext,
    };
    assert.ok(parseRoundTransactionSnapshot(rejected as unknown as Record<string, unknown>));

    const committedEntry = committedFeedbackRound(1, { loopId: "retry-context" });
    const transaction = (committedEntry.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    assert.equal(parseRoundTransactionSnapshot({
      ...(transaction.snapshot as Record<string, unknown>),
      retryContext,
    }), null, "transient retry facts never enter a committed document");
  });

  it("does not replay an abandoned commit with the same roundId on another branch", () => {
    const store = new MemoryLoopStore();
    const engine = new LoopForgeEngine(store);
    const coordinator = new RoundTransactionCoordinator(store);
    const root = prepare("tx-branch", 2, []);
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

    const child = prepare("tx-branch", 2, [], undefined, {
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
