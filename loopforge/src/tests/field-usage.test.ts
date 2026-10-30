/** v3.9.1 — labeled field-opportunity samples.
 *
 * These are MECHANISM tests: they prove that a correctly reported opportunity
 * survives the real submission boundary and that a fabricated/unknown value is
 * diagnosed or rejected. They do not prove that a real agent will report the
 * opportunity — that requires the manual protocol in
 * `scripts/FIELD-USAGE-EVAL.md`, which is reported separately.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSelfEvaluation } from "../self-eval.js";
import { validateSubmission } from "../mcp/submission-boundary.js";
import { MemoryLoopStore } from "./_helpers.js";

const base = {
  success: false,
  output_summary: "made progress",
  constraint_violations: [],
  should_continue: true,
};

interface Opportunity {
  name: string;
  payload: Record<string, unknown>;
  field: string;
}

const OPPORTUNITIES: Opportunity[] = [
  {
    name: "a new constraint was discovered",
    payload: { discovered_constraints: ["commands must not touch prod"] },
    field: "discovered_constraints",
  },
  {
    name: "an earlier assumption was falsified",
    payload: { wrong_assumptions: ["the API was synchronous"] },
    field: "wrong_assumptions",
  },
  {
    name: "a worker returned a result",
    payload: {
      worker_results: [{
        agentId: "w1",
        subTask: "scan the module",
        resultSummary: "found the seam",
        outcome: "success",
      }],
    },
    field: "worker_results",
  },
  {
    name: "a subtask boundary was declared",
    payload: { subtask_boundary: true, subtask_boundary_label: "parser complete" },
    field: "subtask_boundary",
  },
  {
    name: "the round is blocked",
    payload: { outcome: "blocked", blocker: "missing credentials" },
    field: "outcome",
  },
];

describe("v3.9.1 — labeled field opportunities", () => {
  for (const opportunity of OPPORTUNITIES) {
    it(`accepts and preserves: ${opportunity.name}`, () => {
      const submission = { ...base, ...opportunity.payload };
      const boundary = validateSubmission(
        new MemoryLoopStore(),
        undefined,
        submission,
      );
      assert.equal(boundary.ok, true, "the real boundary accepts the payload");
      const normalized = normalizeSelfEvaluation(submission);
      assert.deepEqual(normalized.diagnostics, [],
        "a correctly reported opportunity needs no diagnostic");
      assert.ok(normalized.submittedFields.includes(opportunity.field),
        `the manifest records ${opportunity.field}`);
      assert.notEqual(
        (normalized.evaluation as unknown as Record<string, unknown>)[opportunity.field],
        undefined,
        "the value survives normalization",
      );
    });
  }

  it("keeps a control round with no events diagnostic-free", () => {
    const normalized = normalizeSelfEvaluation({ ...base });
    assert.deepEqual(normalized.diagnostics, []);
    assert.deepEqual(normalized.submittedFields, [
      "success", "output_summary", "constraint_violations", "should_continue",
    ]);
  });

  it("rejects a fabricated sg- id in the creation channel", () => {
    const boundary = validateSubmission(new MemoryLoopStore(), undefined, {
      ...base,
      emerged_subtasks: ["sg-12345678"],
    });
    assert.equal(boundary.ok, false);
    assert.equal(boundary.submissionError.code, "evaluation_invalid");
  });

  it("diagnoses a retired field while accepting the submission", () => {
    const submission = { ...base, progress_estimate: 0.7 };
    const boundary = validateSubmission(new MemoryLoopStore(), undefined, submission);
    assert.equal(boundary.ok, true);
    const normalized = normalizeSelfEvaluation(submission);
    assert.equal(normalized.diagnostics[0]?.path, "progress_estimate");
    assert.equal(normalized.diagnostics[0]?.handling, "dropped");
  });
});
