/** v3.8/v4.0.3: `loopforge explain` — the per-round "why" view.
 *
 * Read-only projection over the shared read model: committed round views,
 * the persisted evidence posture, machine observations, verification flags,
 * checkpoints/restore markers and the committed enforcement result. It never
 * rebuilds history and never writes.
 *
 * v4.0.3: the view exposes the FULL command observations (before and after)
 * with truncation metadata, so replay/explain are the complete-observation
 * read surfaces the prompt intentionally points at.
 */
import type { EvidencePosture, PromptContextMode, PromptContextReason, RoundOutcome, StopReason, SubmissionReceipt } from "./protocol.js";
import type { VaultEntry } from "./loop-store.js";
export interface ExplainObservation {
    providerId: string;
    kind: string;
    phase: string;
    status: string;
    files: string[];
    /** Full machine data. Command observations carry argv/exit/streams/etc. */
    data: Record<string, unknown>;
}
export interface ExplainCheckpoint {
    checkpoint_id: string;
    role: "before" | "mid";
    round: number;
    content_hash: string;
}
export interface ExplainRound {
    round: number;
    roundId: string;
    attempt: number;
    /** Optional transaction/branch identity: a redo may reuse the same numeric
     *  round on a child branch, and these are what distinguish it. */
    branchId?: string;
    transactionId?: string;
    action: string;
    /** v4.0.4: LoopForge's committed terminal reason, when the round stopped the
     *  loop. Renamed from `stopReason` so it cannot be read as the Agent's
     *  `agent_stop_reason`. */
    loopStopReason: StopReason | null;
    /** v4.0.3: the Agent's claim (never a machine verdict). */
    agentSuccessClaim: boolean;
    /** v4.0.3: the effective Agent-declared outcome. */
    agentOutcome: RoundOutcome | null;
    /** v4.0.4: the raw `evaluation.outcome`; null means it was derived from
     *  `success`, not declared. */
    agentOutcomeDeclared: RoundOutcome | null;
    /** v4.0.4: the Agent's declared stop reason (an Agent report). */
    agentStopReason: "gave_up" | "blocked" | "needs_human_input" | null;
    /** v4.0.4: the Agent's declared should_continue. */
    agentShouldContinue: boolean | null;
    /** v4.0.3: the ONE persisted posture. `machineBackedSuccess` lives only
     *  inside it; Explain no longer repeats it at the top level. */
    evidencePosture: EvidencePosture | null;
    /** v4.0.4: the committed enforcement reason, when one was recorded. */
    enforcementReason: string | null;
    /** v4.0.2: the committed context boundary this round was compiled under. */
    context: {
        mode: PromptContextMode;
        reason: PromptContextReason;
    } | null;
    /** The agent's own report, quoted back for audit. Present whenever the
     *  committed evaluation exists, even without an execution_report. */
    report: {
        output_summary: string;
        no_change_reason: string | null;
        subtask_boundary_label: string | null;
        criterion_claims: Array<{
            criterion_id: string;
            outcome: string;
        }>;
        contract_item_claims: Array<{
            item_id: string;
            outcome: string;
        }>;
        worker_results: Array<{
            agent_id: string;
            sub_task: string;
            result_summary: string;
            outcome: string;
        }>;
        retroactive_claims: Array<{
            round: number;
            claim: string;
        }>;
        gate_ids: string[];
        subgoal_updates: Array<{
            id: string;
            status: string;
            status_note?: string;
        }>;
        /** v4.0.3: the remaining Agent report fields, bounded for display. */
        constraint_violations: string[];
        discovered_constraints: string[];
        emerged_subtasks: string[];
        truncated: Record<string, boolean>;
    } | null;
    /** v4.0.2: committed Agent reports, bounded for display. */
    wrongAssumptions: string[];
    retractedConstraints: string[];
    openQuestions: string[];
    openQuestionIds: string[];
    resolvedOpenQuestionIds: string[];
    blocker: string | null;
    /** v4.0.3: BOTH sides of the round boundary, with full command data. */
    observations: {
        before: ExplainObservation[];
        after: ExplainObservation[];
    };
    /** The derived before→after delta — never persisted. */
    observationDelta: Array<{
        providerId: string;
        kind: string;
        changedFiles: string[] | null;
        beforeStatus: string | null;
        afterStatus: string | null;
        progress: {
            kind: "git" | "custom";
            coverage: {
                domain: string;
                object: string;
                scope: string;
                version: number;
            };
            state: "changed" | "unchanged" | "unknown";
            complete: boolean;
            detail?: string;
        } | null;
    }>;
    /** v3.9.1: the Git boundary facts, from the shared union selector. */
    files_changed: string[] | null;
    git_change_state: "not_applicable" | "unknown" | "observed";
    head_before: string | null;
    head_after: string | null;
    git_status: string | null;
    coverage: string | null;
    /** v3.9.7: the committed checkpoints and verified-restore marker. */
    checkpoints: ExplainCheckpoint[];
    restore: {
        directive_transaction_id: string;
        redo_round: number;
        verified_at: number;
    } | null;
    restore_verified: boolean;
    /** v3.9.1: the committed submission's receipt (same derivation as status). */
    submission: SubmissionReceipt;
    /** True when the round committed without a complete observable boundary. */
    evidenceIncomplete: boolean;
    /** Committed verification findings. */
    flags: Array<{
        check: string;
        severity: string;
        detail: string;
        ref?: string;
    }>;
    /** The contract the round executed under, and every item's derived status. */
    contract: {
        id: string;
        declared_at_round: number;
        closure: string;
        items: Array<{
            itemId: string;
            status: string;
            reasons: string[];
        }>;
    } | null;
    /** v4.0.3: this round's explicit contract redirect, report-only. */
    contractRedirect: {
        kind: "supersede";
        contract_id: string;
        reason?: string;
    } | null;
    /** Per-field clipping metadata. A true value means the displayed text is a
     *  bounded excerpt, never the committed original. */
    truncated: Record<string, boolean>;
}
export interface ExplainRollback {
    round: number;
    transactionId: string;
    origin: "agent" | "machine";
    redoRound: number;
    targetCheckpointId: string;
    reason: string;
    observedSkippedFiles: string[];
    reportedSkippedFiles: string[];
    /** Union of observed + reported. */
    skippedFiles: string[];
    abandonedRounds: number[];
    failedRounds: number[];
    approaches: string[];
    wrongAssumptions: string[];
    /** v4.0.3: Agent reports preserved by the rollback. */
    preservedDiscoveries: string[];
    triggerFindings: Array<{
        check: string;
        severity: string;
        field: string;
        detail: string;
        ref?: string;
    }>;
}
export interface ExplainResult {
    loopId: string;
    /** Only the requested round when `round` was given. */
    rounds: ExplainRound[];
    /** The contract active for the NEXT round (derived), when one exists. */
    activeContract: {
        id: string;
        work_item?: string;
        itemCount: number;
    } | null;
    /** v3.9.6: committed rollback directives as events, never normal rounds. */
    rollbacks: ExplainRollback[];
    /** v4.0.4: rounds whose persisted envelope is an unsupported schema. They
     *  are NOT decoded into fake round rows; the count makes the loss visible
     *  instead of showing a silently empty timeline. */
    legacyRounds: number;
}
/** Build the explain view. Pure and read-only.
 *
 *  `legacyRounds` is the loader's explicit legacy count
 *  (`loadCommittedHistory(...).legacyRounds.length`); it is passed through so
 *  Explain never re-scans for it and never migrates it. */
export declare function buildExplain(loopId: string, entries: VaultEntry[], round?: number, legacyRounds?: number): ExplainResult;
/** Human-readable rendering of the explain view (CLI default).
 *
 *  v4.0.4: every round renders the three fact blocks (Agent report,
 *  LoopForge decision, Machine evidence) through `renderResultFacts`, then the
 *  detailed audit rows. Agent claims are labelled `(Agent report)`, the
 *  machine evidence is rendered ONLY by the shared posture formatter, and the
 *  commit-time contract snapshot is labelled separately from the derived
 *  current status. No "changed"/"conflict" boolean is derived here. */
export declare function renderExplain(result: ExplainResult): string;
//# sourceMappingURL=explain.d.ts.map