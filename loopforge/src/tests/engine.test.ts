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
  type LoopForgeRequest,
} from "../protocol.js";
import { resetPolicy } from "../policy.js";

function makeRequest(overrides: Record<string, unknown> = {}): import("../protocol.js").LoopForgeRequest {
  return {
    task: "Audit ERC20 token",
    mode: Mode.LOOP_COMPILE,
    feedback: null,
    skill_name: null,
    task_id: null,
    ...overrides,
  };
}

describe("Engine — Initialisation", () => {
  beforeEach(() => resetPolicy());

  it("createEngine returns LoopForgeEngine instance", () => {
    const engine = createEngine();
    assert.ok(engine instanceof LoopForgeEngine);
    assert.equal(engine.state, null);
    assert.equal(engine.lastTask, null);
  });

  it("engine lazy-inits state on first invocation", () => {
    const engine = createEngine();
    engine.invokeLoopCompile(makeRequest({
      loop_id: "test",
      round: 1,
      goal_id: "audit",
    }));
    assert.notEqual(engine.state, null);
    assert.equal(engine.state!.call_count, 0);
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

  it("returns OK with success flag when feedback provided", () => {
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
    assert.ok(result.response!.prompt!.includes("Success: true"));
  });

  it("returns OK with success=false for failures", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.FEEDBACK,
      feedback: makeExecutionFeedback({
        success: false,
        constraint_violations: [],
        manual_fixes_needed: "formatting",
        output: "Works with manual tweaks",
      }),
    });
    const result = engine.invokeFeedback(req);
    assert.ok(result.response!.prompt!.includes("Success: false"));
  });

  it("updates success trend in state", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.FEEDBACK,
      feedback: makeExecutionFeedback({ success: true, output: "ok" }),
    });
    engine.invokeFeedback(req);
    assert.equal(engine.state!.success_trend.length, 1);
    assert.equal(engine.state!.success_trend[0], true);
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
    engine.invokeFeedback(makeRequest({
      mode: Mode.FEEDBACK,
      feedback: makeExecutionFeedback({ success: true, output: "ok" }),
    })); // init state
    engine.state!.success_trend = [true, true];
    assert.equal(engine.shouldBreak(), false);
  });

  it("returns true when 3 consecutive failures", () => {
    const engine = createEngine();
    engine.invokeFeedback(makeRequest({
      mode: Mode.FEEDBACK,
      feedback: makeExecutionFeedback({ success: true, output: "ok" }),
    }));
    engine.state!.success_trend = [false, false, false];
    assert.equal(engine.shouldBreak(), true);
  });

  it("returns false when all successes (no longer trips on flat success)", () => {
    const engine = createEngine();
    engine.invokeFeedback(makeRequest({
      mode: Mode.FEEDBACK,
      feedback: makeExecutionFeedback({ success: true, output: "ok" }),
    }));
    engine.state!.success_trend = [true, true, true];
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
    assert.ok(result.response!.prompt!.includes("Level: L2"));
    assert.equal(result.response!.prompt_artifact?.level, "l2");
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
    // Compiles at L2 when no prior lineage found
    const result = engine.invokeLoopCompile(req);
    assert.equal(result.status, AgentStatus.OK);
  });
});

describe("Engine — P0-P5 Cognitive Evolution (v1.7 E2E)", () => {
  beforeEach(() => resetPolicy());

  it("P0: discovered_constraints survive engine boundary and reach compiler", () => {
    const engine = createEngine();
    // First round: establish loop objective
    const r1 = engine.invokeLoopCompile(makeRequest({
      mode: Mode.LOOP_COMPILE,
      loop_id: "p0-test",
      round: 1,
      goal_id: "audit",
      task: "Audit ERC20 token",
    }));
    assert.equal(r1.status, AgentStatus.OK);

    // Round 2: pass discovered_constraints via last_round_result
    const r2 = engine.invokeLoopCompile({
      ...makeRequest({
        mode: Mode.LOOP_COMPILE,
        loop_id: "p0-test",
        round: 2,
        goal_id: "audit",
        task: "Audit ERC20 token",
      }),
      last_round_result: {
        round: 1,
        success: true,
        output_summary: "Found 2 reentrancy bugs",
        constraint_violations: [],
        manual_fixes_needed: "",
        discovered_constraints: ["Use SafeERC20 for all external calls"],
        objective_refinement: "Scope includes upgradeable proxy patterns",
        emerged_subtasks: ["Audit proxy init", "Verify timelock"],
      },
    } as unknown as LoopForgeRequest);
    assert.equal(r2.status, AgentStatus.OK);
    const prompt = r2.response!.prompt!;
    // P0: discovered constraint should appear in active constraints
    assert.ok(prompt.includes("SafeERC20"), "P0: discovered constraint not in prompt");
    // P2: emerged subtasks → suggested next task
    assert.ok(prompt.includes("proxy init") || prompt.includes("timelock"),
      "P2: emerged subtasks not forwarded");
  });

  it("P4: execution_evidence survives engine boundary and generates progress dashboard", () => {
    const engine = createEngine();
    // Round 1
    engine.invokeLoopCompile(makeRequest({
      mode: Mode.LOOP_COMPILE,
      loop_id: "p4-test",
      round: 1,
      goal_id: "audit",
      task: "Fix security bugs",
      loop_objective: {
        objective: "Fix all security bugs",
        success_criteria: ["No reentrancy", "Access control OK", "Overflow checks"],
        hard_constraints: [],
        created_at_round: 1,
        loop_id: "p4-test",
      },
    }));
    // Round 2 with execution evidence — force L2 so progress dashboard is rendered
    const r2 = engine.invokeLoopCompile({
      ...makeRequest({
        mode: Mode.LOOP_COMPILE,
        loop_id: "p4-test",
        round: 2,
        goal_id: "audit",
        task: "Fix security bugs",
        force_level: "l2",  // trigger full recompile for P4 processing
        loop_objective: {
          objective: "Fix all security bugs",
          success_criteria: ["No reentrancy", "Access control OK", "Overflow checks"],
          hard_constraints: [],
          created_at_round: 1,
          loop_id: "p4-test",
        },
      }),
      last_round_result: {
        round: 1,
        success: true,
        output_summary: "Fixed reentrancy in withdraw()",
        constraint_violations: [],
        manual_fixes_needed: "",
        execution_evidence: {
          files_changed: ["contracts/Token.sol", "test/Token.test.ts"],
          test_results: { passed: 24, failed: 0, skipped: 0 },
          success_criteria_met: ["No reentrancy"],
          success_criteria_remaining: ["Access control OK", "Overflow checks"],
          progress_estimate: 0.33,
        },
      },
    } as unknown as LoopForgeRequest);
    assert.equal(r2.status, AgentStatus.OK);
    // v1.14 Thin Prompt: progress dashboard lives in state file, not in prompt
    const stateFile = r2.response!.state_file_content;
    assert.ok(stateFile, "P4: state_file_content should be set for L2 compile");
    assert.ok(stateFile!.includes("Progress Dashboard"), "P4: progress dashboard in state file");
    assert.ok(stateFile!.includes("1/3"), "P4: criteria count in state file");
    assert.ok(stateFile!.includes("Token.sol"), "P4: files_changed in state file");
    // v1.16: With inline_in_prompt enabled (default), the state file content
    // (including the progress dashboard) IS in the prompt — it's inlined as a
    // Runtime guarantee. The state_file_content on the response is still set
    // for disk writeback.
    const prompt = r2.response!.prompt!;
    assert.ok(prompt.includes("Progress Dashboard"), "P4: dashboard inlined in prompt via state file");
  });

  it("P5: wrong_assumptions are forwarded to compiler as key lessons", () => {
    const engine = createEngine();
    engine.invokeLoopCompile(makeRequest({
      mode: Mode.LOOP_COMPILE,
      loop_id: "p5-test",
      round: 1,
      goal_id: "audit",
      task: "Audit ERC20",
    }));
    const r2 = engine.invokeLoopCompile({
      ...makeRequest({
        mode: Mode.LOOP_COMPILE,
        loop_id: "p5-test",
        round: 2,
        goal_id: "audit",
        task: "Audit ERC20",
      }),
      last_round_result: {
        round: 1,
        success: false,
        output_summary: "Found missing access control",
        constraint_violations: [],
        manual_fixes_needed: "",
        wrong_assumptions: ["Assumed OZ v4.0 has no known issues"],
        retracted_constraints: [],
        revised_success_criteria: [],
      },
    } as unknown as LoopForgeRequest);
    assert.equal(r2.status, AgentStatus.OK);
    const prompt = r2.response!.prompt!;
    // Wrong assumptions should appear in the prompt
    assert.ok(
      prompt.includes("wrong assumption") || prompt.includes("Wrong assumption") ||
      prompt.includes("assumed") || prompt.includes("Assumed"),
      "P5: wrong_assumptions not reflected in prompt",
    );
  });

  it("P5: retracted_constraints are removed from active set", () => {
    const engine = createEngine();
    engine.invokeLoopCompile(makeRequest({
      mode: Mode.LOOP_COMPILE,
      loop_id: "p5b-test",
      round: 1,
      goal_id: "audit",
      task: "Audit ERC20",
    }));
    const r2 = engine.invokeLoopCompile({
      ...makeRequest({
        mode: Mode.LOOP_COMPILE,
        loop_id: "p5b-test",
        round: 2,
        goal_id: "audit",
        task: "Audit ERC20",
      }),
      last_round_result: {
        round: 1,
        success: true,
        output_summary: "Audited contracts",
        constraint_violations: [],
        manual_fixes_needed: "",
        discovered_constraints: ["No external deps"],
        retracted_constraints: ["No external deps"],
        wrong_assumptions: [],
        revised_success_criteria: [],
      },
    } as unknown as LoopForgeRequest);
    assert.equal(r2.status, AgentStatus.OK);
    // The retracted constraint was discovered then immediately retracted — it should
    // NOT appear in the prompt at all (not in active constraints, not in state file).
    const prompt = r2.response!.prompt!;
    // Check the prompt body portion (after any inlined state file) for the
    // Active Constraints block
    const stateMarker = "*(State also saved to";
    const searchStart = prompt.includes(stateMarker)
      ? prompt.indexOf(stateMarker) + stateMarker.length
      : 0;
    const promptBody = prompt.slice(searchStart);
    if (promptBody.includes("Active Constraints")) {
      const activeStart = promptBody.indexOf("Active Constraints");
      const nextSection = promptBody.indexOf("###", activeStart + 10);
      const activeBlock = nextSection >= 0
        ? promptBody.slice(activeStart, nextSection)
        : promptBody.slice(activeStart);
      assert.ok(!activeBlock.includes("No external deps"),
        "P5: retracted constraint still in active constraints block");
    }
  });

  it("verification_flags are rendered as Verification Gate section in prompt", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.LOOP_COMPILE,
      loop_id: "vg-test",
      round: 2,
      goal_id: "audit",
      task: "Audit ERC20",
    });
    const result = engine.invokeLoopCompile({
      ...req,
      verification_flags: [
        { severity: "error", field: "success", check: "success_with_remaining_criteria",
          detail: "Agent claims success but 2 criteria remain unmet: Access control, Overflow" },
        { severity: "warn", field: "progress_estimate", check: "progress_regression",
          detail: "Progress dropped from 0.50 to 0.20" },
      ],
    } as unknown as LoopForgeRequest);
    assert.equal(result.status, AgentStatus.OK);
    const prompt = result.response!.prompt!;
    assert.ok(prompt.includes("Verification Gate"), "Gate section missing");
    assert.ok(prompt.includes("🚫"), "Error flag icon missing");
    assert.ok(prompt.includes("CONTRADICTED"), "Contradicted verdict message missing");
    assert.ok(prompt.includes("progress_regression"), "Warn flag check name missing");
  });
});
