import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  resetPolicy,
  resolveStateDirectory,
  setPolicyForTest,
  writeStateFile,
} from "../policy.js";

describe("state file path boundary", () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    resetPolicy();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  it("accepts a normal directory inside the workspace", () => {
    const workspace = temp("loopforge-state-root-");
    assert.equal(
      resolveStateDirectory(workspace, ".loopforge/state"),
      join(workspace, ".loopforge", "state"),
    );
  });

  it("rejects lexical traversal outside the workspace", () => {
    const workspace = temp("loopforge-state-root-");
    assert.throws(
      () => resolveStateDirectory(workspace, "../outside"),
      /leaves the workspace/,
    );
  });

  it("rejects a symlink or junction that resolves outside the workspace", () => {
    const workspace = temp("loopforge-state-root-");
    const outside = temp("loopforge-state-outside-");
    mkdirSync(join(workspace, ".loopforge"), { recursive: true });
    symlinkSync(outside, join(workspace, ".loopforge", "state"), "junction");

    assert.throws(
      () => resolveStateDirectory(workspace, ".loopforge/state"),
      /resolves outside the workspace/,
    );
  });

  it("does not rewrite identical rendered content", () => {
    const workspace = temp("loopforge-state-write-");
    process.chdir(workspace);
    setPolicyForTest({
      ...DEFAULT_POLICY,
      state_file: { enabled: true, directory: ".state" },
    });

    writeStateFile("loop-a", "# State\n");
    const target = join(workspace, ".state", "loop-a-state.md");
    const first = statSync(target, { bigint: true }).mtimeNs;

    // If the implementation rewrote the file, its mtime would advance.
    const until = Date.now() + 25;
    while (Date.now() < until) { /* let the clock move */ }
    writeStateFile("loop-a", "# State\n");
    assert.equal(
      statSync(target, { bigint: true }).mtimeNs,
      first,
      "identical content must not be rewritten",
    );

    writeStateFile("loop-a", "# Changed\n");
    assert.notEqual(
      statSync(target, { bigint: true }).mtimeNs,
      first,
      "changed content is written",
    );
  });
});
