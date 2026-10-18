/** v3.9.1 — complete workspace-boundary observation.
 *
 * The round's file delta is the union-key comparison of two complete
 * before/after fingerprint maps. These tests use real temporary Git repos so
 * the enumeration, commit behavior, deletions, renames, ignored files and
 * explicit failure statuses are exercised end to end.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitEvidenceProvider, deriveObservationDeltas } from "../evidence-provider.js";
import type { MachineObservation } from "../protocol.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "lf-boundary",
  GIT_AUTHOR_EMAIL: "lf-boundary@example.invalid",
  GIT_COMMITTER_NAME: "lf-boundary",
  GIT_COMMITTER_EMAIL: "lf-boundary@example.invalid",
};

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "loopforge-boundary-"));
}

/** Windows can briefly hold a directory after a killed git child; retry,
 *  and never let temp-directory removal mask the assertion result. */
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // The OS temp directory is cleaned by the platform; a held handle must
    // not turn a boundary assertion into a cleanup failure.
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

function initRepo(dir: string): void {
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "baseline");
}

async function capture(
  provider: GitEvidenceProvider,
  dir: string,
  phase: "before" | "after" = "after",
  timeoutMs = 20_000,
): Promise<MachineObservation> {
  const observation = await provider.capture({
    signal: new AbortController().signal,
    timeoutMs,
    phase,
    cwd: dir,
  });
  assert.ok(observation, "capture returns an observation");
  return observation;
}

function gitDeltaFiles(
  before: MachineObservation,
  after: MachineObservation,
): string[] {
  return deriveObservationDeltas([before], [after])[0]?.changedFiles ?? [];
}

describe("v3.9.1 — complete boundary observation", () => {
  it("sees a committed content change as a boundary delta", async () => {
    const dir = tempRepo();
    try {
      initRepo(dir);
      const provider = new GitEvidenceProvider();
      const before = await capture(provider, dir, "before");
      writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "change");
      const after = await capture(provider, dir, "after");
      assert.deepEqual(gitDeltaFiles(before, after), ["a.ts"]);
      assert.ok(before.kind === "git" && after.kind === "git");
      assert.ok(after.data.fingerprints["a.ts"] !== before.data.fingerprints["a.ts"]);
      assert.deepEqual(after.files, [], "the worktree is clean after the commit");
    } finally {
      cleanup(dir);
    }
  });

  it("includes deletions and renames", async () => {
    const dir = tempRepo();
    try {
      initRepo(dir);
      writeFileSync(join(dir, "b.ts"), "export const b = 1;\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "add b");
      const provider = new GitEvidenceProvider();
      const before = await capture(provider, dir, "before");
      unlinkSync(join(dir, "b.ts"));
      git(dir, "mv", "a.ts", "renamed.ts");
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "delete and rename");
      const after = await capture(provider, dir, "after");
      assert.deepEqual(
        gitDeltaFiles(before, after),
        ["a.ts", "b.ts", "renamed.ts"],
        "both sides of a rename and a deletion are part of the net boundary change",
      );
      assert.ok(
        !("b.ts" in (after.data as { fingerprints: Record<string, string> }).fingerprints),
        "a committed deletion leaves the index; the union comparison still sees it",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("ignores a dirty file that was already dirty and did not change", async () => {
    const dir = tempRepo();
    try {
      initRepo(dir);
      writeFileSync(join(dir, "pre.ts"), "pre-existing dirty\n");
      const provider = new GitEvidenceProvider();
      const before = await capture(provider, dir, "before");
      const after = await capture(provider, dir, "after");
      assert.deepEqual(gitDeltaFiles(before, after), [],
        "boundary net change, not the dirty list, defines the round delta");
    } finally {
      cleanup(dir);
    }
  });

  it("sees a change to a file that was already dirty at the start", async () => {
    const dir = tempRepo();
    try {
      initRepo(dir);
      writeFileSync(join(dir, "pre.ts"), "v1\n");
      const provider = new GitEvidenceProvider();
      const before = await capture(provider, dir, "before");
      writeFileSync(join(dir, "pre.ts"), "v2\n");
      const after = await capture(provider, dir, "after");
      assert.deepEqual(gitDeltaFiles(before, after), ["pre.ts"]);
    } finally {
      cleanup(dir);
    }
  });

  it("does not enumerate gitignored paths", async () => {
    const dir = tempRepo();
    try {
      initRepo(dir);
      writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
      git(dir, "add", ".gitignore");
      git(dir, "commit", "-q", "-m", "ignore");
      writeFileSync(join(dir, "ignored.txt"), "secret\n");
      const provider = new GitEvidenceProvider();
      const observation = await capture(provider, dir, "after");
      assert.ok(observation.kind === "git");
      assert.ok(!("ignored.txt" in observation.data.fingerprints),
        "ignored files are outside the declared coverage");
    } finally {
      cleanup(dir);
    }
  });

  it("reports a non-repository as unavailable", async () => {
    const dir = tempRepo();
    try {
      const provider = new GitEvidenceProvider();
      const observation = await capture(provider, dir, "after");
      assert.equal(observation.status, "unavailable");
    } finally {
      cleanup(dir);
    }
  });

  it("reports a too-short deadline as timeout, never a partial boundary", async () => {
    const dir = tempRepo();
    try {
      initRepo(dir);
      const provider = new GitEvidenceProvider();
      const observation = await capture(provider, dir, "after", 1);
      assert.equal(observation.status, "timeout");
    } finally {
      cleanup(dir);
    }
  });

  it("uses the same boundary algorithm after an amend / HEAD move", async () => {
    const dir = tempRepo();
    try {
      initRepo(dir);
      const provider = new GitEvidenceProvider();
      const before = await capture(provider, dir, "before");
      git(dir, "commit", "--amend", "-q", "-m", "baseline amended");
      const after = await capture(provider, dir, "after");
      assert.deepEqual(gitDeltaFiles(before, after), [],
        "an amend changes HEAD but not the boundary content");
      assert.notEqual(
        (before.data as { head?: string }).head,
        (after.data as { head?: string }).head,
        "HEAD movement is a separate fact",
      );
    } finally {
      cleanup(dir);
    }
  });

  it("handles a non-ASCII path", async () => {
    const dir = tempRepo();
    try {
      initRepo(dir);
      writeFileSync(join(dir, "资料.md"), "v1\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "chinese name");
      const provider = new GitEvidenceProvider();
      const before = await capture(provider, dir, "before");
      writeFileSync(join(dir, "资料.md"), "v2\n");
      const after = await capture(provider, dir, "after");
      assert.deepEqual(gitDeltaFiles(before, after), ["资料.md"]);
    } finally {
      cleanup(dir);
    }
  });
});
