import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LoopForgeEngine } from "../engine.js";
import { RoundDriver } from "../round-driver.js";
import {
  Mode,
  makeExecutionReport,
  makeSelfEvaluation,
} from "../protocol.js";
import type { LoopForgeRequest } from "../protocol.js";
import { deriveSubGoalId } from "../subgoal-state.js";
import { MemoryLoopStore, installTestCommandProvider, criterionClaims } from "./_helpers.js";
import { queryLoopEntries } from "../loop-store.js";
import { deriveEvidenceCapability } from "../evidence-provider.js";
import { getPolicy } from "../policy.js";

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

  it("v3.8: prepare() returns the derived EvidenceCapability", async () => {
    const prepared = await new RoundDriver(
      new LoopForgeEngine(new MemoryLoopStore()),
    ).prepare(request("driver-capability"), "driver-capability", 1);

    assert.ok(prepared);
    // installTestCommandProvider configures "verify" (enabled, after-phase).
    assert.equal(prepared.capability.schemaVersion, 1);
    assert.deepEqual(
      prepared.capability.commands.map((command) => [command.commandId, command.ready]),
      [["verify", true]],
    );
    assert.equal(prepared.capability.contractVerificationAvailable, true);
    assert.deepEqual(
      prepared.capability.providers.map((provider) => provider.providerId),
      ["git"],
      "the default policy configures the git provider",
    );
    assert.deepEqual(prepared.capability.warnings, [],
      "a configured provider and an enabled command need no warning");
    // The prepared capability is the SAME fact the CLI-side surfaces derive.
    assert.deepEqual(
      prepared.capability,
      deriveEvidenceCapability(getPolicy(), prepared.evidenceBaseline),
    );
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
      subgoal_updates: [
        { id: deriveSubGoalId("driver-cross-round", 1, 0, "Add error handling"), status: "done" },
        { id: deriveSubGoalId("driver-cross-round", 1, 1, "Wire config"), status: "done" },
      ],
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims(["cr-11111111", "Parser handles edge cases"], []),
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
    assert.deepEqual(lin.execution_report, eval1.execution_report);
    assert.deepEqual(entry.discovered_constraints, ["Never log secrets"]);
    assert.deepEqual(entry.subgoal_updates, [
      { id: deriveSubGoalId("driver-cross-round", 1, 0, "Add error handling"), status: "done" },
      { id: deriveSubGoalId("driver-cross-round", 1, 1, "Wire config"), status: "done" },
    ]);

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

  it("rebuilds an equivalent state file from the vault after deletion", async () => {
    // v3.7.1: the state file is a derived view — deleting it must never lose
    // state. A recompile of the same round (same attempt) writes back
    // byte-identical content rebuilt from committed facts. The state
    // directory is workspace-contained (policy enforcement), so the default
    // `.loopforge/state` under the workspace is used and cleaned up.
    const loopId = "driver-state-rebuild";
    const store = new MemoryLoopStore();
    const engine = new LoopForgeEngine(store);
    const driver = new RoundDriver(engine, store);
    const statePath = join(process.cwd(), ".loopforge", "state", `${loopId}-state.md`);
    rmSync(statePath, { force: true });
    try {
      const p1 = await driver.prepare(request(loopId), loopId, 1);
      assert.ok(p1, "round 1 must prepare");
      const c1 = await driver.complete({
        snapshot: p1!.snapshot,
        loopId,
        task: request(loopId).task,
        maxRounds: 4,
        selfEval: makeSelfEvaluation({
          success: false,
          output_summary: "Implemented the durable boundary.",
          constraint_violations: [],
          should_continue: true,
          execution_report: makeExecutionReport({
            files_changed: ["src/store.ts"],
            tests_reported: { passed: 1, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims([], ["Finish the task"]),
            progress_estimate: 0.4,
          }),
        }),
        consecutiveRejections: 0,
        successTrajectory: [],
      });
      assert.equal(c1.outcome.result.action, "continue");
      assert.ok(existsSync(statePath), "round-1 commit writes the state file");
      const first = readFileSync(statePath, "utf8");
      assert.ok(first.includes("**Derived**: true"), "derived metadata present");

      // Round 2 compiles twice; deleting the file between compiles must not
      // change the rebuilt content.
      const p2 = await driver.prepare(
        { ...request(loopId), round: 2 },
        loopId,
        2,
      );
      assert.ok(p2, "first round-2 prepare must succeed");
      const second = readFileSync(statePath, "utf8");
      assert.ok(second.includes("round 2"), "round metadata advances");

      rmSync(statePath, { force: true });
      const p2b = await driver.prepare(
        { ...request(loopId), round: 2 },
        loopId,
        2,
      );
      assert.ok(p2b, "re-prepare after deletion must succeed");
      const rebuilt = readFileSync(statePath, "utf8");
      assert.equal(rebuilt, second, "deleted state file rebuilds byte-identically");
    } finally {
      rmSync(statePath, { force: true });
    }
  });
});
