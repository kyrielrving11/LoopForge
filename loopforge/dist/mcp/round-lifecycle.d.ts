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
import type { CheckpointRef, EvidencePosture, LoopCompileRequest, OperatorAcceptance, PromptContextMode, PromptContextReason, RecoveryRequest, RoundOutcome, SelfEvaluation, SubmissionDiagnostic, SubmissionGuidance, SubmissionHandle, SubmissionReceipt, VerificationFlag, LoopTerminalSink, StopReason } from "../protocol.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import { FileWorkspaceCheckpointStore } from "../workspace-checkpoint.js";
import type { LoopStore, VaultEntry } from "../loop-store.js";
import type { SessionSaveOptions, SessionStateStore } from "../storage.js";
export interface McpSession {
    /** v4.0.4: a LIVE key inside this process. It is persisted and rebuilt by
     *  `loopforge_resume`/`autoResumeAll`, but it is not the durable identity:
     *  relationships and recovery use `loopId`. */
    sessionId: string;
    /** The one durable loop identity. */
    loopId: string;
    /** The compile-time task text; the immutable operator objective is a
     *  separate committed fact (`OperatorAcceptance`). */
    task: string;
    engine: LoopForgeEngine;
    currentRound: number;
    maxRounds: number;
    status: "running" | "stopped" | "stalled" | "paused";
    createdAt: number;
    consecutiveRejections: number;
    /** Which enforcement check triggered the last rejection.
     *  Only same-check rejections accumulate toward the max. */
    lastRejectionCheck: string;
    /** v3.8.3: the trusted round-start fingerprint of every enabled command's
     *  entrypoint files, captured when the CURRENT in-flight round was prepared.
     *
     *  In-flight only: it never enters committed round history. It exists so the
     *  entrypoint check can be absolute (current content vs round-start content)
     *  rather than relative to a git delta that a gitignored entrypoint never
     *  appears in and a re-derived baseline could launder. Absent means the
     *  round runs without that arm — never a lost round. */
    entrypointTrust?: Record<string, string>;
    /** v3.9.7: operator-owned immutable acceptance, carried as a session cursor
     *  so a recovery that clears the held snapshot cannot lose it. The root
     *  committed round-1 transaction remains the authority. */
    operatorAcceptance?: OperatorAcceptance;
    /** Schema-versioned transaction for the prompt currently held by the agent. */
    roundSnapshot?: RoundTransactionSnapshot;
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
    planSource?: string;
    constraints?: string[];
    /** v3.9.4: initial local requirements, each becoming a stable `cr-*` anchor
     *  in the objective. Omit to keep the default criterion. */
    criteria?: string[];
}
/** v3.9.4: a structural defect in the start criteria argument. The MCP
 *  handler maps this to `invalid_argument`; it is never a policy defect. */
export declare class StartCriteriaError extends Error {
    readonly code = "invalid_argument";
}
/** v3.9.4: normalize initial criteria at the start boundary.
 *
 *  - a non-array / non-string element is a structural defect (throws);
 *  - empty text is dropped with a warning;
 *  - duplicate normalized-exact text keeps the first spelling, with a
 *    warning (the stable id derivation would otherwise produce two entries
 *    with one `cr-*` id);
 *  - over `policy.evolution.max_start_criteria` is dropped from the tail with
 *    a warning;
 *  - an empty result is the caller's signal to keep the default criterion. */
export declare function normalizeStartCriteria(raw: unknown): {
    criteria: string[];
    warnings: string[];
};
/** v4.0.4: the terminal reason a manual `loopforge_stop` reports to the
 *  terminal sink and in its response. It is never persisted as a committed
 *  round fact, so status/resume after a restart still report "no committed
 *  terminal reason". One constant keeps the response and the sink aligned. */
export declare const MANUAL_STOP_REASON: "cancelled";
export interface AdvanceResult {
    sessionId: string;
    /** Durable loop identity, returned with the held prompt so a restarted
     *  agent can call `loopforge_resume` without reconstructing IDs. Absent on
     *  results that have no session (for example a missing-handle refusal). */
    loopId?: string;
    /** On a continue result this is the NEXT round being prepared; the
     *  `agentOutcome`/`agentStopReason` fields and the receipt describe the
     *  round that was just submitted. Use `submission_receipt.round_id` as the
     *  authoritative identity of the submitted round. */
    round: number;
    /** v4.0.0: the ONE transport anchor for the held attempt. Derived from the
     *  persisted snapshot; never persisted itself. Absent on terminal results. */
    submissionHandle?: SubmissionHandle;
    /** v3.9.7: the held transaction's before-image + mid savepoints. */
    checkpoints?: CheckpointRef[];
    /** v3.9.7: explicit fact when the automatic before-image failed. */
    beforeCheckpointError?: {
        code: string;
        detail: string;
    };
    prompt: string | null;
    /** v4.0.4: LoopForge's terminal reason. ONLY a `StopReason` — session
     *  state, handle/payload/session errors are reported through
     *  `sessionStatus`/`submissionError` and never masquerade as a stop reason. */
    stopReason?: StopReason;
    /** v4.0.4: the live session's status when the result is not a loop terminal
     *  reason. `paused`/`stopped`/`stalled` describe the SESSION, not a
     *  `StopReason`; `running` is present only where the caller needs the
     *  distinction. */
    sessionStatus?: "running" | "stopped" | "paused" | "stalled";
    /** v2.0.1: Human-readable context for why the loop stopped.
     *  Provides facts the agent can use to decide its next action,
     *  without LoopForge prescribing a specific behavior. */
    stopDetail?: string;
    level?: string;
    /** v4.0.2: the context boundary of the delivered prompt. Projected from the
     *  PromptArtifact, never re-derived by the lifecycle. Absent when this
     *  result carries no prompt. */
    contextMode?: PromptContextMode;
    contextReason?: PromptContextReason;
    agentSuccessClaim?: boolean;
    /** v4.0.3: the effective Agent-declared outcome of the round this result
     *  is about. */
    agentOutcome?: RoundOutcome | null;
    /** v4.0.4: the Agent's declared stop reason of the round this result is
     *  about (an Agent report, never a loop terminal reason). */
    agentStopReason?: "gave_up" | "blocked" | "needs_human_input";
    /** v4.0.4: the Agent's declared should_continue of the same round. */
    agentShouldContinue?: boolean;
    warnings?: string[];
    /** v1.13: Enforcement action for this round. accept/reject/terminate.
     *  When "reject", the prompt contains a rejection notice and the agent
     *  must redo the same round. Round counter does NOT increment. */
    enforcementAction?: "accept" | "reject" | "terminate" | "backtrack" | "recovery";
    /** v4.0.3: the ONE evidence posture of the round this result is about.
     *  Accepted rounds carry the persisted posture; a rejection carries its
     *  transient copy. Never a verdict about the agent's work quality. */
    evidencePosture?: EvidencePosture;
    /** v1.13: When enforcementAction is "reject" or "terminate", the reason
     *  why the round was rejected or the loop was terminated. */
    enforcementReason?: string;
    /** v3.9.7: the committed rollback directive facts and the verified restore
     *  that produced the redo prompt. The Agent does not restore the workspace;
     *  LoopForge already did. */
    recovery?: {
        origin: "agent" | "machine";
        reason: string;
        target_checkpoint_id: string;
        redo_round: number;
        restore: {
            status: "verified";
            head?: string;
            previous_head?: string;
            safety_ref?: string;
            files_written: number;
            files_deleted: number;
            verified_at: number;
        };
    };
    /** v3.8.1: set when the RUNTIME refused the submission before touching any
     *  state — the same `ToolErrorCode` as `stopReason`, plus the structured
     *  details a transport maps onto its error envelope. Produced by
     *  `validateSubmission` in submission-boundary.ts, which SessionManager
     *  runs before its queue and lease heartbeat. */
    submissionError?: {
        code: "evaluation_invalid" | "contract_invalid" | "invalid_argument" | "session_not_found" | "submission_handle_required" | "submission_handle_mismatch" | "recovery_invalid" | "recovery_disabled" | "recovery_unavailable" | "checkpoint_invalid" | "checkpoint_unavailable" | "checkpoint_failed" | "checkpoint_limit" | "restore_failed" | "restore_pending"
        /** v4.0.4: another live process owns the session lease; this is a
         *  session error, not a loop terminal reason. */
         | "lease_conflict";
        details: Record<string, unknown>;
    };
    /** v3.9.4: a prompt-projection code defect. This is NOT a submission
     *  refusal (the round may already be committed); the next prompt was not
     *  delivered and the session is stalled. The MCP envelope maps it to the
     *  `projection_incomplete` error code. */
    projectionError?: {
        code: "projection_incomplete";
        details: Record<string, unknown>;
    };
    /** v3.9.1: current-fact submission guidance for the held/prepared round.
     *  Derived, never persisted; omitted on terminal results with no prompt. */
    submission_guidance?: SubmissionGuidance;
    /** v3.9.1: what this submission actually did. Returned by loopforge_next
     *  only; rebuilt from the transaction on a lost-response replay. */
    submission_receipt?: SubmissionReceipt;
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
    /** v3.9.7: per-loop checkpoint store. Absent disables automatic
     *  before-images (the round still runs with an explicit error fact). */
    checkpointStoreFor?: (loopId: string) => FileWorkspaceCheckpointStore | undefined;
}
export declare function buildLoopRequest(session: McpSession): LoopCompileRequest;
export declare class RoundLifecycle {
    private readonly store;
    private readonly sessionStore;
    private readonly registry;
    private readonly terminalSinks;
    private readonly ownerId;
    private readonly leaseMs;
    private readonly checkpointStoreFor;
    constructor(deps: RoundLifecycleDeps);
    /** v3.9.7: the one RoundDriver construction site. Every prepare must carry
     *  the per-loop checkpoint store, or no round can produce a before-image. */
    private driver;
    /** v3.9.1: the submission-guidance projection for a session's held round.
     *  One history read and one compile window, no writes.
     *  Findings from a rejected/retried attempt are supplied by the caller. */
    guidanceFor(session: McpSession, extras?: {
        verificationFlags?: ReadonlyArray<VerificationFlag>;
        recovery?: {
            pending: boolean;
            redo_round: number;
            checkpoint_id: string;
            restore_verified: boolean;
            origin?: "agent" | "machine";
            reason?: string;
        } | null;
    }): SubmissionGuidance;
    /** The operator criteria the held prompt's reference space was built from.
     *  The held acceptance wins; committed objective lineage is the fallback for
     *  a session whose snapshot predates the acceptance field. Null when neither
     *  is observable — callers fail open. */
    private objectiveCriteriaFor;
    /** v3.9.1: the before facts of the round being submitted, from the SAME
     *  history window the compile uses. Works on a replay too: rounds below the
     *  logical round exclude the round itself. */
    private beforeFactsFor;
    /** v3.9.1: derive this submission's receipt from the transaction and the
     *  shared read model. Never writes and never invents an applied effect. */
    private buildReceipt;
    /** Persist session state to vault for cross-process recovery.
     *  The filtered vault and replacement entry are written once under the
     *  backend lock, so recovery never observes the old two-write gap. */
    save(session: McpSession, options?: SessionSaveOptions): void;
    /** Reconstruct a McpSession from a vault session_state entry.
     *  Returns null if the entry is not "running" status.
     *  Shared by resume() and autoResumeAll(). */
    reconstructSession(entry: VaultEntry, allowPaused?: boolean): McpSession | null;
    /** Apply a prepared round to the session, persist, and build the result.
     *  Shared by reconcileCommittedRound, resume, and unpause — the three
     *  compile-then-persist tails were previously copy-pasted. */
    /** Apply a processed round's counters to the session.
     *
     *  v3.8.1: per-rule rejection tracking — same-check rejections accumulate,
     *  and a DIFFERENT rejection reason resets the counter to 1, so an agent
     *  that fixes what it was told to fix is not punished by an unrelated
     *  earlier rejection. This rule ran as two byte-identical copies (the live
     *  advance path and the crash replay); one rule, one implementation, so the
     *  two paths cannot drift.
     *
     *  `newConsecutiveRejections` comes from the enforcement gate and already
     *  counts the round; it is only honoured when the check is unchanged. */
    private applyRoundCounters;
    /** v3.8.3: capture the trusted entrypoint baseline for the round about to be
     *  prepared.
     *
     *  Called wherever a NEW round is installed and NEVER for a same-round
     *  retry: a retry must keep measuring against the state the round started
     *  in, or the first rejection would silently re-baseline itself. What is
     *  captured here is therefore the round's own start, taken before the agent
     *  receives the prompt.
     *
     *  Best-effort: an unreadable policy or an unresolvable command must leave
     *  the round without the absolute arm, not fail the preparation. */
    /** v4.0.3: seed the round-start entrypoint baseline. Public so the start
     *  path can seed BEFORE the first prompt is delivered; a missing baseline
     *  must never be re-derived from an already-modified workspace. */
    seedEntrypointTrust(session: McpSession): void;
    /** v4.0.3: warnings for a resumed round whose trusted baseline is absent.
     *  The workspace may already have been modified; re-capturing it would
     *  launder the change, so the round runs with the Git-delta arm only. */
    private resumeWarnings;
    /** v3.9.7: operator acceptance and branch identity travel with the session
     *  cursor (not only the held snapshot). Every prepare carries them forward;
     *  a recovery that clears the held snapshot must not reset the branch to
     *  root or lose the operator's acceptance surface. */
    private prepareOptions;
    private persistPrepared;
    /** v4.0.2: the context boundary carried by a prompt-bearing result. It is
     *  a PROJECTION of the artifact that produced the prompt — never a second
     *  derivation from live session state. */
    private contextFacts;
    /** v3.9.7: execution metadata attached to every held/prepared prompt. These
     *  are transport facts, never prompt governance content. v4.0.0: the anchor
     *  itself is the separate `submissionHandle`; this bundle owns only the
     *  checkpoint facts. */
    private transactionFacts;
    /** v4.0.0: the transport handle for the current held snapshot, or absent. */
    private heldHandle;
    /** v3.9.7: guidance facts for a redo whose restore is already verified.
     *  They are derived from the still-pending committed directive, so a
     *  restart returns the same surface as the original recovery response. */
    private pendingRecoveryGuidance;
    /** v4.0.0: return the exact stored prompt plus the CURRENT handle. This is
     *  the ONE path that re-delivers a prompt without compiling. It fails closed
     *  unless the full held predicate holds (phase, round, attempt, rendered
     *  prompt), so a committed/terminated/retrying snapshot can never masquerade
     *  as held. The warning is appended without mutating the artifact. Public so
     *  SessionManager can use it on its pre-queue stale-handle path. */
    heldPromptResult(session: McpSession, warning?: string): AdvanceResult | null;
    /** Reconcile the crash window where feedback committed but session_state
     *  still points at the old prompt. Returns null when no commit is pending.
     *  v3.7: async — the continue-after-crash branch compiles through
     *  RoundDriver.prepare (the sync prepareSync fallback was removed). */
    private reconcileCommittedRound;
    /** v3.9.7: a committed directive with no verified redo snapshot must be
     *  completed BEFORE any ordinary compile/held-prompt path. The restore and
     *  redo prepare are idempotent; a verified held redo prompt is returned
     *  without re-checking the workspace (the Agent may already have worked). */
    private completePendingRecovery;
    /** Resume tail: the session has been reconstructed and registered. Reconcile
     *  a committed-but-undelivered round, restore the held prompt, or recover a
     *  missing prompt from current round state. v3.7: async — compilation runs
     *  through RoundDriver.prepare like unpause (the prepareSync fallback was
     *  removed); a failed compile now degrades to the same stalled terminal
     *  result unpause returns instead of persisting a null prompt. */
    resume(session: McpSession): Promise<AdvanceResult>;
    /** Unpause tail: the session has been reconstructed and registered with
     *  status "running". Reconcile a committed round, restore the held prompt,
     *  or compile the next prompt from the committed window. */
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
     *           session.lastRejectionCheck */
    private executeRoundTransaction;
    /** Build a rejection result: compile a retry prompt, persist, return.
     *  MUTATES: session.roundSnapshot, session.currentPrompt, session.currentLevel */
    private buildRejectionResult;
    /** v3.9.7: the workspace/state-dir facts shared by restore preflight and
     *  execution. The state directory is never part of the restored boundary. */
    private restoreContext;
    /** Execute the committed directive's restore, verify it, then compile the
     *  redo from the SAME baseline. The directive is never rewritten. */
    private runRestoreAndPrepare;
    /** Failed restore: the directive remains pending, no prompt exists, and the
     *  session is resumable. */
    private restoreFailedResult;
    /** v2.10: Build a backtrack result. The directive is already committed;
     *  LoopForge executes and verifies the restore, then compiles the redo from
     *  the verified baseline. A failed restore leaves the directive pending and
     *  the session stalled — no redo prompt is ever issued unverified. */
    private buildBacktrackResult;
    /** v4.0.4: the ONE terminal stop-detail formatter. Live stop, termination,
     *  crash-recovered stop and resume-of-stopped read the same three fact
     *  blocks; a committed fact is described identically on every path. */
    private terminalFacts;
    /** v4.0.4: the terminal result of an already-stopped loop, built from
     *  committed history. This is the ONE read path for `resume` of a stopped
     *  loop: it reports the committed `StopReason` and renders the same three
     *  fact blocks as a live stop. A loop with no committed stop round reports
     *  the session status and says so instead of inventing a reason. */
    stoppedLoopResult(loopId: string, currentRound: number): AdvanceResult;
    /** Build a termination result: persist stopped status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt
     *
     *  v3.8.3: the enforcement gate may NAME its own stop reason (the
     *  contract-debt row terminates as `incomplete`). This used to hard-code
     *  `enforcement_terminated`, so the specific reason reached observability
     *  and the client as a generic one — the fact was computed and then thrown
     *  away. Pass it through, falling back only when the gate named nothing. */
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
     *  prompt could not be prepared/persisted. v4.0.0: the committed snapshot is
     *  NOT a held prompt, so this result carries no handle; the Agent must call
     *  `loopforge_resume`, which reconciles the commit and compiles the next
     *  prompt. Re-submitting an old handle can never resurrect the old round. */
    private stalledAfterCommit;
    private advanceUnlocked;
    /** v3.9.6: Agent-initiated recovery. The Agent selects the target; this
     *  method only validates it against committed facts, records the rollback
     *  directive and compiles the redo. It never runs ordinary verification or
     *  enforcement on the abandoned work. */
    recover(sessionId: string, recovery: RecoveryRequest): Promise<AdvanceResult>;
    /** Execute the committed directive's restore and return the redo prompt. */
    private restoreAndPrepareRedo;
    /** Core cycle entry used by SessionManager.advance after the queue + lease
     *  dance: validate → extract → execute transaction → route disposition
     *  → advance to next round (continue) or return terminal result.
     *  v4.0.0: the submission identity (the exact held transaction) is validated
     *  by SessionManager before its queue and lease heartbeat. This entry point
     *  owns the round state machine and does not re-check anchors. */
    advance(sessionId: string, output: string, preExtractedEval?: SelfEvaluation, normalizationDiagnostics?: SubmissionDiagnostic[], submittedFields?: string[]): Promise<AdvanceResult>;
    /** Write back loop knowledge to long-term memory.
     *  Uses shared base builder from policy.ts. Called when a loop terminates. */
    notifyTerminal(session: McpSession, stopReason: string): Promise<void>;
}
//# sourceMappingURL=round-lifecycle.d.ts.map