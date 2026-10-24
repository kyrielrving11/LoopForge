/** v4.0.1 — resume/unpause compilation failure is a retryable stall. */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import { SessionManager } from "../mcp/session.js";
import {
  AgentStatus,
  makeLoopCompileResponse,
} from "../protocol.js";
import { resetPolicy } from "../policy.js";
import { MemoryLoopStore } from "./_helpers.js";

const LOOP_ID = "lifecycle-recovery";

function sessionDocument(status: "running" | "paused", round = 2) {
  return {
    task_id: `loop:${LOOP_ID}:session`,
    task_type: "session_state",
    loop_id: LOOP_ID,
    task: "Resume without a held prompt",
    loop_lineage: {
      session_id: "session-recovery",
      current_round: round,
      max_rounds: 5,
      status,
      created_at: Date.now(),
      consecutive_rejections: 0,
      last_rejection_check: "",
      operator_acceptance: {
        task: "Resume without a held prompt",
        success_criteria: ["Ship it"],
        hard_constraints: [],
      },
      round_snapshot: null,
      lease_owner: "",
      lease_expires_at: 0,
    },
  };
}

function failingCompiler(): void {
  LoopForgeEngine.prototype.invokeLoopCompile = () =>
    makeLoopCompileResponse({
      status: AgentStatus.ERROR,
      prompt: "",
      error: "forced resume compile failure",
    });
}

describe("v4.0.1 — lifecycle compile recovery", () => {
  const original = LoopForgeEngine.prototype.invokeLoopCompile;

  afterEach(() => {
    LoopForgeEngine.prototype.invokeLoopCompile = original;
    resetPolicy();
  });

  it("resume stalls without notifying terminal, then retries the same round", async () => {
    const store = new MemoryLoopStore();
    store.appendEntry(sessionDocument("running"));
    const manager = new SessionManager(store);
    let terminal = 0;
    manager.addTerminalSink(() => { terminal++; });

    failingCompiler();
    const failed = await manager.resume(LOOP_ID);
    assert.equal(failed?.stopReason, "stalled");
    assert.equal(failed?.prompt, null);
    assert.equal(manager.get("session-recovery")?.status, "stalled");
    assert.equal(terminal, 0, "a compile failure is not a terminal event");
    assert.equal(store.rounds.size, 0, "no round was written");
    assert.equal(
      (store.readSession(LOOP_ID)?.entry.loop_lineage as Record<string, unknown>)
        .status,
      "stalled",
      "the stall is durable",
    );

    LoopForgeEngine.prototype.invokeLoopCompile = original;
    const retried = await manager.resume(LOOP_ID);
    assert.equal(retried?.round, 2);
    assert.ok(retried?.prompt, "the same round compiles on retry");
    assert.equal(store.rounds.size, 0);
  });

  it("unpause stalls and can be resumed afterwards", async () => {
    const store = new MemoryLoopStore();
    store.appendEntry(sessionDocument("paused"));
    const manager = new SessionManager(store);

    failingCompiler();
    const failed = await manager.unpause(LOOP_ID);
    assert.equal(failed?.stopReason, "stalled");
    assert.equal(manager.get("session-recovery")?.status, "stalled");
    assert.equal(
      (store.readSession(LOOP_ID)?.entry.loop_lineage as Record<string, unknown>)
        .status,
      "stalled",
    );

    LoopForgeEngine.prototype.invokeLoopCompile = original;
    const resumed = await manager.resume(LOOP_ID);
    assert.equal(resumed?.round, 2);
    assert.ok(resumed?.prompt);
  });
});
