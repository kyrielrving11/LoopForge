/** LoopForge-loop_compile — TypeScript protocol definitions.
 *
 * All types exchanged between the Main Agent and LoopForge flow through
 * these interfaces. This is the contract layer — no implementation logic.
 * The generated JSON Schema in `loopforge-protocol.json` is the complete,
 * machine-readable wire contract; `$defs` is the authoritative type set.
 */
// ── Enums ──────────────────────────────────────────────────────────────────
// Type-only import — erased at runtime, no dependency cycle with
// canonical-state.ts (which imports protocol.ts for its types).
export var AgentStatus;
(function (AgentStatus) {
    AgentStatus["OK"] = "ok";
    AgentStatus["ERROR"] = "error";
    AgentStatus["STALLED"] = "stalled";
})(AgentStatus || (AgentStatus = {}));
/** v4.0.3: the checkpoint manifest version. The wire type, the store and the
 *  restore preflight all read this ONE constant. */
export const CHECKPOINT_SCHEMA_VERSION = 1;
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
/** v3.9.2: The machine boundary the agent's files_changed report is compared
 *  against. Receipt-only; never persisted, never next-prompt input. */
export const FILES_RECONCILIATION_SCOPE = "tracked_and_non_ignored_untracked";
export function makeSelfEvaluation(overrides = {}) {
    return {
        success: false,
        output_summary: "",
        constraint_violations: [],
        should_continue: true,
        discovered_constraints: [],
        emerged_subtasks: [],
        subgoal_updates: [],
        execution_report: undefined,
        retracted_constraints: [],
        wrong_assumptions: [],
        open_questions: [],
        resolved_open_question_ids: [],
        worker_results: [],
        subtask_boundary: false,
        subtask_boundary_label: "",
        agent_stop_reason: undefined,
        outcome: undefined,
        blocker: undefined,
        retroactiveClaims: [],
        no_change_reason: undefined,
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
        ...overrides,
    };
}
/** The operator acceptance carried by a committed transaction is the same
 *  immutable surface the compiler used to derive the objective. */
export function operatorAcceptanceFromObjective(objective) {
    return {
        task: objective.objective,
        success_criteria: [...objective.success_criteria],
        hard_constraints: [...objective.hard_constraints],
    };
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
        agentSuccessClaim: false,
        output_summary: "",
        constraint_violations: [],
        discovered_constraints: [],
        emerged_subtasks: [],
        subgoal_updates: [],
        execution_report: undefined,
        retracted_constraints: [],
        wrong_assumptions: [],
        open_questions: [],
        resolved_open_question_ids: [],
        worker_results: [],
        subtask_boundary: false,
        subtask_boundary_label: "",
        agentOutcome: undefined,
        blocker: undefined,
        retroactiveClaims: [],
        no_change_reason: undefined,
        ...overrides,
    };
}
export function makeLoopCompileRequest(overrides = {}) {
    return {
        loop_id: "",
        round: 1,
        goal_id: "",
        task: "",
        loop_objective: null,
        plan_source: null,
        constraints_from_plan: [],
        force_level: "auto",
        verification_flags: [],
        attempt: 1,
        consecutive_rejections: 0,
        rejection_notice: "",
        ...overrides,
    };
}
/** v3.8.1: the artifact schema version lives next to the type it versions.
 *  The transaction envelope parser reads it, so the constant lives here rather
 *  than in the renderer.
 *
 *  v4.0.1: schema 7 removes the prompt-request effects. v4.0.2: schema 8 adds
 *  the derived context boundary and the optional Working Memory projection.
 *  v4.0.3: schema 9 adds the expanded Working Memory audit metadata. The
 *  Machine Evidence projection is rendered INTO the prompt text, not carried as
 *  a separate artifact field; the committed posture lives on the transaction
 *  result. v4.0.4: schema 10 renames the clean-context `contextMode` value to
 *  `fresh_invocation`. Older versions are a HARD break — a round whose
 *  artifact does not parse is not committed history, and
 *  `legacyTransactionRounds` reports the loss rather than letting it vanish. */
export const PROMPT_ARTIFACT_SCHEMA_VERSION = 11;
export function makeLoopCompileResponse(overrides = {}) {
    return {
        status: AgentStatus.OK,
        prompt: "",
        recompile_level: "l2",
        constraints_active: [],
        constraints_retired: [],
        loop_id: "",
        round: 0,
        goal_id: "",
        loop_objective: null,
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
        machineBackedSuccess: false,
        ...overrides,
    };
}
export function makeExecutionReport(overrides = {}) {
    return {
        files_changed: [],
        tests_reported: null,
        criterion_claims: [],
        contract_item_claims: [],
        ...overrides,
    };
}
/** v3.9.1: the Git observation's data schema. Version 1 was the
 *  dirty-files-only shape; version 2 is the complete workspace boundary. */
export const GIT_OBSERVATION_SCHEMA_VERSION = 2;
// ── Factory helpers ─────────────────────────────────────────────────────────
//# sourceMappingURL=protocol.js.map