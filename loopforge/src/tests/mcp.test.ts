/** Tests for MCP server — session lifecycle and tool handlers.
 *
 * Process-inline: handlers are called directly (no stdio).
 * Uses MemoryLoopStore from _helpers.ts — no disk I/O.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryLoopStore, installTestCommandProvider, criterionClaims } from "./_helpers.js";
import { queryLoopEntries } from "../loop-store.js";
import type { LoopSessionDocument } from "../loop-store.js";
import { deriveSubGoalId } from "../subgoal-state.js";
import { deriveContractItemIds } from "../token-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Build plain agent output. The authoritative report is the structured eval. */
function agentOutput(opts: {
  success?: boolean;
  violations?: string[];
  shouldContinue?: boolean;
  body?: string;
}): string {
  return opts.body ?? "## Round Output\n\nAll checks passed.";
}

/** Build agent output without a structured evaluation (triggers stalled internally). */
function agentOutputNoEval(body?: string): string {
  return body ?? "## Round Output\n\nTask done. No eval block here.";
}

/** Build a structured evaluation object for the evaluation parameter of loopforge_next. */
function evalParam(opts: {
  success?: boolean;
  violations?: string[];
  shouldContinue?: boolean;
  body?: string;
}): SelfEvaluation {
  const hasSuccess = opts.success ?? true;
  return {
    success: hasSuccess,
    output_summary: opts.body ?? "Completed the task successfully.",
    constraint_violations: opts.violations ?? [],
    should_continue: opts.shouldContinue ?? true,
    // Include minimal execution evidence so enforcement gate R3
    // (empty success) doesn't reject valid test rounds.
    execution_report: hasSuccess ? {
      files_changed: ["src/test.ts"],
      tests_reported: { passed: 1, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims([], []),
      progress_estimate: 0.5,
    } : undefined,
  };
}

import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS, validateToolInput, validateToolOutput } from "../mcp/tools.js";
import { SERVER_INSTRUCTIONS } from "../mcp/server.js";
import { resetPolicy, getPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";
import type { SelfEvaluation } from "../protocol.js";
import { RoundTransactionCoordinator } from "../round-transaction.js";
import { SessionLeaseConflictError } from "../storage.js";
import { deriveGate } from "../cognitive-governance.js";

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

describe("MCP — durable gate resolution", async () => {
  it("resolves a persisted gate after the owning process is recreated", async () => {
    resetPolicy();
    // v3.7.1: gates are opt-in — the blocked-round auto-record path only
    // runs when policy.gate.enabled.
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    installTestCommandProvider();
    const store = new MemoryLoopStore();
    const first = new SessionManager(store);
    const started = await TOOL_HANDLERS.loopforge_start(first, {
      task: "Review the release workflow",
    });
    const sessionId = String(started.sessionId);
    const loopId = String(store.listLoopIds()[0] ?? "");
    const action = "publish the release to production";
    const { id: gateId } = deriveGate(action);
    const advanced = await TOOL_HANDLERS.loopforge_next(first, {
      sessionId,
      roundId: String(started.roundId),
      output: "The release needs explicit production authorization.",
      evaluation: {
        success: false,
        output_summary: "Blocked pending production authorization.",
        constraint_violations: [],
        should_continue: true,
        outcome: "blocked",
        blocker: action,
      },
    });
    assert.equal(advanced.stopReason, undefined);
    assert.ok(store.entries.some((entry) => entry.task_type === "gate_opened" && entry.gate_id === gateId));

    // Release the first owner's lease, then use a fresh manager as a process
    // restart. The new manager has no in-memory session registry entry.
    first.close();
    const restarted = new SessionManager(store);
    const resolved = restarted.resolveGate(sessionId, gateId, true, "approved");
    assert.deepEqual(resolved, {
      sessionId,
      loopId,
      gateId,
      approved: true,
    });
    const decision = store.entries.find((entry) => entry.task_type === "gate_decision");
    assert.ok(decision);
    assert.equal(decision?.loop_id, loopId);
    assert.equal((decision?.loop_lineage as Record<string, unknown>)?.round, 1);
    restarted.close();
    resetPolicy();
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

  it("start → next × 3 → completed", async () => {
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
      evaluation: evalParam({ success: false, violations: ["missed check"], shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined, "round 2 should not stop");
    assert.equal(r1.round, 2);
    assert.ok(typeof r1.prompt === "string");

    // Round 2 → 3 (roundSuccess true)
    const r2 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
      output: agentOutput({ success: true, shouldContinue: true }),
      evaluation: evalParam({ success: true, shouldContinue: true }),
    });
    assert.equal(r2.stopReason, undefined, "round 3 should not stop");
    assert.equal(r2.round, 3);

    // Round 3 → stop (should_continue: false)
    const r3 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r2.roundId),
      output: agentOutput({ success: true, shouldContinue: false }),
      evaluation: evalParam({ success: true, shouldContinue: false }),
    });
    assert.equal(r3.prompt, null);
    assert.equal(r3.stopReason, "completed");
    assert.equal(r3.round, 3);
  });

  it("next without structured evaluation → input error", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Test stalled" });
    const sessionId = String(start.sessionId);

    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      output: agentOutputNoEval(),
    });

    assert.equal(result.error, "evaluation_invalid");
    assert.deepEqual((result.details as Record<string, unknown>).missing, ["evaluation"]);
  });

  it("rejects malformed core fields without consuming the round", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Core validation" });
    const entriesBefore = store.listEntries().length;
    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId: start.sessionId,
      roundId: start.roundId,
      evaluation: {
        success: "false",
        output_summary: "invalid core types",
        constraint_violations: ["valid", 42],
        should_continue: true,
      },
    });
    assert.equal(result.error, "evaluation_invalid");
    assert.deepEqual(
      (result.details as { invalid: Array<{ field: string }> }).invalid.map((item) => item.field),
      ["success", "constraint_violations"],
    );
    const status = mgr.get(String(start.sessionId));
    assert.equal(status?.status, "running");
    assert.equal(status?.currentRound, 1);
    // v3.7: an invalid evaluation returns BEFORE the gates and must write
    // nothing — no vault/session entry, no metrics, no rejection state.
    assert.equal(store.listEntries().length, entriesBefore,
      "invalid evaluation must not append any vault/session entry");
    assert.equal(status?.consecutiveRejections, 0, "no rejection state");
    assert.equal(status?.roundSnapshot?.roundId, start.roundId, "round not consumed");
  });

  it("normalizes malformed optional fields instead of rejecting the round", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Optional validation" });
    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId: start.sessionId,
      roundId: start.roundId,
      evaluation: {
        success: false,
        output_summary: "core report is valid",
        constraint_violations: [],
        should_continue: true,
        outcome: 42,
        blocker: ["invalid optional value"],
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.round, 2);
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
        evaluation: evalParam({ success: false, shouldContinue: true }),
      });
      roundId = String(advanced.roundId);
    }
    const r3 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId,
      output: agentOutput({ success: false, shouldContinue: true }),
      evaluation: evalParam({ success: false, shouldContinue: true }),
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
      evaluation: evalParam({ success: false, violations: ["x"], shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined);

    // Round 2 → stop (maxRounds reached)
    const r2 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
      output: agentOutput({ success: true, shouldContinue: true }),
      evaluation: evalParam({ success: true, shouldContinue: true }),
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

  it("next with evaluation → completed when shouldContinue=false", async () => {
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

  it("next without structured evaluation returns a format error", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "No eval stall" });
    const sessionId = String(start.sessionId);

    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      output: agentOutputNoEval("Just some text without any eval"),
    });
    assert.equal(result.error, "evaluation_invalid");
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
        execution_report: {
          files_changed: ["Token.sol"],
          tests_reported: { passed: 20, failed: 2, skipped: 0 },
          criterion_claims: criterionClaims(["Reentrancy guard added to withdraw()"], ["Reentrancy guard for deposit()", "Access control audit"]),
          progress_estimate: 0.4,
        },
      },
    });
    assert.equal(r1.stopReason, undefined);

    // Round 2 → stop (v1.17: must include execution_report for success=true)
    const r2 = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(r1.roundId),
      evaluation: {
        success: true,
        output_summary: "All reentrancy bugs fixed. 24/24 tests pass.",
        constraint_violations: [],
        should_continue: false,
        execution_report: {
          files_changed: ["Token.sol"],
          tests_reported: { passed: 24, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims(["Reentrancy guard for deposit()", "Access control audit"], []),
          progress_estimate: 1.0,
        },
      },
    });
    assert.equal(r2.prompt, null);
    assert.equal(r2.stopReason, "completed");
  });

  it("a rejected format submission can be corrected with the same roundId", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Test format recovery" });
    const sessionId = String(start.sessionId);

    const invalid = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      output: agentOutputNoEval("Round output without an eval block."),
    });
    assert.equal(invalid.error, "evaluation_invalid");

    // Corrected submission against the SAME session and round.
    const recovered = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      evaluation: evalParam({ success: false, shouldContinue: true }),
    });
    assert.notEqual(recovered.stopReason, "stalled",
      "the corrected resubmission must be processed normally");
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
      execution_report: {
        files_changed: [`src/r${round}.ts`],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], ["Complete the task"]),
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
    }), evalParam({ success: false, shouldContinue: true }));
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

  it("advance() saves stopped status when completed", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "complete-persist" });
    const sessionId = r1.sessionId;

    await mgr.advance(sessionId, agentOutput({
      success: true, shouldContinue: false,
    }), evalParam({ success: true, shouldContinue: false }));

    const entries = queryLoopEntries(store, "complete-persist", { prefix: "loop:complete-persist:session" });
    const sessionEntry = entries.find((e) => e.task_type === "session_state");
    assert.ok(sessionEntry !== undefined);
    const lineage = sessionEntry!.loop_lineage as Record<string, unknown>;
    assert.equal(lineage.status, "stopped");
  });

  it("advance() leaves the session running when evaluation is absent", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "stall-persist" });
    const sessionId = r1.sessionId;
    const beforeEntries = JSON.stringify(store.listEntries("stall-persist"));
    const beforeMetrics = JSON.stringify(mgr.getPolicyMetrics("stall-persist"));
    const beforeRoundDocuments = store.rounds.size;

    const invalid = await mgr.advance(sessionId, agentOutputNoEval("Just some text"));
    assert.equal(invalid.stopReason, "evaluation_invalid");
    assert.equal(JSON.stringify(store.listEntries("stall-persist")), beforeEntries,
      "format errors must not save session or vault state");
    assert.equal(JSON.stringify(mgr.getPolicyMetrics("stall-persist")), beforeMetrics,
      "format errors must not affect metrics");
    assert.equal(store.rounds.size, beforeRoundDocuments,
      "format errors must not create a round document");

    const entries = queryLoopEntries(store, "stall-persist", { prefix: "loop:stall-persist:session" });
    const sessionEntry = entries.find((e) => e.task_type === "session_state");
    assert.ok(sessionEntry !== undefined);
    const lineage = sessionEntry!.loop_lineage as Record<string, unknown>;
    assert.equal(lineage.status, "running");
  });

  it("resume() returns prompt for next round after create", async () => {
    // Create session → simulates process dying after round 1 compile
    const r1 = await mgr.create({ task: "Test task", loopId: "resume-after-create" });
    assert.ok(r1.prompt !== null);

    // New SessionManager (simulating process restart)
    mgr.close();
    const mgr2 = new SessionManager(store);
    const resumed = await mgr2.resume("resume-after-create");
    assert.ok(resumed !== null, "resume should return a result");
    assert.ok(resumed!.prompt !== null, "resume should return a compiled prompt");
    assert.equal(resumed!.round, 1, "should compile round 1 again");
  });

  it("resume() recovers mid-loop state after advance", async () => {
    // Create and advance one round → simulates process dying after round 2 compile
    const r1 = await mgr.create({ task: "Test task", loopId: "resume-mid" });
    const r2 = await mgr.advance(r1.sessionId, agentOutput({
      success: true, shouldContinue: true,
    }), evalParam({ success: true, shouldContinue: true }));
    assert.equal(r2.round, 2);
    assert.ok(r2.prompt !== null);

    // New SessionManager (process restart)
    mgr.close();
    const mgr2 = new SessionManager(store);
    const resumed = await mgr2.resume("resume-mid");
    assert.ok(resumed !== null);
    assert.equal(resumed!.round, 2, "should pick up at round 2");
    assert.ok(resumed!.prompt !== null);
    assert.ok(resumed!.prompt!.length > 0);
  });

  it("resume() returns stopped result for completed loop", async () => {
    const r1 = await mgr.create({ task: "Test task", loopId: "resume-done" });
    await mgr.advance(r1.sessionId, agentOutput({
      success: true, shouldContinue: false,
    }), evalParam({ success: true, shouldContinue: false }));

    const mgr2 = new SessionManager(store);
    const resumed = await mgr2.resume("resume-done");
    assert.ok(resumed !== null);
    assert.equal(resumed!.prompt, null);
    assert.ok(resumed!.stopReason === "stopped" || resumed!.stopReason === "completed");
  });

  it("resume() returns null for unknown loop", async () => {
    const mgr2 = new SessionManager(store);
    const result = await mgr2.resume("nonexistent-loop");
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
    // Create a session and complete it so vault records status="stopped".
    const start = await mgr.create({ task: "Stopped test", loopId: "auto-resume-stopped" });
    const sid = String(start.sessionId);
    await mgr.advance(sid, "done", {
      success: true,
      output_summary: "All done",
      constraint_violations: [],
      should_continue: false,  // triggers completed → status="stopped"
      execution_report: {
        files_changed: ["src/test.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], []),
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
      evaluation: evalParam({ success: false, shouldContinue: true }),
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
      evaluation: evalParam({ success: false, shouldContinue: true }),
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
      evaluation: evalParam({ success: true, shouldContinue: true }),
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

  it("loopforge_status view=loop returns machine counts for a started loop", async () => {
    await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Health test task",
      loopId: "health-test",
      constraints: ["Must use TypeScript"],
    });

    const result = await TOOL_HANDLERS.loopforge_status(mgr, { view: "loop",
      loopId: "health-test",
    });
    // v3.8.1: goal_alignment / drift_detected / strategy_stability /
    // task_continuity are gone — every one was a text-similarity verdict, and
    // two were degenerate in this view (task_continuity pinned to 1.0,
    // strategy_stability a literal true). What remains is counted from
    // committed round flags.
    assert.ok("committed_rounds" in result,
      `expected committed_rounds, got: ${JSON.stringify(result)}`);
    assert.ok("rounds_with_unverified_items" in result);
    assert.ok("unverified_streak_limit" in result);
    assert.ok("policy_metrics" in result);
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
    execution_report: {
      files_changed: [],
      tests_reported: null,
      criterion_claims: criterionClaims([], ["remaining"]),
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
    // v3.8: this test deliberately exercises the UNVERIFIED path — the
    // command provider installed by beforeEach is removed, so the success
    // claim stays unbacked and out of the success trajectory.
    resetPolicy();
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
      execution_report: {
        files_changed: [],
        tests_reported: null,
        criterion_claims: criterionClaims([], ["remaining"]),
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
    const resumed = await restarted.resume("crash-recovery-transaction");
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
      execution_report: {
        files_changed: ["src/change.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], ["still open"]),
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
    const resumed = await restarted.resume("rejected-round-recovery");
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
    assert.equal(persisted?.schemaVersion, 2);
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
      assert.equal(result.error, "invalid_argument", "the CODE is stable");
      assert.ok((result.errorMessage as string).includes("maxRounds"),
        "the human sentence rides in errorMessage, never in the code");
    }
  });

  it("rejects an invalid loopId at the entry point", async () => {
    const result = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Validate loopId",
      loopId: "../escape",
    });
    assert.ok("error" in result);
    assert.equal(result.error, "invalid_argument");
    assert.ok((result.errorMessage as string).includes("loopId"));

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
    assert.equal(second.error, "loop_already_running");
    assert.ok((second.errorMessage as string).includes("already exists"));

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
    assert.equal(result.error, "round_id_required");
    assert.ok((result.errorMessage as string).includes("roundId"));
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
    // v3.8: this suite deliberately exercises the UNVERIFIED path — no
    // command provider is configured, so success claims stay unbacked and
    // never enter the success trajectory.
    getPolicy().evidence.commands = [];
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
      evaluation: evalParam({ success: true, shouldContinue: true }),
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
      evaluation: evalParam({ success: false, shouldContinue: true }),
    });
    const status2 = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    assert.deepEqual(status2.successTrajectory, [false],
      "a non-success round enters the trajectory");
    void second;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool contract fixes — server instructions reference only real tools, and
// loopforge_next requires a structured evaluation at the MCP boundary.
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

  it("loopforge_next schema requires the evaluation parameter", () => {
    assert.throws(() => {
      validateToolInput("loopforge_next", {
        sessionId: "s1",
        roundId: "r1",
        output: "## Round Output",
      });
    }, /evaluation is required/);

    assert.doesNotThrow(() => {
      validateToolInput("loopforge_next", {
        sessionId: "s1",
        roundId: "r1",
        evaluation: evalParam({ success: false, shouldContinue: true }),
      });
    });

    assert.throws(() => {
      validateToolInput("loopforge_next", {
        sessionId: "s1",
        roundId: "r1",
        evaluation: {
          success: "false",
          output_summary: "invalid core",
          constraint_violations: [],
          should_continue: true,
        },
      });
    }, /evaluation\.success must be boolean/);

    assert.doesNotThrow(() => {
      validateToolInput("loopforge_next", {
        sessionId: "s1",
        roundId: "r1",
        evaluation: {
          success: false,
          output_summary: "valid core",
          constraint_violations: [],
          should_continue: true,
          outcome: 42,
          execution_report: "malformed optional value",
        },
      });
    }, "optional evaluation fields must reach runtime normalization");

    // sessionId + roundId remain required.
    assert.throws(() => {
      validateToolInput("loopforge_next", { output: "no anchors" });
    }, /required/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2.1: the sub-goal lifecycle fields must persist on committed feedback
// entries (the drift-streak arm was deleted in v3.8 with R7).
// ═══════════════════════════════════════════════════════════════════════════
describe("MCP — sub-goal persistence (v3.2.1)", async () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("persists subgoal_updates transitions on the feedback entry", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
    const sessionId = String(start.sessionId);
    const started = mgr.get(String(start.sessionId));
    assert.ok(started, "session must exist after start");
    const loopId = started!.loopId;

    // v3.8: ids are scoped to the declaration event (loop, round, ordinal).
    const round1 = Number(started!.currentRound);
    const doneId = deriveSubGoalId(loopId, round1, 0, "first step");
    const blockedId = deriveSubGoalId(loopId, round1, 1, "blocked step");
    const canceledId = deriveSubGoalId(loopId, round1, 2, "dropped step");

    await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      roundId: String(start.roundId),
      evaluation: {
        success: false,
        output_summary: "Finished the first step, hit a wall, dropped a step.",
        should_continue: true,
        constraint_violations: [],
        emerged_subtasks: ["first step", "blocked step", "dropped step", "next step"],
        subgoal_updates: [
          { id: doneId, status: "done" },
          { id: blockedId, status: "blocked" },
          { id: canceledId, status: "canceled" },
        ],
        execution_report: {
          files_changed: ["src/a.ts"],
          tests_reported: { passed: 1, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims([], ["Complete the task"]),
          progress_estimate: 0.3,
        },
      },
    });

    const feedback = queryLoopEntries(store, loopId, {
      prefix: `loop:${loopId}:r1`,
      feedbackOnly: true,
    });
    assert.equal(feedback.length, 1, "round 1 must have one feedback entry");
    assert.deepEqual(feedback[0].subgoal_updates, [
      { id: doneId, status: "done" },
      { id: blockedId, status: "blocked" },
      { id: canceledId, status: "canceled" },
    ], "subgoal_updates must persist on the feedback entry (compiler replays it)");
    assert.deepEqual(feedback[0].emerged_subtasks, ["first step", "blocked step", "dropped step", "next step"]);
  });

  it("rejects an unknown sub-goal ID pre-advance without consuming the round", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
    const entriesBefore = store.listEntries().length;
    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId: start.sessionId,
      roundId: start.roundId,
      evaluation: {
        success: false,
        output_summary: "claimed a transition on a phantom goal",
        should_continue: true,
        constraint_violations: [],
        subgoal_updates: [{ id: "sg-00000000", status: "done" }],
        execution_report: {
          files_changed: ["src/a.ts"],
          tests_reported: { passed: 1, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims([], ["Complete the task"]),
          progress_estimate: 0.3,
        },
      },
    });
    assert.equal(result.error, "evaluation_invalid");
    const details = result.details as { subgoal_errors: Array<{ reason: string; detail: string }> };
    assert.equal(details.subgoal_errors[0]?.reason, "unknown_id");
    // evaluation_invalid guarantee: nothing persisted, no rejection state,
    // the same roundId stays open for a corrected retry.
    assert.equal(store.listEntries().length, entriesBefore, "no vault/session writes");
    const session = mgr.get(String(start.sessionId));
    assert.equal(session?.currentRound, 1);
    assert.equal(session?.consecutiveRejections, 0, "no rejection counters touched");
    assert.equal(session?.roundSnapshot?.roundId, start.roundId, "round not consumed");
    // A corrected submission on the same roundId is accepted.
    const retry = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId: start.sessionId,
      roundId: start.roundId,
      evaluation: {
        success: false,
        output_summary: "fixed the payload",
        should_continue: true,
        constraint_violations: [],
        execution_report: {
          files_changed: ["src/a.ts"],
          tests_reported: { passed: 1, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims([], ["Complete the task"]),
          progress_estimate: 0.3,
        },
      },
    });
    assert.equal(retry.error, undefined, "same-roundId retry must be accepted");
  });

  it("rejects sg-XXXXXXXX literals in emerged_subtasks (creation channel)", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId: start.sessionId,
      roundId: start.roundId,
      evaluation: {
        success: false,
        output_summary: "created by ID literal",
        should_continue: true,
        constraint_violations: [],
        emerged_subtasks: ["sg-abcd1234"],
      },
    });
    assert.equal(result.error, "evaluation_invalid");
    const details = result.details as { subgoal_errors: Array<{ reason: string }> };
    assert.equal(details.subgoal_errors[0]?.reason, "id_in_creation");
  });

  it("accepts a sub-goal that is created and transitioned within the same round", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
    const started = mgr.get(String(start.sessionId));
    assert.ok(started, "session must exist after start");
    const sgId = deriveSubGoalId(started!.loopId, started!.currentRound, 0, "harden the withdraw path");
    const result = await TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId: start.sessionId,
      roundId: start.roundId,
      evaluation: {
        success: false,
        output_summary: "emerged and started hardening the withdraw path",
        should_continue: true,
        constraint_violations: [],
        emerged_subtasks: ["harden the withdraw path"],
        subgoal_updates: [{ id: sgId, status: "in_progress" }],
        execution_report: {
          files_changed: ["src/withdraw.ts"],
          tests_reported: { passed: 1, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims([], ["Complete the task"]),
          progress_estimate: 0.3,
        },
      },
    });
    assert.equal(result.error, undefined,
      "same-round emergence + in_progress transition must be legal");
  });

  it("v3.7.1: an unapproved cited gate rejects the round; approval unblocks it", async () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    try {
      const start = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20", maxRounds: 20 });
      const sessionId = String(start.sessionId);
      const roundId = String(start.roundId);

      // Structured preflight: high-risk action → user_required + record.
      const pre = await TOOL_HANDLERS.loopforge_gate_check(mgr, {
        sessionId,
        roundId,
        action: {
          description: "Deploy the release to production",
          scope: ["prod-api"],
          effects: ["production", "publish"],
          reversibility: "unknown",
          authorization: "user_required",
        },
      });
      assert.equal(pre.error, undefined);
      const preRec = pre as { decision: string; risk: string; reasonCodes: string[]; gateId: string };
      assert.equal(preRec.decision, "user_required");
      assert.equal(preRec.risk, "high");
      assert.ok(preRec.reasonCodes.includes("effects:production"));
      assert.ok(typeof preRec.gateId === "string" && preRec.gateId.length > 0);
      const gateId = preRec.gateId;
      assert.ok(typeof pre.gateId === "string" && pre.gateId.length > 0);
      assert.ok(store.entries.some((e) => e.task_type === "gate_opened" && e.gate_id === gateId),
        "user_required preflight persists a gate_opened record");

      // Citing the unapproved gate → user_gate_unresolved reject.
      const blocked = await TOOL_HANDLERS.loopforge_next(mgr, {
        sessionId,
        roundId,
        evaluation: {
          success: false,
          output_summary: "Deployed but no human approved it yet.",
          should_continue: true,
          constraint_violations: [],
          gate_ids: [gateId],
          execution_report: {
            files_changed: ["deploy.yml"],
            tests_reported: { passed: 1, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims([], ["Complete the task"]),
            progress_estimate: 0.5,
          },
        },
      });
      assert.equal(blocked.enforcementAction, "reject", "unapproved citation must reject");
      assert.ok(String(blocked.enforcementReason ?? "").includes("not_approved"),
        "reason must report the unapproved citation");
      assert.ok(String(blocked.enforcementReason ?? "").includes("approved human decision"),
        "reason must describe the gate layer");
      const sessionAfter = mgr.get(sessionId);
      assert.equal(sessionAfter?.currentRound, 1, "reject must not advance the round");

      // Human approval via gate_resolve, then the citation passes.
      const resolved = await TOOL_HANDLERS.loopforge_gate_resolve(mgr, {
        sessionId,
        gateId,
        approved: true,
        note: "human reviewed and approved",
      });
      assert.equal(resolved.error, undefined);
      const accepted = await TOOL_HANDLERS.loopforge_next(mgr, {
        sessionId,
        roundId,
        evaluation: {
          success: false,
          output_summary: "Deployed with an approved gate.",
          should_continue: true,
          constraint_violations: [],
          gate_ids: [gateId],
          execution_report: {
            files_changed: ["deploy.yml"],
            tests_reported: { passed: 1, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims([], ["Complete the task"]),
            progress_estimate: 0.5,
          },
        },
      });
      assert.ok(!accepted.enforcementAction || accepted.enforcementAction === "accept",
        `approved citation must pass, got ${accepted.enforcementAction ?? "accept"}`);
      assert.equal(accepted.round, 2, "round advances after approval");
    } finally {
      resetPolicy();
    }
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
      scope: ["src/auth"],
      items: [{ description: "login works", criterion_refs: ["cr-auth-login"], subgoal_refs: [], verify_with: ["run-tests"] }],
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
      execution_report: {
        files_changed: ["src/auth.ts"],
        tests_reported: { passed: 0, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], ["cr-login-works"]),
        progress_estimate: 0.2,
      },
      round_contract: {
        work_item: "Implement login flow",
        scope: ["src/auth"],
        items: [{ description: "login works", criterion_refs: ["cr-login-works"], subgoal_refs: [], verify_with: ["run-tests"] }],
      },
    };
    const r2 = await mgr.advance(sessionId, "Scaffolded the auth module.", evalBlock);
    assert.ok(r2.prompt !== null);
    assert.equal(r2.round, 2);
    assert.ok(r2.prompt.includes("**Implement login flow**"),
      "round 2 prompt must carry the contract as Current Task");
    assert.ok(r2.prompt.includes("login works"), "item descriptions render");
    assert.ok(r2.prompt.includes("- Verify via: run-tests"));
  });

  it("a contract-less round stays byte-identical to pre-contract rendering", async () => {
    const r1 = await mgr.create({ task: "Plain task", loopId: "contract-none" });
    const sessionId = r1.sessionId;
    const r2 = await mgr.advance(
      sessionId,
      agentOutput({ success: false }),
      evalParam({ success: false, shouldContinue: true }),
    );
    assert.ok(r2.prompt !== null);
    assert.ok(r2.prompt.includes("Plain task"), "original task stays the Current Task");
    assert.ok(!r2.prompt.includes("Round Contract"), "no contract template without a contract");
  });

  // ── v3.4: active-contract lifecycle through the real advance path ────────

  const CONTRACT = (workItem: string): SelfEvaluation["round_contract"] => ({
    work_item: workItem,
    scope: ["src/auth"],
    // "verify" is the command installTestCommandProvider configures.
    items: [{ description: "login works", criterion_refs: ["cr-login-works"], subgoal_refs: [], verify_with: ["verify"] }],
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
    execution_report: {
      files_changed: ["src/auth.ts"],
      tests_reported: { passed: 1, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims(met, remaining),
      progress_estimate: 0.4,
    },
    ...(contract ? { round_contract: contract } : {}),
  });

  it("v3.8: the projection carries verified_subgoals after the loop stops", async () => {
    // The projection used to read only the committed rounds BELOW
    // session.currentRound — a bound that is only correct while the loop is
    // running. A stop leaves currentRound on the round it just committed, so
    // the final round was dropped and the projection contradicted audit and
    // explain about the very verification it exists to report.
    installTestCommandProvider();
    const started = await mgr.create({ task: "Ship the widget", loopId: "projection-stop", maxRounds: 4 });
    const subGoalId = deriveSubGoalId("projection-stop", 1, 0, "wire the widget");
    const contract: SelfEvaluation["round_contract"] = {
      work_item: "Slice A",
      scope: ["src/auth"],
      items: [{
        description: "widget works",
        criterion_refs: [],
        subgoal_refs: [subGoalId],
        verify_with: ["verify"],
      }],
    };
    const itemId = deriveContractItemIds(contract.items)[0];

    await mgr.advance(started.sessionId, "", {
      success: false,
      output_summary: "Declared the contract.",
      constraint_violations: [],
      should_continue: true,
      emerged_subtasks: ["wire the widget"],
      round_contract: contract,
    });

    const stopped = await mgr.advance(started.sessionId, "", {
      success: true,
      output_summary: "Verified the slice.",
      constraint_violations: [],
      should_continue: false,
      execution_report: {
        files_changed: [],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        contract_item_claims: [{ item_id: itemId, outcome: "met" }],
        criterion_claims: [],
      },
    });
    assert.equal(stopped.stopReason, "completed");

    const projection = await mgr.getProjection(started.sessionId) as Record<string, unknown>;
    assert.deepEqual(
      projection.verified_subgoals,
      [{ subgoal_id: subGoalId, contract_item_ids: [itemId], verified_at_round: 2 }],
      "the final committed round is machine history — the projection must include it",
    );
    // The audit reads the same history and must agree.
    const audit = await mgr.getAudit("projection-stop") as {
      contracts: { verifiedItems: number };
    } | null;
    assert.equal(audit?.contracts.verifiedItems, 1);
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
      execution_report: {
        files_changed: ["src/auth.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], ["cr-login-works"]),
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

  it("v3.8: a verified contract closes and the Current Task reverts", async () => {
    const started = await mgr.create({
      task: "Build the auth module",
      loopId: "contract-satisfied-revert",
      maxRounds: 4,
    });
    const contract = CONTRACT("Implement login flow");
    const itemId = deriveContractItemIds(contract!.items)[0];
    const r2 = await mgr.advance(started.sessionId, "", honest([], ["cr-login-works"], contract));
    assert.ok(String(r2.prompt ?? "").includes("**Implement login flow**"));

    // v3.8: the item closes only when its bound command was observed passing
    // (the "verify" provider is installed for this suite and passes), so the
    // contract closes and the Current Task reverts to the original task.
    const r3 = await mgr.advance(started.sessionId, "", {
      success: false,
      output_summary: "Ran the bound verification command.",
      constraint_violations: [],
      should_continue: true,
      execution_report: {
        files_changed: ["src/auth.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        progress_estimate: 0.6,
        contract_item_claims: [{ item_id: itemId, outcome: "met" }],
      },
    });
    assert.equal(r3.round, 3);
    assert.ok(String(r3.prompt ?? "").includes("Build the auth module"),
      "a closed contract reverts the Current Task to the original task");
    assert.ok(!String(r3.prompt ?? "").includes("**Implement login flow**"),
      "the closed contract must stop rendering");
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
    // v3.5: the premature replacement is no longer silent — round 3's prompt
    // flag lines carry the warn (the round still advanced; warn never
    // rejects).
    assert.ok(String(r3.prompt ?? "").includes("contract_premature"),
      "the ignored replacement must be surfaced as a warn");
  });

  it("v3.5: status exposes the active contract and replay rows carry the proposals", async () => {
    const started = await mgr.create({
      task: "Build the auth module",
      loopId: "contract-display",
      maxRounds: 4,
    });
    const a = CONTRACT("Implement login flow");
    const r2 = await mgr.advance(started.sessionId, "", honest([], ["cr-login-works"], a));
    assert.ok(String(r2.prompt ?? "").includes("**Implement login flow**"));

    // Session view: the ACTIVE contract governing the next round.
    const status = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId: started.sessionId });
    assert.equal(
      (status.activeContract as { work_item?: string } | null)?.work_item,
      "Implement login flow",
      "the session view must expose the derived ACTIVE contract",
    );

    // Replay rows: the declaring round carries its proposal; the round
    // without a contract carries none.
    const replay = await TOOL_HANDLERS.loopforge_replay(mgr, { sessionId: started.sessionId });
    const timeline = (replay.timeline as Array<Record<string, unknown>>) ?? [];
    const row1 = timeline.find((t) => t.round === 1);
    assert.equal(
      (row1?.proposal as { work_item?: string } | null)?.work_item,
      "Implement login flow",
      "round 1's committed proposal must appear on its replay row",
    );
    const row2 = timeline.find((t) => t.round === 2);
    assert.equal(row2?.proposal, undefined, "contract-less rounds carry no proposal key");
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
          execution_report: {
            files_changed: [`src/r${i}.ts`],
            tests_reported: { passed: 1, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims([], ["Complete the task"]),
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
    assert.equal(audit.error, "state_unavailable",
      "a loop without committed decisions must not be solemnly passed: " + JSON.stringify(audit));
    assert.ok(String(audit.errorMessage ?? "").includes("no audit data"));
    const missing = await TOOL_HANDLERS.loopforge_status(mgr, {
      view: "audit",
      loopId: "no-such-loop",
    });
    assert.equal(missing.error, "state_unavailable",
      "a nonexistent loop must not audit as passed");
    assert.ok(String(missing.errorMessage ?? "").includes("no audit data"));
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
    assert.equal(missing.error, "state_unavailable");
    assert.ok(String(missing.errorMessage ?? "").includes("no committed rounds"));
  });
});
