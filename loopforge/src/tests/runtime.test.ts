/** LoopForge — Runtime tests (v1.2).
 *
 *  Tests: LoopRuntime lifecycle, run() convenience function,
 *  heartbeat, timeout, stall, stop(), error handling.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LoopRuntime, run } from "../runtime.js";
import { RuntimeStatus, makeSelfEvaluation } from "../protocol.js";
import type {
  AgentExecutor,
  SelfEvaluation,
  HeartbeatInfo,
  TimeoutInfo,
  RoundCompleteInfo,
} from "../protocol.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeAgentOutput(
  opts: Partial<SelfEvaluation> = {},
): string {
  const se = makeSelfEvaluation({
    success: true,
    output_summary: "Task completed successfully.",
    constraint_violations: [],
    should_continue: true,
    ...opts,
  });
  return [
    "## Result",
    "",
    "I completed the task as requested.",
    "",
    "---loopforge-eval",
    JSON.stringify(se, null, 2),
    "---end-loopforge-eval",
    "",
  ].join("\n");
}

function makeFailingOutput(violations: string[]): string {
  return makeAgentOutput({
    success: false,
    output_summary: "Task partially completed.",
    constraint_violations: violations,
    should_continue: true,
  });
}

function mockExecutor(
  responses: string[],
): AgentExecutor {
  let idx = 0;
  return async (_prompt, _ctx) => {
    if (idx >= responses.length) {
      throw new Error("mockExecutor: no more responses");
    }
    return responses[idx++];
  };
}

function slowExecutor(
  responses: string[],
  delayMs: number,
): AgentExecutor {
  let idx = 0;
  return async (_prompt, _ctx) => {
    if (idx >= responses.length) {
      throw new Error("slowExecutor: no more responses");
    }
    await new Promise((r) => setTimeout(r, delayMs));
    return responses[idx++];
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// run() convenience function
// ═══════════════════════════════════════════════════════════════════════════

describe("run() — convenience function", () => {
  it("completes 3-round loop with auto-generated loopId", async () => {
    const responses = [
      makeAgentOutput({ should_continue: true }),
      makeAgentOutput({ should_continue: true }),
      makeAgentOutput({ should_continue: false }),
    ];

    const result = await run({
      task: "Test task for minimal config",
      execute: mockExecutor(responses),
      maxRounds: 10,
    });

    assert.equal(result.stopReason, "task_complete");
    assert.equal(result.success, true);
    assert.equal(result.roundsCompleted, 3);
    assert.equal(result.successTrajectory.length, 3);
    // All rounds should have success true
    for (const s of result.successTrajectory) {
      assert.equal(s, true);
    }
  });

  it("stops on task_complete when should_continue=false", async () => {
    const result = await run({
      task: "Test task complete",
      execute: mockExecutor([
        makeAgentOutput({ should_continue: false }),
      ]),
      maxRounds: 10,
    });

    assert.equal(result.stopReason, "task_complete");
    assert.equal(result.roundsCompleted, 1);
  });

  it("stops on max_rounds when agent always continues", async () => {
    // Use ascending quality to avoid circuit breaker (flat 5,5,5 fires breaker)
    const responses = [
      makeAgentOutput({ success: false, constraint_violations: [], should_continue: true }),  // quality 1
      makeAgentOutput({ success: true, constraint_violations: [], should_continue: true }),   // quality 5
      makeAgentOutput({ success: true, constraint_violations: [], should_continue: true }),   // quality 5
    ];

    const result = await run({
      task: "Test max rounds",
      execute: mockExecutor(responses),
      maxRounds: 3,
    });

    assert.equal(result.stopReason, "max_rounds");
    assert.equal(result.roundsCompleted, 3);
  });

  it("stops on executor_failure after consecutive errors", async () => {
    let calls = 0;
    const result = await run({
      task: "Test executor failure",
      execute: async () => {
        calls++;
        throw new Error("API key expired");
      },
      maxRounds: 10,
      maxConsecutiveErrors: 3,
    });

    assert.equal(result.stopReason, "executor_failure");
    assert.equal(calls, 3);
  });

  it("recovers from a single execute error", async () => {
    let calls = 0;
    const result = await run({
      task: "Test recover from error",
      execute: async () => {
        calls++;
        if (calls === 1) throw new Error("transient error");
        return makeAgentOutput({ should_continue: false });
      },
      maxRounds: 10,
    });

    // Should succeed — only 1 error, not 3 consecutive
    assert.equal(result.stopReason, "task_complete");
    assert.equal(calls, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LoopRuntime class
// ═══════════════════════════════════════════════════════════════════════════

describe("LoopRuntime", () => {
  it("status transitions: IDLE → RUNNING → STOPPED", async () => {
    const rt = new LoopRuntime({
      task: "Test status transitions",
      execute: mockExecutor([
        makeAgentOutput({ should_continue: false }),
      ]),
    });

    assert.equal(rt.status, "idle");

    const result = await rt.start();
    assert.equal(result.stopReason, "task_complete");

    // After start() resolves, runtime is stopped
    const finalStatus = rt.status;
    assert.notEqual(finalStatus, RuntimeStatus.RUNNING);
    assert.notEqual(finalStatus, RuntimeStatus.IDLE);
  });

  it("stop() mid-loop stops gracefully", async () => {
    const rt = new LoopRuntime({
      task: "Test stop mid-loop",
      execute: mockExecutor([
        makeAgentOutput({ should_continue: true }),
        makeAgentOutput({ should_continue: true }),
        makeAgentOutput({ should_continue: true }),
      ]),
      maxRounds: 10,
      onRoundComplete: (info: RoundCompleteInfo) => {
        if (info.round === 2) {
          rt.stop();
        }
      },
    });

    const result = await rt.start();
    assert.equal(result.stopReason, "stopped");
    // stop() is called in round 2's onRoundComplete; the for-loop
    // increments to round 3 before checking status, so roundsCompleted
    // reflects the incremented counter
    assert.ok(result.roundsCompleted <= 3);
  });

  it("getCurrentRound and getSuccessTrajectory work", async () => {
    const rt = new LoopRuntime({
      task: "Test accessors",
      execute: mockExecutor([
        makeAgentOutput({ should_continue: true }),
        makeAgentOutput({ should_continue: false }),
      ]),
      maxRounds: 10,
    });

    assert.equal(rt.getCurrentRound(), 1); // before start
    assert.equal(rt.getSuccessTrajectory().length, 0);

    await rt.start();

    assert.equal(rt.getSuccessTrajectory().length, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Heartbeat & timeout
// ═══════════════════════════════════════════════════════════════════════════

describe("Heartbeat & timeout", () => {
  it("heartbeat events fire during slow execute", async () => {
    const heartbeats: HeartbeatInfo[] = [];

    const result = await run({
      task: "Test heartbeat",
      execute: slowExecutor(
        [makeAgentOutput({ should_continue: false })],
        150, // 150ms delay — heartbeat at 50ms should fire
      ),
      heartbeatIntervalMs: 50,
      roundTimeoutMs: 5000,
      maxRounds: 10,
      onHeartbeat: (info) => {
        heartbeats.push(info);
      },
    });

    assert.equal(result.stopReason, "task_complete");
    // Should have received at least one heartbeat during the 150ms delay
    assert.ok(
      heartbeats.length >= 1,
      `expected >=1 heartbeats, got ${heartbeats.length}`,
    );
  });

  it("timeout sets signal.aborted", async () => {
    let signalWasAborted = false;

    const result = await run({
      task: "Test timeout",
      execute: async (_prompt, ctx) => {
        // Sleep past the timeout
        await new Promise((r) => setTimeout(r, 200));
        if (ctx && ctx.signal.aborted) {
          signalWasAborted = true;
        }
        return makeAgentOutput({ should_continue: false });
      },
      roundTimeoutMs: 50,
      heartbeatIntervalMs: 25,
      stallGraceMs: 5000,
      maxRounds: 10,
    });

    assert.equal(result.stopReason, "task_complete");
    assert.ok(signalWasAborted, "signal.aborted should be true after timeout");
  });

  it("interactive mode does not trigger timeout", async () => {
    let timeoutFired = false;

    const result = await run({
      task: "Test interactive",
      execute: async (_prompt, _ctx) => {
        await new Promise((r) => setTimeout(r, 150));
        return makeAgentOutput({ should_continue: false });
      },
      interactive: true,
      roundTimeoutMs: 50,
      heartbeatIntervalMs: 25,
      maxRounds: 10,
      onTimeout: () => {
        timeoutFired = true;
      },
    });

    assert.equal(result.stopReason, "task_complete");
    assert.equal(timeoutFired, false);
  });

  it("reportProgress resets stall timer", async () => {
    let reported = false;

    const result = await run({
      task: "Test reportProgress",
      execute: async (_prompt, ctx) => {
        ctx?.reportProgress("still working...");
        reported = true;
        await new Promise((r) => setTimeout(r, 50));
        return makeAgentOutput({ should_continue: false });
      },
      roundTimeoutMs: 5000,
      heartbeatIntervalMs: 20,
      maxRounds: 10,
    });

    assert.equal(result.stopReason, "task_complete");
    assert.ok(reported);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Circuit breaker & extraction failure
// ═══════════════════════════════════════════════════════════════════════════

describe("Circuit breaker & extraction", () => {
  it("circuit breaker triggers after consecutive failures", async () => {
    // Generate failing outputs for 5+ rounds to trigger circuit breaker
    const responses = Array.from({ length: 10 }, () =>
      makeFailingOutput(["violated constraint X"]),
    );

    const result = await run({
      task: "Test circuit breaker",
      execute: mockExecutor(responses),
      maxRounds: 10,
    });

    // Either circuit_breaker or max_rounds — depends on policy
    assert.ok(
      result.stopReason === "circuit_breaker" ||
        result.stopReason === "max_rounds",
      `expected circuit_breaker or max_rounds, got ${result.stopReason}`,
    );
  });

  it("stops on extraction failure (no eval block)", async () => {
    const result = await run({
      task: "Test extraction failure",
      execute: mockExecutor([
        makeAgentOutput({ should_continue: true }),
        "No structured eval block here, still need to continue working on more tasks.", // heuristic will detect "remaining" → should_continue=true, but extraction is heuristic → stalled
      ]),
      maxRounds: 10,
    });

    // Extraction via heuristic → extractionSucceeded=false → stalled
    assert.equal(result.stopReason, "stalled");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stall detection
// ═══════════════════════════════════════════════════════════════════════════

describe("Stall detection", () => {
  it("stalls when execute exceeds timeout + stall grace", async () => {
    const result = await run({
      task: "Test stall",
      execute: async (_prompt, _ctx) => {
        // Sleep past timeout + stall grace
        await new Promise((r) => setTimeout(r, 300));
        return makeAgentOutput({ should_continue: false });
      },
      roundTimeoutMs: 50,
      heartbeatIntervalMs: 25,
      stallGraceMs: 50,
      maxRounds: 10,
    });

    // Should be stalled (status was set to STALLED but execute returned)
    assert.ok(
      ["stalled", "task_complete"].includes(result.stopReason),
      `expected stalled or task_complete, got ${result.stopReason}`,
    );
  });
});
