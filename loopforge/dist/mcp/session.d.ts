/** LoopForge MCP session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * The advance cycle validates a report, executes the transaction, and compiles the next prompt.
 */
import { LoopForgeEngine } from "../engine.js";
import type { VaultBackend } from "../backends/interface.js";
import type { LoopStore } from "../loop-store.js";
import type { NormalizedRoundEvaluation, ExternalContextProvider, LoopTerminalSink, StructuredPlan, WorkflowState, RequiredAction, RoundReportV1, ApprovalPolicy, GateResolution, CapabilityPreflight, PlanningProfile, PlanDiagnostic, PlanChangeAssessment } from "../protocol.js";
import { computeWorkflowProgress } from "../plan.js";
import type { ProviderSnapshot } from "../evidence-provider.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import type { SessionStateStore } from "../storage.js";
import { WorkspaceRuntime } from "../workspace-runtime.js";
import type { WorkspaceRuntimeSummary } from "../protocol.js";
export interface McpSession {
    sessionId: string;
    loopId: string;
    task: string;
    engine: LoopForgeEngine;
    currentRound: number;
    /** Distinguishes post-backtrack branches that reuse logical round numbers. */
    executionEpoch: number;
    maxRounds: number;
    successTrajectory: boolean[];
    status: "running" | "stopped" | "stalled" | "paused";
    createdAt: number;
    /** Previous round's validated evaluation, used by the verification gate. */
    lastEvaluation?: NormalizedRoundEvaluation;
    consecutiveRejections: number;
    /** Which enforcement check triggered the last rejection.
     *  Only same-check rejections accumulate toward the max. */
    lastRejectionCheck: string;
    /** v2.13: Files changed in skipped rounds during the last backtrack.
     *  The next round's verification gate checks that the agent did not
     *  continue working on stale files without restoring the workspace.
     *  Cleared after the first successful post-backtrack round. */
    backtrackSkippedFiles: string[];
    /** Evidence baseline captured immediately before the agent receives a prompt. */
    evidenceBaseline?: ProviderSnapshot[];
    /** Schema-versioned transaction for the prompt currently held by the agent. */
    roundSnapshot?: RoundTransactionSnapshot;
    /** Persisted prompt prevents resume from compiling the same round twice. */
    currentPrompt?: string | null;
    currentLevel?: string;
    /** Structured warnings from the most recent compile, preferred over prompt parsing. */
    currentWarnings?: string[];
    /** v3 workflow state. Persisted sessions without this contract are unsupported. */
    workflow: WorkflowState;
}
export interface McpSessionSummary {
    sessionId: string;
    loopId: string;
    round: number;
    status: "running" | "stopped" | "stalled" | "paused";
    phase: WorkflowState["phase"];
    planVersion: number | null;
    activeStepId: string | null;
    progress: ReturnType<typeof computeWorkflowProgress>;
}
export interface StartInput {
    task: string;
    loopId?: string;
    maxRounds?: number;
    domain?: string;
    planSource?: string;
    constraints?: string[];
    plan?: StructuredPlan;
    workspaceRoot?: string;
    storeDir?: string;
    /** Session-local override; defaults to the workspace workflow policy. */
    approvalPolicy?: ApprovalPolicy;
    planningProfile?: PlanningProfile;
}
export interface AdvanceResult {
    sessionId: string;
    round: number;
    /** Stable logical identity; unchanged when enforcement retries the round. */
    roundId?: string;
    prompt: string | null;
    stopReason?: string;
    /** v2.0.1: Human-readable context for why the loop stopped.
     *  Provides facts the agent can use to decide its next action,
     *  without LoopForge prescribing a specific behavior. */
    stopDetail?: string;
    level?: string;
    roundSuccess?: boolean;
    warnings?: string[];
    /** v1.13: Enforcement action for this round. accept/reject/terminate.
     *  When "reject", the prompt contains a rejection notice and the agent
     *  must redo the same round. Round counter does NOT increment. */
    enforcementAction?: "accept" | "reject" | "terminate" | "backtrack";
    /** v1.13: When enforcementAction is "reject" or "terminate", the reason
     *  why the round was rejected or the loop was terminated. */
    enforcementReason?: string;
    phase?: WorkflowState["phase"];
    requiredAction?: RequiredAction;
    terminal?: boolean;
    planVersion?: number | null;
    activeStepId?: string | null;
    approvalId?: string | null;
    approvalPolicy?: ApprovalPolicy;
    planningProfile?: PlanningProfile;
    runtime?: WorkspaceRuntimeSummary | null;
    planDiagnostics?: PlanDiagnostic[];
    planChangeAssessment?: PlanChangeAssessment;
    regressionSummary?: {
        total: number;
        verified: number;
        gaps: number;
    };
}
export declare class SessionManager {
    private sessions;
    /** Serializes state transitions for each session. */
    private sessionQueues;
    private backend;
    private sessionStore;
    private loopStore;
    private readonly ownerId;
    private leaseMs;
    private leaseRenewIntervalMs;
    private leaseTimer;
    /** Explicit context provider; never auto-discovered. */
    contextProvider?: ExternalContextProvider;
    private readonly terminalSinks;
    readonly runtime?: WorkspaceRuntime;
    constructor(storeOrBackend?: LoopStore | VaultBackend, sessionStore?: SessionStateStore, runtime?: WorkspaceRuntime);
    /** Runtime summary is intentionally compact for unbound MCP processes. */
    getRuntimeSummary(): WorkspaceRuntimeSummary | null;
    getCapabilityPreflight(sessionId?: string): CapabilityPreflight;
    getRegressionSummary(sessionId: string): {
        total: number;
        verified: number;
        gaps: number;
    } | null;
    /** Bind the process and install a store only after path validation succeeds. */
    bindWorkspace(workspaceRoot?: string, storeDir?: string): void;
    private ensureWorkspaceForStart;
    private sessionBinding;
    /** Stable process-local owner token used for cross-process session leases. */
    getOwnerId(): string;
    addTerminalSink(sink: LoopTerminalSink): () => void;
    /** Release owned sessions and stop lease maintenance. */
    close(): void;
    private findSessionEntry;
    private claimSessionEntry;
    private renewSessionLease;
    private renewOwnedLeases;
    private leaseConflictResult;
    private withSessionQueue;
    private withRunningSessionMutation;
    /** Add the uniform v3 workflow envelope to every advancing response. */
    present(result: AdvanceResult, sessionId?: string): AdvanceResult;
    private recordWorkflowEvent;
    private regressionObligations;
    private applyAcceptedWorkflowStep;
    private blockOnExternalGate;
    private prepareWorkflowRoundSync;
    private selectWorkflowPreparation;
    private finishPreparedWorkflowRound;
    private planningResult;
    private prepareWorkflowRound;
    create(input: StartInput): Promise<AdvanceResult>;
    submitPlan(sessionId: string, plan: StructuredPlan, reason?: string, changeSummary?: string, evidenceReferences?: string[]): Promise<AdvanceResult>;
    updatePlan(sessionId: string, baseVersion: number, plan: StructuredPlan, reason: string, changeSummary: string, evidenceReferences: string[]): Promise<AdvanceResult>;
    private acceptPlanRevision;
    approvePlan(sessionId: string, approvalId: string, planVersion: number, decision: "approved" | "rejected", reason: string): Promise<AdvanceResult>;
    get(sessionId: string): McpSession | undefined;
    getByLoopId(loopId: string): McpSession | undefined;
    getLeaseStatus(loopId: string): Record<string, unknown> | null;
    delete(sessionId: string): boolean;
    /** v1.18: Pause a running session. The session state is persisted to
     *  vault so it survives process restarts. Returns the session status.
     * Paused sessions cannot advance until they are resumed. */
    pause(sessionId: string): {
        sessionId: string;
        round: number;
        status: string;
    };
    private restoredPromptResult;
    /** Reconcile the crash window where feedback committed but session_state
     *  still points at the old prompt. Returns null when no commit is pending. */
    private reconcileCommittedRound;
    /** v1.18: Resume a paused session. Reconstructs from vault state and
     *  compiles the next prompt. Returns null if no paused session exists
     *  for this loopId. */
    unpause(loopId: string): Promise<AdvanceResult | null>;
    /** Persist session state to vault for cross-process recovery.
     *  The filtered vault and replacement entry are written once under the
     *  backend lock, so recovery never observes the old two-write gap. */
    save(session: McpSession): void;
    /** Reconstruct a McpSession from a vault session_state entry.
     *  Returns null if the entry is not "running" status.
     *  Shared by resume() and autoResumeAll(). */
    private reconstructSession;
    /** Resume a loop from vault state.
     *  Reconstructs the session and compiles the prompt for the next round.
     *  Returns null if no session_state entry exists for this loopId. */
    resumeWithWorkspace(loopId: string, workspaceRoot?: string, storeDir?: string, gateResolution?: GateResolution): AdvanceResult | null;
    private gateResolutionProblem;
    private resolveExternalGate;
    resume(loopId: string): AdvanceResult | null;
    /** Auto-resume all "running" sessions from vault on server startup.
     *  Scans vault for session_state entries, reconstructs each as an in-memory
     * McpSession without compiling; the next loopforge_next call does that.
     *  Returns the number of sessions resumed. */
    autoResumeAll(): number;
    list(): McpSessionSummary[];
    listIncompatibleSessions(): Array<{
        loopId: string;
        foundSchemaVersion: number | null;
        requiredSchemaVersion: 3;
    }>;
    /** Derive workflow health from the approved plan and normalized evidence. */
    getHealth(loopId: string): Record<string, unknown> | null;
    /** v3 P1 compact-report entry point. Validation and round fencing run inside
     * the per-session queue so concurrent/stale Agent results cannot cross steps. */
    advanceReport(sessionId: string, roundId: string, report: RoundReportV1): Promise<AdvanceResult>;
    /** Execute a validated normalized report through the transaction and gates. */
    private executeRoundTransaction;
    private recordAcceptedAdvancement;
    /** Build a rejection result: compile a retry prompt, persist, return.
     *  MUTATES: session.roundSnapshot, session.currentPrompt, session.currentLevel */
    private buildRejectionResult;
    /** Build a backtrack result by restoring the last clean round.
     *  Resets the round counter to the restore target + 1, merges preserved
     *  discoveries, compiles from the restored state, and injects the
     *  backtrack prompt at the top.
     *  MUTATES: session.currentRound, session.roundSnapshot,
     *           session.currentPrompt, session.currentLevel,
     *           session.consecutiveRejections, session.lastEvaluation */
    private buildBacktrackResult;
    /** Build a termination result: persist stopped status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt */
    private buildTerminationResult;
    /** Build a stop result: persist stopped/stalled status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt */
    private buildStopResult;
    /** Compile the next round's prompt and advance the session.
     *  Includes the commit fence (pause/delete race guard) and context provider.
     *  MUTATES: session.currentRound, session.currentPrompt, session.currentLevel,
     *           session.evidenceBaseline, session.roundSnapshot */
    private advanceToNextRound;
    private advanceEvaluationUnlocked;
    private restoreWorkflowToRound;
    /** Write back loop knowledge to long-term memory.
     *  Uses shared base builder from policy.ts. Called when a loop terminates. */
    private notifyTerminal;
    /** Build the read-only replay timeline from the stored backend. */
    replayTimeline(sessionId: string): Record<string, unknown>[] | null;
    governanceGraph(sessionId: string): import("../governance-graph.js").GovernanceGraphView | null;
}
//# sourceMappingURL=session.d.ts.map