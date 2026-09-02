import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import { RoundDriver } from "../round-driver.js";
import {
  Mode,
  makeExecutionEvidence,
  makeSelfEvaluation,
} from "../protocol.js";
import type { LoopForgeRequest } from "../protocol.js";
import { MemoryLoopStore, installTestCommandProvider } from "./_helpers.js";
import { queryLoopEntries } from "../loop-store.js";

// v3.3: success claims need machine-backed evidence — the RoundDriver
// collects evidence via the real collector, so a passing command provider
// keeps R8 / success_unverified silent in these flows.
installTestCommandProvider();

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
      new LoopForgeEngine(new MemoryLoopStore()),
    ).prepare(request("driver-parity"), "driver-parity", 1);
    const right = await new RoundDriver(
      new LoopForgeEngine(new MemoryLoopStore()),
    ).prepare(request("driver-parity"), "driver-parity", 1);

    assert.ok(left?.artifact);
    assert.ok(right?.artifact);
    assert.equal(left.prompt, right.prompt);
    assert.equal(left.artifact.promptHash, right.artifact.promptHash);
    assert.equal(left.artifact.stateHash, right.artifact.stateHash);
    assert.equal(left.snapshot.phase, "prompted");
  });

  it("compiles a new L0 artifact for a rejected attempt without a lineage commit", async () => {
    const store = new MemoryLoopStore();
    const driver = new RoundDriver(
      new LoopForgeEngine(store),
      store,
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
      queryLoopEntries(store, "driver-retry", { prefix: "loop:driver-retry:r1" })
        .filter((entry) => entry.task_id === "loop:driver-retry:r1").length,
      1,
    );
  });

  it("merges the committed round's truth into the compile context (cross-round features)", async () => {
    const store = new MemoryLoopStore();
    const engine = new LoopForgeEngine(store);
    const driver = new RoundDriver(engine, store);

    // Round 1: the agent reports a checkpoint, discovered constraint,
    // sub-goals, and execution evidence — everything the cross-round
    // compiler features depend on. Regression: the round-2 compile used to
    // see only the 8 compile-time lineage fields, silently disabling
    // milestones, constraint decay, and sub-goal accumulation.
    const p1 = await driver.prepare(
      request("driver-cross-round"),
      "driver-cross-round",
      1,
    );
    const eval1 = makeSelfEvaluation({
      success: true,
      output_summary: "Implemented the parser.",
      constraint_violations: [],
      should_continue: true,
      compression_checkpoint: true,
      checkpoint_label: "Phase 1 done",
      discovered_constraints: ["Never log secrets"],
      completed_subtasks: ["Add error handling", "Wire config"],
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: ["cr-11111111", "Parser handles edge cases"],
        success_criteria_remaining: [],
        progress_estimate: 0.5,
      }),
    });
    const c1 = await driver.complete({
      snapshot: p1!.snapshot,
      loopId: "driver-cross-round",
      task: "Implement a durable transaction boundary",
      maxRounds: 4,
      selfEval: eval1,
      consecutiveRejections: 0,
      successTrajectory: [],
    });
    assert.equal(c1.outcome.result.action, "continue");

    // The round-2 compile context must carry the committed round's truth
    const context = engine.hydrateLoopContext("driver-cross-round") as
      | Record<string, unknown>
      | null;
    assert.ok(context);
    const results = context.results as Array<Record<string, unknown>>;
    assert.equal(results.length, 1);
    const entry = results[0];
    const lin = entry.loop_lineage as Record<string, unknown>;
    assert.equal(entry.output_summary, "Implemented the parser.");
    assert.equal(lin.compression_checkpoint, true);
    assert.equal(lin.checkpoint_label, "Phase 1 done");
    assert.deepEqual(lin.execution_evidence, eval1.execution_evidence);
    assert.deepEqual(entry.discovered_constraints, ["Never log secrets"]);
    assert.deepEqual(entry.completed_subtasks, ["Add error handling", "Wire config"]);

    // And the compiled round-2 response derives the agent_declared milestone
    const r2 = engine.invokeLoopCompile(
      { ...request("driver-cross-round"), round: 2 },
      undefined,
      { persistLineage: false },
    );
    const milestones = r2.response?.rolling_summary?.milestones ?? [];
    assert.ok(
      milestones.some((m) => m.kind === "agent_declared"),
      `expected agent_declared milestone, got ${JSON.stringify(milestones)}`,
    );
    assert.equal(milestones[0].label, "Phase 1 done");
  });
});
