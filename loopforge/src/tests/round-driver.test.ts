import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LoopForgeEngine } from "../engine.js";
import { RoundDriver } from "../round-driver.js";
import {
  makeExecutionReport,
  makeLoopCompileRequest,
  makeSelfEvaluation,
} from "../protocol.js";
import type { LoopCompileRequest } from "../protocol.js";
import { deriveSubGoalId } from "../subgoal-state.js";
import { MemoryLoopStore, installTestCommandProvider, criterionClaims } from "./_helpers.js";
import { queryLoopEntries } from "../loop-store.js";
import { deriveEvidenceCapability } from "../evidence-provider.js";
import { loadCommittedHistory } from "../history.js";
import { getPolicy } from "../policy.js";

// v3.3: success claims need machine-backed evidence — the RoundDriver
// collects evidence via the real collector, so a passing command provider
// keeps R8 / success_unverified silent in these flows.
installTestCommandProvider();

function request(loopId: string): LoopCompileRequest {
  return makeLoopCompileRequest({
    task: "Implement a durable transaction boundary",
    loop_id: loopId,
    round: 1,
    max_rounds: 4,
  });
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

  it("v3.8.1: the capability of a prepared round is the ONE derivation, read where it is used", async () => {
    // The prepared round used to CARRY this fact in a field no production
    // consumer read: the surfaces that speak about capability (MCP
    // start/next/status, the warning list) call the derivation themselves,
    // with the same policy and the same baseline. v3.8.1 deleted the field —
    // a second copy of a fact is a second thing that can go stale.
    const prepared = await new RoundDriver(
      new LoopForgeEngine(new MemoryLoopStore()),
    ).prepare(request("driver-capability"), "driver-capability", 1);
    assert.ok(prepared);

    const capability = deriveEvidenceCapability(getPolicy(), prepared.evidenceBaseline);
    // installTestCommandProvider configures "verify" (enabled, after-phase).
    assert.equal(capability.schemaVersion, 1);
    assert.deepEqual(
      capability.commands.map((command) => [command.commandId, command.ready]),
      [["verify", true]],
    );
    assert.equal(capability.contractVerificationAvailable, true);
    assert.deepEqual(
      capability.providers.map((provider) => provider.providerId),
      ["git"],
      "the default policy configures the git provider",
    );
    assert.deepEqual(capability.warnings, [],
      "a configured provider and an enabled command need no warning");
  });

  it("compiles a new L0 artifact for a rejected attempt without a commit", async () => {
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
      queryLoopEntries(store, "driver-retry", { prefix: "loop:driver-retry:r1" }).length,
      0,
      "a compile or retry writes no Vault history",
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
      }),
    });
    const c1 = await driver.complete({
      snapshot: p1!.snapshot,
      loopId: "driver-cross-round",
      task: "Implement a durable transaction boundary",
      maxRounds: 4,
      selfEval: eval1,
      consecutiveRejections: 0,
    });
    assert.equal(c1.outcome.result.action, "continue");

    // The round-2 compile context must carry the committed round's truth.
    const history = loadCommittedHistory(engine.getStore(), "driver-cross-round");
    assert.equal(history.rounds.length, 1);
    const view = history.rounds[0]!;
    assert.equal(view.evaluation?.output_summary, "Implemented the parser.");
    assert.equal(view.evaluation?.compression_checkpoint, true);
    assert.equal(view.evaluation?.checkpoint_label, "Phase 1 done");
    assert.deepEqual(view.executionReport, eval1.execution_report);
    assert.deepEqual(view.evaluation?.discovered_constraints, ["Never log secrets"]);
    assert.deepEqual(view.evaluation?.subgoal_updates, [
      { id: deriveSubGoalId("driver-cross-round", 1, 0, "Add error handling"), status: "done" },
      { id: deriveSubGoalId("driver-cross-round", 1, 1, "Wire config"), status: "done" },
    ]);

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
          }),
        }),
        consecutiveRejections: 0,
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
