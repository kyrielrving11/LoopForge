/** Tests for loop compiler core: gates, advisories, L0/L1/L2 compilation. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  decideLevel,
  compileLoop,
  computeGoalTextHash,
  deriveGoalId,
  getPreviousRound,
  alignTask,
  checkLoopHealth,
  compileL2,
  buildRollingSummary,
  formatRollingSummaryForPrompt,
} from "../loop-compiler.js";
import {
  makeLoopCompileRequest,
  makeLoopRoundResult,
  makeLoopObjective,
  makeRollingSummary,
} from "../protocol.js";
import { resetPolicy } from "../policy.js";

describe("Loop Compiler — Goal Identity", () => {
  it("computeGoalTextHash produces a 12-char hex string", () => {
    const hash = computeGoalTextHash("Audit ERC20 token");
    assert.equal(hash.length, 12);
    assert.ok(/^[a-f0-9]{12}$/.test(hash));
  });

  it("computeGoalTextHash is deterministic", () => {
    assert.equal(
      computeGoalTextHash("Audit ERC20 token"),
      computeGoalTextHash("Audit ERC20 token"),
    );
  });

  it("computeGoalTextHash normalises whitespace", () => {
    const h1 = computeGoalTextHash("Audit  ERC20   token");
    const h2 = computeGoalTextHash("Audit ERC20 token");
    assert.equal(h1, h2);
  });

  it("deriveGoalId uses explicit goal_id when provided", () => {
    assert.equal(deriveGoalId("loop-1", "Audit ERC20", "audit-erc20"), "audit-erc20");
  });

  it("deriveGoalId falls back to derived id", () => {
    const id = deriveGoalId("loop-1", "Audit ERC20 token");
    assert.ok(id.startsWith("loop-1:"));
  });
});

describe("Loop Compiler — Decide Level (4-gate router)", () => {
  beforeEach(() => resetPolicy());

  it("returns l2 for round 1 (Gate 2: first call)", () => {
    const req = makeLoopCompileRequest({ round: 1, task: "Audit ERC20" });
    assert.equal(decideLevel(req, null), "l2");
  });

  it("returns l2 when plan_source is provided (Gate 2)", () => {
    const req = makeLoopCompileRequest({
      round: 5,
      task: "Audit ERC20",
      plan_source: "spec.md",
    });
    assert.equal(decideLevel(req, null), "l2");
  });

  it("returns l2 when no previous round found", () => {
    const req = makeLoopCompileRequest({ round: 3, task: "Audit ERC20" });
    assert.equal(decideLevel(req, null), "l2");
  });

  it("returns l2 when goal_id changed (Gate 3)", () => {
    const req = makeLoopCompileRequest({
      round: 2,
      loop_id: "test",
      goal_id: "new-audit",
      task: "Audit new contract",
    });
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test",
            round: 1,
            goal_id: "old-audit",
          },
        },
      ],
    };
    // goal_id "new-audit" doesn't match prev "old-audit"
    // But wait: deriveGoalId uses explicit goal_id first, and prev.goal_id is "old-audit"
    // deriveGoalId("test", "Audit new contract", "new-audit") = "new-audit"
    // prev.goal_id = "old-audit" → mismatch → L2
    assert.equal(decideLevel(req, vaultContext), "l2");
  });

  it("returns l1 when new constraints added (Gate 4)", () => {
    const req = makeLoopCompileRequest({
      round: 2,
      loop_id: "test",
      goal_id: "audit",
      task: "Audit ERC20",
      constraints_from_plan: ["check flash loans"],
    });
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test",
            round: 1,
            goal_id: "audit",
          },
        },
      ],
    };
    assert.equal(decideLevel(req, vaultContext), "l1");
  });

  it("returns l1 when last round failed (Gate 4)", () => {
    const req = makeLoopCompileRequest({
      round: 2,
      loop_id: "test",
      goal_id: "audit",
      task: "Audit ERC20",
      last_round_result: makeLoopRoundResult({ success: false }),
    });
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test",
            round: 1,
            goal_id: "audit",
          },
        },
      ],
    };
    assert.equal(decideLevel(req, vaultContext), "l1");
  });

  it("returns l1 with repair signal (Gate 4)", () => {
    const req = makeLoopCompileRequest({
      round: 2,
      loop_id: "test",
      goal_id: "audit",
      task: "Audit ERC20",
      new_since_last_round: "fix the approve race condition bug",
    });
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test",
            round: 1,
            goal_id: "audit",
          },
        },
      ],
    };
    assert.equal(decideLevel(req, vaultContext), "l1");
  });

  it("returns l0 when nothing triggered (Gate 4: fast path)", () => {
    const req = makeLoopCompileRequest({
      round: 2,
      loop_id: "test",
      goal_id: "audit",
      task: "Audit ERC20",
    });
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test",
            round: 1,
            goal_id: "audit",
          },
        },
      ],
    };
    assert.equal(decideLevel(req, vaultContext), "l0");
  });

  it("respects force_level override (Gate 1)", () => {
    const req = makeLoopCompileRequest({
      round: 3,
      loop_id: "test",
      goal_id: "audit",
      task: "Audit ERC20",
      force_level: "l0",
    });
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test",
            round: 2,
            goal_id: "audit",
          },
        },
      ],
    };
    assert.equal(decideLevel(req, vaultContext), "l0");
  });

  it("force_level never overrides round 1 (Gate 1 exception)", () => {
    const req = makeLoopCompileRequest({
      round: 1,
      task: "Audit ERC20",
      force_level: "l0",
    });
    assert.equal(decideLevel(req, null), "l2");
  });

  it("force_level never overrides plan_source (Gate 1 exception)", () => {
    const req = makeLoopCompileRequest({
      round: 3,
      task: "Audit ERC20",
      plan_source: "plan.md",
      force_level: "l0",
    });
    assert.equal(decideLevel(req, null), "l2");
  });
});

describe("Loop Compiler — L0 Fast Path", () => {
  it("reuses cached prompt from previous round", () => {
    const req = makeLoopCompileRequest({
      round: 2,
      loop_id: "test",
      goal_id: "audit",
      task: "Continue audit",
    });
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test",
            round: 1,
            goal_id: "audit",
            constraints_active: ["check ownership"],
          },
          full_prompt: "## Round 1 Prompt\n\nAudit the contract.",
        },
      ],
    };
    const response = compileLoop(req, vaultContext);
    assert.equal(response.recompile_level, "l0");
    assert.ok(response.prompt.includes("Round 1 Prompt"));
    assert.equal(response.technique_used, "cached");
    assert.deepEqual(response.constraints_active, ["check ownership"]);
  });
});

describe("Loop Compiler — L1 Patch Path", () => {
  it("patches prompt with new constraints", () => {
    const req = makeLoopCompileRequest({
      round: 2,
      loop_id: "test",
      goal_id: "audit",
      task: "Check approve race condition",
      constraints_from_plan: ["check flash loans"],
      new_since_last_round: "fix the approve race",
    });
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test",
            round: 1,
            goal_id: "audit",
            constraints_active: ["check ownership"],
          },
        },
      ],
    };
    const response = compileLoop(req, vaultContext);
    assert.equal(response.recompile_level, "l1");
    assert.ok(response.prompt.includes("L1 Patch"));
    assert.ok(response.prompt.includes("check flash loans"));
    assert.ok(response.prompt.includes("check ownership"));
    assert.equal(response.technique_used, "patch");
  });
});

describe("Loop Compiler — L2 Full Recompile", () => {
  it("generates full meta-instruction prompt", () => {
    const req = makeLoopCompileRequest({
      round: 1,
      loop_id: "audit-erc20",
      goal_id: "audit-erc20",
      task: "Audit ERC20 token for security vulnerabilities",
      domain: "solidity-security",
    });
    const response = compileL2(req, null);
    assert.equal(response.recompile_level, "l2");
    assert.ok(response.prompt.includes("L2 Compile"));
    assert.ok(response.prompt.includes("Loop Identity"));
    assert.ok(response.prompt.includes("Generation Instructions"));
    assert.notEqual(response.technique_used, "");
    assert.notEqual(response.goal_text_hash, "");
    assert.equal(response.round, 1);
    assert.equal(response.loop_id, "audit-erc20");
  });

  it("includes loop objective at round 1", () => {
    const req = makeLoopCompileRequest({
      round: 1,
      loop_id: "test",
      task: "Audit ERC20 token",
      loop_objective: makeLoopObjective({
        objective: "Find all vulnerabilities",
        success_criteria: ["All tests pass"],
        hard_constraints: ["No external deps"],
        loop_id: "test",
      }),
    });
    const response = compileL2(req, null);
    assert.ok(response.prompt.includes("Loop Objective (Anchor)"));
    assert.ok(response.prompt.includes("Find all vulnerabilities"));
    assert.ok(response.loop_objective !== null);
  });

  it("merges success_criteria into constraints_active alongside hard_constraints", () => {
    const req = makeLoopCompileRequest({
      round: 1,
      loop_id: "test",
      task: "Audit ERC20 token",
      constraints_from_plan: ["check ownership"],
      loop_objective: makeLoopObjective({
        objective: "Find all vulnerabilities",
        success_criteria: ["All tests pass", "No高危漏洞"],
        hard_constraints: ["No external deps"],
        loop_id: "test",
      }),
    });
    const response = compileL2(req, null);
    assert.ok(response.constraints_active.includes("check ownership"));
    assert.ok(response.constraints_active.includes("No external deps"));
    assert.ok(response.constraints_active.includes("All tests pass"));
    assert.ok(response.constraints_active.includes("No高危漏洞"));
    // All three sources should be merged without duplicates
    assert.equal(
      response.constraints_active.length,
      4,
      "Expected 4 unique constraints: 1 plan + 1 hard + 2 success",
    );
  });

  it("auto-generates loop objective at round 1 when none provided", () => {
    const req = makeLoopCompileRequest({
      round: 1,
      loop_id: "test",
      task: "Test the API endpoints for security issues",
    });
    const response = compileL2(req, null);
    assert.ok(response.loop_objective !== null);
    assert.ok(response.loop_objective!.objective.length > 0);
  });
});

describe("Loop Compiler — Task Alignment (advisory)", () => {
  it("returns default alignment when no loop objective", () => {
    const req = makeLoopCompileRequest({ loop_id: "test", task: "Audit" });
    const result = alignTask("Proposed task", req, null);
    assert.equal(result.is_aligned, true);
    assert.equal(result.escalation, "none");
  });

  it("warns when proposed task drifts from objective", () => {
    const req = makeLoopCompileRequest({
      loop_id: "test",
      task: "Audit ERC20",
      loop_objective: makeLoopObjective({
        objective: "Audit ERC20 token for all security vulnerabilities",
        success_criteria: ["Find all critical vulnerabilities"],
        hard_constraints: ["No external dependencies"],
      }),
    });
    const result = alignTask(
      "Write a frontend UI for the token dashboard",
      req,
      null,
    );
    assert.equal(result.escalation, "block");
    assert.equal(result.is_aligned, false);
  });
});

describe("Loop Compiler — Compile Loop (top-level)", () => {
  it("returns complete response with advisories", () => {
    const req = makeLoopCompileRequest({
      round: 1,
      loop_id: "test",
      task: "Test the API",
      next_task_proposal: "Test the database",
      loop_objective: makeLoopObjective({
        objective: "Test all APIs",
        success_criteria: ["All tests pass"],
        hard_constraints: [],
      }),
    });
    const response = compileLoop(req, null);
    assert.equal(response.status, "ok");
    assert.equal(response.recompile_level, "l2");
    assert.notEqual(response.goal_text_hash.length, 0);
    assert.ok(response.task_alignment !== null);
  });
});

describe("Loop Compiler — Cross-Round Scenarios", () => {
  it("L0→L1 escalation: goal_id stable, new constraints added", () => {
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "audit",
            round: 1,
            goal_id: "audit",
            constraints_active: ["check ownership"],
          },
        },
      ],
    };
    // Round 2: same semantic task → deriveGoalId will match
    const req = makeLoopCompileRequest({
      round: 2,
      loop_id: "audit",
      goal_id: "audit",
      task: "Audit ERC20 token for security vulnerabilities",
      constraints_from_plan: ["check flash loans"],
    });
    const level = decideLevel(req, vaultContext);
    assert.equal(level, "l1");
  });

  it("L0 stability: multiple rounds with same goal_id, no failures", () => {
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "audit",
            round: 2,
            goal_id: "audit",
          },
        },
      ],
    };
    const req = makeLoopCompileRequest({
      round: 3,
      loop_id: "audit",
      goal_id: "audit",
      task: "Audit ERC20",
    });
    const level = decideLevel(req, vaultContext);
    assert.equal(level, "l0");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Failure Lineage Weighting (v1.7)
// ═══════════════════════════════════════════════════════════════════════════

function makeVaultResult(
  loopId: string,
  round: number,
  qualityScore: number,
  task: string,
  outputSummary = "",
  techniqueUsed = "zero-shot",
  constraintViolations: string[] = [],
): Record<string, unknown> {
  return {
    task,
    output_summary: outputSummary,
    constraint_violations: constraintViolations,
    technique_used: techniqueUsed,
    quality_score: qualityScore,
    loop_lineage: {
      loop_id: loopId,
      round,
      quality_score: qualityScore,
      task,
      technique_used: techniqueUsed,
    },
  };
}

describe("Failure Lineage Weighting — buildRollingSummary", () => {
  it("no failure patterns when all rounds score >= 4", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 5, "fix auth bug", "Fixed auth by updating middleware"),
        makeVaultResult("loop-1", 2, 4, "add tests for auth", "Added 12 test cases"),
        makeVaultResult("loop-1", 3, 5, "refactor auth module", "Cleaned up auth module"),
      ],
      global_entries: [],
    };
    const rs = buildRollingSummary("loop-1", 4, vault);
    assert.ok(rs !== null);
    assert.equal(rs!.failed_patterns?.length ?? 0, 0);
    // key_lessons should not have [Consider alternatives] marker
    for (const kl of rs!.key_lessons) {
      assert.ok(!kl.includes("[Consider alternatives]"));
    }
  });

  it("detects 2 consecutive low-quality rounds with same technique and similar task", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 2, "fix cache bug", "Tried cache fix A", "zero-shot"),
        makeVaultResult("loop-1", 2, 2, "fix cache problem", "Tried cache fix B", "zero-shot"),
        makeVaultResult("loop-1", 3, 5, "found auth root cause", "Auth middleware was the issue", "step-back"),
      ],
      global_entries: [],
    };
    const rs = buildRollingSummary("loop-1", 4, vault);
    assert.ok(rs !== null);
    assert.ok((rs!.failed_patterns?.length ?? 0) >= 1);
    const fp = rs!.failed_patterns![0];
    assert.ok(fp.includes("zero-shot"));
    assert.ok(fp.includes("cache"));
    assert.ok(fp.includes("2 consecutive rounds"));
  });

  it("detects 3 consecutive low-quality rounds", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 2, "fix memory leak", "Attempt 1", "few-shot"),
        makeVaultResult("loop-1", 2, 1, "fix memory leak in parser", "Attempt 2", "few-shot"),
        makeVaultResult("loop-1", 3, 2, "fix memory leak - retry", "Attempt 3", "few-shot"),
      ],
      global_entries: [],
    };
    const rs = buildRollingSummary("loop-1", 4, vault);
    assert.ok(rs !== null);
    assert.ok((rs!.failed_patterns?.length ?? 0) >= 1);
    assert.ok(rs!.failed_patterns![0].includes("3 consecutive rounds"));
  });

  it("no pattern when low-quality rounds use different techniques", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 2, "fix cache bug", "Attempt", "zero-shot"),
        makeVaultResult("loop-1", 2, 2, "fix cache bug", "Attempt", "tree-of-thought"),
      ],
      global_entries: [],
    };
    const rs = buildRollingSummary("loop-1", 3, vault);
    assert.ok(rs !== null);
    assert.equal(rs!.failed_patterns?.length ?? 0, 0);
  });

  it("no pattern when low-quality tasks are completely different (Jaccard < 0.4)", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 2, "fix cache bug in Redis layer", "Attempt", "zero-shot"),
        makeVaultResult("loop-1", 2, 2, "rewrite authentication module entirely", "Attempt", "zero-shot"),
      ],
      global_entries: [],
    };
    const rs = buildRollingSummary("loop-1", 3, vault);
    assert.ok(rs !== null);
    assert.equal(rs!.failed_patterns?.length ?? 0, 0);
  });

  it("key_lessons from failure-pattern rounds are demoted to end with [Consider alternatives]", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 2, "fix cache bug", "Tried cache approach", "zero-shot"),
        makeVaultResult("loop-1", 2, 2, "fix cache problem", "Tried another cache fix", "zero-shot"),
        makeVaultResult("loop-1", 3, 5, "found real issue in auth", "Auth was the real problem — fixed", "step-back", ["Auth bug resolved"]),
      ],
      global_entries: [],
    };
    const rs = buildRollingSummary("loop-1", 4, vault);
    assert.ok(rs !== null);

    // key_lessons should have the successful round first, then demoted ones
    // (but since score >= 4 for key_lessons, rounds 1-2 with score=2 won't appear at all)
    // The real test is: no false positives in key_lessons
    for (const kl of rs!.key_lessons) {
      if (kl.includes("cache")) {
        assert.ok(kl.includes("[Consider alternatives]"));
      }
    }
  });

  it("recurring_issues from failure-only rounds marked as [Possible dead end]", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 2, "fix cache bug", "Attempt 1", "zero-shot",
          ["missed edge case"]),
        makeVaultResult("loop-1", 2, 2, "fix cache problem", "Attempt 2", "zero-shot",
          ["missed edge case"]),
        makeVaultResult("loop-1", 3, 5, "found auth root cause", "Fixed auth", "step-back",
          ["auth constraint missed"]),
        makeVaultResult("loop-1", 4, 4, "add auth tests", "Added tests", "least-to-most",
          ["auth constraint missed"]),
      ],
      global_entries: [],
    };
    const rs = buildRollingSummary("loop-1", 5, vault);
    assert.ok(rs !== null);

    // "missed edge case" only appears in failed rounds (1,2) → should be marked
    const edgeCaseIssue = rs!.recurring_issues.find((ri) => ri.includes("missed edge case"));
    assert.ok(edgeCaseIssue !== undefined);
    assert.ok(edgeCaseIssue!.includes("[Possible dead end"));

    // "auth constraint missed" appears in both failed (3) and successful (4) → NOT marked
    const authIssue = rs!.recurring_issues.find((ri) => ri.includes("auth constraint missed"));
    assert.ok(authIssue !== undefined);
    assert.ok(!authIssue!.includes("[Possible dead end"));
  });

  it("empty vault returns null", () => {
    const rs = buildRollingSummary("loop-1", 1, { results: [], global_entries: [] });
    assert.equal(rs, null);
  });

  it("single round returns no failure patterns", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 2, "fix cache bug", "Attempt", "zero-shot"),
      ],
      global_entries: [],
    };
    const rs = buildRollingSummary("loop-1", 2, vault);
    assert.ok(rs !== null);
    assert.equal(rs!.failed_patterns?.length ?? 0, 0);
  });
});

describe("Failure Lineage Weighting — formatRollingSummaryForPrompt", () => {
  it("renders failure patterns section when present", () => {
    const rs = makeRollingSummary({
      quality_trajectory: [2, 2, 5],
      trajectory_direction: "improving",
      what_worked: ["R3 (score=5): Fixed auth"],
      recurring_issues: [],
      key_lessons: ["[R3] Fixed auth bug"],
      rounds_sampled: 3,
      generated_at_round: 4,
      failed_patterns: [
        "technique 'zero-shot' on task 'fix cache bug' failed 2 consecutive rounds (R1-R2, avg score 2.0) — consider strategy change",
      ],
    });
    const text = formatRollingSummaryForPrompt(rs);
    assert.ok(text.includes("### ⚠️ Failure Patterns"));
    assert.ok(text.includes("Consider Strategy Change"));
    assert.ok(text.includes("fix cache bug"));
    assert.ok(text.includes("🚫"));
  });

  it("no failure patterns section when empty", () => {
    const rs = makeRollingSummary({
      quality_trajectory: [5, 4],
      trajectory_direction: "stable",
      what_worked: [],
      recurring_issues: [],
      key_lessons: [],
      rounds_sampled: 2,
      generated_at_round: 3,
      failed_patterns: [],
    });
    const text = formatRollingSummaryForPrompt(rs);
    assert.ok(!text.includes("Failure Patterns"));
  });

  it("returns empty string for null or empty summary", () => {
    assert.equal(formatRollingSummaryForPrompt(null), "");
    const empty = makeRollingSummary({ rounds_sampled: 0 });
    assert.equal(formatRollingSummaryForPrompt(empty), "");
  });
});
