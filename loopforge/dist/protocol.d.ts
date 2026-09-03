/** LoopForge-loop_compile — TypeScript protocol definitions.
 *
 * All types exchanged between the Main Agent and LoopForge flow through
 * these interfaces. This is the contract layer — no implementation logic.
 *
 * v3.3: 41 types — 2 enums + 35 interfaces + 4 type aliases.
 */
export declare enum Mode {
    LOOP_COMPILE = "loop_compile",
    FEEDBACK = "feedback"
}
import type { PresentedStateSnapshot } from "./canonical-state.js";
export declare enum AgentStatus {
    OK = "ok",
    ERROR = "error",
    STALLED = "stalled"
}
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
/** v3.3: Round Contract. v3.4 semantics: the field on a submission is a
 *  PROPOSAL for the NEXT round — it becomes the ACTIVE contract (rendered
 *  as the Current Task and checked for execution conformance) only after
 *  the declaring round commits, and stays active until a committed eval
 *  lists every done_when item in success_criteria_met (complete) or
 *  reports outcome="blocked". While active it is restated unchanged each
 *  round; on completion or block, the next contract is declared instead.
 *  The ACTIVE contract is machine-derived from committed rounds
 *  (round-contract.ts) — never read from last_round_result. Optional:
 *  absent = no contract this round, all contract checks stay silent and
 *  rendering is identical to a contract-less round.
 *
 *  Every field is machine-checkable:
 *  - done_when items are claimed satisfied by listing them in
 *    execution_evidence.success_criteria_met (verified per-round claim
 *    model); leaving them out while success is claimed is premature_boundary
 *    against the ACTIVE contract.
 *  - verification_plan names must reference configured, enabled
 *    evidence.commands (round_unverifiable otherwise).
 *  - scope lists the files/directories the round may touch; actual git
 *    changes outside it trigger round_scope_drift against the ACTIVE
 *    contract. */
export interface RoundContract {
    /** Round focus, one line. Rendered as the Current Task's first line. */
    work_item?: string;
    /** Completion conditions: cr-XXXXXXXX criterion IDs or free text.
     *  Claimed met = listed in success_criteria_met; still open = listed in
     *  success_criteria_remaining. ≤ 20 items. */
    done_when: string[];
    /** Verification plan: names of configured, enabled evidence commands
     *  (policy.evidence.commands[].name). ≤ 20 items. */
    verification_plan: string[];
    /** Files/directories this round may touch (workspace-relative paths,
     *  forward or back slashes, "./" prefix and trailing slashes accepted).
     *  Out-of-scope git changes = round_scope_drift. ≤ 50 items. */
    scope: string[];
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
     *  generates an agent_declared milestone. */
    compression_checkpoint?: boolean;
    /** v1.10: Human-readable label for this checkpoint (e.g. "数据模型层完成").
     *  Used as the checkpoint heading in subsequent prompts. */
    checkpoint_label?: string;
    /** Multi-agent: Results of sub-agent / Worker delegations this round.
     *  The main agent (or Coordinator) reports what it delegated.
     *  The engine automatically writes these to the delegation journal.
     *  Omit or leave empty if no delegations occurred. */
    worker_results?: WorkerResult[];
    /** v1.16: Agent's declared next action — what it plans to do in the
     *  following round. Stored as loop state and rendered in the next prompt
     *  so the agent's self-planning persists across rounds. Optional —
     *  no next_action means the compiler generates the next task as before. */
    next_action?: string;
    /** v2.2: Sub-tasks the agent completed this round. Each entry may be a
     *  sub-goal ID (e.g. "sg-a3f2b1c0" from the Sub-Goal Dashboard) for
     *  exact matching, or a natural-language description for Jaccard
     *  similarity fallback. Omit if none. */
    completed_subtasks?: string[];
    /** v2.2: Sub-tasks that are now blocked (cannot proceed). Same ID-or-
     *  description matching as completed_subtasks. Omit if none. */
    blocked_subtasks?: string[];
    /** v2.2: Sub-tasks the agent is canceling (no longer needed). Same ID-or-
     *  description matching as completed_subtasks. Omit if none. */
    canceled_subtasks?: string[];
    /** v2.5: Why the agent is stopping. Only meaningful when
     *  should_continue=false and success=false. Defaults to "gave_up"
     *  (current behavior) when absent. "blocked" means work cannot proceed
     *  under current constraints; "needs_human_input" requires intervention. */
    stop_reason?: "gave_up" | "blocked" | "needs_human_input";
    /** v2.12: Declared tri-state outcome. When absent, derived from success
     *  (true → "success", false → "failed"). "partial" and "blocked" can only
     *  be declared explicitly. A declared non-success outcome suppresses the
     *  success-class verification checks even when success=true (the boolean
     *  is kept for backward compatibility). */
    outcome?: RoundOutcome;
    /** v2.12: Flat blocker description, meaningful only when outcome==="blocked".
     *  Also feeds the user/agent gate classification (P2). ≤ 500 chars. */
    blocker?: string;
    /** v2.12: Retroactive claims that a PRIOR round satisfied a criterion.
     *  The runtime verifies these against the prior round's git evidence.
     *  Max 20 entries. */
    retroactiveClaims?: {
        round: number;
        claim: string;
    }[];
    /** v2.12: Declared reason for claiming success with no machine-verifiable
     *  evidence (e.g. "no code changes required — documentation-only round").
     *  Downgrades the success_without_verified_evidence check from error to
     *  info. Flat string, ≤ 200 chars. */
    no_change_reason?: string;
    /** v2.8: When the previous round's verification flagged intent_drift or
     *  subgoal_drift, the agent explains why its actions diverged from its
     *  stated plan. Populated from the self-eval block when the prompt
     *  injected the field. Empty or absent when no drift was flagged.
     *  Used by the enforcement gate R7 to distinguish intentional pivots
     *  from unacknowledged drift. */
    drift_clarification?: string;
    /** v2.9: Model's information needs for the next round's prompt.
     *  Consumed by the Compiler — not durable across rounds.
     *  Omit or leave empty if the model has no specific requests. */
    prompt_requests?: PromptRequests;
    /** v3.3: Round Contract. v3.4: a PROPOSAL for the NEXT round's contract
     *  (restated unchanged while the current one is active; a new one after
     *  it completes or blocks). Becomes the ACTIVE contract only once this
     *  round commits; it is then derived at compile time from committed
     *  rounds — see round-contract.ts. Optional. */
    round_contract?: RoundContract;
}
/** v2.12: Tri-state round outcome. Declared via SelfEvaluation.outcome;
 *  derived from `success` when absent. Shared by the dual gates, the stop
 *  mapping, and the audit view. */
export type RoundOutcome = "success" | "partial" | "failed" | "blocked";
/** v2.12: Typed cognitive state projection — runtime-derived facts shipped
 *  with advance/status outputs. All fields are derived, zero persistence.
 *  Consumers: advance output (main agent), status (human/tooling), resume
 *  handoff. The runtime provides facts; the agent decides actions. */
export interface LoopProjection {
    /** Current focus — last non-failed round's output summary. */
    focus: {
        what: string;
        since_round: number;
    } | null;
    /** Suggested next steps: agent-declared intent vs compiler-derived
     *  pending/blocked sub-goals. Non-authoritative. */
    todo: Array<{
        id: string;
        item: string;
        reason: string;
        source: "derived" | "agent_intent";
        priority: number;
    }>;
    /** Phase boundaries from milestone history. */
    phase: {
        current: string;
        label: string;
        boundaries: Array<{
            label: string;
            round: number;
        }>;
    } | null;
    /** Record view of the main agent's reported delegation state — facts
     *  only, never a task book for sub-agents. */
    delegation: {
        pending: number;
        last_results: Array<{
            agentId: string;
            outcome: string;
            round: number;
            summary: string;
        }>;
    };
    /** Handoff capsule for resume / process handover. `verified` holds
     *  cr-IDs backed by the P0 provenance layer. */
    handoff: {
        summary: string;
        verified: string[];
        open_risks: string[];
    };
}
export declare function makeLoopProjection(overrides?: Partial<LoopProjection>): LoopProjection;
/** v2.12: Structured high-risk action descriptor (internal — audit display
 *  and gate classification). The MCP surface uses a flat gate text instead. */
export interface GateActionDescriptor {
    description: string;
    scope: string[];
    effects: Array<"workspace_write" | "production" | "credentials" | "data_migration" | "public_api" | "publish" | "payment" | "external_communication" | "network">;
    reversibility: "reversible" | "recoverable" | "irreversible" | "unknown";
    authorization: "agent_allowed" | "user_required" | "unknown";
}
/** v2.12: Classified gate — user gates need human authorization, agent
 *  gates are resolved by the agent submitting verifiable evidence. */
export interface DerivedGate {
    kind: "user" | "agent";
    question?: string;
    blockedScope?: string[];
    allowedWork?: string[];
    problem?: string;
    requiredEvidence?: string[];
    suggestedResolution?: string;
}
/** v2.12: A persisted user decision for a gate. The actionHash binds the
 *  approval to the exact canonicalized action — an edited action changes
 *  the hash, so stale approvals fail the gateId match automatically. */
export interface GateDecision {
    gateId: string;
    kind: "user" | "agent";
    approved: boolean;
    scope: string[];
    note: string;
    decidedAt: string;
    actionHash: string;
}
export declare function makeGateDecision(overrides?: Partial<GateDecision>): GateDecision;
/** v2.9: Model-expressed information needs for the next round.
 *  Submitted via SelfEvaluation.prompt_requests, consumed by the
 *  Compiler when assembling the next prompt. Transient — each round's
 *  requests apply to that round only. */
export interface PromptRequests {
    /** Items to emphasize. Matched against active state via Jaccard
     *  similarity. Matching items are pulled into a "Critical Context"
     *  section rendered before optional sections. No content is added —
     *  only reordered. Max entries: policy-driven (L2: 5, L1: 3).
     *  L0: ignored. */
    emphasize?: string[];
    /** Structured sections to expand to full detail.
     *  L2: ignored (already expanded). L1: max 1 section. L0: ignored. */
    expand?: ("milestones" | "sub_goals" | "constraint_lifecycle" | "agent_trust" | "progress" | "loop_synthesis")[];
    /** Things the model is confused about. Rendered at the prompt top
     *  as "Confusion Alerts" before the Objective section. Compiler
     *  auto-matches each entry against state sections and provides
     *  pointers. Max 3 entries, each ≤ 200 chars. L0: ignored. */
    confusion_points?: string[];
}
/** v2.1: Milestone summary — a phase-boundary snapshot that survives
 *  rolling-window eviction. Triggered by three signals in priority order:
 *
 *  1. agent_declared    — compression_checkpoint === true (agent marks phase complete)
 *  2. criteria_milestone — new success_criteria_met detected (semantic dedup)
 *  3. auto              — safety net after N rounds without a milestone
 *
 *  Built from raw round data in vault entries — no new persistent storage.
 *  Rendered in L2 prompts and always written to the state file. */
export interface MilestoneSummary {
    /** Human-readable label. Examples:
     *  agent_declared: agent's checkpoint_label or "Round 15"
     *  criteria_milestone: "Completed: unit tests ≥ 90%"
     *  auto: "Rounds 1–20" */
    label: string;
    /** Which rounds this milestone covers (inclusive). */
    round_range: {
        start: number;
        end: number;
    };
    /** Compressed outcome: what was accomplished in this phase. */
    outcome: string;
    /** Constraints that were active when this milestone was created. */
    carried_constraints: string[];
    /** Constraints resolved during this phase. */
    resolved_constraints: string[];
    /** Agent's progress_estimate at the milestone boundary. */
    progress_at_boundary: number;
    /** How this milestone was created. */
    kind: "agent_declared" | "criteria_milestone" | "auto";
    /** The round number when this milestone was created. */
    generated_at_round: number;
}
export declare function makeMilestoneSummary(overrides?: Partial<MilestoneSummary>): MilestoneSummary;
/** A single sub-agent / Worker delegation result (v1.9 — multi-agent). */
export interface WorkerResult {
    agentId: string;
    subAgentType: string;
    subTask: string;
    resultSummary: string;
    success: boolean;
    /** v2.12: Declared worker outcome. When absent, derived from success
     *  (true → "success", false → "failed"). "partial" is explicit only. */
    outcome?: "success" | "partial" | "failed";
    discoveredConstraints?: string[];
}
export declare function makeSelfEvaluation(overrides?: Partial<SelfEvaluation>): SelfEvaluation;
/** Regex to extract a self-evaluation JSON block from agent output. */
export declare const SELF_EVAL_REGEX: RegExp;
export interface LoopForgeRequest {
    task: string;
    mode: Mode;
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
/** v3.2: Derived per-criterion status for the progress dashboard — the
 *  "goal → criteria → evidence" vertical view. Zero persistence: derived from
 *  vault entries each round (met/remaining reports + Jaccard sub-goal links). */
export interface CriterionStatus {
    /** Stable ID derived from the criterion text (cr-XXXXXXXX). */
    id: string;
    /** The criterion text as declared in the objective. */
    text: string;
    status: "met" | "remaining" | "unknown";
    /** Round when the criterion was first reported met (machine-backed). */
    met_at_round?: number;
    /** Sub-goals whose description matches this criterion (Jaccard). */
    related_subgoal_ids: string[];
}
export declare function makeCriterionStatus(overrides?: Partial<CriterionStatus>): CriterionStatus;
/** v3.2: A deterministic "lesson learned" — a constraint or verification
 *  check that failed repeatedly across rounds. Rendered in the prompt to
 *  immunize the agent against repeating the same mistakes. Zero persistence:
 *  derived from vault entries each round; presentation only — never feeds
 *  the enforcement gate's decisions. */
export interface Lesson {
    /** Constraint text or verification check name. */
    text: string;
    kind: "constraint_violation" | "verification_error" | "verification_warning";
    /** How many rounds this lesson occurred in. */
    count: number;
    /** The rounds it occurred in, ascending. */
    rounds: number[];
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
    /** v2.1: Phase-boundary milestone summaries that survive rolling-window
     *  eviction. Accumulated across all rounds from three trigger signals
     *  (agent_declared > criteria_milestone > auto). Rendered in L2 prompts
     *  and always written to the state file. */
    milestones?: MilestoneSummary[];
    /** v2.1: Single-paragraph structural synthesis of the entire loop.
     *  Generated at L2 level. Formulaic, not NLP. Contains round count,
     *  phase count, overall progress, and active constraint summary. */
    loop_synthesis?: string;
}
export declare function makeRollingSummary(overrides?: Partial<RollingSummary>): RollingSummary;
/** v2.2: A structured sub-goal tracked by the compiler across rounds.
 *  Declared by the agent via emerged_subtasks (string[]), managed by
 *  the compiler with derived status. Never creates sub-loops — the
 *  agent still owns execution; the compiler only tracks state. */
export interface SubGoal {
    /** Stable identifier derived from description hash (sg-XXXXXXXX). */
    id: string;
    /** Agent-declared description, deduplicated by similarity. */
    description: string;
    /** Compiler-derived status. */
    status: "pending" | "in_progress" | "done" | "blocked" | "canceled";
    /** Round when the agent first declared this sub-goal. */
    declared_at_round: number;
    /** Round of the last status change. */
    status_changed_at_round: number;
    /** Round when completed (only for done status). */
    completed_at_round?: number;
    /** Priority hint: 0 = highest. Derived from declaration order. */
    priority: number;
}
export declare function makeSubGoal(overrides?: Partial<SubGoal>): SubGoal;
/** v2.3: Per-constraint lifecycle metadata derived by the compiler.
 *  Reconstructed each round from vault entries — no new persistence.
 *  Discovered constraints without violations for N rounds are demoted
 *  to inactive; hard/plan/criteria constraints never auto-decay. */
export interface ConstraintMeta {
    /** v2.11: Stable identifier derived from text hash (c-XXXXXXXX).
     *  Enables exact ID-first matching by the agent and compiler.
     *  Eliminates Jaccard false positives/negatives. */
    id: string;
    /** Normalized constraint text (the key). */
    text: string;
    /** Which round this constraint was first discovered/added. */
    discovered_at_round: number;
    /** Which round this constraint was last violated by the agent.
     *  0 if never violated. */
    last_violated_at_round: number;
    /** Origin — determines whether auto-decay applies. */
    source: "hard" | "plan" | "criteria" | "discovered";
    /** Compiler-derived status. Inactive constraints are removed from
     *  prompts but kept in the state file. */
    status: "active" | "inactive";
}
export declare function makeConstraintMeta(overrides?: Partial<ConstraintMeta>): ConstraintMeta;
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
    /** v1.16: Agent's declared next action for the following round. */
    next_action?: string;
    /** v2.2: Sub-tasks completed this round. */
    completed_subtasks?: string[];
    /** v2.2: Sub-tasks blocked this round. */
    blocked_subtasks?: string[];
    /** v2.2: Sub-tasks canceled this round. */
    canceled_subtasks?: string[];
    /** v2.8: Agent's explanation for intent/subgoal drift detected in
     *  the previous round. Carried forward from SelfEvaluation. */
    drift_clarification?: string;
    /** v2.9: Model's information needs for the next round's prompt.
     *  Carried forward from SelfEvaluation. Consumed by the Compiler. */
    prompt_requests?: PromptRequests;
    /** v2.12: Declared tri-state outcome. Carried forward from SelfEvaluation. */
    outcome?: RoundOutcome;
    /** v2.12: Flat blocker description (outcome==="blocked" only). */
    blocker?: string;
    /** v2.12: Retroactive claims against prior rounds. */
    retroactiveClaims?: {
        round: number;
        claim: string;
    }[];
    /** v2.12: Declared reason for success without machine evidence.
     *  Carried forward from SelfEvaluation. */
    no_change_reason?: string;
    /** v3.3: Round Contract. v3.4: LEGACY — never populated since v3.4
     *  (buildLoopRequest no longer forwards it). The ACTIVE contract is
     *  derived from committed rounds at compile time; reading this field as a
     *  contract source reintroduces the second truth the derivation replaced. */
    round_contract?: RoundContract;
}
export declare function makeRoundContract(overrides?: Partial<RoundContract>): RoundContract;
export declare function makeLoopRoundResult(overrides?: Partial<LoopRoundResult>): LoopRoundResult;
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
    /** Optional context supplied explicitly by the embedding Agent. */
    external_context?: string;
    /** Maximum rounds for this loop. Used by the state file header to show
     *  accurate progress (Round X / Y). Falls back to max_summary_rounds * 2
     *  when not provided (callers that don't track maxRounds). */
    max_rounds?: number;
    /** Verification findings from the previous attempt. Prompt compilation uses
     *  these to select a rehydrate view and render the gate findings exactly
     *  once as part of the final prompt. */
    verification_flags?: VerificationFlag[];
    /** One-based attempt within the same logical round. Enforcement rejection
     * increments this without advancing `round`. */
    attempt: number;
    /** Consecutive zero-commit enforcement rejections for this round. */
    consecutive_rejections: number;
    /** Structured enforcement feedback rendered into retry prompts. */
    rejection_notice: string;
}
export declare function makeLoopCompileRequest(overrides?: Partial<LoopCompileRequest>): LoopCompileRequest;
/** Immutable record of the exact prompt delivered for one round attempt. */
export interface PromptArtifact {
    schemaVersion: 1;
    roundId: string;
    attempt: number;
    level: "l0" | "l1" | "l2";
    levelReasons: string[];
    renderedPrompt: string;
    promptHash: string;
    stateHash: string;
    basePromptVersion: string;
    includedSections: string[];
    budgetChars: number;
    charCount: number;
    budgetExceeded: boolean;
    generatedAt: number;
    /** v3.2: What the rendered prompt actually presented (L1 only). Persisted
     *  on the lineage entry as the diff baseline for L1 collapse. Absent for
     *  L0/L2 compiles. */
    presentedState?: PresentedStateSnapshot;
}
export interface LoopCompileResponse {
    status: AgentStatus;
    prompt: string;
    recompile_level: string;
    diff_from_previous: string;
    lineage: string[];
    constraints_active: string[];
    constraints_retired: string[];
    loop_id: string;
    round: number;
    goal_id: string;
    goal_text_hash: string;
    loop_objective: LoopObjective | null;
    loop_health: LoopHealth | null;
    task_alignment: TaskAlignment | null;
    rolling_summary: RollingSummary | null;
    /** v2.2: Structured sub-goals tracked across rounds. Compiler-managed
     *  lifecycle with derived status. Rendered as Sub-Goal Dashboard. */
    sub_goals?: SubGoal[];
    /** v2.3: Constraints demoted to inactive after prolonged inactivity.
     *  Removed from prompts; kept in state file. Auto-reactivated on violation. */
    constraints_inactive?: string[];
    /** v2.3: Per-constraint lifecycle metadata for state file rendering. */
    constraint_metadata?: ConstraintMeta[];
    /** v2.5: Current round's agent trust score [0, 1]. Derived from verification
     *  flags: -0.15 per error, -0.03 per warn. Always 1.0 for round 1. */
    agent_trust_score?: number;
    /** v2.5: Trust scores from the last 10 rounds, newest last. Empty for
     *  round 1. Reconstructed from vault entries — zero new persistence. */
    agent_trust_trend?: number[];
    /** v3.2: Derived per-criterion status (goal → criteria → evidence view).
     *  Zero persistence — re-derived from vault entries each round. */
    criterion_statuses?: CriterionStatus[];
    /** v3.2: Deterministic lessons learned (repeated violations / repeated
     *  verification failures). Presentation only — never feeds enforcement. */
    lessons?: Lesson[];
    suggested_next_task: string;
    plan_source: string | null;
    warnings: string[];
    error: string;
    /** v1.14: Content for the loop state file. Written by the caller
     *  (SessionManager or Runtime) to .loopforge/state/{loopId}-state.md.
     *  Present on every level when `state_file.enabled` (default true) —
     *  L0/L1/L2 all render it. Undefined only when the state file is
     *  disabled or the compile produced no prompt. */
    state_file_content?: string;
    /** Exact, hashed prompt record used by transaction replay and audit. */
    prompt_artifact?: PromptArtifact;
}
export declare function makeLoopCompileResponse(overrides?: Partial<LoopCompileResponse>): LoopCompileResponse;
/** Aggregated evidence snapshot for the state file Evidence section.
 *  Four categories give the agent a clear picture of what's been confirmed,
 *  what remains, what was wrong, and what's newly discovered — all derived
 *  from accumulated SelfEvaluation data across rounds. */
export interface EvidenceSnapshot {
    /** Criteria met + successful outcomes confirmed across rounds. */
    verified: string[];
    /** Criteria still unmet — work remaining. */
    pending: string[];
    /** Wrong assumptions + retracted constraints — things we were wrong about. */
    invalidated: string[];
    /** New constraints + emerged subtasks discovered this round. */
    discovered: string[];
}
export declare function makeEvidenceSnapshot(overrides?: Partial<EvidenceSnapshot>): EvidenceSnapshot;
export interface LoopForgeResponse {
    status: AgentStatus;
    prompt: string | null;
    error: string | null;
    /** v1.14: State file content from the compiler. Written to disk by the caller. */
    state_file_content?: string;
    /** Exact prompt artifact produced by the compiler. */
    prompt_artifact?: PromptArtifact;
    /** Structured warnings from the compiler — preferred over parsing prompt text. */
    warnings?: string[];
    /** v2.12: Compiler-derived state passed through for typed projections
     *  (zero extra persistence — derived fresh each compile). */
    rolling_summary?: RollingSummary | null;
    sub_goals?: SubGoal[];
    suggested_next_task?: string;
}
export interface SessionState {
    task_id: string;
    call_count: number;
    success_trend: boolean[];
    current_version: string;
    feedback_buffer: Record<string, unknown>[];
}
export declare function makeSessionState(taskId: string): SessionState;
export interface AgentLoopResult {
    status: AgentStatus;
    response: LoopForgeResponse | null;
}
/** Why a loop stopped. Used by MCP session and vault persistence.
 *  `completed` requires both success=true and should_continue=false.
 *  `failed` is success=false + should_continue=false (agent gave up).
 *  `cancelled` is manual stop via loopforge_stop.
 *  Legacy aliases (backward-compat): `task_complete` → `completed`, `stopped` → `cancelled`. */
export type StopReason = "completed" | "failed" | "blocked" | "cancelled" | "max_rounds" | "circuit_breaker" | "stalled" | "executor_failure" | "enforcement_terminated"
/** v1.18: Loop was paused by user or signal. */
 | "paused" | "task_complete" | "stopped";
/** Result of round-boundary enforcement. Decides whether to accept the round,
 *  reject it (force the agent to redo the SAME round), or terminate the loop.
 *
 *  accept:    round passes; proceed to next round as normal.
 *  reject:    agent's self-evaluation or output is invalid; the agent receives
 *             a rejection prompt and must redo the same round. Round counter
 *             does NOT increment.
 *  terminate: loop has reached an unrecoverable state; stop immediately with
 *             stopReason "enforcement_terminated". */
export interface EnforcementResult {
    action: "accept" | "reject" | "terminate" | "backtrack";
    /** Human-readable reason for the enforcement decision. */
    reason: string;
    /** For reject: concrete instructions the agent must follow.
     *  Empty for accept and terminate. */
    fix_instructions: string;
    /** Which enforcement rule fired. Empty for accept.
     *  Used by callers to track consecutive rejections per-rule
     *  so unrelated rejections don't accumulate toward the max. */
    check?: string;
    /** v2.12: True when the enforcement gate accepted the round via
     *  drift_clarification waiver (R7). The caller uses this to track
     *  clarification streaks independently of rejection streaks. */
    clarification_accepted?: boolean;
}
export declare function makeEnforcementResult(overrides?: Partial<EnforcementResult>): EnforcementResult;
/** Context supplied to an embedding-owned provider before compilation. */
export interface ExternalContextRequest {
    loopId: string;
    round: number;
    task: string;
    domain: string;
    /** The previously accepted evaluation, when one exists. */
    lastEvaluation?: SelfEvaluation;
}
export type ExternalContextProvider = (request: ExternalContextRequest) => Promise<string>;
export interface LoopTerminalEvent {
    success: boolean;
    stopReason: StopReason;
    roundsCompleted: number;
    successTrajectory: boolean[];
    loopId: string;
    task: string;
    lastEvaluation?: SelfEvaluation;
}
export type LoopTerminalSink = (event: LoopTerminalEvent) => Promise<void> | void;
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
export declare function makeTaskId(taskDescription: string): string;
//# sourceMappingURL=protocol.d.ts.map