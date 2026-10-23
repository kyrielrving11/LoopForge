/** v3.9.8 — workspace checkpoints and deterministic restore.
 *
 * These tests use real temporary Git repositories: the checkpoint boundary is
 * only meaningful against Git's own index/worktree semantics. The checkpoint
 * store deliberately lives OUTSIDE the repository, mirroring the runtime
 * state-dir guarantee.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHECKPOINT_ID_RE,
  FileWorkspaceCheckpointStore,
  buildCheckpointRef,
  checkpointContentHash,
  deriveCheckpointId,
  parseCheckpointManifest,
} from "../workspace-checkpoint.js";
import type { WorkspaceCheckpointManifest } from "../protocol.js";
import { preflightRestore, executeRestore } from "../workspace-restore.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "lf-checkpoint",
  GIT_AUTHOR_EMAIL: "lf-checkpoint@example.invalid",
  GIT_COMMITTER_NAME: "lf-checkpoint",
  GIT_COMMITTER_EMAIL: "lf-checkpoint@example.invalid",
};

const LOOP_ID = "checkpoint-test";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Windows can briefly hold a directory after a killed git child. */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Platform temp cleanup is the backstop.
  }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initRepo(dir: string, files: Record<string, string> = { "a.ts": "export const a = 1;\n" }): void {
  git(dir, "init", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "baseline");
}

function storeFor(): FileWorkspaceCheckpointStore {
  return new FileWorkspaceCheckpointStore(tempDir("lf-checkpoint-store-"), LOOP_ID);
}

function fingerprintOf(manifest: WorkspaceCheckpointManifest, path: string): string {
  const value = manifest.fingerprints[path];
  assert.equal(typeof value, "string", `manifest must cover ${path}`);
  return value;
}

describe("workspace checkpoint capture", () => {
  it("materializes only content HEAD cannot reproduce", async () => {
    const dir = tempDir("lf-checkpoint-repo-");
    const store = storeFor();
    try {
      initRepo(dir, {
        "a.ts": "export const a = 1;\n",
        "clean.ts": "export const clean = true;\n",
        "deleted.ts": "export const gone = true;\n",
      });
      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      writeFileSync(join(dir, "untracked.ts"), "export const u = 1;\n");
      writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
      writeFileSync(join(dir, "ignored.txt"), "not part of the boundary\n");
      unlinkSync(join(dir, "deleted.ts"));
      mkdirSync(join(dir, "状态"), { recursive: true });
      writeFileSync(join(dir, "状态", "文件.ts"), "export const unicode = 1;\n");

      const manifest = await store.capture({ round: 1, role: "before", cwd: dir });

      assert.match(manifest.checkpointId, CHECKPOINT_ID_RE);
      assert.equal(manifest.coverage, "tracked_and_non_ignored_untracked");
      assert.equal(manifest.dirty.includes("a.ts"), true);
      assert.equal(manifest.dirty.includes("untracked.ts"), true);
      assert.equal(manifest.dirty.includes("deleted.ts"), true);

      assert.equal(fingerprintOf(manifest, "deleted.ts"), "missing");
      assert.equal(manifest.contents.includes("a.ts"), true, "dirty tracked content is stored");
      assert.equal(manifest.contents.includes("untracked.ts"), true, "untracked content is stored");
      assert.equal(manifest.contents.includes("状态/文件.ts"), true, "non-ASCII path content is stored");
      assert.equal(manifest.contents.includes("clean.ts"), false, "clean tracked content stays in HEAD");
      assert.equal("ignored.txt" in manifest.fingerprints, false, "ignored files are outside coverage");
      assert.equal(existsSync(store.blobPath(
        fingerprintOf(manifest, "a.ts").split(":")[1]!,
      )), true);

      assert.deepEqual(store.readManifest(manifest.checkpointId), manifest);
      assert.equal(manifest.head, git(dir, "rev-parse", "HEAD").trim());
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });

  it("records symlink text and executable mode fingerprints", async () => {
    const dir = tempDir("lf-checkpoint-repo-");
    const store = storeFor();
    try {
      initRepo(dir);
      let symlinkCreated = false;
      try {
        symlinkSync("a.ts", join(dir, "link.ts"));
        symlinkCreated = true;
      } catch {
        // Windows without Developer Mode cannot create symlinks; the
        // fingerprint contract is still covered by the executable arm.
      }
      if (process.platform !== "win32") chmodSync(join(dir, "a.ts"), 0o755);

      const manifest = await store.capture({ round: 1, role: "mid", cwd: dir });

      if (symlinkCreated) {
        assert.match(fingerprintOf(manifest, "link.ts"), /^link:[a-f0-9]{64}$/);
        assert.equal(manifest.contents.includes("link.ts"), true);
      }
      if (process.platform !== "win32") {
        assert.match(fingerprintOf(manifest, "a.ts"), /^\d+:[a-f0-9]{64}$/);
      }
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });

  it("is content-addressed and idempotent", async () => {
    const dir = tempDir("lf-checkpoint-repo-");
    const store = storeFor();
    try {
      initRepo(dir);
      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      const first = await store.capture({ round: 2, role: "before", cwd: dir });
      const second = await store.capture({ round: 2, role: "before", cwd: dir });
      assert.equal(second.checkpointId, first.checkpointId);
      assert.equal(second.contentHash, first.contentHash);

      writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
      const third = await store.capture({ round: 2, role: "before", cwd: dir });
      assert.notEqual(third.checkpointId, first.checkpointId);
      assert.notEqual(third.contentHash, first.contentHash);

      const ref = buildCheckpointRef(third, {
        transactionId: "tx-checkpoint-test",
        branchId: "loop:checkpoint-test:branch:root",
        roundId: "loop:checkpoint-test:round:2",
      });
      assert.equal(ref.round, 2);
      assert.equal(ref.redoRound, 2);
      assert.equal(ref.contentHash, third.contentHash);
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });

  it("rejects a tampered manifest or content hash", async () => {
    const dir = tempDir("lf-checkpoint-repo-");
    const store = storeFor();
    try {
      initRepo(dir);
      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      const manifest = await store.capture({ round: 1, role: "before", cwd: dir });

      const tampered = { ...manifest, contentHash: "0".repeat(64) };
      assert.equal(parseCheckpointManifest(tampered), null);

      const parsed = parseCheckpointManifest(manifest);
      assert.equal(parsed?.checkpointId, manifest.checkpointId);
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });
});

describe("workspace restore", () => {
  it("restores dirty/untracked/deleted content and moves HEAD backwards", async () => {
    const dir = tempDir("lf-restore-repo-");
    const store = storeFor();
    try {
      initRepo(dir, {
        "a.ts": "export const a = 1;\n",
        "deleted.ts": "export const gone = true;\n",
      });
      const originalHead = git(dir, "rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      writeFileSync(join(dir, "untracked.ts"), "export const u = 1;\n");
      unlinkSync(join(dir, "deleted.ts"));
      const manifest = await store.capture({ round: 1, role: "before", cwd: dir });

      // A later commit abandons the checkpoint's state.
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "later work");
      writeFileSync(join(dir, "a.ts"), "export const a = 3;\n");
      writeFileSync(join(dir, "extra.ts"), "export const extra = true;\n");
      unlinkSync(join(dir, "untracked.ts"));
      const abandonedHead = git(dir, "rev-parse", "HEAD").trim();

      const result = await executeRestore({
        manifest,
        workspace: dir,
        store,
        directiveTransactionId: "tx-restore-test",
      });

      assert.equal(result.status, "verified");
      assert.equal(result.head, originalHead);
      assert.equal(result.previousHead, abandonedHead);
      assert.ok(result.safetyRef);
      assert.equal(git(dir, "rev-parse", "HEAD").trim(), originalHead);
      assert.equal(
        git(dir, "rev-parse", result.safetyRef!).trim(),
        abandonedHead,
        "moving backwards preserves the abandoned HEAD",
      );
      assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "export const a = 2;\n");
      assert.equal(readFileSync(join(dir, "untracked.ts"), "utf8"), "export const u = 1;\n");
      assert.equal(existsSync(join(dir, "deleted.ts")), false);
      assert.equal(existsSync(join(dir, "extra.ts")), false);
      assert.equal(result.baseline.some((observation) => observation.kind === "git"), true);
      assert.ok(result.baselineBoundary);
      assert.deepEqual(
        result.baselineBoundary!.fingerprints,
        manifest.fingerprints,
        "post-restore boundary equals the checkpoint boundary exactly",
      );
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });

  it("restores a mid-round savepoint without moving HEAD", async () => {
    const dir = tempDir("lf-restore-repo-");
    const store = storeFor();
    try {
      initRepo(dir);
      writeFileSync(join(dir, "a.ts"), "export const a = " + "2".repeat(400) + ";\n");
      const manifest = await store.capture({ round: 1, role: "mid", cwd: dir });
      const head = git(dir, "rev-parse", "HEAD").trim();

      writeFileSync(join(dir, "a.ts"), "destroyed\n");
      writeFileSync(join(dir, "new.ts"), "new\n");
      const result = await executeRestore({
        manifest,
        workspace: dir,
        store,
        directiveTransactionId: "tx-mid-test",
      });

      assert.equal(result.head, head);
      assert.equal(git(dir, "rev-parse", "HEAD").trim(), head);
      assert.equal(
        readFileSync(join(dir, "a.ts"), "utf8"),
        "export const a = " + "2".repeat(400) + ";\n",
      );
      assert.equal(existsSync(join(dir, "new.ts")), false);
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });

  it("fails closed on a corrupt blob before mutating the workspace", async () => {
    const dir = tempDir("lf-restore-repo-");
    const store = storeFor();
    try {
      initRepo(dir);
      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      const manifest = await store.capture({ round: 1, role: "before", cwd: dir });
      const blob = store.blobPath(fingerprintOf(manifest, "a.ts").split(":")[1]!);
      writeFileSync(blob, "tampered\n");
      writeFileSync(join(dir, "a.ts"), "work in progress\n");

      await assert.rejects(
        () => preflightRestore({ manifest, workspace: dir, store }),
        (error: unknown) => (error as { reasonCode?: string }).reasonCode === "blob_corrupt",
      );
      assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "work in progress\n");
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });

  it("rejects a path that escapes the workspace before any mutation", async () => {
    const dir = tempDir("lf-restore-repo-");
    const store = storeFor();
    try {
      initRepo(dir);
      const fingerprints = { "../outside.ts": "missing" };
      const contentHash = checkpointContentHash({
        fingerprints,
        contents: [],
        coverage: "tracked_and_non_ignored_untracked",
      });
      const manifest: WorkspaceCheckpointManifest = {
        schemaVersion: 1,
        checkpointId: deriveCheckpointId({ loopId: LOOP_ID, round: 1, role: "before", contentHash }),
        loopId: LOOP_ID,
        round: 1,
        role: "before",
        createdAt: 1,
        dirty: [],
        fingerprints,
        contents: [],
        coverage: "tracked_and_non_ignored_untracked",
        contentHash,
      };
      await assert.rejects(
        () => preflightRestore({ manifest, workspace: dir, store }),
        (error: unknown) => (error as { reasonCode?: string }).reasonCode === "unsafe_path",
      );
      assert.equal(existsSync(join(dir, "..", "outside.ts")), false);
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });

  it("fails closed on a divergent target HEAD", async () => {
    const dir = tempDir("lf-restore-repo-");
    const store = storeFor();
    try {
      initRepo(dir);
      git(dir, "checkout", "-q", "-b", "other");
      writeFileSync(join(dir, "a.ts"), "other\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "other");
      const manifest = await store.capture({ round: 1, role: "before", cwd: dir });
      git(dir, "checkout", "-q", "main");
      writeFileSync(join(dir, "b.ts"), "main\n");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "main");

      await assert.rejects(
        () => preflightRestore({ manifest, workspace: dir, store }),
        (error: unknown) => (error as { reasonCode?: string }).reasonCode === "head_diverged",
      );
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });
});

describe("workspace restore symlinks", () => {
  it("recreates symlink text when the platform allows it", async () => {
    const dir = tempDir("lf-restore-repo-");
    const store = storeFor();
    try {
      initRepo(dir);
      try {
        symlinkSync("a.ts", join(dir, "link.ts"));
      } catch {
        return; // Windows without symlink privilege.
      }
      const manifest = await store.capture({ round: 1, role: "before", cwd: dir });
      unlinkSync(join(dir, "link.ts"));
      writeFileSync(join(dir, "link.ts"), "not a link\n");

      const result = await executeRestore({
        manifest,
        workspace: dir,
        store,
        directiveTransactionId: "tx-symlink-test",
      });
      assert.equal(result.status, "verified");
      const stat = lstatSync(join(dir, "link.ts"));
      assert.equal(stat.isSymbolicLink(), true);
      assert.equal(readFileSync(join(dir, "link.ts"), "utf8"), "export const a = 1;\n");
    } finally {
      cleanup(dir);
      cleanup(store.loopDir);
    }
  });
});
