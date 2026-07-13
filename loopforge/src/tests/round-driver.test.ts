import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import { RoundDriver } from "../round-driver.js";
import { Mode } from "../protocol.js";
import type { LoopForgeRequest } from "../protocol.js";
import { MemoryBackend } from "./_helpers.js";

function request(loopId: string): LoopForgeRequest {
  return {
    task: "Implement a durable transaction boundary",
    mode: Mode.LOOP_COMPILE,
    feedback: null,
    skill_name: null,
    task_id: null,
    loop_id: loopId,
    round: 1,
    max_rounds: 4,
  };
}

describe("RoundDriver", () => {
  it("produces the same prompt artifact for Runtime and MCP-equivalent state", async () => {
    const left = await new RoundDriver(
      new LoopForgeEngine(new MemoryBackend()),
    ).prepare(request("driver-parity"), "driver-parity", 1);
    const right = await new RoundDriver(
      new LoopForgeEngine(new MemoryBackend()),
    ).prepare(request("driver-parity"), "driver-parity", 1);

    assert.ok(left?.artifact);
    assert.ok(right?.artifact);
    assert.equal(left.prompt, right.prompt);
    assert.equal(left.artifact.promptHash, right.artifact.promptHash);
    assert.equal(left.artifact.stateHash, right.artifact.stateHash);
    assert.equal(left.snapshot.phase, "prompted");
  });

  it("compiles a new L0 artifact for a rejected attempt without a lineage commit", async () => {
    const backend = new MemoryBackend();
    const driver = new RoundDriver(
      new LoopForgeEngine(backend),
      backend,
    );
    const initial = await driver.prepare(
      request("driver-retry"),
      "driver-retry",
      1,
    );
    assert.ok(initial);
    const rejected = {
      ...initial.snapshot,
      phase: "rejected" as const,
      updatedAt: Date.now(),
    };

    const retry = await driver.prepareRetry(
      request("driver-retry"),
      rejected,
      "The claimed result is missing required evidence.",
      1,
    );

    assert.ok(retry?.artifact);
    assert.equal(retry.snapshot.roundId, initial.snapshot.roundId);
    assert.equal(retry.snapshot.attempt, 2);
    assert.equal(retry.snapshot.phase, "prompted");
    assert.equal(retry.level, "l0");
    assert.match(retry.prompt, /missing required evidence/);
    assert.equal(
      backend.queryEntries({ prefix: "loop:driver-retry:r1" })
        .filter((entry) => entry.task_id === "loop:driver-retry:r1").length,
      1,
    );
  });
});
