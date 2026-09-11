/** Tests for self-eval — structured normalization helpers. */
import { criterionClaims } from "./_helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSelfEvaluation,
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
      progress_estimate: 0.5,
    });
    assert.ok(result);
    assert.deepEqual(result!.files_changed, ["a.ts", "b.ts"]);
    assert.equal(result!.tests_reported!.passed, 8);
    assert.equal(result!.progress_estimate, 0.5);
  });

  it("returns undefined for null input", () => {
    assert.equal(parseExecutionReport(null), undefined);
  });

  it("returns undefined for undefined input", () => {
    assert.equal(parseExecutionReport(undefined), undefined);
  });

  it("clamps progress_estimate to [0, 1]", () => {
    const high = parseExecutionReport({ progress_estimate: 1.5 });
    assert.equal(high!.progress_estimate, 1);
    const low = parseExecutionReport({ progress_estimate: -0.5 });
    assert.equal(low!.progress_estimate, 0);
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
      objective_refinement: "scope expanded",
      emerged_subtasks: ["audit timelock"],
      execution_report: {
        files_changed: ["token.sol"],
        tests_reported: { passed: 10, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims(["no reentrancy"], []),
        progress_estimate: 0.3,
      },
      subgoal_updates: [{ id: "sg-aabbccdd", status: "done", note: "ship it" }],
    };
    const result = buildSelfEvaluation(raw);
    assert.equal(result.success, true);
    assert.equal(result.output_summary, "Fixed 3 bugs");
    assert.deepEqual(result.discovered_constraints, ["use SafeERC20"]);
    assert.deepEqual(result.emerged_subtasks, ["audit timelock"]);
    assert.ok(result.execution_report);
    assert.equal(result.execution_report!.progress_estimate, 0.3);
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
    assert.equal(result.objective_refinement, "");
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

  // ── v2.9: prompt_requests parsing ──────────────────────────────────────

  it("parses prompt_requests with all fields", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: {
        emphasize: ["SafeERC20", "gas optimization"],
        confusion_points: ["Why is milestone 3 complete?"],
      },
    });
    assert.ok(result.prompt_requests);
    assert.deepEqual(result.prompt_requests!.emphasize, ["SafeERC20", "gas optimization"]);
    assert.deepEqual(result.prompt_requests!.confusion_points, ["Why is milestone 3 complete?"]);
  });

  it("returns undefined for absent prompt_requests", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(result.prompt_requests, undefined);
  });

  it("returns undefined for all-empty prompt_requests", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: { emphasize: [], confusion_points: [] },
    });
    assert.equal(result.prompt_requests, undefined);
  });

  it("ignores non-object prompt_requests", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: "not an object",
    } as Record<string, unknown>);
    assert.equal(result.prompt_requests, undefined);
  });

  it("caps emphasize and confusion_points at reasonable limits", () => {
    const manyItems = Array.from({ length: 20 }, (_, i) => `item ${i}`);
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: {
        emphasize: manyItems,
        confusion_points: manyItems,
      },
    });
    assert.ok(result.prompt_requests!.emphasize!.length <= 10);
    assert.ok(result.prompt_requests!.confusion_points!.length <= 5);
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
          subgoal_refs: ["sg-11111111", 7],
          verify_with: ["run-tests"],
        },
        "not an object",
      ],
    });
    assert.equal(parsed?.items.length, 1);
    assert.deepEqual(parsed?.items[0].criterion_refs, ["cr-auth-login"]);
    assert.deepEqual(parsed?.items[0].subgoal_refs, ["sg-11111111"]);
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

  it("parseRoundContract: absent or non-object → undefined; empty object survives", () => {
    assert.equal(parseRoundContract(undefined), undefined);
    assert.equal(parseRoundContract("not an object"), undefined);
    assert.equal(parseRoundContract(42), undefined);
    const empty = parseRoundContract({});
    assert.ok(empty, "a declared (empty) contract survives — the strict declaration boundary catches it");
    assert.deepEqual(empty?.items, []);
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
        items: [{ description: "done", criterion_refs: [], subgoal_refs: [], verify_with: ["run-tests"] }],
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

  it("defaults subAgentType to general-purpose and keeps existing caps", () => {
    const se = build([{
      agentId: "w1",
      subTask: "scan",
      resultSummary: "r".repeat(2000),
      outcome: "success",
    }]);
    assert.equal(se.worker_results?.[0].subAgentType, "general-purpose");
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
    knownSubGoalIds: null,
    isConfiguredCommand: known,
    checkScopeEntry: () => null,
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
    description: "works", criterion_refs: [], subgoal_refs: [], verify_with: ["verify"], ...overrides,
  });

  it("accepts a well-formed declaration", () => {
    assert.deepEqual(check({
      round_contract: {
        work_item: "Slice",
        scope: ["src/a"],
        items: [item({ criterion_refs: ["cr-11111111"], subgoal_refs: ["sg-11111111"] })],
      },
    }), []);
  });

  it("rejects a declaration with no items", () => {
    const errors = check({ round_contract: { scope: [], items: [] } });
    assert.equal(errors[0]?.reason, "no_items");
  });

  it("rejects an item that binds no command or an unknown one", () => {
    const none = check({ round_contract: { scope: [], items: [item({ verify_with: [] })] } });
    assert.equal(none[0]?.reason, "no_verify_with");
    const unknown = check({ round_contract: { scope: [], items: [item({ verify_with: ["nope"] })] } });
    assert.equal(unknown[0]?.reason, "unknown_command");
  });

  it("enforces the item and scope count limits at the boundary", () => {
    // Limits used to be enforced only by silently truncating in the lenient
    // parser — a declaration over the cap simply lost its tail.
    const tooMany = check({
      round_contract: {
        scope: [],
        items: Array.from({ length: 21 }, (_, i) => item({ description: `i${i}` })),
      },
    });
    assert.equal(tooMany[0]?.reason, "too_many_items");
    const tooWide = check({
      round_contract: { scope: Array.from({ length: 51 }, (_, i) => `src/${i}`), items: [item()] },
    });
    assert.equal(tooWide[0]?.reason, "too_many_scope_entries");
    const tooManyRefs = check({
      round_contract: {
        scope: [],
        items: [item({ verify_with: Array.from({ length: 21 }, () => "verify") })],
      },
    });
    assert.equal(tooManyRefs[0]?.reason, "too_many_verify_with");
  });

  it("rejects a scope that is not a string array or leaves the workspace", () => {
    const notArray = check({ round_contract: { scope: "src/a", items: [item()] } });
    assert.equal(notArray[0]?.reason, "invalid_scope");
    const notString = check({ round_contract: { scope: ["src/a", 7], items: [item()] } });
    assert.equal(notString[0]?.reason, "invalid_scope_entry");
    const escapes = check(
      { round_contract: { scope: ["../outside"], items: [item()] } },
      { checkScopeEntry: (entry) => (entry === "../outside" ? "leaves the workspace" : null) },
    );
    assert.equal(escapes[0]?.reason, "scope_outside_workspace");
    assert.match(escapes[0]?.detail ?? "", /leaves the workspace/);
  });

  it("rejects non-string criterion refs instead of dropping them", () => {
    const errors = check({
      round_contract: { scope: [], items: [item({ criterion_refs: ["cr-11111111", 42] })] },
    });
    assert.equal(errors[0]?.reason, "invalid_criterion_ref");
  });

  it("rejects malformed, duplicate, and unknown sub-goal refs on an item", () => {
    const malformed = check({
      round_contract: { scope: [], items: [item({ subgoal_refs: ["nope"] })] },
    });
    assert.equal(malformed[0]?.reason, "invalid_subgoal_ref");
    const duplicate = check({
      round_contract: { scope: [], items: [item({ subgoal_refs: ["sg-11111111", "sg-11111111"] })] },
    });
    assert.equal(duplicate[0]?.reason, "duplicate_subgoal_ref");
    const unknown = check(
      { round_contract: { scope: [], items: [item({ subgoal_refs: ["sg-11111111"] })] } },
      { knownSubGoalIds: new Set(["sg-22222222"]) },
    );
    assert.equal(unknown[0]?.reason, "unknown_subgoal_ref");
    // Fail open: an unobservable sub-goal set never invents a rejection.
    assert.deepEqual(
      check({ round_contract: { scope: [], items: [item({ subgoal_refs: ["sg-11111111"] })] } }),
      [],
    );
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
