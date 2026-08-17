import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { FileLoopStore } from "../loop-store.js";
import { SessionManager } from "../mcp/session.js";
import { TOOL_SCHEMAS } from "../mcp/tools.js";
import { StoreLocator, WorkspaceRuntime, resolveStoreRoot, resolveWorkspace } from "../workspace-runtime.js";

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "loopforge-workspace-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace runtime", () => {
  it("canonicalizes explicit workspaces and resolves relative stores inside them", () => {
    const workspace = temporaryRoot();
    const resolved = resolveWorkspace(workspace);
    assert.equal(resolved.source, "explicit");
    assert.equal(resolveStoreRoot(resolved.root, "state"), join(resolved.root, "state"));
    assert.throws(() => resolveStoreRoot(resolved.root, "../outside"), /must stay within/);
  });

  it("rejects a relative Store that resolves outside through a symlink or junction", () => {
    const workspace = temporaryRoot();
    const outside = temporaryRoot();
    symlinkSync(outside, join(workspace, "linked-store"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => resolveStoreRoot(workspace, "linked-store"),
      /resolves outside workspaceRoot/,
    );
  });

  it("rejects filesystem and user-home roots", () => {
    const root = process.platform === "win32" ? `${process.cwd().slice(0, 3)}` : "/";
    assert.throws(() => resolveWorkspace(root), /must not be/);
  });

  it("does not bind after a failed resume and rejects switching after success", async () => {
    const workspace = temporaryRoot();
    const locator = new StoreLocator(join(workspace, "locator.json"));
    const runtime = new WorkspaceRuntime(undefined, locator);
    const manager = new SessionManager(undefined, undefined, runtime);
    assert.throws(() => manager.resumeWithWorkspace("missing-loop", workspace), /session_not_found/);
    assert.equal(runtime.isBound, false);

    const store = new FileLoopStore(join(workspace, ".loopforge"));
    const seed = new SessionManager(store);
    await seed.create({ task: "resume without workspace binding", loopId: "unbound-resume" });
    seed.close();
    const resumed = manager.resumeWithWorkspace("unbound-resume", workspace);
    assert.ok(resumed?.prompt);
    assert.equal(runtime.isBound, true);

    const other = temporaryRoot();
    assert.throws(() => manager.bindWorkspace(other), /workspace_already_bound/);
    manager.close();
  });

  it("requires an explicit first workspace, reuses a binding, and rejects duplicate loop IDs", async () => {
    const workspace = temporaryRoot();
    const runtime = new WorkspaceRuntime(undefined, new StoreLocator(join(workspace, "locator.json")));
    const manager = new SessionManager(undefined, undefined, runtime);

    await assert.rejects(
      manager.create({ task: "missing workspace", loopId: "missing-workspace" }),
      /workspace_not_bound/,
    );
    assert.equal(runtime.isBound, false);

    await manager.create({ task: "first", loopId: "bound-first", workspaceRoot: workspace });
    assert.equal(runtime.summary().bindingSource, "explicit");
    await manager.create({ task: "second", loopId: "bound-second" });

    await assert.rejects(
      manager.create({ task: "overwrite", loopId: "bound-first", workspaceRoot: workspace }),
      /loop_conflict/,
    );
    assert.equal(manager.list().filter((item) => item.loopId === "bound-first").length, 1);
    assert.equal(new FileLoopStore(join(workspace, ".loopforge")).readSession("bound-first")?.entry.task, "first");
    manager.close();
  });

  it("adds binding to a schema 3 session without rewriting its round documents", async () => {
    const workspace = temporaryRoot();
    mkdirSync(join(workspace, ".loopforge"), { recursive: true });
    const store = new FileLoopStore(join(workspace, ".loopforge"));
    const unbound = new SessionManager(store);
    await unbound.create({ task: "bind existing schema 3 session", loopId: "unbound-session" });
    unbound.close();
    const loopHash = createHash("sha256").update("unbound-session").digest("hex");
    const roundPath = join(workspace, ".loopforge", "loops", loopHash, "rounds", "1.json");
    const before = createHash("sha256").update(readFileSync(roundPath)).digest("hex");

    const runtime = new WorkspaceRuntime(undefined, new StoreLocator(join(workspace, "locator.json")));
    const manager = new SessionManager(undefined, undefined, runtime);
    manager.resumeWithWorkspace("unbound-session", workspace);
    const lineage = store.readSession("unbound-session")?.entry.loop_lineage as Record<string, unknown>;
    assert.equal((lineage.workspace_binding as Record<string, unknown>).workspaceRoot, resolveWorkspace(workspace).root);
    const after = createHash("sha256").update(readFileSync(roundPath)).digest("hex");
    assert.equal(after, before);
    manager.close();
  });

  it("keeps the MCP surface within its fixed count and schema budget", () => {
    assert.equal(TOOL_SCHEMAS.length, 12);
    assert.ok(JSON.stringify(TOOL_SCHEMAS).length <= 28_000);
  });

  it("diagnoses corrupt typed state and orphan Markdown without binding", () => {
    const workspace = temporaryRoot();
    const loopId = "broken-session";
    const loopHash = createHash("sha256").update(loopId).digest("hex");
    const loopDir = join(workspace, ".loopforge", "loops", loopHash);
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(join(loopDir, "session.json"), "{broken", "utf8");
    const runtime = new WorkspaceRuntime(undefined, new StoreLocator(join(workspace, "locator.json")));
    const manager = new SessionManager(undefined, undefined, runtime);
    assert.throws(() => manager.resumeWithWorkspace(loopId, workspace), /session_corrupt/);
    assert.equal(runtime.isBound, false);

    rmSync(join(workspace, ".loopforge", "loops"), { recursive: true, force: true });
    mkdirSync(join(workspace, ".loopforge", "state"), { recursive: true });
    writeFileSync(join(workspace, ".loopforge", "state", `${loopId}-state.md`), "derived", "utf8");
    assert.throws(() => manager.resumeWithWorkspace(loopId, workspace), /orphan_markdown/);
    assert.equal(runtime.isBound, false);
    manager.close();
  });

  it("isolates sessions from different workspaces in one explicit Store", async () => {
    const workspaceA = temporaryRoot();
    const workspaceB = temporaryRoot();
    const sharedStore = temporaryRoot();
    const managerA = new SessionManager(undefined, undefined, new WorkspaceRuntime(undefined, new StoreLocator(join(workspaceA, "locator.json"))));
    await managerA.create({ task: "workspace A", loopId: "workspace-a", workspaceRoot: workspaceA, storeDir: sharedStore });
    managerA.close();

    const managerB = new SessionManager(undefined, undefined, new WorkspaceRuntime(undefined, new StoreLocator(join(workspaceB, "locator.json"))));
    await managerB.create({ task: "workspace B", loopId: "workspace-b", workspaceRoot: workspaceB, storeDir: sharedStore });
    assert.deepEqual(managerB.list().map((item) => item.loopId), ["workspace-b"]);
    managerB.close();
  });
});
