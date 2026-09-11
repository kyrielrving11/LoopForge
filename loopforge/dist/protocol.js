/** LoopForge-loop_compile — TypeScript protocol definitions.
 *
 * All types exchanged between the Main Agent and LoopForge flow through
 * these interfaces. This is the contract layer — no implementation logic.
 *
 * v3.3: 41 types — 2 enums + 35 interfaces + 4 type aliases.
 */
// ── Enums ──────────────────────────────────────────────────────────────────
export var Mode;
(function (Mode) {
    Mode["LOOP_COMPILE"] = "loop_compile";
    Mode["FEEDBACK"] = "feedback";
})(Mode || (Mode = {}));
// Type-only import — erased at runtime, no dependency cycle with
// canonical-state.ts (which imports protocol.ts for its types).
export var AgentStatus;
(function (AgentStatus) {
    AgentStatus["OK"] = "ok";
    AgentStatus["ERROR"] = "error";
    AgentStatus["STALLED"] = "stalled";
})(AgentStatus || (AgentStatus = {}));
export function makeExecutionFeedback(overrides = {}) {
    return {
        output: "",
        success: false,
        constraint_violations: [],
        manual_fixes_needed: "",
        ...overrides,
    };
}
export function makeLoopProjection(overrides = {}) {
    return {
        focus: null,
        todo: [],
        phase: null,
        delegation: { pending: 0, last_results: [] },
        handoff: { summary: "", verified: [], open_risks: [] },
        verified_subgoals: [],
        ...overrides,
    };
}
export function makeGateDecision(overrides = {}) {
    return {
        gateId: "",
        kind: "user",
        approved: false,
        scope: [],
        note: "",
        decidedAt: new Date().toISOString(),
        actionHash: "",
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
        progress_at_boundary: 0,
        kind: "auto",
        generated_at_round: 0,
        ...overrides,
    };
}
export function makeSelfEvaluation(overrides = {}) {
    return {
        success: false,
        output_summary: "",
        constraint_violations: [],
        should_continue: true,
        discovered_constraints: [],
        objective_refinement: "",
        emerged_subtasks: [],
        subgoal_updates: [],
        execution_report: undefined,
        retracted_constraints: [],
        revised_success_criteria: [],
        wrong_assumptions: [],
        worker_results: [],
        compression_checkpoint: false,
        checkpoint_label: "",
        stop_reason: undefined,
        outcome: undefined,
        blocker: undefined,
        retroactiveClaims: [],
        no_change_reason: undefined,
        prompt_requests: undefined,
        round_contract: undefined,
        ...overrides,
    };
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
export function makeRollingSummary(overrides = {}) {
    return {
        key_outcomes: [],
        rounds_sampled: 0,
        generated_at_round: 0,
        failed_patterns: [],
        milestones: [],
        ...overrides,
    };
}
export function makeSubGoalUpdate(overrides = {}) {
    return { id: "", status: "done", ...overrides };
}
export function makeSubGoal(overrides = {}) {
    return {
        id: "",
        description: "",
        status: "pending",
        declared_at_round: 0,
        status_changed_at_round: 0,
        priority: 0,
        ...overrides,
    };
}
export function makeConstraintMeta(overrides = {}) {
    return {
        id: "",
        text: "",
        last_violated_at_round: 0,
        source: "discovered",
        ...overrides,
    };
}
export function makeLoopRoundResult(overrides = {}) {
    return {
        round: 0,
        success: false,
        output_summary: "",
        constraint_violations: [],
        manual_fixes_needed: "",
        discovered_constraints: [],
        objective_refinement: "",
        emerged_subtasks: [],
        subgoal_updates: [],
        execution_report: undefined,
        retracted_constraints: [],
        revised_success_criteria: [],
        wrong_assumptions: [],
        worker_results: [],
        compression_checkpoint: false,
        checkpoint_label: "",
        prompt_requests: undefined,
        outcome: undefined,
        blocker: undefined,
        retroactiveClaims: [],
        no_change_reason: undefined,
        ...overrides,
    };
}
export function makeLoopCompileRequest(overrides = {}) {
    return {
        mode: Mode.LOOP_COMPILE,
        loop_id: "",
        round: 1,
        goal_id: "",
        task: "",
        domain: "",
        next_task_proposal: "",
        loop_objective: null,
        plan_source: null,
        constraints_from_plan: [],
        new_since_last_round: "",
        last_round_result: null,
        force_level: "auto",
        external_context: "",
        verification_flags: [],
        attempt: 1,
        consecutive_rejections: 0,
        rejection_notice: "",
        ...overrides,
    };
}
/** Immutable record of the exact prompt delivered for one round attempt. */
/** v3.8.1: the artifact schema version, next to the type it versions. The
 *  transaction envelope parser reads it, so the constant lives here rather
 *  than in the renderer. */
export const PROMPT_ARTIFACT_SCHEMA_VERSION = 2;
export function makeLoopCompileResponse(overrides = {}) {
    return {
        status: AgentStatus.OK,
        prompt: "",
        recompile_level: "l2",
        diff_from_previous: "",
        lineage: [],
        constraints_active: [],
        constraints_retired: [],
        loop_id: "",
        round: 0,
        goal_id: "",
        goal_text_hash: "",
        loop_objective: null,
        rolling_summary: null,
        sub_goals: [],
        constraint_metadata: [],
        plan_source: null,
        warnings: [],
        error: "",
        state_file_content: undefined,
        prompt_artifact: undefined,
        ...overrides,
    };
}
export function makeEvidenceSnapshot(overrides = {}) {
    return { verified: [], pending: [], invalidated: [], discovered: [], ...overrides };
}
export function makeSessionState(taskId) {
    return {
        task_id: taskId,
        call_count: 0,
        success_trend: [],
    };
}
export function makeEnforcementResult(overrides = {}) {
    return {
        action: "accept",
        reason: "",
        fix_instructions: "",
        check: "",
        stopReason: undefined,
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
export function makeExecutionReport(overrides = {}) {
    return {
        files_changed: [],
        tests_reported: null,
        criterion_claims: [],
        contract_item_claims: [],
        progress_estimate: 0.0,
        ...overrides,
    };
}
// ── Serialisation helpers ───────────────────────────────────────────────────
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
// ── Factory helpers ─────────────────────────────────────────────────────────
export function makeTaskId(taskDescription) {
    let slug = taskDescription.toLowerCase().trim().slice(0, 60);
    slug = slug.replace(/[^a-z0-9\s-]/g, "");
    slug = slug.replace(/\s+/g, "-");
    return slug || "unnamed-task";
}
//# sourceMappingURL=protocol.js.map