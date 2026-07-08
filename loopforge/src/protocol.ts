/** LoopForge-loop_compile — TypeScript protocol definitions.
 *
 * All types exchanged between the Main Agent and LoopForge flow through
 * these interfaces. This is the contract layer — no implementation logic.
 *
 * v1.10: 39 types — 4 enums + 34 interfaces + 1 type alias.
 */

// ── Enums ──────────────────────────────────────────────────────────────────

export enum Mode {
  LOOP_COMPILE = "loop_compile",
  FEEDBACK = "feedback",
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
  /** @deprecated Since v4.0 — no technique rotation. Always false. */
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

/** P4: Structured execution evidence reported by the agent after each round.
 *  Gives LoopForge visibility into what actually happened — files changed,
 *  test results, success criteria met, and a subjective progress estimate.
 *  Enables the compiler to cross-validate agent claims and compute real progress. */
export interface ExecutionEvidence {
  /** Files changed in this round. Empty if no files were modified. */
  files_changed: string[];
  /** Test results. null if no tests were run. */
  test_results: { passed: number; failed: number; skipped: number } | null;
  /** Success criteria from the Loop Objective that were MET this round. */
  success_criteria_met: string[];
  /** Success criteria from the Loop Objective that REMAIN unmet. */
  success_criteria_remaining: string[];
  /** Agent's own estimate of overall progress (0.0 to 1.0). */
  progress_estimate: number;
}

export function makeExecutionEvidence(
  overrides: Partial<ExecutionEvidence> = {},
): ExecutionEvidence {
  return {
    files_changed: [],
    test_results: null,
    success_criteria_met: [],
    success_criteria_remaining: [],
    progress_estimate: 0.0,
    ...overrides,
  };
}

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
   *  Feeds: buildRollingSummary (key_outcomes),
   *  computeConstraintRetirement (activity detection), vault lineage. */
  output_summary: string;
  /** Constraints the agent actually violated this round.
   *  Feeds: checkLoopHealth (constraint_integrity),
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
  /** v1.10: Agent declares a subtask boundary. When true, the compiler
   *  snapshots the current round's state into a CheckpointSummary that
   *  persists across rolling-window eviction. */
  compression_checkpoint?: boolean;
  /** v1.10: Human-readable label for this checkpoint (e.g. "数据模型层完成").
   *  Used as the checkpoint heading in subsequent prompts. */
  checkpoint_label?: string;
  /** Multi-agent: Results of sub-agent / Worker delegations this round.
   *  The main agent (or Coordinator) reports what it delegated.
   *  The engine automatically writes these to the delegation journal.
   *  Omit or leave empty if no delegations occurred. */
  worker_results?: WorkerResult[];
}

/** v1.10: Checkpoint summary — a compressed snapshot of loop state at a
 *  subtask boundary. Declared by the Agent via self-evaluation, built by
 *  the compiler. Rendered as a fixed block that survives rolling-window
 *  eviction, so constraints and outcomes from completed subtasks remain
 *  visible in later rounds. */
export interface CheckpointSummary {
  label: string;
  declared_at_round: number;
  outcome: string;
  carried_constraints: string[];
  resolved_constraints: string[];
}

export function makeCheckpointSummary(
  overrides: Partial<CheckpointSummary> = {},
): CheckpointSummary {
  return {
    label: "",
    declared_at_round: 0,
    outcome: "",
    carried_constraints: [],
    resolved_constraints: [],
    ...overrides,
  };
}

/** A single sub-agent / Worker delegation result (v1.9 — multi-agent). */
export interface WorkerResult {
  agentId: string;
  subAgentType: string;
  subTask: string;
  resultSummary: string;
  success: boolean;
  discoveredConstraints?: string[];
}

export function makeSelfEvaluation(
  overrides: Partial<SelfEvaluation> = {},
): SelfEvaluation {
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
    worker_results: [],
    compression_checkpoint: false,
    checkpoint_label: "",
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
  // Extended fields accepted by invokeLoopCompile() to populate LoopCompileRequest:
  //   loop_id, round, goal_id, domain, next_task_proposal, plan_source,
  //   constraints_from_plan, new_since_last_round, force_level,
  //   health_check_interval, external_context, last_round_result,
  //   verification_flags
  [key: string]: unknown;
}

// ── Loop Compile types ──────────────────────────────────────────────────────

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

export function makeLoopObjective(
  overrides: Partial<LoopObjective> = {},
): LoopObjective {
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
  /** v1.12: Unified key outcomes — merged from what_worked + key_lessons.
   *  Format: "[R{round}] ✓/✗ ({technique}): {summary}" */
  key_outcomes: string[];
  recurring_issues: string[];
  rounds_sampled: number;
  generated_at_round: number;
  /** v1.7: Detected failure patterns — repeated failed rounds with
   *  the same technique and similar task text. These are surfaced as
   *  explicit warnings in the prompt. */
  failed_patterns?: string[];
}

export function makeRollingSummary(
  overrides: Partial<RollingSummary> = {},
): RollingSummary {
  return {
    key_outcomes: [],
    recurring_issues: [],
    rounds_sampled: 0,
    generated_at_round: 0,
    failed_patterns: [],
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
  /** Multi-agent: Delegation results from this round.
   *  Set from SelfEvaluation.worker_results during buildLoopRequest. */
  worker_results?: WorkerResult[];
  /** v1.10: Agent declared a subtask boundary in this round. */
  compression_checkpoint?: boolean;
  /** v1.10: Human-readable label for the checkpoint. */
  checkpoint_label?: string;
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
    discovered_constraints: [],
    objective_refinement: "",
    emerged_subtasks: [],
    execution_evidence: undefined,
    retracted_constraints: [],
    revised_success_criteria: [],
    wrong_assumptions: [],
    worker_results: [],
    compression_checkpoint: false,
    checkpoint_label: "",
    ...overrides,
  };
}

export interface LoopCompileRequest {
  mode: Mode;
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
  /** Optional external context from a long-term memory system (e.g. claude-mem).
   *  Injected into L2 prompts only. Ignored by L0/L1 compilers.
   *  Populated by the caller (runtime / MCP session) via a memoryProvider callback. */
  external_context?: string;
}

export function makeLoopCompileRequest(
  overrides: Partial<LoopCompileRequest> = {},
): LoopCompileRequest {
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
    health_check_interval: 1,
    vault_config: makeVaultConfig(),
    external_context: "",
    ...overrides,
  };
}

export interface LoopCompileResponse {
  status: AgentStatus;
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
  checkpoint_summary: CheckpointSummary | null;
  suggested_next_task: string;
  plan_source: string | null;
  warnings: string[];
  error: string;
}

export function makeLoopCompileResponse(
  overrides: Partial<LoopCompileResponse> = {},
): LoopCompileResponse {
  return {
    status: AgentStatus.OK,
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
    checkpoint_summary: null,
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
  success_trend: boolean[];
  current_version: string;
  last_technique: string | null;
  circuit_breaker_count: number;
  feedback_buffer: Record<string, unknown>[];
}

export function makeSessionState(taskId: string): SessionState {
  return {
    task_id: taskId,
    call_count: 0,
    success_trend: [],
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
  roundSuccess: boolean;
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
  /** Optional provider for long-term memory context retrieval.
   *  Called at L2 compile rounds during designated injection phases.
   *  Receives loop state for constructing a targeted query.
   *  Return empty string to skip injection. */
  memoryProvider?: (ctx: MemoryProviderContext) => Promise<string>;
  /** Optional writer for persisting loop knowledge back to long-term memory.
   *  Called once when the loop terminates (any stop reason).
   *  Receives a structured writeback payload with project/feedback/reference entries. */
  memoryWriter?: (payload: LoopMemoryWriteback) => Promise<void>;
}

/** Context passed to the memoryProvider callback at each injection phase.
 *  Contains enough loop state to construct a targeted semantic query. */
export interface MemoryProviderContext {
  loopId: string;
  round: number;
  task: string;
  domain: string;
  /** Injection phase: 1 (start), 2 (mid), 3 (late). */
  phase: 1 | 2 | 3;
  /** Current progress estimate (0.0–1.0), or -1 if unavailable. */
  progressEstimate: number;
  /** Accumulated loop knowledge for constructing a differential query. */
  accumulatedContext: {
    recurringIssues: string[];
    failedPatterns: string[];
    keyLessons: string[];
    remainingCriteria: string[];
  };
}

export interface RunResult {
  success: boolean;
  stopReason: StopReason;
  roundsCompleted: number;
  successTrajectory: boolean[];
}

// ── Memory Writeback (v1.7) ───────────────────────────────────────────────────

/** Structured payload written back to the long-term memory system
 *  when a loop terminates. Contains distilled knowledge suitable
 *  for cross-task reuse. */
export interface LoopMemoryWriteback {
  loopId: string;
  task: string;
  outcome: "completed" | "circuit_breaker" | "stalled" | "max_rounds" | "stopped";
  roundsCompleted: number;
  /** Project-type memory entry — task outcome and key discoveries. */
  projectEntry: LoopMemoryWritebackProjectEntry;
  /** Feedback-type memory entries — tactical lessons learned. */
  feedbackEntries: LoopMemoryWritebackFeedbackEntry[];
  /** Reference-type memory entry — pointer to the vault for deep dives. */
  referenceEntry: LoopMemoryWritebackReferenceEntry;
}

export interface LoopMemoryWritebackProjectEntry {
  title: string;
  objective: string;
  keyOutcome: string;
  keyDiscoveries: string[];
  date: string;
}

export interface LoopMemoryWritebackFeedbackEntry {
  rule: string;
  why: string;
  howToApply: string;
}

export interface LoopMemoryWritebackReferenceEntry {
  description: string;
  vaultLocation: string;
}

// ── Verification Gate (v1.6) ──────────────────────────────────────────────────

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

export function makeVerificationFlag(
  overrides: Partial<VerificationFlag> = {},
): VerificationFlag {
  return {
    severity: "warn",
    field: "",
    check: "",
    detail: "",
    ...overrides,
  };
}

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

export function makeVerificationResult(
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    verdict: "trusted",
    flags: [],
    ...overrides,
  };
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
