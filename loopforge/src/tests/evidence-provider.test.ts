import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  EvidenceCollector,
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

  it("honours an empty evidence provider policy", () => {
    assert.deepEqual(EvidenceCollector.fromProviderNames([]).collect(), []);
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
});
