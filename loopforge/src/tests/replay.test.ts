/** Tests for ReplayBackend — time-travel queries. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ReplayBackend } from "../replay.js";
import { MemoryBackend } from "./_helpers.js";
import type { VaultEntry } from "../backends/interface.js";

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
  let backend: MemoryBackend;
  let replay: ReplayBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
    replay = new ReplayBackend(backend);
  });

  it("returns entry for existing round", () => {
    backend.appendEntry(makeEntry());
    const result = replay.getRound("test", 1);
    assert.notEqual(result, null);
    assert.equal(result!.task_id, "loop:test:r1");
  });

  it("returns null for missing round", () => {
    const result = replay.getRound("test", 99);
    assert.equal(result, null);
  });

  it("returns the prompt stored in the typed round projection", () => {
    backend.appendEntry(makeEntry({ full_prompt: "## Compiled Prompt" }));
    assert.equal(replay.getRound("test", 1)?.full_prompt, "## Compiled Prompt");
  });

  it("merges feedback success flag", () => {
    backend.appendEntry(makeEntry({ success: false }));
    backend.appendEntry({
      task_id: "loop:test:r1:feedback",
      success: true,
    });
    const result = replay.getRound("test", 1);
    assert.equal(result!.success, true);
  });
});

describe("ReplayBackend — replay", () => {
  it("returns all rounds in range", () => {
    const backend = new MemoryBackend();
    backend.appendEntry(makeEntry({ task_id: "loop:test:r1", loop_lineage: { loop_id: "test", round: 1 } }));
    backend.appendEntry(makeEntry({ task_id: "loop:test:r2", loop_lineage: { loop_id: "test", round: 2 } }));
    backend.appendEntry(makeEntry({ task_id: "loop:test:r3", loop_lineage: { loop_id: "test", round: 3 } }));
    const replay = new ReplayBackend(backend);

    const results = replay.replay("test");
    assert.equal(results.length, 3);
  });

  it("respects start/end range", () => {
    const backend = new MemoryBackend();
    for (let i = 1; i <= 5; i++) {
      backend.appendEntry(makeEntry({
        task_id: `loop:test:r${i}`,
        loop_lineage: { loop_id: "test", round: i },
      }));
    }
    const replay = new ReplayBackend(backend);

    const results = replay.replay("test", { start: 2, end: 4 });
    assert.equal(results.length, 3);
  });

  it("returns empty array for empty loop", () => {
    const backend = new MemoryBackend();
    const replay = new ReplayBackend(backend);
    assert.deepEqual(replay.replay("nonexistent"), []);
  });
});

describe("ReplayBackend — timeline", () => {
  it("returns sorted summary entries", () => {
    const backend = new MemoryBackend();
    backend.appendEntry(makeEntry({
      task_id: "loop:test:r3",
      loop_lineage: { loop_id: "test", round: 3, recompile_level: "l1", goal_id: "audit", task: "Fix bugs" },
      success: false,
    }));
    backend.appendEntry(makeEntry({
      task_id: "loop:test:r1",
      loop_lineage: { loop_id: "test", round: 1, recompile_level: "l2", goal_id: "audit", task: "Audit" },
      success: true,
    }));
    const replay = new ReplayBackend(backend);

    const tl = replay.timeline("test");
    assert.equal(tl.length, 2);
    assert.equal(tl[0].round, 1);
    assert.equal(tl[1].round, 3);
    assert.equal(tl[0].recompile_level, "l2");
    assert.equal(tl[1].recompile_level, "l1");
  });

  it("returns empty array for unknown loop", () => {
    const backend = new MemoryBackend();
    const replay = new ReplayBackend(backend);
    const tl = replay.timeline("nonexistent");
    assert.deepEqual(tl, []);
  });

});

// v2.6: ReplayBackend.diff() removed — no tool or API exposed it.
