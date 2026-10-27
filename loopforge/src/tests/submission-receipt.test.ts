/** v3.9.1 — submission receipts: saved reports, effects, verification. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCommittedSubmissionView,
  deriveSubmissionReceipt,
} from "../submission-receipt.js";
import type { ReceiptInput } from "../submission-receipt.js";
import {
  PROMPT_ARTIFACT_SCHEMA_VERSION,
  makeExecutionReport,
  makeSelfEvaluation,
} from "../protocol.js";
import type {
  PromptArtifact,
  RecoveryDirective,
  SubGoal,
  SubmissionReceipt,
} from "../protocol.js";
import type { RoundProcessResult } from "../round-coordinator.js";
import {
  ROUND_TRANSACTION_SCHEMA_VERSION,
} from "../round-transaction.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import {
  committedBacktrackRound,
  committedFeedbackRound,
  fixtureEvidencePosture,
} from "./_helpers.js";
import {
  decodeCommittedRound,
  readOnlyRollbacks,
} from "../committed-round.js";
import { resetPolicy } from "../policy.js";
import { afterEach } from "node:test";

function subGoal(id: string, status: SubGoal["status"] = "pending"): SubGoal {
  return {
    id,
    description: `sub-goal ${id}`,
    status,
    declared_at_round: 1,
    status_changed_at_round: 1,
    priority: 0,
  };
}

function result(overrides: Partial<RoundProcessResult> = {}): RoundProcessResult {
  return {
    action: "continue",
    verificationFlags: [],
    agentSuccessClaim: true,
    gateContradicted: false,
    evidencePosture: fixtureEvidencePosture(1, {
      status: "verified",
      machineBackedSuccess: true,
      verificationConfigured: true,
      contract: {
        id: "rc-12345678",
        closure: "verified",
        items: [{
          id: "rci-12345678",
          status: "verified",
          criterionRefs: [],
          reasons: [],
        }],
        verifiedCount: 1,
        insufficientCount: 0,
        contradictedCount: 0,
        pendingCount: 0,
      },
    }),
    newConsecutiveRejections: 0,
    shouldPushSuccessTrajectory: true,
    ...overrides,
  } as RoundProcessResult;
}

function input(overrides: Partial<ReceiptInput> = {}): ReceiptInput {
  const selfEval = makeSelfEvaluation({
    success: true,
    output_summary: "did the work",
    constraint_violations: [],
    should_continue: true,
    discovered_constraints: ["never touch prod"],
  });
  const pr = result();
  const snapshot = {
    schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
    branchId: "loop:receipt:branch:root",
    transactionId: "tx-test",
    kind: "evaluation",
    roundId: "loop:receipt:round:1",
    loopId: "receipt",
    round: 1,
    attempt: 1,
    phase: "committed",
    beforeEvidence: [],
    afterEvidence: [],
    operatorAcceptance: {
      task: "Receipt task",
      success_criteria: ["Task goal achieved with verifiable evidence"],
      hard_constraints: [],
    },
    compiled: {
      task: "Receipt task",
      goalId: "receipt:test",
      constraintsActive: ["never touch prod"],
      constraintsRetired: [],
    },
    evaluation: selfEval,
    result: pr,
    createdAt: 0,
    updatedAt: 0,
  } as RoundTransactionSnapshot;
  const artifact: PromptArtifact = {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
    roundId: "loop:receipt:round:2",
    round: 2,
    attempt: 1,
    level: "l1",
    contextMode: "fresh_round",
    contextReason: "next_round",
    renderedPrompt: "next",
    promptHash: "h",
    stateHash: "s",
    sections: [],
    droppedSections: [],
    protectedOverflow: false,
    budget: 0,
    renderedChars: 0,
    coverage: { active: [], rendered: [], omitted: [], complete: true },
  };
  return {
    snapshot,
    selfEval,
    pr,
    disposition: "accepted",
    diagnostics: [],
    submittedFields: [
      "success", "output_summary", "constraint_violations", "should_continue",
      "discovered_constraints", "worker_results",
    ],
    facts: {
      contractBefore: null,
      contractAfter: "rc-12345678",
      subGoalsBefore: [],
      subGoalsAfter: [subGoal("sg-12345678")],
      constraintsActiveAfter: ["never touch prod"],
      constraintsRetiredAfter: null,
    },
    nextArtifact: artifact,
    evidenceDeltas: [],
    ...overrides,
  };
}

function report(receipt: SubmissionReceipt, path: string) {
  return receipt.reports.find((entry) => entry.path === path);
}

afterEach(() => resetPolicy());

describe("v3.9.1 — submission receipt", () => {
  it("v4.0.2: open_questions is report-only and the prompt context is projected", () => {
    const selfEval = makeSelfEvaluation({
      success: true,
      output_summary: "did the work",
      constraint_violations: [],
      should_continue: true,
      open_questions: ["does the migration preserve ids?"],
    });
    const receipt = deriveSubmissionReceipt(input({
      selfEval,
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
        "open_questions",
      ],
      nextArtifact: {
        ...input().nextArtifact!,
        contextMode: "same_round_retry",
        contextReason: "enforcement_retry",
      },
    }));
    assert.equal(report(receipt, "open_questions")?.handling, "saved_not_expanded");
    assert.equal(receipt.prompt?.context_mode, "same_round_retry");
    assert.equal(receipt.prompt?.context_reason, "enforcement_retry");
  });

  it("separates saved reports, derived effects and machine verification", () => {
    const receipt = deriveSubmissionReceipt(input());
    assert.equal(receipt.entered_history, true);
    assert.equal(receipt.record, "committed");
    assert.equal(receipt.disposition, "accepted");
    assert.equal(report(receipt, "discovered_constraints")?.handling, "saved");
    assert.equal(report(receipt, "worker_results")?.handling, "saved_not_expanded",
      "a worker report does not expand into derived state");
    assert.equal(receipt.effects.contract.activated, true);
    assert.deepEqual(receipt.effects.subgoals_created.map((item) => item.id),
      ["sg-12345678"]);
    assert.deepEqual(receipt.effects.constraints_declared, ["never touch prod"]);
    assert.deepEqual(receipt.effects.constraints_active_after, ["never touch prod"]);
    assert.equal(receipt.effects.constraints_activation, "observed");
    assert.equal(receipt.verification.evidence_posture.status, "verified");
    assert.equal(receipt.verification.evidence_posture.machineBackedSuccess, true);
    assert.deepEqual(receipt.verification.contract_items.map((item) => item.status),
      ["verified"]);
  });

  it("marks every field not_applied on a reject and never shows an effect", () => {
    const rejected = result({ action: "reject" });
    const receipt = deriveSubmissionReceipt(input({
      pr: rejected,
      snapshot: {
        ...input().snapshot,
        phase: "evaluated",
        result: rejected,
      },
      disposition: "rejected",
      facts: {
        contractBefore: "rc-12345678",
        contractAfter: "rc-12345678",
        subGoalsBefore: [subGoal("sg-12345678")],
        subGoalsAfter: null,
        constraintsActiveAfter: null,
        constraintsRetiredAfter: null,
      },
    }));
    assert.equal(receipt.entered_history, false);
    assert.equal(receipt.record, "none");
    for (const entry of receipt.reports) {
      assert.equal(entry.handling, "not_applied",
        `${entry.path} must not read as applied`);
    }
    assert.deepEqual(receipt.effects.subgoals_created, []);
    assert.deepEqual(receipt.effects.constraints_declared, []);
    assert.equal(receipt.effects.contract.activated, false);
    assert.ok(receipt.prompt, "a rejection carries the retry prompt's effect facts");
  });

  it("reports only actually preserved facts on a backtrack", () => {
    const backtrack = result({
      action: "backtrack",
      recovery: {
        origin: "machine",
        reason: "test backtrack",
        target: {
          checkpoint_id: "ck-aaaaaaaaaaaaaaaaaaaaaaaa",
          content_hash: "a".repeat(64),
          role: "before",
          round: 2,
          round_id: "loop:receipt:round:2",
          transaction_id: "tx-target",
          redo_round: 2,
        },
        skipped_files: [],
        skipped_discoveries: ["a preserved finding"],
        failed_rounds: [2],
        approaches: [],
        wrong_assumptions: ["the API was synchronous"],
        transaction_id: "tx-rollback",
      },
    });
    const receipt = deriveSubmissionReceipt(input({
      pr: backtrack,
      snapshot: {
        ...input().snapshot,
        phase: "committed",
        result: backtrack,
      },
      disposition: "backtracked",
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
        "discovered_constraints", "wrong_assumptions",
      ],
      facts: {
        contractBefore: "rc-12345678",
        contractAfter: "rc-12345678",
        subGoalsBefore: [],
        subGoalsAfter: null,
        constraintsActiveAfter: null,
        constraintsRetiredAfter: null,
      },
    }));
    assert.equal(receipt.entered_history, false);
    assert.equal(receipt.record, "rollback_directive");
    assert.equal(report(receipt, "wrong_assumptions")?.handling, "saved");
    assert.equal(report(receipt, "discovered_constraints")?.handling, "not_applied");
    assert.equal(receipt.effects.rollback?.redo_round, 2);
    assert.equal(receipt.effects.rollback?.target_checkpoint_id, "ck-aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.deepEqual(receipt.effects.rollback?.preserved_discoveries,
      ["a preserved finding"]);
    assert.deepEqual(receipt.effects.subgoals_created, []);
    assert.ok(receipt.prompt, "the restored prompt's effects are carried");
  });

  it("reports constraints that were declared but never became active", () => {
    const receipt = deriveSubmissionReceipt(input({
      facts: {
        contractBefore: null,
        contractAfter: null,
        subGoalsBefore: [],
        subGoalsAfter: null,
        constraintsActiveAfter: [],
        constraintsRetiredAfter: null,
      },
    }));
    assert.deepEqual(receipt.effects.constraints_declared, ["never touch prod"]);
    assert.deepEqual(receipt.effects.constraints_not_expanded, ["never touch prod"]);
  });

  it("carries normalization diagnostics without turning them into effects", () => {
    const receipt = deriveSubmissionReceipt(input({
      diagnostics: [{
        path: "progress_estimate",
        code: "unknown_field",
        handling: "dropped",
        detail: "removed in 3.9.0",
      }],
    }));
    assert.equal(receipt.diagnostics.length, 1);
    assert.equal(report(receipt, "progress_estimate")?.handling, "dropped");
  });

  it("keeps a partially retained array field saved and surfaces the loss", () => {
    const receipt = deriveSubmissionReceipt(input({
      selfEval: makeSelfEvaluation({
        success: true,
        output_summary: "did the work",
        constraint_violations: [],
        should_continue: true,
        discovered_constraints: ["kept"],
      }),
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
        "discovered_constraints",
      ],
      diagnostics: [{
        path: "discovered_constraints",
        code: "invalid_entry",
        handling: "dropped",
        detail: "1 non-string entry dropped",
      }],
    }));
    const entry = report(receipt, "discovered_constraints");
    assert.equal(entry?.handling, "saved", "the field survived with one value");
    assert.match(entry?.detail ?? "", /1 non-string entry dropped/);
  });

  it("marks a whole-field drop as dropped", () => {
    const receipt = deriveSubmissionReceipt(input({
      selfEval: makeSelfEvaluation({
        success: true,
        output_summary: "did the work",
        constraint_violations: [],
        should_continue: true,
        subtask_boundary: false,
      }),
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
        "subtask_boundary",
      ],
      diagnostics: [{
        path: "subtask_boundary",
        code: "invalid_value",
        handling: "dropped",
        detail: "expected a boolean",
      }],
    }));
    assert.equal(report(receipt, "subtask_boundary")?.handling, "dropped");
  });

  it("labels an uncertain retained value as retention unknown", () => {
    const receipt = deriveSubmissionReceipt(input({
      selfEval: makeSelfEvaluation({
        success: true,
        output_summary: "did the work",
        constraint_violations: [],
        should_continue: true,
        discovered_constraints: [],
      }),
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
        "discovered_constraints",
      ],
      diagnostics: [{
        path: "diagnostics",
        code: "diagnostics_truncated",
        handling: "truncated",
        detail: "more diagnostics were omitted",
      }],
    }));
    const entry = report(receipt, "discovered_constraints");
    assert.equal(entry?.handling, "saved");
    assert.match(entry?.detail ?? "", /retention unknown/);
  });

  it("reports the redo recovery checkpoint and its machine verification", () => {
    const directive: RecoveryDirective = {
      origin: "agent",
      reason: "try another approach",
      target: {
        checkpoint_id: "ck-bbbbbbbbbbbbbbbbbbbbbbbb",
        content_hash: "b".repeat(64),
        role: "before",
        round: 2,
        round_id: "loop:receipt:round:2",
        transaction_id: "tx-target",
        redo_round: 2,
      },
      skipped_files: [],
      skipped_discoveries: [],
      failed_rounds: [2],
      approaches: [],
      wrong_assumptions: [],
      transaction_id: "tx-child",
    };
    const verified = deriveSubmissionReceipt(input({
      recoveryDirective: directive,
      snapshot: {
        ...input().snapshot,
        restore: {
          directiveTransactionId: "tx-child",
          redoRound: 2,
          verifiedAt: 1,
        },
      },
    }));
    assert.deepEqual(verified.recovery_checkpoint, {
      checkpoint_id: "ck-bbbbbbbbbbbbbbbbbbbbbbbb",
      redo_round: 2,
      origin: "agent",
      reason: "try another approach",
      restore_verified: true,
    });

    const failed = deriveSubmissionReceipt(input({
      recoveryDirective: directive,
      pr: result({
        action: "reject",
        verificationFlags: [{
          severity: "error",
          field: "recovery",
          check: "backtrack_workspace_not_restored",
          detail: "the workspace was never restored",
        }],
      }),
      disposition: "rejected",
    }));
    assert.equal(failed.recovery_checkpoint?.restore_verified, false);
    assert.equal(deriveSubmissionReceipt(input()).recovery_checkpoint, undefined,
      "an ordinary receipt carries no checkpoint");
    const rollbackDirectiveReceipt = deriveSubmissionReceipt(input({
      pr: result({ action: "backtrack" }),
      disposition: "backtracked",
    }));
    assert.equal(rollbackDirectiveReceipt.recovery_checkpoint, undefined,
      "a rollback directive's own receipt has no checkpoint");

    const redoBacktrack = deriveSubmissionReceipt(input({
      recoveryDirective: directive,
      pr: result({
        action: "backtrack",
        verificationFlags: [{
          severity: "error",
          field: "recovery",
          check: "backtrack_workspace_not_restored",
          detail: "the workspace was never restored",
        }],
      }),
      disposition: "backtracked",
    }));
    assert.equal(redoBacktrack.recovery_checkpoint?.restore_verified, false,
      "a redo that itself rolls back still reports the checkpoint it failed");
  });

  it("rebuilds the redo checkpoint from committed history", () => {
    const directiveEntry = committedBacktrackRound(
      2,
      "receipt-recovery",
      1,
      { transactionId: "tx-child" },
    );
    const directive = readOnlyRollbacks([directiveEntry])[0];
    assert.ok(directive);
    const redoEntry = committedFeedbackRound(2, {
      loopId: "receipt-recovery",
      branchId: "tx-child",
      success: true,
      restore: {
        directiveTransactionId: "tx-child",
        redoRound: 2,
        verifiedAt: 1,
      },
    });
    const redo = decodeCommittedRound(redoEntry);
    assert.ok(redo);
    const receipt = deriveCommittedSubmissionView(redo!, [redo!], [directive!]);
    assert.deepEqual(receipt.recovery_checkpoint, {
      checkpoint_id: directive!.recovery!.target.checkpoint_id,
      redo_round: 2,
      origin: "machine",
      reason: "test_restore",
      restore_verified: true,
    });
    assert.equal(
      deriveCommittedSubmissionView(directive!, [directive!], [directive!])
        .recovery_checkpoint,
      undefined,
      "the rollback directive's own receipt has no checkpoint",
    );
  });

  it("rebuilds the same shape from committed history", () => {
    const entry = committedFeedbackRound(1, {
      loopId: "receipt-history",
      files: ["src/a.ts"],
      discoveredConstraints: ["history constraint"],
    });
    const view = decodeCommittedRound(entry);
    assert.ok(view);
    const receipt = deriveCommittedSubmissionView(view!, [view!]);
    assert.equal(receipt.entered_history, true);
    assert.equal(receipt.record, "committed");
    assert.equal(
      receipt.reports.some((report) =>
        report.path === "discovered_constraints" && report.handling === "saved"),
      true,
    );
    assert.deepEqual(receipt.effects.constraints_declared, ["history constraint"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.2 — files reconciliation
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.2 — files reconciliation", () => {
  const CORE = [
    "success", "output_summary", "constraint_violations", "should_continue",
  ];
  const gitDelta = (changedFiles: string[] | null) => ({
    providerId: "git",
    kind: "git" as const,
    before: null,
    after: null,
    changedFiles,
    progress: null,
  });

  it("compares the report with the shared Git change set", () => {
    const receipt = deriveSubmissionReceipt(input({
      selfEval: makeSelfEvaluation({
        success: true,
        output_summary: "did the work",
        constraint_violations: [],
        should_continue: true,
        execution_report: makeExecutionReport({
          files_changed: ["a.ts"],
          tests_reported: null,
        }),
      }),
      submittedFields: [...CORE, "execution_report.files_changed"],
      evidenceDeltas: [gitDelta(["a.ts", "b.ts"])],
    }));
    assert.equal(receipt.files_reconciliation.status, "mismatch");
    assert.equal(receipt.files_reconciliation.attempted, true);
    assert.deepEqual(receipt.files_reconciliation.reported, ["a.ts"]);
    assert.deepEqual(receipt.files_reconciliation.observed, ["a.ts", "b.ts"]);
    assert.deepEqual(receipt.files_reconciliation.unreported, ["b.ts"]);
    assert.deepEqual(receipt.files_reconciliation.unconfirmed, []);
  });

  it("marks a no-Git round as not applicable", () => {
    const receipt = deriveSubmissionReceipt(input({
      selfEval: makeSelfEvaluation({
        success: true,
        output_summary: "did the work",
        constraint_violations: [],
        should_continue: true,
        execution_report: makeExecutionReport({ files_changed: [] }),
      }),
      submittedFields: [...CORE, "execution_report.files_changed"],
      evidenceDeltas: [],
    }));
    assert.equal(receipt.files_reconciliation.status, "not_applicable");
    assert.equal(receipt.files_reconciliation.observed, null);
  });

  it("rebuilds the same reconciliation from committed history", () => {
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
    const entry = committedFeedbackRound(1, {
      loopId: "receipt-files",
      files: ["a.ts"],
      beforeEvidence: [git("before", [], {})],
      roundEvidence: [git("after", ["a.ts"], { "a.ts": "m:1" })],
    });
    const view = decodeCommittedRound(entry);
    assert.ok(view);
    const receipt = deriveCommittedSubmissionView(view!, [view!]);
    assert.equal(receipt.files_reconciliation.status, "match");
    assert.deepEqual(receipt.files_reconciliation.observed, ["a.ts"]);
  });

  it("still derives reconciliation on a rejected attempt", () => {
    const receipt = deriveSubmissionReceipt(input({
      selfEval: makeSelfEvaluation({
        success: true,
        output_summary: "premature",
        constraint_violations: [],
        should_continue: true,
        execution_report: makeExecutionReport({ files_changed: ["a.ts"] }),
      }),
      pr: result({ action: "reject" }),
      disposition: "rejected",
      submittedFields: [...CORE, "execution_report.files_changed"],
      evidenceDeltas: [gitDelta(["a.ts", "b.ts"])],
    }));
    assert.equal(receipt.files_reconciliation.status, "mismatch");
    assert.deepEqual(receipt.files_reconciliation.unreported, ["b.ts"]);
    assert.ok(receipt.reports.every((entry) => entry.handling === "not_applied"));
  });
});
