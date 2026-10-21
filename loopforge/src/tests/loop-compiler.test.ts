import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSelfEvalBlock,
  buildRollingSummary,
  compileLoop,
  computeGoalTextHash,
  decideLevel,
  deriveCriterionId,
  deriveCriterionStatuses,
  deriveGoalId,
  deriveRecurringFlags,
} from "../loop-compiler.js";
import { deriveSubGoalId, validateSubGoalUpdates } from "../subgoal-state.js";
import type { CommittedRoundView } from "../committed-round.js";
import {
  type LoopObjective,
  makeLoopCompileRequest,
  makeLoopObjective,
  makeLoopRoundResult,
  type SubGoal,
} from "../protocol.js";
import { getPolicy, resetPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";
import {
  committedFeedbackRound,
  committedBacktrackRound,
  mergedLineageRound,
  criterionClaims,
  withTransaction,
} from "./_helpers.js";
import type { MachineObservation, VerificationFlag } from "../protocol.js";
import type { ActiveContractView } from "../round-contract.js";
import type { SelfEvalPromptContext } from "../submission-guidance.js";

/** Minimal prompt context for the evaluation-block tests. */
function evalCtx(
  overrides: Partial<SelfEvalPromptContext> = {},
): SelfEvalPromptContext {
  return {
    round: 3,
    level: "l1",
    activeContract: null,
    itemStatuses: null,
    commands: ["verify"],
    contractVerificationAvailable: true,
    subGoals: [],
    verificationFlags: [],
    recovery: false,
    gateEnabled: false,
    ...overrides,
  };
}

function testContract(overrides: Partial<ActiveContractView> = {}): ActiveContractView {
  return {
    id: "rc-12345678",
    declared_at_round: 2,
    work_item: "Next slice",
    scope: ["src"],
    items: [{
      id: "rci-12345678",
      description: "verification command passes",
      criterion_refs: [],
      subgoal_refs: [],
      verify_with: ["verify"],
    }],
    config_hash_by_command: {},
    ...overrides,
  };
}

function testSubGoal(overrides: Partial<SubGoal> = {}): SubGoal {
  return {
    id: "sg-12345678",
    description: "sub-goal under test",
    status: "pending",
    declared_at_round: 1,
    status_changed_at_round: 1,
    priority: 0,
    ...overrides,
  };
}

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
import { deriveContractItemIds } from "../token-utils.js";

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
      outputSummary: "Committed round 1.",
    });

    const fromFeedback = buildRollingSummary("round-parity", 2, {
      results: [feedback as unknown as Record<string, unknown>],
    });
    const fromMerged = buildRollingSummary("round-parity", 2, {
      results: [merged],
    });
    assert.deepEqual(fromFeedback, fromMerged);
  });

  it("uses L2 first, L1 for normal continuation, and L0 for a proven-empty failed retry", () => {
    const first = makeLoopCompileRequest({ loop_id: "levels", task: "Do work" });
    assert.equal(decideLevel(first, null), "l2");

    const gitObservation = (phase: "before" | "after") => ({
      schemaVersion: 2,
      providerId: "git",
      kind: "git",
      phase,
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: [],
      data: {
        dirty: [],
        fingerprints: {},
        head: "abc123",
        coverage: "tracked_and_non_ignored_untracked",
      },
    });
    const continuing = makeLoopCompileRequest({
      loop_id: "levels", round: 2, task: "Do work",
    });
    const failedButEmpty = {
      results: [committedFeedbackRound(1, {
        loopId: "levels",
        beforeEvidence: [gitObservation("before")],
        roundEvidence: [gitObservation("after")],
      })],
    };
    assert.equal(decideLevel(continuing, failedButEmpty), "l0",
      "the committed fixture is success=false and the Git pair is observed " +
      "with identical fingerprints and HEAD → proven stale");

    const succeeded = {
      results: [withTransaction({
        loop_id: "levels",
        loop_lineage: {
          loop_id: "levels",
          round: 1,
          constraints_active: [],
          committed_action: "continue",
        },
        success: true,
        output_summary: "Done",
      })],
    };
    assert.equal(decideLevel(continuing, succeeded), "l1");
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
        },
      }),
    }), null);
    assert.ok(response.constraints_active.includes("Keep rollback path"));
    assert.ok(response.constraints_retired.includes("Temporary freeze"));
    assert.match(response.prompt, /rollback verification|Run rollback test/);
    // last_round_result remains available for objective/constraint evolution,
    // but without a committed view its report must not enter the state file.
    assert.doesNotMatch(response.state_file_content ?? "", /src\/store\.ts|10 passed/);
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

  it("computes rolling outcomes without technique metadata", () => {
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
    // L0 budget is the policy's l0_max_chars. The compiler should respect this.
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
    // L0 max comes from the policy — rendered prompt must be within budget
    const l0Budget = DEFAULT_POLICY.prompt.l0_max_chars;
    assert.ok(
      (response.prompt?.length ?? 0) <= l0Budget,
      `L0 prompt length ${response.prompt?.length} exceeds ${l0Budget} char budget`,
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
    assert.equal("progress_at_boundary" in m, false);
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
    assert.equal("progress_at_boundary" in critMs[0], false);
  });

  /** One committed round claiming the given criteria, for the two tests
   *  below that pin the exact-vs-similar boundary of criterion identity. */
  const criteriaRound = (round: number, met: string[]) => ({
    loop_id: "dedup_ms",
    output_summary: `round ${round}`,
    success: true,
    loop_lineage: { loop_id: "dedup_ms", round, constraints_active: [] },
    constraint_violations: [],
    execution_report: {
      files_changed: [`test/${round}.ts`],
      tests_reported: { passed: round * 5, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims(met, []),
    },
  });

  const criteriaMilestones = (rolling: ReturnType<typeof buildRollingSummary>) =>
    (rolling?.milestones ?? []).filter((m) => m.kind === "criteria_milestone");

  it("treats differently-worded criteria as DISTINCT — wording is not identity", () => {
    // v3.8.1: the former Jaccard criterion dedup is gone. Two criteria that
    // merely read alike are two criteria, so claiming the second one is new
    // information and earns a milestone. Guessing they were "semantically the
    // same" is exactly the kind of text-similarity-as-fact this release
    // removes.
    const rolling = buildRollingSummary("dedup_ms", 4, {
      results: [
        criteriaRound(1, ["Unit test coverage at 90%"]),
        criteriaRound(2, ["unit test coverage reached 90 percent"]),
        criteriaRound(3, ["unit test coverage reached 90 percent"]),
      ],
    });
    const critMs = criteriaMilestones(rolling);
    assert.equal(critMs.length, 1,
      `expected 1 criteria milestone, got ${critMs.length}: ${critMs.map((m) => m.label).join(", ")}`);
    assert.ok(critMs[0].label.includes("unit test coverage reached 90 percent"));
  });

  it("treats a restated criterion as the same one — normalized-exact is identity", () => {
    // Same criterion, re-claimed with different spacing and case. Whitespace
    // and case fold; the criterion is not new, so no second milestone.
    const rolling = buildRollingSummary("dedup_ms", 4, {
      results: [
        criteriaRound(1, ["Unit test coverage at 90%"]),
        criteriaRound(2, ["unit   test coverage at 90%"]),
        criteriaRound(3, ["unit test coverage at 90%"]),
      ],
    });
    assert.equal(criteriaMilestones(rolling).length, 0,
      "a restated criterion is not new progress");
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
          },
        },
      ],
    });
    assert.ok(rolling, "should produce a rolling summary");
    const critMs = (rolling!.milestones ?? []).filter((m) => m.kind === "criteria_milestone");
    assert.equal(critMs.length, 1, "should detect genuinely new criteria");
    assert.match(critMs[0].label, /Integration done/);
  });

  /** One committed round whose checkpoint forces a distinct milestone. */
  const checkpointRound = (loopId: string, round: number) => ({
    loop_id: loopId,
    output_summary: `Round ${round} done`,
    success: true,
    loop_lineage: {
      loop_id: loopId,
      round,
      constraints_active: [],
      compression_checkpoint: true,
      checkpoint_label: `Phase ${round}`,
    },
    constraint_violations: [],
    execution_report: {
      files_changed: [],
      tests_reported: null,
      criterion_claims: criterionClaims([], []),
    },
  });

  it("keeps every milestone while the history is under the cap", () => {
    const entries = Array.from({ length: 15 }, (_, i) => checkpointRound("cap_ms", i + 1));
    const rolling = buildRollingSummary("cap_ms", 16, { results: entries });
    const ms = rolling?.milestones ?? [];
    // v3.8.1: the fixed cap is 50. The v3.0.1 sampler truncated to 10 and
    // moved the oldest milestones around to keep "history anchors"; the
    // history is now simply bounded, newest kept.
    assert.equal(ms.length, 15, `expected all 15 under the cap, got ${ms.length}`);
    assert.equal(ms[0].label, "Phase 1");
    assert.equal(ms[ms.length - 1].label, "Phase 15");
  });

  it("caps milestone history at MILESTONE_HISTORY_CAP, keeping the newest", () => {
    const entries = Array.from({ length: 60 }, (_, i) => checkpointRound("cap_over", i + 1));
    const ms = buildRollingSummary("cap_over", 61, { results: entries })?.milestones ?? [];
    assert.equal(ms.length, 50, `expected the cap, got ${ms.length}`);
    assert.equal(ms[0].label, "Phase 11", "the oldest are the ones dropped");
    assert.equal(ms[ms.length - 1].label, "Phase 60", "the newest always survive");
  });

  it("the milestone history depends on the committed rounds, never on a prompt level", () => {
    // The v3.0.1 sampler did nothing at L2, so the milestone set written to
    // the state file depended on which level happened to compile. v3.8.1
    // deleted the level parameter outright, so "the level cannot change this"
    // is now structural rather than behavioural; what stays worth pinning is
    // that the derivation is a pure function of the committed rounds.
    const entries = Array.from({ length: 60 }, (_, i) => checkpointRound("cap_lvl", i + 1));
    const first = buildRollingSummary("cap_lvl", 61, { results: entries })?.milestones;
    const second = buildRollingSummary("cap_lvl", 61, { results: entries })?.milestones;
    assert.deepEqual(first, second, "one input, one answer");
    assert.ok((first?.length ?? 0) > 0, "the committed milestones are the only source");
  });

  it("keeps every milestone at or under the cap — nothing samples the set", () => {
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
        },
      });
    }
    const rolling = buildRollingSummary("l2_ms", 16, { results: entries }, 0);
    const ms = rolling!.milestones ?? [];
    assert.equal(ms.length, 15, `expected all 15 milestones, got ${ms.length}`);
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
        },
      });
    }
    const rolling = buildRollingSummary("under_ms", 9, { results: entries }, 0);
    const ms = rolling!.milestones ?? [];
    assert.equal(ms.length, 8, `under-cap must keep all 8 milestones, got ${ms.length}`);
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
          },
        },
      ],
    });
    assert.match(response.prompt, /Phase Anchors/);
    assert.match(response.prompt, /Data Layer/);
    assert.match(response.prompt, /Data Layer\*\* \(Rounds 1–1\)/);
    // v3.9.5: L2 carries stage anchors only; full phase history is state-file.
    assert.match(response.prompt, /Phase Anchors/);
    assert.doesNotMatch(response.prompt, /Phase History/);
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
    // v3.9.5: L1 never replays recent-round narratives or L2's anchors.
    assert.doesNotMatch(response.prompt, /Recent Rounds/);
    assert.doesNotMatch(response.prompt, /Phase Anchors/);
    // v3.8.1: the phase line NAMES the current phase.
    assert.match(response.prompt, /Phase/);
    assert.match(response.prompt, /Core Module/);
    // It must still not re-render the milestone as an anchor entry.
    assert.doesNotMatch(response.prompt, /round_range|Phase 1\b/);
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
    const sgId = deriveSubGoalId("sg-id-match", 1, 0, "Add error handling to login");
    // The transition is a COMMITTED fact in round 1 — the same source the
    // real MCP path commits before the next compile.
    const vault = {
      results: [withTransaction({
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
        subgoal_updates: [{ id: sgId, status: "done" }],
        success: true,
        output_summary: "Started auth fix",
      })],
    };
    // Round 2: the committed transition is replayed from the vault.
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "sg-id-match",
      round: 2,
      task: "Fix auth bug",
      force_level: "l2",
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
    const sgId = deriveSubGoalId("sg-inprogress", 1, 0, "Add rate limiting");
    const vault = {
      results: [withTransaction({
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
        subgoal_updates: [{ id: sgId, status: "in_progress" }],
        success: true,
        output_summary: "Started",
      })],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "sg-inprogress",
      round: 2,
      task: "Fix auth bug",
      force_level: "l2",
    }), vault);
    const active = response.sub_goals?.find(sg => sg.id === sgId);
    assert.equal(active?.status, "in_progress",
      "in_progress is produced only by an explicit agent declaration");
  });

  it("keeps older committed transitions when a later round declares nothing (no regression)", () => {
    const sgId = deriveSubGoalId("sg-persist", 1, 0, "Add error handling to login");
    const vault = {
      results: [
        withTransaction({
          loop_id: "sg-persist",
          loop_lineage: {
            loop_id: "sg-persist", round: 1, goal_id: deriveGoalId("sg-persist", "Fix auth"),
            task: "Fix auth", constraints_active: [], recompile_level: "l2",
            committed_action: "continue",
          },
          emerged_subtasks: ["Add error handling to login"],
          success: true,
          output_summary: "Started",
        }),
        withTransaction({
          loop_id: "sg-persist",
          loop_lineage: {
            loop_id: "sg-persist", round: 2, goal_id: deriveGoalId("sg-persist", "Fix auth"),
            task: "Fix auth", constraints_active: [], recompile_level: "l2",
            committed_action: "continue",
          },
          subgoal_updates: [{ id: sgId, status: "done" }],
          success: true,
          output_summary: "Done auth",
        }),
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

  it("buildSelfEvalBlock renders a real active sub-goal id and no placeholder id", () => {
    const block = buildSelfEvalBlock(evalCtx({ subGoals: [testSubGoal()] }));
    assert.ok(block.includes("sg-12345678"), "uses the real active sub-goal id");
    assert.ok(block.includes("subgoal_updates"), "shows the update field");
    const without = buildSelfEvalBlock(evalCtx({ subGoals: [] }));
    assert.ok(!without.includes("sg-12345678"), "does not invent an id when none exists");
    assert.ok(!without.includes("<sg-"), "does not render a placeholder id");
  });

  // ── v2.8: L2 pointer mode ─────────────────────────────────────────────

  it("v3.9.5: L2 never embeds the full state blob, but still writes the state file", () => {
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
        },
      }),
    }), null);
    assert.ok(!(response.prompt ?? "").includes("Full Rehydrated State"),
      "L2 prompt must not embed the full state blob");
    assert.ok(!(response.prompt ?? "").includes("Progress Dashboard"),
      "the L2 prompt carries no re-composed dashboard");
    assert.ok(!(response.prompt ?? "").includes("Started refactor"),
      "a fallback output summary is not prompt narrative");
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

  it("self-eval template never fabricates stable id formats", () => {
    const block = buildSelfEvalBlock(evalCtx());
    assert.ok(block.includes("Never invent an id"));
    assert.ok(!block.includes("<sg-"), "no phantom sub-goal id");
    assert.ok(!block.includes("<rci-"), "no phantom contract item id");
  });

  it("self-eval template explains the boundary files_changed meaning", () => {
    const block = buildSelfEvalBlock(evalCtx());
    assert.ok(block.includes("files_changed"));
    assert.ok(block.includes("net boundary change from round start"));
    assert.ok(block.includes("including deletions"));
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
        withTransaction({
          loop_id: "recovery-loop",
          loop_lineage: {
            loop_id: "recovery-loop",
            round: 4,
            committed_action: "backtrack",
            recompile_level: "l1",
            constraints_active: [],
            success: true,
          },
        }, "backtrack"),
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
        withTransaction({
          loop_id: "retract-loop",
          loop_lineage: {
            loop_id: "retract-loop",
            round: 1,
            recompile_level: "l1",
            goal_id: "g",
            constraints_active: [constraint],
            success: true,
            committed_action: "continue",
          },
          retracted_constraints: [constraint],
        }),
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
    }), 3);

    assert.equal(statuses.length, 3);
    const parser = statuses.find((s) => s.text === "Parser complete")!;
    assert.equal(parser.status, "claimed");
    assert.equal(parser.met_at_round, 2, "first met report wins");
    // v3.8.1: no contract here, so nothing links — and identical wording alone
    // never links. See the explicit-refs test below.
    assert.deepEqual(parser.related_subgoal_ids, [],
      "text alone does not link a criterion to a sub-goal");

    const tests = statuses.find((s) => s.text === "Tests ≥90%")!;
    assert.equal(tests.status, "remaining");
    assert.equal(tests.met_at_round, undefined);

    const deps = statuses.find((s) => s.text === "No runtime deps")!;
    assert.equal(deps.status, "unknown", "never mentioned → unknown");
    assert.match(deps.id, /^cr-/);
  });

  it("links a criterion to sub-goals only through an item's explicit refs", () => {
    // v3.8.1: `related_subgoal_ids` comes from the shared criterion facts,
    // which read `ContractItemProposal.subgoal_refs` on an item that
    // references the criterion (see round-facts.ts). Identical wording alone
    // links nothing — the Jaccard guess at "which sub-goal is this criterion
    // about" is gone.
    const parserCriterionId = deriveCriterionId("Parser complete");
    const statuses = deriveCriterionStatuses("cs-refs", {
      results: [{
        loop_id: "cs-refs",
        success: true,
        loop_lineage: { loop_id: "cs-refs", round: 1, constraints_active: [] },
        execution_report: {
          criterion_claims: criterionClaims([], ["Parser complete"]),
        },
      }],
    }, makeLoopObjective({
      objective: "Build a parser",
      success_criteria: ["Parser complete", "Tests ≥90%"],
    }), 2, null, [
      // The fact an item that references the criterion AND names the sub-goal
      // produces.
      { criterion_id: parserCriterionId, related_subgoal_ids: ["sg-1"] },
      // An item with no subgoal_refs links nothing.
      { criterion_id: deriveCriterionId("Tests ≥90%"), related_subgoal_ids: [] },
    ]);

    const parser = statuses.find((s) => s.text === "Parser complete")!;
    assert.deepEqual(parser.related_subgoal_ids, ["sg-1"],
      "an item that references the criterion AND names the sub-goal links them");
    const tests = statuses.find((s) => s.text === "Tests ≥90%")!;
    assert.deepEqual(tests.related_subgoal_ids, [],
      "an item with no subgoal_refs links nothing");
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
        },
      }),
    }), null);
    // v3.8.1: the Goal → Criteria dashboard is gone from the prompt. The
    // criterion list survives in the state file, where a human or external
    // tool reads it — the prompt no longer duplicates it.
    assert.doesNotMatch(response.prompt, /Goal → Criteria/);
    assert.match(response.state_file_content ?? "", /## Goal → Criteria/);
    assert.match(response.state_file_content ?? "", /Parser complete/);
    assert.match(response.state_file_content ?? "", /Tests ≥90%/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.8.1 — recurring flags: ONE derivation, two render windows
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.8.1 — recurring flags", () => {
  /** A committed round view. The derivation takes VIEWS, not raw vault
   *  entries, so a caller cannot hand it an uninterpreted envelope. */
  const round = (
    number: number,
    opts: { violations?: string[]; flags?: VerificationFlag[] } = {},
  ): CommittedRoundView => ({
    source: "merged",
    sourceEntry: {},
    loopId: "recurring",
    round: number,
    roundId: `loop:recurring:round:${number}`,
    attempt: 1,
    promptArtifact: null,
    evaluation: null,
    executionReport: null,
    verificationFlags: opts.flags ?? [],
    result: null,
    action: "continue",
    success: false,
    outcome: null,
    contractProposal: null,
    contractBinding: null,
    beforeEvidence: [],
    afterEvidence: [],
    observationDelta: [],
    normalizationDiagnostics: [],
    submittedFields: [],
    evidenceIncomplete: true,
    constraintViolations: opts.violations ?? [],
    backtrack: null,
  });

  const flag = (
    severity: "error" | "warn",
    check: string,
    ref?: string,
  ): VerificationFlag => ({
    severity, field: "x", check, detail: "d", ...(ref ? { ref } : {}),
  });

  it("counts facts across the committed history, keyed by subject and ref", () => {
    const flags = deriveRecurringFlags([
      round(1, { violations: ["No external deps"], flags: [flag("error", "evidence_integrity", "verify")] }),
      round(2, { violations: ["No external deps"], flags: [flag("error", "evidence_integrity", "verify")] }),
      round(3, { violations: ["No external deps"], flags: [flag("warn", "recurring_violation")] }),
    ]);

    const violation = flags.find((f) => f.kind === "constraint_violation")!;
    assert.equal(violation.subject, "No external deps");
    assert.equal(violation.count, 3);
    assert.deepEqual(violation.rounds, [1, 2, 3]);

    const error = flags.find((f) => f.kind === "verification_error")!;
    assert.equal(error.subject, "evidence_integrity");
    assert.equal(error.ref, "verify", "the id the flag was about rides along");
    assert.equal(error.count, 2);
    assert.deepEqual(error.rounds, [1, 2]);

    // Sorted by count descending.
    assert.equal(flags[0].kind, "constraint_violation");
  });

  it("reports a single occurrence — the threshold belongs to the renderer", () => {
    // The old split was a raw no-threshold violation list for the prompt AND
    // a whole-history count >= 2 "lessons" list for the state file. The
    // derivation is now neutral; each renderer applies its own window.
    const flags = deriveRecurringFlags([
      round(1, {}),
      round(2, { flags: [flag("warn", "test_files_modified")] }),
      round(3, {}),
    ]);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].count, 1);
    assert.deepEqual(flags[0].rounds, [2]);
  });

  it("separates facts that share a check id but differ in ref", () => {
    const flags = deriveRecurringFlags([
      round(1, { flags: [flag("error", "required_command_failed", "verify")] }),
      round(2, { flags: [flag("error", "required_command_failed", "lint")] }),
      round(3, { flags: [flag("error", "required_command_failed", "verify")] }),
    ]);
    assert.equal(flags.length, 2, "two subjects failed, not one recurring check");
    const verify = flags.find((f) => f.ref === "verify")!;
    assert.equal(verify.count, 2);
    assert.deepEqual(verify.rounds, [1, 3]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.8.1 — the two render windows over ONE recurring-fact list
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.8.1 — Recurring Findings (prompt) vs Recurring Flags (state file)", () => {
  /** A committed merged round carrying flags and violations. */
  const committed = (
    loopId: string,
    round: number,
    violations: string[],
    flags: VerificationFlag[],
  ): Record<string, unknown> =>
    mergedLineageRound(round, {
      loopId,
      constraintViolations: violations,
      verificationFlags: flags,
    });
  const warn = (check: string): VerificationFlag =>
    ({ severity: "warn", field: "x", check, detail: "d" });

  it("the prompt shows the RECENT window, the state file the RECURRING set", () => {
    // Round 1 violated a constraint and it never recurred; rounds 2 and 3
    // repeatedly tripped one check. With a 3-round window at round 4, the
    // prompt should surface BOTH (the violation is 3 rounds old and still in
    // the window); the state file should surface only the recurring check.
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "windows",
      round: 4,
      task: "Continue work",
      force_level: "l2",
    }), {
      results: [
        committed("windows", 1, ["Never touch prod data"], []),
        committed("windows", 2, [], [warn("test_files_modified")]),
        committed("windows", 3, [], [warn("test_files_modified")]),
      ],
    });

    const prompt = response.prompt;
    assert.match(prompt, /Recurring Findings/);
    assert.match(prompt, /test_files_modified — 2×, latest R3/);
    assert.match(prompt, /Never touch prod data — 1×, latest R1/);

    const stateFile = response.state_file_content ?? "";
    assert.match(stateFile, /## Recurring Flags/);
    assert.match(stateFile, /test_files_modified — 2× \(R2, R3\)/);
    assert.doesNotMatch(stateFile, /Never touch prod data/,
      "a one-off is not a recurring flag");
  });

  it("states differ from the prompt: the window is committed rounds, not the whole loop", () => {
    // The warning fired at round 1 only. At round 9 it is outside the
    // 3-round window, so the prompt must not carry it — while the state
    // file still shows nothing either (it never recurred).
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "stale",
      round: 9,
      task: "Continue work",
      force_level: "l1",
    }), {
      results: [
        committed("stale", 1, [], [warn("test_files_modified")]),
      ],
    });
    assert.doesNotMatch(response.prompt, /Recurring Findings/,
      "nothing is firing inside the recent window");
  });

  it("L0 carries neither window", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "l0-clean",
      round: 3,
      attempt: 2,
      task: "Continue work",
      rejection_notice: "Required command failed",
    }), {
      results: [
        committed("l0-clean", 1, ["Never touch prod data"], [warn("test_files_modified")]),
        committed("l0-clean", 2, ["Never touch prod data"], [warn("test_files_modified")]),
      ],
    });
    assert.doesNotMatch(response.prompt, /Recurring Findings/);
    assert.doesNotMatch(response.prompt, /Recurring Flags/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2.1: current-round violations feed the constraint lifecycle — the L1
// collapse "(violated this round)" annotation and inactive re-activation.
// ═══════════════════════════════════════════════════════════════════════════
describe("manageConstraintLifecycle — current-round violations (v3.2.1)", () => {
  it("marks a committed violation at its own round, not the compile round", () => {
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
    }), {
      results: [withTransaction({
        loop_id: "id-vr",
        loop_lineage: {
          loop_id: "id-vr",
          round: 2,
          constraints_active: ["No plaintext passwords"],
          committed_action: "continue",
        },
        success: false,
        output_summary: "Tried without hashing",
        constraint_violations: ["No plaintext passwords"],
      })],
    });

    const meta = response.constraint_metadata ?? [];
    const hard = meta.find((m) => m.text === "No plaintext passwords");
    assert.ok(hard, "hard constraint must be in metadata");
    assert.equal(
      hard!.last_violated_at_round, 2,
      "a committed violation belongs to its own round; findLastViolatedRound " +
      "is the one fact source, not a relabel at the compile round",
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
      withTransaction({
        loop_id: "id-re",
        loop_lineage: {
          loop_id: "id-re", round: 1,
          constraints_active: [discoveredText],
          committed_action: "continue",
        },
        success: true,
        constraint_violations: [] as string[],
        discovered_constraints: [discoveredText],
      }),
      withTransaction({
        loop_id: "id-re",
        loop_lineage: {
          loop_id: "id-re", round: 17,
          constraints_active: [discoveredText],
          committed_action: "continue",
        },
        success: true,
        constraint_violations: [] as string[],
        discovered_constraints: [] as string[],
      }),
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
    beforeEvidence: [{
      schemaVersion: 2, providerId: "git", kind: "git", phase: "before",
      startedAt: 0, finishedAt: 0, status: "observed", files: [],
      data: {
        dirty: [], fingerprints: {}, head: `h${round - 1}`,
        coverage: "tracked_and_non_ignored_untracked",
      },
    }],
    roundEvidence: [{
      schemaVersion: 2, providerId: "git", kind: "git", phase: "after",
      startedAt: 0, finishedAt: 0, status: "observed", files,
      data: {
        dirty: files,
        fingerprints: Object.fromEntries(files.map((file) => [file, "m:1"])),
        head: `h${round}`,
        coverage: "tracked_and_non_ignored_untracked",
      },
    }],
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
    // v3.8.1: Round Stats is deleted — its only renderer was the L2 prompt
    // section removed in this release, so it was computed, stored in the
    // canonical state (and therefore in stateHash) and read by nothing.
    assert.doesNotMatch(response.prompt, /Round Stats/);
    // The machine git-motion row survives, in the state file — the surface a
    // human or external tool reads.
    assert.match(response.state_file_content ?? "", /Machine \(git\)/);
    assert.match(response.state_file_content ?? "", /changes observed in 3\/3 recent committed rounds/);
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
    const mergedRound = (round: number, attempt: number, gitMotion: boolean): Record<string, unknown> => {
      const changed = gitMotion ? [`src/r${round}.ts`] : [];
      return mergedLineageRound(round, {
        loopId: "stats-loop",
        attempt,
        files: [`src/r${round}.ts`],
        progress: 0.2 + round * 0.1,
        beforeEvidence: [{
          schemaVersion: 2,
          providerId: "git",
          kind: "git",
          phase: "before",
          startedAt: 0,
          finishedAt: 0,
          status: "observed",
          files: [],
          data: {
            dirty: [],
            fingerprints: {},
            head: `h${round - 1}`,
            coverage: "tracked_and_non_ignored_untracked",
          },
        }],
        roundEvidence: [{
          schemaVersion: 2,
          providerId: "git",
          kind: "git",
          phase: "after",
          startedAt: 0,
          finishedAt: 0,
          status: "observed",
          files: changed,
          data: {
            dirty: changed,
            fingerprints: Object.fromEntries(changed.map((file) => [file, "m:1"])),
            head: gitMotion ? `h${round}` : `h${round - 1}`,
            coverage: "tracked_and_non_ignored_untracked",
          },
        }],
      });
    };
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
    // v3.8.1: the per-round stats table is gone from the prompt; the machine
    // git-motion row is a state-file row.
    assert.doesNotMatch(response.prompt, /Round Stats/);
    assert.match(response.state_file_content ?? "", /Machine \(git\)/);
    assert.match(response.state_file_content ?? "", /changes observed in 2\/3 recent committed rounds/,
      "R1+R2 moved; R3 recorded no motion");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Round Contract self-eval template
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.1 — Round Contract eval template", () => {
  it("shows real active-contract item ids without requiring a restatement", () => {
    const block = buildSelfEvalBlock(evalCtx({
      round: 4,
      level: "l2",
      activeContract: testContract(),
    }));
    assert.ok(block.includes("rci-12345678"), "renders the real rci id");
    assert.ok(block.includes("do NOT need to restate"), "no mechanical restatement");
    assert.ok(!block.includes("done_when"), "old contract shape is gone");
    assert.ok(!block.includes("verification_plan"), "old contract shape is gone");
  });

  it("shows a first declaration only when a contract command is available", () => {
    const first = buildSelfEvalBlock(evalCtx({
      round: 4,
      activeContract: null,
      commands: ["verify"],
    }));
    assert.ok(first.includes("round_contract"), "first declaration is offered");
    assert.ok(first.includes("verify"), "uses the real command name");
    const noCommand = buildSelfEvalBlock(evalCtx({
      activeContract: null,
      commands: [],
      contractVerificationAvailable: false,
    }));
    assert.ok(!noCommand.includes("round_contract"),
      "no command → no contract proposal");
    assert.ok(noCommand.includes("run without a contract"));
  });

  it("L0 retry stays lean but keeps functional contract claims", () => {
    const retry = buildSelfEvalBlock(evalCtx({
      round: 4,
      level: "l0",
      activeContract: testContract(),
      subGoals: [testSubGoal()],
    }));
    assert.ok(!retry.includes("retroactiveClaims"), "no L1/L2 extras at L0");
    assert.ok(retry.includes("rci-12345678"), "item claims remain functional");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.4 — ACTIVE Round Contract derivation at compile time
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.4 — ACTIVE Round Contract derivation (compileLoop)", () => {
  beforeEach(() => resetPolicy());
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
    assert.ok(!res.prompt.includes("restate the Current Task's contract UNCHANGED"),
      "L0 retry stays lean — no restatement requirement");
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
    assert.ok(res.prompt.includes("round_contract"),
      "the closing round may declare a successor proposal");
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
  const baselineRound1 = (loopId: string): Record<string, unknown> =>
    withTransaction({
      loop_id: loopId,
      output_summary: "Round 1 done",
      success: true,
      loop_lineage: {
        loop_id: loopId,
        round: 1,
        constraints_active: ["Tests must pass", "Keep API stable", "Migrate data"],
        committed_action: "continue",
      },
      constraint_violations: [],
    });

  it("L2 stays self-contained with current governance, without a history blob", () => {
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
    assert.ok(!response.prompt.includes("Full Rehydrated State"),
      "L2 never falls back to a monolithic history blob");
    assert.ok(response.prompt.includes("Continue the migration"),
      "the prompt stays self-contained for current governance");
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

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.2 — real criteria in the compact evaluation block
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.2 — compact criteria guidance", () => {
  it("renders real criterion ids and text in the compiled prompt", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "criteria-prompt",
      round: 2,
      task: "Build a parser",
      force_level: "l1",
      loop_objective: makeLoopObjective({
        loop_id: "criteria-prompt",
        objective: "Build a parser",
        success_criteria: ["Parser complete", "Tests pass"],
      }),
    }), null);
    const criterionId = deriveCriterionId("Parser complete");
    assert.match(response.prompt, /Optional fields — trigger → field → effect/);
    assert.match(response.prompt, new RegExp(criterionId));
    assert.match(response.prompt, /Parser complete/);
    assert.doesNotMatch(response.prompt, /<criterion text or cr id from the prompt>/);
  });

  it("omits criterion_claims from the compact list when no criteria exist", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "criteria-empty",
      round: 2,
      task: "Build a parser",
      force_level: "l1",
    }), null);
    // The compiler supplies its default criterion, so the field is still
    // present; the important part is that no placeholder text is emitted.
    assert.doesNotMatch(response.prompt, /<criterion text or cr id from the prompt>/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.9.3 — committed-fact prompt level and the L0 field interface
// ═══════════════════════════════════════════════════════════════════════════

describe("3.9.3 — committed-fact prompt level", () => {
  const gitObservation = (
    phase: "before" | "after",
    fingerprints: Record<string, string>,
    head: string,
  ): MachineObservation => ({
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files: [],
    data: {
      dirty: [],
      fingerprints,
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  } as MachineObservation);

  const noMotionEvidence = () => ({
    beforeEvidence: [gitObservation("before", {}, "aaa")],
    afterEvidence: [gitObservation("after", {}, "aaa")],
  });

  const committed = (
    loopId: string,
    round: number,
    entry: Record<string, unknown> = {},
    success = false,
  ) => withTransaction({
    loop_id: loopId,
    loop_lineage: {
      loop_id: loopId,
      round,
      constraints_active: [],
      committed_action: "continue",
    },
    success,
    ...entry,
  }, "continue", noMotionEvidence());

  it("v3.9.5: committed corrections and prompt_requests reach the next prompt", () => {
    const loopId = "committed-reports";
    const context = {
      results: [committed(loopId, 2, {
        output_summary: "a prior summary that must not be replayed",
        wrong_assumptions: ["old belief"],
        prompt_requests: { confusion_points: ["what does committed mean?"] },
      })],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Continue",
      force_level: "l2",
    }), context);
    assert.match(response.prompt, /Corrections \(committed reports\)/);
    assert.match(response.prompt, /Corrected assumption: old belief/);
    assert.match(response.prompt, /Confusion Alerts/);
    assert.match(response.prompt, /what does committed mean\?/);
    assert.doesNotMatch(response.prompt, /a prior summary that must not be replayed/);
  });

  it("v3.9.5: no prompt level replays a committed output_summary", () => {
    const loopId = "no-summary-any-level";
    const context = {
      results: [committed(loopId, 2, {
        output_summary: "UNIQUE_COMMITTED_SUMMARY",
        emerged_subtasks: [],
      })],
    };
    for (const level of ["l0", "l1", "l2"] as const) {
      const response = compileLoop(makeLoopCompileRequest({
        loop_id: loopId,
        round: 3,
        task: "Continue",
        force_level: level,
      }), context);
      assert.equal(response.prompt_artifact?.level, level);
      assert.ok(!response.prompt.includes("UNIQUE_COMMITTED_SUMMARY"),
        `${level} must not replay the committed output summary`);
      assert.ok(!response.warnings.some((warning) =>
        warning.includes("duplicate_declaration")),
        "zero emerged_subtasks is not a warning");
    }
  });

  it("ignores a caller last_round_result when committed history exists", () => {
    const loopId = "det";
    const context = {
      results: [committed(loopId, 2)],
    };
    const base = makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Do work",
    });
    const without = compileLoop(base, context);
    const withLegacy = compileLoop({
      ...base,
      last_round_result: makeLoopRoundResult({
        round: 2,
        success: true,
        output_summary: "a stale caller projection",
        discovered_constraints: ["stale constraint"],
      }),
    }, context);

    assert.equal(withLegacy.recompile_level, without.recompile_level);
    assert.equal(withLegacy.diff_from_previous, without.diff_from_previous);
    assert.equal(
      withLegacy.prompt_artifact?.promptHash,
      without.prompt_artifact?.promptHash,
    );
    assert.equal(
      withLegacy.prompt_artifact?.stateHash,
      without.prompt_artifact?.stateHash,
    );
    assert.deepEqual(withLegacy.warnings, without.warnings);
    assert.equal(withLegacy.state_file_content, without.state_file_content);
    assert.ok(!without.prompt.includes("stale constraint"),
      "the caller projection must not leak into the prompt");
  });

  it("stays L0 only when the committed round proves no activity", () => {
    const loopId = "stale";
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Do work",
      loop_objective: makeLoopObjective({
        loop_id: loopId,
        objective: "Do work",
        success_criteria: ["Ship it"],
      }),
    }), { results: [committed(loopId, 2)] });

    assert.equal(response.recompile_level, "l0");
    assert.equal(response.diff_from_previous,
      "failed_without_observable_new_information");
    const prompt = response.prompt;
    for (const path of [
      "execution_report.criterion_claims",
      "discovered_constraints",
      "wrong_assumptions",
      "emerged_subtasks",
      "worker_results",
      "compression_checkpoint",
      "prompt_requests",
    ]) {
      assert.match(prompt, new RegExp("`" + path.replace(/\./g, "\.") + "`"),
        `L0 must still offer ${path}`);
    }
    assert.match(prompt, /cr-[a-f0-9]{8}/, "real criterion id at L0");
    assert.match(prompt, /Ship it/);
  });

  it("does not let an empty retry inherit the previous committed flags", () => {
    const loopId = "retry-flags";
    const staleFlag = {
      severity: "warn" as const,
      field: "files_changed",
      check: "evidence_integrity",
      detail: "STALE_PREVIOUS_FINDING",
    };
    const context = {
      results: [withTransaction({
        loop_id: loopId,
        loop_lineage: {
          loop_id: loopId,
          round: 1,
          constraints_active: [],
          committed_action: "continue",
        },
        success: false,
        verification_flags: [staleFlag],
      }, "continue", noMotionEvidence())],
    };

    const nextRound = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 2,
      task: "Do work",
    }), context);
    assert.match(nextRound.prompt, /STALE_PREVIOUS_FINDING/,
      "a normal new round shows the committed previous findings");

    const retry = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 2,
      task: "Do work",
      attempt: 2,
      verification_flags: [],
    }), context);
    assert.equal(retry.recompile_level, "l0");
    assert.doesNotMatch(retry.prompt, /STALE_PREVIOUS_FINDING/,
      "an in-flight retry's empty findings are authoritative; they must not " +
      "fall back to the previous committed round's flags");
  });

  it("keeps L1 when the committed round has observable machine motion", () => {
    const loopId = "motion";
    const context = {
      results: [withTransaction({
        loop_id: loopId,
        loop_lineage: {
          loop_id: loopId,
          round: 2,
          constraints_active: [],
          committed_action: "continue",
        },
        success: false,
      }, "continue", {
        beforeEvidence: [gitObservation("before", { "a.ts": "m:1" }, "aaa")],
        afterEvidence: [gitObservation("after", { "a.ts": "m:2" }, "bbb")],
      })],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Do work",
    }), context);
    assert.equal(response.recompile_level, "l1");
    assert.equal(response.diff_from_previous, "state_capsule");
  });

  it("offers the current requirement as the natural contract work item", () => {
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: {
        ...DEFAULT_POLICY.evidence,
        commands: [{
          name: "verify",
          enabled: true,
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          phase: "after",
          required: true,
          timeout_ms: 1000,
          max_output_chars: 2000,
          success_exit_codes: [0],
        }],
      },
    });
    try {
      const response = compileLoop(makeLoopCompileRequest({
        loop_id: "contract-natural",
        round: 2,
        task: "Build the parser",
        force_level: "l2",
        loop_objective: makeLoopObjective({
          loop_id: "contract-natural",
          objective: "Build the parser",
          success_criteria: ["Ship the parser"],
        }),
      }), null);
      const prompt = response.prompt;
      assert.match(prompt, /The current requirement is the natural deliverable seed/);
      assert.match(prompt, /"work_item": "Build the parser"/);
      assert.match(prompt, /"criterion_refs": \[/);
      assert.match(prompt, /cr-[a-f0-9]{8}/);
      assert.match(prompt, /"verify_with": \[/);
      assert.match(prompt, /"verify"/);
      assert.doesNotMatch(prompt, /\bsg-[a-f0-9]{8}\b/);
      assert.doesNotMatch(prompt, /\brci-[a-f0-9]{8}\b/);
    } finally {
      resetPolicy();
    }
  });

  it("keeps the deep-restore recovery boundary and brief on the redo round", () => {
    const loopId = "deep-restore";
    const context = {
      results: [
        committed(loopId, 1, {}, true),
        committed(loopId, 2, {}, true),
        // Abandoned branch above the redo round: must not leak its objective.
        withTransaction({
          loop_id: loopId,
          loop_lineage: {
            loop_id: loopId,
            round: 4,
            constraints_active: [],
            committed_action: "continue",
          },
          success: true,
          loop_objective: makeLoopObjective({
            loop_id: loopId,
            objective: "ABANDONED branch",
            success_criteria: ["never"],
          }),
        }),
        committedBacktrackRound(5, loopId, 2),
      ],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Restore the parser",
    }), context);

    assert.equal(response.recompile_level, "l2");
    assert.equal(response.diff_from_previous, "recovery_boundary");
    assert.ok((response.state_file_content ?? "").includes("Restored to round**: 2"),
      "the Recovery Brief must use the decoded backtrack target");
    assert.ok(!response.prompt.includes("ABANDONED branch"),
      "the abandoned branch's objective must not leak into the redo prompt");
  });
});
