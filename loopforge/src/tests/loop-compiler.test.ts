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
  buildCheckpointSummary,
  formatCheckpointForPrompt,
  filterConstraintsForSubTask,
  formatDelegationPrompt,
  buildDelegationSummary,
} from "../loop-compiler.js";
import {
  makeLoopCompileRequest,
  makeLoopRoundResult,
  makeLoopObjective,
  makeRollingSummary,
  makeCheckpointSummary,
  makeSelfEvaluation,
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

  it("returns l0 when last round failed with no new info (honest retry)", () => {
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
    // failed + no P0-P5 + no new constraints + no repair → L0 retry
    assert.equal(decideLevel(req, vaultContext), "l0");
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

  it("returns l1 as default path when nothing specific triggered", () => {
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
    // v1.14: L1 is the default path — L0 only fires on honest failure with no new info
    assert.equal(decideLevel(req, vaultContext), "l1");
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
  it("uses L1 as default when no trigger (L0 requires failure)", () => {
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
    // v1.14: L1 is the default — state evolves in state file, prompt is thin
    assert.equal(response.recompile_level, "l1");
    // L1 uses real technique routing, not "cached" or "patch"
    assert.notEqual(response.technique_used, "");
    assert.notEqual(response.technique_used, "cached");
    assert.notEqual(response.technique_used, "patch");
  });
});

describe("Loop Compiler — L1 Patch Path", () => {
  it("compiles thin L1 prompt with constraints and real technique", () => {
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
    // v1.14: L1 uses real technique routing (not "patch")
    assert.notEqual(response.technique_used, "patch");
    assert.notEqual(response.technique_used, "cached");
    assert.notEqual(response.technique_used, "");
  });
});

describe("Loop Compiler — L2 Full Recompile", () => {
  it("generates L2 prompt with technique selection block", () => {
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
    assert.ok(response.prompt.includes("Technique Selection"));
    assert.equal(response.technique_used, "agent-selected");
    // v1.15.1: Absolute path from package install location
    assert.ok(
      response.reference_file.endsWith("prompt-techniques/SKILL.md"),
      `reference_file should end with prompt-techniques/SKILL.md, got: ${response.reference_file}`,
    );
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
  it("L1 default: goal_id stable, new constraints added", () => {
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
    // v1.14: L1 is the default path for state evolution
    assert.equal(level, "l1");
  });

  it("L1 default: multiple rounds with same goal_id, no failures", () => {
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
    // v1.14: L1 is the default — L0 only fires on honest failure
    assert.equal(level, "l1");
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
  const success = qualityScore >= 3;
  return {
    task,
    output_summary: outputSummary,
    constraint_violations: constraintViolations,
    technique_used: techniqueUsed,
    success,
    loop_lineage: {
      loop_id: loopId,
      round,
      success,
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
    // key_outcomes should not have [Consider alternatives] marker
    for (const ko of rs!.key_outcomes) {
      assert.ok(!ko.includes("[Consider alternatives]"));
    }
  });

  it("detects 2 consecutive failed rounds with same technique and similar task", () => {
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

  it("detects 3 consecutive failed rounds", () => {
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

  it("no pattern when failed rounds use different techniques", () => {
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

  it("no pattern when failed tasks are completely different (Jaccard < 0.4)", () => {
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

  it("key_outcomes from failure-pattern rounds are demoted to end with [Consider alternatives]", () => {
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

    // key_outcomes only include score>=4 rounds (failure-pattern rounds score<3 don't appear)
    // Round 3 (score=5) should be present and not marked
    for (const ko of rs!.key_outcomes) {
      if (ko.includes("cache")) {
        assert.ok(ko.includes("[Consider alternatives]"));
      }
    }
    // Round 3 (score=5) should be present with auth fix outcome
    assert.ok(rs!.key_outcomes.some((ko) => ko.includes("Auth")));
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
      key_outcomes: ["[R3] ✓ (step-back): Fixed auth bug"],
      recurring_issues: [],
      rounds_sampled: 3,
      generated_at_round: 4,
      failed_patterns: [
        "technique 'zero-shot' on task 'fix cache bug' failed 2 consecutive rounds (R1-R2) — consider strategy change",
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
      key_outcomes: [],
      recurring_issues: [],
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

// ═══════════════════════════════════════════════════════════════════════════
// Delegation Helpers (v1.9 — AgentTool mode)
// ═══════════════════════════════════════════════════════════════════════════

describe("Delegation Helpers — filterConstraintsForSubTask", () => {
  const constraints = [
    "all APIs must have rate limiting",
    "use TypeScript strict mode",
    "all files must have license header",
    "every function needs unit tests",
    "禁止使用 any 类型",
  ];

  it("returns empty array for empty constraints", () => {
    assert.deepEqual(
      filterConstraintsForSubTask([], "search for deprecated API"),
      [],
    );
  });

  it("returns empty array for empty subTask", () => {
    assert.deepEqual(filterConstraintsForSubTask(constraints, ""), []);
    assert.deepEqual(filterConstraintsForSubTask(constraints, "   "), []);
  });

  it("returns only relevant constraints by Jaccard similarity", () => {
    // "search for deprecated API usage in src/" should NOT match
    // rate limiting, strict mode, license headers, or unit tests
    const result = filterConstraintsForSubTask(
      constraints,
      "search for deprecated API usage in src/",
    );
    assert.equal(result.length, 0);
  });

  it("returns relevant constraint when task overlaps", () => {
    // "add rate limiting to all API endpoints" should match
    // "all APIs must have rate limiting"
    const result = filterConstraintsForSubTask(
      constraints,
      "add rate limiting to all API endpoints",
    );
    assert.ok(result.length >= 1);
    assert.ok(result.some((c) => c.includes("rate limiting")));
  });

  it("returns at least one constraint when task has TypeScript+testing overlap", () => {
    // "add TypeScript unit tests for all API functions" overlaps with
    // "every function needs unit tests" (Jaccard ~0.2);
    // "use TypeScript strict mode" overlap is too low (Jaccard ~0.1)
    const result = filterConstraintsForSubTask(
      constraints,
      "add TypeScript unit tests for all API functions",
    );
    assert.ok(result.length >= 1);
    assert.ok(result.some((c) => c.includes("unit tests")));
  });

  it("custom threshold filters more aggressively", () => {
    // With threshold 0.5, should return very few constraints
    const lenient = filterConstraintsForSubTask(
      constraints,
      "add rate limiting to all API endpoints",
      0.15,
    );
    const strict = filterConstraintsForSubTask(
      constraints,
      "add rate limiting to all API endpoints",
      0.5,
    );
    assert.ok(strict.length <= lenient.length);
  });

  it("supports CJK subTask with CJK constraints", () => {
    const cjkConstraints = [
      "所有API必须有速率限制",
      "使用TypeScript严格模式",
    ];
    // "搜索废弃的API" doesn't overlap with rate limiting or strict mode
    const result = filterConstraintsForSubTask(
      cjkConstraints,
      "搜索废弃的API使用情况",
    );
    assert.equal(result.length, 0);
  });

  it("matches CJK constraint with overlapping CJK subTask", () => {
    const cjkConstraints = [
      "所有API必须有速率限制",
      "所有文件必须有许可证头",
    ];
    const result = filterConstraintsForSubTask(
      cjkConstraints,
      "为API添加速率限制",
    );
    assert.ok(result.length >= 1);
    assert.ok(result.some((c) => c.includes("速率限制")));
  });
});

describe("Delegation Helpers — formatDelegationPrompt", () => {
  const subTask = "search for deprecated API usage in src/";
  const constraints = ["all APIs must have rate limiting"];

  it("generates self-contained explore prompt", () => {
    const prompt = formatDelegationPrompt(subTask, "explore", []);
    assert.ok(prompt.includes("### Delegated Task"));
    assert.ok(prompt.includes(subTask));
    assert.ok(prompt.includes("### Output Format"));
    // Explore should NOT get constraints
    assert.ok(!prompt.includes("### Relevant Constraints"));
    // Must be self-contained
    assert.ok(!prompt.match(/based on (above|previous|your findings)/i));
    assert.ok(!prompt.includes("continue from"));
  });

  it("generates general-purpose prompt with constraints", () => {
    const prompt = formatDelegationPrompt(
      "fix the null pointer in src/auth/validate.ts:42",
      "general-purpose",
      constraints,
    );
    assert.ok(prompt.includes("### Delegated Task"));
    assert.ok(prompt.includes("### Relevant Constraints"));
    assert.ok(prompt.includes("rate limiting"));
    assert.ok(prompt.includes("don't leave it half-done"));
    // Must be self-contained
    assert.ok(!prompt.match(/based on (above|previous|your findings)/i));
  });

  it("generates plan prompt with instructions", () => {
    const prompt = formatDelegationPrompt(
      "design authentication middleware",
      "plan",
      constraints,
      { context: "Current auth is JWT-based in src/auth/" },
    );
    assert.ok(prompt.includes("### Delegated Task"));
    assert.ok(prompt.includes("### Context"));
    assert.ok(prompt.includes("JWT-based"));
    assert.ok(prompt.includes("### Relevant Constraints"));
    assert.ok(prompt.includes("Critical files for implementation"));
    assert.ok(prompt.includes("3-5 files"));
  });

  it("skips constraints section when empty", () => {
    const prompt = formatDelegationPrompt(
      subTask,
      "general-purpose",
      [],
    );
    assert.ok(!prompt.includes("### Relevant Constraints"));
  });

  it("custom sub-agent type gets generic template", () => {
    const prompt = formatDelegationPrompt(
      subTask,
      "custom-auditor",
      constraints,
    );
    assert.ok(prompt.includes("### Delegated Task"));
    assert.ok(prompt.includes("### Relevant Constraints"));
    assert.ok(prompt.includes("Complete the task above"));
  });

  it("output is self-contained — no parent-context references", () => {
    const types = ["explore", "general-purpose", "plan", "custom"];
    for (const t of types) {
      const prompt = formatDelegationPrompt(
        "do something",
        t,
        constraints,
      );
      // No references to parent conversation
      assert.ok(!prompt.match(/based on (above|previous|your findings)/i),
        `${t}: should not reference parent context`);
      assert.ok(!prompt.includes("continue from"),
        `${t}: should not say "continue from"`);
      assert.ok(!prompt.includes("as discussed"),
        `${t}: should not say "as discussed"`);
      assert.ok(!prompt.includes("see above"),
        `${t}: should not say "see above"`);
    }
  });
});

describe("Delegation — buildDelegationSummary", () => {
  it("returns empty string for null vault context", () => {
    assert.equal(buildDelegationSummary(null), "");
  });

  it("returns empty string when no delegation journal entries", () => {
    const vault = { results: [{ task_type: "loop_lineage", loop_id: "test" }] };
    assert.equal(buildDelegationSummary(vault), "");
  });

  it("returns empty string when results array is empty", () => {
    const vault = { results: [] };
    assert.equal(buildDelegationSummary(vault), "");
  });

  it("builds delegation table from journal entries", () => {
    const vault = {
      results: [
        {
          task_type: "delegation_journal",
          loop_lineage: {
            round: 2,
            delegations: [
              { index: 1, agentId: "abc-123", subAgentType: "explore", subTask: "search deprecated APIs", resultSummary: "found 12 instances", success: true, discoveredConstraints: [] },
              { index: 2, agentId: "def-456", subAgentType: "general-purpose", subTask: "fix auth bug", resultSummary: "fixed null pointer", success: true, discoveredConstraints: [] },
            ],
          },
        },
      ],
    };
    const text = buildDelegationSummary(vault);
    assert.ok(text.includes("### Delegation History"));
    assert.ok(text.includes("R2"));
    assert.ok(text.includes("search deprecated APIs"));
    assert.ok(text.includes("fix auth bug"));
    assert.ok(text.includes("✓"));
    // Agent column should display agentId
    assert.ok(text.includes("abc-123"));
    assert.ok(text.includes("def-456"));
    // Table header should include Agent column
    assert.ok(text.includes("| Round | Agent | Type | Task | Result | ✓/✗ |"));
  });

  it("shows ✗ for failed delegations", () => {
    const vault = {
      results: [
        {
          task_type: "delegation_journal",
          loop_lineage: {
            round: 3,
            delegations: [
              { index: 1, agentId: "worker-xyz", subAgentType: "general-purpose", subTask: "fix complex bug", resultSummary: "failed — wrong approach", success: false, discoveredConstraints: [] },
            ],
          },
        },
      ],
    };
    const text = buildDelegationSummary(vault);
    assert.ok(text.includes("✗"));
    assert.ok(text.includes("fix complex bug"));
    assert.ok(text.includes("wrong approach"));
  });

  it("handles multiple rounds of delegation", () => {
    const vault = {
      results: [
        {
          task_type: "delegation_journal",
          loop_lineage: { round: 1, delegations: [{ index: 1, agentId: "agent-a", subAgentType: "explore", subTask: "research X", resultSummary: "done", success: true, discoveredConstraints: [] }] },
        },
        {
          task_type: "delegation_journal",
          loop_lineage: { round: 2, delegations: [{ index: 1, agentId: "agent-b", subAgentType: "general-purpose", subTask: "fix Y", resultSummary: "done", success: true, discoveredConstraints: [] }] },
        },
      ],
    };
    const text = buildDelegationSummary(vault);
    assert.ok(text.includes("R1"));
    assert.ok(text.includes("R2"));
  });

  it("falls back to worker-N when agentId is missing (backward compat)", () => {
    const vault = {
      results: [
        {
          task_type: "delegation_journal",
          loop_lineage: {
            round: 1,
            delegations: [
              { index: 3, subAgentType: "explore", subTask: "scan codebase", resultSummary: "done", success: true },
            ],
          },
        },
      ],
    };
    const text = buildDelegationSummary(vault);
    assert.ok(text.includes("worker-3"), "should fall back to worker-3");
  });

  it("escapes pipe characters in markdown table cells", () => {
    const vault = {
      results: [
        {
          task_type: "delegation_journal",
          loop_lineage: {
            round: 1,
            delegations: [
              { index: 1, agentId: "agent-1", subAgentType: "explore", subTask: "audit A|B testing in src/", resultSummary: "found issues in x|y module", success: true, discoveredConstraints: [] },
            ],
          },
        },
      ],
    };
    const text = buildDelegationSummary(vault);
    // Should contain escaped pipes, not raw pipes that would break the table
    assert.ok(text.includes("A\\|B"), "pipe in task should be escaped");
    assert.ok(text.includes("x\\|y"), "pipe in result should be escaped");
    // Verify the table row still has the correct number of pipe chars:
    // 7 structural (leading + 5 separators + trailing) + 2 escaped inside cells = 9 total
    const tableRow = text.split("\n").find((l) => l.startsWith("| R1"));
    assert.ok(tableRow, "should have a table row for R1");
    const pipeCount = (tableRow!.match(/\|/g) ?? []).length;
    assert.equal(pipeCount, 9, "table row should have 9 pipe chars (7 structural + 2 escaped)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Checkpoint Compression (v1.10)
// ═══════════════════════════════════════════════════════════════════════════

describe("Checkpoint — buildCheckpointSummary", () => {
  it("builds from self-eval with checkpoint fields", () => {
    const selfEval = makeSelfEvaluation({
      success: true,
      output_summary: "Completed ERC20 data model with full test coverage",
      compression_checkpoint: true,
      checkpoint_label: "数据模型层完成",
    });
    const cs = buildCheckpointSummary(
      selfEval, 8,
      ["constraint-A", "constraint-B", "constraint-C"],
      ["old-constraint"],
    );
    assert.ok(cs !== null);
    assert.equal(cs.label, "数据模型层完成");
    assert.equal(cs.declared_at_round, 8);
    assert.ok(cs.outcome.includes("ERC20 data model"));
    assert.deepStrictEqual(cs.carried_constraints, ["constraint-A", "constraint-B", "constraint-C"]);
    assert.deepStrictEqual(cs.resolved_constraints, ["old-constraint"]);
  });

  it("falls back to auto-generated label when checkpoint_label is empty", () => {
    const selfEval = makeSelfEvaluation({
      success: true,
      output_summary: "Done with auth module",
      compression_checkpoint: true,
      checkpoint_label: "",
    });
    const cs = buildCheckpointSummary(selfEval, 5, ["c1"], []);
    assert.ok(cs.label.includes("Subtask completed at round 5"));
  });

  it("caps carried and resolved constraints at policy limit", () => {
    const selfEval = makeSelfEvaluation({
      success: true,
      output_summary: "Done",
      compression_checkpoint: true,
      checkpoint_label: "test",
    });
    const manyConstraints = Array.from({ length: 15 }, (_, i) => `c${i + 1}`);
    const cs = buildCheckpointSummary(selfEval, 3, manyConstraints, manyConstraints);
    // Default policy: max_carried_constraints = 10
    assert.equal(cs.carried_constraints.length, 10);
    assert.equal(cs.resolved_constraints.length, 10);
  });

  it("truncates outcome at policy limit", () => {
    const selfEval = makeSelfEvaluation({
      success: true,
      output_summary: "x".repeat(300),
      compression_checkpoint: true,
      checkpoint_label: "test",
    });
    const cs = buildCheckpointSummary(selfEval, 1, [], []);
    // Default policy: outcome_max_chars = 200
    assert.ok(cs.outcome.length <= 200);
  });
});

describe("Checkpoint — formatCheckpointForPrompt", () => {
  it("renders checkpoint block with all fields", () => {
    const cs = makeCheckpointSummary({
      label: "Auth module complete",
      declared_at_round: 5,
      outcome: "Implemented JWT auth with refresh tokens",
      carried_constraints: ["所有API需要认证", "token过期时间≤24h"],
      resolved_constraints: ["旧密码哈希方式需更新"],
    });
    const text = formatCheckpointForPrompt(cs);
    assert.ok(text.includes("### Checkpoint: Auth module complete (Round 5)"));
    assert.ok(text.includes("Implemented JWT auth"));
    assert.ok(text.includes("所有API需要认证"));
    assert.ok(text.includes("旧密码哈希方式需更新"));
    assert.ok(text.includes("Carried Constraints"));
    assert.ok(text.includes("Resolved Constraints"));
  });

  it("returns empty string for null", () => {
    assert.equal(formatCheckpointForPrompt(null), "");
  });

  it("returns empty string for empty checkpoint", () => {
    const cs = makeCheckpointSummary({});
    assert.equal(formatCheckpointForPrompt(cs), "");
  });

  it("omits resolved section when no resolved constraints", () => {
    const cs = makeCheckpointSummary({
      label: "test",
      declared_at_round: 1,
      outcome: "done",
      carried_constraints: ["c1"],
      resolved_constraints: [],
    });
    const text = formatCheckpointForPrompt(cs);
    assert.ok(!text.includes("Resolved Constraints"));
  });
});

describe("Checkpoint — buildRollingSummary with sinceRound", () => {
  function makeVaultResult(
    loopId: string, round: number, qualityScore: number,
    task: string, outputSummary = "", techniqueUsed = "zero-shot",
    constraintViolations: string[] = [],
  ): Record<string, unknown> {
    const success = qualityScore >= 3;
    return {
      task, output_summary: outputSummary,
      constraint_violations: constraintViolations,
      technique_used: techniqueUsed, success,
      loop_lineage: { loop_id: loopId, round, success, task, technique_used: techniqueUsed },
    };
  }

  it("only includes rounds at or after sinceRound", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 4, "task A", "did A"),
        makeVaultResult("loop-1", 2, 5, "task B", "did B"),
        makeVaultResult("loop-1", 3, 3, "task C", "did C"),
        makeVaultResult("loop-1", 4, 5, "task D", "did D"),
        makeVaultResult("loop-1", 5, 4, "task E", "did E"),
      ],
    };
    const rs = buildRollingSummary("loop-1", 6, vault, 3);
    assert.ok(rs !== null);
    // Round 1 and 2 should be excluded (before sinceRound=3)
    assert.equal(rs!.rounds_sampled, 3);
    // Verify key_outcomes contains rounds 3-5
    assert.equal(rs!.key_outcomes.length, 3);
    assert.ok(rs!.key_outcomes.some((k) => k.includes("R3")));
    assert.ok(rs!.key_outcomes.some((k) => k.includes("R5")));
  });

  it("sinceRound with no matching rounds returns null", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 4, "task A", "did A"),
        makeVaultResult("loop-1", 2, 5, "task B", "did B"),
      ],
    };
    const rs = buildRollingSummary("loop-1", 3, vault, 5);
    assert.equal(rs, null);
  });

  it("without sinceRound includes all rounds (backward compat)", () => {
    const vault = {
      results: [
        makeVaultResult("loop-1", 1, 4, "task A", "did A"),
        makeVaultResult("loop-1", 2, 5, "task B", "did B"),
      ],
    };
    const rs = buildRollingSummary("loop-1", 3, vault);
    assert.ok(rs !== null);
    assert.equal(rs!.rounds_sampled, 2);
  });
});

describe("Checkpoint — compileL2 integration", () => {
  it("renders checkpoint in prompt when last_round_result has checkpoint", () => {
    const lr = makeLoopRoundResult({
      round: 4,
      success: true,
      output_summary: "Completed data model layer",
      constraint_violations: [],
      compression_checkpoint: true,
      checkpoint_label: "Data model done",
    });
    const req = makeLoopCompileRequest({
      round: 5,
      loop_id: "test-cp",
      task: "Build API layer on top of data model",
      last_round_result: lr,
    });
    // Empty vault — no prior checkpoint to load
    const vault = { results: [], global_entries: [] };
    const response = compileL2(req, vault);
    assert.ok(response.prompt.includes("### Checkpoint: Data model done (Round 4)"));
    assert.ok(response.prompt.includes("Completed data model layer"));
    assert.ok(response.checkpoint_summary !== null);
    assert.equal(response.checkpoint_summary!.declared_at_round, 4);
  });

  it("no checkpoint in prompt when last_round_result has no checkpoint", () => {
    const lr = makeLoopRoundResult({
      round: 2,
      success: true,
      output_summary: "Fixed a bug",
      constraint_violations: [],
    });
    const req = makeLoopCompileRequest({
      round: 3,
      loop_id: "test-nocp",
      task: "Continue fixing bugs",
      last_round_result: lr,
    });
    const vault = { results: [], global_entries: [] };
    const response = compileL2(req, vault);
    assert.ok(!response.prompt.includes("### Checkpoint:"));
    assert.equal(response.checkpoint_summary, null);
  });

  it("loads existing checkpoint from vault on later rounds", () => {
    // Simulate a previous round that stored a checkpoint in vault
    const vault = {
      results: [
        {
          loop_lineage: { loop_id: "test-cp2", round: 3, success: true },
          checkpoint_summary: {
            label: "API layer done",
            declared_at_round: 3,
            outcome: "Built REST API",
            carried_constraints: ["auth required"],
            resolved_constraints: [],
          },
          task: "Build API",
          output_summary: "Built REST API",
          technique_used: "least-to-most",
        },
      ],
    };
    const lr = makeLoopRoundResult({
      round: 4,
      success: true,
      output_summary: "Added tests",
      constraint_violations: [],
    });
    const req = makeLoopCompileRequest({
      round: 5,
      loop_id: "test-cp2",
      task: "Add integration tests",
      last_round_result: lr,
    });
    const response = compileL2(req, vault);
    // Should load checkpoint from round 3
    assert.ok(response.prompt.includes("### Checkpoint: API layer done (Round 3)"));
    assert.ok(response.prompt.includes("Built REST API"));
    assert.ok(response.checkpoint_summary !== null);
    assert.equal(response.checkpoint_summary!.declared_at_round, 3);
  });
});
