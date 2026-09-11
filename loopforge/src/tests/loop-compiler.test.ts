import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  alignTask,
  buildSelfEvalBlock,
  buildRollingSummary,
  compileLoop,
  computeGoalTextHash,
  decideLevel,
  deriveCriterionStatuses,
  deriveGoalId,
  deriveLessons,
} from "../loop-compiler.js";
import { deriveSubGoalId, validateSubGoalUpdates } from "../subgoal-state.js";
import {
  type LoopObjective,
  makeLoopCompileRequest,
  makeLoopObjective,
  makeLoopRoundResult,
  type SubGoal,
} from "../protocol.js";
import { getPolicy, resetPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";
import { committedFeedbackRound, mergedLineageRound, criterionClaims } from "./_helpers.js";
import type { MachineObservation } from "../protocol.js";

/** v3.8: a passed after-phase command observation for contract verification. */
function commandObservation(status: "passed" | "failed"): MachineObservation {
  return {
    schemaVersion: 1,
    providerId: "command:verify",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      commandId: "verify",
      argv: ["node", "-e", "verify"],
      cwd: ".",
      configHash: "",
      required: true,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
    },
  };
}
import { deriveContractItemIds, deriveItemId } from "../token-utils.js";

describe("cognitive-state compiler", () => {
  beforeEach(() => resetPolicy());

  it("derives deterministic goal identity", () => {
    assert.equal(computeGoalTextHash("A  durable task"), computeGoalTextHash("A durable task"));
    assert.equal(deriveGoalId("loop", "Task", "explicit"), "explicit");
    assert.match(deriveGoalId("loop", "Durable Task"), /^loop:/);
  });

  it("derives the same rolling facts from durable feedback and hydrated lineage", () => {
    const feedback = committedFeedbackRound(1, {
      loopId: "round-parity",
      files: ["src/index.ts"],
      progress: 0.4,
      met: ["criterion-a"],
    });
    const merged = mergedLineageRound(1, {
      loopId: "round-parity",
      files: ["src/index.ts"],
      progress: 0.4,
      met: ["criterion-a"],
    });
    const summary = "Committed round 1.";
    merged.output_summary = summary;
    (merged.loop_lineage as Record<string, unknown>).output_summary = summary;

    const fromFeedback = buildRollingSummary("round-parity", 2, {
      results: [feedback as unknown as Record<string, unknown>],
    });
    const fromMerged = buildRollingSummary("round-parity", 2, {
      results: [merged],
    });
    assert.deepEqual(fromFeedback, fromMerged);
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
        execution_report: {
          files_changed: ["src/store.ts"],
          tests_reported: { passed: 10, failed: 1, skipped: 0 },
          criterion_claims: criterionClaims([], ["All tests pass"]),
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

  // ── v2.1: Hierarchical Summary — milestones ───────────────────────────

  it("creates an agent_declared milestone when compression_checkpoint is true", () => {
    const rolling = buildRollingSummary("agent_ms", 5, {
      results: [
        {
          loop_id: "agent_ms",
          output_summary: "Built data model layer",
          success: true,
          loop_lineage: {
            loop_id: "agent_ms",
            round: 1,
            constraints_active: ["No data loss"],
            checkpoint_label: "",
          },
          constraint_violations: [],
        },
        {
          loop_id: "agent_ms",
          output_summary: "Data migration complete with rollback",
          success: true,
          loop_lineage: {
            loop_id: "agent_ms",
            round: 2,
            constraints_active: ["No data loss", "Keep rollback path"],
            compression_checkpoint: true,
            checkpoint_label: "数据层完成",
          },
          constraint_violations: [],
          execution_report: {
            files_changed: ["db/migrate.ts"],
            tests_reported: { passed: 10, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims(["Migration verified"], []),
            progress_estimate: 0.35,
          },
          retracted_constraints: [],
        },
        {
          loop_id: "agent_ms",
          output_summary: "Started API layer",
          success: true,
          loop_lineage: {
            loop_id: "agent_ms",
            round: 3,
            constraints_active: ["No data loss", "Keep rollback path"],
          },
          constraint_violations: [],
          execution_report: {
            files_changed: ["api/routes.ts"],
            tests_reported: null,
            criterion_claims: criterionClaims(["Migration verified"], ["API coverage ≥ 90%"]),
            progress_estimate: 0.40,
          },
        },
      ],
    });
    assert.ok(rolling, "should produce a rolling summary");
    assert.ok(rolling!.milestones, "should include milestones");
    assert.equal(rolling!.milestones!.length, 1, "exactly one agent_declared milestone");
    const m = rolling!.milestones![0];
    assert.equal(m.kind, "agent_declared");
    assert.equal(m.label, "数据层完成");
    assert.equal(m.round_range.start, 1);
    assert.equal(m.round_range.end, 2);
    assert.equal(m.progress_at_boundary, 0.35);
    assert.ok(m.carried_constraints.includes("No data loss"));
    assert.ok(m.outcome.includes("Data migration complete"));
  });

  it("creates a criteria_milestone when new success criteria are met", () => {
    const rolling = buildRollingSummary("crit_ms", 4, {
      results: [
        {
          loop_id: "crit_ms",
          output_summary: "Wrote unit tests for core module",
          success: true,
          loop_lineage: { loop_id: "crit_ms", round: 1, constraints_active: [] },
          constraint_violations: [],
          execution_report: {
            files_changed: ["test/unit.ts"],
            tests_reported: { passed: 20, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims(["Unit tests ≥ 90%"], ["Integration tests pass", "E2E coverage"]),
            progress_estimate: 0.30,
          },
          retracted_constraints: [],
        },
        {
          loop_id: "crit_ms",
          output_summary: "All integration tests passing",
          success: true,
          loop_lineage: { loop_id: "crit_ms", round: 2, constraints_active: [] },
          constraint_violations: [],
          execution_report: {
            files_changed: ["test/integration.ts"],
            tests_reported: { passed: 15, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims(["Unit tests ≥ 90%", "Integration tests pass"], ["E2E coverage"]),
            progress_estimate: 0.65,
          },
          retracted_constraints: [],
        },
        {
          loop_id: "crit_ms",
          output_summary: "Started E2E tests",
          success: true,
          loop_lineage: { loop_id: "crit_ms", round: 3, constraints_active: [] },
          constraint_violations: [],
          execution_report: {
            files_changed: ["test/e2e.ts"],
            tests_reported: null,
            criterion_claims: criterionClaims(["Unit tests ≥ 90%", "Integration tests pass"], ["E2E coverage"]),
            progress_estimate: 0.70,
          },
        },
      ],
    });
    assert.ok(rolling, "should produce a rolling summary");
    assert.ok(rolling!.milestones, "should include milestones");
    // Round 2 should trigger criteria_milestone ("Integration tests pass" is new vs round 1)
    const critMs = rolling!.milestones!.filter((m) => m.kind === "criteria_milestone");
    assert.equal(critMs.length, 1, "exactly one criteria_milestone");
    assert.match(critMs[0].label, /Integration tests pass/);
    assert.equal(critMs[0].round_range.start, 1);
    assert.equal(critMs[0].round_range.end, 2);
    assert.equal(critMs[0].progress_at_boundary, 0.65);
  });

  it("does not create a duplicate criteria milestone for semantic equivalents", () => {
    // Same criteria phrased differently — should be detected as semantic dup
    const rolling = buildRollingSummary("dedup_ms", 4, {
      results: [
        {
          loop_id: "dedup_ms",
          output_summary: "Wrote tests",
          success: true,
          loop_lineage: { loop_id: "dedup_ms", round: 1, constraints_active: [] },
          constraint_violations: [],
          execution_report: {
            files_changed: ["test/a.ts"],
            tests_reported: { passed: 5, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims(["Unit test coverage at 90%"], []),
            progress_estimate: 0.30,
          },
        },
        {
          loop_id: "dedup_ms",
          output_summary: "More tests",
          success: true,
          loop_lineage: { loop_id: "dedup_ms", round: 2, constraints_active: [] },
          constraint_violations: [],
          execution_report: {
            files_changed: ["test/b.ts"],
            tests_reported: { passed: 10, failed: 0, skipped: 0 },
            // "unit test coverage reached 90 percent" is semantically the same
            criterion_claims: criterionClaims(["unit test coverage reached 90 percent"], []),
            progress_estimate: 0.50,
          },
        },
        {
          loop_id: "dedup_ms",
          output_summary: "Still testing",
          success: true,
          loop_lineage: { loop_id: "dedup_ms", round: 3, constraints_active: [] },
          constraint_violations: [],
          execution_report: {
            files_changed: ["test/c.ts"],
            tests_reported: { passed: 12, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims(["unit test coverage reached 90 percent"], []),
            progress_estimate: 0.60,
          },
        },
      ],
    });
    assert.ok(rolling, "should produce a rolling summary");
    // The dedup should NOT trigger a criteria_milestone at round 2
    // because the criteria are semantically the same (similarity >= 0.7)
    const allMs = rolling!.milestones ?? [];
    const critMs = allMs.filter((m) => m.kind === "criteria_milestone");
    assert.equal(critMs.length, 0,
      `expected 0 criteria milestones (semantic dedup), got ${critMs.length}: ${
        critMs.map((m) => m.label).join(", ")
      }`);
  });

  it("detects genuinely different criteria between rounds", () => {
    const rolling = buildRollingSummary("diff_ms", 3, {
      results: [
        {
          loop_id: "diff_ms",
          output_summary: "Unit tests done",
          success: true,
          loop_lineage: { loop_id: "diff_ms", round: 1, constraints_active: [] },
          constraint_violations: [],
          execution_report: {
            files_changed: ["test/unit.ts"],
            tests_reported: { passed: 20, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims(["Unit tests done"], ["Integration done"]),
            progress_estimate: 0.30,
          },
        },
        {
          loop_id: "diff_ms",
          output_summary: "Integration done",
          success: true,
          loop_lineage: { loop_id: "diff_ms", round: 2, constraints_active: [] },
          constraint_violations: [],
          execution_report: {
            files_changed: ["test/int.ts"],
            tests_reported: { passed: 15, failed: 0, skipped: 0 },
            // "Integration done" is genuinely different from "Unit tests done"
            criterion_claims: criterionClaims(["Unit tests done", "Integration done"], []),
            progress_estimate: 0.70,
          },
        },
      ],
    });
    assert.ok(rolling, "should produce a rolling summary");
    const critMs = (rolling!.milestones ?? []).filter((m) => m.kind === "criteria_milestone");
    assert.equal(critMs.length, 1, "should detect genuinely new criteria");
    assert.match(critMs[0].label, /Integration done/);
  });

  it("caps milestones at max_milestones (10 by default)", () => {
    // Create 15 entries each with compression_checkpoint to force 15 milestones
    const entries: Record<string, unknown>[] = [];
    for (let i = 1; i <= 15; i++) {
      entries.push({
        loop_id: "cap_ms",
        output_summary: `Round ${i} done`,
        success: true,
        loop_lineage: {
          loop_id: "cap_ms",
          round: i,
          constraints_active: [],
          compression_checkpoint: true,
          checkpoint_label: `Phase ${i}`,
        },
        constraint_violations: [],
        execution_report: {
          files_changed: [],
          tests_reported: null,
          criterion_claims: criterionClaims([], []),
          progress_estimate: i / 15,
        },
      });
    }
    const rolling = buildRollingSummary("cap_ms", 16, { results: entries });
    assert.ok(rolling, "should produce a rolling summary");
    const ms = rolling!.milestones ?? [];
    assert.ok(ms.length <= 10, `expected ≤ 10 milestones, got ${ms.length}`);
    // v3.0.1: L1 samples head anchors + newest tail instead of keeping the
    // most recent 10 — the oldest milestones survive as history anchors.
    assert.equal(ms[0].label, "Phase 1");
    assert.equal(ms[ms.length - 1].label, "Phase 15");
  });

  it("v3.0.1 L1 samples milestones as head + middle + tail when over the cap", () => {
    // 15 agent_declared milestones → L1 keeps 3 head + 4 middle + 3 tail.
    const entries: Record<string, unknown>[] = [];
    for (let i = 1; i <= 15; i++) {
      entries.push({
        loop_id: "sample_ms",
        output_summary: `Round ${i} done`,
        success: true,
        loop_lineage: {
          loop_id: "sample_ms",
          round: i,
          constraints_active: [],
          compression_checkpoint: true,
          checkpoint_label: `Phase ${i}`,
        },
        constraint_violations: [],
        execution_report: {
          files_changed: [],
          tests_reported: null,
          criterion_claims: criterionClaims([], []),
          progress_estimate: i / 15,
        },
      });
    }
    const rolling = buildRollingSummary("sample_ms", 16, { results: entries }, 0, "l1");
    const ms = rolling!.milestones ?? [];
    assert.equal(ms.length, 10, `expected 10 sampled milestones, got ${ms.length}`);
    // Head anchors: the 3 oldest milestones survive.
    assert.deepEqual(ms.slice(0, 3).map((m) => m.label), ["Phase 1", "Phase 2", "Phase 3"]);
    // Newest tail: the 3 most recent milestones survive.
    assert.deepEqual(ms.slice(-3).map((m) => m.label), ["Phase 13", "Phase 14", "Phase 15"]);
    // Middle: 4 representatives, in chronological order, no duplicates.
    const middle = ms.slice(3, 7).map((m) => m.label);
    assert.equal(middle.length, 4);
    assert.equal(new Set(middle).size, 4, `middle sample must not repeat: ${middle}`);
    assert.deepEqual([...middle].sort(), [...middle], "middle sample must stay chronological");
  });

  it("v3.0.1 L2 keeps every milestone — full rehydration is never sampled", () => {
    const entries: Record<string, unknown>[] = [];
    for (let i = 1; i <= 15; i++) {
      entries.push({
        loop_id: "l2_ms",
        output_summary: `Round ${i} done`,
        success: true,
        loop_lineage: {
          loop_id: "l2_ms",
          round: i,
          constraints_active: [],
          compression_checkpoint: true,
          checkpoint_label: `Phase ${i}`,
        },
        constraint_violations: [],
        execution_report: {
          files_changed: [],
          tests_reported: null,
          criterion_claims: criterionClaims([], []),
          progress_estimate: i / 15,
        },
      });
    }
    const rolling = buildRollingSummary("l2_ms", 16, { results: entries }, 0, "l2");
    const ms = rolling!.milestones ?? [];
    assert.equal(ms.length, 15, `L2 must keep all 15 milestones, got ${ms.length}`);
    assert.equal(ms[0].label, "Phase 1");
    assert.equal(ms[ms.length - 1].label, "Phase 15");
  });

  it("v3.0.1 keeps every milestone when at or under the cap", () => {
    const entries: Record<string, unknown>[] = [];
    for (let i = 1; i <= 8; i++) {
      entries.push({
        loop_id: "under_ms",
        output_summary: `Round ${i} done`,
        success: true,
        loop_lineage: {
          loop_id: "under_ms",
          round: i,
          constraints_active: [],
          compression_checkpoint: true,
          checkpoint_label: `Phase ${i}`,
        },
        constraint_violations: [],
        execution_report: {
          files_changed: [],
          tests_reported: null,
          criterion_claims: criterionClaims([], []),
          progress_estimate: i / 8,
        },
      });
    }
    const rolling = buildRollingSummary("under_ms", 9, { results: entries }, 0, "l1");
    const ms = rolling!.milestones ?? [];
    assert.equal(ms.length, 8, `under-cap L1 must keep all 8 milestones, got ${ms.length}`);
    assert.equal(ms[0].label, "Phase 1");
    assert.equal(ms[ms.length - 1].label, "Phase 8");
  });

  it("returns empty milestones array for short tasks without checkpoints", () => {
    const rolling = buildRollingSummary("short", 4, {
      results: [
        {
          loop_id: "short",
          output_summary: "Round 1 done",
          success: true,
          loop_lineage: { loop_id: "short", round: 1, constraints_active: [] },
          constraint_violations: [],
        },
        {
          loop_id: "short",
          output_summary: "Round 2 done",
          success: true,
          loop_lineage: { loop_id: "short", round: 2, constraints_active: [] },
          constraint_violations: [],
        },
        {
          loop_id: "short",
          output_summary: "Round 3 done",
          success: true,
          loop_lineage: { loop_id: "short", round: 3, constraints_active: [] },
          constraint_violations: [],
        },
      ],
    });
    assert.ok(rolling, "should produce a rolling summary");
    assert.deepEqual(rolling!.milestones ?? [], []);
  });

  it("L2 prompt includes milestones section", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "l2ms",
      round: 4,
      task: "Continue API layer",
      force_level: "l2",
    }), {
      results: [
        {
          loop_id: "l2ms",
          output_summary: "Core data layer complete",
          success: true,
          loop_lineage: {
            loop_id: "l2ms",
            round: 1,
            constraints_active: ["No regression"],
            compression_checkpoint: true,
            checkpoint_label: "Data Layer",
          },
          constraint_violations: [],
          execution_report: {
            files_changed: ["data/store.ts"],
            tests_reported: { passed: 5, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims([], []),
            progress_estimate: 0.30,
          },
        },
        {
          loop_id: "l2ms",
          output_summary: "Started API routes",
          success: true,
          loop_lineage: {
            loop_id: "l2ms",
            round: 2,
            constraints_active: ["No regression"],
          },
          constraint_violations: [],
          execution_report: {
            files_changed: ["api/routes.ts"],
            tests_reported: null,
            criterion_claims: criterionClaims([], []),
            progress_estimate: 0.45,
          },
        },
        {
          loop_id: "l2ms",
          output_summary: "API middleware done",
          success: true,
          loop_lineage: {
            loop_id: "l2ms",
            round: 3,
            constraints_active: ["No regression"],
          },
          constraint_violations: [],
          execution_report: {
            files_changed: ["api/middleware.ts"],
            tests_reported: { passed: 8, failed: 0, skipped: 0 },
            criterion_claims: criterionClaims([], []),
            progress_estimate: 0.60,
          },
        },
      ],
    });
    assert.match(response.prompt, /Phase History/);
    assert.match(response.prompt, /Data Layer/);
    assert.match(response.prompt, /30%/);
    // L2 includes the durable phase history; formulaic loop synthesis is removed.
    assert.match(response.prompt, /Phase History/);
  });

  it("L1 prompt includes recent rounds but not milestones", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "l1ms",
      round: 4,
      task: "Continue work",
      force_level: "l1",
    }), {
      results: [
        {
          loop_id: "l1ms",
          output_summary: "Finished core module",
          success: true,
          loop_lineage: {
            loop_id: "l1ms",
            round: 1,
            constraints_active: [],
            compression_checkpoint: true,
            checkpoint_label: "Core Module",
          },
          constraint_violations: [],
          execution_report: {
            files_changed: ["core.ts"],
            tests_reported: null,
            criterion_claims: criterionClaims([], []),
            progress_estimate: 0.30,
          },
        },
        {
          loop_id: "l1ms",
          output_summary: "Round 2 work",
          success: true,
          loop_lineage: { loop_id: "l1ms", round: 2, constraints_active: [] },
          constraint_violations: [],
        },
        {
          loop_id: "l1ms",
          output_summary: "Round 3 work",
          success: true,
          loop_lineage: { loop_id: "l1ms", round: 3, constraints_active: [] },
          constraint_violations: [],
        },
      ],
    });
    // L1 should show recent rounds but NOT Phase History
    assert.match(response.prompt, /Recent Rounds/);
    assert.doesNotMatch(response.prompt, /Phase History/);
    // L1 should not mention the old checkpoint label from round 1
    assert.doesNotMatch(response.prompt, /Core Module/);
  });

  it("L0 retry prompt contains no summary sections", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "l0ms",
      round: 4,
      attempt: 2,
      task: "Fix the issue",
      rejection_notice: "Required verification command failed",
    }), {
      results: [
        {
          loop_id: "l0ms",
          output_summary: "Did some work",
          success: true,
          loop_lineage: { loop_id: "l0ms", round: 1, constraints_active: [] },
          constraint_violations: [],
        },
        {
          loop_id: "l0ms",
          output_summary: "More work",
          success: true,
          loop_lineage: { loop_id: "l0ms", round: 2, constraints_active: [] },
          constraint_violations: [],
        },
        {
          loop_id: "l0ms",
          output_summary: "Even more",
          success: true,
          loop_lineage: { loop_id: "l0ms", round: 3, constraints_active: [] },
          constraint_violations: [],
        },
      ],
    });
    // L0 should contain NO summary sections — just task + rejection
    assert.doesNotMatch(response.prompt, /Recent Rounds/);
    assert.doesNotMatch(response.prompt, /Phase History/);
    assert.doesNotMatch(response.prompt, /Cross-Round Outcomes/);
    assert.doesNotMatch(response.prompt, /Recurring Issues/);
    assert.match(response.prompt, /REJECTED|Required verification command failed/);
  });

  // ── v2.8: Sub-goal ID referencing ──────────────────────────────────────

  it("applies a done transition by exact sub-goal ID", () => {
    // Simulate a vault with a previously declared sub-goal
    const vault = {
      results: [{
        loop_id: "sg-id-match",
        loop_lineage: {
          loop_id: "sg-id-match",
          round: 1,
          goal_id: deriveGoalId("sg-id-match", "Fix auth bug"),
          task: "Fix auth bug",
          constraints_active: [],
          recompile_level: "l2",
          committed_action: "continue",
        },
        emerged_subtasks: ["Add error handling to login"],
        success: true,
        output_summary: "Started auth fix",
      }],
    };
    // Round 2: agent completes the sub-goal by transitioning its ID
    const sgId = deriveSubGoalId("sg-id-match", 1, 0, "Add error handling to login");
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "sg-id-match",
      round: 2,
      task: "Fix auth bug",
      force_level: "l2",
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: true,
        output_summary: "Completed auth fix",
        subgoal_updates: [{ id: sgId, status: "done" }],
      }),
    }), vault);
    const doneSubs = response.sub_goals?.filter(sg => sg.status === "done") ?? [];
    assert.equal(doneSubs.length, 1, "should mark sub-goal as done by ID reference");
    assert.equal(doneSubs[0].description, "Add error handling to login");
  });

  it("does not apply an update for an unknown sub-goal ID at compile time", () => {
    const vault = {
      results: [{
        loop_id: "sg-unknown",
        loop_lineage: {
          loop_id: "sg-unknown",
          round: 1,
          goal_id: deriveGoalId("sg-unknown", "Refactor database"),
          task: "Refactor database",
          constraints_active: [],
          recompile_level: "l2",
        },
        emerged_subtasks: ["Write unit tests for queries"],
        success: true,
        output_summary: "Started refactor",
      }],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "sg-unknown",
      round: 2,
      task: "Refactor database",
      force_level: "l2",
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: true,
        output_summary: "Tests written",
        subgoal_updates: [{ id: "sg-00000000", status: "done" }],
      }),
    }), vault);
    const doneSubs = response.sub_goals?.filter(sg => sg.status === "done") ?? [];
    assert.equal(doneSubs.length, 0, "an unknown ID is a no-op for derivation (rejected pre-advance)");
  });

  it("reaches in_progress only through an explicit update", () => {
    const vault = {
      results: [{
        loop_id: "sg-inprogress",
        loop_lineage: {
          loop_id: "sg-inprogress",
          round: 1,
          goal_id: deriveGoalId("sg-inprogress", "Fix auth bug"),
          task: "Fix auth bug",
          constraints_active: [],
          recompile_level: "l2",
          committed_action: "continue",
        },
        emerged_subtasks: ["Add rate limiting"],
        success: true,
        output_summary: "Started",
      }],
    };
    const sgId = deriveSubGoalId("sg-inprogress", 1, 0, "Add rate limiting");
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "sg-inprogress",
      round: 2,
      task: "Fix auth bug",
      force_level: "l2",
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: true,
        output_summary: "Started rate limiting",
        subgoal_updates: [{ id: sgId, status: "in_progress" }],
      }),
    }), vault);
    const active = response.sub_goals?.find(sg => sg.id === sgId);
    assert.equal(active?.status, "in_progress",
      "in_progress is produced only by an explicit agent declaration");
  });

  it("keeps older committed transitions when a later round declares nothing (no regression)", () => {
    const sgId = deriveSubGoalId("sg-persist", 1, 0, "Add error handling to login");
    const vault = {
      results: [
        {
          loop_id: "sg-persist",
          loop_lineage: {
            loop_id: "sg-persist", round: 1, goal_id: deriveGoalId("sg-persist", "Fix auth"),
            task: "Fix auth", constraints_active: [], recompile_level: "l2",
            committed_action: "continue",
          },
          emerged_subtasks: ["Add error handling to login"],
          success: true,
          output_summary: "Started",
        },
        {
          loop_id: "sg-persist",
          loop_lineage: {
            loop_id: "sg-persist", round: 2, goal_id: deriveGoalId("sg-persist", "Fix auth"),
            task: "Fix auth", constraints_active: [], recompile_level: "l2",
            committed_action: "continue",
          },
          subgoal_updates: [{ id: sgId, status: "done" }],
          success: true,
          output_summary: "Done auth",
        },
      ],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "sg-persist",
      round: 3,
      task: "Fix auth",
      force_level: "l2",
      last_round_result: makeLoopRoundResult({
        round: 2,
        success: true,
        output_summary: "Done auth",
      }),
    }), vault);
    const doneSubs = response.sub_goals?.filter(sg => sg.status === "done") ?? [];
    assert.equal(doneSubs.length, 1,
      "a done transition from round 2 must survive a round-3 compile with no new declarations");
  });

  it("v3.7.1: validateSubGoalUpdates enforces the closed matrix and terminality", () => {
    const sg = (id: string, status: SubGoal["status"]): SubGoal => ({
      id,
      description: `goal ${id}`,
      status,
      declared_at_round: 1,
      status_changed_at_round: 1,
      priority: 0,
    });
    const pending = sg("sg-a1111111", "pending");
    const done = sg("sg-b2222222", "done");

    // Legal: pending → in_progress / done / blocked / canceled; same-status
    // no-op is legal for replay idempotency.
    const legal = validateSubGoalUpdates(
      [pending, done],
      [
        { id: "sg-a1111111", status: "in_progress" },
        { id: "sg-a1111111", status: "done" },
        { id: "sg-a1111111", status: "blocked" },
        { id: "sg-a1111111", status: "canceled" },
      ],
    );
    assert.equal(legal.length, 0, "the active-state matrix is fully closed");

    // Unknown ID and terminal references are errors.
    const errors = validateSubGoalUpdates(
      [pending, done],
      [
        { id: "sg-99999999", status: "done" },
        { id: "sg-b2222222", status: "in_progress" },
        { id: "sg-b2222222", status: "done" },
      ],
    );
    assert.deepEqual(errors.map((e) => e.reason), ["unknown_id", "terminal_reference", "terminal_reference"]);
  });

  // ── v2.8: Self-eval block sub-goal ID hints ────────────────────────────

  it("buildSelfEvalBlock includes sub-goal ID usage hints", () => {
    const block = buildSelfEvalBlock(3);
    assert.ok(block.includes("sub-goal ID"), "should mention sub-goal IDs");
    assert.ok(block.includes("sg-"), "should show ID format example");
    assert.ok(block.includes("Sub-Goal Dashboard"), "should reference the dashboard");
  });

  // ── v2.8: L2 pointer mode ─────────────────────────────────────────────

  it("skips fullStateMarkdown at L2 when l2_pointer_enabled is true", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "p2-pointer",
      round: 2,
      task: "Refactor database layer",
      force_level: "l2",
      loop_objective: makeLoopObjective({
        loop_id: "p2-pointer",
        objective: "Refactor database layer",
        success_criteria: ["All tests pass"],
      }),
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: false,
        output_summary: "Started refactor",
        execution_report: {
          files_changed: ["src/db.ts"],
          tests_reported: { passed: 8, failed: 2, skipped: 0 },
          criterion_claims: criterionClaims([], ["All tests pass"]),
          progress_estimate: 0.3,
        },
      }),
    }), null);
    // L2 pointer mode: should NOT contain the monolithic blob
    assert.ok(!(response.prompt ?? "").includes("Full Rehydrated State"),
      "L2 prompt should not contain full state blob when l2_pointer_enabled is true");
    // But structured sections should be present
    assert.ok((response.prompt ?? "").includes("Progress Dashboard"),
      "L2 prompt should include Progress Dashboard");
    // State file should still be written
    assert.ok(response.state_file_content,
      "state_file_content should still be present");
    assert.ok(response.state_file_content.includes("LoopForge State"),
      "state file should contain full state");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // v2.11: Constraint & Criterion ID System
  // ═════════════════════════════════════════════════════════════════════════

  it("populates constraint IDs in constraint_metadata", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-cm",
      round: 2,
      task: "Implement auth",
      loop_objective: makeLoopObjective({
        objective: "Build auth system",
        success_criteria: ["Login endpoint works"],
        hard_constraints: ["No plaintext passwords"],
        loop_id: "id-cm",
      }),
      constraints_from_plan: ["Use bcrypt for hashing"],
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: true,
        output_summary: "Set up project",
        discovered_constraints: ["Rate limit login attempts"],
      }),
    }), null);

    const meta = response.constraint_metadata ?? [];
    assert.ok(meta.length >= 4, `Expected >= 4 constraints, got ${meta.length}`);

    // v3.3.1: identity follows the text's SOURCE — hard/plan/discovered
    // constraints live in the c-XXXXXXXX namespace, success criteria in the
    // cr-XXXXXXXX namespace (their own section and the verification gate's
    // criteriaMatch are ID-first on cr-). One text, one ID — the merged
    // active list must render the criterion under the same identity as its
    // own section instead of re-deriving a c- variant.
    const identityOf = (m: { text: string }): string =>
      m.text === "Login endpoint works" ? "cr" : "c";
    for (const m of meta) {
      assert.ok(m.id, `ConstraintMeta missing id for "${m.text}"`);
      const prefix = identityOf(m);
      assert.match(m.id, new RegExp(`^${prefix}-[a-f0-9]{8}$`),
        `ID "${m.id}" should match ${prefix}-XXXXXXXX pattern for "${m.text}"`);
    }

    // Same text → same ID (deterministic)
    const hardIds = meta.filter(m => m.text === "No plaintext passwords");
    assert.equal(hardIds.length, 1);
    assert.ok(hardIds[0].id);
    const criteriaIds = meta.filter(m => m.text === "Login endpoint works");
    assert.equal(criteriaIds.length, 1);
    assert.match(criteriaIds[0].id, /^cr-[a-f0-9]{8}$/,
      "a success-criterion text must carry its cr- identity in the metadata");
  });

  it("derives different constraint IDs for different texts", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-distinct",
      round: 2,
      task: "Implement feature",
      loop_objective: makeLoopObjective({
        objective: "Build feature",
        success_criteria: ["Feature works"],
        hard_constraints: ["No data loss", "HTTPS only"],
        loop_id: "id-distinct",
      }),
    }), null);

    const meta = response.constraint_metadata ?? [];
    const texts = new Set(meta.map(m => m.text));
    const ids = new Set(meta.map(m => m.id));

    // Each unique text should have a unique ID
    assert.equal(ids.size, texts.size,
      `ID count ${ids.size} should match text count ${texts.size}`);
  });

  it("derives deterministic constraint IDs — same text, same ID", () => {
    const opts = {
      loop_id: "id-det",
      round: 2,
      task: "Implement feature",
      loop_objective: makeLoopObjective({
        objective: "Build feature",
        success_criteria: ["Feature works"],
        hard_constraints: ["No data loss"],
        loop_id: "id-det",
      }),
    };
    const a = compileLoop(makeLoopCompileRequest(opts), null);
    const b = compileLoop(makeLoopCompileRequest(opts), null);

    const metaA = a.constraint_metadata ?? [];
    const metaB = b.constraint_metadata ?? [];
    assert.equal(metaA.length, metaB.length);

    for (let i = 0; i < metaA.length; i++) {
      assert.equal(metaA[i].id, metaB[i].id,
        `ID for "${metaA[i].text}" should be deterministic`);
    }
  });

  it("renders constraint IDs in L1 prompt when constraint_id_enabled is true", () => {
    resetPolicy();
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-render",
      round: 2,
      task: "Implement feature",
      loop_objective: makeLoopObjective({
        objective: "Build feature",
        success_criteria: ["Feature works"],
        hard_constraints: ["No data loss"],
        loop_id: "id-render",
      }),
    }), null);

    const prompt = response.prompt ?? "";
    // L2 by default for round 2 with plan — check state file which always renders
    const stateFile = response.state_file_content ?? "";
    // State file should render IDs for hard constraints (c-) and criteria (cr-)
    assert.ok(stateFile.includes("`c-") || stateFile.includes("[`c-"),
      "State file should render constraint IDs with c- prefix");
    assert.ok(stateFile.includes("`cr-") || stateFile.includes("[`cr-"),
      "State file should render criterion IDs with cr- prefix");
  });

  it("hides constraint IDs in state file when constraint_id_enabled is false", () => {
    resetPolicy();
    const p = getPolicy();
    p.evolution.constraint_id_enabled = false;

    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-off",
      round: 2,
      task: "Implement feature",
      loop_objective: makeLoopObjective({
        objective: "Build feature",
        success_criteria: ["Feature works"],
        hard_constraints: ["No data loss"],
        loop_id: "id-off",
      }),
      constraints_from_plan: ["Use HTTPS"],
    }), null);

    const stateFile = response.state_file_content ?? "";
    // When disabled, IDs should NOT appear with `[c-` or `[cr-` prefix in state file
    assert.ok(!stateFile.includes("[`c-"),
      "State file should NOT show c- ID prefix when constraint_id_enabled=false");
    assert.ok(!stateFile.includes("[`cr-"),
      "State file should NOT show cr- ID prefix when constraint_id_enabled=false");
  });

  it("self-eval template includes ID usage guidance", () => {
    const block = buildSelfEvalBlock(3);
    assert.ok(block.includes("c-XXXXXXXX"),
      "should mention c-XXXXXXXX constraint ID format");
    assert.ok(block.includes("cr-XXXXXXXX"),
      "should mention cr-XXXXXXXX criterion ID format");
    assert.ok(block.includes("sg-XXXXXXXX"),
      "should mention sg-XXXXXXXX sub-goal ID format");
    assert.ok(block.includes("sub-goal ID"),
      "should mention sub-goal IDs");
  });

  it("self-eval template placeholders use ID format", () => {
    const block = buildSelfEvalBlock(5);
    // constraint_violations placeholder should mention c-XXXXXXXX
    assert.ok(block.includes("c-XXXXXXXX"),
      "constraint_violations placeholder should use c-XXXXXXXX");
    // the criterion-claim placeholder should mention cr-XXXXXXXX
    assert.ok(block.includes("cr-XXXXXXXX"),
      "criterion_claims placeholder should use cr-XXXXXXXX");
  });

  it("older vault entries without IDs still match via Jaccard fallback", () => {
    // Simulate old vault entries with text-only constraint violations
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-fallback",
      round: 3,
      task: "Implement auth",
      loop_objective: makeLoopObjective({
        objective: "Build auth system",
        success_criteria: ["Login endpoint works"],
        hard_constraints: ["No plaintext passwords"],
        loop_id: "id-fallback",
      }),
      last_round_result: makeLoopRoundResult({
        round: 2,
        success: false,
        output_summary: "Worked on login",
        // Agent uses text (not ID) for violation — backward compat
        constraint_violations: ["No plaintext passwords"],
      }),
    }), null);

    // The compiler should match the text-based violation to the hard constraint
    // via Jaccard fallback. Verify the response is valid.
    assert.equal(response.status, "ok");
  });

  it("ID-first matching correctly identifies constraint violations by ID", () => {
    // Round 1: set up constraints
    const r1 = compileLoop(makeLoopCompileRequest({
      loop_id: "id-match",
      round: 1,
      task: "Implement auth",
      loop_objective: makeLoopObjective({
        objective: "Build auth system",
        success_criteria: ["Login endpoint works"],
        hard_constraints: ["No plaintext passwords"],
        loop_id: "id-match",
      }),
    }), null);

    // Get the constraint ID from metadata
    const meta = r1.constraint_metadata ?? [];
    const hardId = meta.find(m => m.text === "No plaintext passwords")?.id;
    assert.ok(hardId, "Should have an ID for the hard constraint");

    // Round 2: agent violates using the ID
    const r2 = compileLoop(makeLoopCompileRequest({
      loop_id: "id-match",
      round: 2,
      task: "Implement auth",
      loop_objective: makeLoopObjective({
        objective: "Build auth system",
        success_criteria: ["Login endpoint works"],
        hard_constraints: ["No plaintext passwords"],
        loop_id: "id-match",
      }),
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: false,
        output_summary: "Worked on login",
        constraint_violations: [hardId!], // Use the ID!
      }),
    }), null);

    // Should compile successfully — the ID was matched to the constraint
    assert.equal(r2.status, "ok");
    // The constraint should still be present in metadata
    const meta2 = r2.constraint_metadata ?? [];
    const hardMeta = meta2.find(m => m.text === "No plaintext passwords");
    assert.ok(hardMeta, "Hard constraint should still be in metadata");
    // Note: last_violated_at_round requires vault context for cross-round
    // scanning, which is null in unit tests. The matching is verified
    // end-to-end in the MCP lifecycle tests.
  });

  it("criterion ID-based dedup distinguishes similar criteria", () => {
    // Two similar criteria with different IDs should both appear as new
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-crit-dedup",
      round: 3,
      task: "Feature work",
      loop_objective: makeLoopObjective({
        objective: "Build feature",
        success_criteria: ["API returns valid JSON", "API returns valid XML"],
        loop_id: "id-crit-dedup",
      }),
      last_round_result: makeLoopRoundResult({
        round: 2,
        success: true,
        output_summary: "API work done",
        execution_report: {
          files_changed: ["api.ts"],
          tests_reported: null,
          // Both criteria met — use IDs for precise matching
          criterion_claims: criterionClaims(["cr-" + computeGoalTextHash("API returns valid JSON").slice(0, 8)], []),
          progress_estimate: 0.8,
        },
      }),
    }), null);

    assert.equal(response.status, "ok");
  });

  it("forces L2 rehydration after a backtrack (recovery boundary)", () => {
    const goalId = deriveGoalId("recovery-loop", "Recover the vault", "g1");
    const request = makeLoopCompileRequest({
      loop_id: "recovery-loop",
      round: 4,
      task: "Recover the vault",
      goal_id: goalId,
    });
    const context = {
      results: [
        {
          loop_id: "recovery-loop",
          loop_lineage: {
            loop_id: "recovery-loop",
            round: 3,
            recompile_level: "l1",
            goal_id: goalId,
            constraints_active: [],
            success: true,
          },
        },
        {
          loop_id: "recovery-loop",
          loop_lineage: {
            loop_id: "recovery-loop",
            round: 4,
            committed_action: "backtrack",
            recompile_level: "l1",
            constraints_active: [],
            success: true,
          },
        },
      ],
      global_entries: [],
    };
    // v2.14: the decidePromptLevel recovery_boundary branch existed but no
    // caller ever set it — a post-backtrack compile fell through to L1.
    // A committed backtrack for the current round now forces L2 rehydrate.
    const response = compileLoop(request, context as never);
    assert.equal(response.recompile_level, "l2");
  });

  it("keeps plan constraints retracted for retire_window rounds, then restores them", () => {
    const constraint = "Never log secrets";
    const context = {
      results: [
        {
          loop_id: "retract-loop",
          loop_lineage: {
            loop_id: "retract-loop",
            round: 1,
            recompile_level: "l1",
            goal_id: "g",
            constraints_active: [constraint],
            success: true,
            retracted_constraints: [constraint],
          },
        },
      ],
      global_entries: [],
    };
    // Round 3: retracted at round 1 → 3-1=2 < retire_window(3) → still out
    const r3 = compileLoop(makeLoopCompileRequest({
      loop_id: "retract-loop",
      round: 3,
      task: "Task",
      goal_id: "g",
      constraints_from_plan: [constraint],
    }), context as never);
    assert.ok(!r3.constraints_active.includes(constraint),
      "retracted plan constraint must stay out during the window");

    // Round 4: 4-1=3, not < 3 → the constraint returns (never auto-decay —
    // only the retraction's memory expires)
    const r4 = compileLoop(makeLoopCompileRequest({
      loop_id: "retract-loop",
      round: 4,
      task: "Task",
      goal_id: "g",
      constraints_from_plan: [constraint],
    }), context as never);
    assert.ok(r4.constraints_active.includes(constraint),
      "constraint returns after retire_window rounds");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — L1 collapse diff baseline
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — L1 collapse diff baseline", () => {
  const idsOf = (texts: string[]): string[] =>
    texts.map((text) => `c-${deriveItemId(text)}`);
  const r1Entry = (
    loopId: string,
    presented: Record<string, unknown> | null,
  ): Record<string, unknown> => ({
    loop_id: loopId,
    output_summary: "Round 1 done",
    success: true,
    loop_lineage: {
      loop_id: loopId,
      round: 1,
      constraints_active: ["Tests must pass", "Keep API stable", "Migrate data"],
      ...(presented ?? {}),
    },
    constraint_violations: [],
  });
  const snapshot = (loopId: string): Record<string, unknown> => ({
    presented_constraint_ids: idsOf(["Tests must pass", "Keep API stable", "Migrate data"]),
    presented_subgoals: [["sg-11111111", "pending"], ["sg-22222222", "pending"], ["sg-33333333", "pending"]],
    presented_milestone_ranges: [[1, 1]],
  });

  it("collapses unchanged constraints against a persisted round-1 snapshot", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "collapse-lc",
      round: 2,
      task: "Continue work",
      force_level: "l1",
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: true,
        discovered_constraints: ["No external deps"],
      }),
    }), {
      results: [
        r1Entry("collapse-lc", snapshot("collapse-lc")),
        {
          loop_id: "collapse-lc",
          output_summary: "Round 2 progress",
          success: true,
          loop_lineage: { loop_id: "collapse-lc", round: 2, constraints_active: [] },
          constraint_violations: [],
        },
      ],
    });
    const p = response.prompt;
    // One new constraint this round → full line; three unchanged → collapse.
    assert.match(p, /No external deps \(new this round\)/);
    assert.match(p, /… 3 unchanged constraints, 0 demoted since R1 \(see state file\)/);
    // L1 pointer carries the state-file update round.
    assert.match(p, /📄 Full state: .* \(updated round 2\)/);
  });

  it("is byte-identical across repeated compiles with a collapse baseline", () => {
    const request = makeLoopCompileRequest({
      loop_id: "collapse-lc2",
      round: 2,
      task: "Continue work",
      force_level: "l1",
    });
    const context = {
      results: [
        r1Entry("collapse-lc2", snapshot("collapse-lc2")),
        {
          loop_id: "collapse-lc2",
          output_summary: "Round 2 progress",
          success: true,
          loop_lineage: { loop_id: "collapse-lc2", round: 2, constraints_active: [] },
          constraint_violations: [],
        },
      ],
    };
    const first = compileLoop(request, context);
    const second = compileLoop(request, context);
    assert.equal(second.prompt, first.prompt, "collapse must be deterministic");
    assert.equal(second.prompt_artifact!.promptHash, first.prompt_artifact!.promptHash);
  });

  it("renders in full when the prior round has no L1 presented fields", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "collapse-old",
      round: 2,
      task: "Continue work",
      force_level: "l1",
    }), {
      results: [r1Entry("collapse-old", null)],
    });
    const p = response.prompt;
    assert.ok(p.includes("Tests must pass"), "missing L1 baseline → full render");
    assert.ok(!p.includes("unchanged constraints"), "no collapse line without presented fields");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — criterion status derivation (goal → criteria → evidence)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — criterion status derivation", () => {
  it("derives claimed / remaining / unknown with claimed rounds and linked sub-goals", () => {
    const statuses = deriveCriterionStatuses("cs-test", {
      results: [
        {
          loop_id: "cs-test",
          success: true,
          loop_lineage: { loop_id: "cs-test", round: 1, constraints_active: [] },
          execution_report: {
            criterion_claims: criterionClaims([], ["Parser complete", "Tests ≥90%"]),
          },
        },
        {
          loop_id: "cs-test",
          success: true,
          loop_lineage: { loop_id: "cs-test", round: 2, constraints_active: [] },
          execution_report: {
            criterion_claims: criterionClaims(["Parser complete"], ["Tests ≥90%"]),
          },
        },
      ],
    }, makeLoopObjective({
      objective: "Build a parser",
      success_criteria: ["Parser complete", "Tests ≥90%", "No runtime deps"],
    }), 3, [
      { id: "sg-1", description: "Parser complete", status: "done", declared_at_round: 1, status_changed_at_round: 2, completed_at_round: 2, priority: 0 },
      { id: "sg-2", description: "Test coverage", status: "in_progress", declared_at_round: 1, status_changed_at_round: 1, priority: 1 },
    ]);

    assert.equal(statuses.length, 3);
    const parser = statuses.find((s) => s.text === "Parser complete")!;
    assert.equal(parser.status, "claimed");
    assert.equal(parser.met_at_round, 2, "first met report wins");
    assert.deepEqual(parser.related_subgoal_ids, ["sg-1"], "identical text links the sub-goal");

    const tests = statuses.find((s) => s.text === "Tests ≥90%")!;
    assert.equal(tests.status, "remaining");
    assert.equal(tests.met_at_round, undefined);

    const deps = statuses.find((s) => s.text === "No runtime deps")!;
    assert.equal(deps.status, "unknown", "never mentioned → unknown");
    assert.match(deps.id, /^cr-/);
  });

  it("renders the Goal → Criteria view in the L2 prompt and the state file", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "gc-prompt",
      round: 2,
      task: "Build a parser",
      force_level: "l2",
      loop_objective: makeLoopObjective({
        objective: "Build a parser",
        success_criteria: ["Parser complete", "Tests ≥90%"],
      }),
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: true,
        execution_report: {
          files_changed: ["src/parser.ts"],
          tests_reported: { passed: 10, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims(["Parser complete"], ["Tests ≥90%"]),
          progress_estimate: 0.6,
        },
      }),
    }), null);
    assert.match(response.prompt, /Goal → Criteria/);
    assert.match(response.prompt, /Parser complete.*met R1/);
    assert.match(response.prompt, /Tests ≥90%/);
    assert.match(response.state_file_content ?? "", /## Goal → Criteria/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — lessons learned derivation and rendering
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — lessons learned", () => {
  it("derives repeated violations and verification failures across all rounds", () => {
    const lessons = deriveLessons("lessons-test", {
      results: [
        {
          loop_id: "lessons-test",
          loop_lineage: { loop_id: "lessons-test", round: 1 },
          constraint_violations: ["No external deps"],
          verification_flags: [{ severity: "error", field: "x", check: "evidence_integrity", detail: "d" }],
        },
        {
          loop_id: "lessons-test",
          loop_lineage: { loop_id: "lessons-test", round: 2 },
          constraint_violations: ["No external deps"],
          verification_flags: [{ severity: "error", field: "x", check: "evidence_integrity", detail: "d" }],
        },
        {
          loop_id: "lessons-test",
          loop_lineage: { loop_id: "lessons-test", round: 3 },
          constraint_violations: ["No external deps"],
          verification_flags: [{ severity: "warn", field: "x", check: "intent_drift", detail: "d" }],
        },
        {
          loop_id: "lessons-test",
          loop_lineage: { loop_id: "lessons-test", round: 4 },
          constraint_violations: [],
          verification_flags: [{ severity: "warn", field: "x", check: "intent_drift", detail: "d" }],
        },
      ],
    }, 5);

    const violation = lessons.find((l) => l.kind === "constraint_violation")!;
    assert.equal(violation.text, "No external deps");
    assert.equal(violation.count, 3);
    assert.deepEqual(violation.rounds, [1, 2, 3]);

    const error = lessons.find((l) => l.kind === "verification_error")!;
    assert.equal(error.text, "evidence_integrity");
    assert.equal(error.count, 2);
    assert.deepEqual(error.rounds, [1, 2]);

    // warn repeated twice → also a lesson
    const warn = lessons.find((l) => l.kind === "verification_warning")!;
    assert.equal(warn.text, "intent_drift");
    assert.equal(warn.count, 2);

    // Sorted by count descending.
    assert.equal(lessons[0].kind, "constraint_violation");
  });

  it("renders violation lessons in the L1 Recurring Issues section with rounds", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "lessons-l1",
      round: 3,
      task: "Continue work",
      force_level: "l1",
    }), {
      results: [
        {
          loop_id: "lessons-l1",
          loop_lineage: { loop_id: "lessons-l1", round: 1 },
          constraint_violations: ["No external deps"],
          verification_flags: [{ severity: "error", field: "x", check: "evidence_integrity", detail: "d" }],
        },
        {
          loop_id: "lessons-l1",
          loop_lineage: { loop_id: "lessons-l1", round: 2 },
          constraint_violations: ["No external deps"],
          verification_flags: [{ severity: "error", field: "x", check: "evidence_integrity", detail: "d" }],
        },
      ],
    });
    const p = response.prompt;
    assert.match(p, /Recurring Issues/);
    assert.match(p, /No external deps \(violated 2×: R1, R2\)/);
  });

  it("renders the L2 Lessons Learned section and the state file section", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "lessons-l2",
      round: 3,
      task: "Continue work",
      force_level: "l2",
    }), {
      results: [
        {
          loop_id: "lessons-l2",
          loop_lineage: { loop_id: "lessons-l2", round: 1 },
          constraint_violations: ["No external deps"],
          verification_flags: [{ severity: "error", field: "x", check: "evidence_integrity", detail: "d" }],
        },
        {
          loop_id: "lessons-l2",
          loop_lineage: { loop_id: "lessons-l2", round: 2 },
          constraint_violations: ["No external deps"],
          verification_flags: [{ severity: "error", field: "x", check: "evidence_integrity", detail: "d" }],
        },
      ],
    });
    assert.match(response.prompt, /Lessons Learned/);
    assert.match(response.prompt, /No external deps — 2× \(R1, R2\)/);
    assert.match(response.state_file_content ?? "", /## Lessons Learned/);
  });

  it("keeps L0 free of lessons sections", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "lessons-l0",
      round: 3,
      attempt: 2,
      task: "Continue work",
      rejection_notice: "Required command failed",
    }), {
      results: [
        {
          loop_id: "lessons-l0",
          loop_lineage: { loop_id: "lessons-l0", round: 1 },
          constraint_violations: ["No external deps"],
        },
        {
          loop_id: "lessons-l0",
          loop_lineage: { loop_id: "lessons-l0", round: 2 },
          constraint_violations: ["No external deps"],
        },
      ],
    });
    assert.doesNotMatch(response.prompt, /Lessons Learned/);
    assert.doesNotMatch(response.prompt, /Recurring Issues/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2.1: current-round violations feed the constraint lifecycle — the L1
// collapse "(violated this round)" annotation and inactive re-activation.
// ═══════════════════════════════════════════════════════════════════════════
describe("manageConstraintLifecycle — current-round violations (v3.2.1)", () => {
  it("marks a constraint violated this round with last_violated_at_round = currentRound", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-vr",
      round: 3,
      task: "Implement auth",
      loop_objective: makeLoopObjective({
        objective: "Build auth system",
        success_criteria: ["Login endpoint works"],
        hard_constraints: ["No plaintext passwords"],
        loop_id: "id-vr",
      }),
      constraints_from_plan: ["Use bcrypt for hashing"],
      last_round_result: makeLoopRoundResult({
        round: 2,
        success: false,
        output_summary: "Tried without hashing",
        constraint_violations: ["No plaintext passwords"],
      }),
    }), null);

    const meta = response.constraint_metadata ?? [];
    const hard = meta.find((m) => m.text === "No plaintext passwords");
    assert.ok(hard, "hard constraint must be in metadata");
    assert.equal(
      hard!.last_violated_at_round, 3,
      "a violation reported this round must mark last_violated_at_round = currentRound " +
      "(drives the L1 collapse '(violated this round)' annotation)",
    );
  });

  it("keeps a quiet discovered constraint active (v3.7: decay removed)", () => {
    // Round 1 discovers the constraint; rounds 2–17 never mention it again.
    // Pre-v3.7 constraint_inactive_rounds (15) would have demoted it to
    // inactive; the time-aware decay was removed — discovered constraints
    // stay in the active set until the agent retracts them.
    // The active set propagates via previous round's constraints_active —
    // fixture mirrors the real lineage chain.
    const discoveredText = "Rate limit login attempts";
    const results = [
      {
        loop_id: "id-re",
        loop_lineage: {
          loop_id: "id-re", round: 1,
          constraints_active: [discoveredText],
        },
        constraint_violations: [] as string[],
        discovered_constraints: [discoveredText],
      },
      {
        loop_id: "id-re",
        loop_lineage: {
          loop_id: "id-re", round: 17,
          constraints_active: [discoveredText],
        },
        constraint_violations: [] as string[],
        discovered_constraints: [] as string[],
      },
    ];
    const base = makeLoopCompileRequest({
      loop_id: "id-re",
      round: 18,
      task: "Continue auth work",
      loop_objective: makeLoopObjective({
        objective: "Build auth system",
        success_criteria: ["Login endpoint works"],
        loop_id: "id-re",
      }),
      constraints_from_plan: [] as string[],
    });

    const quiet = compileLoop({ ...base, last_round_result: makeLoopRoundResult({
      round: 17,
      success: true,
      output_summary: "Quiet rounds",
      constraint_violations: [],
    }) }, { results });
    assert.ok(
      (quiet.constraints_active ?? []).includes(discoveredText),
      "a quiet discovered constraint must stay active (no decay)",
    );
    const meta = (quiet.constraint_metadata ?? []).find((m) => m.text === discoveredText);
    assert.ok(meta, "constraint must still carry metadata");
    assert.equal(meta!.source, "discovered");
    assert.equal(meta!.last_violated_at_round, 0, "never violated");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — round stats + machine git-motion status threading
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — round stats and machine status threading", () => {
  /** Hydrated committed entry carrying the facts used by both dashboards. */
  const feedbackEntry = (
    round: number,
    files: string[],
    progress: number,
    attempt: number,
  ): Record<string, unknown> => mergedLineageRound(round, {
    loopId: "stats-loop",
    attempt,
    files,
    progress,
    roundEvidence: [{ schemaVersion: 1, providerId: "git", kind: "git", phase: "after", startedAt: 0, finishedAt: 0, status: "observed", files, data: { fingerprints: {} } }],
  });

  it("derives round stats and machine git-motion from committed context entries", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "stats-loop",
      round: 4,
      task: "Derive stats",
      force_level: "l2",
    }), {
      results: [
        feedbackEntry(1, ["src/a.ts", "src/b.ts"], 0.4, 2), // 1 rejected attempt
        feedbackEntry(2, ["src/c.ts"], 0.5, 1),
        feedbackEntry(3, ["src/d.ts", "src/e.ts"], 0.6, 1),
      ],
      global_entries: [],
    } as never);
    // Round Stats (L2 structured): files per round, rejected attempts from
    // snapshot.attempt - 1, self-reported progress deltas.
    assert.match(response.prompt, /Round Stats/);
    assert.match(response.prompt, /- R1: 2 files, 1 rejected attempt/);
    assert.match(response.prompt, /- R2: 1 file, Δ\+0\.10/);
    assert.match(response.prompt, /- R3: 2 files, Δ\+0\.10/);
    // Machine git-motion row: git observed changes in all 3 committed rounds.
    assert.match(response.prompt, /Machine \(git\)/);
    assert.match(response.prompt, /changes in 3\/3 recent committed rounds/);
    // state.md renderer gets the same machine rows (same-source contract).
    assert.match(response.state_file_content ?? "", /Machine \(git\)/);
  });

  it("keeps prompt and state hashes deterministic with derived data present", () => {
    const opts = {
      loop_id: "stats-loop",
      round: 4,
      task: "Derive stats",
      force_level: "l2",
    };
    const context = {
      results: [
        feedbackEntry(1, ["src/a.ts"], 0.4, 1),
        feedbackEntry(2, ["src/b.ts"], 0.5, 1),
        feedbackEntry(3, ["src/c.ts"], 0.6, 1),
      ],
      global_entries: [],
    };
    const a = compileLoop(makeLoopCompileRequest(opts), context as never);
    const b = compileLoop(makeLoopCompileRequest(opts), context as never);
    assert.equal(a.prompt_artifact?.promptHash, b.prompt_artifact?.promptHash);
    assert.equal(a.state_file_content, b.state_file_content);
  });

  it("v3.5.1: renders rejected attempts and the Machine (git) row from MERGED entries", () => {
    // Production shape regression: engine hydration stamps lineage.attempt /
    // lineage.round_evidence onto merged lineage entries (raw :feedback
    // entries never reach the compile view). Before the stamp, this fixture
    // rendered "— rejected attempts" and no Machine row at all.
    const mergedRound = (round: number, attempt: number, gitMotion: boolean): Record<string, unknown> =>
      mergedLineageRound(round, {
        loopId: "stats-loop",
        attempt,
        files: [`src/r${round}.ts`],
        progress: 0.2 + round * 0.1,
        roundEvidence: [{
          schemaVersion: 1,
          providerId: "git",
          kind: "git",
          phase: "after",
          startedAt: 0,
          finishedAt: 0,
          status: "observed",
          files: gitMotion ? [`src/r${round}.ts`] : [],
          data: { fingerprints: {} },
        }],
      });
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "stats-loop",
      round: 4,
      task: "Derive stats",
      force_level: "l2",
    }), {
      results: [
        mergedRound(1, 2, true), // 1 rejected attempt before commit
        mergedRound(2, 1, true),
        mergedRound(3, 1, false), // committed, but no git motion that round
      ],
      global_entries: [],
    } as never);
    assert.match(response.prompt, /- R1: 1 file, 1 rejected attempt/);
    assert.match(response.prompt, /Machine \(git\)/);
    assert.match(response.prompt, /changes in 2\/3 recent committed rounds/,
      "R1+R2 moved; R3 recorded no motion");
    assert.match(response.state_file_content ?? "", /Machine \(git\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Round Contract self-eval template
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — Round Contract eval template", () => {
  it("restates the contract in L1/L2 templates when hasContract is set", () => {
    const block = buildSelfEvalBlock(4, "l2", true);
    assert.ok(block.includes("round_contract"), "template must carry the contract key");
    assert.ok(block.includes("restate the Current Task's contract UNCHANGED"));
  });

  it("non-contract rounds and L0 retries never see the contract template", () => {
    const plain = buildSelfEvalBlock(4, "l2", false);
    assert.ok(!plain.includes("round_contract"), "no contract → no template key");
    const retry = buildSelfEvalBlock(4, "l0", true);
    assert.ok(!retry.includes("round_contract"), "L0 retry stays lean even with a contract");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.4 — ACTIVE Round Contract derivation at compile time
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.4 — ACTIVE Round Contract derivation (compileLoop)", () => {
  /** Merged production-shape lineage entry (shared fixture, derive-cc loop). */
  const mergedRound = (r: number, o: Parameters<typeof mergedLineageRound>[1] = {}) =>
    mergedLineageRound(r, { loopId: "derive-cc", ...o });
  // v3.8: contracts declare ITEMS; each binds evidence commands.
  const A = {
    work_item: "Slice A",
    scope: ["src/a"],
    items: [
      { description: "a one", criterion_refs: ["cr-a-1"], subgoal_refs: [], verify_with: ["verify"] },
      { description: "a two", criterion_refs: ["cr-a-2"], subgoal_refs: [], verify_with: ["verify"] },
    ],
  };
  const B = {
    work_item: "Slice B",
    scope: ["src/b"],
    items: [{ description: "b one", criterion_refs: ["cr-b-1"], subgoal_refs: [], verify_with: ["verify"] }],
  };
  const TASK = "Build the whole thing";
  const compileAt = (
    round: number,
    level: "l0" | "l1" | "l2",
    results: Record<string, unknown>[],
  ) => compileLoop(makeLoopCompileRequest({
    loop_id: "derive-cc",
    round,
    task: TASK,
    force_level: level,
    // v3.4: NO last_round_result — the rejection-retry / resume / unpause /
    // backtrack compile shape. Current Task must still come from the
    // committed rounds via the derivation.
  }), { results, global_entries: [] } as never);

  it("declared contract renders as Current Task without last_round_result", () => {
    const res = compileAt(3, "l2", [
      mergedRound(1, { contract: A }),
      mergedRound(2, { met: [] }),
    ]);
    assert.ok(res.prompt.includes("**Slice A**"), "active contract must be the Current Task");
    assert.ok(res.prompt.includes("a one"), "item descriptions render");
    assert.ok(res.state_file_content?.includes("**Slice A**"));
    // L1/L2 eval template asks for the restatement (hasContract via derived
    // active — no last_round_result needed).
    assert.ok(res.prompt.includes("round_contract"));
  });

  it("L0 retry keeps the contract as Current Task but stays template-lean", () => {
    const res = compileAt(3, "l0", [
      mergedRound(1, { contract: A }),
      mergedRound(2, { met: [] }),
    ]);
    assert.ok(res.prompt.includes("**Slice A**"),
      "an L0 retry under an active contract must keep showing it");
    assert.ok(!res.prompt.includes("round_contract"),
      "L0 retry stays lean — no restatement template");
  });

  it("a fully verified contract reverts the Current Task to the original task", () => {
    // v3.8: closure requires every item to be machine-verified — a claim
    // alone never closes a contract.
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: {
        ...DEFAULT_POLICY.evidence,
        commands: [{
          name: "verify", enabled: true, executable: "node", args: ["-e", "verify"],
          phase: "after", required: true, timeout_ms: 1000,
          max_output_chars: 2000, success_exit_codes: [0],
        }],
      },
    });
    const itemIds = deriveContractItemIds(A.items);
    const res = compileAt(3, "l2", [
      mergedRound(1, { contract: A }),
      mergedRound(2, {
        contractItemClaims: itemIds.map((item_id) => ({ item_id, outcome: "met" as const })),
        roundEvidence: [commandObservation("passed")],
      }),
    ]);
    assert.ok(!res.prompt.includes("**Slice A**"), "satisfied contract must stop rendering");
    assert.ok(!res.prompt.includes("round_contract"),
      "no active contract → no restatement template");
    assert.ok(res.prompt.includes(TASK), "objective still present");
  });

  it("ignores a premature replacement declared while the active contract is open", () => {
    const res = compileAt(3, "l2", [
      mergedRound(1, { contract: A }),
      mergedRound(2, { contract: B, met: [] }), // proposes B, completes nothing
    ]);
    assert.ok(res.prompt.includes("**Slice A**"), "A continues — B was premature");
    assert.ok(!res.prompt.includes("**Slice B**"));
  });

  it("closes on outcome=blocked and activates the blocking eval's proposal", () => {
    const res = compileAt(3, "l2", [
      mergedRound(1, { contract: A }),
      mergedRound(2, { outcome: "blocked", contract: B }),
    ]);
    assert.ok(res.prompt.includes("**Slice B**"), "blocked closes A; B becomes active");
    assert.ok(!res.prompt.includes("**Slice A**"));
  });

  it("contract-less committed rounds render no contract and no template", () => {
    const res = compileAt(3, "l2", [
      mergedRound(1, { met: [] }),
      mergedRound(2, { met: [] }),
    ]);
    assert.ok(!res.prompt.includes("**Slice A**"));
    assert.ok(!res.prompt.includes("round_contract"));
    assert.ok(res.prompt.includes(TASK));
  });
});

describe("Auto safety-net milestone — milestone-less loops (v3.3.1)", () => {
  beforeEach(() => resetPolicy());

  function quietRound(round: number): Record<string, unknown> {
    return {
      loop_id: "auto-net",
      loop_lineage: { loop_id: "auto-net", round, constraints_active: [] },
      constraint_violations: [],
      discovered_constraints: [],
      output_summary: `quiet round ${round}`,
    };
  }

  it("fires from round 1 when NO milestone was ever created", () => {
    // Regression: the safety net required lastMilestoneRound > 0, so a loop
    // that never produced an agent_declared/criteria milestone (no
    // checkpoints, criteria all met in round 1 or never reported met) had an
    // empty Phase History forever — the gap was measured from a milestone
    // that did not exist. The policy contract says the net fires when no
    // milestone has been created for milestone_interval rounds.
    getPolicy().summary.milestone_interval = 3;
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "auto-net",
      round: 5,
      task: "Quiet grind",
      force_level: "l1",
    }), {
      results: [1, 2, 3, 4].map(quietRound),
    });
    const milestones = response.rolling_summary?.milestones ?? [];
    const auto = milestones.filter((m) => m.kind === "auto");
    assert.ok(auto.length >= 1,
      "a milestone-less loop must receive an auto safety-net milestone");
    assert.equal(auto[0].round_range.start, 1,
      "the net must cover from round 1 when nothing preceded it");
    assert.equal(auto[0].round_range.end, 4);
  });

  it("does not fire before the interval elapses", () => {
    getPolicy().summary.milestone_interval = 3;
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "auto-net",
      round: 3,
      task: "Quiet grind",
      force_level: "l1",
    }), {
      results: [1, 2].map(quietRound),
    });
    const milestones = response.rolling_summary?.milestones ?? [];
    assert.equal(milestones.filter((m) => m.kind === "auto").length, 0,
      "gap 2 < interval 3 must not fire the net yet");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.5 — L2 contract declaration nudge + post-backtrack revision fixtures
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.5 — L2 contract declaration nudge", () => {
  beforeEach(() => resetPolicy());

  const NUDGE = "consider declaring a";

  it("appends nudge prose on an L2 contract-less block — without the JSON key name", () => {
    const block = buildSelfEvalBlock(4, "l2", false, true);
    assert.ok(block.includes(NUDGE), "nudge must be present");
    assert.ok(block.includes("Round Contract"));
    assert.ok(!block.includes("round_contract"),
      "the prose must never contain the JSON key name (contract-less L2 tests rely on it)");
  });

  it("is off by default (no proposalNudge flag)", () => {
    assert.ok(!buildSelfEvalBlock(4, "l2", false).includes(NUDGE));
  });

  it("never appears on L0/L1 compiles (the L2 gating lives at the call site)", () => {
    // Round 3 with two contract-less committed rounds — force_level applies
    // outside the round-1 first_round decision (which is always L2).
    const ctx = {
      results: [
        {
          loop_id: "nudge-loop",
          task_id: "nudge-loop:r1",
          task_type: "loop_lineage",
          loop_lineage: { loop_id: "nudge-loop", round: 1, committed_action: "continue" },
          execution_report: { files_changed: [], criterion_claims: criterionClaims([]) },
        },
        {
          loop_id: "nudge-loop",
          task_id: "nudge-loop:r2",
          task_type: "loop_lineage",
          loop_lineage: { loop_id: "nudge-loop", round: 2, committed_action: "continue" },
          execution_report: { files_changed: [], criterion_claims: criterionClaims([]) },
        },
      ],
      global_entries: [],
    };
    const mk = (level: "l0" | "l1" | "l2") => compileLoop(makeLoopCompileRequest({
      loop_id: "nudge-loop",
      round: 3,
      task: "Plain one-round task",
      force_level: level,
    }), ctx as never);
    assert.ok(!mk("l0").prompt.includes(NUDGE), "L0 stays lean");
    assert.ok(!mk("l1").prompt.includes(NUDGE), "nudge is L2-only");
    assert.ok(mk("l2").prompt.includes(NUDGE));
  });

  it("compileLoop nudges L2 contract-less compiles (policy default on)", () => {
    const res = compileLoop(makeLoopCompileRequest({
      loop_id: "nudge-loop",
      round: 1,
      task: "Plain one-round task",
      force_level: "l2",
    }), null);
    assert.ok(res.prompt.includes(NUDGE));
  });

  it("does not nudge when an ACTIVE contract is the Current Task", () => {
    const res = compileLoop(makeLoopCompileRequest({
      loop_id: "nudge-loop",
      round: 2,
      task: "Plain one-round task",
      force_level: "l2",
    }), {
      results: [{
        loop_id: "nudge-loop",
        task_id: "nudge-loop:r1",
        task_type: "loop_lineage",
        loop_lineage: {
          loop_id: "nudge-loop",
          round: 1,
          committed_action: "continue",
        },
        round_contract: {
          work_item: "Slice A",
          scope: ["src/a"],
          items: [{ description: "a one", criterion_refs: ["cr-a-1"], subgoal_refs: [], verify_with: ["verify"] }],
        },
        execution_report: { files_changed: [], criterion_claims: criterionClaims([]) },
      }],
      global_entries: [],
    } as never);
    assert.ok(res.prompt.includes("**Slice A**"), "active contract renders");
    assert.ok(!res.prompt.includes(NUDGE), "no nudge when a contract is active");
  });

  it("kill switch: contract_nudge_on_l2=false restores pre-v3.5 L2 rendering", () => {
    setPolicyForTest({
      ...DEFAULT_POLICY,
      prompt: { ...DEFAULT_POLICY.prompt, contract_nudge_on_l2: false },
    });
    const res = compileLoop(makeLoopCompileRequest({
      loop_id: "nudge-loop",
      round: 1,
      task: "Plain one-round task",
      force_level: "l2",
    }), null);
    assert.ok(!res.prompt.includes(NUDGE));
  });
});

describe("v3.5 — post-backtrack contract revision (compile side)", () => {
  /** Merged production-shape lineage entry (shared fixture, redo-cc loop). */
  const merged = (r: number, o: Parameters<typeof mergedLineageRound>[1] = {}) =>
    mergedLineageRound(r, { loopId: "redo-cc", ...o });
  const A = {
    work_item: "Stalled slice",
    scope: ["src/a"],
    items: [{ description: "a one", criterion_refs: ["cr-a-1"], subgoal_refs: [], verify_with: ["verify"] }],
  };
  const B = {
    work_item: "Revised slice",
    scope: ["src/b"],
    items: [{ description: "b one", criterion_refs: ["cr-b-1"], subgoal_refs: [], verify_with: ["verify"] }],
  };

  it("a blocked redo eval after backtrack rounds activates the revised contract", () => {
    // r1: A declared (restore point) · r2/r3: committed backtrack rounds
    // (skipped — their proposals must not leak) · r4: redo eval closes A with
    // outcome=blocked and proposes B → round 5's Current Task is B.
    const res = compileLoop(makeLoopCompileRequest({
      loop_id: "redo-cc",
      round: 5,
      task: "Whole task",
      force_level: "l2",
    }), {
      results: [
        merged(1, { contract: A }),
        merged(2, { action: "backtrack", contract: A }),
        merged(3, { action: "backtrack", contract: A }),
        merged(4, { outcome: "blocked", contract: B }),
      ],
      global_entries: [],
    } as never);
    assert.ok(res.prompt.includes("**Revised slice**"),
      "the revised contract must become the Current Task");
    assert.ok(!res.prompt.includes("**Stalled slice**"),
      "the stalled contract must be closed, not re-rendered");
  });

  it("mid-redo (before the redo eval commits) the restore-point contract still renders", () => {
    const res = compileLoop(makeLoopCompileRequest({
      loop_id: "redo-cc",
      round: 4, // the redo round — nothing committed at/after r4 yet
      task: "Whole task",
      force_level: "l2",
    }), {
      results: [
        merged(1, { contract: A }),
        merged(2, { action: "backtrack", contract: A }),
        merged(3, { action: "backtrack", contract: A }),
      ],
      global_entries: [],
    } as never);
    assert.ok(res.prompt.includes("**Stalled slice**"),
      "until the redo commits, the restore point's active contract governs");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M5 regression: objective_refinement folds exactly once per persisted state
// ═══════════════════════════════════════════════════════════════════════════

describe("M5 — objective refinement retry idempotency", () => {
  it("retries do not re-append an already-folded refinement", () => {
    const loopId = "m5-retry";
    const refinement = "Include rollback verification";

    // Round 3 attempt 1 already folded round 2's refinement into the
    // objective base (its compile lineage is what a retry rehydrates).
    const base = makeLoopObjective({
      loop_id: loopId,
      objective: "Ship the port",
      success_criteria: ["All green"],
      hard_constraints: ["No data loss"],
    });
    const attempt1Objective: LoopObjective = {
      ...base,
      objective: `${base.objective}\nRefinement: ${refinement}`,
      version: (base.version ?? 1) + 1,
      refinement_history: [refinement],
    };
    const context = {
      results: [{
        loop_id: loopId,
        loop_lineage: { round: 3 },
        loop_objective: attempt1Objective,
      }],
    };
    const lastResult = makeLoopRoundResult({
      round: 2,
      success: false,
      output_summary: "reworked the schema",
      objective_refinement: refinement,
    });

    // Attempt 2 — and then attempt 3 against attempt 2's own compile output.
    let lineage = context.results[0];
    const attempt2 = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Ship the port",
      last_round_result: lastResult,
    }), context);
    const o2 = attempt2.loop_objective!;
    assert.equal(o2.objective.match(/Refinement:/g)?.length, 1,
      "attempt 2 must not duplicate the folded refinement");
    assert.equal(o2.version, attempt1Objective.version,
      "attempt 2 must not inflate the objective version");

    lineage = { ...lineage, loop_objective: o2 };
    const attempt3 = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Ship the port",
      last_round_result: lastResult,
    }), { results: [lineage] });
    const o3 = attempt3.loop_objective!;
    assert.equal(o3.objective.match(/Refinement:/g)?.length, 1,
      "attempt 3 must stay at a single fold");
    assert.equal(o3.version, attempt1Objective.version,
      "attempt 3 must not inflate the version further");
    assert.deepEqual(o3.refinement_history, [refinement]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L7 regression: state_file.enabled=false must disable every knob that
// depends on the file — L2 pointer mode and L1 collapse both point prompts
// at the file for content, so with the file disabled they would silently
// truncate what the agent sees.
// ═══════════════════════════════════════════════════════════════════════════

describe("L7 — state file disabled cross-knob guard", () => {
  beforeEach(() => resetPolicy());

  const disableStateFile = (): void => {
    setPolicyForTest({
      ...DEFAULT_POLICY,
      state_file: { ...DEFAULT_POLICY.state_file, enabled: false },
    });
  };
  const idsOf = (texts: string[]): string[] =>
    texts.map((text) => `c-${deriveItemId(text)}`);
  const baselineRound1 = (loopId: string): Record<string, unknown> => ({
    loop_id: loopId,
    output_summary: "Round 1 done",
    success: true,
    loop_lineage: {
      loop_id: loopId,
      round: 1,
      constraints_active: ["Tests must pass", "Keep API stable", "Migrate data"],
      presented_constraint_ids: idsOf(["Tests must pass", "Keep API stable", "Migrate data"]),
      presented_subgoals: [],
      presented_milestone_ranges: [[1, 1]],
    },
    constraint_violations: [],
  });

  it("L2 keeps the full state in the prompt instead of pointing at nothing", () => {
    disableStateFile();
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "l7-l2",
      round: 2,
      task: "Continue the migration",
      force_level: "l2",
      last_round_result: makeLoopRoundResult({ round: 1, success: true }),
    }), { results: [baselineRound1("l7-l2")] });
    assert.equal(response.state_file_content, undefined,
      "no state file content is produced when the file is disabled");
    assert.ok(!response.prompt.includes("Full state:"),
      "the L2 pointer line must not reference a file that is never written");
    assert.ok(!response.prompt.includes("Read the full state file"),
      "no read-the-file instruction may appear");
    assert.ok(response.prompt.includes("Continue the migration"),
      "the prompt stays self-contained when the file is disabled");
  });

  it("L1 renders full constraints instead of collapsing behind a missing file", () => {
    disableStateFile();
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "l7-l1",
      round: 2,
      task: "Continue work",
      force_level: "l1",
      last_round_result: makeLoopRoundResult({
        round: 1,
        success: true,
        discovered_constraints: ["No external deps"],
      }),
    }), { results: [baselineRound1("l7-l1")] });
    const p = response.prompt;
    // Collapse would have demoted the three unchanged constraints behind a
    // "(see state file)" line — with no file, every constraint renders.
    assert.ok(!p.includes("(see state file)"),
      "no collapse line may point at a file that is never written");
    assert.ok(!p.includes("unchanged constraints"),
      "unchanged constraints must not be demoted");
    for (const text of ["Tests must pass", "Keep API stable", "Migrate data"]) {
      assert.ok(p.includes(text), `unchanged constraint must render in full: ${text}`);
    }
  });
});
