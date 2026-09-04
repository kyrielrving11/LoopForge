import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReplayBackend } from "../replay.js";
import type { VaultEntry } from "../loop-store.js";
import { committedFeedbackRound, MemoryLoopStore } from "./_helpers.js";

function lineage(round: number, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    task_id: `loop:test:r${round}`,
    loop_id: "test",
    loop_lineage: {
      loop_id: "test",
      round,
      goal_id: "audit",
      recompile_level: round === 1 ? "l2" : "l1",
      task: `Round ${round}`,
    },
    ...overrides,
  };
}

function appendRound(
  store: MemoryLoopStore,
  round: number,
  overrides: Partial<VaultEntry> = {},
): void {
  store.appendEntry(lineage(round, overrides));
  store.appendEntry(committedFeedbackRound(round, { loopId: "test" }));
}

describe("ReplayBackend", () => {
  let store: MemoryLoopStore;
  let replay: ReplayBackend;

  beforeEach(() => {
    store = new MemoryLoopStore();
    replay = new ReplayBackend(store);
  });

  it("returns only committed rounds", () => {
    store.appendEntry(lineage(1));
    assert.equal(replay.getRound("test", 1), null);
    store.appendEntry(committedFeedbackRound(1, { loopId: "test" }));
    assert.equal(replay.getRound("test", 1)?.task_id, "loop:test:r1");
  });

  it("does not confuse round 1 with round 10", () => {
    appendRound(store, 10);
    appendRound(store, 1);
    assert.equal(replay.getRound("test", 1)?.loop_lineage?.round, 1);
    assert.equal(replay.getRound("test", 10)?.loop_lineage?.round, 10);
  });

  it("preserves the prompt projection and merges committed facts", () => {
    appendRound(store, 1, { full_prompt: "## Compiled Prompt" });
    const feedback = store.listEntries("test").find((entry) =>
      String(entry.task_id).endsWith(":feedback"));
    const transaction = feedback?.loop_lineage?.round_transaction as Record<string, unknown>;
    (transaction.result as Record<string, unknown>).roundSuccess = true;
    assert.equal(replay.getRound("test", 1)?.full_prompt, "## Compiled Prompt");
    assert.equal(replay.getRound("test", 1)?.success, true);
  });

  it("replays committed rounds in a selected range", () => {
    for (let round = 1; round <= 5; round++) appendRound(store, round);
    assert.equal(replay.replay("test").length, 5);
    assert.deepEqual(
      replay.replay("test", { start: 2, end: 4 })
        .map((entry) => entry.loop_lineage?.round),
      [2, 3, 4],
    );
  });

  it("excludes rolled-back rounds", () => {
    store.appendEntry(lineage(1));
    store.appendEntry(committedFeedbackRound(1, { loopId: "test", action: "backtrack" }));
    assert.deepEqual(replay.replay("test"), []);
  });

  it("returns a sorted factual timeline", () => {
    appendRound(store, 3);
    appendRound(store, 1);
    const timeline = replay.timeline("test");
    assert.deepEqual(timeline.map((row) => row.round), [1, 3]);
    assert.equal(timeline[0]?.recompile_level, "l2");
    assert.equal(timeline[1]?.recompile_level, "l1");
  });

  it("returns empty views for an unknown loop", () => {
    assert.equal(replay.getRound("missing", 1), null);
    assert.deepEqual(replay.replay("missing"), []);
    assert.deepEqual(replay.timeline("missing"), []);
  });
});
