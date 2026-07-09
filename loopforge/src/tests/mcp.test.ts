/** Tests for MCP server — session lifecycle and tool handlers.
 *
 * Process-inline: handlers are called directly (no stdio).
 * Uses MemoryBackend from _helpers.ts — no disk I/O.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryBackend } from "./_helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Build agent output with a valid self-eval block. */
function agentOutput(opts: {
  success?: boolean;
  violations?: string[];
  shouldContinue?: boolean;
  body?: string;
}): string {
  const hasSuccess = opts.success ?? true;
  const evalBlock = {
    success: hasSuccess,
    output_summary: opts.body ?? "Completed the task successfully.",
    constraint_violations: opts.violations ?? [],
    should_continue: opts.shouldContinue ?? true,
    // Include minimal execution evidence so enforcement gate R3
    // (empty success) doesn't reject valid test rounds.
    execution_evidence: hasSuccess ? {
      files_changed: ["src/test.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: [],
      success_criteria_remaining: [],
      progress_estimate: 0.5,
    } : undefined,
  };
  return [
    opts.body ?? "## Round Output\n\nAll checks passed.",
    "",
    "---loopforge-eval",
    JSON.stringify(evalBlock),
    "---end-loopforge-eval",
  ].join("\n");
}

/** Build agent output without a self-eval block (triggers stalled). */
function agentOutputNoEval(body?: string): string {
  return body ?? "## Round Output\n\nTask done. No eval block here.";
}

/** Build a structured evaluation object for the evaluation parameter of loopforge_next. */
function evalParam(opts: {
  success?: boolean;
  violations?: string[];
  shouldContinue?: boolean;
  body?: string;
}): Record<string, unknown> {
  const hasSuccess = opts.success ?? true;
  return {
    success: hasSuccess,
    output_summary: opts.body ?? "Completed the task successfully.",
    constraint_violations: opts.violations ?? [],
    should_continue: opts.shouldContinue ?? true,
    // Include minimal execution evidence so enforcement gate R3
    // (empty success) doesn't reject valid test rounds.
    execution_evidence: hasSuccess ? {
      files_changed: ["src/test.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: [],
      success_criteria_remaining: [],
      progress_estimate: 0.5,
    } : undefined,
  };
}

import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import { resetPolicy } from "../policy.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP — loopforge_start", async () => {
  let backend: MemoryBackend;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    backend = new MemoryBackend();
    mgr = new SessionManager(backend);
  });

  it("returns sessionId + Round 1 prompt (L2 compile)", async () => {
    const result = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20 token" });

    assert.equal(typeof result.sessionId, "string");
    assert.ok((result.sessionId as string).length > 0);
    assert.equal(result.round, 1);
    assert.equal(typeof result.prompt, "string");
    assert.ok((result.prompt as string).length > 0);
    assert.ok((result.prompt as string).includes("LoopForge"));
    assert.equal(typeof result.technique, "string");
    assert.equal(typeof result.level, "string");
  });
});

describe("MCP — multi-round lifecycle", async () => {
  let backend: MemoryBackend;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    backend = new MemoryBackend();
    mgr = new SessionManager(backend);
  });

  it("start → next × 3 → task_complete", async () => {
    // Round 1
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Audit ERC20",
      maxRounds: 20,
    });
    const sessionId = String(start.sessionId);

    // Round 1 → 2 (ascending quality [2, ...] avoids breaker)
    const r1 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: false, violations: ["missed check"], shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined, "round 2 should not stop");
    assert.equal(r1.round, 2);
    assert.ok(typeof r1.prompt === "string");

    // Round 2 → 3 (quality 5)
    const r2 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });
    assert.equal(r2.stopReason, undefined, "round 3 should not stop");
    assert.equal(r2.round, 3);

    // Round 3 → stop (should_continue: false)
    const r3 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: false }),
    });
    assert.equal(r3.prompt, null);
    assert.equal(r3.stopReason, "task_complete");
    assert.equal(r3.round, 3);
  });

  it("next without eval block → stalled", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Test stalled" });
    const sessionId = String(start.sessionId);

    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutputNoEval(),
    });

    assert.equal(result.prompt, null);
    assert.equal(result.stopReason, "stalled");
  });

  it("next with 3 consecutive failures → circuit_breaker", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Breaker test",
      maxRounds: 20,
    });
    const sessionId = String(start.sessionId);

    // 3 rounds of failures = [false, false, false] → breaker fires
    await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: false, shouldContinue: true }),
    });
    await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: false, shouldContinue: true }),
    });
    const r3 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: false, shouldContinue: true }),
    });

    assert.equal(r3.prompt, null);
    assert.equal(r3.stopReason, "circuit_breaker");
  });

  it("next at maxRounds stops", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Short loop",
      maxRounds: 2,
    });
    const sessionId = String(start.sessionId);

    // Round 1 → 2 (use ascending quality to avoid breaker)
    const r1 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: false, violations: ["x"], shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined);

    // Round 2 → stop (maxRounds reached)
    const r2 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });
    assert.equal(r2.prompt, null);
    assert.equal(r2.stopReason, "max_rounds");
    assert.equal(r2.round, 2);
  });

  // ── New: evaluation parameter tests ──────────────────────────────────

  it("next with evaluation parameter (no output) → advances normally", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Eval param test" });
    const sessionId = String(start.sessionId);

    const r1 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      evaluation: evalParam({ success: true, shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined, "should advance without output");
    assert.equal(r1.round, 2);
    assert.ok(typeof r1.prompt === "string");
  });

  it("next with evaluation parameter + output → advances normally", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Both sources test" });
    const sessionId = String(start.sessionId);

    const r1 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: "Some raw output text without eval block",
      evaluation: evalParam({ success: false, violations: ["v1"], shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined);
    assert.equal(r1.round, 2);
  });

  it("next with evaluation → task_complete when shouldContinue=false", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Eval complete test" });
    const sessionId = String(start.sessionId);

    const r1 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      evaluation: evalParam({ success: true, shouldContinue: false }),
    });
    assert.equal(r1.prompt, null);
    assert.equal(r1.stopReason, "task_complete");
  });

  it("next without evaluation or eval block in output → stalled", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "No eval stall" });
    const sessionId = String(start.sessionId);

    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutputNoEval("Just some text without any eval"),
    });
    assert.equal(result.prompt, null);
    assert.equal(result.stopReason, "stalled");
  });

  it("next with evaluation parameter (multi-round with discoveries)", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Multi-round eval test" });
    const sessionId = String(start.sessionId);

    // Round 1 → 2 with discovered constraints
    const r1 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      evaluation: {
        success: false,
        output_summary: "Found 2 reentrancy bugs, fixed 1.",
        constraint_violations: [],
        should_continue: true,
        discovered_constraints: ["All external calls must use SafeERC20"],
        execution_evidence: {
          files_changed: ["Token.sol"],
          test_results: { passed: 20, failed: 2, skipped: 0 },
          success_criteria_met: ["Reentrancy guard added to withdraw()"],
          success_criteria_remaining: ["Reentrancy guard for deposit()", "Access control audit"],
          progress_estimate: 0.4,
        },
      },
    });
    assert.equal(r1.stopReason, undefined);

    // Round 2 → stop
    const r2 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      evaluation: {
        success: true,
        output_summary: "All reentrancy bugs fixed. 24/24 tests pass.",
        constraint_violations: [],
        should_continue: false,
      },
    });
    assert.equal(r2.prompt, null);
    assert.equal(r2.stopReason, "task_complete");
  });
});

describe("MCP — session persistence (save / resume)", async () => {
  let backend: MemoryBackend;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    backend = new MemoryBackend();
    mgr = new SessionManager(backend);
  });

  it("create() persists session to vault as session_state entry", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "persist-test" });
    assert.ok(r1.prompt !== null);

    const entries = backend.queryEntries({ prefix: "loop:persist-test:session" });
    const sessionEntry = entries.find((e) => e.task_type === "session_state");
    assert.ok(sessionEntry !== undefined);
    assert.equal(sessionEntry!.loop_id, "persist-test");
    const lineage = sessionEntry!.loop_lineage as Record<string, unknown>;
    assert.equal(lineage.current_round, 1);
    assert.equal(lineage.status, "running");
  });

  it("advance() updates session_state after each round", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "advance-persist" });
    const sessionId = r1.sessionId;

    // Advance round 1 → compiles round 2
    const r2 = await mgr.advance(sessionId, agentOutput({
      success: true, shouldContinue: true,
    }));
    assert.ok(r2.prompt !== null);
    assert.equal(r2.round, 2);

    const entries = backend.queryEntries({ prefix: "loop:advance-persist:session" });
    const sessionEntry = entries.find((e) => e.task_type === "session_state");
    assert.ok(sessionEntry !== undefined);
    const lineage = sessionEntry!.loop_lineage as Record<string, unknown>;
    assert.equal(lineage.current_round, 2);
    const st = lineage.success_trajectory as boolean[];
    assert.ok(st.length >= 1, "success trajectory should have at least 1 entry");
  });

  it("advance() saves stopped status when task_complete", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "complete-persist" });
    const sessionId = r1.sessionId;

    await mgr.advance(sessionId, agentOutput({
      success: true, shouldContinue: false,
    }));

    const entries = backend.queryEntries({ prefix: "loop:complete-persist:session" });
    const sessionEntry = entries.find((e) => e.task_type === "session_state");
    assert.ok(sessionEntry !== undefined);
    const lineage = sessionEntry!.loop_lineage as Record<string, unknown>;
    assert.equal(lineage.status, "stopped");
  });

  it("advance() saves stalled status when no eval block", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "stall-persist" });
    const sessionId = r1.sessionId;

    await mgr.advance(sessionId, agentOutputNoEval("Just some text"));

    const entries = backend.queryEntries({ prefix: "loop:stall-persist:session" });
    const sessionEntry = entries.find((e) => e.task_type === "session_state");
    assert.ok(sessionEntry !== undefined);
    const lineage = sessionEntry!.loop_lineage as Record<string, unknown>;
    assert.equal(lineage.status, "stalled");
  });

  it("resume() returns prompt for next round after create", async () => {
    // Create session → simulates process dying after round 1 compile
    const r1 = await mgr.create({ task: "Test task", loopId: "resume-after-create" });
    assert.ok(r1.prompt !== null);

    // New SessionManager (simulating process restart)
    const mgr2 = new SessionManager(backend);
    const resumed = mgr2.resume("resume-after-create");
    assert.ok(resumed !== null, "resume should return a result");
    assert.ok(resumed!.prompt !== null, "resume should return a compiled prompt");
    assert.equal(resumed!.round, 1, "should compile round 1 again");
  });

  it("resume() recovers mid-loop state after advance", async () => {
    // Create and advance one round → simulates process dying after round 2 compile
    const r1 = await mgr.create({ task: "Test task", loopId: "resume-mid" });
    const r2 = await mgr.advance(r1.sessionId, agentOutput({
      success: true, shouldContinue: true,
    }));
    assert.equal(r2.round, 2);
    assert.ok(r2.prompt !== null);

    // New SessionManager (process restart)
    const mgr2 = new SessionManager(backend);
    const resumed = mgr2.resume("resume-mid");
    assert.ok(resumed !== null);
    assert.equal(resumed!.round, 2, "should pick up at round 2");
    assert.ok(resumed!.prompt !== null);
    assert.ok(resumed!.prompt!.length > 0);
  });

  it("resume() returns stopped result for completed loop", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "resume-done" });
    await mgr.advance(r1.sessionId, agentOutput({
      success: true, shouldContinue: false,
    }));

    const mgr2 = new SessionManager(backend);
    const resumed = mgr2.resume("resume-done");
    assert.ok(resumed !== null);
    assert.equal(resumed!.prompt, null);
    assert.ok(resumed!.stopReason === "stopped" || resumed!.stopReason === "task_complete");
  });

  it("resume() returns null for unknown loop", async () => {
    const mgr2 = new SessionManager(backend);
    const result = mgr2.resume("nonexistent-loop");
    assert.equal(result, null);
  });

  it("save() upserts — only one session_state entry per loop", async () => {
    await mgr.create({ task: "Test task", loopId: "upsert-test" });
    // Create another session for the same loop (simulating multiple sessions)
    const mgr2 = new SessionManager(backend);
    mgr2.create({ task: "Test task", loopId: "upsert-test" });

    const entries = backend.queryEntries({ prefix: "loop:upsert-test:session" });
    const sessionEntries = entries.filter((e) => e.task_type === "session_state");
    assert.equal(sessionEntries.length, 1, "should only have one session_state entry per loop");
  });
});

describe("MCP — status / list / stop / replay", async () => {
  let backend: MemoryBackend;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    backend = new MemoryBackend();
    mgr = new SessionManager(backend);
  });

  it("status returns correct round, quality, status", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Status test" });
    const sessionId = String(start.sessionId);

    // Advance once to populate quality
    await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });

    const status = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    assert.equal(status.sessionId, sessionId);
    assert.equal(status.round, 2);
    assert.equal(status.status, "running");
    assert.ok((status.successTrajectory as boolean[]).length >= 1);
  });

  it("list returns multiple sessions", async () => {
    await TOOL_HANDLERS.loopforge_start(mgr, { task: "Task A" });
    await TOOL_HANDLERS.loopforge_start(mgr, { task: "Task B" });

    const result = await TOOL_HANDLERS.loopforge_list(mgr, {});
    const sessions = result.sessions as Array<Record<string, unknown>>;
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((s) => typeof s.sessionId === "string"));
  });

  it("stop manually returns final trajectory", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Stop test" });
    const sessionId = String(start.sessionId);

    // Advance once
    await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });

    const result = await TOOL_HANDLERS.loopforge_stop(mgr, { sessionId });
    assert.equal(result.success, true);
    assert.equal(result.roundsCompleted, 2);
    assert.ok((result.successTrajectory as boolean[]).length >= 1);

    // Session should be gone
    const status = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    assert.ok("error" in status);
  });

  it("replay returns timeline", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Replay test" });
    const sessionId = String(start.sessionId);

    // Advance once to create lineage data
    await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });

    const result = await TOOL_HANDLERS.loopforge_replay(mgr, { sessionId });
    const timeline = result.timeline as Array<Record<string, unknown>>;
    assert.ok(timeline.length >= 1, "timeline should have entries");
    assert.equal(typeof timeline[0].round, "number");
    assert.equal(typeof timeline[0].technique_used, "string");
  });
});

describe("MCP — resume / list-vault / health", async () => {
  let backend: MemoryBackend;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    backend = new MemoryBackend();
    mgr = new SessionManager(backend);
  });

  it("loopforge_resume returns prompt via MCP handler", async () => {
    // Create session → save persists to vault
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Resume handler test",
      loopId: "resume-hdl-test",
    });
    assert.ok("sessionId" in start);

    // Simulate new SessionManager (process restart)
    const mgr2 = new SessionManager(backend);
    const result = await TOOL_HANDLERS.loopforge_resume(mgr2, {
      loopId: "resume-hdl-test",
    });
    assert.ok("prompt" in result, `expected prompt, got: ${JSON.stringify(result)}`);
    assert.ok(result.prompt !== null);
  });

  it("loopforge_resume returns error for unknown loop", async () => {
    const result = await TOOL_HANDLERS.loopforge_resume(mgr, {
      loopId: "nonexistent",
    });
    assert.ok("error" in result);
  });

  it("loopforge_list includes vault-persisted sessions after restart", async () => {
    // Create a session on mgr → saved to vault
    await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Vault list test",
      loopId: "vault-list-loop",
    });

    // Fresh SessionManager (process restart)
    const mgr2 = new SessionManager(backend);
    const result = await TOOL_HANDLERS.loopforge_list(mgr2, {});
    const sessions = result.sessions as Array<Record<string, unknown>>;

    const found = sessions.find((s) => s.loopId === "vault-list-loop");
    assert.ok(found !== undefined, "vault-persisted session should appear in list");
  });

  it("loopforge_health returns health data for a started loop", async () => {
    await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Health test task",
      loopId: "health-test",
      constraints: ["Must use TypeScript"],
    });

    const result = await TOOL_HANDLERS.loopforge_health(mgr, {
      loopId: "health-test",
    });
    assert.ok("goal_alignment" in result, `expected goal_alignment, got: ${JSON.stringify(result)}`);
    assert.ok("constraint_integrity" in result);
    assert.ok("drift_detected" in result);
    assert.ok("strategy_stability" in result);
    assert.ok("task_continuity" in result);
  });

  it("loopforge_health returns error for unknown loop", async () => {
    const result = await TOOL_HANDLERS.loopforge_health(mgr, {
      loopId: "nonexistent",
    });
    assert.ok("error" in result);
  });

  it("loopforge_status shows technique after compiling", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Technique status test",
      loopId: "technique-status",
    });
    const sessionId = String(start.sessionId);

    const status = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    const technique = status.technique as string;
    assert.ok(typeof technique === "string", "technique should be a string");
    assert.ok(technique.length > 0, "technique should not be empty");
  });
});
