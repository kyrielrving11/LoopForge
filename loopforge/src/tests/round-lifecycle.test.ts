/** Tests for RoundLifecycle — the round state machine extracted from
 *  SessionManager (v2.14 decomposition).
 *
 *  Crash recovery (reconstructSession / reconcileCommittedRound) is tested
 *  directly against a fake registry — no full MCP stack needed.
 *  Uses MemoryLoopStore from _helpers.js — no disk I/O.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryLoopStore, installTestCommandProvider, criterionClaims } from "./_helpers.js";
import { resetPolicy } from "../policy.js";
import { LoopForgeEngine } from "../engine.js";
import { SessionManager } from "../mcp/session.js";
import { RoundLifecycle } from "../mcp/round-lifecycle.js";
import type { McpSession, SessionRegistry } from "../mcp/round-lifecycle.js";
import { RoundDriver } from "../round-driver.js";
import { prepareRoundTransaction } from "../round-transaction.js";
import { VaultSessionStateStore } from "../storage.js";
import { SessionLeaseConflictError } from "../storage.js";
import { StorageCorruptionError } from "../loop-store.js";
import type { LoopStore, VaultEntry } from "../loop-store.js";
import type { SelfEvaluation } from "../protocol.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** A fake SessionRegistry backed by a plain map. Lets us test the lifecycle
 *  without a SessionManager. */
function makeRegistry(): SessionRegistry & {
  upsert(s: McpSession): void;
  get(id: string): McpSession | undefined;
  values(): Iterable<McpSession>;
} {
  const map = new Map<string, McpSession>();
  return {
    get: (id: string) => map.get(id),
    values: () => map.values(),
    upsert: (s: McpSession) => { map.set(s.sessionId, s); },
  };
}

function makeLifecycle(
  store: LoopStore,
  registry: SessionRegistry,
  opts: { ownerId?: string; pauseDuringContext?: boolean | (() => void) } = {},
): RoundLifecycle {
  return new RoundLifecycle({
    store,
    sessionStore: new VaultSessionStateStore(store),
    registry,
    terminalSinks: new Set(),
    ownerId: opts.ownerId ?? "test-owner",
    leaseMs: 60_000,
    getContext: () => opts.pauseDuringContext
      ? async () => {
          // Simulate pause()/delete() racing the context provider await:
          // either mutate the registered session directly, or run the real
          // pause() (which also persists the incremented round counter).
          if (typeof opts.pauseDuringContext === "function") {
            opts.pauseDuringContext();
          } else {
            for (const s of registry.values()) s.status = "paused";
          }
          return "";
        }
      : undefined,
  });
}

/** Build a session_state VaultEntry with default lineage fields. */
function makeSessionEntry(overrides: {
  loopId: string;
  status?: McpSession["status"];
  currentRound?: number;
  sessionId?: string;
  currentPrompt?: string | null;
  roundSnapshot?: Record<string, unknown> | null;
}): VaultEntry {
  return {
    task_id: `loop:${overrides.loopId}:session`,
    task_type: "session_state",
    timestamp: new Date().toISOString(),
    loop_id: overrides.loopId,
    task: "Test task",
    loop_lineage: {
      session_id: overrides.sessionId ?? null,
      current_round: overrides.currentRound ?? 1,
      max_rounds: 20,
      success_trajectory: [],
      status: overrides.status ?? "running",
      created_at: Date.now(),
      consecutive_rejections: 0,
      last_rejection_check: "",
      backtrack_skipped_files: [],
      backtrack_target_git_head: null,
      round_snapshot: overrides.roundSnapshot ?? null,
      last_self_eval: null,
      current_prompt: overrides.currentPrompt ?? null,
      current_level: "",
      lease_owner: "",
      lease_expires_at: 0,
    },
  };
}

/** SelfEvaluation with minimal execution evidence so the enforcement gate
 *  doesn't reject the round (same shape as mcp.test.ts agentOutput). */
function evalFor(opts: { success?: boolean; shouldContinue?: boolean }): SelfEvaluation {
  const success = opts.success ?? true;
  return {
    success,
    output_summary: "Completed the task successfully.",
    constraint_violations: [],
    should_continue: opts.shouldContinue ?? true,
    execution_report: success
      ? {
          files_changed: ["src/test.ts"],
          tests_reported: { passed: 1, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims([], []),
        }
      : undefined,
  } as SelfEvaluation;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("RoundLifecycle — reconstructSession", async () => {
  let store: MemoryLoopStore;
  let lifecycle: RoundLifecycle;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    lifecycle = makeLifecycle(store, makeRegistry());
  });

  it("reconstructs a running entry with all lineage fields mapped", () => {
    const snapshot = prepareRoundTransaction("loop-a", 3, []);
    const entry = makeSessionEntry({
      loopId: "loop-a",
      sessionId: "sess-1",
      currentRound: 3,
      currentPrompt: "held prompt",
      roundSnapshot: JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>,
    });
    (entry.loop_lineage as Record<string, unknown>).backtrack_skipped_files = ["a.ts"];
    (entry.loop_lineage as Record<string, unknown>).backtrack_target_git_head = "abc123";
    (entry.loop_lineage as Record<string, unknown>).consecutive_rejections = 1;
    (entry.loop_lineage as Record<string, unknown>).last_rejection_check = "R4";

    const session = lifecycle.reconstructSession(entry)!;
    assert.ok(session, "running entry must reconstruct");
    assert.equal(session.sessionId, "sess-1");
    assert.equal(session.loopId, "loop-a");
    assert.equal(session.currentRound, 3);
    assert.equal(session.status, "running");
    assert.equal(session.consecutiveRejections, 1);
    assert.equal(session.lastRejectionCheck, "R4");
    assert.deepEqual(session.backtrackSkippedFiles, ["a.ts"]);
    assert.equal(session.backtrackTargetGitHead, "abc123");
    assert.equal(session.currentPrompt, "held prompt");
    // Evidence baseline comes from the persisted snapshot
    assert.deepEqual(session.evidenceBaseline, snapshot.beforeEvidence);
    assert.equal(session.roundSnapshot?.roundId, snapshot.roundId);
  });

  it("rejects paused/stopped entries unless allowPaused is set", () => {
    const paused = makeSessionEntry({ loopId: "loop-p", status: "paused" });
    assert.equal(lifecycle.reconstructSession(paused), null);
    const resumed = lifecycle.reconstructSession(paused, true);
    assert.ok(resumed);
    assert.equal(resumed.status, "paused");

    const stopped = makeSessionEntry({ loopId: "loop-s", status: "stopped" });
    assert.equal(lifecycle.reconstructSession(stopped), null);
    assert.equal(lifecycle.reconstructSession(stopped, true), null);
  });

  it("round-trips save → reconstruct across a process restart", () => {
    const engine = new LoopForgeEngine(store);
    const original: McpSession = {
      sessionId: "sess-rt",
      loopId: "loop-rt",
      task: "Round trip",
      engine,
      currentRound: 4,
      maxRounds: 20,
      successTrajectory: [true],
      status: "running",
      createdAt: Date.now(),
      consecutiveRejections: 0,
      lastRejectionCheck: "",
      backtrackSkippedFiles: [],
      backtrackSkippedFingerprints: {},
      evidenceBaseline: [],
      roundSnapshot: prepareRoundTransaction("loop-rt", 4, []),
      currentPrompt: "persisted prompt",
      currentLevel: "l1",
      currentWarnings: ["warn"],
    };

    lifecycle.save(original);

    // "New process": fresh lifecycle over the same store
    const restarted = makeLifecycle(store, makeRegistry());
    const entry = new VaultSessionStateStore(store).load("loop-rt")!;
    const recovered = restarted.reconstructSession(entry)!;

    assert.equal(recovered.loopId, "loop-rt");
    assert.equal(recovered.currentRound, 4);
    assert.equal(recovered.currentPrompt, "persisted prompt");
    assert.equal(recovered.currentLevel, "l1");
    assert.deepEqual(recovered.successTrajectory, [true]);
  });

  it("surfaces round-sequence gaps at load time (reconstructSession)", () => {
    const store = new MemoryLoopStore();
    // Session entry claims the loop is running
    store.writeSession("gap-loop", {
      schemaVersion: 1,
      loopId: "gap-loop",
      updatedAt: new Date().toISOString(),
      entry: {
        task_id: "loop:gap-loop:session",
        task_type: "session_state",
        loop_id: "gap-loop",
        loop_lineage: { session_id: "sess-gap", status: "running", current_round: 4 },
      },
    });
    // Rounds 1 and 3 committed — round 2 was deleted
    store.writeRound("gap-loop", {
      schemaVersion: 1,
      loopId: "gap-loop",
      round: 1,
      sequence: 1,
      updatedAt: new Date().toISOString(),
      events: [],
    });
    store.writeRound("gap-loop", {
      schemaVersion: 1,
      loopId: "gap-loop",
      round: 3,
      sequence: 3,
      updatedAt: new Date().toISOString(),
      events: [],
    });

    // v2.14: reconstructing a gapped loop must surface the corruption —
    // previously the gap was only visible through the read-only audit.
    const lifecycle = makeLifecycle(store, makeRegistry());
    const entry = new VaultSessionStateStore(store).load("gap-loop")!;
    assert.throws(
      () => lifecycle.reconstructSession(entry),
      (error: unknown) =>
        error instanceof StorageCorruptionError && error.kind === "sequence_gap",
    );
  });

  it("throws SessionLeaseConflictError when another owner holds the lease", () => {
    const engine = new LoopForgeEngine(store);
    const session: McpSession = {
      sessionId: "sess-conflict",
      loopId: "loop-conflict",
      task: "Conflict",
      engine,
      currentRound: 1,
      maxRounds: 20,
      successTrajectory: [],
      status: "running",
      createdAt: Date.now(),
      consecutiveRejections: 0,
      lastRejectionCheck: "",
      backtrackSkippedFiles: [],
      backtrackSkippedFingerprints: {},
      evidenceBaseline: [],
    };

    // Process A persists a running session — its entry carries lease_owner A
    const ownerA = makeLifecycle(store, makeRegistry(), { ownerId: "owner-A" });
    ownerA.save(session);

    // Process B tries to persist its running session for the same loop —
    // the cross-process fence must reject the write.
    const ownerB = makeLifecycle(store, makeRegistry(), { ownerId: "owner-B" });
    assert.throws(
      () => ownerB.save({ ...session, sessionId: "sess-conflict-B" }),
      SessionLeaseConflictError,
    );
  });
});

describe("RoundLifecycle — resume / crash window", async () => {
  let store: MemoryLoopStore;
  let lifecycle: RoundLifecycle;

  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence.
    installTestCommandProvider();
    store = new MemoryLoopStore();
    lifecycle = makeLifecycle(store, makeRegistry());
  });

  it("resume returns the held prompt without recompiling", async () => {
    const session: McpSession = {
      sessionId: "sess-held",
      loopId: "loop-held",
      task: "Held",
      engine: new LoopForgeEngine(store),
      currentRound: 2,
      maxRounds: 20,
      successTrajectory: [],
      status: "running",
      createdAt: Date.now(),
      consecutiveRejections: 0,
      lastRejectionCheck: "",
      backtrackSkippedFiles: [],
      backtrackSkippedFingerprints: {},
      evidenceBaseline: [],
      roundSnapshot: prepareRoundTransaction("loop-held", 2, []),
      currentPrompt: "HELD-PROMPT",
      currentLevel: "l2",
    };

    const result = await lifecycle.resume(session);
    assert.equal(result.prompt, "HELD-PROMPT");
    assert.equal(result.round, 2);
    assert.equal(session.currentPrompt, "HELD-PROMPT", "prompt not consumed");
  });

  it("resume recovers a missing round-1 prompt and persists it", async () => {
    const session: McpSession = {
      sessionId: "sess-legacy-resume",
      loopId: "loop-legacy-resume",
      task: "Legacy resume",
      engine: new LoopForgeEngine(store),
      currentRound: 1,
      maxRounds: 20,
      successTrajectory: [],
      status: "running",
      createdAt: Date.now(),
      consecutiveRejections: 0,
      lastRejectionCheck: "",
      backtrackSkippedFiles: [],
      backtrackSkippedFingerprints: {},
      evidenceBaseline: [],
    };

    const result = await lifecycle.resume(session);
    assert.ok(result.prompt, "legacy resume compiles a prompt");
    assert.ok(result.prompt!.includes("LoopForge"));
    assert.equal(result.round, 1);
    // Persisted for cross-process recovery
    const persisted = new VaultSessionStateStore(store).load("loop-legacy-resume")!;
    const lineage = persisted.loop_lineage as Record<string, unknown>;
    assert.equal(lineage.current_prompt, result.prompt);
  });

  it("crash window: committed continue-round recovered on resume", async () => {
    const mgr = new SessionManager(store);
    const start = await mgr.create({ task: "Crash continue", loopId: "crash-cont" });
    const sid = String(start.sessionId);
    const session = mgr.get(sid)!;

    // Agent's round 1 commits, but the process crashes before the prompt
    // for round 2 is compiled — session state still points at round 1.
    await new RoundDriver(session.engine, store).complete({
      snapshot: session.roundSnapshot!,
      loopId: session.loopId,
      task: session.task,
      maxRounds: session.maxRounds,
      selfEval: evalFor({ success: true, shouldContinue: true }),
      consecutiveRejections: 0,
      successTrajectory: session.successTrajectory,
    });

    // "New process": the old process releases its lease on close() (same-pid
    // acquireLease refuses to take over while the owner is alive), then
    // claim the lease like production resume() does via claimSessionEntry.
    mgr.close();
    const restarted = makeLifecycle(store, makeRegistry());
    const sessionStore = new VaultSessionStateStore(store);
    sessionStore.acquireLease("crash-cont", "test-owner", 60_000);
    const entry = sessionStore.load("crash-cont")!;
    const recovered = restarted.reconstructSession(entry)!;
    const result = await restarted.resume(recovered);

    assert.equal(result.round, 2, "committed continue advances to the next round");
    assert.ok(result.prompt, "next round prompt compiled");
    assert.equal(recovered.currentRound, 2);
  });

  it("crash window: committed stop-round returns the terminal result", async () => {
    const mgr = new SessionManager(store);
    const start = await mgr.create({ task: "Crash stop", loopId: "crash-stop" });
    const sid = String(start.sessionId);
    const session = mgr.get(sid)!;

    await new RoundDriver(session.engine, store).complete({
      snapshot: session.roundSnapshot!,
      loopId: session.loopId,
      task: session.task,
      maxRounds: session.maxRounds,
      selfEval: evalFor({ success: true, shouldContinue: false }),
      consecutiveRejections: 0,
      successTrajectory: session.successTrajectory,
    });

    mgr.close();
    const restarted = makeLifecycle(store, makeRegistry());
    const sessionStore = new VaultSessionStateStore(store);
    sessionStore.acquireLease("crash-stop", "test-owner", 60_000);
    const entry = sessionStore.load("crash-stop")!;
    const recovered = restarted.reconstructSession(entry)!;
    const result = await restarted.resume(recovered);

    assert.equal(result.prompt, null);
    assert.equal(result.stopReason, "completed");
    assert.equal(recovered.status, "stopped");
  });
});

describe("RoundLifecycle — advance", async () => {
  it("commit fence stops compile when the session is paused mid-advance", async () => {
    resetPolicy();
    installTestCommandProvider();
    const store = new MemoryLoopStore();
    const mgr = new SessionManager(store);
    const start = await mgr.create({ task: "Fence test", loopId: "fence-test" });
    const sid = String(start.sessionId);

    // A lifecycle whose context provider pauses the session while the
    // provider await is in flight — the pause/delete race the fence guards.
    const registry = makeRegistry();
    registry.upsert(mgr.get(sid)!);
    const racing = makeLifecycle(store, registry, { pauseDuringContext: true });

    const result = await racing.advance(sid, "agent output", evalFor({ success: true }));

    assert.equal(result.prompt, null, "next prompt must not be compiled");
    assert.equal(result.stopReason, "paused");
    assert.equal(mgr.get(sid)!.status, "paused");
  });

  it("resume after the pause race compiles the next round, not skip it", async () => {
    resetPolicy();
    installTestCommandProvider();
    const store = new MemoryLoopStore();
    const mgr = new SessionManager(store);
    const start = await mgr.create({ task: "Pause race resume", loopId: "pause-race" });
    const sid = String(start.sessionId);

    // The real race: while advance awaits the context provider, pause()
    // runs — setting status and PERSISTING the already-incremented round
    // counter (the commit fence then returns "paused" without compiling).
    const registry = makeRegistry();
    registry.upsert(mgr.get(sid)!);
    const racing = makeLifecycle(store, registry, {
      pauseDuringContext: () => { void mgr.pause(sid); },
    });
    const result = await racing.advance(sid, "agent output", evalFor({ success: true }));
    assert.equal(result.stopReason, "paused");
    assert.equal(mgr.get(sid)!.currentRound, 2, "round counter incremented before the fence");

    // "Process restart": unpause must compile round 2 — previously the
    // replay incremented the already-incremented counter and silently
    // skipped round 2 (jumping straight to round 3).
    mgr.close();
    const mgr2 = new SessionManager(store);
    const resumed = await mgr2.unpause("pause-race");
    assert.ok(resumed);
    assert.equal(resumed.round, 2, "resume must compile the next round, not skip it");
    assert.ok(resumed.prompt);
    // L1: pause() persisted the trajectory AFTER round 1's success was
    // pushed — the crash-window reconcile must not push it a second time.
    assert.deepEqual(mgr2.get(sid)?.successTrajectory, [true],
      "unpause must not duplicate round 1 in the success trajectory");
  });
});
