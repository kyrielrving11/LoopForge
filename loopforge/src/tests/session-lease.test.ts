import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { FileLoopStore, LoopStoreBackend } from "../loop-store.js";
import { VaultSessionStateStore } from "../storage.js";

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
    const store = new VaultSessionStateStore(
      new LoopStoreBackend(new FileLoopStore(storeRoot)),
    );
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
      `import { FileLoopStore, LoopStoreBackend } from ${JSON.stringify(loopStoreUrl)}`,
      `import { VaultSessionStateStore } from ${JSON.stringify(storageUrl)}`,
      "const store = new VaultSessionStateStore(new LoopStoreBackend(new FileLoopStore(process.env.TEST_STORE)))",
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
