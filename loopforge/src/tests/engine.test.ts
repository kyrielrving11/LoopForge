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
  makeLoopRoundResult,
  type LoopForgeRequest,
} from "../protocol.js";
import { resetPolicy } from "../policy.js";
import { installTestCommandProvider } from "./_helpers.js";
import { deriveItemId } from "../token-utils.js";

function makeRequest(overrides: Record<string, unknown> = {}): import("../protocol.js").LoopForgeRequest {
  return {
    task: "Audit ERC20 token",
    mode: Mode.LOOP_COMPILE,
    feedback: null,
    skill_name: null,
    task_id: null,
    // Prevents "LoopStore only accepts loop-scoped entries" warnings in tests
    // that don't explicitly set a loop_id. Engine tests use the real
    // FileLoopStore backend (via createEngine), so every write needs a
    // valid loop-scoped task_id.
    loop_id: "loop:engine-test",
    ...overrides,
  };
}

describe("Engine — Initialisation", () => {
  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence — install a real
    // passing command so R8 / success_unverified stay silent in these flows.
    installTestCommandProvider();
  });

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
  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence — install a real
    // passing command so R8 / success_unverified stay silent in these flows.
    installTestCommandProvider();
  });

  it("returns error when no feedback payload", () => {
    const engine = createEngine();
    const result = engine.invokeFeedback(makeRequest());
    assert.equal(result.status, AgentStatus.ERROR);
    assert.ok(result.response!.error!.includes("feedback payload"));
  });

  it("returns error when loop_id is missing (feedback is loop-scoped)", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.FEEDBACK,
      round: 1,
      loop_id: undefined,
      feedback: makeExecutionFeedback({
        success: true,
        constraint_violations: [],
        manual_fixes_needed: "",
        output: "All tests passed",
      }),
    });
    const result = engine.invokeFeedback(req);
    assert.equal(result.status, AgentStatus.ERROR);
    assert.ok(result.response!.error!.includes("loop_id"));
  });

  it("returns error when the feedback write fails", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.FEEDBACK,
      round: 1,
      loop_id: "../not-a-loop",
      feedback: makeExecutionFeedback({
        success: true,
        constraint_violations: [],
        manual_fixes_needed: "",
        output: "All tests passed",
      }),
    });
    const result = engine.invokeFeedback(req);
    assert.equal(result.status, AgentStatus.ERROR);
    assert.ok(result.response!.error!.includes("persisted"));
  });

  it("returns OK with success flag when feedback provided", () => {
    const engine = createEngine();
    const req = makeRequest({
      mode: Mode.FEEDBACK,
      round: 1,
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
      round: 1,
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
      round: 1,
      feedback: makeExecutionFeedback({ success: true, output: "ok" }),
    });
    engine.invokeFeedback(req);
    assert.equal(engine.state!.success_trend.length, 1);
    assert.equal(engine.state!.success_trend[0], true);
  });
});

describe("Engine — Circuit breaker (v2.5: removed)", () => {
  it("shouldBreak() method no longer exists — stalled loops are now detected by enforcement gate R4/R5", () => {
    const engine = createEngine();
    // shouldBreak was removed in v2.5. The enforcement gate (R4/R5) now
    // handles stall detection using progress_estimate gradients instead of
    // binary success/failure counting.
    assert.equal(typeof (engine as unknown as Record<string, unknown>).shouldBreak, "undefined");
  });
});

describe("Engine — Loop Compile mode", () => {
  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence — install a real
    // passing command so R8 / success_unverified stay silent in these flows.
    installTestCommandProvider();
  });

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
    // v2.8: L2 pointer mode renders "### Objective" (path B), not
    // "Loop Objective" from the full state blob (path A).
    assert.ok(result.response!.prompt!.includes("Full security audit"));
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
  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence — install a real
    // passing command so R8 / success_unverified stay silent in these flows.
    installTestCommandProvider();
  });

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
    // v3.2: error/warn flags carry actionable continuation lines.
    assert.ok(prompt.includes("→ Fix: Complete the remaining criteria"),
      "error flag must carry a Fix instruction");
    assert.ok(prompt.includes("→ Action: Correct progress_estimate"),
      "warn flag must carry an Action instruction");
  });
});

describe("v3.2 — presented-state persistence", () => {

  it("persists the L1 presented-state snapshot on the lineage entry (L0/L2 do not)", () => {
    const engine = createEngine();
    // Round 1: first_round → L2 → no presented snapshot.
    engine.invokeLoopCompile(makeRequest({
      mode: Mode.LOOP_COMPILE,
      loop_id: "ps-test",
      round: 1,
      goal_id: "audit",
      task: "Audit ERC20",
    }));
    // Round 2: continuation → L1 → presented snapshot persisted.
    const r2 = engine.invokeLoopCompile({
      ...makeRequest({
        mode: Mode.LOOP_COMPILE,
        loop_id: "ps-test",
        round: 2,
        goal_id: "audit",
        task: "Audit ERC20",
      }),
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: true,
        output_summary: "Made progress",
        constraint_violations: [],
        manual_fixes_needed: "",
      }),
    });
    assert.equal(r2.status, AgentStatus.OK);
    assert.equal(r2.response!.prompt_artifact!.level, "l1");

    const entries = engine.getStore().listEntries("ps-test");
    const r1Lineage = entries.find((e) => e.task_id === "loop:ps-test:r1");
    const r2Lineage = entries.find((e) => e.task_id === "loop:ps-test:r2");
    const l1 = r1Lineage?.loop_lineage as Record<string, unknown>;
    const l2 = r2Lineage?.loop_lineage as Record<string, unknown>;
    assert.equal(l1.presented_constraint_ids, undefined,
      "L2 compile must not persist a presented snapshot");
    assert.ok(Array.isArray(l2.presented_constraint_ids), "L1 compile must persist constraint ids");
    assert.ok(Array.isArray(l2.presented_subgoals), "L1 compile must persist sub-goals");
    assert.ok(Array.isArray(l2.presented_milestone_ranges), "L1 compile must persist milestone ranges");
  });

});

describe("Engine — last_round_result boundary (v3.3.1)", () => {
  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
  });

  it("preserves next_action and prompt_requests across the invokeLoopCompile boundary", () => {
    // Regression: the field-by-field last_round_result rebuild in
    // invokeLoopCompile silently dropped next_action and prompt_requests.
    // Every compile path funnels through this boundary, so on the real MCP
    // flow the "Next Action" section, suggested_next_task, sub-goal auto
    // in_progress, and prompt_requests (emphasize /
    // confusion_points) never reached the compiler — unit tests fed
    // compileLoop directly and missed the gap.
    const engine = createEngine();
    const result = engine.invokeLoopCompile(makeRequest({
      loop_id: "engine-boundary-next",
      round: 2,
      force_level: "l2",
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: false,
        output_summary: "Started the auth module",
        constraint_violations: [],
        manual_fixes_needed: "",
        next_action: "Finish the auth module",
        discovered_constraints: ["auth module"],
        prompt_requests: {
          emphasize: ["auth module"],
          confusion_points: ["What does machine-backed evidence mean?"],
        },
      }),
    }));
    assert.equal(result.status, AgentStatus.OK);
    const prompt = result.response?.prompt ?? "";
    // next_action must survive the boundary.
    assert.ok(prompt.includes("### Next Action"),
      "L2 must render the Next Action section");
    assert.ok(prompt.includes("Finish the auth module"),
      "the next_action text must reach the rendered prompt");
    assert.equal(result.response?.suggested_next_task, "Finish the auth module",
      "suggested_next_task must derive from the preserved next_action");
    // prompt_requests must survive the boundary.
    assert.ok(prompt.includes("🔴 Critical Context"),
      "emphasize must reach the Critical Context section");
    assert.ok(prompt.includes("⚠️ Confusion Alerts"),
      "confusion_points must render the Confusion Alerts section");
  });
});

describe("Engine — identity & round-view consistency (v3.3.1)", () => {
  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
  });

  it("renders a success-criterion text under ONE identity (cr-) in the L2 prompt", () => {
    // Regression: criterion texts are merged into the active constraint set,
    // and the active list used to re-derive a c-XXXXXXXX id for them while
    // their own Success Criteria section (and the verification gate's
    // criteriaMatch) speaks cr-XXXXXXXX. One text, two IDs — an agent
    // echoing the active-list ID into success_criteria_met could never match.
    const engine = createEngine();
    const result = engine.invokeLoopCompile(makeRequest({
      loop_id: "identity-loop",
      round: 1,
      task: "Deliver the data pipeline",
      force_level: "l2",
      loop_objective: {
        objective: "Deliver the data pipeline",
        success_criteria: ["Ship the ETL module"],
        hard_constraints: ["Never touch prod data"],
        created_at_round: 1,
        loop_id: "identity-loop",
      },
    }));
    assert.equal(result.status, AgentStatus.OK);
    const prompt = result.response?.prompt ?? "";
    const criterionHash = deriveItemId("Ship the ETL module");
    assert.ok(prompt.includes(`cr-${criterionHash}`),
      "the criterion must render under its cr- identity");
    assert.ok(!prompt.includes(`c-${criterionHash}`),
      "the same text must never render under a c- identity");
    const constraintHash = deriveItemId("Never touch prod data");
    assert.ok(prompt.includes(`c-${constraintHash}`),
      "a hard constraint keeps its c- identity");
    assert.ok(!prompt.includes(`cr-${constraintHash}`),
      "the constraint must never render under a cr- identity");
  });

  it("a delegation journal entry does not shadow the round's lineage view", () => {
    // Regression: recordDelegation writes loop:…:rN:delegations entries that
    // share lineage.round with the round. Compile-side round-level consumers
    // matched on the round number alone, so with worker_results the journal
    // (sorted after the lineage entry of the same round) became
    // getPreviousRound's answer: empty goal_id → spurious forced L2 and a
    // lost L1 collapse baseline.
    const engine = createEngine();
    const loopId = "journal-shadow";
    const task = "Orchestrate the port";
    const result1 = engine.invokeLoopCompile(makeRequest({
      loop_id: loopId,
      round: 1,
      task,
    }));
    assert.equal(result1.status, AgentStatus.OK);
    engine.autoFeedback({
      success: false,
      output_summary: "coordinated the sub-agents",
      constraint_violations: [],
      should_continue: true,
      worker_results: [{
        agentId: "w1",
        subAgentType: "general-purpose",
        subTask: "scan the module",
        resultSummary: "found the seam",
        success: true,
      }],
    }, loopId, 1, task);
    const result2 = engine.invokeLoopCompile(makeRequest({
      loop_id: loopId,
      round: 2,
      task,
    }));
    assert.equal(result2.status, AgentStatus.OK);
    const prompt = result2.response?.prompt ?? "";
    assert.ok(prompt.includes("Level: L1"),
      "round 2 with a clean previous round must continue at L1 — the " +
      "delegation journal must not masquerade as the previous round and " +
      "force an L2 recovery");
    assert.ok(!prompt.includes("Level: L2"),
      "the compiled prompt must not be forced into L2 by a journal entry");
  });
});
