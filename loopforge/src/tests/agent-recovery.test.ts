/** v3.9.7 — checkpoint selection, manifest binding, and deterministic restore. */

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
import {
  checkpointForRoundBoundary,
  deriveRecoveryDirective,
  findCheckpointRef,
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
