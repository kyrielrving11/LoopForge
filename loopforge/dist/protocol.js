/** LoopForge-loop_compile — TypeScript protocol definitions.
 *
 * All types exchanged between the Main Agent and LoopForge flow through
 * these interfaces. This is the contract layer — no implementation logic.
 *
 * v1.6: 32 types — 4 enums + 27 interfaces + 1 type alias.
 */
// ── Enums ──────────────────────────────────────────────────────────────────
export var Mode;
(function (Mode) {
    Mode["LOOP_COMPILE"] = "loop_compile";
    Mode["FEEDBACK"] = "feedback";
})(Mode || (Mode = {}));
export var AgentStatus;
(function (AgentStatus) {
    AgentStatus["OK"] = "ok";
    AgentStatus["ERROR"] = "error";
    AgentStatus["STALLED"] = "stalled";
})(AgentStatus || (AgentStatus = {}));
export var Technique;
(function (Technique) {
    Technique["ZERO_SHOT"] = "zero-shot";
    Technique["FEW_SHOT"] = "few-shot";
    Technique["ZERO_SHOT_COT"] = "zero-shot-cot";
    Technique["FEW_SHOT_COT"] = "few-shot-cot";
    Technique["STEP_BACK"] = "step-back";
    Technique["LEAST_TO_MOST"] = "least-to-most";
    Technique["TREE_OF_THOUGHT"] = "tree-of-thought";
})(Technique || (Technique = {}));
export function makeAnalysis(overrides = {}) {
    return {
        technique: "zero-shot",
        rationale: "",
        independence: "independent",
        cognitive_load: "low",
        reference_file: "",
        was_rotated: false,
        ...overrides,
    };
}
export function makeVaultConfig(overrides = {}) {
    return {
        project_vault: ".promptcraft/prompt_vault.json",
        global_vault: "~/.promptcraft/global_vault.json",
        skills_dir: "skills",
        no_global: false,
        ...overrides,
    };
}
export function makeExecutionFeedback(overrides = {}) {
    return {
        output: "",
        success: false,
        constraint_violations: [],
        manual_fixes_needed: "",
        ...overrides,
    };
}
export function makeExecutionEvidence(overrides = {}) {
    return {
        files_changed: [],
        test_results: null,
        success_criteria_met: [],
        success_criteria_remaining: [],
        progress_estimate: 0.0,
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
        execution_evidence: makeExecutionEvidence(),
        retracted_constraints: [],
        revised_success_criteria: [],
        wrong_assumptions: [],
        ...overrides,
    };
}
/** Regex to extract a self-evaluation JSON block from agent output. */
export const SELF_EVAL_REGEX = /---loopforge-eval\s*([\s\S]*?)\s*---end-loopforge-eval/;
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
export function makeLoopHealth(overrides = {}) {
    return {
        goal_alignment: 1.0,
        constraint_integrity: 1.0,
        drift_detected: false,
        strategy_stability: true,
        task_continuity: 1.0,
        escalation_recommended: "none",
        ...overrides,
    };
}
export function makeRollingSummary(overrides = {}) {
    return {
        quality_trajectory: [],
        trajectory_direction: "",
        what_worked: [],
        recurring_issues: [],
        key_lessons: [],
        rounds_sampled: 0,
        generated_at_round: 0,
        failed_patterns: [],
        ...overrides,
    };
}
export function makeTaskAlignment(overrides = {}) {
    return {
        is_aligned: true,
        alignment_score: 1.0,
        warning: "",
        escalation: "none",
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
        quality_score: 0,
        discovered_constraints: [],
        objective_refinement: "",
        emerged_subtasks: [],
        execution_evidence: undefined,
        retracted_constraints: [],
        revised_success_criteria: [],
        wrong_assumptions: [],
        ...overrides,
    };
}
export function makeLoopCompileRequest(overrides = {}) {
    return {
        mode: "loop_compile",
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
        health_check_interval: 1,
        vault_config: makeVaultConfig(),
        ...overrides,
    };
}
export function makeLoopCompileResponse(overrides = {}) {
    return {
        status: "ok",
        prompt: "",
        recompile_level: "l2",
        diff_from_previous: "",
        lineage: [],
        constraints_active: [],
        constraints_retired: [],
        technique_used: "",
        reference_file: "",
        loop_id: "",
        round: 0,
        goal_id: "",
        goal_text_hash: "",
        loop_objective: null,
        loop_health: null,
        task_alignment: null,
        rolling_summary: null,
        suggested_next_task: "",
        plan_source: null,
        warnings: [],
        error: "",
        ...overrides,
    };
}
export function makeSessionState(taskId) {
    return {
        task_id: taskId,
        call_count: 0,
        quality_trend: [],
        current_version: "v1",
        last_technique: null,
        circuit_breaker_count: 0,
        feedback_buffer: [],
    };
}
// ── Runtime types (v1.2) ──────────────────────────────────────────────────────
export var RuntimeStatus;
(function (RuntimeStatus) {
    RuntimeStatus["IDLE"] = "idle";
    RuntimeStatus["RUNNING"] = "running";
    RuntimeStatus["STOPPED"] = "stopped";
    RuntimeStatus["STALLED"] = "stalled";
})(RuntimeStatus || (RuntimeStatus = {}));
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
// ── Serialisation helpers ───────────────────────────────────────────────────
export function toDict(obj) {
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