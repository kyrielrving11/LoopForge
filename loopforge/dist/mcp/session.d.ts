/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 *
 * Since v2.14 the round state machine lives in RoundLifecycle
 * (round-lifecycle.ts). SessionManager owns "who may touch a session":
 * the in-memory registry, per-session serialization queue, and cross-process
 * lease fencing. RoundLifecycle owns "what happens to a session": crash
 * recovery, transaction execution, disposition result building, and the
 * advance pipeline. All round processing still goes through the
 * SessionManager → RoundDriver → RoundCoordinator path.
 */
import type { GateActionDescriptor } from "../protocol.js";
import type { LoopTerminalSink, SubmissionGuidance, SubmissionReceipt } from "../protocol.js";
import type { ActiveContractView } from "../round-contract.js";
import type { LoopStore } from "../loop-store.js";
import { FileWorkspaceCheckpointStore } from "../workspace-checkpoint.js";
import type { PolicyMetricsSnapshot } from "../policy-metrics.js";
import type { SessionStateStore } from "../storage.js";
import type { McpSession, McpSessionSummary, StartInput, AdvanceResult, SessionRegistry } from "./round-lifecycle.js";
export type { McpSession, McpSessionSummary, StartInput, AdvanceResult, } from "./round-lifecycle.js";
export declare class SessionManager implements SessionRegistry {
    private sessions;
    /** Serializes state transitions for each session. */
    private sessionQueues;
    private readonly loopStore;
    private sessionStore;
    private readonly ownerId;
    private readonly leaseMs;
    private readonly leaseRenewIntervalMs;
    private leaseTimer;
    private readonly lifecycle;
    private readonly terminalSinks;
    private readonly checkpointStoreFor;
    constructor(store?: LoopStore, sessionStore?: SessionStateStore, checkpointStoreFor?: (loopId: string) => FileWorkspaceCheckpointStore | undefined);
    /** Stable process-local owner token used for cross-process session leases. */
    getOwnerId(): string;
    addTerminalSink(sink: LoopTerminalSink): () => void;
    /** Release owned sessions and stop lease maintenance. */
    close(): void;
    values(): Iterable<McpSession>;
    /** Register (or replace) a session in the in-memory registry. */
    upsert(session: McpSession): void;
    private findSessionEntry;
    private claimSessionEntry;
    private renewSessionLease;
    private renewOwnedLeases;
    private leaseConflictResult;
    private withSessionQueue;
    create(input: StartInput): Promise<AdvanceResult>;
    /** v3.9.1: current-fact submission guidance for the session's held round.
     *  Read-only projection; null when the session is unknown. */
    getSubmissionGuidance(sessionId: string): SubmissionGuidance | null;
    /** v3.9.1: the most recent committed round's receipt, rebuilt from the
     *  transaction + shared read model. Rejected/terminated attempts are not in
     *  history; their receipt exists only on their own response. */
    getLastSubmissionReceipt(sessionId: string): SubmissionReceipt | null;
    /** v3.9.6: the success trajectory is a projection of committed branch
     *  rounds, not a session counter. */
    getSuccessTrajectory(loopId: string): boolean[];
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
    /** Persist session state to vault for cross-process recovery. Delegates to
     *  the round lifecycle, which owns the durable session document shape. */
    save(session: McpSession): void;
    /** Resume a loop from vault state.
     *  Reconstructs the session and compiles the prompt for the next round
     *  (async — compilation collects evidence through RoundDriver.prepare).
     *  Returns null if no session_state entry exists for this loopId. */
    resume(loopId: string): Promise<AdvanceResult | null>;
    /** v1.18: Resume a paused session. Reconstructs from vault state and
     *  compiles the next prompt. Returns null if no paused session exists
     *  for this loopId. */
    unpause(loopId: string): Promise<AdvanceResult | null>;
    /** Auto-resume all "running" sessions from vault on server startup.
     *  Scans vault for session_state entries, reconstructs each as an in-memory
     *  McpSession (without compiling — the next loopforge_next will do that).
     *  Returns the number of sessions resumed. */
    autoResumeAll(): number;
    list(): McpSessionSummary[];
    /** Persist a gate_opened record for a structured preflight. Only
     *  user_required actions are recorded — agent_allowed needs no human
     *  authorization and opens no record. */
    private recordOpenedGate;
    /** v3.7.1: structured gate preflight. The agent submits a
     *  GateActionDescriptor; the runtime classifies it (conservative:
     *  anything not provably safe is user_required with reason codes). A
     *  user_required verdict persists a gate_opened record bound to
     *  loop + round + actionHash; agent_allowed records nothing and returns
     *  the evidence suggestion instead. No action is executed and no round
     *  advances from this call. */
    checkGate(sessionId: string, roundId: string, action: GateActionDescriptor): Record<string, unknown>;
    /** Record a user decision for a recorded gate. The gateId embeds the
     *  canonicalized action hash — if the action changed, the match fails and
     *  the old approval expires automatically. */
    resolveGate(sessionId: string, gateId: string, approved: boolean, note?: string): Record<string, unknown>;
    /** The compile context for this round.
     *
     *  v3.8.1: delegates to the SHARED implementation in round-lifecycle.ts —
     *  the runtime's submission boundary reads the same context (the sub-goal
     *  reference space is exactly the compiled set the prompt carried), and two
     *  copies would let the projection and the boundary disagree about it. */
    /** v3.8: Read-only per-round "why" view over committed facts. Never
     *  rebuilds history and never writes. */
    getExplain(loopId: string, round?: number): Record<string, unknown>;
    /** Read-only end-of-loop audit (verification view). Never writes. */
    getAudit(loopId: string): Record<string, unknown> | null;
    /** v3.5: The ACTIVE Round Contract governing the session's next round —
     *  derived from the committed :feedback evals (the SAME adapter + walker
     *  the verification gate uses; display-only, zero persistence). Null when
     *  nothing is active (whole-task round). */
    getActiveContract(sessionId: string): ActiveContractView | null;
    /** v2.12: Policy metrics that survive restarts — vault-derived round
     *  statistics (A4 port) folded with this process's live observations.
     *  Non-durable fields (evidence, vault errors) come from live only. */
    getPolicyMetrics(loopId: string): PolicyMetricsSnapshot;
    /** Get machine facts about a loop (in-memory or vault).
     *
     *  v3.8.1: this view used to report `goal_alignment`, `drift_detected`,
     *  `strategy_stability` and `task_continuity`. Every one was a
     *  text-similarity verdict rather than a fact, and two were degenerate in
     *  THIS method specifically: `task_continuity` was pinned to 1.0 because the
     *  request was built with `round: 1`, so `getPreviousRound(loopId, 0)`
     *  returned null and the code took its hardcoded `?? 1` branch; and
     *  `strategy_stability` was a literal `true`. What remains is counted
     *  directly from committed round flags. */
    getHealth(loopId: string): Record<string, unknown> | null;
    /** Core cycle: extract self-eval → record feedback → check stop → compile next.
     *  The lease + per-session queue wrap the RoundLifecycle state machine.
     *  @param preExtractedEval Structured SelfEvaluation supplied by the caller.
     *    An absent value is returned as evaluation_invalid without mutating state.
     *  @param roundId v3.0.1: The roundId of the round this submission reports on
     *    (from the last start/next/resume response). Anchors the submission so a
     *    stale or duplicate submission is not processed against a later round.
     *    Optional for library callers — when absent the anchor check is skipped. */
    /** \`submission\` is the RAW evaluation payload, not a built one.
     *
     *  v3.8.1: this method used to carry a partial copy of the submission
     *  boundary (an object check plus core-field validation) while the MCP tool
     *  handler carried the rest — one rule, three copies, across two layers.
     *  The boundary now lives entirely in the runtime
     *  (`RoundLifecycle.submissionBoundary`), so every caller — this manager, a
     *  library user, a future CLI command — gets the same strictness. */
    /** \`submission\` is the RAW evaluation payload, not a built one.
     *
     *  v3.8.1: this method used to carry a partial copy of the submission
     *  boundary (an object check plus core-field validation) while the MCP tool
     *  handler carried the rest — one rule, three copies, across two layers.
     *  The whole boundary now runs HERE, before the queue and before the lease
     *  heartbeat, so every caller of the public API gets it and a rejected
     *  payload leaves nothing durable behind. */
    advance(sessionId: string, output: string, submission?: unknown, roundId?: string, transactionId?: string): Promise<AdvanceResult>;
    /** v3.9.7: submit an Agent-initiated recovery. Shape validation happens
     *  before the session queue/lease; target referential validation happens in
     *  the lifecycle against committed facts. */
    recover(sessionId: string, recovery: unknown, roundId?: string, transactionId?: string): Promise<AdvanceResult>;
    /** v3.9.7: Agent-created mid-round savepoint. It does not touch the round
     *  counter, progress, or any governance projection. The capture runs under
     *  the session queue/lease but outside the store lock; the session save is
     *  the only store mutation. */
    checkpoint(sessionId: string, roundId?: string, transactionId?: string): Promise<Record<string, unknown>>;
    /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
    replayTimeline(sessionId: string): Record<string, unknown>[] | null;
    /** v3.3.1: Replay a loop straight from the vault — no in-memory session
     *  needed. Time travel over committed rounds is a property of the store
     *  (ReplayBackend reads round documents), so a process restart must not
     *  revoke it: the session registry was an artificial prerequisite that
     *  made every vault loop unreplayable after restart.
     *  Returns null when the loop has no committed rounds. */
    replayByLoop(loopId: string): Record<string, unknown>[] | null;
    /** v3.9.6: committed rollback directives for the replay view. They are
     *  events, not normal rounds; the timeline stays a normal-round projection. */
    replayRollbacks(loopId: string): Record<string, unknown>[];
    /** v3.9.1: unsupported envelope versions for a loop, reported explicitly
     *  rather than silently dropped from replay/audit. */
    replayLegacyRounds(loopId: string): Array<{
        round: number;
        schemaVersion: number;
        envelope: string;
    }>;
}
//# sourceMappingURL=session.d.ts.map