/** v3.3.1: Tests for the single workspace containment check (workspace.ts).
 *
 * Every path that must stay inside the loop workspace (state-file
 * directory, evidence command cwd/entrypoints, CLI targets) delegates to
 * containInWorkspace — these tests pin the semantics every caller now
 * shares: lexical containment, realpath containment (incl. symlinked
 * ancestors of not-yet-created paths), and absent-path handling.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { containInWorkspace } from "../workspace.js";

function freshWorkspace(): { dir: string; outside: string } {
  const root = join(tmpdir(), `lf-ws-${Math.random().toString(36).slice(2)}`);
  const outside = join(tmpdir(), `lf-ws-out-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, "inner"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { dir: root, outside };
}

describe("containInWorkspace", () => {
  it("accepts and resolves paths inside the workspace", () => {
    const { dir, outside } = freshWorkspace();
    try {
      writeFileSync(join(dir, "file.ts"), "x");
      // Existing path resolves to itself (no symlinks involved).
      assert.equal(containInWorkspace(dir, join(dir, "file.ts")), join(dir, "file.ts"));
      assert.equal(containInWorkspace(dir, "inner"), join(dir, "inner"));
      // Absent first-run paths are allowed and returned lexically.
      const absent = containInWorkspace(dir, join(dir, "state", "new"));
      assert.ok(absent.startsWith(dir), absent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects lexical escapes", () => {
    const { dir, outside } = freshWorkspace();
    try {
      assert.throws(() => containInWorkspace(dir, "../outside-dir"), /leaves the workspace/);
      assert.throws(() => containInWorkspace(dir, outside), /leaves the workspace/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a junction that resolves outside the workspace", () => {
    const { dir, outside } = freshWorkspace();
    try {
      const link = join(dir, "evil-link");
      // "junction" type works without admin privileges on Windows and is a
      // directory symlink elsewhere.
      symlinkSync(outside, link, "junction");
      assert.throws(
        () => containInWorkspace(dir, join(link, "state")),
        /resolves outside the workspace/,
      );
      // A not-yet-created child of the escaping link must also be caught
      // (the realpath half walks up to the link before resolving).
      assert.throws(
        () => containInWorkspace(dir, join(link, "brand-new-dir")),
        /resolves outside the workspace/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("resolves a workspace-internal junction to its real location", () => {
    const { dir, outside } = freshWorkspace();
    try {
      const inside = join(dir, "real-target");
      mkdirSync(inside);
      const link = join(dir, "alias");
      symlinkSync(inside, link, "junction");
      assert.equal(containInWorkspace(dir, link), inside,
        "existing symlinked paths resolve to their real location");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("realpaths the workspace itself before comparing", () => {
    const { dir, outside } = freshWorkspace();
    try {
      // A path computed from a symlinked workspace root must still be judged
      // against the real root.
      const alias = join(dir, "ws-alias");
      symlinkSync(dir, alias, "junction");
      assert.equal(containInWorkspace(alias, "inner"), join(dir, "inner"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("never follows a symlinked file target into a write outside", (t) => {
    const { dir, outside } = freshWorkspace();
    try {
      writeFileSync(join(outside, "payload.ts"), "secret");
      const link = join(dir, "payload-link.ts");
      try {
        symlinkSync(join(outside, "payload.ts"), link, "file");
      } catch (error) {
        // File symlinks need developer mode / admin on Windows.
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("file symlinks require privileges on this platform");
          return;
        }
        throw error;
      }
      assert.throws(
        () => containInWorkspace(dir, "payload-link.ts"),
        /resolves outside the workspace/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
