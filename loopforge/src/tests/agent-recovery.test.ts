/** v3.9.6 — Agent-initiated recovery: target validation, directive commit,
 *  branch fencing and the restore checkpoint. */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopForgeEngine } from "../engine.js";
import { SessionManager } from "../mcp/session.js";
import { VaultSessionStateStore } from "../storage.js";
import { queryLoopEntries } from "../loop-store.js";
import { resetPolicy } from "../policy.js";
import { policyMetrics, resetPolicyMetrics } from "../policy-metrics.js";
import { MemoryLoopStore, committedFeedbackRound, deltaAfter } from "./_helpers.js";
import type { GitObservation } from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";
import {
  RoundTransactionCoordinator,
  deriveTransactionId,
  prepareRoundTransaction,
  rootBranchId,
} from "../round-transaction.js";
import {
  decodeCommittedRound,
  pendingRollbackDirective,
  readOnlyRollbacks,
  readOnlyRounds,
} from "../committed-round.js";
import { deriveCommittedSubmissionView } from "../submission-receipt.js";
import {
  deriveRecoveryDirective,
  resolveRecoveryTarget,
  verifyRecoveryCheckpoint,
} from "../recovery.js";

const LOOP = "recovery-test";

function git(
  phase: "before" | "after",
  head: string,
  files: string[] = [],
): GitObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files,
    data: {
      dirty: files,
      fingerprints: Object.fromEntries(files.map((file) => [file, "m:1"])),
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

function targetRound(): VaultEntry {
  return committedFeedbackRound(1, {
    loopId: LOOP,
    success: true,
    roundEvidence: [git("after", "target-head", [])],
  });
}

function abandonedRound(): VaultEntry {
  return committedFeedbackRound(2, {
    loopId: LOOP,
    success: false,
    files: ["src/abandoned.ts"],
    roundEvidence: [git("after", "abandoned-head", ["src/abandoned.ts"])],
  });
}

describe("v3.9.6 — agent recovery", () => {
  it("resolves a committed target with an observed restore point", () => {
    const entries = [targetRound(), abandonedRound()];
    const resolved = resolveRecoveryTarget(entries, 3, 1);
    assert.ok(resolved.ok);
    assert.equal(resolved.target.head, "target-head");
    assert.deepEqual(resolved.target.dirty, []);
    assert.equal(resolved.target.view.transactionId, `tx-${LOOP}-1-1`);
  });

  it("rejects a future, rollback, or unobserved target without side effects", () => {
    const entries = [targetRound(), abandonedRound()];
    const future = resolveRecoveryTarget(entries, 3, 3);
    assert.equal(future.ok, false);
    if (!future.ok) assert.equal(future.reason, "target_out_of_range");

    const unobserved = committedFeedbackRound(2, {
      loopId: LOOP,
      success: true,
      roundEvidence: [],
    });
    const missing = resolveRecoveryTarget([targetRound(), unobserved], 3, 2);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "restore_point_unobserved");
  });

  it("commits a rollback event, fences the branch and stays idempotent", () => {
    const store = new MemoryLoopStore();
    const engine = new LoopForgeEngine(store);
    const entries = [targetRound(), abandonedRound()];
    for (const entry of entries) store.appendEntry(entry);

    const held = prepareRoundTransaction(
      LOOP,
      3,
      [],
      undefined,
      { branchId: rootBranchId(LOOP) },
    );
    const resolved = resolveRecoveryTarget(entries, 3, 1);
    assert.ok(resolved.ok);
    const transactionId = deriveTransactionId({
      kind: "rollback",
      branchId: rootBranchId(LOOP),
      roundId: held.roundId,
      attempt: 1,
      recovery: {
        target: 1,
        reason: "Try the other approach",
        target_transaction_id: resolved.target.view.transactionId ?? "",
      },
    });
    const after = [git("after", "abandoned-head", ["src/abandoned.ts"])];
    const recovery = deriveRecoveryDirective({
      origin: "agent",
      reason: "Try the other approach",
      transactionId,
      target: resolved.target,
      abandonedRounds: readOnlyRounds(entries).filter((view) =>
        view.round > resolved.target.view.round && view.round < 3),
      currentRound: 3,
      beforeEvidence: [],
      afterEvidence: after,
    });
    const coordinator = new RoundTransactionCoordinator(engine, store);
    const first = coordinator.commitRecovery({
      snapshot: held,
      loopId: LOOP,
      recovery,
      actualEvidence: after,
    });
    assert.equal(first.result.action, "recovery");
    assert.equal(first.result.origin, "agent");
    assert.equal(first.result.recovery?.target, 1);

    const committed = store.listEntries(LOOP);
    const events = readOnlyRollbacks(committed);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.origin, "agent");
    assert.equal(events[0]!.recovery?.reason, "Try the other approach");
    assert.deepEqual(readOnlyRounds(committed).map((view) => view.round), [1]);
    assert.equal(pendingRollbackDirective(committed, 2)?.round, 3);

    // The committed directive is the redo's checkpoint fact, both live and
    // rebuilt after the child round commits.
    const redoEntry = committedFeedbackRound(2, {
      loopId: LOOP,
      branchId: events[0]!.recovery!.transaction_id,
      success: true,
      roundEvidence: [git("after", "target-head", [])],
    });
    const redo = decodeCommittedRound(redoEntry);
    assert.ok(redo);
    const receipt = deriveCommittedSubmissionView(redo!, [redo!], events);
    assert.deepEqual(receipt.recovery_checkpoint, {
      restore_point: 1,
      origin: "agent",
      reason: "Try the other approach",
      verified: true,
    });

    const second = coordinator.commitRecovery({
      snapshot: held,
      loopId: LOOP,
      recovery,
      actualEvidence: after,
    });
    assert.equal(second.replayed, true, "the same transactionId is idempotent");
  });

  it("fails the restore checkpoint closed on an unknown or unrestored boundary", () => {
    const directive = {
      origin: "agent" as const,
      reason: "abandon",
      target: 1,
      target_round_id: "loop:recovery-test:round:1",
      target_transaction_id: "tx-recovery-test-1-1",
      target_head: "target-head",
      target_dirty: [],
      skipped_files: ["src/abandoned.ts"],
      skipped_fingerprints: { "src/abandoned.ts": "m:1" },
      skipped_discoveries: [],
      failed_rounds: [2],
      approaches: [],
      wrong_assumptions: [],
      transaction_id: "tx-rollback",
    };
    assert.deepEqual(
      verifyRecoveryCheckpoint({
        directive,
        beforeEvidence: [],
        evidenceDeltas: [],
      }).ok,
      false,
      "unknown Git is not a pass",
    );

    const wrongHead = deltaAfter(git("after", "wrong-head", []), []);
    assert.equal(
      verifyRecoveryCheckpoint({
        directive,
        beforeEvidence: [],
        evidenceDeltas: [wrongHead],
      }).ok,
      false,
    );

    const restored = deltaAfter(git("after", "target-head", []), []);
    assert.deepEqual(
      verifyRecoveryCheckpoint({
        directive,
        beforeEvidence: [],
        evidenceDeltas: [restored],
      }),
      { ok: true },
    );
  });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "lf-recovery",
  GIT_AUTHOR_EMAIL: "lf-recovery@example.invalid",
  GIT_COMMITTER_NAME: "lf-recovery",
  GIT_COMMITTER_EMAIL: "lf-recovery@example.invalid",
};

function runGit(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepo(dir: string): void {
  runGit(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), ".loopforge/\n");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  runGit(dir, "add", ".");
  runGit(dir, "commit", "-q", "-m", "baseline");
}

function roundEvaluation(file: string): Record<string, unknown> {
  return {
    success: false,
    output_summary: `Worked on ${file}.`,
    constraint_violations: [],
    should_continue: true,
    execution_report: {
      files_changed: [file],
      tests_reported: { passed: 0, failed: 0, skipped: 0 },
    },
  };
}

describe("v3.9.6 — SessionManager agent recovery E2E", () => {
  let dir = "";
  let originalCwd = "";

  beforeEach(() => {
    resetPolicy();
    resetPolicyMetrics();
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "loopforge-recover-e2e-"));
    initRepo(dir);
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // The platform temp directory owns the cleanup.
    }
    resetPolicy();
    resetPolicyMetrics();
  });

  it("commits a valid target, keeps invalid targets side-effect free, and replays idempotently", async () => {
    const store = new MemoryLoopStore();
    const sessionStore = new VaultSessionStateStore(store);
    const mgr = new SessionManager(store, sessionStore);
    const readEntries = () => [
      ...queryLoopEntries(store, "recover-e2e", {
        prefix: "loop:recover-e2e:",
      }),
      ...queryLoopEntries(store, "recover-e2e", {
        prefix: "loop:recover-e2e:",
        feedbackOnly: true,
      }),
    ];
    try {
      const started = await mgr.create({
        task: "Recover the branch",
        loopId: "recover-e2e",
        maxRounds: 10,
      });
      const sessionId = String(started.sessionId);

      writeFileSync(join(dir, "r1.txt"), "round one\n");
      runGit(dir, "add", ".");
      runGit(dir, "commit", "-q", "-m", "round 1 work");
      const round1 = await mgr.advance(
        sessionId,
        "",
        roundEvaluation("r1.txt"),
        started.roundId,
      );
      assert.equal(round1.round, 2);
      assert.ok(round1.prompt, "round 2 prompt is delivered");

      writeFileSync(join(dir, "r2.txt"), "round two\n");
      runGit(dir, "add", ".");
      runGit(dir, "commit", "-q", "-m", "round 2 work");
      const round2 = await mgr.advance(
        sessionId,
        "",
        roundEvaluation("r2.txt"),
        round1.roundId,
      );
      assert.equal(round2.round, 3);
      assert.ok(round2.prompt, "round 3 prompt is delivered");

      const sessionBefore = JSON.stringify(sessionStore.load("recover-e2e"));
      const entriesBefore = readEntries();
      const rollbacksBefore = readOnlyRollbacks(entriesBefore).length;
      const roundsBefore = readOnlyRounds(entriesBefore).map((view) => view.round);
      const roundBefore = mgr.get(sessionId)?.currentRound;
      const rejectionsBefore = mgr.get(sessionId)?.consecutiveRejections;
      const metricsBefore = JSON.stringify(policyMetrics.snapshot("recover-e2e"));

      const invalid = await mgr.recover(
        sessionId,
        { target_round: 99, reason: "not a real target" },
        round2.roundId,
      );
      assert.equal(invalid.submissionError?.code, "recovery_invalid");
      assert.equal(
        invalid.submissionError?.details.reason_code,
        "target_out_of_range",
      );
      assert.equal(
        JSON.stringify(sessionStore.load("recover-e2e")),
        sessionBefore,
        "an invalid target must not write the session document",
      );
      const entriesAfterInvalid = readEntries();
      assert.equal(readOnlyRollbacks(entriesAfterInvalid).length, rollbacksBefore);
      assert.deepEqual(
        readOnlyRounds(entriesAfterInvalid).map((view) => view.round),
        roundsBefore,
      );
      assert.equal(mgr.get(sessionId)?.currentRound, roundBefore);
      assert.equal(mgr.get(sessionId)?.consecutiveRejections, rejectionsBefore);
      assert.equal(
        JSON.stringify(policyMetrics.snapshot("recover-e2e")),
        metricsBefore,
      );

      const redo = await mgr.recover(
        sessionId,
        { target_round: 1, reason: "abandon this approach" },
        round2.roundId,
      );
      assert.ok(redo.prompt, "the redo prompt is delivered");
      assert.equal(redo.round, 2, "the redo targets restore point + 1");
      assert.equal(redo.enforcementAction, "recovery");
      assert.equal(redo.recovery?.origin, "agent");
      assert.equal(redo.recovery?.target_round, 1);
      assert.equal(redo.recovery?.reason, "abandon this approach");

      const committed = readEntries();
      const rollbacks = readOnlyRollbacks(committed);
      assert.equal(rollbacks.length, 1);
      assert.equal(rollbacks[0]!.origin, "agent");
      assert.equal(rollbacks[0]!.recovery?.target, 1);
      assert.equal(rollbacks[0]!.recovery?.reason, "abandon this approach");
      assert.deepEqual(
        readOnlyRounds(committed).map((view) => view.round),
        [1],
        "the abandoned branch leaves the effective history",
      );
      assert.equal(pendingRollbackDirective(committed, 2)?.origin, "agent");

      // A repeated recovery while the checkpoint is pending returns the held
      // prompt and never commits a second directive.
      const repeat = await mgr.recover(
        sessionId,
        { target_round: 1, reason: "repeat the request" },
        redo.roundId,
      );
      assert.ok(repeat.prompt);
      assert.equal(repeat.round, 2);
      assert.equal(
        readOnlyRollbacks(readEntries()).length,
        1,
      );

      // Crash/restart: the committed directive and the redo cursor survive.
      mgr.close();
      const restarted = new SessionManager(store, new VaultSessionStateStore(store));
      const resumed = await restarted.resume("recover-e2e");
      assert.ok(resumed?.prompt, "resume returns the held redo prompt");
      assert.equal(resumed?.round, 2);
      const replay = await restarted.recover(
        String(resumed!.sessionId),
        { target_round: 1, reason: "after restart" },
        redo.roundId,
      );
      assert.ok(replay.prompt);
      assert.equal(replay.round, 2);
      assert.equal(
        readOnlyRollbacks(readEntries()).length,
        1,
      );
      restarted.close();
    } finally {
      mgr.close();
    }
  });
});
