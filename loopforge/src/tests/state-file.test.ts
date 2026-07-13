import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveStateDirectory } from "../policy.js";

describe("state file path boundary", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
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
      /within the workspace/,
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
});
