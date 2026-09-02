import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { FileLoopStore } from "../loop-store.js";
import type { VaultEntry } from "../loop-store.js";
import { SessionLeaseConflictError, VaultSessionStateStore } from "../storage.js";
import type { SessionStateStore } from "../storage.js";
import { SessionManager } from "../mcp/session.js";

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe("cross-process session lease", () => {
  it("blocks a live process and immediately recovers a dead owner", () => {
    const dir = join(tmpdir(), `loopforge-lease-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    cleanup.push(dir);
    const storeRoot = join(dir, "store");
    const fileStore = new FileLoopStore(storeRoot);
    const store = new VaultSessionStateStore(fileStore);
    store.save({
      task_id: "loop:cross-process:session",
      task_type: "session_state",
      loop_id: "cross-process",
      loop_lineage: { status: "running" },
    });
    assert.ok(store.acquireLease(
      "cross-process",
      `${process.pid}:parent`,
      30_000,
    ));

    const loopStoreUrl = pathToFileURL(resolve("dist/loop-store.js")).href;
    const storageUrl = pathToFileURL(resolve("dist/storage.js")).href;
    const code = [
      `import { FileLoopStore } from ${JSON.stringify(loopStoreUrl)}`,
      `import { VaultSessionStateStore } from ${JSON.stringify(storageUrl)}`,
      "const store = new VaultSessionStateStore(new FileLoopStore(process.env.TEST_STORE))",
      "const result = store.acquireLease('cross-process', `${process.pid}:child`, 30000)",
      "process.stdout.write(result ? 'claimed' : 'blocked')",
    ].join(";\n");
    const blocked = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      env: { ...process.env, TEST_STORE: storeRoot },
    });
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(blocked.stdout, "blocked");

    // A syntactically valid but nonexistent PID is recoverable before TTL.
    const entry = store.load("cross-process")!;
    store.save({
      ...entry,
      loop_lineage: {
        ...entry.loop_lineage,
        lease_owner: "99999999:dead",
        lease_expires_at: Date.now() + 30_000,
      },
    }, { expectedLeaseOwner: `${process.pid}:parent` });
    assert.ok(store.acquireLease(
      "cross-process",
      `${process.pid}:replacement`,
      30_000,
    ));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2.1: create() must pre-flight the cross-process lease BEFORE compiling
// (the compile writes round-1 lineage + state file into the loop's vault),
// and must roll back its in-memory registration when the save-time lease
// race is lost.
// ═══════════════════════════════════════════════════════════════════════════
describe("create() lease fencing (v3.2.1)", () => {
  it("pre-flights the lease before compiling — no vault pollution, no registry leak", async () => {
    const dir = join(tmpdir(), `loopforge-create-lease-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    cleanup.push(dir);
    const store = new FileLoopStore(join(dir, "store"));

    // "Process A" creates loop L and holds its lease.
    const mgrA = new SessionManager(store);
    const createdA = await mgrA.create({
      task: "Process A task",
      loopId: "lease-create-1",
    });
    assert.ok(createdA.sessionId, "A must create the loop");

    // "Process B" (same store, its own ownerId) must be blocked BEFORE the
    // compile — round-1 lineage and state file must stay untouched.
    const mgrB = new SessionManager(store);
    await assert.rejects(
      mgrB.create({ task: "Process B task", loopId: "lease-create-1" }),
      SessionLeaseConflictError,
      "B must be rejected for a loop A owns",
    );

    // B's in-memory registry is clean: a second create must hit the lease
    // conflict again (pre-flight throws), NOT the same-process
    // loop_already_running guard — the latter would mean the first attempt
    // leaked a registered session that can only be cleared by restarting.
    await assert.rejects(
      mgrB.create({ task: "Process B task", loopId: "lease-create-1" }),
      SessionLeaseConflictError,
      "a conflicting create must not leak a registered session",
    );

    // A's vault is not polluted: round-1 lineage still records A's task.
    const entries = store.listEntries("lease-create-1");
    const lineage = entries.find((e) => String(e.task_id).endsWith(":r1"));
    assert.ok(lineage, "A's round-1 lineage must still exist");
    assert.equal(
      lineage!.task, "Process A task",
      "a conflicting create must not overwrite A's round-1 lineage",
    );

    // B can create the loop once A releases the lease.
    mgrA.close();
    const mgrC = new SessionManager(store);
    const createdC = await mgrC.create({
      task: "Process C task",
      loopId: "lease-create-1",
    });
    assert.ok(createdC.sessionId, "C must be able to create after A releases");
    mgrB.close();
    mgrC.close();
  });

  it("rolls back the registry when the save-time lease race is lost", async () => {
    const dir = join(tmpdir(), `loopforge-create-race-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    cleanup.push(dir);
    const store = new FileLoopStore(join(dir, "store"));
    const inner = new VaultSessionStateStore(store);

    // A session store whose save() throws once — simulates another process
    // winning the lease between the pre-flight check and the save.
    let failNextSave = false;
    const flaky: SessionStateStore = {
      load: (loopId) => inner.load(loopId),
      list: () => inner.list(),
      save: (entry: VaultEntry, opts) => {
        if (failNextSave) {
          failNextSave = false;
          throw new SessionLeaseConflictError(String(entry.loop_id ?? ""));
        }
        inner.save(entry, opts);
      },
      acquireLease: (loopId, ownerId, leaseMs, now) =>
        inner.acquireLease?.(loopId, ownerId, leaseMs, now),
      renewLease: (loopId, ownerId, leaseMs, now) =>
        inner.renewLease?.(loopId, ownerId, leaseMs, now),
      releaseLease: (loopId, ownerId) => inner.releaseLease?.(loopId, ownerId),
    };

    const mgr = new SessionManager(store, flaky);
    failNextSave = true;
    await assert.rejects(
      mgr.create({ task: "Task", loopId: "lease-save-race" }),
      SessionLeaseConflictError,
      "save-time lease conflict must surface",
    );
    assert.ok(
      !mgr.list().some((s) => s.loopId === "lease-save-race"),
      "a lost lease race must not leave a registered session behind",
    );

    // The registry was rolled back, so a later create for the same loopId
    // works instead of returning loop_already_running forever.
    const retry = await mgr.create({ task: "Task", loopId: "lease-save-race" });
    assert.ok(retry.sessionId, "create must be retryable after a lost lease race");
    mgr.close();
  });
});
