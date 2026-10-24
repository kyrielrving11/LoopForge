/** v4.0.1 — a loopId names durable history; a second start is refused. */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopExistsError } from "../errors.js";
import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import { resetPolicy } from "../policy.js";
import { VaultSessionStateStore } from "../storage.js";
import { committedFeedbackRound, MemoryLoopStore } from "./_helpers.js";

function sessionEntry(loopId: string) {
  return {
    task_id: `loop:${loopId}:session`,
    task_type: "session_state",
    loop_id: loopId,
    loop_lineage: { status: "stopped", current_round: 1 },
  };
}

describe("v4.0.1 — loopId reuse protection", () => {
  afterEach(() => {
    resetPolicy();
  });

  it("the store-level expectAbsent gate rejects a second save", () => {
    const store = new MemoryLoopStore();
    const sessions = new VaultSessionStateStore(store);
    sessions.save(sessionEntry("reuse-atomic"));
    assert.throws(
      () => sessions.save(sessionEntry("reuse-atomic"), { expectAbsent: true }),
      (error: unknown) => error instanceof LoopExistsError,
    );
  });

  it("start refuses a loop with committed rounds but no session", async () => {
    const store = new MemoryLoopStore();
    store.appendEntry(committedFeedbackRound(1, { loopId: "reuse-rounds" }));
    const manager = new SessionManager(store);
    const result = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Do not overwrite history",
      loopId: "reuse-rounds",
    });
    assert.equal(result.error, "loop_exists");
    assert.equal((result.details as Record<string, unknown>).reason, "rounds");
    assert.equal(store.rounds.size, 1, "the existing round is untouched");
  });

  it("start refuses a duplicate in the same process", async () => {
    const store = new MemoryLoopStore();
    const manager = new SessionManager(store);
    const first = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "First",
      loopId: "reuse-active",
    });
    assert.equal(first.error, undefined);
    const second = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Second",
      loopId: "reuse-active",
    });
    assert.equal(second.error, "loop_exists");
    assert.equal((second.details as Record<string, unknown>).reason, "active");
  });
});
