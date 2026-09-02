/** Tests for MCP server — session lifecycle and tool handlers.
 *
 * Process-inline: handlers are called directly (no stdio).
 * Uses MemoryLoopStore from _helpers.ts — no disk I/O.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryLoopStore, installTestCommandProvider } from "./_helpers.js";
import { queryLoopEntries } from "../loop-store.js";
import type { LoopSessionDocument } from "../loop-store.js";

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
import { TOOL_HANDLERS, validateToolInput, validateToolOutput } from "../mcp/tools.js";
import { SERVER_INSTRUCTIONS } from "../mcp/server.js";
import { resetPolicy, getPolicy } from "../policy.js";
import type { SelfEvaluation } from "../protocol.js";
import { RoundTransactionCoordinator } from "../round-transaction.js";
import { SessionLeaseConflictError } from "../storage.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP — loopforge_start", async () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("returns sessionId + Round 1 prompt (L2 compile)", async () => {
    const result = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20 token" });

    assert.equal(typeof result.sessionId, "string");
    assert.ok((result.sessionId as string).length > 0);
    assert.equal(result.round, 1);
    assert.equal(typeof result.prompt, "string");
    assert.ok((result.prompt as string).length > 0);
    assert.ok((result.prompt as string).includes("LoopForge"));
    assert.equal(typeof result.level, "string");
  });
});

describe("MCP — multi-round lifecycle", async () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("start → next × 3 → task_complete", async () => {
    // Round 1
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Audit ERC20",
      maxRounds: 20,
    });
    const sessionId = String(start.sessionId);

    // Round 1 → 2 (ascending success trajectory avoids breaker)
    const r1 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      output: agentOutput({ success: false, violations: ["missed check"], shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined, "round 2 should not stop");
    assert.equal(r1.round, 2);
    assert.ok(typeof r1.prompt === "string");

    // Round 2 → 3 (roundSuccess true)
    const r2 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
      output: agentOutput({ success: true, shouldContinue: true }),
    });
    assert.equal(r2.stopReason, undefined, "round 3 should not stop");
    assert.equal(r2.round, 3);

    // Round 3 → stop (should_continue: false)
    const r3 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r2.roundId),
      output: agentOutput({ success: true, shouldContinue: false }),
    });
    assert.equal(r3.prompt, null);
    assert.equal(r3.stopReason, "completed");
    assert.equal(r3.round, 3);
  });

  it("next without eval block → stalled", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Test stalled" });
    const sessionId = String(start.sessionId);

    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      output: agentOutputNoEval(),
    });

    assert.equal(result.prompt, null);
    assert.equal(result.stopReason, "stalled");
  });

  it("3 consecutive success=false rounds continue normally (no false-positive circuit breaker)", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Long task — not done yet",
      maxRounds: 20,
    });
    const sessionId = String(start.sessionId);

    // 3 rounds of honest success=false (task not done, still making progress).
    // The old binary-success circuit breaker would have killed the loop here.
    // The new progress-based enforcement correctly lets it continue.
    let roundId = String(start.roundId);
    for (let i = 0; i < 2; i++) {
      const advanced = await TOOL_HANDLERS.loopforge_next(mgr, {
        sessionId,
        roundId,
        output: agentOutput({ success: false, shouldContinue: true }),
      });
      roundId = String(advanced.roundId);
    }
    const r3 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId,
      output: agentOutput({ success: false, shouldContinue: true }),
    });

    // Loop continues — no false-positive circuit breaker.
    assert.equal(r3.stopReason, undefined);
    assert.ok(typeof r3.prompt === "string" && r3.prompt.length > 50,
      "Loop should continue with next prompt, not be killed by circuit breaker");
  });

  it("next at maxRounds stops", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Short loop",
      maxRounds: 2,
    });
    const sessionId = String(start.sessionId);

    // Round 1 → 2 (use ascending successes to avoid breaker)
    const r1 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      output: agentOutput({ success: false, violations: ["x"], shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined);

    // Round 2 → stop (maxRounds reached)
    const r2 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
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
      roundId: String(start.roundId),
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
      roundId: String(start.roundId),
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
      roundId: String(start.roundId),
      evaluation: evalParam({ success: true, shouldContinue: false }),
    });
    assert.equal(r1.prompt, null);
    assert.equal(r1.stopReason, "completed");
  });

  it("next without evaluation or eval block in output → stalled", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "No eval stall" });
    const sessionId = String(start.sessionId);

    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
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
      roundId: String(start.roundId),
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

    // Round 2 → stop (v1.17: must include execution_evidence for success=true)
    const r2 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
      evaluation: {
        success: true,
        output_summary: "All reentrancy bugs fixed. 24/24 tests pass.",
        constraint_violations: [],
        should_continue: false,
        execution_evidence: {
          files_changed: ["Token.sol"],
          test_results: { passed: 24, failed: 0, skipped: 0 },
          success_criteria_met: ["Reentrancy guard for deposit()", "Access control audit"],
          success_criteria_remaining: [],
          progress_estimate: 1.0,
        },
      },
    });
    assert.equal(r2.prompt, null);
    assert.equal(r2.stopReason, "completed");
  });

  it("a stalled session accepts a corrected resubmission (v3.3.1)", async () => {
    // Regression: an unparseable submission stalled the session AND the
    // stalled result omitted roundId — loopforge_next requires roundId, so
    // the resubmission its own stopDetail asked for was impossible to build;
    // resume/unpause reject stalled, leaving the loop a tombstone.
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Test stalled recovery" });
    const sessionId = String(start.sessionId);

    const stalled = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      output: agentOutputNoEval("Round output without an eval block."),
    });
    assert.equal(stalled.stopReason, "stalled");
    assert.equal(typeof stalled.roundId, "string",
      "the stalled result must carry the round anchor so a resubmission can be constructed");

    // Corrected submission against the SAME session and round.
    const recovered = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(stalled.roundId),
      evaluation: evalParam({ success: false, shouldContinue: true }),
    });
    assert.notEqual(recovered.stopReason, "stalled",
      "the corrected resubmission must be processed, not stalled again");
    assert.notEqual(recovered.stopReason, "session_not_found");
    assert.equal(recovered.round, 2, "the round must advance after recovery");
    assert.ok(typeof recovered.prompt === "string" && recovered.prompt.length > 0,
      "round 2 must compile after the stalled session recovers");
  });

  it("a persistent recurring-violation offender terminates (v3.3.1 R6 ladder)", async () => {
    // Regression: R2 rejected on every occurrence and R6 (the generic
    // max-rejections ladder) sat after it in the priority array — R6 only
    // ran when no rule fired, so a repeat offender was rejected forever.
    // The un-laddered rules now escalate on the session's per-check
    // consecutive-rejection count: reject, reject, terminate.
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
    const sessionId = String(start.sessionId);
    const violationEval = (round: number, summary: string): Record<string, unknown> => ({
      success: false,
      output_summary: summary,
      should_continue: true,
      constraint_violations: ["Violate X"],
      execution_evidence: {
        files_changed: [`src/r${round}.ts`],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["Complete the task"],
        progress_estimate: 0.2 + round * 0.1,
      },
    });

    // Rounds 1–2 commit (recurring detection needs a 3-round window).
    let last = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      evaluation: violationEval(1, "Did round-one work"),
    });
    assert.ok(!last.enforcementAction || last.enforcementAction === "accept",
      "round 1 must advance");
    last = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(last.roundId),
      evaluation: violationEval(2, "Did round-two work"),
    });
    assert.ok(!last.enforcementAction || last.enforcementAction === "accept",
      "round 2 must advance");

    // Submission 3: same violation again → R2 fires (first occurrence).
    last = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(last.roundId),
      evaluation: violationEval(3, "Repeated the same violating work"),
    });
    assert.equal(last.enforcementAction, "reject",
      "the first recurring-violation occurrence must reject");
    // Submission 4: second consecutive same-check rejection.
    last = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(last.roundId),
      evaluation: violationEval(4, "Repeated the same violating work again"),
    });
    assert.equal(last.enforcementAction, "reject",
      "the second recurring-violation occurrence must reject");
    // Submission 5: third consecutive same-check rejection → terminate.
    last = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(last.roundId),
      evaluation: violationEval(5, "Still repeating the same violating work"),
    });
    assert.equal(last.enforcementAction, "terminate",
      "the third recurring-violation occurrence must terminate the loop");
    assert.equal(last.stopReason, "enforcement_terminated");
  });
});

describe("MCP — session persistence (save / resume)", async () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("create() persists session to vault as session_state entry", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "persist-test" });
    assert.ok(r1.prompt !== null);

    const entries = queryLoopEntries(store, "persist-test", { prefix: "loop:persist-test:session" });
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
      success: false, shouldContinue: true,
    }));
    assert.ok(r2.prompt !== null);
    assert.equal(r2.round, 2);

    const entries = queryLoopEntries(store, "advance-persist", { prefix: "loop:advance-persist:session" });
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

    const entries = queryLoopEntries(store, "complete-persist", { prefix: "loop:complete-persist:session" });
    const sessionEntry = entries.find((e) => e.task_type === "session_state");
    assert.ok(sessionEntry !== undefined);
    const lineage = sessionEntry!.loop_lineage as Record<string, unknown>;
    assert.equal(lineage.status, "stopped");
  });

  it("advance() saves stalled status when no eval block", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "stall-persist" });
    const sessionId = r1.sessionId;

    await mgr.advance(sessionId, agentOutputNoEval("Just some text"));

    const entries = queryLoopEntries(store, "stall-persist", { prefix: "loop:stall-persist:session" });
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
    mgr.close();
    const mgr2 = new SessionManager(store);
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
    mgr.close();
    const mgr2 = new SessionManager(store);
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

    const mgr2 = new SessionManager(store);
    const resumed = mgr2.resume("resume-done");
    assert.ok(resumed !== null);
    assert.equal(resumed!.prompt, null);
    assert.ok(resumed!.stopReason === "stopped" || resumed!.stopReason === "completed");
  });

  it("resume() returns null for unknown loop", async () => {
    const mgr2 = new SessionManager(store);
    const result = mgr2.resume("nonexistent-loop");
    assert.equal(result, null);
  });

  it("save() upserts — only one session_state entry per loop", async () => {
    await mgr.create({ task: "Test task", loopId: "upsert-test" });
    // A second live owner is fenced instead of overwriting the session.
    const mgr2 = new SessionManager(store);
    await assert.rejects(
      () => mgr2.create({ task: "Test task", loopId: "upsert-test" }),
      SessionLeaseConflictError,
    );

    const entries = queryLoopEntries(store, "upsert-test", { prefix: "loop:upsert-test:session" });
    const sessionEntries = entries.filter((e) => e.task_type === "session_state");
    assert.equal(sessionEntries.length, 1, "should only have one session_state entry per loop");
  });

  // ── v1.16: autoResumeAll ──────────────────────────────────────────────

  it("autoResumeAll() recovers running sessions on startup", async () => {
    // Create a session → saved to vault as session_state
    await mgr.create({ task: "Auto-resume test", loopId: "auto-resume-running" });

    // Simulate process restart with a fresh SessionManager on same store
    mgr.close();
    const mgr2 = new SessionManager(store);
    const resumed = mgr2.autoResumeAll();
    assert.equal(resumed, 1, "should resume one running session");

    // Verify it's in the in-memory session list
    const sessions = mgr2.list();
    const found = sessions.find(s => s.loopId === "auto-resume-running");
    assert.ok(found !== undefined, "resumed session should appear in list");
    assert.equal(found!.status, "running");
  });

  it("autoResumeAll() does not recover stopped sessions", async () => {
    // Create a session and advance it to task_complete so vault records status="stopped"
    const start = await mgr.create({ task: "Stopped test", loopId: "auto-resume-stopped" });
    const sid = String(start.sessionId);
    await mgr.advance(sid, "done", {
      success: true,
      output_summary: "All done",
      constraint_violations: [],
      should_continue: false,  // triggers completed → status="stopped"
      execution_evidence: {
        files_changed: ["src/test.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: [],
        progress_estimate: 1.0,
      },
    } as SelfEvaluation);

    // Simulate restart — vault should have status="stopped"
    const mgr2 = new SessionManager(store);
    const resumed = mgr2.autoResumeAll();
    assert.equal(resumed, 0, "stopped session should not be auto-resumed");

    // The stopped session might appear in list from vault, but it won't be "running"
    const sessions = mgr2.list();
    const found = sessions.find(s => s.loopId === "auto-resume-stopped");
    if (found) {
      assert.notEqual(found.status, "running");
    }
  });
});

describe("MCP — status / list / stop / replay", async () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("status returns correct round, roundSuccess, status", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Status test" });
    const sessionId = String(start.sessionId);

    // Advance once to populate roundSuccess and trajectory
    await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      output: agentOutput({ success: false, shouldContinue: true }),
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

    const result = await TOOL_HANDLERS.loopforge_status(mgr, { view: "all" });
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
      roundId: String(start.roundId),
      output: agentOutput({ success: false, shouldContinue: true }),
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
      roundId: String(start.roundId),
      output: agentOutput({ success: true, shouldContinue: true }),
    });

    const result = await TOOL_HANDLERS.loopforge_replay(mgr, { sessionId });
    const timeline = result.timeline as Array<Record<string, unknown>>;
    assert.ok(timeline.length >= 1, "timeline should have entries");
    assert.equal(typeof timeline[0].round, "number");
  });
});

describe("MCP — resume / list-vault / health", async () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("loopforge_resume returns prompt via MCP handler", async () => {
    // Create session → save persists to vault
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Resume handler test",
      loopId: "resume-hdl-test",
    });
    assert.ok("sessionId" in start);

    // Simulate new SessionManager (process restart)
    mgr.close();
    const mgr2 = new SessionManager(store);
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
    const mgr2 = new SessionManager(store);
    const result = await TOOL_HANDLERS.loopforge_status(mgr2, { view: "all" });
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

    const result = await TOOL_HANDLERS.loopforge_status(mgr, { view: "loop",
      loopId: "health-test",
    });
    assert.ok("goal_alignment" in result, `expected goal_alignment, got: ${JSON.stringify(result)}`);
    assert.ok("constraint_integrity" in result);
    assert.ok("drift_detected" in result);
    assert.ok("strategy_stability" in result);
    assert.ok("task_continuity" in result);
  });

  it("loopforge_health returns error for unknown loop", async () => {
    const result = await TOOL_HANDLERS.loopforge_status(mgr, { view: "loop",
      loopId: "nonexistent",
    });
    assert.ok("error" in result);
  });

  it("loopforge_status shows the current round identity", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Round status test",
      loopId: "round-status",
    });
    const sessionId = String(start.sessionId);

    const status = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    assert.equal(typeof status.roundId, "string");
  });
});

describe("MCP P0 lifecycle regressions", () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  const continuingEvaluation = (): SelfEvaluation => ({
    success: false,
    output_summary: "partial",
    constraint_violations: [],
    should_continue: true,
    execution_evidence: {
      files_changed: [],
      test_results: null,
      success_criteria_met: [],
      success_criteria_remaining: ["remaining"],
      progress_estimate: 0.4,
    },
  });

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("resumes a paused session as running and can advance", async () => {
    const started = await mgr.create({
      task: "Pause resume regression",
      loopId: "pause-resume-regression",
      maxRounds: 3,
    });
    assert.equal(mgr.pause(started.sessionId).status, "paused");

    const restarted = new SessionManager(store);
    const resumed = await TOOL_HANDLERS.loopforge_resume(restarted, {
      loopId: "pause-resume-regression",
    });
    const resumedId = String(resumed.sessionId);
    assert.ok(resumed.prompt !== null);
    assert.equal(restarted.get(resumedId)?.status, "running");

    const next = await TOOL_HANDLERS.loopforge_next(restarted, {
      sessionId: resumedId,
      roundId: String(resumed.roundId),
      evaluation: evalParam({ success: false, shouldContinue: false }),
    });
    assert.equal(next.stopReason, "failed");
  });

  it("commits the terminal trajectory and keeps completed replay available", async () => {
    // v3.3: this test deliberately exercises the UNVERIFIED path — R8 is
    // relaxed to warn and the command provider (installed by beforeEach) is
    // removed so the success claim stays unverified and out of the trajectory.
    resetPolicy();
    getPolicy().evidence.machine_backed_success = "warn";
    const started = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Terminal replay regression",
      loopId: "terminal-replay-regression",
    });
    const sessionId = String(started.sessionId);

    const completed = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(started.roundId),
      evaluation: evalParam({ success: true, shouldContinue: false }),
    });
    assert.equal(completed.stopReason, "completed");
    // v3.2: an unverified success commits the loop but never enters the
    // trajectory — success without machine observation is not progress.
    assert.deepEqual(mgr.get(sessionId)?.successTrajectory, []);

    const replay = await TOOL_HANDLERS.loopforge_replay(mgr, { sessionId });
    assert.ok(Array.isArray(replay.timeline));
    assert.ok((replay.timeline as unknown[]).length >= 1);

    const sessionEntry = queryLoopEntries(store, "terminal-replay-regression", {
      prefix: "loop:terminal-replay-regression:session",
    }).find((entry) => entry.task_type === "session_state");
    assert.deepEqual(sessionEntry?.loop_lineage?.success_trajectory, []);
  });

  it("serializes concurrent advances for the same session", async () => {
    const started = await mgr.create({
      task: "Concurrent advance regression",
      loopId: "concurrent-advance-regression",
      maxRounds: 30,
    });
    const sessionId = started.sessionId;
    let releaseProvider!: () => void;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mgr.contextProvider = async () => {
      markProviderStarted();
      await providerGate;
      return "";
    };

    const evaluation = {
      success: false,
      output_summary: "partial",
      constraint_violations: [],
      should_continue: true,
      execution_evidence: {
        files_changed: [],
        test_results: null,
        success_criteria_met: [],
        success_criteria_remaining: ["remaining"],
        progress_estimate: 0.4,
      },
    } as SelfEvaluation;

    const first = mgr.advance(sessionId, "", evaluation);
    await providerStarted;
    let secondSettled = false;
    const second = mgr.advance(sessionId, "", evaluation).then((result) => {
      secondSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(secondSettled, false);
    assert.equal(mgr.get(sessionId)?.currentRound, 2);
    releaseProvider();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.round, 2);
    assert.equal(secondResult.round, 3);
    assert.equal(mgr.get(sessionId)?.currentRound, 3);
  });

  it("does not revive a session paused during an in-flight advance", async () => {
    const started = await mgr.create({
      task: "Pause during advance regression",
      loopId: "pause-during-advance-regression",
      maxRounds: 30,
    });
    let releaseProvider!: () => void;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mgr.contextProvider = async () => {
      markProviderStarted();
      await providerGate;
      return "";
    };

    const advancing = mgr.advance(
      started.sessionId,
      "",
      continuingEvaluation(),
    );
    await providerStarted;
    assert.equal(mgr.pause(started.sessionId).status, "paused");
    releaseProvider();

    const result = await advancing;
    assert.equal(result.stopReason, "paused");
    assert.equal(result.prompt, null);
    assert.equal(mgr.get(started.sessionId)?.status, "paused");
  });

  it("does not revive a session stopped during an in-flight advance", async () => {
    const started = await mgr.create({
      task: "Stop during advance regression",
      loopId: "stop-during-advance-regression",
      maxRounds: 30,
    });
    let releaseProvider!: () => void;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    mgr.contextProvider = async () => {
      markProviderStarted();
      await providerGate;
      return "";
    };

    const advancing = mgr.advance(
      started.sessionId,
      "",
      continuingEvaluation(),
    );
    await providerStarted;
    assert.equal(mgr.delete(started.sessionId), true);
    releaseProvider();

    const result = await advancing;
    assert.equal(result.stopReason, "stopped");
    assert.equal(result.prompt, null);
    assert.equal(mgr.get(started.sessionId), undefined);
  });

  it("recovers a committed round after a crash without duplicate feedback", async () => {
    const started = await mgr.create({
      task: "Crash recovery transaction",
      loopId: "crash-recovery-transaction",
      maxRounds: 3,
    });
    const session = mgr.get(started.sessionId);
    assert.ok(session?.roundSnapshot);

    // Commit the round but deliberately skip SessionManager's state update,
    // simulating a process death between feedback commit and session save.
    const transaction = new RoundTransactionCoordinator(session.engine, store);
    const evaluation = continuingEvaluation();
    const committed = transaction.process({
      snapshot: session.roundSnapshot,
      task: session.task,
      maxRounds: session.maxRounds,
      selfEval: evaluation,
      consecutiveRejections: 0,
      successTrajectory: [],
      actualEvidence: session.evidenceBaseline ?? [],
    });
    assert.equal(committed.snapshot.phase, "committed");

    mgr.close();
    const restarted = new SessionManager(store);
    const resumed = restarted.resume("crash-recovery-transaction");
    assert.ok(resumed);
    assert.equal(resumed.sessionId, started.sessionId);
    assert.equal(resumed.round, 2);
    assert.notEqual(resumed.prompt, started.prompt);
    assert.notEqual(resumed.roundId, started.roundId);
    assert.equal(
      queryLoopEntries(store, "crash-recovery-transaction", {
        prefix: "loop:crash-recovery-transaction:r1",
        feedbackOnly: true,
      }).length,
      1,
    );
  });

  it("restores the compiled retry attempt with the same round ID and zero commit", async () => {
    const started = await mgr.create({
      task: "Rejected round recovery",
      loopId: "rejected-round-recovery",
      maxRounds: 3,
    });
    const rejectedEvaluation: SelfEvaluation = {
      success: true,
      output_summary: "premature success",
      constraint_violations: [],
      should_continue: true,
      execution_evidence: {
        files_changed: ["src/change.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["still open"],
        progress_estimate: 0.5,
      },
    };
    const rejected = await mgr.advance(
      started.sessionId,
      "",
      rejectedEvaluation,
    );
    assert.equal(rejected.enforcementAction, "reject");
    assert.equal(rejected.roundId, started.roundId);
    assert.equal(rejected.level, "l0");
    assert.match(rejected.prompt ?? "", /Attempt: 2/);
    assert.match(rejected.prompt ?? "", /Retry Requirements/);
    const lineageBefore = queryLoopEntries(store, "rejected-round-recovery", {
      prefix: "loop:rejected-round-recovery:r1",
    }).filter((entry) => entry.task_id === "loop:rejected-round-recovery:r1").length;

    mgr.close();
    const restarted = new SessionManager(store);
    const resumed = restarted.resume("rejected-round-recovery");
    assert.ok(resumed);
    assert.equal(resumed.sessionId, started.sessionId);
    assert.equal(resumed.prompt, rejected.prompt);
    assert.equal(resumed.roundId, started.roundId);
    assert.equal(resumed.level, "l0");
    assert.equal(
      queryLoopEntries(store, "rejected-round-recovery", {
        prefix: "loop:rejected-round-recovery:r1",
        feedbackOnly: true,
      }).length,
      0,
    );

    const accepted = await restarted.advance(
      resumed.sessionId,
      "",
      continuingEvaluation(),
    );
    assert.equal(accepted.round, 2);
    assert.notEqual(accepted.roundId, started.roundId);
    const lineageAfter = queryLoopEntries(store, "rejected-round-recovery", {
      prefix: "loop:rejected-round-recovery:r1",
    }).filter((entry) => entry.task_id === "loop:rejected-round-recovery:r1").length;
    assert.equal(lineageAfter, lineageBefore);
  });

  it("persists a session snapshot with one session write", async () => {
    class CountingStore extends MemoryLoopStore {
      writes = 0;
      override writeSession(loopId: string, document: LoopSessionDocument): void {
        this.writes++;
        super.writeSession(loopId, document);
      }
    }

    const counting = new CountingStore();
    const manager = new SessionManager(counting);
    const started = await manager.create({
      task: "Atomic session save",
      loopId: "atomic-session-save",
    });
    const session = manager.get(started.sessionId);
    assert.ok(session);
    counting.writes = 0;
    manager.save(session);
    assert.equal(counting.writes, 1);

    const persisted = counting.readSession("atomic-session-save")
      ?.entry?.loop_lineage?.round_snapshot as Record<string, unknown> | undefined;
    assert.equal(persisted?.schemaVersion, 1);
    assert.equal(persisted?.roundId, started.roundId);
  });
});

// v2.14: entry-point validation + declared output contracts.
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP — input and output contract enforcement", () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("rejects maxRounds that is not a positive integer", async () => {
    for (const bad of [0, -1, 1.5]) {
      const result = await TOOL_HANDLERS.loopforge_start(mgr, {
        task: "Validate maxRounds",
        maxRounds: bad,
      });
      assert.ok("error" in result, `maxRounds=${bad} must be rejected`);
      assert.ok((result.error as string).includes("maxRounds"));
    }
  });

  it("rejects an invalid loopId at the entry point", async () => {
    const result = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Validate loopId",
      loopId: "../escape",
    });
    assert.ok("error" in result);
    assert.ok((result.error as string).includes("loopId"));

    const resume = await TOOL_HANDLERS.loopforge_resume(mgr, {
      loopId: "../escape",
    });
    assert.ok("error" in resume);
  });

  it("validateToolOutput rejects schema-violating outputs", () => {
    assert.throws(
      () => validateToolOutput("loopforge_status", {
        round: "not-a-number",
      }),
      /must be number/,
    );
    // An explicitly-undefined optional field is the same as absent
    assert.doesNotThrow(() =>
      validateToolOutput("loopforge_resume", {
        sessionId: "s1",
        round: 1,
        prompt: null,
        roundSuccess: undefined,
      }));
  });

  it("rejects a same-process duplicate loopId instead of overwriting", async () => {
    const first = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Duplicate guard",
      loopId: "dup-guard",
    });
    assert.ok(!("error" in first));

    // v2.14: a second start for the same loopId must fail cleanly — the
    // old behavior silently overwrote the persisted session state and left
    // two in-memory sessions pointing at one loop.
    const second = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Duplicate guard again",
      loopId: "dup-guard",
    });
    assert.ok("error" in second, "second create must be rejected");
    assert.ok((second.error as string).includes("already exists"));

    // The first session remains intact and advanceable
    const advanced = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId: String(first.sessionId),
      roundId: String(first.roundId),
      evaluation: evalParam({ success: true }),
    });
    assert.ok(!("error" in advanced));
  });

  it("rejects loopforge_next without a roundId", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "RoundId required" });
    const sessionId = String(start.sessionId);

    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      evaluation: evalParam({ success: true }),
    });
    assert.ok("error" in result, "missing roundId must be rejected");
    assert.ok((result.error as string).includes("roundId"));
  });

  it("returns the held prompt with a warning when a stale roundId is submitted", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Stale roundId test" });
    const sessionId = String(start.sessionId);
    const roundOneId = String(start.roundId);

    // Round 1 commits → session advances to round 2 and holds its prompt
    const advanced = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: roundOneId,
      evaluation: evalParam({ success: true, shouldContinue: true }),
    });
    assert.equal(advanced.round, 2);
    assert.ok(typeof advanced.prompt === "string");

    // Duplicate submission of round 1's eval: must NOT process it against
    // round 2 — the held round-2 prompt is returned instead, with a warning.
    const duplicate = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: roundOneId,
      evaluation: evalParam({ success: true, shouldContinue: true }),
    });
    assert.equal(duplicate.round, 2, "round must not advance on a stale submission");
    assert.equal(duplicate.roundId, advanced.roundId);
    assert.equal(duplicate.prompt, advanced.prompt, "the held prompt is returned so the lost response is recovered");
    assert.ok((duplicate.warnings as string[]).some((w) => w.includes("does not match")),
      `expected a stale-roundId warning, got: ${JSON.stringify(duplicate.warnings)}`);

    // Zero commit: round 2 has no feedback entry, session still on round 2
    assert.equal(mgr.get(sessionId)?.currentRound, 2);
    const feedback = queryLoopEntries(store, String(mgr.get(sessionId)?.loopId), {
      prefix: `loop:${mgr.get(sessionId)?.loopId}:r2`,
      feedbackOnly: true,
    });
    assert.equal(feedback.length, 0, "a stale submission must not commit a round");

    // The loop still advances normally with the correct roundId
    const final = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(advanced.roundId),
      evaluation: evalParam({ success: true, shouldContinue: false }),
    });
    assert.equal(final.stopReason, "completed");
  });

  it("MemoryLoopStore listEntries mirrors the session-doc-is-storage contract", () => {
    // In production both writeSession and a raw session_state append route
    // to the same session.json — the document is the single copy. The test
    // double must replace the raw entry, not list both.
    store.appendEntry({
      task_id: "loop:mirror-test:session",
      task_type: "session_state",
      loop_id: "mirror-test",
      loop_lineage: { status: "running" },
    });
    store.writeSession("mirror-test", {
      schemaVersion: 1,
      loopId: "mirror-test",
      updatedAt: new Date().toISOString(),
      entry: {
        task_id: "loop:mirror-test:session",
        task_type: "session_state",
        loop_id: "mirror-test",
        loop_lineage: { status: "stopped" },
      },
    });
    const entries = store.listEntries("mirror-test");
    assert.equal(entries.length, 1);
    assert.equal(
      (entries[0].loop_lineage as Record<string, unknown>).status,
      "stopped",
      "the session document wins, matching production's single copy",
    );
  });
});


describe("MCP — v3.2 unverified success trajectory", () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    // v3.3: this suite deliberately exercises the UNVERIFIED path — no
    // command provider, and machine_backed_success=warn so R8 tolerates
    // the claim (warn instead of reject) while the success still never
    // enters the trajectory.
    getPolicy().evidence.commands = [];
    getPolicy().evidence.machine_backed_success = "warn";
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("an unverified success commits but never enters the success trajectory", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Unverified trajectory test" });
    const sessionId = String(start.sessionId);

    // success=true but no machine-verified observation (no real file change,
    // no command provider) → the round commits, the trajectory stays empty.
    const advanced = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      output: agentOutput({ success: true, shouldContinue: true }),
    });
    assert.equal(advanced.round, 2, "unverified success still advances the loop");
    const status = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    assert.deepEqual(status.successTrajectory, [],
      "an unverified success must not enter the trajectory");

    // A non-success round does.
    const second = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(advanced.roundId),
      output: agentOutput({ success: false, shouldContinue: true }),
    });
    const status2 = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    assert.deepEqual(status2.successTrajectory, [false],
      "a non-success round enters the trajectory");
    void second;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2.1: tool contract fixes — server instructions reference only real
// tools, and loopforge_next accepts the output-with-embedded-eval path.
// ═══════════════════════════════════════════════════════════════════════════
describe("MCP — tool contract (v3.2.1)", async () => {
  it("server instructions do not reference the nonexistent loopforge_list tool", () => {
    assert.ok(!SERVER_INSTRUCTIONS.includes("loopforge_list"),
      "instructions must not name a tool that does not exist");
    assert.ok(SERVER_INSTRUCTIONS.includes("loopforge_status"),
      "instructions must point agents at loopforge_status (view=all) instead");
    assert.ok(Object.hasOwn(TOOL_HANDLERS, "loopforge_status"),
      "loopforge_status must exist (list functionality moved into it)");
  });

  it("loopforge_next schema accepts output without the evaluation parameter", () => {
    // The embedded ---loopforge-eval path is only reachable if schema
    // validation lets an output-only submission through — the handler
    // requires EITHER evaluation OR output-with-eval-block.
    assert.doesNotThrow(() => {
      validateToolInput("loopforge_next", {
        sessionId: "s1",
        roundId: "r1",
        output: "## Round Output\n\n---loopforge-eval\n...",
      });
    }, "evaluation must not be required at the schema level");

    // sessionId + roundId remain required.
    assert.throws(() => {
      validateToolInput("loopforge_next", { output: "no anchors" });
    }, /required/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2.1: drift streak must not be polluted by non-R7 rejections, and the
// sub-goal lifecycle fields must persist on committed feedback entries.
// ═══════════════════════════════════════════════════════════════════════════
describe("MCP — drift streak & sub-goal persistence (v3.2.1)", async () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("a non-R7 rejection (recurring violation) does not pollute the drift streak", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
    const sessionId = String(start.sessionId);

    const evalFor = (round: number, summary: string): Record<string, unknown> => ({
      success: false,
      output_summary: summary,
      should_continue: true,
      next_action: "Refactor the auth module",
      constraint_violations: ["Violate X"],
      execution_evidence: {
        files_changed: [`src/r${round}.ts`],
        test_results: { passed: 0, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["Complete the task"],
        progress_estimate: 0.3,
      },
    });

    // Rounds 1–2: same violation, intent matches output.
    let last = start;
    for (const [round, summary] of [
      [1, "Refactored the auth module"],
      [2, "Refactored the auth module"],
    ] as Array<[number, string]>) {
      last = await TOOL_HANDLERS.loopforge_next(mgr, {
        sessionId,
        roundId: String(last.roundId),
        evaluation: evalFor(round, summary),
      });
      assert.ok(!last.enforcementAction || last.enforcementAction === "accept",
        `round ${round} must advance, got ${last.enforcementAction ?? "accept"}`);
    }

    // Round 3: SAME violation (3rd → recurring_violation flag, R2 fires)
    // AND drifted output ("Fixed the CSS…" vs next_action "Refactor the
    // auth module" → intent_drift flag). R2 has higher priority than R7,
    // so R7 never participates — the streak must stay untouched.
    const r3 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(last.roundId),
      evaluation: evalFor(3, "Fixed the CSS padding and layout issues"),
    });
    assert.equal(r3.enforcementAction, "reject", "R2 recurring violation must reject");
    const session = mgr.get(String(start.sessionId));
    assert.ok(session, "session must exist");
    assert.equal(
      session!.driftClarificationStreak, 0,
      "a rejection by a higher-priority rule must not increment the R7 streak",
    );
  });

  it("persists completed/blocked/canceled subtasks on the feedback entry", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
    const sessionId = String(start.sessionId);
    const started = mgr.get(String(start.sessionId));
    assert.ok(started, "session must exist after start");
    const loopId = started!.loopId;

    await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      evaluation: {
        success: false,
        output_summary: "Finished sg-a, hit a wall on sg-c, dropped sg-d.",
        should_continue: true,
        constraint_violations: [],
        emerged_subtasks: ["sg-b: next step"],
        completed_subtasks: ["sg-a: first step"],
        blocked_subtasks: ["sg-c: blocked step"],
        canceled_subtasks: ["sg-d: dropped step"],
        execution_evidence: {
          files_changed: ["src/a.ts"],
          test_results: { passed: 1, failed: 0, skipped: 0 },
          success_criteria_met: [],
          success_criteria_remaining: ["Complete the task"],
          progress_estimate: 0.3,
        },
      },
    });

    const feedback = queryLoopEntries(store, loopId, {
      prefix: `loop:${loopId}:r1`,
      feedbackOnly: true,
    });
    assert.equal(feedback.length, 1, "round 1 must have one feedback entry");
    assert.deepEqual(feedback[0].completed_subtasks, ["sg-a: first step"],
      "completed_subtasks must persist on the feedback entry (subgoal_drift reads it)");
    assert.deepEqual(feedback[0].blocked_subtasks, ["sg-c: blocked step"]);
    assert.deepEqual(feedback[0].canceled_subtasks, ["sg-d: dropped step"]);
    assert.deepEqual(feedback[0].emerged_subtasks, ["sg-b: next step"]);
  });

  it("three consecutive weak drift clarifications terminate the loop (v3.3.1 R7 streak)", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
    const sessionId = String(start.sessionId);

    // Round 1 aligns with its own next_action → clean continue. Its
    // next_action becomes the intent baseline for the drift checks.
    const r1 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      evaluation: {
        success: false,
        output_summary: "Refactored the auth module",
        should_continue: true,
        next_action: "Refactor the auth module",
        constraint_violations: [],
        execution_evidence: {
          files_changed: ["src/auth.ts"],
          test_results: { passed: 1, failed: 0, skipped: 0 },
          success_criteria_met: [],
          success_criteria_remaining: ["Complete the task"],
          progress_estimate: 0.3,
        },
      },
    });
    assert.ok(!r1.enforcementAction || r1.enforcementAction === "accept",
      "round 1 must advance cleanly, got " + String(r1.enforcementAction));

    // Every later submission drifts from the declared intent and carries NO
    // drift_clarification (weak by definition). Progress rises so R4/R5 stay
    // silent — this must exercise the R7 streak, not the stall rules.
    const driftEval = (attempt: number): Record<string, unknown> => ({
      success: false,
      output_summary: "Reworked the CSS grid and layout instead",
      should_continue: true,
      constraint_violations: [],
      execution_evidence: {
        files_changed: [`src/layout-${attempt}.ts`],
        test_results: { passed: 0, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["Complete the task"],
        progress_estimate: 0.3 + attempt * 0.1,
      },
    });
    const session = () => {
      const s = mgr.get(String(start.sessionId));
      assert.ok(s, "session must exist");
      return s;
    };

    // Drift #1 → R7 rejects (no clarification); the streak must increment.
    let last = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
      evaluation: driftEval(1),
    });
    assert.equal(last.enforcementAction, "reject", "drift #1 must reject");
    assert.ok(String(last.enforcementReason ?? "").includes("Declared intent was"),
      `drift #1 must be R7's intent_drift rejection (got: ${last.enforcementReason})`);
    assert.equal(session().driftClarificationStreak, 1,
      "an R7 weak-clarification rejection must increment the streak");

    // Drift #2 → R7 rejects again; streak reaches 2.
    last = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
      evaluation: driftEval(2),
    });
    assert.equal(last.enforcementAction, "reject", "drift #2 must reject");
    assert.ok(String(last.enforcementReason ?? "").includes("Declared intent was"),
      `drift #2 must be R7's intent_drift rejection (got: ${last.enforcementReason})`);
    assert.equal(session().driftClarificationStreak, 2,
      "the second R7 weak-clarification rejection must increment the streak to 2");

    // Drift #3 → R6 (escalation at 2 consecutive rejections) fires before R7
    // and rejects with max_rejections. The streak is untouched (R6 is not
    // R7) and the per-check rejection counter resets.
    last = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
      evaluation: driftEval(3),
    });
    assert.equal(last.enforcementAction, "reject", "drift #3 must reject");
    assert.ok(String(last.enforcementReason ?? "").includes("consecutive enforcement rejections"),
      `R6's escalation ladder must interleave on the third rejection (got: ${last.enforcementReason})`);
    assert.equal(session().driftClarificationStreak, 2,
      "a non-R7 rejection must not touch the streak");

    // Drift #4 → R7 sees streak 2 → newStreak 3 ≥ drift_clarification_max_streak
    // → terminate. This is the ladder the v3.3.1 fix restores: without the
    // reject-path clarificationAccepted echo, the streak never grew and the
    // loop rejected forever instead of terminating.
    last = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
      evaluation: driftEval(4),
    });
    assert.equal(last.enforcementAction, "terminate",
      "the third weak clarification must terminate the loop");
    assert.equal(last.stopReason, "enforcement_terminated");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Round Contract end-to-end (schema → parse → compile → prompt)
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP — Round Contract flow", async () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("round_contract passes the evaluation schema", () => {
    const input = evalParam({
      success: false,
      shouldContinue: true,
    });
    input.round_contract = {
      work_item: "Implement auth",
      done_when: ["cr-auth-login"],
      verification_plan: ["run-tests"],
      scope: ["src/auth"],
      boundary_reason: "vertical slice",
    };
    assert.doesNotThrow(() => {
      validateToolInput("loopforge_next", {
        sessionId: "s", roundId: "r", evaluation: input,
      });
    }, "a well-formed round_contract must pass loopforge_next schema validation");
  });

  it("a contract declared in round 1 renders as round 2's Current Task", async () => {
    const r1 = await mgr.create({ task: "Build the auth module", loopId: "contract-flow" });
    const sessionId = r1.sessionId;

    // Round 1's eval: honest partial progress + a declared contract for the
    // work the next round will execute under.
    const evalBlock = {
      success: false,
      output_summary: "Scaffolded auth; declared the round contract.",
      constraint_violations: [],
      should_continue: true,
      execution_evidence: {
        files_changed: ["src/auth.ts"],
        test_results: { passed: 0, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["cr-login-works"],
        progress_estimate: 0.2,
      },
      round_contract: {
        work_item: "Implement login flow",
        done_when: ["cr-login-works"],
        verification_plan: ["run-tests"],
        scope: ["src/auth"],
      },
    };
    const output = [
      "## Round Output",
      "Scaffolded the auth module.",
      "",
      "---loopforge-eval",
      JSON.stringify(evalBlock),
      "---end-loopforge-eval",
    ].join("\n");

    const r2 = await mgr.advance(sessionId, output);
    assert.ok(r2.prompt !== null);
    assert.equal(r2.round, 2);
    assert.ok(r2.prompt.includes("**Implement login flow**"),
      "round 2 prompt must carry the contract as Current Task");
    assert.ok(r2.prompt.includes("- Done when: cr-login-works"));
    assert.ok(r2.prompt.includes("- Verify via: run-tests"));
  });

  it("a contract-less round stays byte-identical to pre-contract rendering", async () => {
    const r1 = await mgr.create({ task: "Plain task", loopId: "contract-none" });
    const sessionId = r1.sessionId;
    const r2 = await mgr.advance(sessionId, agentOutput({ success: false }));
    assert.ok(r2.prompt !== null);
    assert.ok(r2.prompt.includes("Plain task"), "original task stays the Current Task");
    assert.ok(!r2.prompt.includes("Round Contract"), "no contract template without a contract");
  });

  // ── v3.4: active-contract lifecycle through the real advance path ────────

  const CONTRACT = (workItem: string): SelfEvaluation["round_contract"] => ({
    work_item: workItem,
    done_when: ["cr-login-works"],
    verification_plan: ["verify"], // the name installTestCommandProvider configures
    scope: ["src/auth"],
  });

  /** Partial honest eval: success=false + a declared proposal (or none). */
  const honest = (
    met: string[],
    remaining: string[],
    contract?: SelfEvaluation["round_contract"],
  ): SelfEvaluation => ({
    success: false,
    output_summary: "Worked the round.",
    constraint_violations: [],
    should_continue: true,
    execution_evidence: {
      files_changed: ["src/auth.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: met,
      success_criteria_remaining: remaining,
      progress_estimate: 0.4,
    },
    ...(contract ? { round_contract: contract } : {}),
  });

  it("v3.4: rejection mid-contract keeps the ACTIVE contract as the retry's Current Task", async () => {
    const started = await mgr.create({
      task: "Build the auth module",
      loopId: "contract-reject-mid",
      maxRounds: 4,
    });
    const a = CONTRACT("Implement login flow");
    // Round 1 declares A → round 2's Current Task is A.
    const r2 = await mgr.advance(
      started.sessionId,
      "",
      honest([], ["cr-login-works"], a),
    );
    assert.equal(r2.round, 2);
    assert.ok(String(r2.prompt ?? "").includes("**Implement login flow**"),
      "round 2 must execute under the ACTIVE contract");

    // Round 2 submits a deterministic rejection (success with open criteria).
    const rejected = await mgr.advance(started.sessionId, "", {
      success: true,
      output_summary: "premature success",
      constraint_violations: [],
      should_continue: true,
      execution_evidence: {
        files_changed: ["src/auth.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["cr-login-works"],
        progress_estimate: 0.5,
      },
    });
    assert.equal(rejected.enforcementAction, "reject");
    assert.equal(rejected.level, "l0");
    // v3.4: the retry compiles WITHOUT last_round_result, yet the derived
    // ACTIVE contract still renders as the Current Task…
    assert.ok(String(rejected.prompt ?? "").includes("**Implement login flow**"),
      "the L0 retry must keep the contract as Current Task (derived, not last_round_result)");
    assert.ok(!String(rejected.prompt ?? "").includes("round_contract"),
      "L0 retry stays lean — no restatement template");
  });

  it("v3.4: a satisfied contract reverts the next prompt to the original task", async () => {
    const started = await mgr.create({
      task: "Build the auth module",
      loopId: "contract-satisfied-revert",
      maxRounds: 4,
    });
    const a = CONTRACT("Implement login flow");
    const r2 = await mgr.advance(started.sessionId, "", honest([], ["cr-login-works"], a));
    assert.ok(String(r2.prompt ?? "").includes("**Implement login flow**"));
    // Round 2 completes A (all done_when met) and proposes nothing new.
    const r3 = await mgr.advance(
      started.sessionId,
      "",
      honest(["cr-login-works"], [], undefined),
    );
    assert.equal(r3.round, 3);
    assert.ok(String(r3.prompt ?? "").includes("Build the auth module"),
      "round 3 must fall back to the original task as Current Task");
    assert.ok(!String(r3.prompt ?? "").includes("**Implement login flow**"),
      "a satisfied contract must stop rendering");
  });

  it("v3.4: a premature replacement is ignored — the open contract continues", async () => {
    const started = await mgr.create({
      task: "Build the auth module",
      loopId: "contract-premature-replace",
      maxRounds: 4,
    });
    const a = CONTRACT("Implement login flow");
    const b = CONTRACT("Implement the admin panel");
    const r2 = await mgr.advance(started.sessionId, "", honest([], ["cr-login-works"], a));
    assert.ok(String(r2.prompt ?? "").includes("**Implement login flow**"));
    // Round 2 proposes B while A is still open (nothing met, not blocked) —
    // the machine keeps A as the Current Task for round 3.
    const r3 = await mgr.advance(started.sessionId, "", honest([], ["cr-login-works"], b));
    assert.equal(r3.round, 3);
    assert.ok(String(r3.prompt ?? "").includes("**Implement login flow**"),
      "the open ACTIVE contract must continue — B was premature");
    assert.ok(!String(r3.prompt ?? "").includes("**Implement the admin panel**"));
  });
});

describe("MCP — audit & vault replay (v3.3.1)", async () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  async function commitTwoRounds(): Promise<string> {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
    const sessionId = String(start.sessionId);
    let roundId = String(start.roundId);
    for (let i = 1; i <= 2; i++) {
      const advanced = await TOOL_HANDLERS.loopforge_next(mgr, {
        sessionId,
        roundId,
        evaluation: {
          success: false,
          output_summary: `Round ${i} progress`,
          constraint_violations: [],
          should_continue: true,
          execution_evidence: {
            files_changed: [`src/r${i}.ts`],
            test_results: { passed: 1, failed: 0, skipped: 0 },
            success_criteria_met: [],
            success_criteria_remaining: ["Complete the task"],
            progress_estimate: 0.2 + i * 0.1,
          },
        },
      });
      roundId = String(advanced.roundId);
    }
    const started = mgr.get(sessionId);
    return started!.loopId;
  }

  it("view=audit judges COMMITTED rounds (v3.3.1)", async () => {
    // Regression: getAudit queried without feedback entries, so the audit
    // never saw a committed decision and always reported an empty pass.
    const loopId = await commitTwoRounds();
    const audit = await TOOL_HANDLERS.loopforge_status(mgr, { view: "audit", loopId });
    assert.ok(Array.isArray(audit.rounds), "audit must expose a rounds list");
    assert.ok(audit.rounds.length >= 2,
      `committed rounds must be auditable (got ${audit.rounds.length})`);
    assert.equal(typeof audit.verdict, "string");
  });

  it("session view surfaces the engine session lifetime (v3.3.1)", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Lifetime probe" });
    const sessionId = String(start.sessionId);
    const view = await TOOL_HANDLERS.loopforge_status(mgr, { view: "session", sessionId });
    const metrics = view.metrics as Record<string, unknown>;
    assert.ok(typeof metrics?.startedAt === "number" && (metrics.startedAt as number) > 0,
      "engine sessionStart must be surfaced, not dead: " + JSON.stringify(metrics));
    assert.ok(typeof metrics?.sessionAgeSeconds === "number" && (metrics.sessionAgeSeconds as number) >= 0);
  });

  it("view=audit reports no audit data for a loop with zero committed rounds", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Never commits" });
    const loopId = mgr.get(String(start.sessionId))!.loopId;
    const audit = await TOOL_HANDLERS.loopforge_status(mgr, { view: "audit", loopId });
    assert.ok(String(audit.error ?? "").includes("no audit data"),
      "a loop without committed decisions must not be solemnly passed: " + JSON.stringify(audit));
    const missing = await TOOL_HANDLERS.loopforge_status(mgr, {
      view: "audit",
      loopId: "no-such-loop",
    });
    assert.ok(String(missing.error ?? "").includes("no audit data"),
      "a nonexistent loop must not audit as passed");
  });

  it("replays a loop straight from the vault after restart (v3.3.1)", async () => {
    const loopId = await commitTwoRounds();
    // New manager over the SAME store — no in-memory session survives.
    const restarted = new SessionManager(store);
    const replay = await TOOL_HANDLERS.loopforge_replay(restarted, { loopId });
    assert.equal(replay.error, undefined, JSON.stringify(replay));
    assert.equal(replay.loopId, loopId);
    const timeline = replay.timeline as unknown as unknown[];
    assert.ok(Array.isArray(timeline) && timeline.length >= 2,
      `vault replay must return the committed timeline (got ${String(timeline?.length)})`);
    const missing = await TOOL_HANDLERS.loopforge_replay(restarted, { loopId: "no-such-loop" });
    assert.ok(String(missing.error ?? "").includes("no committed rounds"));
  });
});
