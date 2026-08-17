import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessPlanChange, validatePlan } from "../plan.js";
import type { RoundEvidenceEnvelope, StructuredPlan } from "../protocol.js";
import { deriveRegressionObligations } from "../regression-obligations.js";
import { createWorkflowEvent, workflowEventEntry } from "../workflow-events.js";

function plan(overrides: Partial<StructuredPlan> = {}): StructuredPlan {
  return {
    objective: "Ship feature",
    successCriteria: ["works"],
    constraints: ["preserve API"],
    steps: [{ id: "ps-one", title: "Implement", kind: "executable", dependsOn: [], scope: ["src"], successCriteria: ["works"], constraints: ["preserve API"], acceptanceCriteria: ["implemented"], evidenceRequirements: ["tests"], refinement: "executable", riskTags: [], status: "ready" }],
    ...overrides,
  };
}

describe("adaptive planning and regression obligations", () => {
  it("classifies normal outline filling as tactical and contract edits as contract", () => {
    const outline = plan({ steps: [{ ...plan().steps[0], kind: "outline", refinement: "outline", acceptanceCriteria: [], evidenceRequirements: [] }] });
    const refined = plan({ steps: [{ ...plan().steps[0], title: "Implement the current slice", kind: "executable", refinement: "executable" }] });
    assert.equal(assessPlanChange(outline, refined).impact, "tactical");
    assert.equal(assessPlanChange(outline, { ...refined, steps: [{ ...refined.steps[0], dependsOn: ["ps-other"] }] }).impact, "contract");
    assert.equal(assessPlanChange(plan(), { ...plan(), objective: "Change goal" }).impact, "contract");
  });

  it("returns stable diagnostics for an invalid dependency", () => {
    const invalid = plan({ steps: [{ ...plan().steps[0], dependsOn: ["ps-missing"] }] });
    const result = validatePlan(invalid, { maxSteps: 50, executableHorizon: 3 });
    assert.equal(result.valid, false);
    const diagnostic = result.diagnostics.find((item) => item.code === "unknown_dependency");
    assert.ok(diagnostic);
    assert.match(diagnostic.repairHint, /existing ps/);
  });

  it("derives a stable regression obligation from a verified er check", () => {
    const envelope = {
      files: { value: [], confidence: "unavailable", source: "agent" },
      checks: { value: [{ name: "unit", status: "passed" }], confidence: "verified", source: "command" },
      claims: [{ targetId: "er-tests", evidenceRefs: ["check:unit"] }], noChangeReason: null,
      providerNames: ["command"], checkProvenance: { unit: { confidence: "verified", source: "command" } }, providerClaims: {}, contradictions: [],
    } as unknown as RoundEvidenceEnvelope;
    const event = createWorkflowEvent("loop-1", 1, "executing", 1, "ps-one", { eventType: "step_result", payload: { step_id: "ps-one", step_status: "completed", round_id: "r1", attempt: 1, evidence: envelope, summary: "done" } });
    const obligations = deriveRegressionObligations([workflowEventEntry(event, "task")]);
    assert.equal(obligations.length, 1);
    assert.match(obligations[0].id, /^ro-/);
    assert.equal(obligations[0].lastStatus, "verified");
    assert.deepEqual(obligations, deriveRegressionObligations([workflowEventEntry(event, "task")]));
  });
});
