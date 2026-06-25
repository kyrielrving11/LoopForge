/** Tests for ReplayBackend — time-travel queries. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ReplayBackend } from "../replay.js";
/** In-memory backend for testing — implements VaultBackend without filesystem. */
class MemoryBackend {
    entries = [];
    markdownFiles = new Map();
    markdownScans = new Map();
    readVault() {
        return { entries: this.entries };
    }
    writeVault(data) {
        this.entries = data.entries || [];
    }
    queryEntries(opts) {
        return this.entries.filter((entry) => {
            const taskId = String(entry.task_id ?? "");
            if (opts?.feedbackOnly && !taskId.endsWith(":feedback"))
                return false;
            if (!opts?.feedbackOnly && taskId.endsWith(":feedback"))
                return false;
            if (opts?.prefix && !taskId.startsWith(opts.prefix))
                return false;
            return true;
        });
    }
    appendEntry(entry) {
        this.entries.push(entry);
    }
    appendEntries(entries) {
        this.entries.push(...entries);
        return entries.length;
    }
    writeLineageMd(_loopId, roundNum, content, _metadata) {
        this.markdownFiles.set(`${_loopId}:r${roundNum}`, content);
        return `/fake/${_loopId}/r${roundNum}.md`;
    }
    readLineageMd(loopId, roundNum) {
        return this.markdownFiles.get(`${loopId}:r${roundNum}`) ?? null;
    }
    scanLineageMd(loopId) {
        return this.markdownScans.get(loopId) ?? [];
    }
}
function makeEntry(overrides = {}) {
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
    let backend;
    let replay;
    beforeEach(() => {
        backend = new MemoryBackend();
        replay = new ReplayBackend(backend);
    });
    it("returns entry for existing round", () => {
        backend.appendEntry(makeEntry());
        const result = replay.getRound("test", 1);
        assert.notEqual(result, null);
        assert.equal(result.task_id, "loop:test:r1");
    });
    it("returns null for missing round", () => {
        const result = replay.getRound("test", 99);
        assert.equal(result, null);
    });
    it("enriches with full_prompt from markdown", () => {
        backend.appendEntry(makeEntry());
        backend.markdownFiles.set("test:r1", "## Compiled Prompt\n\nAudit the contract.");
        const result = replay.getRound("test", 1);
        assert.equal(result.full_prompt, "## Compiled Prompt\n\nAudit the contract.");
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
        assert.equal(result.full_prompt, "## From Markdown");
    });
    it("merges feedback quality_score", () => {
        backend.appendEntry(makeEntry({ quality_score: 0 }));
        backend.appendEntry({
            task_id: "loop:test:r1:feedback",
            quality_score: 5,
        });
        const result = replay.getRound("test", 1);
        assert.equal(result.quality_score, 5);
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
        assert.ok(diff.changes.length > 0);
        assert.ok(diff.unchanged.includes("goal_id"));
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
});
//# sourceMappingURL=replay.test.js.map