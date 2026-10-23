/** v3.9.7 — a restore that fails after the directive is committed must stay
 *  pending, persist `stalled`, and be retried idempotently after a restart.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../mcp/session.js";
import { FileLoopStore } from "../loop-store.js";
import { FileWorkspaceCheckpointStore } from "../workspace-checkpoint.js";
import { resetPolicy } from "../policy.js";
import { readOnlyRollbacks } from "../committed-round.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "lf-failure",
  GIT_AUTHOR_EMAIL: "lf-failure@example.invalid",
  GIT_COMMITTER_NAME: "lf-failure",
  GIT_COMMITTER_EMAIL: "lf-failure@example.invalid",
};

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function flatEvaluation() {
  return {
    success: false,
    output_summary: "no change",
    constraint_violations: [],
    should_continue: true,
    execution_report: {
      files_changed: [] as string[],
      tests_reported: { passed: 0, failed: 0, skipped: 0 },
    },
  };
}

describe("v3.9.7 — failed restore stays pending and resumes", () => {
  let workspace = "";
  let storeDir = "";
  let originalCwd = "";

  beforeEach(() => {
    resetPolicy();
    originalCwd = process.cwd();
    workspace = mkdtempSync(join(tmpdir(), "lf-restore-failure-ws-"));
    storeDir = mkdtempSync(join(tmpdir(), "lf-restore-failure-store-"));
    process.chdir(workspace);
    git(workspace, "init", "-q");
    writeFileSync(join(workspace, ".gitignore"), ".loopforge/\n");
    writeFileSync(join(workspace, "baseline.txt"), "baseline\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-q", "-m", "baseline");
    // A pre-existing untracked work-in-progress file makes every before-image
    // carry content, including the machine backtrack target.
    writeFileSync(join(workspace, "precious.txt"), "precious\n");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const path of [workspace, storeDir]) {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        // Platform temp cleanup is the backstop.
      }
    }
    resetPolicy();
  });

  it("keeps the directive pending, stalls, then completes after the blob is restored", async () => {
    const fileStore = new FileLoopStore(join(storeDir, ".loopforge"));
    const checkpointStoreFor = (loopId: string): FileWorkspaceCheckpointStore =>
      new FileWorkspaceCheckpointStore(fileStore.loopDir(loopId), loopId);
    let mgr = new SessionManager(fileStore, undefined, checkpointStoreFor);
    const loopId = "restore-failure";
    try {
      const started = await mgr.create({ task: "Recover after a failed restore", loopId, maxRounds: 20 });
      const sessionId = String(started.sessionId);
      let held = mgr.get(sessionId)!.roundSnapshot!;

      // Three flat committed rounds build the stall window.
      for (let round = 1; round <= 3; round++) {
        const result = await mgr.advance(
          sessionId, "", flatEvaluation(), held.roundId, held.transactionId,
        );
        assert.ok(result.prompt, `round ${round} must advance`);
        held = mgr.get(sessionId)!.roundSnapshot!;
      }

      // First round-4 submission: progress-stall reject.
      const rejected = await mgr.advance(
        sessionId, "", flatEvaluation(), held.roundId, held.transactionId,
      );
      assert.equal(rejected.enforcementAction, "reject");
      held = mgr.get(sessionId)!.roundSnapshot!;
      const targetRef = held.beforeCheckpoint!;
      assert.ok(targetRef, "round 4 has a before-image");

      const store = checkpointStoreFor(loopId);
      const manifest = store.readManifest(targetRef.checkpointId);
      assert.ok(manifest);
      const fingerprint = manifest.fingerprints["precious.txt"];
      assert.match(fingerprint, /^\d+:[a-f0-9]{64}$/);
      const hash = fingerprint.split(":")[1]!;
      const blob = store.blobPath(hash);
      const content = readFileSync(blob);
      rmSync(blob);

      // Second round-4 submission: machine backtrack. The directive commits,
      // but the post-commit preflight cannot read the target content.
      const failed = await mgr.advance(
        sessionId, "", flatEvaluation(), held.roundId, held.transactionId,
      );
      assert.equal(failed.enforcementAction, "backtrack");
      assert.equal(failed.prompt, null, "no redo prompt is issued without a verified restore");
      assert.equal(failed.stopReason, "stalled");
      assert.equal(failed.submissionError?.code, "restore_failed");
      assert.equal(failed.submissionError?.details.reason_code, "blob_missing");
      assert.equal(mgr.get(sessionId)!.status, "stalled");
      assert.equal(mgr.get(sessionId)!.roundSnapshot, undefined);
      assert.equal(mgr.get(sessionId)!.currentRound, 4);

      mgr.close();
      // Simulate repairing the content store outside the process.
      writeFileSync(blob, content);

      mgr = new SessionManager(fileStore, undefined, checkpointStoreFor);
      const resumed = await mgr.resume(loopId);
      assert.ok(resumed?.prompt, "resume retries the same directive and restores");
      assert.equal(resumed?.round, 4);
      assert.equal(resumed?.recovery?.target_checkpoint_id, targetRef.checkpointId);
      assert.equal(resumed?.recovery?.redo_round, 4);
      assert.equal(
        mgr.get(resumed!.sessionId)!.status,
        "running",
        "a completed retry returns the session to running",
      );
      assert.equal(readOnlyRollbacks(fileStore.listEntries(loopId)).length, 1,
        "resume never commits a second directive");
    } finally {
      mgr.close();
    }
  });
});
