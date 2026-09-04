/** LoopForge MCP — Round lifecycle.
 *
 * The round state machine split out of SessionManager: crash recovery,
 * transaction execution, disposition result building, and the advance
 * pipeline. SessionManager owns "who may touch a session" (registry, queue,
 * leases); this class owns "what happens to a session" (state machine,
 * recovery, result building).
 *
 * The lifecycle depends on a narrow registry and explicit stores/providers;
 * session ownership, queues, and leases remain in SessionManager.
 */
import { LoopForgeEngine } from "../engine.js";
import type { LoopForgeRequest, LoopForgeResponse, SelfEvaluation, VerificationFlag, ExternalContextProvider, LoopTerminalSink } from "../protocol.js";
import type { ProviderSnapshot } from "../evidence-provider.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import type { LoopStore, VaultEntry } from "../loop-store.js";
import type { SessionStateStore } from "../storage.js";
export interface McpSession {
    sessionId: string;
    loopId: string;
    task: string;
    engine: LoopForgeEngine;
    currentRound: number;
    maxRounds: number;
    successTrajectory: boolean[];
    status: "running" | "stopped" | "stalled" | "paused";
    createdAt: number;
    /** Previous round's validated SelfEvaluation — used by verification gate. */
    lastSelfEval?: SelfEvaluation;
    consecutiveRejections: number;
    /** Which enforcement check triggered the last rejection.
     *  Only same-check rejections accumulate toward the max. */
    lastRejectionCheck: string;
    /** v2.12: Consecutive rounds where the agent used drift_clarification
     *  to waive R7 rejection. Reset to 0 when a round has no intent_drift.
     *  Terminates the loop when exceeding policy.drift_clarification_max_streak. */
    driftClarificationStreak: number;
    /** v2.13: Files changed in skipped rounds during the last backtrack.
     *  The next round's verification gate checks that the agent did not
     *  continue working on stale files without restoring the workspace.
     *  Cleared after the first successful post-backtrack round. */
    backtrackSkippedFiles: string[];
    /** v2.12: Git HEAD of the last backtrack restore point. The verification
     *  gate checks the workspace returns to this commit before accepting.
     *  Cleared after the first successful post-backtrack round. */
    backtrackTargetGitHead?: string;
    /** Evidence baseline captured immediately before the agent receives a prompt. */
    evidenceBaseline?: ProviderSnapshot[];
    /** Schema-versioned transaction for the prompt currently held by the agent. */
    roundSnapshot?: RoundTransactionSnapshot;
    /** Persisted prompt prevents resume from compiling the same round twice. */
    currentPrompt?: string | null;
    currentLevel?: string;
    /** Structured warnings from the most recent compile — preferred over regex parsing. */
    currentWarnings?: string[];
    /** v3.0.1: The full compile response of the current round, cached so the
     *  typed projection (getProjection) derives from it instead of recompiling
     *  the whole vault. Freshness is checked via loop_id + round; rebuilt by
     *  every compile path. Not persisted — cold sessions fall back to compiling. */
    lastCompileResponse?: LoopForgeResponse | null;
}
export interface McpSessionSummary {
    sessionId: string;
    loopId: string;
    round: number;
    status: "running" | "stopped" | "stalled" | "paused";
}
export interface StartInput {
    task: string;
    loopId?: string;
    maxRounds?: number;
    domain?: string;
    planSource?: string;
    constraints?: string[];
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
}
/** Narrow view of the session registry the lifecycle may touch. The owning
 *  SessionManager implements this over its private Map, so the lifecycle
 *  never holds or mutates registry state directly. */
export interface SessionRegistry {
    get(sessionId: string): McpSession | undefined;
    values(): Iterable<McpSession>;
    upsert(session: McpSession): void;
}
export interface RoundLifecycleDeps {
    store: LoopStore;
    sessionStore: SessionStateStore | undefined;
    registry: SessionRegistry;
    terminalSinks: Set<LoopTerminalSink>;
    /** Stable process-local owner token used for cross-process session leases. */
    ownerId: string;
    /** Session lease duration; stamped into saved session entries. */
    leaseMs: number;
    /** Live accessor for the mutable contextProvider field on SessionManager. */
    getContext: () => ExternalContextProvider | undefined;
}
export declare function buildLoopRequest(session: McpSession, lastEval?: SelfEvaluation, verificationFlags?: VerificationFlag[]): LoopForgeRequest;
export declare class RoundLifecycle {
    private readonly store;
    private readonly sessionStore;
    private readonly registry;
    private readonly terminalSinks;
    private readonly ownerId;
    private readonly leaseMs;
    private readonly getContext;
    constructor(deps: RoundLifecycleDeps);
    /** Persist session state to vault for cross-process recovery.
     *  The filtered vault and replacement entry are written once under the
     *  backend lock, so recovery never observes the old two-write gap. */
    save(session: McpSession): void;
    /** Reconstruct a McpSession from a vault session_state entry.
     *  Returns null if the entry is not "running" status.
     *  Shared by resume() and autoResumeAll(). */
    reconstructSession(entry: VaultEntry, allowPaused?: boolean): McpSession | null;
    /** Apply a prepared round to the session, persist, and build the result.
     *  Shared by reconcileCommittedRound, resume, and unpause — the three
     *  compile-then-persist tails were previously copy-pasted. */
    private persistPrepared;
    private restoredPromptResult;
    /** Reconcile the crash window where feedback committed but session_state
     *  still points at the old prompt. Returns null when no commit is pending. */
    private reconcileCommittedRound;
    /** Resume tail: the session has been reconstructed and registered. Reconcile
     *  a committed-but-undelivered round, restore the held prompt, or recover a
     *  missing prompt from current round state. */
    resume(session: McpSession): AdvanceResult;
    /** Unpause tail: the session has been reconstructed and registered with
     *  status "running". Refresh async evidence, reconcile a committed round,
     *  restore the held prompt, or compile the next prompt. */
    unpause(session: McpSession): Promise<AdvanceResult>;
    /** Record a gate_opened entry when an accepted round reports a high-risk
     *  blocker (USER_RISK hit). Idempotent per gate. The gate is a record
     *  layer — it never blocks the round decision flow. */
    private recordGateFromBlocked;
    /** Undecided user gate descriptions for a loop (recorded but unresolved). */
    listOpenGateDescriptions(loopId: string): string[];
    /** The boundary supplies the typed evaluation. Free-text parsing is
     *  deliberately not part of the round state machine. */
    private extractEvaluation;
    /** Execute the round transaction and apply per-rule rejection tracking.
     *  MUTATES: session.roundSnapshot, session.consecutiveRejections,
     *           session.lastRejectionCheck, session.lastSelfEval,
     *           session.successTrajectory, session.driftClarificationStreak */
    private executeRoundTransaction;
    /** v2.12: Update the clarification streak based on the round result.
     *  - Substantive clarification (anchors present): keep streak — genuine pivot.
     *  - No intent_drift this round: reset streak to 0.
     *  - Weak clarification rejected by R7: streak was already consumed by
     *    enforceIntentDrift to decide reject vs terminate; staleness is handled
     *    on the enforcement side. We sync the persisted counter for crash recovery.
     *  v3.2.1: when a HIGHER-PRIORITY rule (R1–R6/R8/R9/R-EVID) rejected the
     *  round, R7 never participated — clarificationAccepted is undefined (it
     *  is only set on the continue path). Touching the streak there would
     *  pollute it with rejections unrelated to drift and terminate the loop
     *  one weak clarification early.
     *  MUTATES: session.driftClarificationStreak */
    private updateClarificationStreak;
    /** Build a rejection result: compile a retry prompt, persist, return.
     *  MUTATES: session.roundSnapshot, session.currentPrompt, session.currentLevel */
    private buildRejectionResult;
    /** v2.10: Build a backtrack result — roll back to last clean round.
     *  Resets the round counter to the restore target + 1, merges preserved
     *  discoveries, compiles from the restored state, and injects the
     *  backtrack prompt at the top.
     *  MUTATES: session.currentRound, session.roundSnapshot,
     *           session.currentPrompt, session.currentLevel,
     *           session.consecutiveRejections, session.lastSelfEval */
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
    private advanceUnlocked;
    /** Core cycle entry used by SessionManager.advance after the queue + lease
     *  dance: validate → extract → execute transaction → route disposition
     *  → advance to next round (continue) or return terminal result.
     *  @param roundId v3.0.1: the roundId of the round this submission reports
     *    on (from the last start/next/resume response). Anchors the submission;
     *    a stale or duplicate submission returns the held prompt instead of
     *    being processed. Optional — when absent the anchor check is skipped. */
    advance(sessionId: string, output: string, preExtractedEval?: SelfEvaluation, roundId?: string): Promise<AdvanceResult>;
    /** Write back loop knowledge to long-term memory.
     *  Uses shared base builder from policy.ts. Called when a loop terminates. */
    notifyTerminal(session: McpSession, stopReason: string): Promise<void>;
}
//# sourceMappingURL=round-lifecycle.d.ts.map