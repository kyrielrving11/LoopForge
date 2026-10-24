/** v4.0.1 — legacy rounds are reported, never recompiled over. */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LegacyHistoryError } from "../errors.js";
import { resetPolicyMetrics } from "../policy-metrics.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import { SessionManager } from "../mcp/session.js";
import { committedFeedbackRound, MemoryLoopStore } from "./_helpers.js";

const LOOP_ID = "legacy-loop";

function storeWithLegacyRound(): MemoryLoopStore {
  const store = new MemoryLoopStore();
  const feedback = committedFeedbackRound(1, { loopId: LOOP_ID, success: true });
  const transaction = (feedback.loop_lineage as Record<string, unknown>)
    .round_transaction as Record<string, unknown>;
  (transaction.snapshot as Record<string, unknown>).schemaVersion = 5;
  store.appendEntry(feedback);
  store.appendEntry({
    task_id: `loop:${LOOP_ID}:session`,
    task_type: "session_state",
    loop_id: LOOP_ID,
    task: "Legacy task",
    loop_lineage: {
      loop_id: LOOP_ID,
      status: "running",
      current_round: 2,
      max_rounds: 10,
    },
  });
  return store;
}

describe("legacy history guard", () => {
  beforeEach(() => {
    resetPolicyMetrics();
  });

  it("resume refuses to recompile over an undecodable round", async () => {
    const store = storeWithLegacyRound();
    const manager = new SessionManager(store);
    await assert.rejects(
      () => manager.resume(LOOP_ID),
      (error: unknown) => error instanceof LegacyHistoryError &&
        error.rounds.includes(1),
    );
  });

  it("the resume tool maps the guard to legacy_history", async () => {
    const store = storeWithLegacyRound();
    const manager = new SessionManager(store);
    const result = await TOOL_HANDLERS.loopforge_resume(manager, { loopId: LOOP_ID });
    assert.equal(result.error, "legacy_history");
    assert.deepEqual(
      (result.details as Record<string, unknown>).rounds,
      [1],
    );
  });

  it("autoResumeAll skips a legacy loop instead of aborting startup", () => {
    const store = storeWithLegacyRound();
    const manager = new SessionManager(store);
    assert.equal(manager.autoResumeAll(), 0);
  });

  it("health exposes the legacy round count", () => {
    const store = storeWithLegacyRound();
    const manager = new SessionManager(store);
    assert.equal(manager.getHealth(LOOP_ID)?.legacy_rounds, 1);
  });

  it("audit reports a legacy-only loop instead of pretending it is empty", () => {
    const store = storeWithLegacyRound();
    const manager = new SessionManager(store);
    const audit = manager.getAudit(LOOP_ID);
    assert.ok(audit);
    assert.deepEqual(audit?.rounds, []);
    assert.deepEqual(audit?.legacyRounds, [1]);
  });
});
