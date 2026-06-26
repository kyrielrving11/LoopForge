/** LoopForge-loop_compile — TypeScript protocol definitions.
 *
 * All types exchanged between the Main Agent and LoopForge flow through
 * these interfaces. This is the contract layer — no implementation logic.
 *
 * v1.0: 19 types — loop_compile + build + feedback + review + rolling_summary.
 */
export declare enum Mode {
    LOOP_COMPILE = "loop_compile",
    FEEDBACK = "feedback",
    REVIEW = "review",
    BUILD = "build"
}
export declare enum AgentStatus {
    OK = "ok",
    ERROR = "error",
    STALLED = "stalled"
}
export declare enum Technique {
    ZERO_SHOT = "zero-shot",
    FEW_SHOT = "few-shot",
    ZERO_SHOT_COT = "zero-shot-cot",
    FEW_SHOT_COT = "few-shot-cot",
    STEP_BACK = "step-back",
    LEAST_TO_MOST = "least-to-most",
    TREE_OF_THOUGHT = "tree-of-thought"
}
export interface Analysis {
    technique: string;
    rationale: string;
    independence: string;
    cognitive_load: string;
    reference_file: string;
    was_rotated: boolean;
}
export declare function makeAnalysis(overrides?: Partial<Analysis>): Analysis;
export interface VaultConfig {
    project_vault: string;
    global_vault: string;
    skills_dir: string;
    no_global: boolean;
}
export declare function makeVaultConfig(overrides?: Partial<VaultConfig>): VaultConfig;
export interface ExecutionFeedback {
    output: string;
    success: boolean;
    constraint_violations: string[];
    manual_fixes_needed: string;
}
export declare function makeExecutionFeedback(overrides?: Partial<ExecutionFeedback>): ExecutionFeedback;
/** Structured self-evaluation embedded in compiled prompts.
 *  The agent outputs this after completing each round.
 *  Every field is consumed by at least one downstream function. */
export interface SelfEvaluation {
    /** true ONLY if all hard constraints were met and the task goal was achieved. */
    success: boolean;
    /** Specific, actionable summary of what was DONE this round.
     *  Feeds: buildRollingSummary (what_worked, key_lessons),
     *  computeConstraintRetirement (activity detection), vault lineage. */
    output_summary: string;
    /** Constraints the agent actually violated this round.
     *  Feeds: scoreQuality, checkLoopHealth (constraint_integrity),
     *  buildRollingSummary (recurring_issues), computeConstraintRetirement. */
    constraint_violations: string[];
    /** false ONLY when the entire task is complete. Tells the autonomous
     *  runner to stop the loop. Not consumed by the compiler. */
    should_continue: boolean;
}
export declare function makeSelfEvaluation(overrides?: Partial<SelfEvaluation>): SelfEvaluation;
/** Regex to extract a self-evaluation JSON block from agent output. */
export declare const SELF_EVAL_REGEX: RegExp;
export interface LoopForgeRequest {
    task: string;
    mode: Mode;
    vault_config: VaultConfig;
    feedback: ExecutionFeedback | null;
    skill_name: string | null;
    task_id: string | null;
    [key: string]: unknown;
}
export interface LoopObjective {
    objective: string;
    success_criteria: string[];
    hard_constraints: string[];
    created_at_round: number;
    loop_id: string;
}
export declare function makeLoopObjective(overrides?: Partial<LoopObjective>): LoopObjective;
export interface LoopHealth {
    goal_alignment: number;
    constraint_integrity: number;
    drift_detected: boolean;
    strategy_stability: boolean;
    task_continuity: number;
    escalation_recommended: string;
}
export declare function makeLoopHealth(overrides?: Partial<LoopHealth>): LoopHealth;
export interface RollingSummary {
    quality_trajectory: number[];
    trajectory_direction: string;
    what_worked: string[];
    recurring_issues: string[];
    key_lessons: string[];
    rounds_sampled: number;
    generated_at_round: number;
}
export declare function makeRollingSummary(overrides?: Partial<RollingSummary>): RollingSummary;
export interface TaskAlignment {
    is_aligned: boolean;
    alignment_score: number;
    warning: string;
    escalation: string;
}
export declare function makeTaskAlignment(overrides?: Partial<TaskAlignment>): TaskAlignment;
export interface LoopRoundResult {
    round: number;
    success: boolean;
    output_summary: string;
    constraint_violations: string[];
    manual_fixes_needed: string;
    quality_score: number;
}
export declare function makeLoopRoundResult(overrides?: Partial<LoopRoundResult>): LoopRoundResult;
export interface LoopCompileRequest {
    mode: string;
    loop_id: string;
    round: number;
    goal_id: string;
    task: string;
    domain: string;
    next_task_proposal: string;
    loop_objective: LoopObjective | null;
    plan_source: string | null;
    constraints_from_plan: string[];
    new_since_last_round: string;
    last_round_result: LoopRoundResult | null;
    force_level: string;
    health_check_interval: number;
    vault_config: VaultConfig;
}
export declare function makeLoopCompileRequest(overrides?: Partial<LoopCompileRequest>): LoopCompileRequest;
export interface LoopCompileResponse {
    status: string;
    prompt: string;
    recompile_level: string;
    diff_from_previous: string;
    lineage: string[];
    constraints_active: string[];
    constraints_retired: string[];
    technique_used: string;
    reference_file: string;
    loop_id: string;
    round: number;
    goal_id: string;
    goal_text_hash: string;
    loop_objective: LoopObjective | null;
    loop_health: LoopHealth | null;
    task_alignment: TaskAlignment | null;
    rolling_summary: RollingSummary | null;
    suggested_next_task: string;
    plan_source: string | null;
    warnings: string[];
    error: string;
}
export declare function makeLoopCompileResponse(overrides?: Partial<LoopCompileResponse>): LoopCompileResponse;
export interface LoopForgeResponse {
    status: AgentStatus;
    prompt: string | null;
    analysis: Analysis | null;
    error: string | null;
}
export interface SessionState {
    task_id: string;
    call_count: number;
    quality_trend: number[];
    current_version: string;
    last_technique: string | null;
    circuit_breaker_count: number;
    feedback_buffer: Record<string, unknown>[];
}
export declare function makeSessionState(taskId: string): SessionState;
export interface AgentLoopResult {
    status: AgentStatus;
    response: LoopForgeResponse | null;
}
export declare function toDict(obj: Record<string, unknown>): Record<string, unknown>;
export declare function makeTaskId(taskDescription: string): string;
//# sourceMappingURL=protocol.d.ts.map