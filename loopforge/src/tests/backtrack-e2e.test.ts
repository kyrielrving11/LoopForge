/** End-to-end backtrack lifecycle test.
 *
 * Drives a complete backtrack cycle through the SessionManager API directly
 * (no subprocess) so that crash recovery can be simulated by destroying and
 * recreating the SessionManager with the same FileLoopStore backend.
 *
 * Flow: start → 3× flat progress → backtrack → verify prompt → simulated
 * crash → resume → verify recovery → continue loop.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FileLoopStore, queryLoopEntries } from "../loop-store.js";
import { SessionManager } from "../mcp/session.js";
import type { McpSession } from "../mcp/session.js";
import { verifyBacktrackPrompt } from "./_backtrack-asserts.js";
import { installTestCommandProvider, criterionClaims } from "./_helpers.js";
import { resetPolicy } from "../policy.js";

// v3.3: success claims need machine-backed evidence — the SessionManager
// collects via the real collector, so a passing command provider keeps
// R8 / success_unverified silent in these flows.
installTestCommandProvider();

// ── Helpers ──────────────────────────────────────────────────────────────

/** A flat-progress self-evaluation that will eventually trigger
 *  progress_stall after 3 consecutive rounds. */
function stalledEval(round: number, progress: number, files: string[]) {
  return {
    success: false as const,
    output_summary: `Round ${round}: reviewed ${files.join(", ")}, no new progress.`,
    should_continue: true as const,
    constraint_violations: [] as string[],
    execution_report: {
      files_changed: files,
      tests_reported: { passed: 0, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims([] as string[], ["Complete the task"]),
    },
  };
}

/** Create a SessionManager wired to a temp directory. */
function createSessionManager(storeDir: string): SessionManager {
  return new SessionManager(
    new FileLoopStore(join(storeDir, ".loopforge")),
  );
}

/** v3.9.7: the restore executor mutates its workspace. These E2E suites must
 *  run against a disposable Git repo, never the checkout that is executing the
 *  tests. */
function initWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "loopforge-backtrack-ws-"));
  const git = (...args: string[]): void => {
    execFileSync("git", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "lf-e2e",
        GIT_AUTHOR_EMAIL: "lf-e2e@example.invalid",
        GIT_COMMITTER_NAME: "lf-e2e",
        GIT_COMMITTER_EMAIL: "lf-e2e@example.invalid",
      },
    });
  };
  git("init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".loopforge/\n");
  writeFileSync(join(dir, "baseline.txt"), "baseline\n");
  git("add", ".");
  git("commit", "-q", "-m", "baseline");
  return dir;
}

/** v3.2.1 regression: a genuine fix submitted after backtrack — must be
 *  evaluated, never replayed as the old backtrack decision. */
function fixedEval(round: number, files: string[]) {
  return {
    success: true as const,
    output_summary: `Round ${round}: fixed the root cause, tests now pass.`,
    should_continue: true as const,
    constraint_violations: [] as string[],
    execution_report: {
      files_changed: files,
      tests_reported: { passed: 0, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims(["Complete the task"], [] as string[]),
    },
  };
}

describe("E2E backtrack lifecycle", () => {
  let storeDir: string;
  let mgr: SessionManager;
  let sessionId: string;
  let loopId: string;
  let workspaceDir: string;
  let originalCwd: string;

  before(() => {
    // v3.9.7: this suite drives the real collector; a policy left behind by
    // another test file would remove the Git provider and with it every
    // checkpoint. Start from the shipped defaults.
    resetPolicy();
    originalCwd = process.cwd();
    workspaceDir = initWorkspace();
    process.chdir(workspaceDir);
    storeDir = join(tmpdir(), `loopforge-backtrack-${randomUUID()}`);
    mgr = createSessionManager(storeDir);
  });

  after(() => {
    mgr.close();
    process.chdir(originalCwd);
    for (const dir of [storeDir, workspaceDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  // ── Step 1: Start ──────────────────────────────────────────────────────

  it("step 1 — start compiles the first prompt", async () => {
    const result = await mgr.create({
      task: "Write unit tests for all public functions. Run npm test after each change.",
      maxRounds: 10,
      constraints: ["Do not skip tests", "Run npm test before claiming success"],
    });

    assert.ok(!result.prompt?.includes("error"), `unexpected error in prompt`);
    assert.equal(result.round, 1);
    assert.ok(typeof result.sessionId === "string" && result.sessionId.length > 0);
    assert.ok(typeof result.prompt === "string" && result.prompt.length > 100);

    sessionId = result.sessionId;
    const session = mgr.get(sessionId)!;
    loopId = session.loopId;
    assert.ok(loopId.length > 0, "loopId must be non-empty");
  });

  // ── Step 2–5: Four flat-progress rounds → backtrack ───────────────────
  // R4 needs 3 data points in vault. Round 1 goes to vault after advance,
  // so we need rounds 1,2,3 in vault + round 4 triggering enforcement.

  it("step 2 — round 1 flat progress (0.3)", async () => {
    const result = await mgr.advance(
      sessionId,
      "Round 1 output",
      stalledEval(1, 0.3, ["src/a.ts"]),
    );
    assert.ok(!result.enforcementAction || result.enforcementAction === "accept");
    assert.equal(result.round, 2);
  });

  it("step 3 — round 2 flat progress (0.3)", async () => {
    const result = await mgr.advance(
      sessionId,
      "Round 2 output",
      stalledEval(2, 0.3, ["src/b.ts"]),
    );
    assert.ok(!result.enforcementAction || result.enforcementAction === "accept");
    assert.equal(result.round, 3);
  });

  it("step 4 — round 3 flat progress (0.3)", async () => {
    const result = await mgr.advance(
      sessionId,
      "Round 3 output",
      stalledEval(3, 0.3, ["src/c.ts"]),
    );
    assert.ok(!result.enforcementAction || result.enforcementAction === "accept");
    assert.equal(result.round, 4);
  });

  it("step 5 — round 4 triggers progress_stall REJECT (first occurrence)", async () => {
    const before = mgr.get(sessionId)!;
    const roundId = before.roundSnapshot?.roundId;
    const result = await mgr.advance(
      sessionId,
      "Round 4 output",
      stalledEval(4, 0.3, ["src/d.ts"]),
    );

    // First stall detection → reject (gives agent a chance to change approach)
    assert.equal(
      result.enforcementAction,
      "reject",
      `expected enforcementAction=reject (first stall), got ${result.enforcementAction} (reason: ${result.enforcementReason ?? "none"})`,
    );
    assert.equal(result.round, 4, "reject must not advance the round counter");
    assert.equal(mgr.get(sessionId)!.roundSnapshot?.roundId, roundId,
      "reject keeps the logical round identity for retry");
    const feedback = queryLoopEntries(
      new FileLoopStore(join(storeDir, ".loopforge")),
      loopId,
      { prefix: `loop:${loopId}:r4`, feedbackOnly: true },
    );
    assert.equal(feedback.length, 0,
      "a rejected attempt must not become committed round history");
  });

  it("step 6 — round 4 retry triggers BACKTRACK (second consecutive stall)", async () => {
    const result = await mgr.advance(
      sessionId,
      "Round 4 retry output — same stalled approach",
      stalledEval(4, 0.3, ["src/d.ts"]),
    );

    // Second consecutive stall → backtrack (escalation + backtrack_enabled)
    assert.equal(
      result.enforcementAction,
      "backtrack",
      `expected enforcementAction=backtrack, got ${result.enforcementAction} (reason: ${result.enforcementReason ?? "none"})`,
    );

    // Prompt must reference Backtrack, Workspace Restore, and NO literal ${...}
    assert.ok(typeof result.prompt === "string" && result.prompt.length > 50);
    assert.ok(
      !result.prompt!.includes("${"),
      "backtrack prompt must not contain un-interpolated ${...} literals",
    );
    assert.ok(result.prompt!.includes("Recovery Brief"),
      "the protected recovery section is part of the compiled prompt");
    assert.match(result.prompt!, /Restored checkpoint\*\*: `ck-[a-f0-9]{24}`/,
      "prompt must name the machine-restored checkpoint");
    assert.match(result.prompt!, /Redo round\*\*: \d+/,
      "prompt must name the first redo round");
    // v3.7.1: the Recovery Brief carries the derived facts — trigger and the
    // failed (in-flight) approach. v3.9.4: it is inside the artifact, so the
    // delivered prompt equals `prompt_artifact.renderedPrompt`.
    assert.ok(result.prompt!.includes("**Trigger**: progress_stall"),
      "brief must name the trigger rule");
    assert.match(result.prompt!, /Failure reason\*\*: .*no machine-observed progress/,
      "brief must preserve the machine's reason for the rollback");
    assert.match(result.prompt!, /Restored checkpoint\*\*: .*machine-verified by LoopForge/,
      "brief must state that LoopForge verified the restore");
    assert.ok(result.prompt!.includes(`Failed approach: Round 4: reviewed src/d.ts, no new progress.`),
      "brief must record the failed approach");
    assert.equal(
      result.prompt,
      mgr.get(sessionId)?.roundSnapshot?.promptArtifact?.renderedPrompt,
      "the artifact must describe the exact prompt delivered",
    );
  });

  // ── Step 7: Simulate crash and recover ─────────────────────────────────

  it("step 7 — crash recovery via new SessionManager resumes correctly", async () => {
    // Capture state before crash
    const sessionBefore = mgr.get(sessionId)!;
    const roundBefore = sessionBefore.currentRound;

    // Simulate crash: close old manager, create new one with same store
    mgr.close();
    mgr = createSessionManager(storeDir);

    // Auto-resume all vault sessions (as McpServer.start() does)
    const resumed = mgr.autoResumeAll();
    assert.ok(resumed >= 1, `autoResumeAll must find >=1 sessions, got ${resumed}`);

    // Find the resumed session
    const sessions = mgr.list();
    const resumedSession = sessions.find((s) => s.loopId === loopId);
    assert.ok(resumedSession, "resumed session must appear in list");

    // Resume to get the prompt
    const result = await mgr.resume(loopId);
    assert.ok(result !== null, "resume must return a result");
    assert.ok(
      result!.round === roundBefore ||
      result!.round === roundBefore + 1,
      `resumed round (${result!.round}) should be near pre-crash round (${roundBefore})`,
    );
    assert.ok(
      typeof result!.prompt === "string" && result!.prompt!.length > 50,
      "resume must return a valid prompt",
    );

    // Update sessionId to the new one
    sessionId = result!.sessionId;
  });

  // ── Step 8: Verify loop is alive after backtrack ───────────────────────
  // The vault still holds the old flat-progress entries, so submitting
  // another round would re-trigger progress_stall. What matters is that
  // the backtrack completed successfully and the loop is still running.

  it("step 8 — session is still running after backtrack + crash recovery", async () => {
    const session = mgr.get(sessionId);
    assert.ok(session, "session must still exist after backtrack recovery");
    assert.equal(
      session!.status, "running",
      `session must be running, got ${session!.status}`,
    );

    // Verify the session list still includes this loop
    const sessions = mgr.list();
    const found = sessions.find((s) => s.loopId === loopId);
    assert.ok(found, "loop must appear in session list after backtrack recovery");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.7.1: Recovery Brief window — derived from the committed rollback
// decision (never from rejected payloads), rendered in the backtrack prompt
// and the state file's Recent tier, and gone once the redo commits.
// ═══════════════════════════════════════════════════════════════════════════
describe("E2E Recovery Brief window (v3.7.1)", () => {
  let storeDir: string;
  let mgr: SessionManager;
  let loopId = "";
  let statePath = "";
  let workspaceDir: string;
  let originalCwd: string;

  before(() => {
    resetPolicy();
    originalCwd = process.cwd();
    workspaceDir = initWorkspace();
    process.chdir(workspaceDir);
    storeDir = join(tmpdir(), `loopforge-recovery-brief-${randomUUID()}`);
    mgr = createSessionManager(storeDir);
  });

  after(() => {
    mgr.close();
    process.chdir(originalCwd);
    for (const dir of [storeDir, workspaceDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    try { rmSync(statePath, { force: true }); } catch { /* best effort */ }
  });

  it("start + flat rounds + backtrack carries brief facts and the state-file window", async () => {
    const created = await mgr.create({
      task: "Write unit tests for all public functions. Run npm test after each change.",
      maxRounds: 10,
      constraints: ["Do not skip tests", "Run npm test before claiming success"],
    });
    const sessionId = created.sessionId;
    const session = mgr.get(sessionId);
    assert.ok(session, "session must exist");
    loopId = session!.loopId;
    statePath = join(process.cwd(), ".loopforge", "state", `${loopId}-state.md`);
    rmSync(statePath, { force: true });

    for (const [round, files] of [
      [1, ["src/a.ts"]],
      [2, ["src/b.ts"]],
      [3, ["src/c.ts"]],
    ] as Array<[number, string[]]>) {
      const result = await mgr.advance(sessionId, `Round ${round} output`, stalledEval(round, 0.3, files));
      assert.ok(!result.enforcementAction || result.enforcementAction === "accept");
    }
    const first = await mgr.advance(sessionId, "Round 4 output", stalledEval(4, 0.3, ["src/d.ts"]));
    assert.equal(first.enforcementAction, "reject", "first stall must reject");
    const second = await mgr.advance(sessionId, "Round 4 retry — same stalled approach", stalledEval(4, 0.3, ["src/d.ts"]));
    assert.equal(second.enforcementAction, "backtrack", "second stall must backtrack");

    // Prompt brief + redo round ID (loop:<loopId>:round:4 — restore 3 + 1).
    assert.ok(second.prompt?.includes("### Recovery Brief"), "prompt carries the brief");
    assert.ok(second.prompt?.includes(`\`loop:${loopId}:round:4\``), "prompt carries the redo round ID");

    // The committed rollback decision retains the derived brief facts.
    const reader = new FileLoopStore(join(storeDir, ".loopforge"));
    const rollback = queryLoopEntries(reader, loopId, {
      prefix: `loop:${loopId}:r4`,
    }).filter((entry) => entry.task_type === "rollback_directive");
    assert.equal(rollback.length, 1, "round 4 holds the rollback directive event");
    const lineage = (rollback[0]?.loop_lineage ?? {}) as Record<string, unknown>;
    const tx = lineage.round_transaction as Record<string, unknown> | undefined;
    const result = (tx?.result ?? {}) as Record<string, unknown>;
    assert.equal(result.action, "backtrack");
    const recovery = result.recovery as Record<string, unknown>;
    assert.ok(Array.isArray(recovery.failed_rounds), "decision records failed rounds");
    assert.ok(
      (recovery.approaches as string[] | undefined)?.some(
        (a) => a.includes("Round 4: reviewed src/d.ts"),
      ),
      "decision records the failed approach (from the in-flight attempt — never a rejected payload)",
    );

    // State file (recovery window): Recent tier shows the brief.
    assert.ok(existsSync(statePath), "backtrack compile writes the state file");
    const during = readFileSync(statePath, "utf8");
    const idxRecent = during.indexOf("## Recent");
    const idxHistorical = during.indexOf("## Historical Summary");
    assert.ok(idxRecent >= 0 && idxHistorical > idxRecent, "state file is tiered");
    assert.ok(during.slice(idxRecent, idxHistorical).includes("### Recovery Brief"),
      "brief renders in the Recent tier during the window");
    assert.ok(during.includes(`**Source**: round 4`), "recovery compile marks its round");

    // v3.9.6: the restore point's machine snapshot lives in the committed
    // rollback directive, not in the session. A restart must read the same
    // event.
    const beforeEvent = mgr.replayRollbacks(loopId).at(-1)!;
    assert.equal(typeof beforeEvent.targetCheckpointId, "string",
      "the directive records the target checkpoint id");
    assert.equal(beforeEvent.redoRound, 4, "the directive records the redo round");
    const targetCheckpoint = beforeEvent.targetCheckpointId;
    mgr.close();
    mgr = createSessionManager(storeDir);
    assert.ok(mgr.autoResumeAll() >= 1, "the loop resumes after a restart");
    const resumedEvent = mgr.replayRollbacks(loopId).at(-1)!;
    assert.equal(resumedEvent.targetCheckpointId, targetCheckpoint,
      "the target checkpoint survives a restart");

    // Redo with the same held identity is evaluated and accepted. The redo is
    // ordinary work: it must move the machine boundary, not just re-submit.
    const redoFile = "lf-redo-evidence.txt";
    writeFileSync(join(process.cwd(), redoFile), "redo evidence\n");
    const heldRedo = mgr.get(sessionId)!.roundSnapshot!;
    const redo = await mgr.advance(
      sessionId, "Redo: root cause fixed, tests pass.",
      fixedEval(4, [redoFile]), heldRedo.roundId, heldRedo.transactionId,
    ).finally(() => {
      try { rmSync(join(process.cwd(), redoFile), { force: true }); } catch { /* best effort */ }
    });
    assert.ok(!redo.enforcementAction || redo.enforcementAction === "accept",
      `redo must be accepted, got ${redo.enforcementAction ?? "accept"} (reason: ${redo.enforcementReason ?? "none"})`);
    assert.equal(redo.round, 5);

    // The redo consumed the pending recovery; the directive remains history.
    assert.equal(mgr.getSubmissionGuidance(sessionId)?.recovery ?? null, null,
      "no recovery checkpoint is pending after the redo commits");

    // After the redo commits the rollback record is replaced — the brief
    // exits the projection by construction.
    const afterRedo = readFileSync(statePath, "utf8");
    assert.ok(!afterRedo.includes("Recovery Brief"),
      "brief disappears once the redo round commits");
  });
});
