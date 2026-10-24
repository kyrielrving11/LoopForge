/** Tests for self-eval — structured normalization helpers. */
import { criterionClaims } from "./_helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSelfEvaluation,
  normalizeSelfEvaluation,
  parseExecutionReport,
  parseRoundContract,
  effectiveOutcome,
  validateCoreSelfEvaluation,
  validateContractShape,
} from "../self-eval.js";
import type { ContractValidationContext } from "../self-eval.js";

// ═══════════════════════════════════════════════════════════════════════════
// parseExecutionReport
// ═══════════════════════════════════════════════════════════════════════════

describe("parseExecutionReport", () => {
  it("parses valid execution evidence", () => {
    const result = parseExecutionReport({
      files_changed: ["a.ts", "b.ts"],
      tests_reported: { passed: 8, failed: 1, skipped: 2 },
      criterion_claims: criterionClaims(["reentrancy fixed"], ["access control"]),
    });
    assert.ok(result);
    assert.deepEqual(result!.files_changed, ["a.ts", "b.ts"]);
    assert.equal(result!.tests_reported!.passed, 8);
    assert.equal("progress_estimate" in result!, false);
  });

  it("returns undefined for null input", () => {
    assert.equal(parseExecutionReport(null), undefined);
  });

  it("returns undefined for undefined input", () => {
    assert.equal(parseExecutionReport(undefined), undefined);
  });

  it("ignores the removed progress_estimate field", () => {
    const result = parseExecutionReport({ progress_estimate: 1.5 });
    assert.equal("progress_estimate" in result!, false);
  });

  it("defaults missing tests_reported to null", () => {
    const result = parseExecutionReport({});
    assert.equal(result!.tests_reported, null);
  });

  it("filters non-string from files_changed", () => {
    const result = parseExecutionReport({
      files_changed: ["a.ts", 42, "b.ts"],
    });
    assert.deepEqual(result!.files_changed, ["a.ts", "b.ts"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildSelfEvaluation
// ═══════════════════════════════════════════════════════════════════════════

describe("buildSelfEvaluation", () => {
  it("builds from a complete raw object", () => {
    const raw: Record<string, unknown> = {
      success: true,
      output_summary: "Fixed 3 bugs",
      constraint_violations: [],
      should_continue: true,
      discovered_constraints: ["use SafeERC20"],
      emerged_subtasks: ["audit timelock"],
      execution_report: {
        files_changed: ["token.sol"],
        tests_reported: { passed: 10, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims(["no reentrancy"], []),
      },
      subgoal_updates: [{ id: "sg-aabbccdd", status: "done", note: "ship it" }],
    };
    const result = buildSelfEvaluation(raw);
    assert.equal(result.success, true);
    assert.equal(result.output_summary, "Fixed 3 bugs");
    assert.deepEqual(result.discovered_constraints, ["use SafeERC20"]);
    assert.deepEqual(result.emerged_subtasks, ["audit timelock"]);
    assert.ok(result.execution_report);
    assert.equal("progress_estimate" in result.execution_report!, false);
    assert.deepEqual(result.subgoal_updates, [{ id: "sg-aabbccdd", status: "done", note: "ship it" }]);
  });

  it("uses sensible defaults for missing fields", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "",
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(result.success, false);
    assert.deepEqual(result.discovered_constraints, []);
  });

  it("handles non-boolean success gracefully", () => {
    const result = buildSelfEvaluation({
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
    });
    assert.equal(result.success, false);
  });

  it("handles non-string output_summary gracefully", () => {
    const result = buildSelfEvaluation({
      success: true,
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(result.output_summary, "");
  });

  it("parses valid stop_reason", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
      stop_reason: "blocked",
    });
    assert.equal(result.stop_reason, "blocked");
  });

  it("ignores invalid stop_reason values", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
      stop_reason: "invalid_value",
    });
    assert.equal(result.stop_reason, undefined);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: Tri-state outcome / blocker / retroactive claims
// ═══════════════════════════════════════════════════════════════════════════

describe("v2.12 outcome parsing", () => {
  it("preserves a valid declared outcome", () => {
    const eval_ = buildSelfEvaluation({ success: true, outcome: "partial" });
    assert.equal(eval_.outcome, "partial");
  });

  it("falls back to derivation on an invalid outcome value", () => {
    const eval_ = buildSelfEvaluation({ success: true, outcome: "completed" });
    assert.equal(eval_.outcome, undefined);
    assert.equal(effectiveOutcome(eval_), "success");
  });

  it("derives success/failed from the boolean when outcome is absent", () => {
    assert.equal(effectiveOutcome(buildSelfEvaluation({ success: true })), "success");
    assert.equal(effectiveOutcome(buildSelfEvaluation({ success: false })), "failed");
  });

  it("never silently derives partial from success=false", () => {
    assert.equal(effectiveOutcome(buildSelfEvaluation({ success: false })), "failed");
  });

  it("trims empty blocker to undefined", () => {
    assert.equal(buildSelfEvaluation({ blocker: "   " }).blocker, undefined);
    assert.equal(buildSelfEvaluation({ blocker: "waiting on CI" }).blocker, "waiting on CI");
  });

  it("filters retroactive claims (bad round / empty claim / cap 20)", () => {
    const claims = buildSelfEvaluation({
      retroactiveClaims: [
        { round: 0, claim: "bad round" },
        { round: 3, claim: "" },
        { round: 2, claim: "valid" },
      ],
    }).retroactiveClaims;
    assert.deepEqual(claims, [{ round: 2, claim: "valid" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: Tolerant field diagnostics
// ═══════════════════════════════════════════════════════════════════════════

describe("core evaluation validation", () => {
  it("reports only required field gaps", () => {
    const validation = validateCoreSelfEvaluation({
      success: "yes", // wrong type
      output_summary: "ok",
      constraint_violations: "not-array",
      should_continue: true,
      outcome: 42, // wrong type
    });
    assert.deepEqual(validation.missing, []);
    assert.deepEqual(validation.invalid.map((g) => g.field).sort(), ["constraint_violations", "success"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — round_contract parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — round_contract parsing", () => {
  it("parseRoundContract: lenient field filtering and capping", () => {
    const parsed = parseRoundContract({
      work_item: "Implement auth",
      scope: ["src/auth", null],
      items: [
        {
          description: "login works",
          criterion_refs: ["cr-auth-login", 42],
          verify_with: ["run-tests"],
        },
        "not an object",
      ],
    });
    assert.equal(parsed?.items.length, 1);
    assert.deepEqual(parsed?.items[0].criterion_refs, ["cr-auth-login"]);
    assert.deepEqual(parsed?.items[0].verify_with, ["run-tests"]);
    assert.deepEqual(parsed?.scope, ["src/auth"]);
    assert.equal(parsed?.work_item, "Implement auth");
  });

  it("parseRoundContract: caps overlong items and array lengths", () => {
    const long = "x".repeat(300);
    const parsed = parseRoundContract({
      work_item: long,
      items: Array.from({ length: 30 }, (_, i) => ({ description: `item ${i}`, criterion_refs: [], verify_with: [] })),
    });
    assert.equal(parsed?.items.length, 20, "items capped at 20");
    assert.equal(parsed?.work_item?.length, 200, "strings capped at 200");
  });

  it("parseRoundContract: absent or non-object → undefined; empty object is diagnosed and dropped", () => {
    assert.equal(parseRoundContract(undefined), undefined);
    assert.equal(parseRoundContract("not an object"), undefined);
    assert.equal(parseRoundContract(42), undefined);
    const diagnostics: Array<{ path: string; code: string; handling: string }> = [];
    const empty = parseRoundContract({}, {
      push: (path, code, handling) => { diagnostics.push({ path, code, handling }); },
    });
    assert.equal(empty, undefined);
    assert.ok(diagnostics.some((entry) =>
      entry.path === "round_contract" && entry.handling === "dropped"),
      "an empty contract is an attempted field that did not survive");
  });

  it("buildSelfEvaluation carries round_contract through and defaults absent", () => {
    const withContract = buildSelfEvaluation({
      success: false,
      output_summary: "x",
      constraint_violations: [],
      should_continue: true,
      round_contract: {
        work_item: "auth",
        scope: [],
        items: [{ description: "done", criterion_refs: [], verify_with: ["run-tests"] }],
      },
    });
    assert.equal(withContract.round_contract?.work_item, "auth");
    assert.equal(withContract.round_contract?.items[0].description, "done");
    const without = buildSelfEvaluation({
      success: false,
      output_summary: "x",
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(without.round_contract, undefined);
  });
});

describe("v3.7.1 — worker_results parsing (outcome is the single fact)", () => {
  function build(worker_results: unknown) {
    return buildSelfEvaluation({
      success: false,
      output_summary: "x",
      constraint_violations: [],
      should_continue: true,
      worker_results,
    });
  }

  it("accepts an absent worker_results array (the main agent did not delegate)", () => {
    const absent = build(undefined);
    assert.deepEqual(absent.worker_results, []);
    const empty = build([]);
    assert.deepEqual(empty.worker_results, []);
  });

  it("keeps entries with a valid declared outcome", () => {
    const se = build([{
      agentId: "w1",
      subTask: "scan",
      resultSummary: "found seams",
      outcome: "partial",
      discoveredConstraints: ["x"],
    }]);
    assert.equal(se.worker_results?.length, 1);
    assert.equal(se.worker_results?.[0].outcome, "partial");
  });

  it("drops an entry without a valid outcome — never derives, never rejects the round", () => {
    const se = build([
      {
        agentId: "w-legacy",
        subTask: "scan",
        resultSummary: "legacy shape",
        // success: true was deleted in v3.7.1; an outcome-less entry is unclassifiable.
      },
      { agentId: "w2", subTask: "scan", resultSummary: "ok", outcome: "failed" },
      { agentId: "w3", subTask: "scan", resultSummary: "bad enum", outcome: "blocked" },
    ]);
    assert.equal(se.worker_results?.length, 1);
    assert.equal(se.worker_results?.[0].agentId, "w2");
  });

  it("keeps existing caps", () => {
    const se = build([{
      agentId: "w1",
      subTask: "scan",
      resultSummary: "r".repeat(2000),
      outcome: "success",
    }]);
    assert.equal(se.worker_results?.[0].resultSummary.length, 1000);
  });

  it("caps the number of parsed worker entries at 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      agentId: `w${i}`, subTask: "t", resultSummary: "s", outcome: "success" as const,
    }));
    assert.equal(build(many).worker_results?.length, 20);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.8 — strict contract declaration boundary (contract_invalid)
// ═══════════════════════════════════════════════════════════════════════════

describe("validateContractShape", () => {
  const known = (name: string) => name === "verify";
  const context = (
    overrides: Partial<ContractValidationContext> = {},
  ): ContractValidationContext => ({
    activeItemIds: null,
    knownCriterionIds: null,
    isConfiguredCommand: known,
    ...overrides,
  });
  const check = (
    raw: Record<string, unknown>,
    overrides: Partial<ContractValidationContext> = {},
  ) => validateContractShape(raw, context(overrides));
  const claim = (item_id: string, outcome = "met") => ({
    execution_report: { contract_item_claims: [{ item_id, outcome }] },
  });
  const item = (overrides: Record<string, unknown> = {}) => ({
    description: "works", criterion_refs: [], verify_with: ["verify"], ...overrides,
  });

  it("accepts a well-formed declaration", () => {
    assert.deepEqual(check({
      round_contract: {
        work_item: "Slice",
        scope: ["src/a"],
        items: [item({ criterion_refs: ["cr-11111111"] })],
      },
    }), []);
  });

  it("v3.9.5: requires a non-empty, bounded work_item and scope", () => {
    const missing = check({ round_contract: { scope: [], items: [item()] } });
    assert.equal(missing[0]?.reason, "missing_work_item");
    const invalid = check({ round_contract: { work_item: 42, scope: [], items: [item()] } });
    assert.equal(invalid[0]?.reason, "invalid_work_item");
    const empty = check({ round_contract: { work_item: "   ", scope: [], items: [item()] } });
    assert.equal(empty[0]?.reason, "empty_work_item");
    const long = check({ round_contract: { work_item: "x".repeat(201), scope: [], items: [item()] } });
    assert.equal(long[0]?.reason, "work_item_too_long");
    const noScope = check({ round_contract: { work_item: "Slice", items: [item()] } });
    assert.deepEqual(noScope, [], "v3.9.9: scope is optional and report-only");
    assert.deepEqual(
      check({ round_contract: { work_item: "x".repeat(200), scope: [], items: [item()] } }),
      [],
      "200 characters is accepted",
    );
  });

  it("v3.9.5: rejects unknown contract/item fields and long descriptions", () => {
    const unknownTop = check({
      round_contract: {
        work_item: "Slice", scope: [], items: [item()], verify_with: ["verify"],
      },
    });
    assert.equal(unknownTop[0]?.reason, "unknown_field");
    const unknownItem = check({
      round_contract: {
        work_item: "Slice", scope: [], items: [item({ work_item: "nested" })],
      },
    });
    assert.equal(unknownItem[0]?.reason, "unknown_field");
    const longDescription = check({
      round_contract: {
        work_item: "Slice", scope: [], items: [item({ description: "x".repeat(201) })],
      },
    });
    assert.equal(longDescription[0]?.reason, "item_description_too_long");
    assert.deepEqual(
      check({
        round_contract: {
          work_item: "Slice", scope: [], items: [item({ description: "x".repeat(200) })],
        },
      }),
      [],
      "200-character item description is accepted",
    );
  });

  it("v3.9.5: does not semantically judge work_item or item descriptions", () => {
    assert.deepEqual(
      check({
        round_contract: {
          work_item: "edit src/auth.ts",
          scope: [],
          items: [item({ description: "the file is edited", verify_with: ["verify"] })],
        },
      }),
      [],
      "structure/binding are valid, so no semantic rejection is invented",
    );
  });

  it("rejects a declaration with no items", () => {
    const errors = check({ round_contract: { work_item: "Slice", scope: [], items: [] } });
    assert.equal(errors[0]?.reason, "no_items");
  });

  it("rejects an item that binds no command or an unknown one", () => {
    const none = check({ round_contract: { work_item: "Slice", scope: [], items: [item({ verify_with: [] })] } });
    assert.equal(none[0]?.reason, "no_verify_with");
    const unknown = check({ round_contract: { work_item: "Slice", scope: [], items: [item({ verify_with: ["nope"] })] } });
    assert.equal(unknown[0]?.reason, "unknown_command");
  });

  it("enforces the item and ref count limits at the boundary", () => {
    // Limits used to be enforced only by silently truncating in the lenient
    // parser — a declaration over the cap simply lost its tail.
    const tooMany = check({
      round_contract: {
        work_item: "Slice",
        scope: [],
        items: Array.from({ length: 21 }, (_, i) => item({ description: `i${i}` })),
      },
    });
    assert.equal(tooMany[0]?.reason, "too_many_items");
    const tooManyRefs = check({
      round_contract: {
        work_item: "Slice",
        scope: [],
        items: [item({ verify_with: Array.from({ length: 21 }, () => "verify") })],
      },
    });
    assert.equal(tooManyRefs[0]?.reason, "too_many_verify_with");
  });

  it("treats scope as optional, lenient, report-only intent", () => {
    // v3.9.9: a scope is no longer a trust boundary. A non-array, non-string
    // entries, a path outside the workspace, or an omitted scope must never
    // reject the declaration.
    assert.deepEqual(
      check({ round_contract: { work_item: "Slice", scope: "src/a", items: [item()] } }),
      [],
    );
    assert.deepEqual(
      check({ round_contract: { work_item: "Slice", scope: ["src/a", 7], items: [item()] } }),
      [],
    );
    assert.deepEqual(
      check({ round_contract: { work_item: "Slice", scope: ["../outside"], items: [item()] } }),
      [],
    );
    assert.deepEqual(
      check({ round_contract: { work_item: "Slice", items: [item()] } }),
      [],
      "omitting scope is legal",
    );
    const diagnostics: Array<{ path: string; code: string }> = [];
    const proposal = parseRoundContract({
      work_item: "Slice",
      scope: ["src/a", 7, "", "  "],
      items: [item()],
    }, {
      push: (path, code) => diagnostics.push({ path, code }),
    });
    assert.deepEqual(proposal?.scope, ["src/a"], "invalid entries are dropped");
    assert.ok(diagnostics.some((entry) =>
      entry.path === "round_contract.scope[]" && entry.code === "invalid_entry"));
  });

  it("rejects non-string criterion refs instead of dropping them", () => {
    const errors = check({
      round_contract: { work_item: "Slice", scope: [], items: [item({ criterion_refs: ["cr-11111111", 42] })] },
    });
    assert.equal(errors[0]?.reason, "invalid_criterion_ref");
  });

  it("rejects malformed item ids, duplicates, and unknown active items", () => {
    const malformed = check(claim("nope"));
    assert.equal(malformed[0]?.reason, "invalid_item_id");
    const duplicate = check({
      execution_report: { contract_item_claims: [
        { item_id: "rci-11111111", outcome: "met" },
        { item_id: "rci-11111111", outcome: "remaining" },
      ] },
    });
    assert.equal(duplicate[0]?.reason, "duplicate_item_id");
    const unknownItem = check(claim("rci-22222222"), {
      activeItemIds: new Set(["rci-11111111"]),
    });
    assert.equal(unknownItem[0]?.reason, "unknown_item_id");
  });

  it("rejects an illegal outcome", () => {
    const errors = check(claim("rci-11111111", "maybe"));
    assert.equal(errors[0]?.reason, "invalid_outcome");
  });

  it("stays silent when neither field is present", () => {
    assert.deepEqual(check({}), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.1 — normalization diagnostics
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.1 — normalization diagnostics", () => {
  const base = {
    success: true,
    output_summary: "done",
    constraint_violations: [],
    should_continue: false,
  };

  it("diagnoses and drops unknown/retired fields", () => {
    const result = normalizeSelfEvaluation({
      ...base,
      progress_estimate: 0.5,
      bogus_field: "x",
    });
    assert.equal("progress_estimate" in result.evaluation, false);
    assert.equal("bogus_field" in result.evaluation, false);
    const paths = result.diagnostics.map((item) => item.path);
    assert.deepEqual(paths, ["bogus_field", "progress_estimate"],
      "unknown keys are sorted and deterministic");
    for (const diagnostic of result.diagnostics) {
      assert.equal(diagnostic.code, "unknown_field");
      assert.equal(diagnostic.handling, "dropped");
    }
    assert.ok(result.diagnostics.find((item) => item.path === "progress_estimate")
      ?.detail.includes("removed in 3.9.0"));
    assert.ok(!result.submittedFields.includes("progress_estimate"));
  });

  it("v4.0.1: diagnoses the removed prompt channels", () => {
    const result = normalizeSelfEvaluation({
      ...base,
      prompt_requests: { emphasize: ["x"] },
      objective_refinement: "a newer understanding",
    });
    assert.equal("prompt_requests" in result.evaluation, false);
    assert.equal("objective_refinement" in result.evaluation, false);
    assert.ok(!result.submittedFields.includes("prompt_requests"));
    assert.ok(!result.submittedFields.includes("objective_refinement"));
    const details = new Map(
      result.diagnostics.map((item) => [item.path, item.detail]),
    );
    assert.match(details.get("prompt_requests") ?? "", /removed in 4\.0\.1/);
    assert.match(details.get("objective_refinement") ?? "", /removed in 4\.0\.1/);
  });

  it("diagnoses wrong types, caps, truncation and invalid enums", () => {
    const result = normalizeSelfEvaluation({
      ...base,
      discovered_constraints: "not an array",
      emerged_subtasks: [1, "ok"],
      retracted_constraints: Array.from({ length: 55 }, (_, index) => `c${index}`),
      wrong_assumptions: ["x".repeat(600)],
      outcome: "maybe",
      execution_report: {
        files_changed: "not an array",
        tests_reported: { passed: "many", failed: -1 },
        unknown_report_key: true,
      },
      worker_results: [
        { agentId: "w1", subTask: "s", resultSummary: "r", outcome: "success" },
        { agentId: "w2" },
      ],
    });
    const byPath = new Map(result.diagnostics.map((item) => [item.path, item]));
    assert.equal(byPath.get("discovered_constraints")?.code, "not_array");
    assert.equal(byPath.get("emerged_subtasks")?.code, "invalid_entry");
    assert.equal(byPath.get("retracted_constraints")?.code, "too_many");
    assert.equal(byPath.get("wrong_assumptions")?.code, "truncated");
    assert.equal(byPath.get("outcome")?.code, "invalid_enum");
    assert.equal(byPath.get("execution_report.files_changed")?.code, "not_array");
    assert.equal(byPath.get("execution_report.tests_reported")?.code, "invalid_value");
    assert.equal(byPath.get("execution_report.unknown_report_key")?.code, "unknown_field");
    assert.equal(byPath.get("worker_results")?.code, "invalid_entry");
  });

  it("keeps a valid payload diagnostic-free and deterministic", () => {
    const raw = {
      ...base,
      discovered_constraints: ["no prod"],
      execution_report: {
        files_changed: ["src/a.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
      },
    };
    const a = normalizeSelfEvaluation(raw);
    const b = normalizeSelfEvaluation(raw);
    assert.deepEqual(a.diagnostics, []);
    assert.deepEqual(a.submittedFields, b.submittedFields);
    assert.deepEqual(a.evaluation, b.evaluation);
    assert.ok(a.submittedFields.includes("execution_report.files_changed"));
  });

  it("diagnoses a malformed execution_report object", () => {
    const result = normalizeSelfEvaluation({ ...base, execution_report: "nope" });
    assert.equal(result.diagnostics[0]?.path, "execution_report");
    assert.equal(result.diagnostics[0]?.code, "invalid_entry");
    assert.equal(result.evaluation.execution_report, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.2 — criterion claim reference filtering
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.2 — criterion claim reference filtering", () => {
  const core = {
    success: false,
    output_summary: "made progress",
    constraint_violations: [],
    should_continue: true,
  };
  const known = { id: "cr-12345678", text: "All tests pass" };
  const payload = (claims: Array<{ criterion_id: string; outcome: string }>) => ({
    ...core,
    execution_report: { criterion_claims: claims },
  });

  it("drops an unknown reference with an all-entries diagnostic", () => {
    const result = normalizeSelfEvaluation(
      payload([{ criterion_id: "cr-deadbeef", outcome: "met" }]),
      { knownCriterionRefs: [known] },
    );
    assert.deepEqual(result.evaluation.execution_report?.criterion_claims, []);
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.path === "execution_report.criterion_claims" &&
      diagnostic.code === "all_entries_dropped" &&
      diagnostic.handling === "dropped"));
  });

  it("keeps a real id and an exact criterion text", () => {
    const result = normalizeSelfEvaluation(
      payload([
        { criterion_id: "cr-12345678", outcome: "met" },
        { criterion_id: "All tests pass", outcome: "remaining" },
      ]),
      { knownCriterionRefs: [known] },
    );
    assert.equal(result.evaluation.execution_report?.criterion_claims?.length, 2);
    assert.deepEqual(result.diagnostics, []);
  });

  it("drops only the unknown part of a mixed payload", () => {
    const result = normalizeSelfEvaluation(
      payload([
        { criterion_id: "cr-12345678", outcome: "met" },
        { criterion_id: "cr-deadbeef", outcome: "remaining" },
      ]),
      { knownCriterionRefs: [known] },
    );
    assert.deepEqual(result.evaluation.execution_report?.criterion_claims, [
      { criterion_id: "cr-12345678", outcome: "met" },
    ]);
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.path === "execution_report.criterion_claims" &&
      diagnostic.code === "unknown_id" &&
      diagnostic.handling === "dropped"));
  });

  it("fails open when the reference space is unobservable", () => {
    const result = normalizeSelfEvaluation(
      payload([{ criterion_id: "cr-deadbeef", outcome: "met" }]),
      { knownCriterionRefs: null },
    );
    assert.equal(result.evaluation.execution_report?.criterion_claims?.length, 1);
    assert.deepEqual(result.diagnostics, []);
  });

  it("drops every claim when the reference space is observed and empty", () => {
    const result = normalizeSelfEvaluation(
      payload([{ criterion_id: "cr-12345678", outcome: "met" }]),
      { knownCriterionRefs: [] },
    );
    assert.deepEqual(result.evaluation.execution_report?.criterion_claims, []);
    assert.ok(result.diagnostics.some((diagnostic) =>
      diagnostic.code === "all_entries_dropped"));
  });
});
