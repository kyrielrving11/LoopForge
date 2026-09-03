/** Tests for self-eval — structured extraction and heuristic fallback. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractSelfEvaluation,
  buildSelfEvaluation,
  parseExecutionEvidence,
  parseRoundContract,
  effectiveOutcome,
  inferOutcomeFromText,
  extractSelfEvaluationWithDiagnostics,
  collectSelfEvalGaps,
} from "../self-eval.js";

// ═══════════════════════════════════════════════════════════════════════════
// parseExecutionEvidence
// ═══════════════════════════════════════════════════════════════════════════

describe("parseExecutionEvidence", () => {
  it("parses valid execution evidence", () => {
    const result = parseExecutionEvidence({
      files_changed: ["a.ts", "b.ts"],
      test_results: { passed: 8, failed: 1, skipped: 2 },
      success_criteria_met: ["reentrancy fixed"],
      success_criteria_remaining: ["access control"],
      progress_estimate: 0.5,
    });
    assert.ok(result);
    assert.deepEqual(result!.files_changed, ["a.ts", "b.ts"]);
    assert.equal(result!.test_results!.passed, 8);
    assert.equal(result!.progress_estimate, 0.5);
  });

  it("returns undefined for null input", () => {
    assert.equal(parseExecutionEvidence(null), undefined);
  });

  it("returns undefined for undefined input", () => {
    assert.equal(parseExecutionEvidence(undefined), undefined);
  });

  it("clamps progress_estimate to [0, 1]", () => {
    const high = parseExecutionEvidence({ progress_estimate: 1.5 });
    assert.equal(high!.progress_estimate, 1);
    const low = parseExecutionEvidence({ progress_estimate: -0.5 });
    assert.equal(low!.progress_estimate, 0);
  });

  it("defaults missing test_results to null", () => {
    const result = parseExecutionEvidence({});
    assert.equal(result!.test_results, null);
  });

  it("filters non-string from files_changed", () => {
    const result = parseExecutionEvidence({
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
      execution_evidence: {
        files_changed: ["token.sol"],
        test_results: { passed: 10, failed: 0, skipped: 0 },
        success_criteria_met: ["no reentrancy"],
        success_criteria_remaining: [],
        progress_estimate: 0.3,
      },
      completed_subtasks: ["setup tests"],
      blocked_subtasks: [],
      canceled_subtasks: [],
      next_action: "audit upgrade proxy",
    };
    const result = buildSelfEvaluation(raw);
    assert.equal(result.success, true);
    assert.equal(result.output_summary, "Fixed 3 bugs");
    assert.deepEqual(result.discovered_constraints, ["use SafeERC20"]);
    assert.deepEqual(result.emerged_subtasks, ["audit timelock"]);
    assert.ok(result.execution_evidence);
    assert.equal(result.execution_evidence!.progress_estimate, 0.3);
    assert.deepEqual(result.completed_subtasks, ["setup tests"]);
    assert.equal(result.next_action, "audit upgrade proxy");
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
    assert.equal(result.next_action, undefined);
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

  // v2.8: Drift clarification
  it("parses drift_clarification when present", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "fixed css",
      constraint_violations: [],
      should_continue: true,
      drift_clarification: "Pivoted because auth module was already refactored in R3",
    });
    assert.equal(
      result.drift_clarification,
      "Pivoted because auth module was already refactored in R3",
    );
  });

  it("leaves drift_clarification undefined when absent", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "fixed css",
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(result.drift_clarification, undefined);
  });

  it("leaves drift_clarification undefined for non-string values", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      drift_clarification: 123,
    } as Record<string, unknown>);
    assert.equal(result.drift_clarification, undefined);
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
        expand: ["milestones", "sub_goals"],
        confusion_points: ["Why is milestone 3 complete?"],
      },
    });
    assert.ok(result.prompt_requests);
    assert.deepEqual(result.prompt_requests!.emphasize, ["SafeERC20", "gas optimization"]);
    assert.deepEqual(result.prompt_requests!.expand, ["milestones", "sub_goals"]);
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
      prompt_requests: { emphasize: [], expand: [], confusion_points: [] },
    });
    assert.equal(result.prompt_requests, undefined);
  });

  it("filters invalid expand values", () => {
    const result = buildSelfEvaluation({
      success: false,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
      prompt_requests: { expand: ["milestones", "invalid_section", "sub_goals"] },
    });
    assert.deepEqual(result.prompt_requests!.expand, ["milestones", "sub_goals"]);
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
// extractSelfEvaluation
// ═══════════════════════════════════════════════════════════════════════════

describe("extractSelfEvaluation", () => {
  const delimiter = "---loopforge-eval\n";
  const endDelim = "\n---end-loopforge-eval";

  it("extracts a valid eval block from agent output", () => {
    const output = `Some agent text\n${delimiter}${
      JSON.stringify({
        success: true,
        output_summary: "all done",
        constraint_violations: [],
        should_continue: false,
      })
    }${endDelim}\nMore text.`;
    const result = extractSelfEvaluation(output);
    assert.ok(result);
    assert.equal(result!.success, true);
    assert.equal(result!.should_continue, false);
  });

  it("returns null when no eval block found", () => {
    const result = extractSelfEvaluation("just some text without delimiters");
    assert.equal(result, null);
  });

  it("returns null for invalid JSON in eval block", () => {
    const result = extractSelfEvaluation(`${delimiter}{not json}${endDelim}`);
    assert.equal(result, null);
  });

  it("returns null when required fields are wrong type", () => {
    const result = extractSelfEvaluation(`${delimiter}${
      JSON.stringify({
        success: "not boolean",
        output_summary: 123,
        constraint_violations: "not array",
        should_continue: "not boolean",
      })
    }${endDelim}`);
    assert.equal(result, null);
  });

  it("returns null when success field is missing", () => {
    const result = extractSelfEvaluation(`${delimiter}${
      JSON.stringify({
        output_summary: "done",
        constraint_violations: [],
        should_continue: false,
      })
    }${endDelim}`);
    assert.equal(result, null);
  });

  it("parses optional fields when present", () => {
    const output = `${delimiter}${
      JSON.stringify({
        success: true,
        output_summary: "done",
        constraint_violations: [],
        should_continue: true,
        discovered_constraints: ["new rule"],
        execution_evidence: {
          files_changed: ["a.ts"],
          progress_estimate: 0.7,
        },
      })
    }${endDelim}`;
    const result = extractSelfEvaluation(output);
    assert.ok(result);
    assert.deepEqual(result!.discovered_constraints, ["new rule"]);
    assert.equal(result!.execution_evidence!.progress_estimate, 0.7);
  });
});

// v2.6: heuristicSelfEvaluation removed.

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
// v2.12: Tolerant diagnostics (infer / reason / gaps)
// ═══════════════════════════════════════════════════════════════════════════

describe("v2.12 diagnostic helpers", () => {
  it("infers outcome from Chinese success keywords", () => {
    const inferred = inferOutcomeFromText("任务完成，所有测试通过");
    assert.equal(inferred?.outcome, "success");
  });

  it("infers outcome from English failure keywords", () => {
    const inferred = inferOutcomeFromText("failed: cannot resolve import");
    assert.equal(inferred?.outcome, "failed");
  });

  it("defaults to partial without keywords", () => {
    const inferred = inferOutcomeFromText("做了部分工作");
    assert.equal(inferred?.outcome, "partial");
  });

  it("returns null for empty text and truncates summary at 200 chars", () => {
    assert.equal(inferOutcomeFromText(""), null);
    const long = inferOutcomeFromText("x".repeat(500));
    assert.ok(long!.summary.length <= 200);
    assert.ok(long!.summary.endsWith("..."));
  });

  it("reports the three extraction failure reasons", () => {
    assert.equal(extractSelfEvaluationWithDiagnostics("no block here").reason, "no_eval_block");
    assert.equal(
      extractSelfEvaluationWithDiagnostics("---loopforge-eval\n{not json\n---end-loopforge-eval").reason,
      "json_parse_failed",
    );
    assert.equal(
      extractSelfEvaluationWithDiagnostics(
        "---loopforge-eval\n{\"success\":true}\n---end-loopforge-eval",
      ).reason,
      "missing_required_fields",
    );
  });

  it("extracts a valid block without a reason", () => {
    const result = extractSelfEvaluationWithDiagnostics(
      "---loopforge-eval\n" +
      JSON.stringify({ success: true, output_summary: "done", constraint_violations: [], should_continue: false }) +
      "\n---end-loopforge-eval",
    );
    assert.equal(result.reason, null);
    assert.ok(result.selfEval);
  });

  it("collects field-level gaps without changing acceptance", () => {
    const gaps = collectSelfEvalGaps({
      success: "yes", // wrong type
      output_summary: "ok",
      constraint_violations: "not-array",
      should_continue: true,
      outcome: 42, // wrong type
    });
    const fields = gaps.map((g) => g.field).sort();
    assert.deepEqual(fields, ["constraint_violations", "outcome", "success"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — round_contract parsing
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — round_contract parsing", () => {
  it("parseRoundContract: lenient field filtering and capping", () => {
    const parsed = parseRoundContract({
      work_item: "Implement auth",
      done_when: ["cr-auth-login", 42, "", "cr-auth-logout"],
      verification_plan: ["run-tests"],
      scope: ["src/auth", null],
    });
    assert.deepEqual(parsed?.done_when, ["cr-auth-login", "cr-auth-logout"]);
    assert.deepEqual(parsed?.scope, ["src/auth"]);
    assert.equal(parsed?.work_item, "Implement auth");
  });

  it("parseRoundContract: caps overlong items and array lengths", () => {
    const long = "x".repeat(300);
    const parsed = parseRoundContract({
      done_when: Array.from({ length: 30 }, (_, i) => `criterion ${i}`),
      work_item: long,
    });
    assert.equal(parsed?.done_when.length, 20, "done_when capped at 20");
    assert.equal(parsed?.work_item?.length, 200, "strings capped at 200");
  });

  it("parseRoundContract: absent or non-object → undefined; empty object survives", () => {
    assert.equal(parseRoundContract(undefined), undefined);
    assert.equal(parseRoundContract("not an object"), undefined);
    assert.equal(parseRoundContract(42), undefined);
    const empty = parseRoundContract({});
    assert.ok(empty, "a declared (empty) contract survives — round_underspecified catches it");
    assert.deepEqual(empty?.done_when, []);
  });

  it("buildSelfEvaluation carries round_contract through and defaults absent", () => {
    const withContract = buildSelfEvaluation({
      success: false,
      output_summary: "x",
      constraint_violations: [],
      should_continue: true,
      round_contract: { work_item: "auth", done_when: ["done"], verification_plan: [], scope: [] },
    });
    assert.equal(withContract.round_contract?.work_item, "auth");
    assert.deepEqual(withContract.round_contract?.done_when, ["done"]);
    const without = buildSelfEvaluation({
      success: false,
      output_summary: "x",
      constraint_violations: [],
      should_continue: true,
    });
    assert.equal(without.round_contract, undefined);
  });
});
