import { createHash } from "node:crypto";
import type { VaultEntry } from "./backends/interface.js";
import { stableStringify } from "./canonical-state.js";
import type {
  EvaluationStepStatus,
  PlanApprovalRecord,
  PlanChangeRequest,
  PlanRevisionRecord,
  PlanChangeAssessment,
  RoundDiscoveries,
  RoundEvidenceEnvelope,
  StructuredPlan,
  WorkflowPhase,
} from "./protocol.js";
import { isRecord } from "./token-utils.js";

export const WORKFLOW_EVENT_SCHEMA_VERSION = 1 as const;

export type WorkflowEventType =
  | "planning_started"
  | "plan_submitted"
  | "plan_updated"
  | "plan_approval"
  | "plan_change_requested"
  | "work_discovered"
  | "step_result"
  | "external_gate_resolved"
  | "round_rejected"
  | "backtrack_restored";

export interface WorkflowEventPayloads {
  planning_started: { plan_source: string | null };
  plan_submitted: PlanRevisionPayload;
  plan_updated: PlanRevisionPayload;
  plan_approval: {
    approval_id: string;
    plan_version: number;
    decision: PlanApprovalRecord["decision"];
    reason: string;
    decided_at: string;
  };
  plan_change_requested: { step_id: string; request: PlanChangeRequest };
  work_discovered: { step_id: string; discoveries: RoundDiscoveries };
  step_result: {
    step_id: string;
    step_status: EvaluationStepStatus;
    round_id: string | null;
    attempt: number;
    evidence?: RoundEvidenceEnvelope;
    evidence_requirements?: string[];
    summary?: string;
    reason?: string;
  };
  external_gate_resolved: {
    plan_version: number;
    step_id: string;
    summary: string;
    evidence_references: string[];
  };
  round_rejected: {
    step_id: string | null;
    round_id: string;
    attempt: number;
    reason: string;
  };
  backtrack_restored: {
    from_round: number;
    to_round: number;
    execution_epoch: number;
    trigger_rule: string;
  };
}

export interface PlanRevisionPayload {
  base_version: number | null;
  reason: string;
  change_summary: string;
  evidence_references: string[];
  validation_warnings: string[];
  plan: StructuredPlan;
  effective_round: number;
  refinement_links: PlanRevisionRecord["refinementLinks"];
  change_impact?: PlanChangeAssessment["impact"];
  changed_paths?: string[];
}

export type WorkflowEventInput = {
  [K in WorkflowEventType]: { eventType: K; payload: WorkflowEventPayloads[K] }
}[WorkflowEventType];

export type WorkflowEvent = {
  [K in WorkflowEventType]: {
    eventSchemaVersion: typeof WORKFLOW_EVENT_SCHEMA_VERSION;
    eventId: string;
    eventType: K;
    loopId: string;
    round: number;
    phase: WorkflowPhase;
    planVersion: number | null;
    activeStepId: string | null;
    payload: WorkflowEventPayloads[K];
  }
}[WorkflowEventType];

function validPayload(type: WorkflowEventType, payload: Record<string, unknown>): boolean {
  const string = (key: string) => typeof payload[key] === "string";
  const number = (key: string) => typeof payload[key] === "number";
  const stringArray = (key: string) => Array.isArray(payload[key]) && payload[key].every((item) => typeof item === "string");
  const optionalString = (key: string) => payload[key] === undefined || typeof payload[key] === "string";
  const validPlan = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.objective !== "string" ||
        !Array.isArray(value.successCriteria) || !value.successCriteria.every((item) => typeof item === "string") ||
        !Array.isArray(value.constraints) || !value.constraints.every((item) => typeof item === "string") ||
        !Array.isArray(value.steps)) return false;
    return value.steps.every((step) => isRecord(step) && typeof step.id === "string" &&
      typeof step.title === "string" && ["executable", "outline", "external_gate"].includes(String(step.kind)) &&
      Array.isArray(step.dependsOn) && step.dependsOn.every((item) => typeof item === "string") &&
      Array.isArray(step.scope) && step.scope.every((item) => typeof item === "string") &&
      Array.isArray(step.successCriteria) && step.successCriteria.every((item) => typeof item === "string") &&
      Array.isArray(step.constraints) && step.constraints.every((item) => typeof item === "string") &&
      Array.isArray(step.acceptanceCriteria) && step.acceptanceCriteria.every((item) => typeof item === "string") &&
      Array.isArray(step.evidenceRequirements) && step.evidenceRequirements.every((item) => typeof item === "string") &&
      ["outline", "executable"].includes(String(step.refinement)) &&
      Array.isArray(step.riskTags) && step.riskTags.every((item) => typeof item === "string") &&
      ["pending", "ready", "active", "done", "blocked", "canceled"].includes(String(step.status)) &&
      (step.refinesStepId === undefined || typeof step.refinesStepId === "string"));
  };
  const validRefinementLinks = (value: unknown): boolean => Array.isArray(value) && value.every((link) =>
    isRecord(link) && typeof link.sourceStepId === "string" && Array.isArray(link.childStepIds) &&
    link.childStepIds.every((item) => typeof item === "string"));
  const validDiscoveries = (value: unknown): boolean => isRecord(value) &&
    ["wrongAssumptions", "emergedWork", "facts", "newConstraints"].every((key) =>
      value[key] === undefined || (Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")));
  const validEvidence = (value: unknown): boolean => {
    if (!isRecord(value) || !isRecord(value.files) || !isRecord(value.checks) ||
        !Array.isArray(value.files.value) || !value.files.value.every((item) => typeof item === "string") ||
        !Array.isArray(value.checks.value) || !Array.isArray(value.claims) ||
        !Array.isArray(value.providerNames) || !value.providerNames.every((item) => typeof item === "string") ||
        !Array.isArray(value.contradictions) || !value.contradictions.every((item) => typeof item === "string")) return false;
    return value.claims.every((claim) => isRecord(claim) && typeof claim.targetId === "string" &&
      Array.isArray(claim.evidenceRefs) && claim.evidenceRefs.every((item) => typeof item === "string"));
  };
  switch (type) {
    case "planning_started": return payload.plan_source === null || string("plan_source");
    case "plan_submitted":
    case "plan_updated":
      return (payload.base_version === null || number("base_version")) && string("reason") &&
        string("change_summary") && stringArray("evidence_references") &&
        stringArray("validation_warnings") && validPlan(payload.plan) &&
        number("effective_round") && validRefinementLinks(payload.refinement_links) &&
        (payload.change_impact === undefined || ["none", "tactical", "contract", "risk"].includes(String(payload.change_impact))) &&
        (payload.changed_paths === undefined || stringArray("changed_paths"));
    case "plan_approval":
      return string("approval_id") && number("plan_version") &&
        ["approved", "rejected"].includes(String(payload.decision)) &&
        string("reason") && string("decided_at");
    case "plan_change_requested": return string("step_id") && isRecord(payload.request) &&
      ["before_continue", "next_boundary"].includes(String(payload.request.timing)) &&
      typeof payload.request.reason === "string" && Array.isArray(payload.request.affectedIds) &&
      payload.request.affectedIds.every((item) => typeof item === "string");
    case "work_discovered": return string("step_id") && validDiscoveries(payload.discoveries);
    case "step_result":
      return string("step_id") && ["completed", "blocked", "in_progress"].includes(String(payload.step_status)) &&
        (payload.round_id === null || string("round_id")) && number("attempt") &&
        (payload.evidence === undefined || validEvidence(payload.evidence)) &&
        (payload.evidence_requirements === undefined || stringArray("evidence_requirements")) &&
        optionalString("summary") && optionalString("reason");
    case "external_gate_resolved":
      return number("plan_version") && string("step_id") && string("summary") &&
        stringArray("evidence_references");
    case "round_rejected":
      return (payload.step_id === null || string("step_id")) && string("round_id") &&
        number("attempt") && string("reason");
    case "backtrack_restored":
      return number("from_round") && number("to_round") && number("execution_epoch") && string("trigger_rule");
  }
}

function eventDiscriminator(input: WorkflowEventInput): unknown {
  switch (input.eventType) {
    case "planning_started": return { planSource: input.payload.plan_source };
    case "plan_submitted":
    case "plan_updated": return {
      baseVersion: input.payload.base_version,
      effectiveRound: input.payload.effective_round,
      plan: input.payload.plan,
    };
    case "plan_approval": return {
      approvalId: input.payload.approval_id,
      planVersion: input.payload.plan_version,
      decision: input.payload.decision,
    };
    case "plan_change_requested": return { stepId: input.payload.step_id, request: input.payload.request };
    case "work_discovered": return { stepId: input.payload.step_id, discoveries: input.payload.discoveries };
    case "step_result": return {
      stepId: input.payload.step_id,
      roundId: input.payload.round_id,
      attempt: input.payload.attempt,
      status: input.payload.step_status,
    };
    case "external_gate_resolved": return { planVersion: input.payload.plan_version, stepId: input.payload.step_id };
    case "round_rejected": return { roundId: input.payload.round_id, attempt: input.payload.attempt };
    case "backtrack_restored": return {
      fromRound: input.payload.from_round,
      toRound: input.payload.to_round,
      executionEpoch: input.payload.execution_epoch,
    };
  }
}

export function createWorkflowEvent(
  loopId: string,
  round: number,
  phase: WorkflowPhase,
  planVersion: number | null,
  activeStepId: string | null,
  input: WorkflowEventInput,
): WorkflowEvent {
  const identity = stableStringify({
    loopId, round, phase, planVersion, activeStepId,
    eventType: input.eventType,
    discriminator: eventDiscriminator(input),
  });
  const eventId = `we-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
  return {
    eventSchemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
    eventId,
    eventType: input.eventType,
    loopId,
    round,
    phase,
    planVersion,
    activeStepId,
    payload: input.payload,
  } as WorkflowEvent;
}

export function workflowEventEntry(event: WorkflowEvent, task: string): VaultEntry {
  return {
    task_id: `loop:${event.loopId}:r${event.round}:workflow:${event.eventType}:${event.eventId}`,
    task_type: `workflow_${event.eventType}`,
    timestamp: new Date().toISOString(),
    loop_id: event.loopId,
    task,
    loop_lineage: {
      event_schema_version: event.eventSchemaVersion,
      event_id: event.eventId,
      event_type: event.eventType,
      round: event.round,
      phase: event.phase,
      plan_version: event.planVersion,
      active_step_id: event.activeStepId,
      payload: event.payload,
    },
  };
}

export function parseWorkflowEventEntry(entry: VaultEntry): WorkflowEvent | null {
  const data = entry.loop_lineage;
  if (!isRecord(data) || data.event_schema_version !== WORKFLOW_EVENT_SCHEMA_VERSION ||
      typeof data.event_id !== "string" || typeof data.event_type !== "string" ||
      typeof entry.loop_id !== "string" || !Number.isInteger(data.round) ||
      !["planning", "awaiting_approval", "executing", "auditing", "terminal"].includes(String(data.phase)) ||
      !(data.plan_version === null || typeof data.plan_version === "number") ||
      !(data.active_step_id === null || typeof data.active_step_id === "string") ||
      !isRecord(data.payload)) return null;
  const eventType = data.event_type as WorkflowEventType;
  if (!["planning_started", "plan_submitted", "plan_updated", "plan_approval", "plan_change_requested",
    "work_discovered", "step_result", "external_gate_resolved", "round_rejected", "backtrack_restored"].includes(eventType) ||
      !validPayload(eventType, data.payload)) return null;
  return {
    eventSchemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
    eventId: data.event_id,
    eventType,
    loopId: entry.loop_id,
    round: data.round as number,
    phase: data.phase as WorkflowPhase,
    planVersion: data.plan_version as number | null,
    activeStepId: data.active_step_id as string | null,
    payload: data.payload,
  } as WorkflowEvent;
}
