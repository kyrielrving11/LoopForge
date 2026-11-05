/** v4.0.6 — one round conclusion (`outcome`), one stop semantic, and the
 *  removal of `tests_reported` from every surface. */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../mcp/session.js";
import { MemoryLoopStore } from "./_helpers.js";
import { resetPolicy } from "../policy.js";
import { TOOL_SCHEMAS } from "../mcp/tools.js";
import { allFieldGuidePaths } from "../submission-guidance.js";
import type { SubmissionReceipt } from "../protocol.js";

describe("v4.0.6 — outcome / blocker strictness", () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });
  afterEach(() => mgr.close());

  async function start(loopId: string) {
    return mgr.create({ task: `Task ${loopId}`, loopId });
  }

  it("success with should_continue=true is evaluation_invalid", async () => {
    const started = await start("outcome-success-continue");
    const handle = started.submissionHandle!;
    const before = store.listEntries("outcome-success-continue").length;
    const result = await mgr.advance(handle, "", {
      outcome: "success",
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(result.submissionError?.code, "evaluation_invalid");
    const invalid = (result.submissionError?.details as {
      invalid?: Array<{ field: string }>;
    }).invalid ?? [];
    assert.ok(invalid.some((entry) => entry.field === "outcome"));
    assert.deepEqual(result.submissionHandle, handle);
    assert.equal(mgr.get(started.sessionId)?.currentRound, 1);
    assert.equal(store.listEntries("outcome-success-continue").length, before);
  });

  it("blocked with should_continue=true is evaluation_invalid", async () => {
    const started = await start("outcome-blocked-continue");
    const result = await mgr.advance(started.submissionHandle!, "", {
      outcome: "blocked",
      output_summary: "blocked",
      constraint_violations: [],
      should_continue: true,
      blocker: "missing credentials",
    });
    assert.equal(result.submissionError?.code, "evaluation_invalid");
  });

  it("blocked requires a non-empty blocker", async () => {
    const started = await start("outcome-blocked-no-blocker");
    for (const blocker of [undefined, "", "   ", 42]) {
      const result = await mgr.advance(started.submissionHandle!, "", {
        outcome: "blocked",
        output_summary: "blocked",
        constraint_violations: [],
        should_continue: false,
        ...(blocker !== undefined ? { blocker } : {}),
      });
      assert.equal(result.submissionError?.code, "evaluation_invalid");
      const invalid = (result.submissionError?.details as {
        invalid?: Array<{ field: string }>;
      }).invalid ?? [];
      assert.ok(invalid.some((entry) => entry.field === "blocker"));
      assert.equal(mgr.get(started.sessionId)?.currentRound, 1);
    }
  });

  it("a non-blocked blocker is dropped with a diagnostic, not rejected", async () => {
    const started = await start("outcome-stray-blocker");
    const result = await mgr.advance(started.submissionHandle!, "", {
      outcome: "failed",
      output_summary: "still working",
      constraint_violations: [],
      should_continue: true,
      blocker: "this is not a blocked round",
    });
    assert.equal(result.submissionError, undefined);
    assert.equal(result.round, 2, "the round advances");
    const receipt = result.submission_receipt as SubmissionReceipt;
    assert.ok(receipt.reports.some((report) =>
      report.path === "blocker" && report.handling === "dropped"));
    assert.ok(receipt.diagnostics.some((diagnostic) =>
      diagnostic.path === "blocker" && diagnostic.handling === "dropped"));
  });

  it("a blocked stop commits the round and stops as blocked", async () => {
    const started = await start("outcome-blocked-stop");
    const result = await mgr.advance(started.submissionHandle!, "", {
      outcome: "blocked",
      output_summary: "cannot proceed",
      constraint_violations: [],
      should_continue: false,
      blocker: "needs a human decision on the target database",
    });
    assert.equal(result.stopReason, "blocked");
    assert.equal(result.agentOutcome, "blocked");
  });
});

describe("v4.0.6 — tests_reported is gone from every surface", () => {
  it("is absent from the MCP evaluation schema and the field guide", () => {
    const next = TOOL_SCHEMAS.find((tool) => tool.name === "loopforge_next")!;
    assert.ok(!allFieldGuidePaths().includes("execution_report.tests_reported"));
    const serialized = JSON.stringify(next.inputSchema);
    assert.ok(!serialized.includes("tests_reported"));
  });

  it("a submitted tests_reported is diagnosed and never retained or rendered", async () => {
    resetPolicy();
    const store = new MemoryLoopStore();
    const mgr = new SessionManager(store);
    try {
      const started = await mgr.create({
        task: "Legacy test counts",
        loopId: "tests-reported-retired",
      });
      const result = await mgr.advance(started.submissionHandle!, "", {
        outcome: "failed",
        output_summary: "ran the suite",
        constraint_violations: [],
        should_continue: true,
        execution_report: {
          files_changed: [],
          tests_reported: { passed: 9, failed: 1, skipped: 0 },
        },
      });
      assert.equal(result.submissionError, undefined, "a retired optional field never rejects");
      const receipt = result.submission_receipt as SubmissionReceipt;
      const retired = receipt.diagnostics.find((diagnostic) =>
        diagnostic.path === "execution_report.tests_reported" &&
        diagnostic.handling === "dropped");
      assert.ok(retired);
      assert.match(retired!.detail, /removed in 4\.0\.6/,
        "the diagnostic explains the removal instead of a generic drop");
      assert.ok(!receipt.reports.some((report) =>
        report.path === "execution_report.tests_reported" &&
        report.handling === "saved"));
      const feedback = store.listEntries("tests-reported-retired").find((entry) =>
        entry.task_type === "feedback");
      assert.ok(feedback);
      const snapshot = ((feedback!.loop_lineage as Record<string, unknown>)
        .round_transaction as Record<string, unknown>).snapshot as Record<string, unknown>;
      const evaluation = snapshot.evaluation as Record<string, unknown>;
      const report = evaluation.execution_report as Record<string, unknown>;
      assert.ok(!("tests_reported" in report),
        "the committed evaluation never carries the removed field");
    } finally {
      mgr.close();
    }
  });
});
