/** Internal TypeScript contracts shared by the compiler, workflow runtime,
 * evidence gates, and supported public protocol types. */
export declare enum Mode {
    LOOP_COMPILE = "loop_compile"
}
export declare enum AgentStatus {
    OK = "ok",
    ERROR = "error",
    STALLED = "stalled"
}
export type WorkflowPhase = "planning" | "awaiting_approval" | "executing" | "auditing" | "terminal";
/** Controls when a user must approve a plan revision. High-risk revisions
 * always require approval regardless of this setting. */
export type ApprovalPolicy = "risk_only" | "every_revision";
export type PlanningProfile = "minimal" | "full";
export type PlanChangeImpact = "none" | "tactical" | "contract" | "risk";
export interface PlanChangeAssessment {
    impact: PlanChangeImpact;
    changedPaths: string[];
    reasons: string[];
}
export type PlanDiagnosticCode = "unknown_dependency" | "dependency_cycle" | "uncovered_success_criterion" | "uncovered_constraint" | "missing_acceptance" | "missing_evidence_requirement" | "invalid_refinement" | "stale_plan_version" | "completed_step_mutation" | "risk_tag_not_inherited" | "no_ready_step";
export interface PlanDiagnostic {
    code: PlanDiagnosticCode;
    severity: "error" | "warning";
    path: string;
    stepId?: string;
    relatedStepId?: string;
    message: string;
    repairHint: string;
}
export declare function isApprovalPolicy(value: unknown): value is ApprovalPolicy;
export type RequiredAction = "submit_plan" | "approve_plan" | "execute_prompt" | "resubmit_round" | "restore_workspace" | "refine_plan" | "execute_audit" | "none";
export type PlanRiskTag = "destructive_workspace" | "data_migration" | "production_change" | "credentials_or_permissions" | "external_side_effect" | "public_api_break";
export type PlanStepKind = "executable" | "outline" | "external_gate";
export type PlanStepStatus = "pending" | "ready" | "active" | "done" | "blocked" | "canceled";
export type EvaluationStepStatus = "completed" | "blocked" | "in_progress";
export type EvidenceConfidence = "verified" | "claimed" | "unavailable" | "contradicted";
export type WorkflowReadiness = "planning" | "awaiting_approval" | "executing" | "blocked" | "awaiting_external_gate" | "ready_for_audit" | "auditing" | "completed";
export interface RoundCheckReport {
    name: string;
    status: "passed" | "failed" | "not_run";
    summary?: string;
    counts?: {
        passed: number;
        failed: number;
        skipped: number;
    };
}
export interface RoundEvidenceClaim {
    targetId: string;
    evidenceRefs: string[];
}
export interface AgentEvidenceReport {
    files?: string[];
    checks?: RoundCheckReport[];
    claims?: RoundEvidenceClaim[];
    noChangeReason?: string;
}
export interface RoundBlocker {
    kind: "dependency" | "external" | "needs_human_input" | "plan_change";
    reason: string;
    references?: string[];
}
export interface RoundDiscoveries {
    wrongAssumptions?: string[];
    emergedWork?: string[];
    facts?: string[];
    newConstraints?: string[];
}
export interface PlanChangeRequest {
    timing: "before_continue" | "next_boundary";
    reason: string;
    affectedIds: string[];
}
/** Compact v3 report authored by the external Agent. */
export interface RoundReportV1 {
    status: EvaluationStepStatus;
    summary: string;
    violations?: string[];
    evidence?: AgentEvidenceReport;
    blocker?: RoundBlocker;
    discoveries?: RoundDiscoveries;
    planChangeRequest?: PlanChangeRequest;
    delegations?: WorkerResult[];
    contextRequest?: ContextRequest;
}
export interface NormalizedEvidenceItem<T> {
    value: T;
    confidence: EvidenceConfidence;
    source: "agent" | "git" | "command" | "provider" | "derived";
}
/** Runtime-normalized evidence persisted with an accepted/rejected attempt. */
export interface RoundEvidenceEnvelope {
    files: NormalizedEvidenceItem<string[]>;
    /** Runtime Git identity for the current dirty file set. Used to distinguish
     *  repeated path names from actual content movement across rounds. */
    fileFingerprints?: Record<string, string>;
    checks: NormalizedEvidenceItem<RoundCheckReport[]>;
    claims: RoundEvidenceClaim[];
    noChangeReason: string | null;
    providerNames: string[];
    /** Per-check provenance; optional for pre-P1 persisted envelopes. */
    checkProvenance?: Record<string, {
        confidence: EvidenceConfidence;
        source: "agent" | "git" | "command" | "provider" | "derived";
        provider?: string;
    }>;
    /** Provider claims are explicit bindings, never inferred from provider names. */
    providerClaims?: Record<string, string[]>;
    contradictions: string[];
}
export interface NormalizedRoundEvaluation {
    reportVersion: 1;
    phase: "executing" | "auditing";
    activeStepId: string | null;
    report: RoundReportV1;
    evidenceEnvelope: RoundEvidenceEnvelope;
    materialAdvancement?: {
        material: boolean;
        signals: string[];
        stepId?: string;
    };
    /** Server-derived obligations required for this completed report. */
    requiredRegressionObligationIds?: string[];
}
export interface MaterialAdvancementRecord {
    round: number;
    stepId: string | null;
    planVersion: number | null;
    material: boolean;
    signals: string[];
}
export interface ExternalGateBlock {
    stepId: string;
    planVersion: number;
    evidenceRequirements: string[];
    blockedAt: string;
}
export interface GateResolution {
    planVersion: number;
    stepId: string;
    summary: string;
    evidenceReferences: string[];
}
export interface WorkflowProgress {
    planVersion: number | null;
    planSteps: {
        total: number;
        done: number;
        active: number;
        pending: number;
        blocked: number;
        canceled: number;
    };
    outlineRemaining: number;
    successCriteria: {
        total: number;
        covered: number;
        provisionallyMet: number;
        auditVerified: number;
        remaining: number;
    };
    externalGates: {
        total: number;
        satisfied: number;
        pending: number;
        blocked: number;
    };
    readiness: WorkflowReadiness;
}
export interface CapabilityPreflight {
    serverVersion: string;
    reportContract: "round_report_v1";
    toolCount: number;
    workspaceBound: boolean;
    storeWritable: boolean;
    gitEvidence: "available" | "disabled" | "unavailable";
    commandEvidence: "configured" | "blocked" | "disabled";
    warnings: string[];
}
export type RoundPromptMode = "step_start" | "step_continue" | "step_retry" | "refine_plan" | "audit";
export interface ReportClaimTarget {
    id: string;
    text: string;
    kind: "acceptance" | "evidence" | "success_criterion" | "regression_obligation";
}
export interface RegressionObligation {
    id: string;
    sourceStepId: string;
    sourcePlanVersion: number;
    checkName: string;
    claimId: string;
    lastStatus: "verified" | "contradicted" | "unavailable";
    lastVerifiedRound: number | null;
    latestEvidenceRef: string | null;
}
export interface PlanStep {
    id: string;
    title: string;
    kind: PlanStepKind;
    dependsOn: string[];
    scope: string[];
    successCriteria: string[];
    constraints: string[];
    acceptanceCriteria: string[];
    evidenceRequirements: string[];
    refinement: "outline" | "executable";
    riskTags: PlanRiskTag[];
    status: PlanStepStatus;
    /** Previous-version outline expanded by this newly introduced step. */
    refinesStepId?: string;
}
export interface StructuredPlan {
    objective: string;
    successCriteria: string[];
    constraints: string[];
    steps: PlanStep[];
}
export interface PlanApprovalRecord {
    approvalId: string;
    planVersion: number;
    decision: "approved" | "rejected";
    decidedAt: string;
    reason: string;
}
export interface PlanRevisionRecord {
    version: number;
    baseVersion: number | null;
    reason: string;
    changeSummary: string;
    evidenceReferences: string[];
    submittedAt: string;
    effectiveRound: number;
    plan: StructuredPlan;
    /** Server-derived lineage from replaced outline nodes to their children. */
    refinementLinks: Array<{
        sourceStepId: string;
        childStepIds: string[];
    }>;
    /** Server-derived change classification; never accepted from Agent input. */
    changeImpact: PlanChangeImpact;
    changedPaths: string[];
}
export interface GraphSliceSummary {
    planVersion: number | null;
    activeStepId: string | null;
    parentOutlineId: string | null;
    dependencyStepIds: string[];
    dependencySummaries: string[];
    relevantConstraintIds: string[];
    requiredClaimIds: string[];
    uncoveredClaimIds: string[];
    priorAttemptSummary: string | null;
    blockedDescendantCount: number;
    regressionGapIds: string[];
}
export interface WorkflowState {
    phase: WorkflowPhase;
    approvalPolicy: ApprovalPolicy;
    planningProfile: PlanningProfile;
    planVersion: number | null;
    plan: StructuredPlan | null;
    revisions: PlanRevisionRecord[];
    approvalId: string | null;
    approvalHistory: PlanApprovalRecord[];
    activeStepId: string | null;
    planningPrompt: string | null;
    planSource: string | null;
    /** Immutable constraints supplied when the session was started. */
    baselineConstraints: string[];
    /** v3 P1: accepted discoveries waiting for a versioned plan update. */
    pendingPlanChange: PlanChangeRequest | null;
    /** v3 P1: plan change requested after the active step reaches a boundary. */
    queuedPlanChange: PlanChangeRequest | null;
    /** v3 P1: success criteria verified by the accepted final audit. */
    auditVerifiedCriteria: string[];
    /** v3 P1: terminal external gate that may be resumed with evidence. */
    blockingGate: ExternalGateBlock | null;
    /** v3 P1: material evidence movement used instead of subjective progress. */
    advancementHistory: MaterialAdvancementRecord[];
}
/** Process-level workspace/store identity used by the MCP runtime. */
export interface WorkspaceRuntimeSummary {
    serverVersion: string;
    bindingStatus: "unbound" | "bound" | "mismatch";
    workspaceId: string | null;
    workspaceRoot: string | null;
    workspaceFingerprint: string | null;
    storeId: string | null;
    storeRoot: string | null;
    bindingSource: "explicit" | "git_root" | "cwd_legacy" | null;
}
export interface WorkspaceBinding {
    schemaVersion: 1;
    workspaceId: string;
    workspaceRoot: string;
    workspaceFingerprint: string;
    storeId: string;
    storeRoot: string;
    previousStoreRoots: string[];
    boundAt: string;
}
export interface StoreResolutionDiagnostic {
    code: "session_not_found" | "session_version_unsupported" | "workspace_mismatch" | "session_corrupt" | "store_incomplete" | "orphan_markdown" | "ambiguous_loop" | "store_unreadable";
    current: WorkspaceRuntimeSummary;
    searchedStores: Array<{
        storeRoot: string;
        storeId: string;
        exists: boolean;
        stale?: boolean;
    }>;
    matches: Array<{
        storeRoot: string;
        loopId: string;
        workspaceId?: string | null;
    }>;
    orphanMarkdownPaths: string[];
    recommendation: {
        action: "retry_resume" | "restart_mcp" | "inspect_store" | "restore_json" | "start_new_loop";
        toolCall?: {
            name: "loopforge_resume";
            arguments: Record<string, unknown>;
        };
        command?: {
            executable: string;
            args: string[];
            display: string;
        };
    } | null;
    warnings: string[];
}
export interface LoopForgeRequest {
    task: string;
    mode: Mode;
    [key: string]: unknown;
}
export interface LoopObjective {
    objective: string;
    success_criteria: string[];
    hard_constraints: string[];
    created_at_round: number;
    loop_id: string;
    version?: number;
    refinement_history?: string[];
}
export declare function makeLoopObjective(overrides?: Partial<LoopObjective>): LoopObjective;
/** One-shot context request applied only to the immediately following prompt. */
export interface ContextRequest {
    /** State items to emphasize in the immediately following prompt. */
    emphasize?: string[];
    /** Specific uncertainties to surface in the immediately following prompt. */
    confusion_points?: string[];
}
/** A phase-boundary summary derived from workflow events. */
export interface MilestoneSummary {
    label: string;
    round_range: {
        start: number;
        end: number;
    };
    outcome: string;
    carried_constraints: string[];
    resolved_constraints: string[];
    kind: "step_boundary" | "plan_refinement" | "backtrack" | "audit" | "auto";
    generated_at_round: number;
}
export declare function makeMilestoneSummary(overrides?: Partial<MilestoneSummary>): MilestoneSummary;
/** Compact history projection derived from accepted v3 reports and workflow events. */
export interface ExecutionHistorySummary {
    recentOutcomes: string[];
    blockedOutcomes: string[];
    roundsSampled: number;
    latestRound: number;
    milestones: MilestoneSummary[];
    synthesis: string;
}
export declare function makeExecutionHistorySummary(overrides?: Partial<ExecutionHistorySummary>): ExecutionHistorySummary;
export interface WorkerResult {
    agentId: string;
    subAgentType: string;
    subTask: string;
    resultSummary: string;
    success: boolean;
    discoveredConstraints?: string[];
}
/** Per-constraint lifecycle metadata derived from approved plan revisions. */
export interface ConstraintMeta {
    id: string;
    text: string;
    discovered_at_round: number;
    last_violated_at_round: number;
    source: "hard" | "plan" | "criteria";
    status: "active" | "retired";
}
export declare function makeConstraintMeta(overrides?: Partial<ConstraintMeta>): ConstraintMeta;
export interface RoundHistoryEntry {
    round: number;
    status: EvaluationStepStatus;
    summary: string;
    violations: string[];
    evidenceEnvelope: RoundEvidenceEnvelope;
    discoveries?: RoundDiscoveries;
    delegations?: WorkerResult[];
    contextRequest?: ContextRequest;
    materialAdvancement?: {
        material: boolean;
        signals: string[];
        stepId?: string;
    };
}
export declare function makeRoundHistoryEntry(overrides?: Partial<RoundHistoryEntry>): RoundHistoryEntry;
/** Typed, server-derived work assignment consumed by the prompt compiler. */
export interface PromptCompilationContext {
    planVersion: number | null;
    promptMode: RoundPromptMode;
    activeStep: PlanStep | null;
    objective: string;
    successCriteria: string[];
    claimTargets: ReportClaimTarget[];
    evidenceGaps: ReportClaimTarget[];
    failedChecks: RoundCheckReport[];
    instruction: string;
}
export interface LoopCompileRequest {
    mode: Mode;
    loop_id: string;
    round: number;
    /** Branch-aware transaction identity. Stable across retries of one attempt chain. */
    round_id?: string;
    goal_id: string;
    task: string;
    domain: string;
    loop_objective: LoopObjective | null;
    compilation_context: PromptCompilationContext | null;
    /** True only when the plan was created or revised for this prompt. */
    plan_boundary?: boolean;
    constraints_from_plan: string[];
    new_since_last_round: string;
    last_evaluation: RoundHistoryEntry | null;
    force_level: string;
    /** Optional context supplied explicitly by the embedding Agent. */
    external_context?: string;
    /** Maximum rounds for this loop, used by prompt and state projections. */
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
    /** v3 P1: enables the compact MCP round report prompt contract. */
    report_contract?: "round_report_v1";
    /** Server-derived prompt mode; retry attempts override this to step_retry. */
    report_mode?: RoundPromptMode;
    /** Exact claim IDs the current step or audit must prove. */
    report_claim_targets?: ReportClaimTarget[];
    /** Server-derived active-step graph neighborhood; never Agent-authored. */
    graph_slice?: GraphSliceSummary;
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
}
export interface LoopCompileResponse {
    status: AgentStatus;
    prompt: string;
    recompile_level: string;
    diff_from_previous: string;
    lineage: string[];
    constraints_active: string[];
    loop_id: string;
    round: number;
    goal_id: string;
    goal_text_hash: string;
    loop_objective: LoopObjective | null;
    executionHistory: ExecutionHistorySummary;
    /** Per-constraint lifecycle metadata derived from approved plan revisions. */
    constraint_metadata?: ConstraintMeta[];
    warnings: string[];
    error: string;
    /** v1.14: Content for the loop state file. Written by the caller
     *  (SessionManager or Runtime) to .loopforge/state/{loopId}-state.md.
     * Undefined for L0/L1 compilations; only L2 produces state file content. */
    state_file_content?: string;
    /** Exact, hashed prompt record used by transaction replay and audit. */
    prompt_artifact?: PromptArtifact;
}
export declare function makeLoopCompileResponse(overrides?: Partial<LoopCompileResponse>): LoopCompileResponse;
export interface LoopForgeResponse {
    status: AgentStatus;
    prompt: string | null;
    error: string | null;
    /** v1.14: State file content from the compiler. Written to disk by the caller. */
    state_file_content?: string;
    /** Exact prompt artifact produced by the compiler. */
    prompt_artifact?: PromptArtifact;
    /** Structured warnings from the compiler, preferred over prompt parsing. */
    warnings?: string[];
}
export interface AgentLoopResult {
    status: AgentStatus;
    response: LoopForgeResponse | null;
}
/** Why a loop stopped. */
export type StopReason = "completed" | "failed" | "blocked" | "cancelled" | "max_rounds" | "circuit_breaker" | "stalled" | "executor_failure" | "enforcement_terminated" | "paused";
/** Result of round-boundary enforcement. Decides whether to accept the round,
 *  reject it (force the agent to redo the SAME round), or terminate the loop.
 *
 *  accept:    round passes; proceed to next round as normal.
 *  reject:    the normalized report or evidence is invalid; the agent receives
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
}
export declare function makeEnforcementResult(overrides?: Partial<EnforcementResult>): EnforcementResult;
/** Context supplied to an embedding-owned provider before compilation. */
export interface ExternalContextRequest {
    loopId: string;
    round: number;
    task: string;
    domain: string;
    /** The previously accepted evaluation, when one exists. */
    lastEvaluation?: NormalizedRoundEvaluation;
}
export type ExternalContextProvider = (request: ExternalContextRequest) => Promise<string>;
export interface LoopTerminalEvent {
    success: boolean;
    stopReason: StopReason;
    roundsCompleted: number;
    successTrajectory: boolean[];
    loopId: string;
    task: string;
    lastEvaluation?: NormalizedRoundEvaluation;
}
export type LoopTerminalSink = (event: LoopTerminalEvent) => Promise<void> | void;
/** A single flag raised during round-report verification.
 *  Each flag identifies a specific inconsistency between the agent's
 *  self-reported data and the loop's cross-round lineage. */
export interface VerificationFlag {
    /** Severity controls how aggressively the compiler reacts. */
    severity: "info" | "warn" | "error";
    /** Which round evaluation field triggered this flag (e.g. "subjective_progress"). */
    field: string;
    /** Check name for debugging / audit (e.g. "progress_regression"). */
    check: string;
    /** Human-readable description of the inconsistency found. */
    detail: string;
}
export declare function makeVerificationFlag(overrides?: Partial<VerificationFlag>): VerificationFlag;
/** Result of cross-round report and evidence verification.
 *
 *  Verdict semantics:
 *  - trusted:   all checks passed; flags are informational only.
 *  - suspect:   one or more warn-level flags; flags become warnings in the
 *               next prompt so the agent can clarify.
 *  - contradicted: one or more error-level flags; the quality score for this
 *                  round is excluded from the quality trend (NOT modified).
 *                  Flags become hard constraints that the Agent must address. */
export interface VerificationResult {
    verdict: "trusted" | "suspect" | "contradicted";
    flags: VerificationFlag[];
}
export declare function makeVerificationResult(overrides?: Partial<VerificationResult>): VerificationResult;
export declare function makeTaskId(taskDescription: string): string;
//# sourceMappingURL=protocol.d.ts.map