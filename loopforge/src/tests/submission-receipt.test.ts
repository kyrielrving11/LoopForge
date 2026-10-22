/** v3.9.1 — submission receipts: saved reports, effects, verification. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveCommittedSubmissionView,
  deriveSubmissionReceipt,
} from "../submission-receipt.js";
import type { ReceiptInput } from "../submission-receipt.js";
import { makeExecutionReport, makeSelfEvaluation } from "../protocol.js";
import type {
  PromptArtifact,
  SubGoal,
  SubmissionReceipt,
} from "../protocol.js";
import type { RoundProcessResult } from "../round-coordinator.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import { committedFeedbackRound } from "./_helpers.js";
import { decodeCommittedRound } from "../committed-round.js";
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
    roundSuccess: true,
    gateContradicted: false,
    verificationStatus: "trusted",
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
    schemaVersion: 4,
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
    evaluation: selfEval,
    result: pr,
    createdAt: 0,
    updatedAt: 0,
  } as RoundTransactionSnapshot;
  const artifact: PromptArtifact = {
    schemaVersion: 5,
    roundId: "loop:receipt:round:2",
    round: 2,
    attempt: 1,
    level: "l1",
    renderedPrompt: "next",
    promptHash: "h",
    stateHash: "s",
    sections: [],
    droppedSections: [],
    protectedOverflow: false,
    budget: 0,
    renderedChars: 0,
    promptRequestEffects: [{
      field: "emphasize",
      request: "never touch prod",
      status: "applied",
    }],
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
    },
    nextArtifact: artifact,
    contractItems: [{ item_id: "rci-12345678", status: "verified" }],
    evidenceDeltas: [],
    ...overrides,
  };
}

function report(receipt: SubmissionReceipt, path: string) {
  return receipt.reports.find((entry) => entry.path === path);
}

afterEach(() => resetPolicy());

describe("v3.9.1 — submission receipt", () => {
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
    assert.equal(receipt.verification.contract_status, "trusted");
    assert.equal(receipt.verification.evidence_status, "absent");
    assert.deepEqual(receipt.verification.contract_items.map((item) => item.status),
      ["verified"]);
    assert.equal(receipt.prompt?.prompt_request_effects[0]?.status, "applied");
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
      backtrackTarget: 1,
      backtrackSkippedDiscoveries: ["a preserved finding"],
      backtrackWrongAssumptions: ["the API was synchronous"],
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
      },
    }));
    assert.equal(receipt.entered_history, false);
    assert.equal(receipt.record, "rollback_directive");
    assert.equal(report(receipt, "wrong_assumptions")?.handling, "saved");
    assert.equal(report(receipt, "discovered_constraints")?.handling, "not_applied");
    assert.equal(receipt.effects.rollback?.restore_point, 1);
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
        compression_checkpoint: false,
      }),
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
        "compression_checkpoint",
      ],
      diagnostics: [{
        path: "compression_checkpoint",
        code: "invalid_value",
        handling: "dropped",
        detail: "expected a boolean",
      }],
    }));
    assert.equal(report(receipt, "compression_checkpoint")?.handling, "dropped");
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
