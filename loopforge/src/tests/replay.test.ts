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
    technique_used: "few-shot-cot",
    quality_score: 4,
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

  it("enriches with full_prompt from markdown", () => {
    backend.appendEntry(makeEntry());
    backend.markdownFiles.set("test:r1", "## Compiled Prompt\n\nAudit the contract.");
    const result = replay.getRound("test", 1);
    assert.equal(result!.full_prompt, "## Compiled Prompt\n\nAudit the contract.");
  });

  it("falls back to markdown scan when JSON vault empty", () => {
    backend.markdownScans.set("test", [
      {
        task_id: "loop:test:r1",
        loop_lineage: { round: 1, goal_id: "audit", loop_id: "test" },
        full_prompt: "## From Markdown",
      },
    ]);
    const result = replay.getRound("test", 1);
    assert.notEqual(result, null);
    assert.equal(result!.full_prompt, "## From Markdown");
  });

  it("merges feedback quality_score", () => {
    backend.appendEntry(makeEntry({ quality_score: 0 }));
    backend.appendEntry({
      task_id: "loop:test:r1:feedback",
      quality_score: 5,
    });
    const result = replay.getRound("test", 1);
    assert.equal(result!.quality_score, 5);
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
      technique_used: "few-shot",
      quality_score: 3,
    }));
    backend.appendEntry(makeEntry({
      task_id: "loop:test:r1",
      loop_lineage: { loop_id: "test", round: 1, recompile_level: "l2", goal_id: "audit", task: "Audit" },
      technique_used: "few-shot-cot",
      quality_score: 4,
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

  it("falls back to markdown scan for maxRound detection", () => {
    const backend = new MemoryBackend();
    // Provide all 5 rounds via markdown scan (simulating a loop with
    // no JSON vault entries — all data from markdown lineage)
    const mdEntries: VaultEntry[] = [];
    for (let r = 1; r <= 5; r++) {
      mdEntries.push({
        task_id: `loop:test:r${r}`,
        loop_lineage: { round: r, loop_id: "test", goal_id: "audit" },
      });
    }
    backend.markdownScans.set("test", mdEntries);
    const replay = new ReplayBackend(backend);
    const results = replay.replay("test");
    assert.equal(results.length, 5); // rounds 1-5, all from markdown
    assert.equal(results[4]?.loop_lineage?.round, 5);
  });
});

describe("ReplayBackend — diff", () => {
  it("detects changes between rounds", () => {
    const backend = new MemoryBackend();
    backend.appendEntry(makeEntry({
      task_id: "loop:test:r1",
      loop_lineage: { loop_id: "test", round: 1, recompile_level: "l2", goal_id: "audit", task: "Audit ERC20", constraints_active: ["check ownership"] },
      technique_used: "few-shot-cot",
      quality_score: 4,
    }));
    backend.appendEntry(makeEntry({
      task_id: "loop:test:r3",
      loop_lineage: { loop_id: "test", round: 3, recompile_level: "l1", goal_id: "audit", task: "Check flash loans", constraints_active: ["check ownership", "check flash loans"] },
      technique_used: "few-shot",
      quality_score: 3,
    }));
    const replay = new ReplayBackend(backend);

    const diff = replay.diff("test", 1, 3);
    assert.equal(diff.missing, null);
    assert.ok((diff.changes as unknown[]).length > 0);
    assert.ok((diff.unchanged as string[]).includes("goal_id"));
  });

  it("handles missing rounds", () => {
    const backend = new MemoryBackend();
    backend.appendEntry(makeEntry({ task_id: "loop:test:r1" }));
    const replay = new ReplayBackend(backend);

    const diff = replay.diff("test", 1, 99);
    assert.equal(diff.missing, "round_b");
  });

  it("handles both missing", () => {
    const backend = new MemoryBackend();
    const replay = new ReplayBackend(backend);

    const diff = replay.diff("test", 1, 2);
    assert.equal(diff.missing, "both");
  });

  it("reports added and removed constraints", () => {
    const backend = new MemoryBackend();
    backend.appendEntry(makeEntry({
      task_id: "loop:test:r1",
      loop_lineage: {
        loop_id: "test", round: 1, recompile_level: "l2", goal_id: "audit",
        task: "Initial", constraints_active: ["A", "B"],
      },
    }));
    backend.appendEntry(makeEntry({
      task_id: "loop:test:r2",
      loop_lineage: {
        loop_id: "test", round: 2, recompile_level: "l1", goal_id: "audit",
        task: "Updated", constraints_active: ["B", "C"],
      },
    }));
    const replay = new ReplayBackend(backend);
    const diff = replay.diff("test", 1, 2);

    const changes = diff.changes as Record<string, unknown>[];
    const constraintChange = changes.find(
      (c) => c.field === "constraints_active",
    );
    assert.notEqual(constraintChange, undefined);
    assert.deepEqual(constraintChange!.added, ["C"]);
    assert.deepEqual(constraintChange!.removed, ["A"]);
  });

  it("does not report constraints_active as changed when identical", () => {
    const backend = new MemoryBackend();
    backend.appendEntry(makeEntry({
      task_id: "loop:test:r1",
      loop_lineage: {
        loop_id: "test", round: 1, recompile_level: "l2", goal_id: "x",
        constraints_active: ["A"],
      },
    }));
    backend.appendEntry(makeEntry({
      task_id: "loop:test:r2",
      loop_lineage: {
        loop_id: "test", round: 2, recompile_level: "l0", goal_id: "x",
        constraints_active: ["A"],
      },
    }));
    const replay = new ReplayBackend(backend);
    const diff = replay.diff("test", 1, 2);

    const unchanged = diff.unchanged as string[];
    assert.ok(unchanged.includes("constraints_active"));
  });
});
