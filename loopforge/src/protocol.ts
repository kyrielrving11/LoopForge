/** LoopForge-loop_compile — TypeScript protocol definitions.
 *
 * All types exchanged between the Main Agent and LoopForge flow through
 * these interfaces. This is the contract layer — no implementation logic.
 *
 * v1.2: 28 types — 4 enums + 23 interfaces + 1 type alias.
 */

// ── Enums ──────────────────────────────────────────────────────────────────

export enum Mode {
  LOOP_COMPILE = "loop_compile",
  FEEDBACK = "feedback",
  REVIEW = "review",
  BUILD = "build",
}

export enum AgentStatus {
  OK = "ok",
  ERROR = "error",
  STALLED = "stalled",
}

export enum Technique {
  ZERO_SHOT = "zero-shot",
  FEW_SHOT = "few-shot",
  ZERO_SHOT_COT = "zero-shot-cot",
  FEW_SHOT_COT = "few-shot-cot",
  STEP_BACK = "step-back",
  LEAST_TO_MOST = "least-to-most",
  TREE_OF_THOUGHT = "tree-of-thought",
}

// ── Analysis — Router output ────────────────────────────────────────────────

export interface Analysis {
  technique: string;
  rationale: string;
  independence: string;
  cognitive_load: string;
  reference_file: string;
  was_rotated: boolean;
}

export function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
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

// ── Vault config ────────────────────────────────────────────────────────────

export interface VaultConfig {
  project_vault: string;
  global_vault: string;
  skills_dir: string;
  no_global: boolean;
}

export function makeVaultConfig(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    project_vault: ".promptcraft/prompt_vault.json",
    global_vault: "~/.promptcraft/global_vault.json",
    skills_dir: "skills",
    no_global: false,
    ...overrides,
  };
}

// ── Request schemas ─────────────────────────────────────────────────────────

export interface ExecutionFeedback {
  output: string;
  success: boolean;
  constraint_violations: string[];
  manual_fixes_needed: string;
}

export function makeExecutionFeedback(
  overrides: Partial<ExecutionFeedback> = {},
): ExecutionFeedback {
  return {
    output: "",
    success: false,
    constraint_violations: [],
    manual_fixes_needed: "",
    ...overrides,
  };
}

// ── Agent Self-Evaluation (autonomous loop feedback) ────────────────────────

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

export function makeSelfEvaluation(
  overrides: Partial<SelfEvaluation> = {},
): SelfEvaluation {
  return {
    success: false,
    output_summary: "",
    constraint_violations: [],
    should_continue: true,
    ...overrides,
  };
}

/** Regex to extract a self-evaluation JSON block from agent output. */
export const SELF_EVAL_REGEX =
  /---loopforge-eval\s*([\s\S]*?)\s*---end-loopforge-eval/;

export interface LoopForgeRequest {
  task: string;
  mode: Mode;
  vault_config: VaultConfig;
  feedback: ExecutionFeedback | null;
  skill_name: string | null;
  task_id: string | null;
  // Dynamic fields (loop_compile mode attaches these via extras)
  [key: string]: unknown;
}

// ── Loop Compile types ──────────────────────────────────────────────────────

export interface LoopObjective {
  objective: string;
  success_criteria: string[];
  hard_constraints: string[];
  created_at_round: number;
  loop_id: string;
}

export function makeLoopObjective(
  overrides: Partial<LoopObjective> = {},
): LoopObjective {
  return {
    objective: "",
    success_criteria: [],
    hard_constraints: [],
    created_at_round: 1,
    loop_id: "",
    ...overrides,
  };
}

export interface LoopHealth {
  goal_alignment: number;
  constraint_integrity: number;
  drift_detected: boolean;
  strategy_stability: boolean;
  task_continuity: number;
  escalation_recommended: string;
}

export function makeLoopHealth(overrides: Partial<LoopHealth> = {}): LoopHealth {
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

export interface RollingSummary {
  quality_trajectory: number[];
  trajectory_direction: string;
  what_worked: string[];
  recurring_issues: string[];
  key_lessons: string[];
  rounds_sampled: number;
  generated_at_round: number;
}

export function makeRollingSummary(
  overrides: Partial<RollingSummary> = {},
): RollingSummary {
  return {
    quality_trajectory: [],
    trajectory_direction: "",
    what_worked: [],
    recurring_issues: [],
    key_lessons: [],
    rounds_sampled: 0,
    generated_at_round: 0,
    ...overrides,
  };
}

export interface TaskAlignment {
  is_aligned: boolean;
  alignment_score: number;
  warning: string;
  escalation: string;
}

export function makeTaskAlignment(
  overrides: Partial<TaskAlignment> = {},
): TaskAlignment {
  return {
    is_aligned: true,
    alignment_score: 1.0,
    warning: "",
    escalation: "none",
    ...overrides,
  };
}

export interface LoopRoundResult {
  round: number;
  success: boolean;
  output_summary: string;
  constraint_violations: string[];
  manual_fixes_needed: string;
  quality_score: number;
}

export function makeLoopRoundResult(
  overrides: Partial<LoopRoundResult> = {},
): LoopRoundResult {
  return {
    round: 0,
    success: false,
    output_summary: "",
    constraint_violations: [],
    manual_fixes_needed: "",
    quality_score: 0,
    ...overrides,
  };
}

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

export function makeLoopCompileRequest(
  overrides: Partial<LoopCompileRequest> = {},
): LoopCompileRequest {
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

export function makeLoopCompileResponse(
  overrides: Partial<LoopCompileResponse> = {},
): LoopCompileResponse {
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

// ── Response schemas ────────────────────────────────────────────────────────

export interface LoopForgeResponse {
  status: AgentStatus;
  prompt: string | null;
  analysis: Analysis | null;
  error: string | null;
}

// ── Session state (Engine internal) ─────────────────────────────────────────

export interface SessionState {
  task_id: string;
  call_count: number;
  quality_trend: number[];
  current_version: string;
  last_technique: string | null;
  circuit_breaker_count: number;
  feedback_buffer: Record<string, unknown>[];
}

export function makeSessionState(taskId: string): SessionState {
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

// ── Agent result ────────────────────────────────────────────────────────────

export interface AgentLoopResult {
  status: AgentStatus;
  response: LoopForgeResponse | null;
}

// ── Runtime types (v1.2) ──────────────────────────────────────────────────────

export enum RuntimeStatus {
  IDLE = "idle",
  RUNNING = "running",
  STOPPED = "stopped",
  STALLED = "stalled",
}

export interface RoundContext {
  round: number;
  signal: { aborted: boolean };
  reportProgress: (message: string) => void;
}

export type AgentExecutor = (prompt: string, ctx: RoundContext) => Promise<string>;

export type StopReason =
  | "task_complete"
  | "circuit_breaker"
  | "max_rounds"
  | "stalled"
  | "stopped"
  | "executor_failure";

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

// ── Serialisation helpers ───────────────────────────────────────────────────

export function toDict(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "object" && !Array.isArray(value)) {
      result[key] = toDict(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) =>
        typeof v === "object" && v !== null && !Array.isArray(v)
          ? toDict(v as Record<string, unknown>)
          : v,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Factory helpers ─────────────────────────────────────────────────────────

export function makeTaskId(taskDescription: string): string {
  let slug = taskDescription.toLowerCase().trim().slice(0, 60);
  slug = slug.replace(/[^a-z0-9\s-]/g, "");
  slug = slug.replace(/\s+/g, "-");
  return slug || "unnamed-task";
}
