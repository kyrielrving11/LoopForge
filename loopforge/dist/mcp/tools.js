/** LoopForge MCP — Tool definitions and handlers.
 *
 * 12 tools: planning, execution, control, and audit surfaces.
 * Each handler receives SessionManager + parsed input, returns the output object.
 */
import { parseRoundReport } from "../round-report.js";
import { getPolicyMetrics } from "../policy-metrics.js";
import { isRecord } from "../token-utils.js";
import { computeWorkflowProgress } from "../plan.js";
import { summarizeGovernanceGraph } from "../governance-graph.js";
// ═══════════════════════════════════════════════════════════════════════════
// Tool schemas (MCP JSON Schema format)
// ═══════════════════════════════════════════════════════════════════════════
const PLAN_STEP_SCHEMA = {
    type: "object",
    properties: {
        id: { type: "string", description: "Stable ps-* plan step ID." },
        title: { type: "string" },
        kind: { type: "string", enum: ["executable", "outline", "external_gate"] },
        dependsOn: { type: "array", items: { type: "string" } },
        scope: { type: "array", items: { type: "string" } },
        successCriteria: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        evidenceRequirements: { type: "array", items: { type: "string" } },
        refinement: { type: "string", enum: ["outline", "executable"] },
        riskTags: {
            type: "array",
            items: { type: "string", enum: ["destructive_workspace", "data_migration", "production_change", "credentials_or_permissions", "external_side_effect", "public_api_break"] },
        },
        status: { type: "string", enum: ["pending", "ready", "active", "done", "blocked", "canceled"] },
        refinesStepId: {
            type: "string",
            description: "Previous-version outline step expanded by this new step. Valid only in plan updates.",
        },
    },
    required: ["id", "title", "kind", "dependsOn", "scope", "successCriteria", "constraints", "acceptanceCriteria", "evidenceRequirements", "refinement", "riskTags", "status"],
};
const PLAN_SCHEMA = {
    type: "object",
    properties: {
        objective: { type: "string" },
        successCriteria: { type: "array", items: { type: "string" } },
        constraints: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: PLAN_STEP_SCHEMA },
    },
    required: ["objective", "successCriteria", "constraints", "steps"],
};
const TOOL_BASE_SCHEMAS = [
    {
        name: "loopforge_start",
        description: "Start a loop. Without a plan, returns a planning prompt; with a valid plan, prepares execution.",
        inputSchema: {
            type: "object",
            properties: {
                task: {
                    type: "string",
                    description: "The task to accomplish across the loop. Be specific and actionable.",
                },
                loopId: {
                    type: "string",
                    description: "Optional loop ID. Generated automatically if not provided.",
                },
                maxRounds: {
                    type: "number",
                    description: "Maximum rounds before auto-stop. Default: 20 from policy.",
                },
                domain: {
                    type: "string",
                    description: "Domain hint (e.g. 'solidity', 'react', 'rust') for state context.",
                },
                planSource: {
                    type: "string",
                    description: "Plan reference for constraint extraction (e.g. 'docs/plan.md').",
                },
                constraints: {
                    type: "array",
                    items: { type: "string" },
                    description: "Hard constraints to enforce across all rounds.",
                },
                plan: {
                    ...PLAN_SCHEMA,
                    description: "Optional complete structured plan. When omitted, start returns a planning prompt and consumes no engineering round.",
                },
                workspaceRoot: { type: "string", description: "Target workspace directory. Required on an unbound MCP process." },
                storeDir: { type: "string", description: "Optional LoopForge store directory; relative paths resolve inside workspaceRoot." },
                approvalPolicy: {
                    type: "string",
                    enum: ["risk_only", "every_revision"],
                    description: "Approval mode: risk_only (default) or every_revision.",
                },
                planningProfile: {
                    type: "string",
                    enum: ["minimal", "full"],
                    description: "Planning density: minimal (default) or full.",
                },
            },
            required: ["task"],
        },
    },
    {
        name: "loopforge_plan_submit",
        description: "Submit the initial structured plan produced during planning. Approval follows the session policy; fixed high-risk plans always pause.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: { type: "string" },
                plan: PLAN_SCHEMA,
                reason: { type: "string" },
                changeSummary: { type: "string" },
                evidenceReferences: { type: "array", items: { type: "string" } },
            },
            required: ["sessionId", "plan"],
        },
    },
    {
        name: "loopforge_plan_update",
        description: "Submit a full replacement plan against an exact baseVersion. Completed steps are immutable and stale versions are rejected.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: { type: "string" },
                baseVersion: { type: "integer", minimum: 1 },
                plan: PLAN_SCHEMA,
                reason: { type: "string" },
                changeSummary: { type: "string" },
                evidenceReferences: { type: "array", items: { type: "string" } },
            },
            required: ["sessionId", "baseVersion", "plan", "reason", "changeSummary", "evidenceReferences"],
        },
    },
    {
        name: "loopforge_plan_approve",
        description: "Approve or reject the exact plan version identified by the server approvalId when policy requires review.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: { type: "string" },
                approvalId: { type: "string" },
                planVersion: { type: "integer", minimum: 1 },
                decision: { type: "string", enum: ["approved", "rejected"] },
                reason: { type: "string" },
            },
            required: ["sessionId", "approvalId", "planVersion", "decision", "reason"],
        },
    },
    {
        name: "loopforge_next",
        description: "Submit the exact roundId and compact v3 report for the active execution or audit round.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: { type: "string" },
                roundId: { type: "string" },
                report: {
                    type: "object",
                    required: ["status", "summary"],
                    properties: {
                        status: { type: "string", enum: ["completed", "in_progress", "blocked"] },
                        summary: { type: "string" },
                        violations: { type: "array", items: { type: "string" } },
                        evidence: {
                            type: "object",
                            properties: {
                                files: { type: "array", items: { type: "string" } },
                                checks: { type: "array", items: {
                                        type: "object", required: ["name", "status"], properties: {
                                            name: { type: "string" },
                                            status: { type: "string", enum: ["passed", "failed", "not_run"] },
                                            summary: { type: "string" },
                                            counts: { type: "object", required: ["passed", "failed", "skipped"], properties: {
                                                    passed: { type: "integer", minimum: 0 },
                                                    failed: { type: "integer", minimum: 0 },
                                                    skipped: { type: "integer", minimum: 0 },
                                                } },
                                        },
                                    } },
                                claims: { type: "array", items: {
                                        type: "object", required: ["targetId", "evidenceRefs"], properties: {
                                            targetId: { type: "string" },
                                            evidenceRefs: { type: "array", items: { type: "string" } },
                                        },
                                    } },
                                noChangeReason: { type: "string" },
                            },
                        },
                        blocker: { type: "object", required: ["kind", "reason"], properties: {
                                kind: { type: "string", enum: ["dependency", "external", "needs_human_input", "plan_change"] },
                                reason: { type: "string" },
                                references: { type: "array", items: { type: "string" } },
                            } },
                        discoveries: { type: "object", properties: {
                                wrongAssumptions: { type: "array", items: { type: "string" } },
                                emergedWork: { type: "array", items: { type: "string" } },
                                facts: { type: "array", items: { type: "string" } },
                                newConstraints: { type: "array", items: { type: "string" } },
                            } },
                        planChangeRequest: { type: "object", required: ["timing", "reason", "affectedIds"], properties: {
                                timing: { type: "string", enum: ["before_continue", "next_boundary"] },
                                reason: { type: "string" },
                                affectedIds: { type: "array", items: { type: "string" } },
                            } },
                        delegations: { type: "array", items: {
                                type: "object",
                                required: ["agentId", "subTask", "resultSummary", "success"],
                                properties: {
                                    agentId: { type: "string" }, subAgentType: { type: "string" },
                                    subTask: { type: "string" }, resultSummary: { type: "string" },
                                    success: { type: "boolean" },
                                    discoveredConstraints: { type: "array", items: { type: "string" } },
                                },
                            } },
                        contextRequest: { type: "object", properties: {
                                emphasize: { type: "array", items: { type: "string" } },
                                confusion_points: { type: "array", items: { type: "string" } },
                            } },
                    },
                },
            },
            required: ["sessionId", "roundId", "report"],
        },
    },
    {
        name: "loopforge_status",
        description: "Get the current status of a loop session, including round identity and success trajectory.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID returned by loopforge_start.",
                },
                loopId: {
                    type: "string",
                    description: "Alternative persisted loop ID. Provide exactly one of sessionId or loopId.",
                },
            },
            required: [],
        },
    },
    {
        name: "loopforge_stop",
        description: "Manually stop a loop session and return its final trajectory.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID to stop.",
                },
            },
            required: ["sessionId"],
        },
    },
    {
        name: "loopforge_pause",
        description: "Pause a running session at its round boundary.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID to pause.",
                },
            },
            required: ["sessionId"],
        },
    },
    {
        name: "loopforge_list",
        description: "List all active loop sessions managed by this MCP server.",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
    },
    {
        name: "loopforge_replay",
        description: "Replay a completed or running loop session as an auditable round timeline.",
        inputSchema: {
            type: "object",
            properties: {
                sessionId: {
                    type: "string",
                    description: "Session ID to replay.",
                },
            },
            required: ["sessionId"],
        },
    },
    {
        name: "loopforge_resume",
        description: "Resume an interrupted, paused, or externally gated loop from typed state.",
        inputSchema: {
            type: "object",
            properties: {
                loopId: {
                    type: "string",
                    description: "Loop ID to resume. Must have a saved session_state entry from a previous start/run.",
                },
                workspaceRoot: { type: "string", description: "Target workspace directory. Required on an unbound MCP process." },
                storeDir: { type: "string", description: "Optional LoopForge store directory; relative paths resolve inside workspaceRoot." },
                gateResolution: {
                    type: "object",
                    properties: {
                        planVersion: { type: "integer", minimum: 1 },
                        stepId: { type: "string" },
                        summary: { type: "string" },
                        evidenceReferences: { type: "array", minItems: 1, items: { type: "string" } },
                    },
                    required: ["planVersion", "stepId", "summary", "evidenceReferences"],
                    description: "Resolve exactly one terminal external gate with auditable evidence.",
                },
            },
            required: ["loopId"],
        },
    },
    {
        name: "loopforge_health",
        description: "Check the health of a loop: goal alignment, constraint integrity, drift detection, strategy stability, and task continuity. Works for both active in-memory sessions and vault-persisted loops.",
        inputSchema: {
            type: "object",
            properties: {
                loopId: {
                    type: "string",
                    description: "Loop ID to check health for.",
                },
            },
            required: ["loopId"],
        },
    },
];
const ADVANCE_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        error: { type: "string" },
        sessionId: { type: "string" },
        round: { type: "number" },
        roundId: { type: ["string", "null"] },
        prompt: { type: ["string", "null"] },
        stopReason: { type: "string" },
        stopDetail: { type: "string" },
        level: { type: "string" },
        roundSuccess: { type: "boolean" },
        enforcementAction: { enum: ["accept", "reject", "terminate", "backtrack"] },
        enforcementReason: { type: "string" },
        warnings: { type: "array", items: { type: "string" } },
        phase: { enum: ["planning", "awaiting_approval", "executing", "auditing", "terminal"] },
        requiredAction: { enum: ["submit_plan", "approve_plan", "execute_prompt", "resubmit_round", "restore_workspace", "refine_plan", "execute_audit", "none"] },
        terminal: { type: "boolean" },
        planVersion: { type: ["number", "null"] },
        activeStepId: { type: ["string", "null"] },
        approvalId: { type: ["string", "null"] },
        runtime: { type: ["object", "null"], additionalProperties: true },
        capabilityPreflight: { type: "object", additionalProperties: true },
    },
    additionalProperties: true,
};
const TOOL_OUTPUT_SCHEMAS = {
    loopforge_start: ADVANCE_OUTPUT_SCHEMA,
    loopforge_plan_submit: ADVANCE_OUTPUT_SCHEMA,
    loopforge_plan_update: ADVANCE_OUTPUT_SCHEMA,
    loopforge_plan_approve: ADVANCE_OUTPUT_SCHEMA,
    loopforge_next: ADVANCE_OUTPUT_SCHEMA,
    loopforge_resume: ADVANCE_OUTPUT_SCHEMA,
    loopforge_status: {
        type: "object",
        properties: {
            error: { type: "string" },
            sessionId: { type: "string" },
            loopId: { type: "string" },
            round: { type: "number" },
            roundId: { type: ["string", "null"] },
            maxRounds: { type: "number" },
            status: { enum: ["running", "stopped", "stalled", "paused"] },
            phase: { enum: ["planning", "awaiting_approval", "executing", "auditing", "terminal"] },
            planVersion: { type: ["number", "null"] },
            activeStepId: { type: ["string", "null"] },
            approvalId: { type: ["string", "null"] },
            approvalPolicy: { enum: ["risk_only", "every_revision"] },
            planCounts: { type: "object", additionalProperties: true },
            approvalHistory: { type: "array", items: { type: "object", additionalProperties: true } },
            successTrajectory: { type: "array", items: { type: "boolean" } },
            lease: { type: ["object", "null"], additionalProperties: true },
            metrics: { type: "object", additionalProperties: true },
            runtime: { type: ["object", "null"], additionalProperties: true },
            graphSummary: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
    },
    loopforge_stop: {
        type: "object",
        properties: {
            error: { type: "string" },
            success: { type: "boolean" },
            roundsCompleted: { type: "number" },
            successTrajectory: { type: "array", items: { type: "boolean" } },
        },
        additionalProperties: true,
    },
    loopforge_pause: {
        type: "object",
        properties: {
            error: { type: "string" },
            sessionId: { type: "string" },
            round: { type: "number" },
            status: { type: "string" },
        },
        additionalProperties: true,
    },
    loopforge_list: {
        type: "object",
        properties: {
            sessions: { type: "array", items: { type: "object", additionalProperties: true } },
            runtime: { type: ["object", "null"], additionalProperties: true },
            hint: { type: "string" },
        },
        required: ["sessions"],
        additionalProperties: false,
    },
    loopforge_replay: {
        type: "object",
        properties: {
            error: { type: "string" },
            sessionId: { type: "string" },
            loopId: { type: "string" },
            timeline: { type: "array", items: { type: "object", additionalProperties: true } },
            phase: { type: "string" },
            planVersion: { type: ["number", "null"] },
            activeStepId: { type: ["string", "null"] },
            approvalId: { type: ["string", "null"] },
            approvalHistory: { type: "array", items: { type: "object", additionalProperties: true } },
            graph: { type: "object", additionalProperties: true },
            graphSummary: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
    },
    loopforge_health: {
        type: "object",
        properties: {
            error: { type: "string" },
            loopId: { type: "string" },
            workflow_alignment: { type: "object", additionalProperties: true },
            constraint_integrity: { type: "object", additionalProperties: true },
            evidence_integrity: { type: "object", additionalProperties: true },
            stall_risk: { type: "object", additionalProperties: true },
            readiness: { type: "string" },
            progress: { type: "object", additionalProperties: true },
            graphSummary: { type: "object", additionalProperties: true },
            graphDiagnostics: { type: "array", items: { type: "object", additionalProperties: true } },
            policy_metrics: { type: "object", additionalProperties: true },
        },
        additionalProperties: true,
    },
};
function closeObjectSchemas(schema) {
    const result = { ...schema };
    if (result.type === "object") {
        result.additionalProperties = false;
        if (isRecord(result.properties)) {
            result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [
                key,
                isRecord(value) ? closeObjectSchemas(value) : value,
            ]));
        }
    }
    if (result.type === "array" && isRecord(result.items)) {
        result.items = closeObjectSchemas(result.items);
    }
    return result;
}
/** MCP tool contracts include strict input and structured output schemas. */
export const TOOL_SCHEMAS = TOOL_BASE_SCHEMAS.map((schema) => ({
    ...schema,
    annotations: {
        readOnlyHint: ["loopforge_status", "loopforge_list", "loopforge_replay", "loopforge_health"].includes(schema.name),
        destructiveHint: ["loopforge_stop", "loopforge_plan_approve"].includes(schema.name),
        idempotentHint: ["loopforge_status", "loopforge_list", "loopforge_replay", "loopforge_health"].includes(schema.name),
        openWorldHint: false,
    },
    inputSchema: closeObjectSchemas(schema.inputSchema),
    outputSchema: TOOL_OUTPUT_SCHEMAS[schema.name] ?? {
        type: "object",
        additionalProperties: true,
    },
}));
export class ToolInputValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ToolInputValidationError";
    }
}
function validateSchema(value, schema, path) {
    const type = schema.type;
    if (type === "object") {
        if (!isRecord(value)) {
            throw new ToolInputValidationError(`${path} must be an object`);
        }
        const properties = isRecord(schema.properties) ? schema.properties : {};
        const required = Array.isArray(schema.required)
            ? schema.required.filter((item) => typeof item === "string")
            : [];
        for (const key of required) {
            if (!(key in value)) {
                throw new ToolInputValidationError(`${path}.${key} is required`);
            }
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!(key in properties)) {
                    throw new ToolInputValidationError(`${path}.${key} is not allowed`);
                }
            }
        }
        for (const [key, child] of Object.entries(properties)) {
            if (key in value && isRecord(child)) {
                validateSchema(value[key], child, `${path}.${key}`);
            }
        }
        return;
    }
    if (type === "array") {
        if (!Array.isArray(value)) {
            throw new ToolInputValidationError(`${path} must be an array`);
        }
        if (isRecord(schema.items)) {
            value.forEach((item, index) => validateSchema(item, schema.items, `${path}[${index}]`));
        }
        return;
    }
    if (type === "string" && typeof value !== "string") {
        throw new ToolInputValidationError(`${path} must be a string`);
    }
    if (typeof value === "string" && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        throw new ToolInputValidationError(`${path} must be one of: ${schema.enum.join(", ")}`);
    }
    if (type === "boolean" && typeof value !== "boolean") {
        throw new ToolInputValidationError(`${path} must be a boolean`);
    }
    if (type === "number" || type === "integer") {
        if (typeof value !== "number" ||
            !Number.isFinite(value) ||
            (type === "integer" && !Number.isInteger(value))) {
            throw new ToolInputValidationError(`${path} must be ${type === "integer" ? "an integer" : "a number"}`);
        }
        if (typeof schema.minimum === "number" && value < schema.minimum) {
            throw new ToolInputValidationError(`${path} must be >= ${schema.minimum}`);
        }
        if (typeof schema.maximum === "number" && value > schema.maximum) {
            throw new ToolInputValidationError(`${path} must be <= ${schema.maximum}`);
        }
    }
}
export function validateToolInput(name, input) {
    const contract = TOOL_SCHEMAS.find((schema) => schema.name === name);
    if (!contract)
        throw new ToolInputValidationError(`Unknown tool: ${name}`);
    validateSchema(input, contract.inputSchema, "arguments");
}
export const TOOL_HANDLERS = {
    async loopforge_start(mgr, input) {
        const startInput = {
            task: String(input.task ?? ""),
            loopId: input.loopId,
            maxRounds: typeof input.maxRounds === "number" ? input.maxRounds : undefined,
            domain: input.domain,
            planSource: input.planSource,
            constraints: Array.isArray(input.constraints)
                ? input.constraints
                : undefined,
            plan: input.plan,
            workspaceRoot: input.workspaceRoot,
            storeDir: input.storeDir,
            approvalPolicy: input.approvalPolicy,
            planningProfile: input.planningProfile,
        };
        if (!startInput.task.trim()) {
            return { error: "task is required and must be non-empty" };
        }
        const result = await mgr.create(startInput);
        const presented = mgr.present(result);
        return { ...presented, capabilityPreflight: mgr.getCapabilityPreflight(presented.sessionId) };
    },
    async loopforge_plan_submit(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        const result = await mgr.submitPlan(sessionId, input.plan, typeof input.reason === "string" ? input.reason : "initial plan", typeof input.changeSummary === "string" ? input.changeSummary : "Initial structured plan", Array.isArray(input.evidenceReferences) ? input.evidenceReferences : []);
        return { ...mgr.present(result, sessionId) };
    },
    async loopforge_plan_update(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        const result = await mgr.updatePlan(sessionId, Number(input.baseVersion), input.plan, String(input.reason ?? ""), String(input.changeSummary ?? ""), input.evidenceReferences);
        return { ...mgr.present(result, sessionId) };
    },
    async loopforge_plan_approve(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        const result = await mgr.approvePlan(sessionId, String(input.approvalId ?? ""), Number(input.planVersion), input.decision, String(input.reason ?? ""));
        return { ...mgr.present(result, sessionId) };
    },
    async loopforge_next(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        const roundId = String(input.roundId ?? "");
        const report = parseRoundReport(input.report);
        if (!sessionId)
            return { error: "sessionId is required" };
        if (!roundId)
            return { error: "roundId is required" };
        if (!report)
            return { error: "report is required and must match the v3 RoundReportV1 contract" };
        const result = await mgr.advanceReport(sessionId, roundId, report);
        return { ...mgr.present(result, sessionId) };
    },
    async loopforge_status(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        const loopId = String(input.loopId ?? "");
        if ((sessionId && loopId) || (!sessionId && !loopId))
            return { error: "provide exactly one of sessionId or loopId" };
        const session = sessionId ? mgr.get(sessionId) : mgr.getByLoopId(loopId);
        if (!session) {
            const listed = mgr.list().find((item) => item.loopId === loopId);
            if (!listed)
                return { error: `session not found: ${sessionId || loopId}`, runtime: mgr.getRuntimeSummary() };
            return { ...listed, runtime: mgr.getRuntimeSummary() };
        }
        const metrics = session.engine.getMetrics();
        return {
            sessionId: session.sessionId,
            loopId: session.loopId,
            round: session.currentRound,
            roundId: session.roundSnapshot?.roundId ?? null,
            maxRounds: session.maxRounds,
            status: session.status,
            phase: session.workflow.phase,
            planVersion: session.workflow.planVersion,
            activeStepId: session.workflow.activeStepId,
            approvalId: session.workflow.approvalId,
            approvalPolicy: session.workflow.approvalPolicy,
            planningProfile: session.workflow.planningProfile,
            planCounts: session.workflow.plan ? {
                ready: session.workflow.plan.steps.filter((step) => step.status === "ready" || step.status === "active").length,
                blocked: session.workflow.plan.steps.filter((step) => step.status === "blocked").length,
                done: session.workflow.plan.steps.filter((step) => step.status === "done" || step.status === "canceled").length,
            } : { ready: 0, blocked: 0, done: 0 },
            progress: computeWorkflowProgress(session.workflow),
            approvalHistory: session.workflow.approvalHistory,
            successTrajectory: session.successTrajectory,
            lease: mgr.getLeaseStatus(session.loopId),
            metrics: {
                vaultWriteErrors: metrics.vaultWriteErrors,
                policy: getPolicyMetrics(session.loopId),
            },
            runtime: mgr.getRuntimeSummary(),
            graphSummary: (() => {
                const graph = mgr.governanceGraph(session.sessionId);
                return graph ? summarizeGovernanceGraph(graph) : undefined;
            })(),
            regressionSummary: mgr.getRegressionSummary(session.sessionId),
        };
    },
    async loopforge_stop(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        if (!sessionId)
            return { error: "sessionId is required" };
        const session = mgr.get(sessionId);
        if (!session)
            return { error: `session not found: ${sessionId}` };
        const roundsCompleted = session.currentRound;
        const successTrajectory = [...session.successTrajectory];
        mgr.delete(sessionId);
        return { success: true, roundsCompleted, successTrajectory };
    },
    async loopforge_pause(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        if (!sessionId)
            return { error: "sessionId is required" };
        const result = mgr.pause(sessionId);
        return { ...result };
    },
    async loopforge_list(mgr, _input) {
        const sessions = mgr.list();
        return {
            sessions,
            incompatibleSessions: mgr.listIncompatibleSessions(),
            runtime: mgr.getRuntimeSummary(),
            hint: sessions.length === 0 && mgr.getRuntimeSummary()?.bindingStatus === "unbound"
                ? "Call loopforge_start or loopforge_resume with workspaceRoot."
                : undefined,
        };
    },
    async loopforge_replay(mgr, input) {
        const sessionId = String(input.sessionId ?? "");
        if (!sessionId)
            return { error: "sessionId is required" };
        const session = mgr.get(sessionId);
        if (!session)
            return { error: `session not found: ${sessionId}` };
        const timeline = mgr.replayTimeline(sessionId) ?? [];
        const graph = mgr.governanceGraph(sessionId);
        return {
            sessionId,
            loopId: session.loopId,
            phase: session.workflow.phase,
            planVersion: session.workflow.planVersion,
            activeStepId: session.workflow.activeStepId,
            approvalId: session.workflow.approvalId,
            approvalHistory: session.workflow.approvalHistory,
            timeline,
            graph,
            graphSummary: graph ? summarizeGovernanceGraph(graph) : undefined,
            regressionSummary: mgr.getRegressionSummary(session.sessionId),
        };
    },
    async loopforge_resume(mgr, input) {
        const loopId = String(input.loopId ?? "");
        if (!loopId)
            return { error: "loopId is required" };
        const gateResolution = input.gateResolution;
        if (gateResolution) {
            const result = mgr.resumeWithWorkspace(loopId, input.workspaceRoot, input.storeDir, gateResolution);
            if (!result)
                return { error: `no saved session found for loop "${loopId}"` };
            const presented = mgr.present(result, result.sessionId);
            return { ...presented, capabilityPreflight: mgr.getCapabilityPreflight(presented.sessionId) };
        }
        // Paused recovery must run first so the persisted status is atomically
        // changed back to running before a prompt is returned.
        let result = mgr.runtime?.isBound ? await mgr.unpause(loopId) : null;
        if (!result)
            result = mgr.resumeWithWorkspace(loopId, input.workspaceRoot, input.storeDir);
        if (result?.stopReason === "paused")
            result = await mgr.unpause(loopId);
        if (!result)
            result = await mgr.unpause(loopId);
        if (!result)
            result = mgr.resume(loopId);
        if (!result)
            return { error: `no saved session found for loop "${loopId}"` };
        const presented = mgr.present(result, result.sessionId);
        return { ...presented, capabilityPreflight: mgr.getCapabilityPreflight(presented.sessionId) };
    },
    async loopforge_health(mgr, input) {
        const loopId = String(input.loopId ?? "");
        if (!loopId)
            return { error: "loopId is required" };
        const health = mgr.getHealth(loopId);
        if (!health)
            return { error: `no data found for loop "${loopId}"` };
        return health;
    },
};
//# sourceMappingURL=tools.js.map