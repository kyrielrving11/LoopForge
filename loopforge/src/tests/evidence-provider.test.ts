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
} from "../evidence-provider.js";
import type { GitObservation } from "../protocol.js";

function gitSnapshot(
  files: string[],
  fingerprints: Record<string, string>,
): GitObservation {
  return {
    schemaVersion: 1,
    providerId: "git",
    kind: "git",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
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

  it("v3.8.1: the runtime's own state directory is not machine-observed work", async () => {
    // The vault lives inside the workspace by default, so every round's
    // bookkeeping writes would otherwise read as machine-observed motion —
    // the very signal the stall evaluator and the backtrack restore checks
    // consume. The exclusion lives in the provider, at the fact, rather than
    // in a workspace .gitignore the runtime neither owns nor can rely on.
    const dir = join(tmpdir(), `lf-state-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    try {
      git("init", "-q");
      writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
      mkdirSync(join(dir, ".loopforge", "loops", "x", "rounds"), { recursive: true });
      writeFileSync(join(dir, ".loopforge", "loops", "x", "rounds", "1.json"), "{}\n");

      const provider = new GitEvidenceProvider();
      const snapshot = await provider.capture({
        signal: new AbortController().signal,
        timeoutMs: 10000,
        phase: "after",
        cwd: dir,
      });
      assert.ok(snapshot, "the git provider observes a real repository");
      assert.ok(snapshot!.files.includes("src.ts"), "the agent's own file is observed");
      assert.ok(!snapshot!.files.some((file) => file.startsWith(".loopforge/")),
        "the runtime's state must not count as the agent's work");
      assert.ok(!snapshot!.data.untracked.some((file) => file.startsWith(".loopforge/")),
        "the raw lists exclude it too — one observation, one file set");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      const capture = (): Promise<GitObservation | null> => provider.capture({
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
