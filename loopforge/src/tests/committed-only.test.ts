/** v4.0.1 — compiling is read-only; only a committed transaction is history. */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import { SessionManager } from "../mcp/session.js";
import { makeLoopCompileRequest } from "../protocol.js";
import { resetPolicy } from "../policy.js";
import { LoopExistsError } from "../errors.js";
import {
  MemoryLoopStore,
  advanceWithHeld,
  committedBacktrackRound,
} from "./_helpers.js";

const TASK = "Implement the parser";

function continuing() {
  return {
    success: false,
    output_summary: "parser skeleton in place",
    constraint_violations: [],
    should_continue: true,
  };
}

describe("v4.0.1 — committed-only history", () => {
  beforeEach(() => {
    resetPolicy();
  });

  it("compile writes no round document", async () => {
    const store = new MemoryLoopStore();
    const manager = new SessionManager(store);
    const started = await manager.create({
      task: TASK,
      loopId: "compiled-only",
      maxRounds: 5,
    });
    assert.ok(started.prompt);
    assert.equal(store.rounds.size, 0, "start compiles without committing");

    const engine = new LoopForgeEngine(store);
    engine.invokeLoopCompile(makeLoopCompileRequest({
      loop_id: "compiled-only",
      round: 1,
      task: TASK,
    }));
    engine.invokeLoopCompile(makeLoopCompileRequest({
      loop_id: "compiled-only",
      round: 2,
      task: TASK,
    }));
    assert.equal(store.rounds.size, 0, "a compile never writes the vault");
  });

  it("a restart before submission recompiles the same round with no history", async () => {
    const store = new MemoryLoopStore();
    const first = new SessionManager(store);
    const started = await first.create({
      task: TASK,
      loopId: "crash-before-submit",
      maxRounds: 5,
    });
    assert.equal(started.round, 1);

    // Simulate a process exit: the first manager stops renewing and its
    // lease is expired, so a new process can claim the same session.
    const document = store.readSession("crash-before-submit");
    assert.ok(document);
    const lineage = document.entry.loop_lineage as Record<string, unknown>;
    lineage.lease_expires_at = 0;
    store.writeSession("crash-before-submit", document);

    const restarted = new SessionManager(store);
    const resumed = await restarted.resume("crash-before-submit");
    assert.equal(resumed?.round, 1, "the uncommitted round is recompiled");
    assert.ok(resumed?.prompt, JSON.stringify(resumed));
    assert.equal(store.rounds.size, 0);
  });

  it("a commit produces exactly one feedback document", async () => {
    const store = new MemoryLoopStore();
    const manager = new SessionManager(store);
    const started = await manager.create({
      task: TASK,
      loopId: "one-feedback",
      maxRounds: 5,
    });
    const advanced = await advanceWithHeld(
      manager,
      started.sessionId,
      "",
      continuing(),
    );
    assert.notEqual(advanced.stopReason, "stalled");
    assert.equal(store.rounds.size, 1);
    const document = store.readRound("one-feedback", 1);
    assert.ok(document?.feedback, "the committed round is one :feedback entry");
    assert.equal(
      (document?.feedback?.loop_lineage as Record<string, unknown>)?.round_transaction
        !== undefined,
      true,
      "the feedback carries the complete transaction snapshot",
    );
    assert.deepEqual(document?.events, []);

    // Written shapes: one session document (not in the flat entry log) and
    // one :feedback entry. No compile lineage and no delegation journal.
    const taskTypes = store.entries.map((entry) => String(entry.task_type ?? ""));
    assert.deepEqual(taskTypes, ["feedback"]);
    assert.equal(
      store.entries[0]?.task_id,
      "loop:one-feedback:r1:feedback",
    );
    assert.ok(!taskTypes.includes("loop_lineage"));
    assert.ok(!taskTypes.includes("delegation_journal"));
  });

  it("treats a directive-only loop as committed history for start and audit", async () => {
    const loopId = "directive-only";
    const store = new MemoryLoopStore();
    store.appendEntry(committedBacktrackRound(2, loopId, 0));
    const manager = new SessionManager(store);

    assert.ok(manager.getAudit(loopId), "the committed directive is auditable");
    await assert.rejects(
      manager.create({ task: TASK, loopId }),
      LoopExistsError,
      "a rollback directive reserves its loop identity",
    );
    manager.close();
  });
});
