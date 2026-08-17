import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalLoopState } from "../canonical-state.js";
import {
  assemblePromptArtifact,
  DEFAULT_PROMPT_BUDGETS,
  PROMPT_ARTIFACT_SCHEMA_VERSION,
} from "../prompt-assembler.js";

function state(overrides: Partial<CanonicalLoopState> = {}): CanonicalLoopState {
  return {
    schemaVersion: 3,
    loopId: "prompt-v3",
    round: 2,
    maxRounds: 20,
    goalId: "goal-v3",
    objective: "Ship a verified change",
    objectiveVersion: 1,
    currentTask: "Implement the active step",
    compilationContext: {
      planVersion: 2,
      promptMode: "step_start",
      activeStep: {
        id: "ps-change",
        title: "Implement and verify",
        kind: "executable",
        dependsOn: [],
        scope: ["src/change.ts"],
        successCriteria: ["all checks pass"],
        constraints: ["preserve API"],
        acceptanceCriteria: ["change works"],
        evidenceRequirements: ["tests pass"],
        refinement: "executable",
        riskTags: [],
        status: "active",
      },
      objective: "Ship a verified change",
      successCriteria: ["all checks pass"],
      claimTargets: [
        { id: "ac-change", text: "change works", kind: "acceptance" },
        { id: "er-tests", text: "tests pass", kind: "evidence" },
      ],
      evidenceGaps: [{ id: "er-tests", text: "tests pass", kind: "evidence" }],
      failedChecks: [],
      instruction: "Execute only the assigned active step.",
    },
    successCriteria: ["all checks pass"],
    hardConstraints: ["preserve API"],
    activeConstraints: ["preserve API"],
    constraintMetadata: [],
    changesSinceLastRound: [],
    blockers: [],
    verificationFlags: [],
    discoveries: [],
    rollingOutcomes: [],
    recurringIssues: [],
    failedPatterns: [],
    milestones: [],
    loopSynthesis: "",
    externalContext: "",
    stateFilePath: ".loopforge/state/prompt-v3.md",
    evidence: {
      files: ["src/change.ts"],
      checks: [{ name: "unit", status: "passed" }],
      coveredClaims: ["ac-change"],
      evidenceGaps: ["er-tests: tests pass"],
    },
    graphSlice: {
      planVersion: 2,
      activeStepId: "ps-change",
      parentOutlineId: "ps-phase",
      dependencyStepIds: [],
      dependencySummaries: [],
      relevantConstraintIds: ["c-api"],
      requiredClaimIds: ["ac-change", "er-tests"],
      uncoveredClaimIds: ["er-tests"],
      priorAttemptSummary: null,
      blockedDescendantCount: 2,
      regressionGapIds: ["ro-unit"],
    },
    ...overrides,
  };
}

function artifact(level: "l0" | "l1" | "l2", overrides = {}) {
  return assemblePromptArtifact({
    state: state(),
    level,
    reasons: ["state_capsule"],
    reportInstructions: "Return RoundReportV1 JSON.",
    reportMode: level === "l0" ? "step_retry" : "step_start",
    roundId: "loop:prompt-v3:round:2",
    ...overrides,
  });
}

describe("v3 prompt assembly", () => {
  it("emits deterministic hashes and the strict report footer", () => {
    const left = artifact("l1");
    const right = artifact("l1");
    assert.equal(left.schemaVersion, PROMPT_ARTIFACT_SCHEMA_VERSION);
    assert.equal(left.promptHash, right.promptHash);
    assert.equal(left.stateHash, right.stateHash);
    assert.match(left.renderedPrompt, /sessionId, roundId/);
    assert.match(left.renderedPrompt, /RoundReportV1/);
    assert.match(left.renderedPrompt, /ps-change: Implement and verify/);
    assert.doesNotMatch(left.renderedPrompt, /\{"planVersion"/);
  });

  it("keeps graph context out of L0 and includes it for L1/L2", () => {
    const retry = artifact("l0");
    const start = artifact("l1");
    assert.doesNotMatch(retry.renderedPrompt, /Active Graph Slice/);
    assert.match(start.renderedPrompt, /Active Graph Slice/);
    assert.match(start.renderedPrompt, /Regression gaps: ro-unit/);
    assert.ok(start.includedSections.includes("graph_slice"));
  });

  it("honors per-level budgets and one-shot context requests", () => {
    const result = artifact("l2", {
      contextRequest: { confusion_points: ["Which parser owns this token?"], emphasize: ["preserve API"] },
    });
    assert.ok(result.charCount <= DEFAULT_PROMPT_BUDGETS.l2);
    assert.equal(result.budgetExceeded, false);
    assert.match(result.renderedPrompt, /Which parser owns this token/);
    assert.match(result.renderedPrompt, /preserve API/);
  });
});
