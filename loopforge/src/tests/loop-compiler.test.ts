import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alignTask,
  buildRollingSummary,
  compileLoop,
  computeGoalTextHash,
  decideLevel,
  deriveGoalId,
} from "../loop-compiler.js";
import {
  makeLoopCompileRequest,
  makeLoopObjective,
  makeLoopRoundResult,
} from "../protocol.js";
import { resetPolicy } from "../policy.js";

describe("cognitive-state compiler", () => {
  beforeEach(() => resetPolicy());

  it("derives deterministic goal identity", () => {
    assert.equal(computeGoalTextHash("A  durable task"), computeGoalTextHash("A durable task"));
    assert.equal(deriveGoalId("loop", "Task", "explicit"), "explicit");
    assert.match(deriveGoalId("loop", "Durable Task"), /^loop:/);
  });

  it("uses L2 first, L1 for normal continuation, and L0 for empty failed retry", () => {
    const first = makeLoopCompileRequest({ loop_id: "levels", task: "Do work" });
    assert.equal(decideLevel(first, null), "l2");
    const vault = {
      results: [{
        loop_id: "levels",
        loop_lineage: {
          loop_id: "levels",
          round: 1,
          goal_id: deriveGoalId("levels", "Do work"),
          task: "Do work",
          constraints_active: [],
          recompile_level: "l2",
        },
      }],
    };
    const continuing = makeLoopCompileRequest({
      loop_id: "levels", round: 2, task: "Do work",
      last_round_result: makeLoopRoundResult({ success: true }),
    });
    assert.equal(decideLevel(continuing, vault), "l1");
    continuing.last_round_result = makeLoopRoundResult({ success: false });
    assert.equal(decideLevel(continuing, vault), "l0");
  });

  it("renders one hashed prompt artifact without a reasoning technique", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "artifact",
      task: "Implement atomic state",
      constraints_from_plan: ["Preserve user data"],
      max_rounds: 5,
    }), null);
    assert.ok(response.prompt_artifact);
    assert.equal(response.prompt, response.prompt_artifact.renderedPrompt);
    assert.equal(response.prompt_artifact.level, "l2");
    assert.match(response.prompt_artifact.promptHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(response.prompt, /Technique Selection|tree-of-thought|few-shot/i);
    assert.match(response.prompt, /Preserve user data/);
  });

  it("evolves discoveries, objective refinements, retractions, and evidence", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "evolution",
      round: 2,
      task: "Finish migration",
      force_level: "l2",
      loop_objective: makeLoopObjective({
        loop_id: "evolution",
        objective: "Migrate safely",
        success_criteria: ["All tests pass"],
        hard_constraints: ["No data loss"],
      }),
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: false,
        output_summary: "Migrated schema",
        discovered_constraints: ["Keep rollback path"],
        objective_refinement: "Include rollback verification",
        retracted_constraints: ["Temporary freeze"],
        wrong_assumptions: ["Migration was reversible"],
        emerged_subtasks: ["Verify rollback"],
        next_action: "Run rollback test",
        execution_evidence: {
          files_changed: ["src/store.ts"],
          test_results: { passed: 10, failed: 1, skipped: 0 },
          success_criteria_met: [],
          success_criteria_remaining: ["All tests pass"],
          progress_estimate: 0.7,
        },
      }),
    }), null);
    assert.ok(response.constraints_active.includes("Keep rollback path"));
    assert.ok(response.constraints_retired.includes("Temporary freeze"));
    assert.match(response.prompt, /rollback verification|Run rollback test/);
    assert.match(response.state_file_content ?? "", /src\/store\.ts|10 passed/);
  });

  it("keeps mandatory verification findings in an L0 retry", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "retry",
      round: 3,
      attempt: 2,
      task: "Verify result",
      rejection_notice: "Required command failed",
      verification_flags: [{
        severity: "error",
        field: "success",
        check: "required_evidence_failed",
        detail: "npm test exited with code 1",
      }],
    }), null);
    assert.equal(response.prompt_artifact?.level, "l0");
    assert.match(response.prompt, /Attempt: 2/);
    assert.match(response.prompt, /Required command failed/);
    assert.match(response.prompt, /npm test exited with code 1/);
  });

  it("computes objective alignment and rolling outcomes without technique metadata", () => {
    const request = makeLoopCompileRequest({
      loop_id: "health",
      round: 2,
      task: "Fix storage transaction",
      loop_objective: makeLoopObjective({
        objective: "Fix storage transaction",
        success_criteria: ["Recovery works"],
      }),
    });
    assert.ok(alignTask(request.task, request, null).alignment_score > 0.3);
    const rolling = buildRollingSummary("health", 3, {
      results: [{
        loop_id: "health",
        output_summary: "Recovery now works",
        success: true,
        loop_lineage: { loop_id: "health", round: 2 },
      }],
    });
    assert.deepEqual(rolling?.key_outcomes, ["[R2] accepted: Recovery now works"]);
  });

  // ── PromptArtifact determinism + attempt differentiation ────────────────
  // AGENTS.md hotspot: "Prompt changes require PromptArtifact budget,
  // hashing, and same-round retry coverage."

  it("produces deterministic prompt hashes for identical inputs", () => {
    const request = makeLoopCompileRequest({
      loop_id: "det",
      round: 2,
      task: "Implement atomic state",
      constraints_from_plan: ["Preserve user data"],
    });
    const a = compileLoop(request, null);
    const b = compileLoop(request, null);
    assert.equal(a.prompt_artifact?.promptHash, b.prompt_artifact?.promptHash);
    assert.equal(a.prompt, b.prompt);
  });

  it("produces different hashes for different attempt numbers on same round", () => {
    const base = makeLoopCompileRequest({
      loop_id: "attempts",
      round: 3,
      task: "Verify result",
      rejection_notice: "Required command failed",
    });
    const a1 = compileLoop({ ...base, attempt: 1 }, null);
    const a2 = compileLoop({ ...base, attempt: 2 }, null);
    assert.notEqual(a1.prompt_artifact?.promptHash, a2.prompt_artifact?.promptHash);
  });

  it("honors L0 budget ceiling in prompt artifact", () => {
    // L0 budget is 3000 chars. The compiler should respect this.
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "budget",
      round: 3,
      attempt: 2,
      task: "Verify result",
      rejection_notice: "Required command failed",
      verification_flags: [{
        severity: "error",
        field: "success",
        check: "required_evidence_failed",
        detail: "npm test exited with code 1",
      }],
    }), null);
    assert.equal(response.prompt_artifact?.level, "l0");
    // L0 max is 3000 chars per policy — rendered prompt must be within budget
    assert.ok(
      (response.prompt?.length ?? 0) <= 3000,
      `L0 prompt length ${response.prompt?.length} exceeds 3000 char budget`,
    );
  });
});
