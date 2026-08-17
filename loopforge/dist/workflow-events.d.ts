import type { VaultEntry } from "./backends/interface.js";
import type { EvaluationStepStatus, PlanApprovalRecord, PlanChangeRequest, PlanRevisionRecord, PlanChangeAssessment, RoundDiscoveries, RoundEvidenceEnvelope, StructuredPlan, WorkflowPhase } from "./protocol.js";
export declare const WORKFLOW_EVENT_SCHEMA_VERSION: 1;
export type WorkflowEventType = "planning_started" | "plan_submitted" | "plan_updated" | "plan_approval" | "plan_change_requested" | "work_discovered" | "step_result" | "external_gate_resolved" | "round_rejected" | "backtrack_restored";
export interface WorkflowEventPayloads {
    planning_started: {
        plan_source: string | null;
    };
    plan_submitted: PlanRevisionPayload;
    plan_updated: PlanRevisionPayload;
    plan_approval: {
        approval_id: string;
        plan_version: number;
        decision: PlanApprovalRecord["decision"];
        reason: string;
        decided_at: string;
    };
    plan_change_requested: {
        step_id: string;
        request: PlanChangeRequest;
    };
    work_discovered: {
        step_id: string;
        discoveries: RoundDiscoveries;
    };
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
    [K in WorkflowEventType]: {
        eventType: K;
        payload: WorkflowEventPayloads[K];
    };
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
    };
}[WorkflowEventType];
export declare function createWorkflowEvent(loopId: string, round: number, phase: WorkflowPhase, planVersion: number | null, activeStepId: string | null, input: WorkflowEventInput): WorkflowEvent;
export declare function workflowEventEntry(event: WorkflowEvent, task: string): VaultEntry;
export declare function parseWorkflowEventEntry(entry: VaultEntry): WorkflowEvent | null;
//# sourceMappingURL=workflow-events.d.ts.map