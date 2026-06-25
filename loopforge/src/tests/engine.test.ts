/** Tests for engine: lifecycle, feedback, circuit breaker, metrics. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  LoopForgeEngine,
  createEngine,
} from "../engine.js";
import {
  AgentStatus,
  Mode,
  makeExecutionFeedback,
} from "../protocol.js";
import { resetPolicy } from "../policy.js";

function makeRequest(overrides: Record<string, unknown> = {}): import("../protocol.js").LoopForgeRequest {
  return {
    task: "Audit ERC20 token",
    mode: Mode.BUILD,
    vault_config: {
      project_vault: ".promptcraft/prompt_vault.json",
      global_vault: "~/.promptcraft/global_vault.json",
      skills_dir: "skills",
      no_global: false,
    },
    feedback: null,
    skill_name: null,
    task_id: null,
    ...overrides,
  };
}

describe("Engine — Initialisation", () => {
  beforeEach(() => resetPolicy());

  it("createEngine returns LoopForgeEngine instance", () => {
    const engine = createEngine("skills");
    assert.ok(engine instanceof LoopForgeEngine);
    assert.equal(engine.skillsDir, "skills");
    assert.equal(engine.state, null);
  });

  it("engine lazy-inits state on first invocation", () => {
    const engine = createEngine();
    engine.invokeBuild(makeRequest());
    assert.notEqual(engine.state, null);
    assert.equal(engine.state!.call_count, 0);
  });
});

describe("Engine — Build mode (internal)", () => {
  beforeEach(() => resetPolicy());

  it("returns OK with generated prompt", () => {
    const engine = createEngine();
    const result = engine.invokeBuild(makeRequest({ task: "Audit ERC20" }));
    assert.equal(result.status, AgentStatus.OK);
    assert.ok(result.response!.prompt!.includes("LoopForge Build"));
    assert.ok(result.response!.prompt!.includes("Audit ERC20"));
    assert.notEqual(result.response!.analysis, null);
  });

  it("sets technique in analysis", () => {
    const engine = createEngine();
    const result = engine.invokeBuild(makeRequest({
      task: "Rename getCwd to getCurrentWorkingDirectory",
    }));
    assert.equal(result.response!.analysis!.technique, "zero-shot");
  });
});

describe("Engine — Feedback mode", () => {
  beforeEach(() => resetPolicy());

  it("returns error when no feedback payload", () => {
    const engine = createEngine();
    const result = engine.invokeFeedback(makeRequest());
    assert.equal(result.status, AgentStatus.ERROR);
    assert.ok(result.response!.error!.includes("feedback payload"));
  });

  it("returns OK with quality score when feedback provided", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.FEEDBACK,
      feedback: makeExecutionFeedback({
        success: true,
        constraint_violations: [],
        manual_fixes_needed: "",
        output: "All tests passed",
      }),
    });
    const result = engine.invokeFeedback(req);
    assert.equal(result.status, AgentStatus.OK);
    assert.ok(result.response!.prompt!.includes("Quality Score: 5/5"));
  });

  it("scores quality=4 for success with fixes but no violations", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.FEEDBACK,
      feedback: makeExecutionFeedback({
        success: true,
        constraint_violations: [],
        manual_fixes_needed: "formatting",
        output: "Works with manual tweaks",
      }),
    });
    const result = engine.invokeFeedback(req);
    assert.ok(result.response!.prompt!.includes("Quality Score: 4/5"));
  });

  it("updates quality trend in state", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.FEEDBACK,
      feedback: makeExecutionFeedback({ success: true, output: "ok" }),
    });
    engine.invokeFeedback(req);
    assert.equal(engine.state!.quality_trend.length, 1);
    assert.equal(engine.state!.quality_trend[0], 5);
  });
});

describe("Engine — Circuit breaker", () => {
  beforeEach(() => resetPolicy());

  it("returns false when no state", () => {
    const engine = createEngine();
    assert.equal(engine.shouldBreak(), false);
  });

  it("returns false when not enough data points", () => {
    const engine = createEngine();
    engine.invokeBuild(makeRequest()); // init state
    engine.state!.quality_trend = [5, 4];
    assert.equal(engine.shouldBreak(), false);
  });

  it("returns true when quality is non-increasing for 3 rounds", () => {
    const engine = createEngine();
    engine.invokeBuild(makeRequest());
    engine.state!.quality_trend = [3, 3, 3];
    assert.equal(engine.shouldBreak(), true);
  });

  it("returns false when quality is improving", () => {
    const engine = createEngine();
    engine.invokeBuild(makeRequest());
    engine.state!.quality_trend = [3, 4, 5];
    assert.equal(engine.shouldBreak(), false);
  });
});

describe("Engine — Loop Compile mode", () => {
  beforeEach(() => resetPolicy());

  it("returns OK with compiled prompt for round 1", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.LOOP_COMPILE,
      loop_id: "test",
      round: 1,
      goal_id: "audit",
      task: "Audit ERC20 token",
    });
    const result = engine.invokeLoopCompile(req);
    assert.equal(result.status, AgentStatus.OK);
    assert.ok(result.response!.prompt!.includes("L2 Compile"));
  });

  it("includes loop health in prompt", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.LOOP_COMPILE,
      loop_id: "test",
      round: 1,
      goal_id: "audit",
      task: "Audit ERC20 token",
      loop_objective: {
        objective: "Full security audit",
        success_criteria: ["All tests pass"],
        hard_constraints: [],
        created_at_round: 1,
        loop_id: "test",
      },
    });
    const result = engine.invokeLoopCompile(req);
    assert.ok(result.response!.prompt!.includes("Loop Objective"));
  });

  it("handles round 2 with existing vault context", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.LOOP_COMPILE,
      loop_id: "test-r2",
      round: 2,
      goal_id: "audit",
      task: "Check approve race condition",
    });
    // Should fail gracefully to build mode fallback when no prior lineage
    const result = engine.invokeLoopCompile(req);
    assert.equal(result.status, AgentStatus.OK);
  });
});

describe("Engine — Review mode", () => {
  beforeEach(() => resetPolicy());

  it("returns error when no hydrate results", () => {
    const engine = createEngine();
    const result = engine.handleReview(makeRequest());
    assert.equal(result.status, AgentStatus.ERROR);
    assert.ok(result.response!.error!.includes("hydrate_results"));
  });

  it("returns report when hydrate results provided", () => {
    const engine = createEngine();
    const hydrateResults = {
      results: [
        {
          full_prompt: "角色: Security Auditor\n任务: Audit\n输入: Contract\n输出格式: Report\n硬约束: No deps\n生成要求: Complete",
        },
      ],
      global_entries: [],
    };
    const result = engine.handleReview(
      makeRequest({ mode: Mode.REVIEW }),
      hydrateResults,
    );
    assert.equal(result.status, AgentStatus.OK);
    assert.ok(result.response!.prompt!.includes("Review Report"));
  });
});
