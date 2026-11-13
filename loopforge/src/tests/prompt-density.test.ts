/** v4.0.8 — prompt/guidance density and same-fact deduplication.
 *
 *  The baselines are the 4.0.7 measurements recorded in the release plan.
 *  They are test data only; no baseline file is read at runtime.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemblePromptArtifact } from "../prompt-assembler.js";
import {
  CANONICAL_STATE_SCHEMA_VERSION,
  type CanonicalLoopState,
} from "../canonical-state.js";
import { compileLoop } from "../loop-compiler.js";
import { makeLoopCompileRequest, makeLoopObjective } from "../protocol.js";
import type {
  ConfiguredCapability,
  CriterionStatus,
  SubGoal,
} from "../protocol.js";
import type { ActiveContractView } from "../round-contract.js";
import type { ContractItemStatusView } from "../contract-items.js";
import type { WorkingMemory } from "../working-memory.js";
import { deriveSubmissionGuidance, renderSelfEvalBlock } from "../submission-guidance.js";
import { deriveConfiguredCapability, DEFAULT_POLICY, resetPolicy } from "../policy.js";
import { deriveCriterionId, deriveItemId } from "../token-utils.js";
import {
  committedFeedbackRound,
  fixtureEvidencePosture,
} from "./_helpers.js";
import { MACHINE_EVIDENCE_AUTHORITY } from "../evidence-posture-view.js";
import { ROUND_BOUNDARY_INVOCATION_LOST } from "../round-guidance.js";

const FIRST_ROUND_BASELINE = 7_225;
const SECOND_ROUND_BASELINE = 7_203;
const L0_RETRY_BASELINE = 5_317;
const GUIDANCE_BASELINE = 5_943;
const FULL_PAYLOAD_BASELINE = 13_168;

function reduction(baseline: number, current: number): number {
  return 1 - current / baseline;
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function testCapability(): ConfiguredCapability {
  return {
    schemaVersion: 1,
    providers: [],
    commands: [{
      commandId: "verify",
      enabled: true,
      phase: "after",
      required: true,
      configHash: "hash-verify",
    }],
    observationConfigured: false,
    contractVerificationAvailable: true,
  };
}

function testContract(): ActiveContractView {
  return {
    id: "rc-12345678",
    declared_at_round: 1,
    work_item: "Slice A",
    scope: ["src"],
    items: [{
      id: "rci-12345678",
      description: "acceptance item",
      criterion_refs: [],
      verify_with: ["verify"],
    }],
    config_hash_by_command: { verify: "hash-verify" },
  };
}

function testItemStatuses(): ContractItemStatusView {
  return {
    contractId: "rc-12345678",
    closure: "open",
    closed_at_round: null,
    items: [{
      itemId: "rci-12345678",
      description: "acceptance item",
      status: "pending",
      status_at_round: null,
      history: [],
      reasons: [],
    }],
    verifiedCount: 0,
    contradictedCount: 0,
    insufficientCount: 0,
  };
}

function testMemory(): WorkingMemory {
  return {
    reports: [{
      roundId: "loop:density:round:1",
      round: 1,
      attempt: 1,
      agentSuccessClaim: true,
      agentOutcome: "success",
      outputSummary: "UNIQUE_WORKING_MEMORY_MARKER",
      sourceChars: 30,
    }],
    assumptions: [],
    openQuestions: [],
    recoveries: [],
    redirects: [],
    sourceCounts: {
      windowRounds: 1, reports: 1, assumptions: 0,
      openQuestions: 0, recoveries: 0, redirects: 0,
    },
  };
}

function testSubGoal(): SubGoal {
  return {
    id: "sg-12345678",
    description: "sub-goal under test",
    status: "in_progress",
    declared_at_round: 1,
    status_changed_at_round: 1,
    priority: 0,
  };
}

function testCriteria(): CriterionStatus[] {
  return [{
    id: deriveCriterionId("all tests pass"),
    text: "all tests pass",
    status: "unknown",
  }];
}

function minimalState(overrides: Partial<CanonicalLoopState> = {}): CanonicalLoopState {
  return {
    schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
    loopId: "density-loop",
    round: 2,
    maxRounds: 20,
    goalId: "goal-density",
    objective: "Density objective",
    currentTask: "Density task",
    rejectionNotice: null,
    successCriteria: ["all tests pass"],
    hardConstraints: ["no runtime deps"],
    activeConstraints: ["no runtime deps", "all tests pass"],
    retiredConstraints: [],
    constraintMetadata: [],
    reportedIssues: [],
    warnings: [],
    verificationFlags: [],
    subGoals: [],
    criterionStatuses: testCriteria(),
    recurringFlags: [],
    stateFilePath: ".loopforge/state/density-loop-state.md",
    capability: deriveConfiguredCapability(DEFAULT_POLICY),
    reportedProgress: {
      criteriaMet: [],
      criteriaRemaining: [],
      agentReportedRemaining: [],
      filesChanged: [],
    },
    ...overrides,
  };
}

function assemble(
  state: CanonicalLoopState,
  options: {
    level?: "l0" | "l1" | "l2";
    contextMode?: "fresh_invocation" | "same_round_retry";
    contextReason?: "first_round" | "next_round" | "recovery_redo" |
      "enforcement_retry" | "rejection_escalation" | "invocation_recovery";
    attempt?: number;
  } = {},
) {
  const level = options.level ?? "l2";
  const contextMode = options.contextMode ?? "fresh_invocation";
  const contextReason = options.contextReason ?? "next_round";
  const attempt = options.attempt ?? 1;
  const ctx = {
    round: state.round,
    maxRounds: state.maxRounds,
    activeContract: state.roundContract ?? null,
    itemStatuses: state.contractItemStatuses ?? null,
    commands: ["verify"],
    contractVerificationAvailable:
      state.capability.contractVerificationAvailable,
    subGoals: state.subGoals,
    gateEnabled: false,
    criteria: state.criterionStatuses,
  };
  return assemblePromptArtifact({
    state,
    level,
    attempt,
    contextMode,
    contextReason,
    selfEvaluationBlock: renderSelfEvalBlock(ctx),
    workingMemory: state.workingMemory,
  });
}

describe("v4.0.8 — prompt density budgets", () => {
  it("keeps the first-round prompt under 4,000 chars and 40% smaller", () => {
    resetPolicy();
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "density-first",
      round: 1,
      task: "Ship the parser",
      loop_objective: makeLoopObjective({
        loop_id: "density-first",
        objective: "Ship the parser",
        success_criteria: ["all tests pass"],
        hard_constraints: ["no runtime deps"],
      }),
    }), null);
    assert.equal(response.prompt_artifact?.level, "l2");
    assert.equal(response.prompt_artifact?.contextReason, "first_round");
    assert.ok(response.prompt.length <= 4_000,
      `first-round prompt was ${response.prompt.length} chars`);
    assert.ok(reduction(FIRST_ROUND_BASELINE, response.prompt.length) >= 0.40,
      `first-round reduction was ${reduction(FIRST_ROUND_BASELINE, response.prompt.length)}`);
  });

  it("keeps the second-round prompt under 4,300 chars and 40% smaller", () => {
    resetPolicy();
    const loopId = "density-second";
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 2,
      task: "Ship the parser",
      force_level: "l1",
    }), {
      results: [committedFeedbackRound(1, { loopId, success: true })],
    });
    assert.equal(response.prompt_artifact?.level, "l1");
    assert.ok(response.prompt.length <= 4_300,
      `second-round prompt was ${response.prompt.length} chars`);
    assert.ok(reduction(SECOND_ROUND_BASELINE, response.prompt.length) >= 0.40,
      `second-round reduction was ${reduction(SECOND_ROUND_BASELINE, response.prompt.length)}`);
  });

  it("keeps the minimal L0 retry prompt under 4,500 chars", () => {
    resetPolicy();
    const loopId = "density-retry";
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 2,
      task: "Ship the parser",
      force_level: "l0",
      attempt: 2,
      rejection_notice: "fix the finding",
    }), {
      results: [committedFeedbackRound(1, { loopId, success: true })],
    });
    assert.equal(response.prompt_artifact?.contextMode, "same_round_retry");
    assert.ok(response.prompt.length <= 4_500,
      `L0 retry prompt was ${response.prompt.length} chars`);
    assert.ok(reduction(L0_RETRY_BASELINE, response.prompt.length) >= 0.15,
      `L0 retry reduction was ${reduction(L0_RETRY_BASELINE, response.prompt.length)}`);
  });

  it("keeps the minimal prompt + guidance under 8,000 chars and 35% smaller", () => {
    resetPolicy();
    const loopId = "density-payload";
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 1,
      task: "Ship the parser",
      loop_objective: makeLoopObjective({
        loop_id: loopId,
        objective: "Ship the parser",
        success_criteria: ["all tests pass"],
        hard_constraints: ["no runtime deps"],
      }),
    }), null);
    const guidance = deriveSubmissionGuidance(
      {
        loopId,
        currentRound: 1,
        maxRounds: 200,
        roundSnapshot: {
          promptArtifact: response.prompt_artifact ?? undefined,
        },
      },
      {
        rounds: [],
        objective: { success_criteria: ["all tests pass"] },
      },
    );
    const guidanceChars = JSON.stringify(guidance).length;
    const payload = response.prompt.length + guidanceChars;
    assert.ok(guidanceChars <= 4_500,
      `submission_guidance was ${guidanceChars} chars`);
    assert.ok(payload <= 8_000, `dynamic payload was ${payload} chars`);
    assert.ok(reduction(FULL_PAYLOAD_BASELINE, payload) >= 0.35,
      `dynamic payload reduction was ${reduction(FULL_PAYLOAD_BASELINE, payload)}`);
    assert.ok(reduction(GUIDANCE_BASELINE, guidanceChars) >= 0.24,
      `guidance reduction was ${reduction(GUIDANCE_BASELINE, guidanceChars)}`);
  });

  it("is deterministic for identical inputs", () => {
    resetPolicy();
    const request = makeLoopCompileRequest({
      loop_id: "density-deterministic",
      round: 1,
      task: "Ship the parser",
      loop_objective: makeLoopObjective({
        loop_id: "density-deterministic",
        objective: "Ship the parser",
        success_criteria: ["all tests pass"],
      }),
    });
    const first = compileLoop(request, null);
    const second = compileLoop(request, null);
    assert.equal(first.prompt, second.prompt);
    assert.equal(first.prompt_artifact?.promptHash, second.prompt_artifact?.promptHash);
    assert.deepEqual(first.prompt_artifact?.sections, second.prompt_artifact?.sections);
  });
});

describe("v4.0.8 — same-fact deduplication and fact preservation", () => {
  it("merges an identical objective and current task exactly once", () => {
    const marker = "UNIQUE_OBJECTIVE_MARKER";
    const state = minimalState({ objective: marker, currentTask: marker });
    const artifact = assemble(state);
    assert.equal(occurrences(artifact.renderedPrompt, marker), 1);
    assert.ok(artifact.renderedPrompt.includes("Objective / Current Task"));
    assert.ok(artifact.sections.includes("objective"));
    assert.ok(!artifact.sections.includes("current_task"));
  });

  it("keeps different objective and current task separate", () => {
    const state = minimalState({
      objective: "OVERALL_OBJECTIVE",
      currentTask: "CURRENT_SLICE",
    });
    const artifact = assemble(state);
    assert.ok(artifact.renderedPrompt.includes("### Objective\nOVERALL_OBJECTIVE"));
    assert.ok(artifact.renderedPrompt.includes("### Current Task\nCURRENT_SLICE"));
  });

  it("names every active fact exactly where it belongs", () => {
    const contract = testContract();
    const state = minimalState({
      round: 2,
      roundContract: contract,
      contractItemStatuses: testItemStatuses(),
      subGoals: [testSubGoal()],
      workingMemory: testMemory(),
      recoveryBrief: ["**Restored checkpoint**: ck-123456789012345678901234"],
      verificationFlags: [{
        severity: "error",
        field: "execution_report.files_changed",
        check: "evidence_integrity",
        detail: "UNIQUE_FINDING_DETAIL",
        ref: "verify",
      }],
      capability: testCapability(),
    });
    const artifact = assemble(state);
    const prompt = artifact.renderedPrompt;
    const currentFacts = prompt.slice(0, prompt.indexOf("### LoopForge Evaluation"));

    // Current contract fact: one item row in the current-fact region.
    assert.equal(occurrences(currentFacts, "rci-12345678"), 1,
      "contract item id appears once in the current-fact region");
    assert.ok(prompt.includes("rc-12345678"));
    assert.ok(prompt.includes("sg-12345678"));
    assert.ok(prompt.includes("Recovery Brief"));
    assert.ok(prompt.includes("UNIQUE_FINDING_DETAIL"));
    assert.ok(prompt.includes("UNIQUE_WORKING_MEMORY_MARKER"));
    assert.ok(prompt.includes(deriveCriterionId("all tests pass")));
    assert.ok(prompt.includes(`c-${deriveItemId("no runtime deps")}`));
    assert.ok(prompt.includes("clean context — next round"));
    assert.ok(prompt.includes("`submissionHandle`"));
    for (const path of [
      "objective_refinement",
      "discovered_constraints",
      "wrong_assumptions",
      "open_questions",
      "emerged_subtasks",
      "worker_results",
      "subtask_boundary",
    ]) {
      assert.ok(prompt.includes(path), `optional field ${path} stays discoverable`);
    }
  });

  it("renders the invocation-lost rule once, not in both header and footer", () => {
    const state = minimalState();
    const artifact = assemble(state, {
      level: "l1",
      attempt: 2,
      contextMode: "same_round_retry",
      contextReason: "enforcement_retry",
    });
    assert.equal(occurrences(artifact.renderedPrompt, ROUND_BOUNDARY_INVOCATION_LOST), 1);
  });

  it("renders one action per check and preserves every finding detail", () => {
    const state = minimalState({
      verificationFlags: [
        {
          severity: "error",
          field: "execution_report.files_changed",
          check: "evidence_integrity",
          detail: "FIRST_FINDING_DETAIL",
          ref: "verify",
        },
        {
          severity: "error",
          field: "execution_report.claims",
          check: "evidence_integrity",
          detail: "SECOND_FINDING_DETAIL",
          ref: "verify",
        },
      ],
    });
    const artifact = assemble(state);
    assert.ok(artifact.renderedPrompt.includes("FIRST_FINDING_DETAIL"));
    assert.ok(artifact.renderedPrompt.includes("SECOND_FINDING_DETAIL"));
    assert.equal(occurrences(artifact.renderedPrompt, "→ Fix:"), 1);
  });

  it("renders the Machine Evidence authority once for both postures", () => {
    const state = minimalState({
      round: 3,
      context: {
        round: 3,
        attempt: 2,
        mode: "fresh_invocation",
        reason: "rejection_escalation",
      },
      previousEvidencePosture: fixtureEvidencePosture(2),
      retryEvidencePosture: fixtureEvidencePosture(3, { status: "contradicted" }),
    });
    const artifact = assemble(state, {
      level: "l2",
      attempt: 2,
      contextMode: "fresh_invocation",
      contextReason: "rejection_escalation",
    });
    assert.equal(occurrences(artifact.renderedPrompt, MACHINE_EVIDENCE_AUTHORITY), 1);
  });

  it("does not repeat criteria excerpts in the evaluation block", () => {
    const artifact = assemble(minimalState());
    assert.equal(occurrences(artifact.renderedPrompt, "Real criteria"), 0);
    assert.equal(occurrences(
      artifact.renderedPrompt,
      ".loopforge/state/density-loop-state.md",
    ), 1);
  });

  it("is self-sufficient without submission_guidance", () => {
    const block = renderSelfEvalBlock({
      round: 2,
      maxRounds: 20,
      activeContract: null,
      itemStatuses: null,
      commands: [],
      contractVerificationAvailable: false,
      subGoals: [],
      gateEnabled: false,
      criteria: testCriteria(),
    });
    for (const marker of [
      "outcome",
      "output_summary",
      "constraint_violations",
      "should_continue",
      "execution_report",
      "files_changed",
      "claims",
    ]) {
      assert.ok(block.includes(marker), `the prompt template carries ${marker}`);
    }
  });
});
