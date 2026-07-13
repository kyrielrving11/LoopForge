import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileLoopStore } from "../loop-store.js";

const cleanup: string[] = [];

function makeRoot(): string {
  const root = join(tmpdir(), `loopforge-store-lock-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  cleanup.push(root);
  return root;
}

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

function append(store: FileLoopStore): void {
  store.appendEntry({
    task_id: "loop:lock-test:r1",
    task_type: "loop_lineage",
    loop_id: "lock-test",
    loop_lineage: { round: 1 },
  });
}

describe("FileLoopStore lock ownership", () => {
  it("does not steal an old lock from a live owner", () => {
    const root = makeRoot();
    const lockPath = join(root, ".store.lock");
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ token: "live-owner", pid: process.pid }),
    );
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockPath, old, old);

    assert.throws(() => append(new FileLoopStore(root)), /lock timeout/i);
    assert.equal(existsSync(lockPath), true);
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    assert.equal(owner.token, "live-owner");
  });

  it("recovers an old lock whose owner process is gone", () => {
    const root = makeRoot();
    const lockPath = join(root, ".store.lock");
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "owner.json"),
      JSON.stringify({ token: "dead-owner", pid: 2_147_483_647 }),
    );
    const old = new Date(Date.now() - 10_000);
    utimesSync(lockPath, old, old);

    const store = new FileLoopStore(root);
    append(store);
    assert.equal(existsSync(lockPath), false);
    assert.equal(store.readRound("lock-test", 1)?.round, 1);
  });
});
