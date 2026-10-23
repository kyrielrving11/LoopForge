/** v3.9.7 — checkpoint selection, manifest binding, and deterministic restore. */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointForRoundBoundary,
  deriveRecoveryDirective,
  findCheckpointRef,
  validateCheckpointManifest,
} from "../recovery.js";
import type { CheckpointRef, MachineObservation } from "../protocol.js";
import { prepareRoundTransaction, rootBranchId } from "../round-transaction.js";
import {
  FileWorkspaceCheckpointStore,
} from "../workspace-checkpoint.js";
import {
  executeRestore,
  preflightRestore,
} from "../workspace-restore.js";
import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import { VaultSessionStateStore } from "../storage.js";
import { queryLoopEntries } from "../loop-store.js";
import { resetPolicy } from "../policy.js";
import { MemoryLoopStore } from "./_helpers.js";
import { advanceWithHeld } from "./_helpers.js";
import {
  pendingRollbackDirective,
  readOnlyRollbacks,
  readOnlyRounds,
} from "../committed-round.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "lf-checkpoint",
  GIT_AUTHOR_EMAIL: "lf-checkpoint@example.invalid",
  GIT_COMMITTER_NAME: "lf-checkpoint",
  GIT_COMMITTER_EMAIL: "lf-checkpoint@example.invalid",
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

function gitObservation(fingerprints: Record<string, string>): MachineObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files: [],
    data: {
      dirty: [],
      fingerprints,
      head: "head",
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

function ref(input: {
  id?: string;
  round?: number;
  role?: "before" | "mid";
  transactionId?: string;
} = {}): CheckpointRef {
  const round = input.round ?? 1;
  return {
    checkpointId: input.id ?? `ck-${"a".repeat(24)}`,
    contentHash: "a".repeat(64),
    role: input.role ?? "before",
    round,
    roundId: `loop:test:round:${round}`,
    transactionId: input.transactionId ?? "tx-test-1",
    branchId: rootBranchId("test"),
    redoRound: round,
    createdAt: 0,
  };
}

describe("v3.9.7 — checkpoint selection predicates", () => {
  it("finds a held before-image and ignores an unknown id", () => {
    const held = {
      ...prepareRoundTransaction("test", 1, []),
      beforeCheckpoint: ref(),
    };
    const found = findCheckpointRef({
      entries: [],
      held,
      checkpointId: held.beforeCheckpoint.checkpointId,
    });
    assert.equal(found.ok, true);
    if (found.ok) assert.equal(found.ref.role, "before");

    const missing = findCheckpointRef({
      entries: [],
      held,
      checkpointId: `ck-${"b".repeat(24)}`,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "target_not_visible");
  });

  it("rejects a manifest that does not match its transaction ref", () => {
    const checkpointRef = ref();
    const manifest = {
      schemaVersion: 1 as const,
      checkpointId: checkpointRef.checkpointId,
      loopId: "test",
      round: checkpointRef.round,
      role: checkpointRef.role,
      createdAt: 0,
      dirty: ["a.ts"],
      fingerprints: { "a.ts": "m:1" },
      contents: ["a.ts"],
      coverage: "tracked_and_non_ignored_untracked" as const,
      contentHash: checkpointRef.contentHash,
    };
    assert.equal(validateCheckpointManifest(checkpointRef, manifest).ok, true);
    assert.equal(
      validateCheckpointManifest(checkpointRef, {
        ...manifest,
        contentHash: "b".repeat(64),
      }).ok,
      false,
    );
    assert.equal(
      validateCheckpointManifest(checkpointRef, {
        ...manifest,
        round: checkpointRef.round + 1,
      }).ok,
      false,
    );
  });

  it("maps a round boundary to the before-image of its redo round", () => {
    const heldRef = ref({ round: 3, transactionId: "tx-3" });
    assert.equal(
      checkpointForRoundBoundary({
        entries: [],
        heldRound: 3,
        heldBeforeCheckpoint: heldRef,
        redoRound: 3,
      })?.checkpointId,
      heldRef.checkpointId,
    );
    assert.equal(
      checkpointForRoundBoundary({
        entries: [],
        heldRound: 4,
        heldBeforeCheckpoint: ref({ round: 4, transactionId: "tx-4" }),
        redoRound: 3,
      }),
      null,
      "a committed boundary with no committed view is not materialized",
    );
  });

  it("derives skipped files from the target manifest vs. the current boundary", () => {
    const targetRef = ref({ round: 2 });
    const directive = deriveRecoveryDirective({
      origin: "agent",
      reason: "try another approach",
      transactionId: "tx-rollback",
      targetRef,
      targetManifest: {
        schemaVersion: 1,
        checkpointId: targetRef.checkpointId,
        loopId: "test",
        round: 2,
        role: "before",
        createdAt: 0,
        head: "head",
        dirty: [],
        fingerprints: { "a.ts": "mode:1", "keep.ts": "mode:2" },
        contents: [],
        coverage: "tracked_and_non_ignored_untracked",
        contentHash: targetRef.contentHash,
      },
      abandonedRounds: [],
      currentAfterEvidence: [gitObservation({
        "a.ts": "mode:changed",
        "keep.ts": "mode:2",
        "new.ts": "mode:new",
      })],
    });
    assert.deepEqual(directive.skipped_files, ["a.ts", "new.ts"]);
    assert.equal(directive.target.redo_round, 2);
    assert.equal(directive.target.checkpoint_id, targetRef.checkpointId);
  });
});

describe("v3.9.7 — FileWorkspaceCheckpointStore + restore executor", () => {
  let dir = "";
  let originalCwd = "";

  beforeEach(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "loopforge-checkpoint-"));
    initRepo(dir);
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // The platform temp directory owns cleanup.
    }
  });

  it("captures dirty content, preflights it, and restores it exactly", async () => {
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    const store = new FileWorkspaceCheckpointStore(
      join(dir, ".loopforge", "loops", "test"),
      "test",
    );
    const manifest = await store.capture({
      round: 1,
      role: "before",
      cwd: dir,
      exclude: (path) => path.includes(".loopforge"),
    });
    assert.equal(manifest.round, 1);
    assert.equal(manifest.role, "before");
    assert.ok(manifest.fingerprints["a.ts"]);
    assert.deepEqual(manifest.contents, ["a.ts"]);
    const persisted = store.readManifest(manifest.checkpointId);
    assert.ok(persisted);
    assert.equal(persisted.contentHash, manifest.contentHash);

    const preflight = await preflightRestore({
      manifest,
      workspace: dir,
      store,
      stateDir: join(dir, ".loopforge"),
      exclude: (path) => path.includes(".loopforge"),
    });
    assert.equal(preflight.currentHead, manifest.head);

    writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
    writeFileSync(join(dir, "scratch.txt"), "to be deleted\n");
    const restored = await executeRestore({
      manifest,
      workspace: dir,
      store,
      directiveTransactionId: "tx-rollback-test",
      stateDir: join(dir, ".loopforge"),
      exclude: (path) => path.includes(".loopforge"),
    });
    assert.equal(restored.status, "verified");
    assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "export const a = 2;\n");
    assert.throws(
      () => readFileSync(join(dir, "scratch.txt"), "utf8"),
      "an untracked file absent from the target is deleted",
    );
    assert.equal(restored.filesDeleted, 1);
  });
});

describe("v3.9.7 — SessionManager checkpoint recovery E2E", () => {
  let dir = "";
  let storeRoot = "";
  let originalCwd = "";

  beforeEach(() => {
    resetPolicy();
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "loopforge-recover-e2e-"));
    storeRoot = mkdtempSync(join(tmpdir(), "loopforge-recover-store-"));
    initRepo(dir);
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const path of [dir, storeRoot]) {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        // The platform temp directory owns cleanup.
      }
    }
    resetPolicy();
  });

  it("creates a mid checkpoint, rejects a stale transaction, restores, and survives a restart", async () => {
    const store = new MemoryLoopStore();
    const sessionStore = new VaultSessionStateStore(store);
    const checkpointStoreFor = (loopId: string): FileWorkspaceCheckpointStore =>
      new FileWorkspaceCheckpointStore(join(storeRoot, loopId), loopId);
    let mgr = new SessionManager(store, sessionStore, checkpointStoreFor);
    const readEntries = () => [
      ...queryLoopEntries(store, "recover-e2e", { prefix: "loop:recover-e2e:" }),
      ...queryLoopEntries(store, "recover-e2e", {
        prefix: "loop:recover-e2e:",
        feedbackOnly: true,
      }),
    ];
    const evaluation = (file: string) => ({
      success: false,
      output_summary: `worked on ${file}`,
      constraint_violations: [],
      should_continue: true,
      execution_report: {
        files_changed: [file],
        tests_reported: { passed: 0, failed: 0, skipped: 0 },
      },
    });
    try {
      const started = await mgr.create({
        task: "Recover through a checkpoint",
        loopId: "recover-e2e",
        maxRounds: 10,
      });
      const sessionId = String(started.sessionId);
      assert.ok(started.transactionId, "start returns a transactionId");
      assert.equal(started.checkpoints?.length, 1, "start holds its before-image");

      const mid = await TOOL_HANDLERS.loopforge_checkpoint(mgr, {
        sessionId,
        roundId: started.roundId,
        transactionId: started.transactionId,
      });
      assert.equal(mid.ok, true, `checkpoint tool failed: ${JSON.stringify(mid)}`);
      assert.equal(mid.role, "mid");
      assert.match(String(mid.checkpointId), /^ck-[a-f0-9]{24}$/);

      const status = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
      assert.equal(status.transactionId, started.transactionId);
      assert.equal((status.checkpoints as unknown[]).length, 2,
        "status returns the before-image and the explicit savepoint");

      writeFileSync(join(dir, "r1.txt"), "round one\n");
      runGit(dir, "add", ".");
      runGit(dir, "-c", "user.name=lf", "-c", "user.email=lf@example.invalid",
        "commit", "-q", "-m", "round one");
      const round1 = await advanceWithHeld(mgr, 
        sessionId, "", evaluation("r1.txt"), started.roundId, started.transactionId,
      );
      assert.ok(round1.prompt, "round 2 prompt");
      const round2Before = round1.checkpoints?.find((item) => item.role === "before");
      assert.ok(round2Before, "round 2 has a before-image");

      writeFileSync(join(dir, "r2.txt"), "round two\n");
      runGit(dir, "add", ".");
      runGit(dir, "-c", "user.name=lf", "-c", "user.email=lf@example.invalid",
        "commit", "-q", "-m", "round two");
      const round2 = await advanceWithHeld(mgr, 
        sessionId, "", evaluation("r2.txt"), round1.roundId, round1.transactionId,
      );
      assert.ok(round2.prompt, "round 3 prompt");
      const held = mgr.get(sessionId)!.roundSnapshot!;

      const stale = await advanceWithHeld(mgr, 
        sessionId, "", evaluation("r2.txt"), held.roundId, "tx-stale-attempt",
      );
      assert.ok(stale.prompt, "a stale transaction returns the held prompt");
      assert.ok(
        (stale.warnings ?? []).some((warning) => warning.includes("transactionId")),
        "the stale response is warned, not evaluated",
      );
      assert.equal(mgr.get(sessionId)!.currentRound, 3, "no round was consumed");

      const redo = await mgr.recover(
        sessionId,
        { target_checkpoint_id: round2Before.checkpointId, reason: "abandon this approach" },
        held.roundId,
        held.transactionId,
      );
      assert.ok(redo.prompt, "the redo prompt is delivered only after restore");
      assert.equal(redo.round, 2);
      assert.equal(redo.recovery?.target_checkpoint_id, round2Before.checkpointId);
      assert.equal(redo.recovery?.redo_round, 2);
      assert.equal(
        redo.submission_guidance?.recovery?.pending,
        true,
        "guidance exposes the pending recovery facts",
      );
      assert.equal(existsSync(join(dir, "r2.txt")), false,
        "the abandoned round's file was removed by the restore");
      assert.deepEqual(readOnlyRounds(readEntries()).map((view) => view.round), [1]);
      const directive = readOnlyRollbacks(readEntries())[0]!;
      assert.equal(directive.origin, "agent");
      assert.equal(pendingRollbackDirective(readEntries())?.origin, "agent");
      assert.equal(
        mgr.get(sessionId)!.roundSnapshot?.branchId,
        directive.transactionId,
        "the redo transaction lives on the directive's child branch",
      );

      const repeat = await mgr.recover(
        sessionId,
        { target_checkpoint_id: round2Before.checkpointId, reason: "repeat" },
        redo.roundId,
        redo.transactionId,
      );
      assert.ok(repeat.prompt, "a repeated recovery returns the held redo prompt");
      assert.equal(readOnlyRollbacks(readEntries()).length, 1,
        "no second directive is committed");

      mgr.close();
      mgr = new SessionManager(
        store,
        new VaultSessionStateStore(store),
        checkpointStoreFor,
      );
      const resumed = await mgr.resume("recover-e2e");
      assert.ok(resumed?.prompt, "resume returns the held redo prompt");
      assert.equal(resumed?.round, 2);
      assert.equal(resumed?.transactionId, redo.transactionId);
      assert.equal(resumed?.submission_guidance?.recovery?.pending, true,
        "the held redo keeps its recovery facts across a restart");
      assert.equal(
        mgr.get(resumed!.sessionId)!.operatorAcceptance?.task,
        "Recover through a checkpoint",
        "the operator acceptance cursor survives the restore and restart",
      );
      assert.equal(readOnlyRollbacks(readEntries()).length, 1);

      // The next ordinary round must stay on the child branch, not fall back
      // to root after the redo commits.
      writeFileSync(join(dir, "r2b.txt"), "redo work\n");
      runGit(dir, "add", ".");
      runGit(dir, "-c", "user.name=lf", "-c", "user.email=lf@example.invalid",
        "commit", "-q", "-m", "redo work");
      const next = await advanceWithHeld(mgr, 
        resumed!.sessionId, "", evaluation("r2b.txt"),
        resumed!.roundId, resumed!.transactionId,
      );
      assert.equal(next.round, 3);
      assert.equal(
        mgr.get(resumed!.sessionId)!.roundSnapshot?.branchId,
        directive.transactionId,
        "later rounds remain on the recovery child branch",
      );
    } finally {
      mgr.close();
    }
  });
});
