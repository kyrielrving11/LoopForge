/** v4.0.1 — a start that cannot compile is not a running session. */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import { SessionManager } from "../mcp/session.js";
import { ProjectionCoverageError } from "../prompt-coverage.js";
import {
  AgentStatus,
  makeLoopCompileResponse,
} from "../protocol.js";
import { resetPolicy } from "../policy.js";
import { MemoryLoopStore } from "./_helpers.js";

const LOOP_ID = "start-failure";

class CountingStore extends MemoryLoopStore {
  sessionWrites = 0;
  override writeSession(...args: Parameters<MemoryLoopStore["writeSession"]>): void {
    this.sessionWrites++;
    super.writeSession(...args);
  }
}

describe("v4.0.1 — start failure is a stable refusal", () => {
  const original = LoopForgeEngine.prototype.invokeLoopCompile;

  afterEach(() => {
    LoopForgeEngine.prototype.invokeLoopCompile = original;
    resetPolicy();
  });

  it("maps a compiler refusal to start_failed with no session or handle", async () => {
    LoopForgeEngine.prototype.invokeLoopCompile = () =>
      makeLoopCompileResponse({
        status: AgentStatus.ERROR,
        prompt: "",
        error: "forced compiler refusal",
      });
    const store = new CountingStore();
    const manager = new SessionManager(store);
    const result = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Never starts",
      loopId: LOOP_ID,
    });

    assert.equal(result.error, "start_failed");
    assert.equal(result.sessionId, undefined);
    assert.equal(result.submissionHandle, undefined);
    assert.equal(store.readSession(LOOP_ID), null, "no session document");
    assert.equal(store.sessionWrites, 0, "no session save");
    assert.equal(store.rounds.size, 0, "no round history");
  });

  it("keeps a projection defect on projection_incomplete", async () => {
    LoopForgeEngine.prototype.invokeLoopCompile = () => {
      throw new ProjectionCoverageError({
        active: [],
        rendered: [],
        omitted: [{ id: "c-12345678", reason: "defect" }],
        complete: false,
      });
    };
    const store = new CountingStore();
    const manager = new SessionManager(store);
    const result = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Projection fails",
      loopId: LOOP_ID,
    });

    assert.equal(result.error, "projection_incomplete");
    assert.equal(store.readSession(LOOP_ID), null);
    assert.equal(store.sessionWrites, 0);
    assert.equal(store.rounds.size, 0);
  });
});
