/** Tests for ReplayBackend — time-travel queries. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ReplayBackend } from "../replay.js";
import { MemoryLoopStore } from "./_helpers.js";
import type { VaultEntry } from "../loop-store.js";

function makeEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    task_id: "loop:test:r1",
    loop_lineage: {
      loop_id: "test",
      round: 1,
      goal_id: "audit",
      recompile_level: "l2",
      task: "Audit contract",
      constraints_active: ["check ownership"],
    },
    success: true,
    ...overrides,
  };
}

describe("ReplayBackend — getRound", () => {
  let store: MemoryLoopStore;
  let replay: ReplayBackend;

  beforeEach(() => {
    store = new MemoryLoopStore();
    replay = new ReplayBackend(store);
  });

  it("returns entry for existing round", () => {
    store.appendEntry(makeEntry());
    const result = replay.getRound("test", 1);
    assert.notEqual(result, null);
    assert.equal(result!.task_id, "loop:test:r1");
  });

  it("returns null for missing round", () => {
    const result = replay.getRound("test", 99);
    assert.equal(result, null);
  });

  it("does not confuse round 1 with round 10 when both exist", () => {
    // Append round 10 BEFORE round 1 so the flat entry list is in
    // adversarial order — "loop:test:r1" must not prefix-match
    // "loop:test:r10" (digit guard in queryLoopEntries).
    store.appendEntry(makeEntry({
      task_id: "loop:test:r10",
      loop_lineage: { loop_id: "test", round: 10, goal_id: "g10" },
    }));
    store.appendEntry(makeEntry({
      task_id: "loop:test:r1",
      loop_lineage: { loop_id: "test", round: 1, goal_id: "g1" },
    }));
    const round1 = replay.getRound("test", 1);
    assert.equal(round1?.loop_lineage?.round, 1);
    assert.equal(round1?.task_id, "loop:test:r1");
    const round10 = replay.getRound("test", 10);
    assert.equal(round10?.loop_lineage?.round, 10);
    assert.equal(round10?.task_id, "loop:test:r10");
  });

  it("returns the prompt stored in the typed round projection", () => {
    store.appendEntry(makeEntry({ full_prompt: "## Compiled Prompt" }));
    assert.equal(replay.getRound("test", 1)?.full_prompt, "## Compiled Prompt");
  });

  it("merges feedback success flag", () => {
    store.appendEntry(makeEntry({ success: false }));
    store.appendEntry({
      task_id: "loop:test:r1:feedback",
      success: true,
    });
    const result = replay.getRound("test", 1);
    assert.equal(result!.success, true);
  });
});

describe("ReplayBackend — replay", () => {
  it("returns all rounds in range", () => {
    const store = new MemoryLoopStore();
    store.appendEntry(makeEntry({ task_id: "loop:test:r1", loop_lineage: { loop_id: "test", round: 1 } }));
    store.appendEntry(makeEntry({ task_id: "loop:test:r2", loop_lineage: { loop_id: "test", round: 2 } }));
    store.appendEntry(makeEntry({ task_id: "loop:test:r3", loop_lineage: { loop_id: "test", round: 3 } }));
    const replay = new ReplayBackend(store);

    const results = replay.replay("test");
    assert.equal(results.length, 3);
  });

  it("respects start/end range", () => {
    const store = new MemoryLoopStore();
    for (let i = 1; i <= 5; i++) {
      store.appendEntry(makeEntry({
        task_id: `loop:test:r${i}`,
        loop_lineage: { loop_id: "test", round: i },
      }));
    }
    const replay = new ReplayBackend(store);

    const results = replay.replay("test", { start: 2, end: 4 });
    assert.equal(results.length, 3);
  });

  it("returns empty array for empty loop", () => {
    const store = new MemoryLoopStore();
    const replay = new ReplayBackend(store);
    assert.deepEqual(replay.replay("nonexistent"), []);
  });
});

describe("ReplayBackend — timeline", () => {
  it("returns sorted summary entries", () => {
    const store = new MemoryLoopStore();
    store.appendEntry(makeEntry({
      task_id: "loop:test:r3",
      loop_lineage: { loop_id: "test", round: 3, recompile_level: "l1", goal_id: "audit", task: "Fix bugs" },
      success: false,
    }));
    store.appendEntry(makeEntry({
      task_id: "loop:test:r1",
      loop_lineage: { loop_id: "test", round: 1, recompile_level: "l2", goal_id: "audit", task: "Audit" },
      success: true,
    }));
    const replay = new ReplayBackend(store);

    const tl = replay.timeline("test");
    assert.equal(tl.length, 2);
    assert.equal(tl[0].round, 1);
    assert.equal(tl[1].round, 3);
    assert.equal(tl[0].recompile_level, "l2");
    assert.equal(tl[1].recompile_level, "l1");
  });

  it("returns empty array for unknown loop", () => {
    const store = new MemoryLoopStore();
    const replay = new ReplayBackend(store);
    const tl = replay.timeline("nonexistent");
    assert.deepEqual(tl, []);
  });

});

// v2.6: ReplayBackend.diff() removed — no tool or API exposed it.
