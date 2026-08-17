/** Internal TypeScript contracts shared by the compiler, workflow runtime,
 * evidence gates, and supported public protocol types. */
// Enums
export var Mode;
(function (Mode) {
    Mode["LOOP_COMPILE"] = "loop_compile";
})(Mode || (Mode = {}));
export var AgentStatus;
(function (AgentStatus) {
    AgentStatus["OK"] = "ok";
    AgentStatus["ERROR"] = "error";
    AgentStatus["STALLED"] = "stalled";
})(AgentStatus || (AgentStatus = {}));
export function isApprovalPolicy(value) {
    return value === "risk_only" || value === "every_revision";
}
export function makeLoopObjective(overrides = {}) {
    return {
        objective: "",
        success_criteria: [],
        hard_constraints: [],
        created_at_round: 1,
        loop_id: "",
        version: 1,
        refinement_history: [],
        ...overrides,
    };
}
export function makeMilestoneSummary(overrides = {}) {
    return {
        label: "",
        round_range: { start: 0, end: 0 },
        outcome: "",
        carried_constraints: [],
        resolved_constraints: [],
        kind: "auto",
        generated_at_round: 0,
        ...overrides,
    };
}
export function makeExecutionHistorySummary(overrides = {}) {
    return {
        recentOutcomes: [],
        blockedOutcomes: [],
        roundsSampled: 0,
        latestRound: 0,
        milestones: [],
        synthesis: "",
        ...overrides,
    };
}
export function makeConstraintMeta(overrides = {}) {
    return {
        id: "",
        text: "",
        discovered_at_round: 0,
        last_violated_at_round: 0,
        source: "plan",
        status: "active",
        ...overrides,
    };
}
export function makeRoundHistoryEntry(overrides = {}) {
    return {
        round: 0,
        status: "in_progress",
        summary: "",
        violations: [],
        evidenceEnvelope: {
            files: { value: [], confidence: "unavailable", source: "agent" },
            fileFingerprints: {},
            checks: { value: [], confidence: "unavailable", source: "agent" },
            claims: [],
            noChangeReason: null,
            providerNames: [],
            checkProvenance: {},
            providerClaims: {},
            contradictions: [],
        },
        ...overrides,
    };
}
export function makeLoopCompileRequest(overrides = {}) {
    return {
        mode: Mode.LOOP_COMPILE,
        loop_id: "",
        round: 1,
        round_id: undefined,
        goal_id: "",
        task: "",
        domain: "",
        loop_objective: null,
        compilation_context: null,
        plan_boundary: false,
        constraints_from_plan: [],
        new_since_last_round: "",
        last_evaluation: null,
        force_level: "auto",
        external_context: "",
        verification_flags: [],
        attempt: 1,
        consecutive_rejections: 0,
        rejection_notice: "",
        ...overrides,
    };
}
export function makeLoopCompileResponse(overrides = {}) {
    return {
        status: AgentStatus.OK,
        prompt: "",
        recompile_level: "l2",
        diff_from_previous: "",
        lineage: [],
        constraints_active: [],
        loop_id: "",
        round: 0,
        goal_id: "",
        goal_text_hash: "",
        loop_objective: null,
        executionHistory: makeExecutionHistorySummary(),
        constraint_metadata: [],
        warnings: [],
        error: "",
        state_file_content: undefined,
        prompt_artifact: undefined,
        ...overrides,
    };
}
export function makeEnforcementResult(overrides = {}) {
    return {
        action: "accept",
        reason: "",
        fix_instructions: "",
        check: "",
        ...overrides,
    };
}
export function makeVerificationFlag(overrides = {}) {
    return {
        severity: "warn",
        field: "",
        check: "",
        detail: "",
        ...overrides,
    };
}
export function makeVerificationResult(overrides = {}) {
    return {
        verdict: "trusted",
        flags: [],
        ...overrides,
    };
}
// Serialization helpers
function toDict(obj) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value === null || value === undefined)
            continue;
        if (typeof value === "object" && !Array.isArray(value)) {
            result[key] = toDict(value);
        }
        else if (Array.isArray(value)) {
            result[key] = value.map((v) => typeof v === "object" && v !== null && !Array.isArray(v)
                ? toDict(v)
                : v);
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
// Factory helpers
export function makeTaskId(taskDescription) {
    let slug = taskDescription.toLowerCase().trim().slice(0, 60);
    slug = slug.replace(/[^a-z0-9\s-]/g, "");
    slug = slug.replace(/\s+/g, "-");
    return slug || "unnamed-task";
}
//# sourceMappingURL=protocol.js.map