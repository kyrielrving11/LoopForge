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
  const evalBlock = {
    success: opts.success ?? true,
    output_summary: opts.body ?? "Completed the task successfully.",
    constraint_violations: opts.violations ?? [],
    should_continue: opts.shouldContinue ?? true,
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

import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import { resetPolicy } from "../policy.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP — loopforge_start", () => {
  let backend: MemoryBackend;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    backend = new MemoryBackend();
    mgr = new SessionManager(backend);
  });

  it("returns sessionId + Round 1 prompt (L2 compile)", () => {
    const result = TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit ERC20 token" });

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

describe("MCP — multi-round lifecycle", () => {
  let backend: MemoryBackend;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    backend = new MemoryBackend();
    mgr = new SessionManager(backend);
  });

  it("start → next × 3 → task_complete", () => {
    // Round 1
    const start = TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Audit ERC20",
      maxRounds: 20,
    });
    const sessionId = String(start.sessionId);

    // Round 1 → 2 (ascending quality [2, ...] avoids breaker)
    const r1 = TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: false, violations: ["missed check"], shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined, "round 2 should not stop");
    assert.equal(r1.round, 2);
    assert.ok(typeof r1.prompt === "string");

    // Round 2 → 3 (quality 5)
    const r2 = TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });
    assert.equal(r2.stopReason, undefined, "round 3 should not stop");
    assert.equal(r2.round, 3);

    // Round 3 → stop (should_continue: false)
    const r3 = TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: false }),
    });
    assert.equal(r3.prompt, null);
    assert.equal(r3.stopReason, "task_complete");
    assert.equal(r3.round, 3);
  });

  it("next without eval block → stalled", () => {
    const start = TOOL_HANDLERS.loopforge_start(mgr, { task: "Test stalled" });
    const sessionId = String(start.sessionId);

    const result = TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutputNoEval(),
    });

    assert.equal(result.prompt, null);
    assert.equal(result.stopReason, "stalled");
  });

  it("next with consecutive flat quality → circuit_breaker", () => {
    const start = TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Breaker test",
      maxRounds: 20,
    });
    const sessionId = String(start.sessionId);

    // 3 rounds of identical high quality = [5, 5, 5] → breaker fires
    TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });
    TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });
    const r3 = TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });

    assert.equal(r3.prompt, null);
    assert.equal(r3.stopReason, "circuit_breaker");
  });

  it("next at maxRounds stops", () => {
    const start = TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Short loop",
      maxRounds: 2,
    });
    const sessionId = String(start.sessionId);

    // Round 1 → 2 (use ascending quality to avoid breaker)
    const r1 = TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: false, violations: ["x"], shouldContinue: true }),
    });
    assert.equal(r1.stopReason, undefined);

    // Round 2 → stop (maxRounds reached)
    const r2 = TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });
    assert.equal(r2.prompt, null);
    assert.equal(r2.stopReason, "max_rounds");
    assert.equal(r2.round, 2);
  });
});

describe("MCP — status / list / stop / replay", () => {
  let backend: MemoryBackend;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    backend = new MemoryBackend();
    mgr = new SessionManager(backend);
  });

  it("status returns correct round, quality, status", () => {
    const start = TOOL_HANDLERS.loopforge_start(mgr, { task: "Status test" });
    const sessionId = String(start.sessionId);

    // Advance once to populate quality
    TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });

    const status = TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    assert.equal(status.sessionId, sessionId);
    assert.equal(status.round, 2);
    assert.equal(status.status, "running");
    assert.ok((status.qualityTrajectory as number[]).length >= 1);
  });

  it("list returns multiple sessions", () => {
    TOOL_HANDLERS.loopforge_start(mgr, { task: "Task A" });
    TOOL_HANDLERS.loopforge_start(mgr, { task: "Task B" });

    const result = TOOL_HANDLERS.loopforge_list(mgr, {});
    const sessions = result.sessions as Array<Record<string, unknown>>;
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((s) => typeof s.sessionId === "string"));
  });

  it("stop manually returns final trajectory", () => {
    const start = TOOL_HANDLERS.loopforge_start(mgr, { task: "Stop test" });
    const sessionId = String(start.sessionId);

    // Advance once
    TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });

    const result = TOOL_HANDLERS.loopforge_stop(mgr, { sessionId });
    assert.equal(result.success, true);
    assert.equal(result.roundsCompleted, 2);
    assert.ok((result.qualityTrajectory as number[]).length >= 1);

    // Session should be gone
    const status = TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    assert.ok("error" in status);
  });

  it("replay returns timeline", () => {
    const start = TOOL_HANDLERS.loopforge_start(mgr, { task: "Replay test" });
    const sessionId = String(start.sessionId);

    // Advance once to create lineage data
    TOOL_HANDLERS.loopforge_next(mgr, {
      sessionId,
      output: agentOutput({ success: true, shouldContinue: true }),
    });

    const result = TOOL_HANDLERS.loopforge_replay(mgr, { sessionId });
    const timeline = result.timeline as Array<Record<string, unknown>>;
    assert.ok(timeline.length >= 1, "timeline should have entries");
    assert.equal(typeof timeline[0].round, "number");
    assert.equal(typeof timeline[0].technique_used, "string");
  });
});
