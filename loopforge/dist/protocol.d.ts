/** LoopForge-loop_compile — TypeScript protocol definitions.
 *
 * All types exchanged between the Main Agent and LoopForge flow through
 * these interfaces. This is the contract layer — no implementation logic.
 *
 * v1.6: 32 types — 4 enums + 27 interfaces + 1 type alias.
 */
export declare enum Mode {
    LOOP_COMPILE = "loop_compile",
    FEEDBACK = "feedback"
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
/** P4: Structured execution evidence reported by the agent after each round.
 *  Gives LoopForge visibility into what actually happened — files changed,
 *  test results, success criteria met, and a subjective progress estimate.
 *  Enables the compiler to cross-validate agent claims and compute real progress. */
export interface ExecutionEvidence {
    /** Files changed in this round. Empty if no files were modified. */
    files_changed: string[];
    /** Test results. null if no tests were run. */
    test_results: {
        passed: number;
        failed: number;
        skipped: number;
    } | null;
    /** Success criteria from the Loop Objective that were MET this round. */
    success_criteria_met: string[];
    /** Success criteria from the Loop Objective that REMAIN unmet. */
    success_criteria_remaining: string[];
    /** Agent's own estimate of overall progress (0.0 to 1.0). */
    progress_estimate: number;
}
export declare function makeExecutionEvidence(overrides?: Partial<ExecutionEvidence>): ExecutionEvidence;
/** P5: A revision to a success criterion — the old form and the new form.
 *  The agent proposes this when it discovers the original criterion was
 *  wrong, unrealistic, or needs refinement. */
export interface CriterionRevision {
    old: string;
    new: string;
}
/** Structured self-evaluation embedded in compiled prompts.
 *  The agent outputs this after completing each round.
 *  Every field is consumed by at least one downstream function.
 *
 *  v1.4 (P0–P2): Three new optional fields enable cognitive evolution.
 *  v1.5 (P4–P5): Execution evidence, progress tracking, and self-correction. */
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
    /** P0: New constraints discovered during this round that were not
     *  known before. Merged into the active constraint set by the compiler.
     *  Omit or leave empty if none discovered. */
    discovered_constraints?: string[];
    /** P1: A refinement / deepening of the task objective based on this
     *  round's discoveries. Appended to (never replaces) the original
     *  objective. Omit if understanding is unchanged. */
    objective_refinement?: string;
    /** P2: Sub-problems that surfaced during execution and may need
     *  separate attention. Feed into the next-task suggestion.
     *  Omit or leave empty if none emerged. */
    emerged_subtasks?: string[];
    /** P4: Structured evidence of what was executed this round.
     *  Files changed, test results, criteria met/remaining, progress estimate.
     *  Enables the compiler to validate claims and compute real progress. */
    execution_evidence?: ExecutionEvidence;
    /** P5: Constraints that the agent now believes are wrong or irrelevant.
     *  Removed from the active constraint set by the compiler.
     *  Omit or leave empty if none. */
    retracted_constraints?: string[];
    /** P5: Success criteria that need revision. The agent discovered the
     *  original criterion was incorrect and proposes a new formulation.
     *  Applied to the Loop Objective by the compiler (version++). */
    revised_success_criteria?: CriterionRevision[];
    /** P5: Assumptions the agent made in earlier rounds that turned out to
     *  be wrong. Recorded in the rolling summary as key lessons.
     *  Omit or leave empty if none. */
    wrong_assumptions?: string[];
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
    /** P1: Version number for the objective, starting at 1.
     *  Incremented each time objective_refinement is applied. */
    version?: number;
    /** P1: Ordered history of all objective refinements applied.
     *  Each entry is the refinement text from a single round. */
    refinement_history?: string[];
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
    /** v1.7: Detected failure patterns — repeated low-quality rounds with
     *  the same technique and similar task text. These are demoted in
     *  key_lessons and surfaced as explicit warnings in the prompt. */
    failed_patterns?: string[];
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
    /** P0: Constraints discovered during this round. */
    discovered_constraints?: string[];
    /** P1: Objective refinement from this round. */
    objective_refinement?: string;
    /** P2: Sub-problems that emerged during this round. */
    emerged_subtasks?: string[];
    /** P4: Execution evidence from this round. */
    execution_evidence?: ExecutionEvidence;
    /** P5: Constraints retracted this round. */
    retracted_constraints?: string[];
    /** P5: Success criteria revised this round. */
    revised_success_criteria?: CriterionRevision[];
    /** P5: Wrong assumptions identified this round. */
    wrong_assumptions?: string[];
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
export declare enum RuntimeStatus {
    IDLE = "idle",
    RUNNING = "running",
    STOPPED = "stopped",
    STALLED = "stalled"
}
export interface RoundContext {
    round: number;
    signal: {
        aborted: boolean;
    };
    reportProgress: (message: string) => void;
}
export type AgentExecutor = (prompt: string, ctx: RoundContext) => Promise<string>;
export type StopReason = "task_complete" | "circuit_breaker" | "max_rounds" | "stalled" | "stopped" | "executor_failure";
export interface RoundStartInfo {
    round: number;
    level: string;
    technique: string;
    prompt: string;
}
export interface RoundCompleteInfo {
    round: number;
    quality: number;
    selfEval: SelfEvaluation | null;
    durationMs: number;
}
export interface HeartbeatInfo {
    round: number;
    elapsedMs: number;
    sinceProgressMs: number;
}
export interface TimeoutInfo {
    round: number;
    elapsedMs: number;
}
export interface HealthWarning {
    type: string;
    message: string;
}
export interface RuntimeConfig {
    task: string;
    execute: AgentExecutor;
    loopId?: string;
    goalId?: string;
    maxRounds?: number;
    roundTimeoutMs?: number;
    heartbeatIntervalMs?: number;
    stallGraceMs?: number;
    maxConsecutiveErrors?: number;
    interactive?: boolean;
    healthCheckInterval?: number;
    planSource?: string;
    constraintsFromPlan?: string[];
    domain?: string;
    onRoundStart?: (info: RoundStartInfo) => void;
    onRoundComplete?: (info: RoundCompleteInfo) => void;
    onHeartbeat?: (info: HeartbeatInfo) => void;
    onTimeout?: (info: TimeoutInfo) => void;
    onHealthWarning?: (warning: HealthWarning) => void;
}
export interface RunResult {
    success: boolean;
    stopReason: StopReason;
    roundsCompleted: number;
    qualityTrajectory: number[];
}
/** A single flag raised during self-evaluation verification.
 *  Each flag identifies a specific inconsistency between the agent's
 *  self-reported data and the loop's cross-round lineage. */
export interface VerificationFlag {
    /** info | warn | error — determines how aggressively the compiler reacts. */
    severity: "info" | "warn" | "error";
    /** Which SelfEvaluation field triggered this flag (e.g. "progress_estimate"). */
    field: string;
    /** Check name for debugging / audit (e.g. "progress_regression"). */
    check: string;
    /** Human-readable description of the inconsistency found. */
    detail: string;
}
export declare function makeVerificationFlag(overrides?: Partial<VerificationFlag>): VerificationFlag;
/** Result of cross-round self-evaluation verification.
 *
 *  Verdict semantics:
 *  - trusted:   all checks passed; flags are informational only.
 *  - suspect:   one or more warn-level flags; flags become warnings in the
 *               next prompt so the agent can clarify.
 *  - contradicted: one or more error-level flags; the quality score for this
 *                  round is excluded from the quality trend (NOT modified).
 *                  Flags become hard constraints — the agent must respond. */
export interface VerificationResult {
    verdict: "trusted" | "suspect" | "contradicted";
    flags: VerificationFlag[];
}
export declare function makeVerificationResult(overrides?: Partial<VerificationResult>): VerificationResult;
export declare function toDict(obj: Record<string, unknown>): Record<string, unknown>;
export declare function makeTaskId(taskDescription: string): string;
//# sourceMappingURL=protocol.d.ts.map