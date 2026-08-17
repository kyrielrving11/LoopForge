import { createHash } from "node:crypto";
import { stableStringify } from "./canonical-state.js";
import { isRecord } from "./token-utils.js";
export const WORKFLOW_EVENT_SCHEMA_VERSION = 1;
function validPayload(type, payload) {
    const string = (key) => typeof payload[key] === "string";
    const number = (key) => typeof payload[key] === "number";
    const stringArray = (key) => Array.isArray(payload[key]) && payload[key].every((item) => typeof item === "string");
    const optionalString = (key) => payload[key] === undefined || typeof payload[key] === "string";
    const validPlan = (value) => {
        if (!isRecord(value) || typeof value.objective !== "string" ||
            !Array.isArray(value.successCriteria) || !value.successCriteria.every((item) => typeof item === "string") ||
            !Array.isArray(value.constraints) || !value.constraints.every((item) => typeof item === "string") ||
            !Array.isArray(value.steps))
            return false;
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
    const validRefinementLinks = (value) => Array.isArray(value) && value.every((link) => isRecord(link) && typeof link.sourceStepId === "string" && Array.isArray(link.childStepIds) &&
        link.childStepIds.every((item) => typeof item === "string"));
    const validDiscoveries = (value) => isRecord(value) &&
        ["wrongAssumptions", "emergedWork", "facts", "newConstraints"].every((key) => value[key] === undefined || (Array.isArray(value[key]) && value[key].every((item) => typeof item === "string")));
    const validEvidence = (value) => {
        if (!isRecord(value) || !isRecord(value.files) || !isRecord(value.checks) ||
            !Array.isArray(value.files.value) || !value.files.value.every((item) => typeof item === "string") ||
            !Array.isArray(value.checks.value) || !Array.isArray(value.claims) ||
            !Array.isArray(value.providerNames) || !value.providerNames.every((item) => typeof item === "string") ||
            !Array.isArray(value.contradictions) || !value.contradictions.every((item) => typeof item === "string"))
            return false;
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
function eventDiscriminator(input) {
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
export function createWorkflowEvent(loopId, round, phase, planVersion, activeStepId, input) {
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
    };
}
export function workflowEventEntry(event, task) {
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
export function parseWorkflowEventEntry(entry) {
    const data = entry.loop_lineage;
    if (!isRecord(data) || data.event_schema_version !== WORKFLOW_EVENT_SCHEMA_VERSION ||
        typeof data.event_id !== "string" || typeof data.event_type !== "string" ||
        typeof entry.loop_id !== "string" || !Number.isInteger(data.round) ||
        !["planning", "awaiting_approval", "executing", "auditing", "terminal"].includes(String(data.phase)) ||
        !(data.plan_version === null || typeof data.plan_version === "number") ||
        !(data.active_step_id === null || typeof data.active_step_id === "string") ||
        !isRecord(data.payload))
        return null;
    const eventType = data.event_type;
    if (!["planning_started", "plan_submitted", "plan_updated", "plan_approval", "plan_change_requested",
        "work_discovered", "step_result", "external_gate_resolved", "round_rejected", "backtrack_restored"].includes(eventType) ||
        !validPayload(eventType, data.payload))
        return null;
    return {
        eventSchemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
        eventId: data.event_id,
        eventType,
        loopId: entry.loop_id,
        round: data.round,
        phase: data.phase,
        planVersion: data.plan_version,
        activeStepId: data.active_step_id,
        payload: data.payload,
    };
}
//# sourceMappingURL=workflow-events.js.map