import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CANONICAL_STATE_SCHEMA_VERSION,
  createCanonicalLoopState,
  hashCanonicalState,
  renderCanonicalStateMarkdown,
  stableStringify,
} from "../canonical-state.js";
import {
  makeLoopCompileRequest,
  makeLoopCompileResponse,
  makeLoopObjective,
  makeRoundHistoryEntry,
} from "../protocol.js";

function fixture() {
  const request = makeLoopCompileRequest({
    loop_id: "canonical-v3",
    round: 2,
    task: "Implement the active step",
    max_rounds: 12,
    compilation_context: {
      planVersion: 2,
      promptMode: "step_continue",
      activeStep: {
        id: "ps-change",
        title: "Implement and verify",
        kind: "executable",
        dependsOn: [],
        scope: ["src/parser.ts"],
        successCriteria: ["all checks pass"],
        constraints: ["preserve the public API"],
        acceptanceCriteria: ["change works"],
        evidenceRequirements: ["tests pass"],
        refinement: "executable",
        riskTags: [],
        status: "active",
      },
      objective: "Ship a verified parser change",
      successCriteria: ["all checks pass"],
      claimTargets: [
        { id: "ac-change", text: "change works", kind: "acceptance" },
        { id: "er-tests", text: "tests pass", kind: "evidence" },
      ],
      evidenceGaps: [{ id: "er-tests", text: "tests pass", kind: "evidence" }],
      failedChecks: [],
      instruction: "Execute only the assigned active step.",
    },
    report_claim_targets: [
      { id: "ac-change", text: "change works", kind: "acceptance" },
      { id: "er-tests", text: "tests pass", kind: "evidence" },
    ],
    last_evaluation: makeRoundHistoryEntry({
      round: 1,
      status: "in_progress",
      summary: "Implemented the first half.",
      discoveries: { facts: ["The parser is shared."] },
      evidenceEnvelope: {
        files: { value: ["src/parser.ts"], confidence: "verified", source: "git" },
        checks: { value: [{ name: "unit", status: "passed" }], confidence: "verified", source: "command" },
        claims: [{ targetId: "ac-change", evidenceRefs: ["check:unit"] }],
        noChangeReason: null,
        providerNames: ["git", "command"],
        checkProvenance: { unit: { confidence: "verified", source: "command" } },
        providerClaims: {},
        contradictions: [],
      },
    }),
    graph_slice: {
      planVersion: 2,
      activeStepId: "ps-change",
      parentOutlineId: "ps-phase",
      dependencyStepIds: ["ps-setup"],
      dependencySummaries: ["ps-setup completed"],
      relevantConstraintIds: ["c-safe"],
      requiredClaimIds: ["ac-change", "er-tests"],
      uncoveredClaimIds: ["er-tests"],
      priorAttemptSummary: null,
      blockedDescendantCount: 1,
      regressionGapIds: [],
    },
  });
  const response = makeLoopCompileResponse({
    loop_id: "canonical-v3",
    round: 2,
    goal_id: "goal-v3",
    loop_objective: makeLoopObjective({
      objective: "Ship a verified parser change",
      success_criteria: ["all checks pass"],
      hard_constraints: ["preserve the public API"],
      loop_id: "canonical-v3",
    }),
    constraints_active: ["preserve the public API"],
  });
  return createCanonicalLoopState(request, response, ".loopforge/state/canonical-v3.md");
}

describe("canonical v3 state", () => {
  it("uses deterministic schema-3 serialization and hashing", () => {
    assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
    const left = fixture();
    const right = fixture();
    assert.equal(left.schemaVersion, CANONICAL_STATE_SCHEMA_VERSION);
    assert.equal(hashCanonicalState(left), hashCanonicalState(right));
    assert.notEqual(hashCanonicalState(left), hashCanonicalState({ ...right, round: 3 }));
  });

  it("projects typed report evidence and graph gaps without subjective progress", () => {
    const state = fixture();
    assert.equal(state.compilationContext?.activeStep?.id, "ps-change");
    assert.deepEqual(state.evidence.files, ["src/parser.ts"]);
    assert.deepEqual(state.evidence.coveredClaims, ["ac-change"]);
    assert.deepEqual(state.evidence.evidenceGaps, ["er-tests: tests pass"]);
    assert.deepEqual(state.discoveries, ["The parser is shared."]);
    assert.equal(state.graphSlice?.parentOutlineId, "ps-phase");
  });

  it("renders Markdown as a rebuildable evidence view", () => {
    const markdown = renderCanonicalStateMarkdown(fixture());
    assert.match(markdown, /## Evidence Gaps/);
    assert.match(markdown, /er-tests: tests pass/);
    assert.match(markdown, /## Active Graph Slice/);
    assert.match(markdown, /ps-change: Implement and verify/);
    assert.doesNotMatch(markdown, /\{"planVersion"/);
    assert.doesNotMatch(markdown, /Overall progress|Sub-Goals|Next Action/i);
    assert.ok(markdown.endsWith("\n"));
  });
});
