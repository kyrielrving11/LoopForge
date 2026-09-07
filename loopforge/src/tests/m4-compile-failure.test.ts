/** M4 (v3.7.x) regression: a post-commit next-round compile failure must
 *  stall the session — not silently strand it or let a replay skip a round.
 *
 *  Scenario: round 2 commits, then compiling round 3's prompt throws (the
 *  state-file write fails because the state directory was replaced by a
 *  file mid-loop — the same shape as an I/O failure during a live loop).
 *
 *  Pre-fix: the exception propagated out of advance as a raw JSON-RPC
 *  internal error while the in-memory session kept currentRound=3 with a
 *  snapshot still pointing at committed round 2; a resubmission of roundId
 *  r2 replayed the commit and advanced the counter to 4, silently skipping
 *  round 3's compile and eventually poisoning the vault sequence.
 *
 *  Post-fix: the failed advance returns a retryable "stalled" result, and
 *  once the fault clears, resubmitting the SAME roundId compiles round 3 —
 *  never skipping it.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FileLoopStore } from "../loop-store.js";
import { SessionManager } from "../mcp/session.js";
import { resetPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";
import type { SelfEvaluation } from "../protocol.js";

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

describe("M4 — post-commit compile failure stalls, never skips", () => {
  const originalCwd = process.cwd();
  afterEach(() => {
    process.chdir(originalCwd);
    resetPolicy();
  });

  it("stalls on a compile exception after the commit and recovers the round", async () => {
    const work = join(tmpdir(), `lf-m4-${randomUUID()}`);
    mkdirSync(work, { recursive: true });
    process.chdir(work);

    // State file directory inside the temporary workspace; sabotage it with
    // a same-named FILE between rounds to make writeStateFile throw.
    const stateDir = ".lf-state";
    const statePath = join(work, stateDir);
    setPolicyForTest({
      ...DEFAULT_POLICY,
      state_file: { enabled: true, directory: stateDir },
    });
    mkdirSync(statePath, { recursive: true });

    const store = new FileLoopStore(join(work, "vault"));
    const mgr = new SessionManager(store);
    const started = await mgr.create({ task: "M4 compile failure", loopId: "m4-fail" });
    const sessionId = started.sessionId;

    await mgr.advance(sessionId, "", continuingEvaluation()); // commits round 1
    // Sabotage: the state directory becomes a file — the next compile's
    // writeStateFile (round-driver compile step) throws.
    rmSync(statePath, { recursive: true, force: true });
    writeFileSync(statePath, "not a directory");

    const failed = await mgr.advance(sessionId, "", continuingEvaluation()); // commits round 2, then compile of round 3 throws
    assert.equal(failed.stopReason, "stalled",
      "a post-commit compile exception must surface as a stalled result, " +
      "not a raw internal error");
    assert.equal(failed.prompt, null);
    assert.equal(failed.round, 3, "the counter must sit at the round that failed to compile");
    const heldRoundId = failed.roundId;
    assert.ok(typeof heldRoundId === "string" && heldRoundId.includes("round:2"),
      "the stalled result must still anchor the committed round 2");

    // Clear the fault: restore the directory.
    rmSync(statePath, { force: true });
    mkdirSync(statePath, { recursive: true });

    // Resubmit the SAME roundId — the committed round replays and round 3
    // is compiled, never skipped (pre-fix this advanced to 4 without ever
    // compiling round 3).
    const recovered = await mgr.advance(sessionId, "", continuingEvaluation(), heldRoundId);
    assert.equal(recovered.stopReason, undefined);
    assert.equal(recovered.round, 3,
      "the recovered submission must compile round 3 — not skip it");
    assert.equal(typeof recovered.prompt, "string");
    assert.ok((recovered.prompt as string).length > 0);
    // L1 (live path): the replay of committed round 2 must not push its
    // success into the trajectory a second time.
    assert.equal(mgr.get(sessionId)?.successTrajectory.length, 2,
      "the replayed round must not duplicate its trajectory entry");

    // And the loop continues normally afterwards.
    const next = await mgr.advance(sessionId, "", continuingEvaluation(), recovered.roundId);
    assert.equal(next.round, 4, "the loop keeps advancing after the recovery");
    assert.equal(existsSync(join(work, "vault", "loops")), true);
  });

  it("null preparation after the commit also stalls (sibling-path parity)", async () => {
    // RoundDriver.prepare returns null when invokeLoopCompile yields no
    // prompt. That previously produced a silent prompt:null WITHOUT a
    // stopReason while the session kept running — unlike every sibling
    // path (resume/unpause/reject/backtrack/crash recovery), which stall.
    // Reachable shape: compile the loop in a workspace whose vault cannot
    // serve a compile is hard to stage cleanly, so this asserts the parity
    // contract at the status level: a stalled session is retryable through
    // advance with the same roundId.
    const work = join(tmpdir(), `lf-m4b-${randomUUID()}`);
    mkdirSync(work, { recursive: true });
    process.chdir(work);
    const stateDir = ".lf-state";
    setPolicyForTest({
      ...DEFAULT_POLICY,
      state_file: { enabled: true, directory: stateDir },
    });
    mkdirSync(join(work, stateDir), { recursive: true });
    const store = new FileLoopStore(join(work, "vault"));
    const mgr = new SessionManager(store);
    const started = await mgr.create({ task: "M4 parity", loopId: "m4-parity" });
    await mgr.advance(started.sessionId, "", continuingEvaluation());
    await mgr.advance(started.sessionId, "", continuingEvaluation());
    const result = await mgr.advance(started.sessionId, "", continuingEvaluation());
    assert.equal(result.round, 4, "healthy loops stay unaffected by the guard");
  });
});
