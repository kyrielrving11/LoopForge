import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  criticalPlanChange,
  collectPlanRiskTags,
  planRequiresApproval,
  selectActiveStep,
  validatePlan,
  validatePlanReplacement,
  deriveRefinementLinks,
} from "../plan.js";
import type { StructuredPlan } from "../protocol.js";

function validPlan(): StructuredPlan {
  return {
    objective: "Ship v3",
    successCriteria: ["tests pass"],
    constraints: ["zero runtime dependencies"],
    steps: [{
      id: "ps-core",
      title: "Implement core",
      kind: "executable",
      dependsOn: [],
      scope: ["src"],
      successCriteria: ["tests pass"],
      constraints: ["zero runtime dependencies"],
      acceptanceCriteria: ["implementation complete"],
      evidenceRequirements: ["npm test"],
      refinement: "executable",
      riskTags: [],
      status: "ready",
    }],
  };
}

describe("v3 plan validation", () => {
  it("accepts a covered executable DAG and selects its ready step", () => {
    const plan = validPlan();
    const result = validatePlan(plan, { maxSteps: 50, executableHorizon: 3 });
    assert.equal(result.valid, true, result.errors.join("; "));
    assert.equal(selectActiveStep(plan)?.id, "ps-core");
  });

  it("rejects duplicate IDs, missing dependencies, cycles, and uncovered criteria", () => {
    const plan = validPlan();
    plan.successCriteria.push("docs updated");
    plan.steps.push({ ...structuredClone(plan.steps[0]), dependsOn: ["ps-missing"], title: "Duplicate" });
    const result = validatePlan(plan, { maxSteps: 50, executableHorizon: 3 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("duplicate")));
    assert.ok(result.errors.some((error) => error.includes("unknown dependency")));
    assert.ok(result.errors.some((error) => error.includes("uncovered success criteria")));
  });

  it("requires approval for fixed high-risk tags and critical revisions", () => {
    const plan = validPlan();
    const revised = structuredClone(plan);
    revised.steps[0].riskTags = ["production_change"];
    assert.equal(planRequiresApproval(revised), true);
    assert.equal(criticalPlanChange(plan, revised), true);
  });

  it("requires approval when an executable contract or dependency changes", () => {
    const plan = validPlan();
    const acceptanceChanged = structuredClone(plan);
    acceptanceChanged.steps[0].acceptanceCriteria = ["summary written"];
    assert.equal(criticalPlanChange(plan, acceptanceChanged), true);

    const evidenceChanged = structuredClone(plan);
    evidenceChanged.steps[0].evidenceRequirements = ["manual confirmation"];
    assert.equal(criticalPlanChange(plan, evidenceChanged), true);

    const dependencyChanged = structuredClone(plan);
    dependencyChanged.steps.push({
      ...validPlan().steps[0],
      id: "ps-dependency",
      title: "Dependency",
      status: "pending",
    });
    dependencyChanged.steps[0].dependsOn = ["ps-dependency"];
    assert.equal(criticalPlanChange(plan, dependencyChanged), true);
  });

  it("does not allow completed steps to be removed or changed", () => {
    const plan = validPlan();
    plan.steps[0].status = "done";
    assert.ok(validatePlanReplacement(plan, { ...plan, steps: [] }).length > 0);
    const changed = structuredClone(plan);
    changed.steps[0].title = "Mutated history";
    assert.ok(validatePlanReplacement(plan, changed).length > 0);
  });

  it("rejects server-owned statuses on initial submission", () => {
    const plan = validPlan();
    plan.steps[0].status = "done";
    const result = validatePlan(plan, { maxSteps: 50, executableHorizon: 3 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("initial plan status")));
  });

  it("rejects refinement lineage on an initial plan", () => {
    const plan = validPlan();
    plan.steps[0].refinesStepId = "ps-outline";
    const result = validatePlan(plan, { maxSteps: 50, executableHorizon: 3 });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("initial plan steps cannot declare refinesStepId")));
  });

  it("allows one outline to be refined into multiple executable children", () => {
    const previous: StructuredPlan = {
      ...validPlan(),
      steps: [{
        id: "ps-phase",
        title: "Phase outline",
        kind: "outline",
        dependsOn: [],
        scope: ["src"],
        successCriteria: ["tests pass"],
        constraints: ["zero runtime dependencies"],
        acceptanceCriteria: [],
        evidenceRequirements: [],
        refinement: "outline",
        riskTags: [],
        status: "ready",
      }],
    };
    const next: StructuredPlan = {
      ...previous,
      steps: [
        { ...previous.steps[0], status: "canceled" },
        {
          ...validPlan().steps[0], id: "ps-part-a", title: "Part A", refinesStepId: "ps-phase",
          dependsOn: [], status: "ready",
        },
        {
          ...validPlan().steps[0], id: "ps-part-b", title: "Part B", refinesStepId: "ps-phase",
          dependsOn: ["ps-part-a"], status: "pending",
        },
      ],
    };
    const errors = validatePlanReplacement(previous, next);
    assert.deepEqual(errors, []);
    assert.deepEqual(deriveRefinementLinks(next), [{ sourceStepId: "ps-phase", childStepIds: ["ps-part-a", "ps-part-b"] }]);
  });

  it("rejects unknown, completed, and non-outline refinement sources", () => {
    const previous = validPlan();
    const unknown = structuredClone(previous);
    unknown.steps.push({ ...previous.steps[0], id: "ps-child", refinesStepId: "ps-missing", status: "ready" });
    assert.ok(validatePlanReplacement(previous, unknown).some((error) => error.includes("does not exist")));

    const completedOutline = structuredClone(previous);
    completedOutline.steps[0] = {
      ...completedOutline.steps[0], kind: "outline", refinement: "outline", status: "done",
      acceptanceCriteria: [], evidenceRequirements: [],
    };
    const completedChild = structuredClone(completedOutline);
    completedChild.steps.push({ ...previous.steps[0], id: "ps-child", refinesStepId: "ps-core", status: "ready" });
    assert.ok(validatePlanReplacement(completedOutline, completedChild).some((error) => error.includes("already terminal")));

    const nonOutlineChild = structuredClone(previous);
    nonOutlineChild.steps.push({ ...previous.steps[0], id: "ps-child", refinesStepId: "ps-core", status: "ready" });
    assert.ok(validatePlanReplacement(previous, nonOutlineChild).some((error) => error.includes("must be an outline")));
  });

  it("does not permit removing an unrefined outline", () => {
    const previous: StructuredPlan = {
      ...validPlan(),
      steps: [{
        id: "ps-phase", title: "Phase outline", kind: "outline", dependsOn: [], scope: ["src"],
        successCriteria: ["tests pass"], constraints: ["zero runtime dependencies"], acceptanceCriteria: [],
        evidenceRequirements: [], refinement: "outline", riskTags: [], status: "ready",
      }],
    };
    const next = { ...previous, steps: [] };
    assert.ok(validatePlanReplacement(previous, next).some((error) => error.includes("outline cannot be removed")));
  });

  it("infers approval risk from protected operation language", () => {
    const plan = validPlan();
    plan.steps[0].scope = ["deploy to production"];
    assert.equal(planRequiresApproval(plan), true);
  });

  it("recognizes migration directories and production infrastructure paths", () => {
    const migration = validPlan();
    migration.steps[0].scope = ["db/migrations/001-init.sql"];
    assert.ok(collectPlanRiskTags(migration).includes("data_migration"));
    const production = validPlan();
    production.steps[0].scope = ["infra/prod.tf"];
    assert.ok(collectPlanRiskTags(production).includes("production_change"));
  });

  it("preserves risk semantics when an outline is refined", () => {
    const previous: StructuredPlan = {
      ...validPlan(),
      steps: [{
        ...validPlan().steps[0],
        id: "ps-release",
        title: "Deploy to production",
        kind: "outline",
        refinement: "outline",
        acceptanceCriteria: [],
        evidenceRequirements: [],
        status: "ready",
      }],
    };
    assert.equal(planRequiresApproval(previous), true);

    const child = {
      ...validPlan().steps[0],
      id: "ps-release-child",
      title: "Apply config",
      refinesStepId: "ps-release",
      status: "ready" as const,
    };
    const missing = {
      ...previous,
      steps: [{ ...previous.steps[0], status: "canceled" as const }, child],
    };
    assert.ok(validatePlanReplacement(previous, missing).some((error) => error.includes("inherit risk tags")));

    const inherited = {
      ...missing,
      steps: [{ ...missing.steps[0] }, { ...child, riskTags: ["production_change" as const] }],
    };
    assert.deepEqual(validatePlanReplacement(previous, inherited), []);
  });
});
