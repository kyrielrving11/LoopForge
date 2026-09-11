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
import type { LoopForgeRequest, LoopForgeResponse, SelfEvaluation, VerificationFlag, ExternalContextProvider, LoopTerminalSink, RoundVerificationStatus } from "../protocol.js";
import type { MachineObservation } from "../protocol.js";
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
    /** v2.13: Files changed in skipped rounds during the last backtrack.
     *  The next round's verification gate checks that the agent did not
     *  continue working on stale files without restoring the workspace.
     *  Cleared after the first successful post-backtrack round. */
    backtrackSkippedFiles: string[];
    /** M3 (v3.7.x): git fingerprint of each skipped file at its failed round
     *  — machine proof for the workspace-restore check. Cleared with
     *  backtrackSkippedFiles after the restore round. */
    backtrackSkippedFingerprints: Record<string, string>;
    /** v2.12: Git HEAD of the last backtrack restore point. The verification
     *  gate checks the workspace returns to this commit before accepting.
     *  Cleared after the first successful post-backtrack round. */
    backtrackTargetGitHead?: string;
    /** Evidence baseline captured immediately before the agent receives a prompt. */
    evidenceBaseline?: MachineObservation[];
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
    /** v3.8: The round-level verification posture — `trusted` when everything
     *  claimed this round is machine-backed, `insufficient` when claims are
     *  unbacked but nothing is denied, `contradicted` when a machine fact
     *  denies a claim. Never a verdict about the agent's work quality. */
    verificationStatus?: RoundVerificationStatus;
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
     *  still points at the old prompt. Returns null when no commit is pending.
     *  v3.7: async — the continue-after-crash branch compiles through
     *  RoundDriver.prepare (the sync prepareSync fallback was removed). */
    private reconcileCommittedRound;
    /** Resume tail: the session has been reconstructed and registered. Reconcile
     *  a committed-but-undelivered round, restore the held prompt, or recover a
     *  missing prompt from current round state. v3.7: async — compilation runs
     *  through RoundDriver.prepare like unpause (the prepareSync fallback was
     *  removed); a failed compile now degrades to the same stalled terminal
     *  result unpause returns instead of persisting a null prompt. */
    resume(session: McpSession): Promise<AdvanceResult>;
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
     *           session.successTrajectory */
    private executeRoundTransaction;
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
    /** M4: mark a session stalled after its round committed but the next
     *  prompt could not be prepared/persisted — mirrors the crash-recovery
     *  siblings (reconcileCommittedRound / resume / reject paths). The
     *  committed round stays held (roundSnapshot untouched) so a resubmission
     *  with the same roundId replays it and recompiles the next round. */
    private stalledAfterCommit;
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