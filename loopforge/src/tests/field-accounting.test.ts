/** Field accounting: attempted (raw presence) vs retained (normalized value).
 *
 * The table below drives every FIELD_ORDER path through a valid, a partial
 * loss, and a whole-field loss. The invariant is: an attempted path is either
 * retained or has an exact-path whole-field drop diagnostic; an unexplained
 * attempted path makes the accounting incomplete. That is what keeps the
 * usage metric from counting malformed payloads as field use.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeSelfEvaluation } from "../self-eval.js";
import { deriveFieldAccounting } from "../field-accounting.js";
import { FIELD_ORDER, type FieldPath } from "../submission-guidance.js";
import { makeSelfEvaluation } from "../protocol.js";
import type { SubmissionDiagnostic } from "../protocol.js";

const BASE = {
  success: false,
  output_summary: "made progress",
  constraint_violations: [],
  should_continue: true,
};

function account(raw: Record<string, unknown>) {
  const normalized = normalizeSelfEvaluation({ ...BASE, ...raw });
  const accounting = deriveFieldAccounting({
    submittedFields: normalized.submittedFields,
    normalizationDiagnostics: normalized.diagnostics,
    evaluation: normalized.evaluation,
  });
  return { normalized, accounting };
}

function rawFor(path: FieldPath, value: unknown): Record<string, unknown> {
  if (path.startsWith("execution_report.")) {
    return {
      execution_report: {
        [path.slice("execution_report.".length)]: value,
      },
    };
  }
  return { [path]: value };
}

const VALID_ITEM = {
  description: "works",
  criterion_refs: [],
  verify_with: ["verify"],
};
const VALID_CONTRACT = {
  work_item: "slice",
  scope: [],
  items: [VALID_ITEM],
};
const VALID_WORKER = {
  agentId: "w1",
  subTask: "scan",
  resultSummary: "found the seam",
  outcome: "success",
};

interface FieldCase {
  path: FieldPath;
  valid: unknown;
  invalid: unknown;
  partial?: unknown;
}

const CASES: FieldCase[] = [
  { path: "success", valid: true, invalid: "yes" },
  { path: "output_summary", valid: "done", invalid: 42 },
  { path: "constraint_violations", valid: ["violated"], invalid: "not-array", partial: ["violated", 1] },
  { path: "should_continue", valid: false, invalid: "yes" },
  {
    path: "execution_report.files_changed",
    valid: ["src/a.ts"],
    invalid: "not-array",
    partial: ["src/a.ts", 1],
  },
  {
    path: "execution_report.tests_reported",
    valid: { passed: 1 },
    invalid: "not-an-object",
  },
  {
    path: "execution_report.contract_item_claims",
    valid: [{ item_id: "rci-12345678", outcome: "met" }],
    invalid: "not-array",
    partial: [{ item_id: "rci-12345678", outcome: "met" }, 1],
  },
  {
    path: "execution_report.criterion_claims",
    valid: [{ criterion_id: "criterion-a", outcome: "met" }],
    invalid: "not-array",
    partial: [{ criterion_id: "criterion-a", outcome: "met" }, 1],
  },
  {
    path: "subgoal_updates",
    valid: [{ id: "sg-12345678", status: "done" }],
    invalid: "not-array",
    partial: [{ id: "sg-12345678", status: "done" }, 1],
  },
  {
    path: "emerged_subtasks",
    valid: ["new slice"],
    invalid: "not-array",
    partial: ["new slice", 1],
  },
  {
    path: "discovered_constraints",
    valid: ["never touch prod"],
    invalid: "not-array",
    partial: ["never touch prod", 1],
  },
  {
    path: "wrong_assumptions",
    valid: ["the API was synchronous"],
    invalid: "not-array",
    partial: ["the API was synchronous", 1],
  },
  {
    path: "retracted_constraints",
    valid: ["old constraint"],
    invalid: "not-array",
    partial: ["old constraint", 1],
  },
  { path: "round_contract", valid: VALID_CONTRACT, invalid: null },
  {
    path: "contract_transition",
    valid: {
      kind: "supersede",
      contract_id: "rc-12345678",
      reason: "the active slice is not the right route",
    },
    invalid: null,
  },
  {
    path: "worker_results",
    valid: [VALID_WORKER],
    invalid: "not-array",
    partial: [VALID_WORKER, 1],
  },
  { path: "compression_checkpoint", valid: true, invalid: "yes" },
  { path: "checkpoint_label", valid: "parser complete", invalid: 42 },
  {
    path: "retroactiveClaims",
    valid: [{ round: 1, claim: "fixed it" }],
    invalid: "not-array",
    partial: [{ round: 1, claim: "fixed it" }, 1],
  },
  { path: "gate_ids", valid: ["g-1"], invalid: "not-array", partial: ["g-1", 1] },
  { path: "outcome", valid: "success", invalid: "nope" },
  { path: "blocker", valid: "missing credentials", invalid: 42 },
  { path: "stop_reason", valid: "blocked", invalid: "nope" },
  { path: "no_change_reason", valid: "nothing to change", invalid: "" },
];

describe("field accounting — per-path invariant matrix", () => {
  it("has a case for every FIELD_ORDER path", () => {
    assert.equal(CASES.length, FIELD_ORDER.length);
    assert.deepEqual(CASES.map((entry) => entry.path), [...FIELD_ORDER]);
  });

  for (const entry of CASES) {
    it(`${entry.path}: valid → retained; invalid → whole-field drop`, () => {
      const valid = account(rawFor(entry.path, entry.valid));
      assert.ok(valid.normalized.submittedFields.includes(entry.path),
        "the path is attempted");
      assert.ok(valid.accounting.retained.includes(entry.path),
        "a valid value survives");
      assert.equal(valid.accounting.incomplete, false,
        "no unexplained attempted path");

      const invalid = account(rawFor(entry.path, entry.invalid));
      assert.ok(invalid.normalized.submittedFields.includes(entry.path),
        "the invalid value is still an attempt");
      assert.ok(!invalid.accounting.retained.includes(entry.path),
        "an invalid value is not retained");
      assert.equal(invalid.accounting.incomplete, false,
        "the normalizer explains the loss");
      assert.ok(invalid.normalized.diagnostics.some((diagnostic) =>
        diagnostic.path === entry.path && diagnostic.handling === "dropped"),
      "the loss is diagnosed at the exact field path");
    });

    if (entry.partial !== undefined) {
      it(`${entry.path}: partial loss stays retained`, () => {
        const partial = account(rawFor(entry.path, entry.partial));
        assert.ok(partial.normalized.submittedFields.includes(entry.path));
        assert.ok(partial.accounting.retained.includes(entry.path),
          "at least one entry survived");
        assert.equal(partial.accounting.incomplete, false,
          "a partial loss is not an accounting failure");
        assert.ok(partial.normalized.diagnostics.some((diagnostic) =>
          diagnostic.path === entry.path && diagnostic.handling === "dropped"),
        "the partial loss is still visible");
      });
    }
  }
});

describe("field accounting — empty and null semantics", () => {
  it("retains legitimate empty arrays and empty strings", () => {
    for (const raw of [
      { discovered_constraints: [] },
      { wrong_assumptions: [] },
      { execution_report: { files_changed: [] } },
      { checkpoint_label: "" },
    ]) {
      const { normalized, accounting } = account(raw);
      const path = Object.keys(raw)[0] === "execution_report"
        ? "execution_report.files_changed"
        : Object.keys(raw)[0] as FieldPath;
      assert.ok(normalized.submittedFields.includes(path));
      assert.ok(accounting.retained.includes(path), `${path} is an explicit empty value`);
      assert.equal(accounting.incomplete, false);
    }
  });

  it("retains explicit tests_reported: null but not an absent key", () => {
    const nullTests = account({ execution_report: { tests_reported: null } });
    assert.ok(nullTests.normalized.submittedFields.includes("execution_report.tests_reported"));
    assert.ok(nullTests.accounting.retained.includes("execution_report.tests_reported"));

    const absent = account({});
    assert.ok(!absent.normalized.submittedFields.includes("execution_report.tests_reported"));
  });

  it("drops an empty blocker / no_change_reason", () => {
    for (const [path, raw] of [
      ["blocker", { blocker: "" }],
      ["no_change_reason", { no_change_reason: "" }],
    ] as const) {
      const { normalized, accounting } = account(raw);
      assert.ok(normalized.submittedFields.includes(path));
      assert.ok(!accounting.retained.includes(path));
      assert.equal(accounting.incomplete, false);
    }
  });

  it("keeps a contract with valid items but an invalid sub-field", () => {
    const { accounting } = account({
      round_contract: { work_item: 42, scope: "not-an-array", items: [VALID_ITEM] },
    });
    assert.ok(accounting.retained.includes("round_contract"),
      "the proposal survived because its items are valid");
    assert.equal(accounting.incomplete, false);
  });
});

describe("field accounting — incomplete states", () => {
  it("marks a missing evaluation incomplete and retains nothing", () => {
    const accounting = deriveFieldAccounting({
      submittedFields: ["success", "output_summary", "constraint_violations", "should_continue"],
      normalizationDiagnostics: [],
      evaluation: null,
    });
    assert.deepEqual(accounting.retained, []);
    assert.equal(accounting.incomplete, true);
  });

  it("under truncated diagnostics only positive values are retained", () => {
    const evaluation = makeSelfEvaluation({
      success: false,
      output_summary: "",
      constraint_violations: [],
      should_continue: true,
      discovered_constraints: [],
    });
    const diagnostics: SubmissionDiagnostic[] = [{
      path: "diagnostics",
      code: "diagnostics_truncated",
      handling: "truncated",
      detail: "loss list was truncated",
    }];
    const accounting = deriveFieldAccounting({
      submittedFields: [
        "success", "output_summary", "constraint_violations", "should_continue",
        "discovered_constraints",
      ],
      normalizationDiagnostics: diagnostics,
      evaluation,
    });
    assert.equal(accounting.incomplete, true);
    assert.ok(accounting.retained.includes("success"));
    assert.ok(accounting.retained.includes("should_continue"));
    assert.ok(!accounting.retained.includes("discovered_constraints"),
      "an empty value is uncertain when the loss list is truncated");
  });

  it("marks an unknown attempted path incomplete", () => {
    const accounting = deriveFieldAccounting({
      submittedFields: ["not_a_declared_field"],
      normalizationDiagnostics: [],
      evaluation: makeSelfEvaluation(BASE),
    });
    assert.equal(accounting.incomplete, true);
  });
});
