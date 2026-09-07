import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  EvidenceCollector,
  GitEvidenceProvider,
  captureGitFileStateAsync,
  diffSnapshotCollections,
  diffSnapshots,
  runBacktrackAutoRestore,
} from "../evidence-provider.js";
import type { ProviderSnapshot } from "../evidence-provider.js";

function gitSnapshot(
  files: string[],
  fingerprints: Record<string, string>,
): ProviderSnapshot {
  return {
    provider: "git",
    timestamp: Date.now(),
    files,
    data: { tracked: files, staged: [], untracked: [], fingerprints },
  };
}

describe("EvidenceProvider round diffs", () => {
  it("detects a pre-existing dirty file modified again", () => {
    const before = [gitSnapshot(["src/dirty.ts"], { "src/dirty.ts": "v1" })];
    const after = [gitSnapshot(["src/dirty.ts"], { "src/dirty.ts": "v2" })];

    assert.deepEqual(diffSnapshots(before, after), ["src/dirty.ts"]);
    assert.deepEqual(
      diffSnapshotCollections(before, after)[0]?.files,
      ["src/dirty.ts"],
    );
  });

  it("detects a dirty file restored to its baseline", () => {
    const before = [gitSnapshot(["src/restored.ts"], { "src/restored.ts": "v1" })];
    const after = [gitSnapshot([], {})];
    assert.deepEqual(diffSnapshots(before, after), ["src/restored.ts"]);
  });

  it("honours an empty evidence provider policy", async () => {
    assert.deepEqual(await EvidenceCollector.fromProviderNames([]).collectAsync(), []);
  });

  it("M1: detects a content change to a non-ASCII (Chinese) filename", async () => {
    // Git octal-escapes paths with bytes >= 0x80 by default ("资料.md" →
    // "\350\265\204\346\226\231.md"); an escaped name can't be stat/hash'd,
    // so every capture recorded fingerprint "missing" and a pure content
    // change to such a file vanished from the round diff.
    const dir = join(tmpdir(), `lf-m1-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "lf-test", GIT_AUTHOR_EMAIL: "lf@test", GIT_COMMITTER_NAME: "lf-test", GIT_COMMITTER_EMAIL: "lf@test" };
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv });
    try {
      git("init", "-q");
      writeFileSync(join(dir, "资料.md"), "baseline\n");
      git("add", "资料.md");
      git("commit", "-q", "-m", "baseline");
      const fileName = "资料.md";

      // Already-dirty across the round boundary is the failing shape: the
      // file is listed in BOTH captures, so only the fingerprint can see
      // the content change.
      const provider = new GitEvidenceProvider();
      const capture = (): Promise<ProviderSnapshot | null> => provider.capture({
        signal: new AbortController().signal,
        timeoutMs: 10000,
        phase: "after",
        cwd: dir,
      });
      writeFileSync(join(dir, fileName), "v1\n");
      const snapBefore = await capture();
      const before = await captureGitFileStateAsync(undefined, 10000, dir);
      assert.ok(before?.tracked.includes(fileName),
        "the modified Chinese-named file must be listed raw (no octal escapes)");
      writeFileSync(join(dir, fileName), "v2\n");
      const after = await captureGitFileStateAsync(undefined, 10000, dir);
      assert.ok(after?.tracked.includes(fileName));
      const snapAfter = await capture();
      assert.ok(snapBefore && snapAfter);
      const fpsBefore = snapBefore.data.fingerprints as Record<string, string>;
      const fpsAfter = snapAfter.data.fingerprints as Record<string, string>;
      assert.notEqual(
        fpsBefore[fileName],
        fpsAfter[fileName],
        "content fingerprints must differ across the modification",
      );
      assert.deepEqual(diffSnapshots([snapBefore], [snapAfter]), [fileName],
        "a pure content change to a Chinese-named file must surface in the diff");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runBacktrackAutoRestore (v3.3.1)", () => {
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "lf-test", GIT_AUTHOR_EMAIL: "lf@test", GIT_COMMITTER_NAME: "lf-test", GIT_COMMITTER_EMAIL: "lf@test" };
  function git(dir: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv });
  }

  function freshRepo(): string {
    const dir = join(tmpdir(), `lf-autorestore-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    return dir;
  }

  it("stashes failed-round changes and resets to the restore-point commit", async () => {
    const dir = freshRepo();
    try {
      writeFileSync(join(dir, "work.ts"), "baseline\n");
      git(dir, "add", "work.ts");
      git(dir, "commit", "-q", "-m", "baseline");
      const head = git(dir, "rev-parse", "HEAD").trim();

      // Failed round: modify a tracked file, create an untracked file, commit.
      writeFileSync(join(dir, "work.ts"), "failed-round change\n");
      writeFileSync(join(dir, "scratch-untracked.ts"), "leftover\n");
      git(dir, "add", "work.ts");
      git(dir, "commit", "-q", "-m", "failed round commit");

      const outcome = await runBacktrackAutoRestore(head, 7, dir);
      assert.equal(outcome.ok, true, outcome.detail);
      // Tracked file back at baseline; untracked scratch removed (stashed);
      // the failed commit is gone (HEAD back at the restore point).
      assert.equal(readFileSync(join(dir, "work.ts"), "utf8").trim(), "baseline",
        "tracked changes must be reverted to the restore point");
      assert.equal(existsSync(join(dir, "scratch-untracked.ts")), false,
        "untracked failed-round files must be stashed away, not left behind");
      assert.equal(git(dir, "rev-parse", "HEAD").trim(), head,
        "commits made by failed rounds must be discarded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an already-clean workspace as success", async () => {
    const dir = freshRepo();
    try {
      writeFileSync(join(dir, "work.ts"), "baseline\n");
      git(dir, "add", "work.ts");
      git(dir, "commit", "-q", "-m", "baseline");
      const head = git(dir, "rev-parse", "HEAD").trim();
      const outcome = await runBacktrackAutoRestore(head, 1, dir);
      assert.equal(outcome.ok, true, outcome.detail);
      assert.ok(outcome.detail.includes("clean"), outcome.detail);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("L6: skips reset --hard when the stash fails — uncommitted work survives", async () => {
    // A stash failure must abort the restore: `reset --hard` after it would
    // destroy exactly the changes the stash was meant to preserve. A merge
    // conflict is the deterministic way to make `git stash push -u` fail
    // while `git reset --hard` would otherwise succeed.
    const dir = freshRepo();
    try {
      writeFileSync(join(dir, "work.ts"), "base\n");
      git(dir, "add", "work.ts");
      git(dir, "commit", "-q", "-m", "base");
      git(dir, "checkout", "-q", "-b", "side");
      writeFileSync(join(dir, "work.ts"), "side\n");
      git(dir, "commit", "-qam", "side");
      git(dir, "checkout", "-q", "master");
      writeFileSync(join(dir, "work.ts"), "master\n");
      git(dir, "commit", "-qam", "master");
      const head = git(dir, "rev-parse", "HEAD").trim();
      // Merge conflict: unmerged index entries — stash push now fails.
      try { git(dir, "merge", "side"); } catch { /* expected conflict */ }
      assert.ok(readFileSync(join(dir, "work.ts"), "utf8").includes("<<<<<<<"),
        "fixture must be in a conflicted state");

      const outcome = await runBacktrackAutoRestore(head, 5, dir);
      assert.equal(outcome.ok, false, "a failed stash must report failure");
      assert.ok(outcome.detail.includes("SKIPPED"), outcome.detail);
      assert.ok(readFileSync(join(dir, "work.ts"), "utf8").includes("<<<<<<<"),
        "reset must NOT have run — the conflicted (uncommitted) state survives");
      assert.equal(git(dir, "rev-parse", "HEAD").trim(), head,
        "HEAD must be untouched when the restore aborted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
