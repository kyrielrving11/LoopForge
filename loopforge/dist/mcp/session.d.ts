/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 */
import { LoopForgeEngine } from "../engine.js";
import type { VaultBackend } from "../backends/interface.js";
import type { LoopStore } from "../loop-store.js";
import type { SelfEvaluation, ExternalContextProvider, LoopTerminalSink } from "../protocol.js";
import type { ProviderSnapshot } from "../evidence-provider.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import type { SessionStateStore } from "../storage.js";
import type { CognitiveCheckpointSink } from "../interop.js";
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
    /** Evidence baseline captured immediately before the agent receives a prompt. */
    evidenceBaseline?: ProviderSnapshot[];
    /** Schema-versioned transaction for the prompt currently held by the agent. */
    roundSnapshot?: RoundTransactionSnapshot;
    /** Persisted prompt prevents resume from compiling the same round twice. */
    currentPrompt?: string | null;
    currentLevel?: string;
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
    level?: string;
    /** @deprecated Use roundSuccess instead. Derived: roundSuccess ? 5 : 1 */
    quality?: number;
    roundSuccess?: boolean;
    warnings?: string[];
    /** v1.13: Enforcement action for this round. accept/reject/terminate.
     *  When "reject", the prompt contains a rejection notice and the agent
     *  must redo the same round. Round counter does NOT increment. */
    enforcementAction?: "accept" | "reject" | "terminate";
    /** v1.13: When enforcementAction is "reject" or "terminate", the reason
     *  why the round was rejected or the loop was terminated. */
    enforcementReason?: string;
}
export declare class SessionManager {
    private sessions;
    /** Serializes state transitions for each session. */
    private sessionQueues;
    private backend;
    private sessionStore;
    private readonly ownerId;
    private readonly leaseMs;
    private readonly leaseRenewIntervalMs;
    private leaseTimer;
    private readonly checkpointSinks;
    /** Explicit context provider; never auto-discovered. */
    contextProvider?: ExternalContextProvider;
    private readonly terminalSinks;
    constructor(storeOrBackend?: LoopStore | VaultBackend, sessionStore?: SessionStateStore);
    /** Stable process-local owner token used for cross-process session leases. */
    getOwnerId(): string;
    /** Subscribe an external checkpointer; sink failures are isolated. */
    addCheckpointSink(sink: CognitiveCheckpointSink): () => void;
    addTerminalSink(sink: LoopTerminalSink): () => void;
    /** Release owned sessions and stop lease maintenance. */
    close(): void;
    private findSessionEntry;
    private claimSessionEntry;
    private renewSessionLease;
    private renewOwnedLeases;
    private leaseConflictResult;
    private withSessionQueue;
    create(input: StartInput): Promise<AdvanceResult>;
    get(sessionId: string): McpSession | undefined;
    getLeaseStatus(loopId: string): Record<string, unknown> | null;
    delete(sessionId: string): boolean;
    /** v1.18: Pause a running session. The session state is persisted to
     *  vault so it survives process restarts. Returns the session status.
     *  Paused sessions cannot be advanced — they must be resumed first. */
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
    resume(loopId: string): AdvanceResult | null;
    /** Auto-resume all "running" sessions from vault on server startup.
     *  Scans vault for session_state entries, reconstructs each as an in-memory
     *  McpSession (without compiling — the next loopforge_next will do that).
     *  Returns the number of sessions resumed. */
    autoResumeAll(): number;
    list(): McpSessionSummary[];
    /** Get loop health for a loop (in-memory or vault).
     *  Computes goal alignment, constraint integrity, drift, strategy stability. */
    getHealth(loopId: string): Record<string, unknown> | null;
    /** Core cycle: extract self-eval → record feedback → check stop → compile next.
     *  @param preExtractedEval Optional pre-built SelfEvaluation from MCP tool parameter.
     *    When provided (MCP path with evaluation parameter), skips regex extraction.
     *    When undefined (runtime/CLI path), falls back to regex extraction from output. */
    advance(sessionId: string, output: string, preExtractedEval?: SelfEvaluation): Promise<AdvanceResult>;
    private advanceUnlocked;
    /** Write back loop knowledge to long-term memory.
     *  Uses shared base builder from policy.ts. Called when a loop terminates. */
    private notifyTerminal;
    /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
    replayTimeline(sessionId: string): Record<string, unknown>[] | null;
}
//# sourceMappingURL=session.d.ts.map