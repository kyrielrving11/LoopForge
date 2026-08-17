import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { StructuredPlan, RoundEvidenceEnvelope } from "../protocol.js";
import { buildGovernanceGraph } from "../governance-graph.js";
import { createWorkflowEvent, workflowEventEntry } from "../workflow-events.js";
import { stableClaimId } from "../round-report.js";
import type { VaultEntry } from "../backends/interface.js";

function outlinePlan(): StructuredPlan {
  return {
    objective: "Ship governed change",
    successCriteria: ["verified behavior"],
    constraints: ["preserve safety"],
    steps: [{
      id: "ps-phase",
      title: "Implementation phase",
      kind: "outline",
      dependsOn: [],
      scope: ["src"],
      successCriteria: ["verified behavior"],
      constraints: ["preserve safety"],
      acceptanceCriteria: [],
      evidenceRequirements: [],
      refinement: "outline",
      riskTags: [],
      status: "ready",
    }],
  };
}

function executablePlan(status: "ready" | "blocked" = "ready"): StructuredPlan {
  return {
    objective: "Ship governed change",
    successCriteria: ["verified behavior"],
    constraints: ["preserve safety"],
    steps: [{
      id: "ps-phase",
      title: "Implementation phase",
      kind: "outline",
      dependsOn: [],
      scope: ["src"],
      successCriteria: ["verified behavior"],
      constraints: ["preserve safety"],
      acceptanceCriteria: [],
      evidenceRequirements: [],
      refinement: "outline",
      riskTags: [],
      status: "canceled",
    }, {
      id: "ps-impl",
      title: "Implement behavior",
      kind: "executable",
      dependsOn: [],
      scope: ["src/feature.ts"],
      successCriteria: ["verified behavior"],
      constraints: ["preserve safety"],
      acceptanceCriteria: ["behavior works"],
      evidenceRequirements: ["unit tests pass"],
      refinement: "executable",
      refinesStepId: "ps-phase",
      riskTags: [],
      status,
    }, {
      id: "ps-followup",
      title: "Follow-up validation",
      kind: "executable",
      dependsOn: ["ps-impl"],
      scope: ["tests"],
      successCriteria: [],
      constraints: [],
      acceptanceCriteria: ["validation is recorded"],
      evidenceRequirements: ["audit check"],
      refinement: "executable",
      refinesStepId: "ps-phase",
      riskTags: [],
      status: "pending",
    }],
  };
}

function envelope(status: "passed" | "failed"): RoundEvidenceEnvelope {
  const targetId = stableClaimId("ac", "behavior works");
  return {
    files: { value: [], confidence: "unavailable", source: "agent" },
    checks: { value: [{ name: "unit", status }], confidence: status === "passed" ? "verified" : "contradicted", source: "command" },
    claims: [{ targetId, evidenceRefs: ["check:unit"] }],
    noChangeReason: null,
    providerNames: ["command-provider"],
    checkProvenance: { unit: { confidence: status === "passed" ? "verified" : "contradicted", source: "command", provider: "command-provider" } },
    providerClaims: {},
    contradictions: status === "failed" ? ["required check failed"] : [],
  };
}

function eventEntry(
  loopId: string,
  round: number,
  input: Parameters<typeof createWorkflowEvent>[5],
  planVersion: number | null,
  activeStepId: string | null,
): VaultEntry {
  return workflowEventEntry(createWorkflowEvent(loopId, round, "executing", planVersion, activeStepId, input), "graph test");
}

describe("governance graph projection", () => {
  it("projects refinement, approval, execution, and verified evidence deterministically", () => {
    const loopId = "graph-loop";
    const initial = outlinePlan();
    const refined = executablePlan();
    const entries: VaultEntry[] = [
      eventEntry(loopId, 0, {
        eventType: "plan_submitted",
        payload: {
          base_version: null, reason: "initial", change_summary: "initial outline", evidence_references: [],
          validation_warnings: [], plan: initial, effective_round: 0,
          refinement_links: [],
        },
      }, 1, null),
      eventEntry(loopId, 1, {
        eventType: "plan_updated",
        payload: {
          base_version: 1, reason: "refine phase", change_summary: "implementation children", evidence_references: [],
          validation_warnings: [], plan: refined, effective_round: 1,
          refinement_links: [{ sourceStepId: "ps-phase", childStepIds: ["ps-impl", "ps-followup"] }],
        },
      }, 2, "ps-impl"),
      eventEntry(loopId, 1, {
        eventType: "plan_approval",
        payload: { approval_id: "pa-2", plan_version: 2, decision: "approved", reason: "reviewed", decided_at: "2026-01-01T00:00:00.000Z" },
      }, 2, "ps-impl"),
      eventEntry(loopId, 2, {
        eventType: "step_result",
        payload: {
          step_id: "ps-impl", step_status: "completed", round_id: "round-2", attempt: 1,
          evidence: envelope("passed"), summary: "verified",
        },
      }, 2, "ps-impl"),
    ];
    const graph = buildGovernanceGraph(loopId, entries);
    const graphAgain = buildGovernanceGraph(loopId, entries);
    assert.equal(graph.effectivePlanVersion, 2);
    assert.ok(graph.edges.some((edge) => edge.kind === "refines" && edge.from === "ps-impl" && edge.to === "ps-phase"));
    assert.ok(graph.edges.some((edge) => edge.kind === "approved_by" && edge.to === "pa-2"));
    assert.ok(graph.edges.some((edge) => edge.kind === "supports" && edge.to === stableClaimId("ac", "behavior works")));
    assert.ok(graph.diagnostics.some((diagnostic) => diagnostic.code === "blocked_descendants") === false);
    assert.deepEqual(graph, graphAgain);
  });

  it("never turns failed evidence into support and reports unverified completion", () => {
    const loopId = "contradiction-loop";
    const plan = executablePlan();
    const entries: VaultEntry[] = [
      eventEntry(loopId, 0, {
        eventType: "plan_submitted",
        payload: {
          base_version: null, reason: "initial", change_summary: "plan", evidence_references: [], validation_warnings: [],
          plan, effective_round: 0, refinement_links: [],
        },
      }, 1, "ps-impl"),
      eventEntry(loopId, 1, {
        eventType: "step_result",
        payload: { step_id: "ps-impl", step_status: "completed", round_id: "round-1", attempt: 1, evidence: envelope("failed") },
      }, 1, "ps-impl"),
    ];
    const graph = buildGovernanceGraph(loopId, entries);
    assert.equal(graph.edges.some((edge) => edge.kind === "supports"), false);
    assert.ok(graph.edges.some((edge) => edge.kind === "contradicts"));
    assert.ok(graph.diagnostics.some((diagnostic) => diagnostic.code === "unverified_completion_edge"));
  });

  it("reports malformed events and blocked descendants without guessing", () => {
    const loopId = "diagnostic-loop";
    const plan = executablePlan("blocked");
    const malformed: VaultEntry = {
      task_id: "bad-event", task_type: "workflow_step_result", loop_id: loopId,
      loop_lineage: { event_schema_version: 1, event_id: "bad", event_type: "step_result", round: 1, phase: "executing", plan_version: 1, active_step_id: "ps-impl", payload: { step_id: 42 } },
    };
    const valid = eventEntry(loopId, 0, {
      eventType: "plan_submitted",
      payload: { base_version: null, reason: "initial", change_summary: "plan", evidence_references: [], validation_warnings: [], plan, effective_round: 0, refinement_links: [] },
    }, 1, "ps-impl");
    const graph = buildGovernanceGraph(loopId, [valid, malformed]);
    assert.ok(graph.diagnostics.some((diagnostic) => diagnostic.code === "malformed_event"));
    assert.ok(graph.diagnostics.some((diagnostic) => diagnostic.code === "blocked_descendants"));
    const throughZero = buildGovernanceGraph(loopId, [valid, malformed], { throughRound: 0 });
    assert.equal(throughZero.diagnostics.some((diagnostic) => diagnostic.code === "malformed_event"), false);
  });

  it("uses the restored plan version after backtrack", () => {
    const loopId = "backtrack-graph";
    const v1 = executablePlan();
    const v2 = structuredClone(v1);
    v2.steps[1] = { ...v2.steps[1], title: "Revised implementation" };
    const entries: VaultEntry[] = [
      eventEntry(loopId, 0, {
        eventType: "plan_submitted",
        payload: { base_version: null, reason: "initial", change_summary: "v1", evidence_references: [], validation_warnings: [], plan: v1, effective_round: 0, refinement_links: [] },
      }, 1, "ps-impl"),
      eventEntry(loopId, 1, {
        eventType: "plan_updated",
        payload: { base_version: 1, reason: "revise", change_summary: "v2", evidence_references: [], validation_warnings: [], plan: v2, effective_round: 1, refinement_links: [] },
      }, 2, "ps-impl"),
      eventEntry(loopId, 3, {
        eventType: "backtrack_restored",
        payload: { from_round: 3, to_round: 2, execution_epoch: 1, trigger_rule: "R4" },
      }, 1, "ps-impl"),
    ];
    const graph = buildGovernanceGraph(loopId, entries);
    assert.equal(graph.effectivePlanVersion, 1);
  });
});
