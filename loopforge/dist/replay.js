/** ReplayBackend — time-travel queries over committed rounds.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Every query loads the same committed history once and reads the branch's
 * `CommittedRoundView`s; there is no second decode pass and no synthesized
 * lineage-shaped entry.
 */
import { loadCommittedHistory } from "./history.js";
import { deriveRoundProgress } from "./progress.js";
import { deriveOpenQuestionId } from "./open-question.js";
import { gitRoundFacts } from "./git-facts.js";
import { deriveFindingId } from "./token-utils.js";
export const REPLAY_DEFAULT_ROUNDS = 10;
export const REPLAY_MAX_WINDOW_ROUNDS = 50;
const REPORT_DISPLAY_CHARS = 4000;
const ASSUMPTION_DISPLAY_CHARS = 500;
const QUESTION_DISPLAY_CHARS = 300;
const BLOCKER_DISPLAY_CHARS = 500;
const REDIRECT_REASON_DISPLAY_CHARS = 500;
const WORKER_DISPLAY_CHARS = 500;
const RETROACTIVE_DISPLAY_CHARS = 500;
const SUBTASK_LABEL_DISPLAY_CHARS = 200;
/** Invalid explicit replay window. The MCP boundary maps this to
 *  `invalid_argument`. */
export class ReplayWindowError extends Error {
    code = "invalid_argument";
    constructor(message) {
        super(message);
        this.name = "ReplayWindowError";
    }
}
function displayed(value, maxChars) {
    const text = value ?? "";
    if (text.length <= maxChars)
        return { text, truncated: false };
    return { text: text.slice(0, maxChars), truncated: true };
}
function displayedList(values, maxChars) {
    let truncated = false;
    const out = (values ?? []).map((value) => {
        const clipped = displayed(value, maxChars);
        truncated ||= clipped.truncated;
        return clipped.text;
    });
    return { values: out, truncated };
}
/** Resolve an explicit/default window over the committed evaluation rounds.
 *
 *  - no start/end: the last 10 committed rounds;
 *  - both: the inclusive range, at most 50 rounds wide;
 *  - start only: start..latest, at most 50 rounds wide;
 *  - end only: the 50-round window ending at `end`.
 */
function resolveWindow(rounds, legacyRounds, opts) {
    const positions = [...new Set([
            ...rounds.map((view) => view.round),
            ...legacyRounds.map((round) => round.round),
        ])].sort((a, b) => a - b);
    const totalRounds = positions.length;
    const latest = positions.length > 0 ? positions[positions.length - 1] : 0;
    const validatePositive = (value, name) => {
        if (value === undefined)
            return;
        if (!Number.isInteger(value) || value < 1) {
            throw new ReplayWindowError(`${name} must be a positive integer`);
        }
    };
    validatePositive(opts?.start, "start");
    validatePositive(opts?.end, "end");
    if (opts?.start !== undefined && opts?.end !== undefined &&
        opts.start > opts.end) {
        throw new ReplayWindowError("start must be <= end");
    }
    if (opts?.start !== undefined && opts?.end !== undefined &&
        opts.end - opts.start + 1 > REPLAY_MAX_WINDOW_ROUNDS) {
        throw new ReplayWindowError(`an explicit replay window may span at most ${REPLAY_MAX_WINDOW_ROUNDS} rounds`);
    }
    let from;
    let to;
    if (opts?.start === undefined && opts?.end === undefined) {
        // Count-based default over the round POSITIONS that exist, including
        // legacy envelopes: an unsupported schema must stay visible rather than
        // fall outside a window derived only from parseable rounds.
        const windowPositions = positions.slice(-REPLAY_DEFAULT_ROUNDS);
        from = windowPositions[0] ?? 0;
        to = windowPositions.at(-1) ?? 0;
    }
    else if (opts?.start !== undefined && opts?.end !== undefined) {
        from = opts.start;
        to = opts.end;
    }
    else if (opts?.start !== undefined) {
        from = opts.start;
        to = latest;
        if (latest >= from && to - from + 1 > REPLAY_MAX_WINDOW_ROUNDS) {
            throw new ReplayWindowError(`an explicit replay window may span at most ${REPLAY_MAX_WINDOW_ROUNDS} rounds`);
        }
    }
    else {
        to = opts.end;
        from = Math.max(1, to - REPLAY_MAX_WINDOW_ROUNDS + 1);
    }
    const inWindowPositions = positions.filter((position) => position >= from && position <= to);
    const window = {
        start: inWindowPositions[0] ?? 0,
        end: inWindowPositions.at(-1) ?? 0,
        totalRounds,
        hasBefore: positions.some((position) => position < from),
        hasAfter: positions.some((position) => position > to),
    };
    return { from, to, window };
}
// ═══════════════════════════════════════════════════════════════════════════
// ReplayBackend
// ═══════════════════════════════════════════════════════════════════════════
export class ReplayBackend {
    store;
    constructor(store) {
        this.store = store;
    }
    // ── Single-round lookup ────────────────────────────────────────────────
    getRound(loopId, roundNum) {
        const history = loadCommittedHistory(this.store, loopId);
        return history.rounds.find((view) => view.kind === "evaluation" && view.round === roundNum) ?? null;
    }
    // ── Multi-round replay ─────────────────────────────────────────────────
    replay(loopId, opts) {
        const start = opts?.start ?? 1;
        const end = opts?.end ?? Number.POSITIVE_INFINITY;
        return loadCommittedHistory(this.store, loopId).rounds.filter((view) => view.kind === "evaluation" && view.round >= start && view.round <= end);
    }
    // ── Timeline ──────────────────────────────────────────────────────────
    /** v4.0.2: the paged timeline. The returned `window` tells the Agent
     *  whether more committed rounds exist before/after this page. */
    page(loopId, opts) {
        const history = loadCommittedHistory(this.store, loopId);
        const rounds = history.rounds.filter((view) => view.kind === "evaluation");
        const { from, to, window } = resolveWindow(rounds, history.legacyRounds, opts);
        const timeline = [];
        for (const view of rounds) {
            if (view.round < from || view.round > to)
                continue;
            // v4.0.3: ONE Git fact set per row, from the union selector.
            const git = gitRoundFacts(view.observationDelta);
            // v3.9.9: replay is a display surface, so it selects every fact. The
            // per-fact list below makes the coverage of each fact visible.
            const progress = deriveRoundProgress(view.observationDelta);
            const progressFacts = view.observationDelta
                .filter((delta) => delta.progress !== null)
                .map((delta) => ({
                kind: delta.progress.kind,
                providerId: delta.providerId,
                coverage: delta.progress.coverage,
                state: delta.progress.state,
                complete: delta.progress.complete,
            }));
            const report = displayed(view.evaluation?.output_summary, REPORT_DISPLAY_CHARS);
            const wrongAssumptions = displayedList(view.evaluation?.wrong_assumptions, ASSUMPTION_DISPLAY_CHARS);
            const retractedConstraints = displayedList(view.retractedConstraints, ASSUMPTION_DISPLAY_CHARS);
            const openQuestions = displayedList(view.openQuestions, QUESTION_DISPLAY_CHARS);
            const blocker = displayed(view.evaluation?.blocker, BLOCKER_DISPLAY_CHARS);
            const redirectReason = displayed(view.contractTransition?.reason, REDIRECT_REASON_DISPLAY_CHARS);
            const noChangeReason = displayed(view.evaluation?.no_change_reason, BLOCKER_DISPLAY_CHARS);
            const subtaskLabel = displayed(view.evaluation?.subtask_boundary_label, SUBTASK_LABEL_DISPLAY_CHARS);
            const workerResults = (view.evaluation?.worker_results ?? []).map((worker) => ({
                agent_id: worker.agentId.slice(0, SUBTASK_LABEL_DISPLAY_CHARS),
                sub_task: displayed(worker.subTask, WORKER_DISPLAY_CHARS).text,
                result_summary: displayed(worker.resultSummary, WORKER_DISPLAY_CHARS).text,
                outcome: worker.outcome,
            }));
            const retroactiveClaims = (view.evaluation?.retroactiveClaims ?? [])
                .map((claim) => ({
                round: claim.round,
                claim: displayed(claim.claim, RETROACTIVE_DISPLAY_CHARS).text,
            }));
            const subgoalUpdates = (view.subgoalUpdates ?? []).map((update) => ({
                id: update.id,
                status: update.status,
                ...(update.note !== undefined
                    ? { status_note: update.note.slice(0, 300) }
                    : {}),
            }));
            const commandStatuses = view.observationDelta
                .filter((delta) => delta.kind === "command")
                .map((delta) => ({
                command_id: delta.after?.kind === "command"
                    ? delta.after.data.commandId
                    : delta.providerId,
                status: delta.after?.status ?? null,
            }));
            const checkpoints = [
                ...(view.beforeCheckpoint ? [view.beforeCheckpoint] : []),
                ...view.checkpoints,
            ].map((ref) => ({
                checkpoint_id: ref.checkpointId,
                role: ref.role,
                round: ref.round,
                content_hash: ref.contentHash,
            }));
            timeline.push({
                round: view.round,
                attempt: view.attempt,
                recompile_level: view.promptArtifact?.level ?? "l2",
                // v4.0.2: the context boundary is a committed artifact fact.
                context_mode: view.promptArtifact?.contextMode ?? null,
                context_reason: view.promptArtifact?.contextReason ?? null,
                // v4.0.3: Agent claims are named as claims. The machine facts are
                // separate and come from the persisted posture.
                agent_success_claim: view.agentSuccessClaim,
                agent_outcome: view.agentOutcome,
                machine_backed_success: view.evidencePosture?.machineBackedSuccess ?? false,
                evidence_posture: view.evidencePosture,
                // v4.0.1: task and goal identity are compile facts stamped at commit.
                task: view.compiled?.task ?? "",
                goal_id: view.compiled?.goalId ?? "",
                // v4.0.2/v4.0.3: the committed Agent report, bounded for display.
                // `success` is not duplicated here: the row already names the claim.
                report: view.evaluation
                    ? {
                        output_summary: report.text,
                        no_change_reason: noChangeReason.text || null,
                        blocker: view.evaluation.blocker ? blocker.text : null,
                        subtask_boundary_label: subtaskLabel.text || null,
                        worker_results: workerResults,
                        retroactive_claims: retroactiveClaims,
                        gate_ids: [...(view.evaluation.gate_ids ?? [])],
                        subgoal_updates: subgoalUpdates,
                        truncated: report.truncated ||
                            noChangeReason.truncated ||
                            blocker.truncated ||
                            subtaskLabel.truncated,
                    }
                    : null,
                wrong_assumptions: wrongAssumptions.values,
                retracted_constraints: retractedConstraints.values,
                open_questions: openQuestions.values,
                open_question_ids: (view.openQuestions ?? []).map(deriveOpenQuestionId),
                resolved_open_question_ids: view.resolvedOpenQuestionIds ?? [],
                blocker: view.evaluation?.blocker ? blocker.text : null,
                // v3.9.1/v4.0.3: the shared round delta and Git boundary facts, from
                // the union selector (never the first Git delta).
                files_changed: git.changedFiles,
                git_change_state: git.state,
                head_before: git.headBefore,
                head_after: git.headAfter,
                git_status: git.status,
                // v4.0.3: finding ids are the stable repair handles.
                verification_flag_ids: view.verificationFlags.map(deriveFindingId),
                verification_checks: view.verificationFlags.map((flag) => ({
                    check: flag.check,
                    severity: flag.severity,
                    ref: flag.ref ?? null,
                })),
                command_statuses: commandStatuses,
                checkpoints,
                restore_verified: view.restore !== null,
                restore: view.restore
                    ? {
                        directive_transaction_id: view.restore.directiveTransactionId,
                        redo_round: view.restore.redoRound,
                        verified_at: view.restore.verifiedAt,
                    }
                    : null,
                // v3.9.7: the shared per-round progress verdict. Window verdicts are
                // not committed facts; this is the only progress value a round owns.
                machine_progress: progress?.state ?? null,
                progress_providers: progress?.providers ?? [],
                progress_coverages: progress?.coverages ?? [],
                progress_facts: progressFacts,
                // v3.5: the round's declared contract (proposal for the next round),
                // when it committed one — lets replay show the contract arc.
                ...(view.contractProposal ? { proposal: view.contractProposal } : {}),
                // v3.9.9/v4.0.2: the committed redirect, report-only.
                contract_redirect: view.contractTransition
                    ? {
                        kind: view.contractTransition.kind,
                        contract_id: view.contractTransition.contract_id,
                        ...(view.contractTransition.reason !== undefined
                            ? { reason: redirectReason.text }
                            : {}),
                    }
                    : null,
                // Display-only truncation facts for the bounded report lists.
                report_truncated: report.truncated ||
                    wrongAssumptions.truncated ||
                    retractedConstraints.truncated ||
                    openQuestions.truncated ||
                    blocker.truncated ||
                    redirectReason.truncated ||
                    noChangeReason.truncated ||
                    subtaskLabel.truncated,
                truncation: {
                    output_summary: report.truncated,
                    wrong_assumptions: wrongAssumptions.truncated,
                    retracted_constraints: retractedConstraints.truncated,
                    open_questions: openQuestions.truncated,
                    blocker: blocker.truncated,
                    redirect_reason: redirectReason.truncated,
                    no_change_reason: noChangeReason.truncated,
                    subtask_boundary_label: subtaskLabel.truncated,
                },
            });
        }
        // Unsupported envelope versions are NOT history. Keep them visible in the
        // timeline instead of letting the loop look shorter than it was.
        for (const legacy of history.legacyRounds) {
            if (legacy.round < from || legacy.round > to)
                continue;
            timeline.push({
                round: legacy.round,
                legacy: true,
                envelope: legacy.envelope,
                schema_version: legacy.schemaVersion,
            });
        }
        timeline.sort((a, b) => a.round - b.round);
        return { timeline, window };
    }
    /** Backwards-compatible array view. Defaults to the same bounded page. */
    timeline(loopId, opts) {
        return this.page(loopId, opts).timeline;
    }
    /** v3.9.1: explicit legacy-envelope report for the tool envelope. */
    legacyRounds(loopId) {
        return loadCommittedHistory(this.store, loopId).legacyRounds;
    }
}
//# sourceMappingURL=replay.js.map