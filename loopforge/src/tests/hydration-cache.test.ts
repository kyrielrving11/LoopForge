/** v3.0.1: Tests for the incremental compile hydration cache.
 *
 * The engine caches merged lineage entries per loop. Warm compiles skip the
 * vault read entirely (fast path); a compile at a later round reads only the
 * round documents committed since the cache point (incremental path). The
 * cache must be invisible to the compiler: a cold engine's full hydration and
 * a warm engine's incremental hydration must produce identical entry sets.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LoopForgeEngine } from "../engine.js";
import { FileLoopStore } from "../loop-store.js";
import type { VaultEntry } from "../loop-store.js";
import { SessionManager } from "../mcp/session.js";
import { MemoryLoopStore } from "./_helpers.js";
import { resetPolicy } from "../policy.js";
import { Mode, type LoopForgeRequest, type SelfEvaluation } from "../protocol.js";

const continuingEvaluation = (): SelfEvaluation => ({
  success: false,
  output_summary: "made progress",
  constraint_violations: [],
  should_continue: true,
  execution_evidence: {
    files_changed: ["src/a.ts"],
    test_results: { passed: 1, failed: 0, skipped: 0 },
    success_criteria_met: [],
    success_criteria_remaining: ["more"],
    progress_estimate: 0.5,
  },
});

/** Records the sinceRound option each listEntries call received. */
class TrackingStore extends MemoryLoopStore {
  sinceRounds: Array<number | undefined> = [];
  override listEntries(loopId?: string, opts?: { sinceRound?: number }): VaultEntry[] {
    this.sinceRounds.push(opts?.sinceRound);
    return super.listEntries(loopId, opts);
  }
}

describe("Hydration cache — equivalence and incrementality", () => {
  beforeEach(() => resetPolicy());

  /** Entries with a lineage round below `compileRound`, sorted by task_id —
   *  the exact set the compiler reads for a compile at that round. Entries of
   *  the compile round itself (its lineage is written after hydration) and
   *  the `full_prompt` attachment timing (cosmetic; never read by the
   *  compiler) are excluded from the comparison. */
  const compilerView = (entries: unknown, compileRound: number): VaultEntry[] =>
    (entries as VaultEntry[])
      .filter((entry) => {
        const lineage = (entry.loop_lineage ?? entry.lineage ?? {}) as Record<string, unknown>;
        const round = typeof lineage.round === "number" ? lineage.round : 0;
        return round >= 1 && round < compileRound;
      })
      .sort((a, b) => String(a.task_id ?? "").localeCompare(String(b.task_id ?? "")));

  it("incremental hydration equals full hydration at each compile point", async () => {
    const store = new FileLoopStore(join(tmpdir(), `loopforge-hyd-${randomUUID()}`));
    const mgr = new SessionManager(store);
    const started = await mgr.create({ task: "Cache equivalence", loopId: "hyd-eq" });
    const sessionId = started.sessionId;

    // Warm engine's hydration points mirror the session's own compile points:
    // each hydrate happens after the previous round committed, for the next
    // compile. A cold engine hydrates the same store state for comparison.
    const warm = new LoopForgeEngine(store);
    const cold = new LoopForgeEngine(store);

    await mgr.advance(sessionId, "", continuingEvaluation()); // commits round 1
    const warm2 = warm.hydrateLoopContext("hyd-eq", 2);
    const cold2 = cold.hydrateLoopContext("hyd-eq", 2);
    assert.ok(warm2 && cold2);
    assert.deepEqual(
      compilerView(warm2.results, 2),
      compilerView(cold2.results, 2),
      "first compile: warm (full) and cold (full) must agree",
    );

    await mgr.advance(sessionId, "", continuingEvaluation()); // commits round 2
    const warm3 = warm.hydrateLoopContext("hyd-eq", 3);
    const cold3 = cold.hydrateLoopContext("hyd-eq", 3);
    assert.ok(warm3 && cold3);
    assert.deepEqual(
      compilerView(warm3.results, 3),
      compilerView(cold3.results, 3),
      "second compile: warm (incremental) and cold (full) must agree",
    );

    await mgr.advance(sessionId, "", continuingEvaluation()); // commits round 3
    const warm4 = warm.hydrateLoopContext("hyd-eq", 4);
    const cold4 = cold.hydrateLoopContext("hyd-eq", 4);
    assert.ok(warm4 && cold4);
    assert.deepEqual(
      compilerView(warm4.results, 4),
      compilerView(cold4.results, 4),
      "third compile: warm (incremental) and cold (full) must agree",
    );
  });

  it("a warm cache serves repeated compiles of the same round with zero reads", async () => {
    const store = new FileLoopStore(join(tmpdir(), `loopforge-hyd-${randomUUID()}`));
    const mgr = new SessionManager(store);
    const started = await mgr.create({ task: "Fast path", loopId: "hyd-fast" });
    await mgr.advance(started.sessionId, "", continuingEvaluation());

    const engine = new LoopForgeEngine(store);
    engine.hydrateLoopContext("hyd-fast", 2);
    const again = engine.hydrateLoopContext("hyd-fast", 2);
    assert.ok(again);
    // Fast path returns the cached array by reference — no re-read, no re-merge.
    assert.equal(
      again.results,
      engine.hydrateLoopContext("hyd-fast", 2)?.results,
      "repeated hydration must return the cached array by reference",
    );
  });

  it("incremental hydration reads only rounds committed since the cache point", async () => {
    const store = new TrackingStore();
    const mgr = new SessionManager(store);
    const started = await mgr.create({ task: "Incremental reads", loopId: "hyd-reads" });
    const sessionId = started.sessionId;

    // Round 1 → full hydration (no sinceRound). Round 2 → incremental sinceRound 2.
    await mgr.advance(sessionId, "", continuingEvaluation());
    await mgr.advance(sessionId, "", continuingEvaluation());
    assert.ok(
      store.sinceRounds.includes(undefined),
      "the first hydration must be a full read",
    );
    assert.ok(
      store.sinceRounds.includes(2),
      `the second compile must read only rounds >= 2 (got: ${store.sinceRounds.join(", ")})`,
    );

    store.sinceRounds = [];
    // Round 3 → incremental sinceRound 3 — only the just-committed document.
    await mgr.advance(sessionId, "", continuingEvaluation());
    assert.ok(
      store.sinceRounds.includes(3),
      `the third compile must read only rounds >= 3 (got: ${store.sinceRounds.join(", ")})`,
    );
  });
});

describe("FileLoopStore listEntries sinceRound", () => {
  let store: FileLoopStore;
  let dir: string;

  before(() => {
    dir = join(tmpdir(), `loopforge-sr-${randomUUID()}`);
    store = new FileLoopStore(dir);
  });
  after(() => {
    try { rmSync(dir, { recursive: true }); } catch { /* best effort */ }
  });

  it("skips round documents older than sinceRound but keeps the session entry", () => {
    for (let round = 1; round <= 3; round++) {
      store.appendEntry({
        id: randomUUID(),
        task_id: `loop:since-test:r${round}`,
        task_type: "loop_lineage",
        loop_id: "since-test",
        timestamp: new Date().toISOString(),
        loop_lineage: { loop_id: "since-test", round },
      });
    }
    store.appendEntry({
      id: randomUUID(),
      task_id: "loop:since-test:session",
      task_type: "session_state",
      loop_id: "since-test",
      timestamp: new Date().toISOString(),
      loop_lineage: { status: "running" },
    });

    const all = store.listEntries("since-test");
    assert.equal(all.length, 4, "all rounds plus session");
    const recent = store.listEntries("since-test", { sinceRound: 3 });
    const taskIds = recent.map((entry) => String(entry.task_id ?? "")).sort();
    assert.deepEqual(taskIds, ["loop:since-test:r3", "loop:since-test:session"]);
  });
});

describe("Hydration cache — backtrack redo replace (v3.3.1)", () => {
  it("a redo that replaces a committed backtrack feedback invalidates the stale cache entry", () => {
    const store = new FileLoopStore(join(tmpdir(), `loopforge-hydredo-${randomUUID()}`));
    const engine = new LoopForgeEngine(store);
    const loopId = "hyd-redo";
    const task = "Rebuild the module after a rollback";
    const compileRequest = (round: number): LoopForgeRequest => ({
      task,
      mode: Mode.LOOP_COMPILE,
      feedback: null,
      skill_name: null,
      task_id: null,
      loop_id: loopId,
      round,
    });
    // Minimal round-transaction shape the engine merges: round_id for the
    // idempotency scan, result for the committed decision.
    const transaction = (roundId: string, action: "backtrack" | "continue") => ({
      round_id: roundId,
      result: { action, verificationFlags: [], roundSuccess: false },
    });
    const round2Entry = (hydration: Record<string, unknown> | null) =>
      ((hydration?.results ?? []) as VaultEntry[]).find((entry) => {
        const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
        return lineage.round === 2;
      });
    const committedAction = (entry: VaultEntry | undefined): unknown =>
      ((entry?.loop_lineage ?? {}) as Record<string, unknown>).committed_action;

    // Round 1 compiles and commits normally.
    engine.invokeLoopCompile(compileRequest(1));
    engine.autoFeedback(continuingEvaluation(), loopId, 1, task, transaction("rid-1", "continue"));
    // Round 2 compiles, then the runtime commits a BACKTRACK decision for it.
    engine.invokeLoopCompile(compileRequest(2));
    engine.autoFeedback(continuingEvaluation(), loopId, 2, task, transaction("rid-2", "backtrack"));
    // Warm hydration merges the backtrack into the cache (coveredRound = 2).
    engine.hydrateLoopContext(loopId, 3);
    const warm = engine.hydrateLoopContext(loopId, 3);
    assert.ok(warm, "hydration must be served from the warm cache");
    assert.equal(
      committedAction(round2Entry(warm)),
      "backtrack",
      "precondition: the cache holds the rolled-back round-2 decision",
    );

    // The agent redoes round 2 (same roundId) — the redo REPLACES the
    // backtrack feedback (v3.2.1 semantics).
    engine.autoFeedback(continuingEvaluation(), loopId, 2, task, transaction("rid-2", "continue"));

    // v3.3.1: the next hydration must show the REDO decision. Before the
    // fix, the fast path (coveredRound >= round - 1) served the stale
    // rolled-back entry forever — round-2's committed_action stayed
    // "backtrack", wrongly forcing L2 rehydration and stale compiler state.
    const after = engine.hydrateLoopContext(loopId, 3);
    assert.ok(after, "hydration must be served after the redo");
    assert.equal(
      committedAction(round2Entry(after)),
      "continue",
      "the redo's decision must replace the rolled-back entry in the cache view",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.5.1 — hydration stamps machine-observed data onto merged lineage entries
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.5.1 — hydration stamps attempt/roundEvidence for the compile view", () => {
  beforeEach(() => resetPolicy());

  it("merged lineage entries carry lineage.attempt after a committed round", async () => {
    const store = new FileLoopStore(join(tmpdir(), `loopforge-stamp-${randomUUID()}`));
    const mgr = new SessionManager(store);
    const started = await mgr.create({ task: "Stamp check", loopId: "stamp-check" });
    const sessionId = started.sessionId;

    // One rejected attempt then an accepted one → committed attempt = 2.
    const rejected = await mgr.advance(sessionId, "", {
      success: true,
      output_summary: "premature success",
      constraint_violations: [],
      should_continue: true,
      execution_evidence: {
        files_changed: [],
        test_results: { passed: 0, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["more"],
        progress_estimate: 0.1,
      },
    });
    assert.equal(rejected.enforcementAction, "reject");
    const accepted = await mgr.advance(sessionId, "", continuingEvaluation());
    assert.equal(accepted.round, 2);

    // A fresh engine hydrates from disk and must re-derive the same stamp —
    // the compile view's Round Stats / Machine rows depend on it.
    const engine = new LoopForgeEngine(store);
    const hydrated = engine.hydrateLoopContext("stamp-check", 2);
    const results = ((hydrated as { results?: unknown }).results ?? []) as Array<Record<string, unknown>>;
    const r1 = results.find((entry) => {
      const lin = (entry.loop_lineage ?? {}) as Record<string, unknown>;
      return lin.round === 1;
    });
    assert.ok(r1, "round-1 merged entry must be in the hydrated view");
    const lin1 = (r1!.loop_lineage ?? {}) as Record<string, unknown>;
    assert.equal(lin1.attempt, 2,
      "the committed attempt (rejection + redo) must be stamped for the compile view");
    assert.equal(typeof lin1.attempt, "number");
  });
});
