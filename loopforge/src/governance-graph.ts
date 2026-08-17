import { createHash } from "node:crypto";
import type { VaultEntry } from "./backends/interface.js";
import { stableStringify } from "./canonical-state.js";
import { stableClaimId, stepClaimTargets } from "./round-report.js";
import { deriveStableItemId } from "./token-utils.js";
import { parseWorkflowEventEntry, type WorkflowEvent } from "./workflow-events.js";
import type { GraphSliceSummary, NormalizedRoundEvaluation, RoundEvidenceEnvelope, RoundEvidenceClaim, WorkflowState } from "./protocol.js";
import { claimHasVerifiedEvidenceForEnvelope } from "./round-report.js";

export type GovernanceGraphNodeKind =
  | "objective" | "criterion" | "constraint" | "plan_version" | "step"
  | "round" | "attempt" | "claim" | "evidence" | "approval" | "outcome";

export type GovernanceGraphEdgeKind =
  | "defines" | "contains" | "depends_on" | "refines" | "covers"
  | "constrained_by" | "attempts" | "produced" | "supports" | "contradicts"
  | "approved_by" | "supersedes" | "restored_from";

export type GovernanceGraphDiagnosticCode =
  | "orphan_refinement" | "orphan_claim" | "blocked_descendants"
  | "plan_execution_divergence" | "unverified_completion_edge"
  | "approval_version_mismatch" | "malformed_event";

export interface GovernanceGraphNode {
  id: string;
  kind: GovernanceGraphNodeKind;
  label: string;
  status?: string;
  planVersion?: number | null;
  round?: number;
}

export interface GovernanceGraphEdge {
  id: string;
  kind: GovernanceGraphEdgeKind;
  from: string;
  to: string;
  planVersion?: number | null;
  round?: number;
}

export interface GovernanceGraphDiagnostic {
  code: GovernanceGraphDiagnosticCode;
  severity: "warn" | "error";
  detail: string;
  nodeId?: string;
}

export interface GovernanceGraphView {
  schemaVersion: 1;
  loopId: string;
  effectivePlanVersion: number | null;
  nodes: GovernanceGraphNode[];
  edges: GovernanceGraphEdge[];
  diagnostics: GovernanceGraphDiagnostic[];
}

export interface GovernanceGraphSummary {
  nodeCount: number;
  edgeCount: number;
  effectivePlanVersion: number | null;
  blockedDescendants: number;
  errorCount: number;
  warningCount: number;
}

function edgeId(kind: GovernanceGraphEdgeKind, from: string, to: string, version?: number | null, round?: number): string {
  return `ge-${createHash("sha256").update(stableStringify({ kind, from, to, version, round })).digest("hex").slice(0, 20)}`;
}

function evidenceId(reference: string): string {
  return `evidence-${deriveStableItemId(reference, 20)}`;
}

function evidenceRelation(
  envelope: RoundEvidenceEnvelope,
  claim: RoundEvidenceClaim,
  reference: string,
): "supports" | "contradicts" | null {
  if (reference.startsWith("file:")) {
    if (envelope.files.confidence === "verified" && envelope.files.value.includes(reference.slice(5))) return "supports";
    if (envelope.files.confidence === "contradicted") return "contradicts";
    return null;
  }
  if (reference.startsWith("check:")) {
    const name = reference.slice(6);
    const check = envelope.checks.value.find((item) => item.name === name);
    if (!check) return null;
    if (check.status === "failed" || envelope.checkProvenance?.[name]?.confidence === "contradicted") return "contradicts";
    if (check.status === "passed" && envelope.checkProvenance?.[name]?.confidence === "verified") return "supports";
    return null;
  }
  if (reference.startsWith("provider:")) {
    return (envelope.providerClaims?.[reference.slice(9)] ?? []).includes(claim.targetId) ? "supports" : null;
  }
  return null;
}

function descendants(stepId: string, dependencies: Map<string, string[]>): string[] {
  const found = new Set<string>();
  const visit = (id: string): void => {
    for (const [candidate, deps] of dependencies) {
      if (!deps.includes(id) || found.has(candidate)) continue;
      found.add(candidate);
      visit(candidate);
    }
  };
  visit(stepId);
  return [...found];
}

export function buildGovernanceGraph(
  loopId: string,
  entries: VaultEntry[],
  options: { throughRound?: number } = {},
): GovernanceGraphView {
  const nodes = new Map<string, GovernanceGraphNode>();
  const edges = new Map<string, GovernanceGraphEdge>();
  const diagnostics: GovernanceGraphDiagnostic[] = [];
  const workflowEntries = entries.filter((entry) => String(entry.task_type ?? "").startsWith("workflow_"));
  const events: WorkflowEvent[] = [];
  for (const entry of workflowEntries) {
    const storedRound = entry.loop_lineage?.round;
    if (options.throughRound !== undefined && typeof storedRound === "number" && storedRound > options.throughRound) continue;
    const event = parseWorkflowEventEntry(entry);
    if (!event) {
      diagnostics.push({ code: "malformed_event", severity: "error", detail: `Malformed workflow event: ${String(entry.task_id ?? "unknown")}` });
      continue;
    }
    if (options.throughRound !== undefined && event.round > options.throughRound) continue;
    events.push(event);
  }
  events.sort((left, right) => left.round - right.round || left.eventId.localeCompare(right.eventId));

  const plans = new Map<number, Extract<WorkflowEvent, { eventType: "plan_submitted" | "plan_updated" }>>();
  for (const event of events) {
    if ((event.eventType === "plan_submitted" || event.eventType === "plan_updated") && event.planVersion !== null) {
      plans.set(event.planVersion, event);
    }
  }
  const versions = [...plans.keys()].sort((a, b) => a - b);
  let effectivePlanVersion: number | null = null;
  for (const event of events) {
    if ((event.eventType === "plan_submitted" || event.eventType === "plan_updated") && event.planVersion !== null) {
      effectivePlanVersion = event.planVersion;
    } else if (event.eventType === "backtrack_restored" && event.planVersion !== null) {
      effectivePlanVersion = event.planVersion;
    }
  }

  for (const version of versions) {
    const event = plans.get(version)!;
    const plan = event.payload.plan;
    const objectiveId = `objective-${deriveStableItemId(plan.objective, 20)}`;
    const versionId = `plan-v${version}`;
    nodes.set(objectiveId, { id: objectiveId, kind: "objective", label: plan.objective, planVersion: version });
    nodes.set(versionId, { id: versionId, kind: "plan_version", label: `Plan v${version}`, planVersion: version });
    edges.set(edgeId("defines", objectiveId, versionId, version), { id: edgeId("defines", objectiveId, versionId, version), kind: "defines", from: objectiveId, to: versionId, planVersion: version });
    if (version > versions[0]) {
      const prior = versions.filter((candidate) => candidate < version).at(-1);
      if (prior !== undefined) edges.set(edgeId("supersedes", versionId, `plan-v${prior}`, version), { id: edgeId("supersedes", versionId, `plan-v${prior}`, version), kind: "supersedes", from: versionId, to: `plan-v${prior}`, planVersion: version });
    }
    for (const criterion of plan.successCriteria) {
      const id = stableClaimId("cr", criterion);
      nodes.set(id, { id, kind: "criterion", label: criterion, planVersion: version });
      edges.set(edgeId("defines", objectiveId, id, version), { id: edgeId("defines", objectiveId, id, version), kind: "defines", from: objectiveId, to: id, planVersion: version });
    }
    for (const constraint of plan.constraints) {
      const id = `constraint-${deriveStableItemId(constraint, 20)}`;
      nodes.set(id, { id, kind: "constraint", label: constraint, planVersion: version });
    }
    for (const step of plan.steps) {
      nodes.set(step.id, { id: step.id, kind: "step", label: step.title, status: step.status, planVersion: version });
      edges.set(edgeId("contains", versionId, step.id, version), { id: edgeId("contains", versionId, step.id, version), kind: "contains", from: versionId, to: step.id, planVersion: version });
      for (const dependency of step.dependsOn) {
        edges.set(edgeId("depends_on", step.id, dependency, version), { id: edgeId("depends_on", step.id, dependency, version), kind: "depends_on", from: step.id, to: dependency, planVersion: version });
      }
      if (step.refinesStepId) {
        const sourceKnown = [...plans.entries()].some(([priorVersion, priorEvent]) =>
          priorVersion < version && priorEvent.payload.plan.steps.some((candidate) => candidate.id === step.refinesStepId));
        if (!sourceKnown) diagnostics.push({ code: "orphan_refinement", severity: "error", detail: `${step.id} refines missing ${step.refinesStepId}`, nodeId: step.id });
        edges.set(edgeId("refines", step.id, step.refinesStepId, version), { id: edgeId("refines", step.id, step.refinesStepId, version), kind: "refines", from: step.id, to: step.refinesStepId, planVersion: version });
      }
      for (const criterion of step.successCriteria) {
        const id = stableClaimId("cr", criterion);
        edges.set(edgeId("covers", step.id, id, version), { id: edgeId("covers", step.id, id, version), kind: "covers", from: step.id, to: id, planVersion: version });
      }
      for (const target of stepClaimTargets(step)) {
        nodes.set(target.id, { id: target.id, kind: "claim", label: target.text, planVersion: version });
        edges.set(edgeId("covers", step.id, target.id, version), { id: edgeId("covers", step.id, target.id, version), kind: "covers", from: step.id, to: target.id, planVersion: version });
      }
      for (const constraint of step.constraints) {
        const id = `constraint-${deriveStableItemId(constraint, 20)}`;
        nodes.set(id, { id, kind: "constraint", label: constraint, planVersion: version });
        edges.set(edgeId("constrained_by", step.id, id, version), { id: edgeId("constrained_by", step.id, id, version), kind: "constrained_by", from: step.id, to: id, planVersion: version });
      }
    }
  }

  const effectivePlan = effectivePlanVersion === null ? null : plans.get(effectivePlanVersion)?.payload.plan ?? null;
  const dependencies = new Map(effectivePlan?.steps.map((step) => [step.id, step.dependsOn]) ?? []);
  for (const step of effectivePlan?.steps.filter((candidate) => candidate.status === "blocked") ?? []) {
    const blocked = descendants(step.id, dependencies).filter((id) => effectivePlan?.steps.find((candidate) => candidate.id === id)?.status !== "done");
    if (blocked.length) diagnostics.push({ code: "blocked_descendants", severity: "warn", detail: `${step.id} blocks ${blocked.length} descendant step(s)`, nodeId: step.id });
  }

  for (const event of events) {
    if (event.eventType === "plan_approval") {
      const approvalId = event.payload.approval_id;
      nodes.set(approvalId, { id: approvalId, kind: "approval", label: event.payload.decision, planVersion: event.payload.plan_version });
      const planId = `plan-v${event.payload.plan_version}`;
      if (!nodes.has(planId)) diagnostics.push({ code: "approval_version_mismatch", severity: "error", detail: `${approvalId} references missing plan v${event.payload.plan_version}`, nodeId: approvalId });
      edges.set(edgeId("approved_by", planId, approvalId, event.payload.plan_version), { id: edgeId("approved_by", planId, approvalId, event.payload.plan_version), kind: "approved_by", from: planId, to: approvalId, planVersion: event.payload.plan_version });
    }
    if (event.eventType === "step_result") {
      const roundId = event.payload.round_id ?? `round-${event.round}`;
      const attemptId = `${roundId}:attempt:${event.payload.attempt}`;
      nodes.set(roundId, { id: roundId, kind: "round", label: `Round ${event.round}`, round: event.round });
      nodes.set(attemptId, { id: attemptId, kind: "attempt", label: `Attempt ${event.payload.attempt}`, round: event.round });
      edges.set(edgeId("attempts", roundId, event.payload.step_id, event.planVersion, event.round), { id: edgeId("attempts", roundId, event.payload.step_id, event.planVersion, event.round), kind: "attempts", from: roundId, to: event.payload.step_id, planVersion: event.planVersion, round: event.round });
      const eventPlan = event.planVersion === null ? null : plans.get(event.planVersion)?.payload.plan ?? null;
      if (!eventPlan?.steps.some((step) => step.id === event.payload.step_id)) {
        diagnostics.push({ code: "plan_execution_divergence", severity: "error", detail: `Round ${event.round} executed ${event.payload.step_id} outside plan v${event.planVersion ?? "none"}`, nodeId: event.payload.step_id });
      }
      const envelope = event.payload.evidence;
      if (event.payload.step_status === "completed" && (!envelope || envelope.claims.length === 0)) {
        diagnostics.push({ code: "unverified_completion_edge", severity: "error", detail: `Completed step ${event.payload.step_id} has no claims`, nodeId: event.payload.step_id });
      }
      for (const claim of envelope?.claims ?? []) {
        if (!nodes.has(claim.targetId)) diagnostics.push({ code: "orphan_claim", severity: "error", detail: `Unknown claim ${claim.targetId}`, nodeId: claim.targetId });
        for (const reference of claim.evidenceRefs) {
          const id = evidenceId(reference);
          nodes.set(id, { id, kind: "evidence", label: reference, round: event.round });
          edges.set(edgeId("produced", attemptId, id, event.planVersion, event.round), { id: edgeId("produced", attemptId, id, event.planVersion, event.round), kind: "produced", from: attemptId, to: id, planVersion: event.planVersion, round: event.round });
          const kind = envelope ? evidenceRelation(envelope, claim, reference) : null;
          if (kind) {
            const relationId = edgeId(kind, id, claim.targetId, event.planVersion, event.round);
            edges.set(relationId, { id: relationId, kind, from: id, to: claim.targetId, planVersion: event.planVersion, round: event.round });
          }
        }
      if (event.payload.step_status === "completed" && (!envelope || !claimHasVerifiedEvidenceForEnvelope(envelope, claim))) {
          diagnostics.push({ code: "unverified_completion_edge", severity: "error", detail: `Completed claim ${claim.targetId} has no verified evidence`, nodeId: claim.targetId });
        }
      }
      const attemptEdge = edgeId("attempts", roundId, attemptId, event.planVersion, event.round);
      edges.set(attemptEdge, { id: attemptEdge, kind: "attempts", from: roundId, to: attemptId, planVersion: event.planVersion, round: event.round });
      const outcomeId = `outcome:${event.eventId}`;
      nodes.set(outcomeId, { id: outcomeId, kind: "outcome", label: event.payload.step_status, status: event.payload.step_status, round: event.round });
    }
    if (event.eventType === "backtrack_restored") {
      const from = `round-${event.payload.from_round}`;
      const to = `round-${event.payload.to_round}`;
      nodes.set(from, nodes.get(from) ?? { id: from, kind: "round", label: `Round ${event.payload.from_round}`, round: event.payload.from_round });
      nodes.set(to, nodes.get(to) ?? { id: to, kind: "round", label: `Round ${event.payload.to_round}`, round: event.payload.to_round });
      edges.set(edgeId("restored_from", from, to, event.planVersion, event.round), { id: edgeId("restored_from", from, to, event.planVersion, event.round), kind: "restored_from", from, to, planVersion: event.planVersion, round: event.round });
    }
  }

  return {
    schemaVersion: 1,
    loopId,
    effectivePlanVersion,
    nodes: [...nodes.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)),
    diagnostics: diagnostics.sort((left, right) => left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail)),
  };
}

export function summarizeGovernanceGraph(graph: GovernanceGraphView): GovernanceGraphSummary {
  const blockedDescendants = graph.diagnostics
    .filter((item) => item.code === "blocked_descendants")
    .reduce((total, item) => total + (Number(item.detail.match(/blocks (\d+)/)?.[1]) || 0), 0);
  return {
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    effectivePlanVersion: graph.effectivePlanVersion,
    blockedDescendants,
    errorCount: graph.diagnostics.filter((item) => item.severity === "error").length,
    warningCount: graph.diagnostics.filter((item) => item.severity === "warn").length,
  };
}

export function graphEntriesHash(entries: VaultEntry[]): string {
  return createHash("sha256").update(stableStringify(entries)).digest("hex");
}

export function buildGraphSlice(
  workflow: WorkflowState,
  previous?: NormalizedRoundEvaluation,
): GraphSliceSummary {
  const plan = workflow.plan;
  const active = plan?.steps.find((step) => step.id === workflow.activeStepId) ?? null;
  const targets = workflow.phase === "auditing" && plan
    ? plan.successCriteria.map((criterion) => stableClaimId("cr", criterion))
    : active ? stepClaimTargets(active).map((target) => target.id) : [];
  const covered = new Set(previous?.evidenceEnvelope.claims.map((claim) => claim.targetId) ?? []);
  const dependencySummaries = (active?.dependsOn ?? []).map((id) => {
    const dependency = plan?.steps.find((step) => step.id === id);
    return dependency ? `${dependency.id} [${dependency.status}]: ${dependency.title}` : `${id} [missing]`;
  });
  const dependencies = new Map(plan?.steps.map((step) => [step.id, step.dependsOn]) ?? []);
  const blockedDescendantCount = active
    ? descendants(active.id, dependencies).filter((id) =>
      !["done", "canceled"].includes(plan?.steps.find((step) => step.id === id)?.status ?? "pending")).length
    : 0;
  return {
    planVersion: workflow.planVersion,
    activeStepId: active?.id ?? null,
    parentOutlineId: active?.refinesStepId ?? null,
    dependencyStepIds: [...(active?.dependsOn ?? [])],
    dependencySummaries,
    relevantConstraintIds: [...new Set([
      ...workflow.baselineConstraints,
      ...(plan?.constraints ?? []),
      ...(active?.constraints ?? []),
    ])].map((item) => `constraint-${deriveStableItemId(item, 20)}`),
    requiredClaimIds: targets,
    uncoveredClaimIds: targets.filter((id) => !covered.has(id)),
    priorAttemptSummary: previous?.report.summary ?? null,
    blockedDescendantCount,
    regressionGapIds: [],
  };
}
