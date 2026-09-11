/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "./protocol.js";
import { ROUND_TRANSACTION_SCHEMA_VERSION, deriveRoundObservationDelta, parseRoundTransactionSnapshot, transactionSchemaVersionOf, } from "./round-transaction.js";
import { claimedMetCriteria, claimedRemainingCriteria, effectiveOutcome, parseRoundContract } from "./self-eval.js";
import { entryRound, isRecord } from "./token-utils.js";
function committedAction(value) {
    return value === "continue" || value === "stop" || value === "backtrack"
        ? value
        : null;
}
function snapshots(value) {
    return Array.isArray(value) ? value : [];
}
function flags(value) {
    return Array.isArray(value) ? value : [];
}
function roundOutcome(value) {
    return value === "success" || value === "partial" ||
        value === "failed" || value === "blocked"
        ? value
        : null;
}
function strings(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
}
function numbers(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "number")
        : [];
}
function stringMap(value) {
    if (!isRecord(value))
        return {};
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string")
            out[key] = entry;
    }
    return out;
}
/** v3.8.1: decode a rollback directive's facts from either carrier —
 *  `result.*` on a durable :feedback entry, `lineage.*` on a hydrated merged
 *  entry. Returns null when no restore point is recorded, which is also the
 *  signal that the record cannot serve as recovery guidance. */
export function decodeBacktrackRecord(source) {
    const value = isRecord(source) ? source : {};
    const target = typeof value.backtrackTarget === "number" ? value.backtrackTarget : null;
    if (target === null)
        return null;
    return {
        target,
        triggerRule: typeof value.backtrackTriggerRule === "string"
            ? value.backtrackTriggerRule
            : "",
        failedRounds: numbers(value.backtrackFailedRounds),
        approaches: strings(value.backtrackApproaches),
        wrongAssumptions: strings(value.backtrackWrongAssumptions),
        skippedFiles: strings(value.backtrackSkippedFiles),
        skippedFingerprints: stringMap(value.backtrackSkippedFingerprints),
        targetGitHead: typeof value.backtrackTargetGitHead === "string"
            ? value.backtrackTargetGitHead
            : undefined,
    };
}
/** Normalize a raw subgoal_updates value into typed entries. Decode stays
 *  tolerant of any shape (parser caps apply at ingestion; this is the
 *  read-model view of what was committed). */
function subGoalUpdates(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (typeof item !== "object" || item === null)
            continue;
        const u = item;
        if (typeof u.id !== "string")
            continue;
        const status = u.status;
        if (status !== "in_progress" && status !== "done" &&
            status !== "blocked" && status !== "canceled")
            continue;
        out.push({
            id: u.id,
            status,
            note: typeof u.note === "string" ? u.note : undefined,
        });
        if (out.length >= 20)
            break;
    }
    return out;
}
/** Decode a durable :feedback entry. Reject/terminate/in-flight envelopes are
 * not committed history and therefore do not produce a view. */
export function decodeCommittedRound(entry) {
    if (!String(entry.task_id ?? "").endsWith(":feedback"))
        return null;
    const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
    const transaction = lineage && isRecord(lineage.round_transaction)
        ? lineage.round_transaction
        : null;
    if (!transaction)
        return null;
    // v3.8: the transaction schema is a HARD break — an envelope that does not
    // parse (legacy version, malformed observations) is not committed history.
    // legacyTransactionRounds() reports the loss explicitly; it is never
    // silently decoded into a partial view.
    const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
    if (!snapshot)
        return null;
    if (snapshot.phase !== "committed")
        return null;
    const resultValue = isRecord(transaction.result)
        ? transaction.result
        : snapshot.result;
    if (!isRecord(resultValue))
        return null;
    const action = committedAction(resultValue.action);
    if (!action)
        return null;
    const result = resultValue;
    const round = snapshot?.round ?? entryRound(entry);
    const loopId = snapshot?.loopId ?? String(entry.loop_id ?? lineage?.loop_id ?? "");
    if (round < 1 || !loopId)
        return null;
    const evaluation = snapshot?.evaluation ?? null;
    const outcome = evaluation ? effectiveOutcome(evaluation) : null;
    const sequence = typeof entry.sequence === "number" ? entry.sequence : undefined;
    return {
        source: "feedback",
        sourceEntry: entry,
        loopId,
        round,
        roundId: snapshot?.roundId ?? String(transaction.round_id ?? `loop:${loopId}:round:${round}`),
        sequence,
        attempt: snapshot?.attempt ?? 1,
        promptArtifact: snapshot?.promptArtifact ?? null,
        evaluation,
        executionReport: evaluation?.execution_report ?? null,
        verificationFlags: flags(result.verificationFlags),
        result,
        action,
        success: result.roundSuccess === true,
        outcome,
        contractProposal: evaluation?.round_contract
            ? parseRoundContract(evaluation.round_contract) ?? null
            : null,
        contractBinding: snapshot?.contractBinding ?? null,
        beforeEvidence: snapshots(snapshot?.beforeEvidence),
        afterEvidence: snapshots(snapshot?.afterEvidence),
        observationDelta: deriveRoundObservationDelta(snapshots(snapshot?.beforeEvidence), snapshots(snapshot?.afterEvidence)),
        evidenceIncomplete: (snapshot?.afterEvidence?.length ?? 0) === 0,
        outputSummary: evaluation?.output_summary,
        constraintViolations: strings(evaluation?.constraint_violations),
        discoveredConstraints: strings(evaluation?.discovered_constraints),
        activeConstraints: strings(lineage?.constraints_active),
        retractedConstraints: strings(evaluation?.retracted_constraints),
        emergedSubtasks: strings(evaluation?.emerged_subtasks),
        subgoalUpdates: subGoalUpdates(evaluation?.subgoal_updates),
        backtrack: action === "backtrack" ? decodeBacktrackRecord(resultValue) : null,
    };
}
/** Decode an in-memory lineage entry after the engine merged its committed
 * feedback. The merged shape is intentionally accepted only when stamped
 * with committed_action. */
export function decodeMergedRound(entry) {
    if (!isRecord(entry))
        return null;
    const raw = entry;
    // v3.7: the legacy top-level `lineage` alias was removed — committed
    // entries always carry `loop_lineage`.
    const lineage = isRecord(raw.loop_lineage) ? raw.loop_lineage : {};
    const action = committedAction(lineage.committed_action ?? raw.committed_action);
    if (!action)
        return null;
    const round = entryRound(raw);
    if (round < 1)
        return null;
    const loopId = typeof raw.loop_id === "string"
        ? raw.loop_id
        : typeof lineage.loop_id === "string" ? lineage.loop_id : "";
    const roundId = typeof lineage.round_id === "string"
        ? lineage.round_id
        : `loop:${loopId}:round:${round}`;
    const evaluationRaw = {};
    const evaluationKeys = [
        "success", "output_summary", "constraint_violations", "should_continue",
        "discovered_constraints", "objective_refinement", "emerged_subtasks",
        "execution_report", "retracted_constraints", "revised_success_criteria",
        "wrong_assumptions", "worker_results", "compression_checkpoint",
        "checkpoint_label", "subgoal_updates", "stop_reason",
        "outcome", "blocker", "gate_ids",
        "retroactiveClaims", "no_change_reason",
        "prompt_requests", "round_contract",
    ];
    let hasEvaluation = false;
    for (const key of evaluationKeys) {
        const value = raw[key] ?? lineage[key];
        if (value !== undefined) {
            evaluationRaw[key] = value;
            hasEvaluation = true;
        }
    }
    const evaluation = hasEvaluation
        ? evaluationRaw
        : null;
    const resultRaw = isRecord(lineage.result) ? lineage.result : null;
    const result = resultRaw ? resultRaw : null;
    const outcome = roundOutcome(evaluationRaw.outcome) ??
        (typeof evaluationRaw.success === "boolean"
            ? evaluationRaw.success ? "success" : "failed"
            : null);
    const proposal = parseRoundContract(evaluationRaw.round_contract) ?? null;
    const executionReport = isRecord(evaluationRaw.execution_report)
        ? evaluationRaw.execution_report
        : null;
    return {
        source: "merged",
        sourceEntry: raw,
        loopId,
        round,
        roundId,
        sequence: typeof lineage.sequence === "number" ? lineage.sequence : undefined,
        attempt: typeof lineage.attempt === "number" ? lineage.attempt : 1,
        promptArtifact: isRecord(lineage.prompt_artifact)
            ? lineage.prompt_artifact
            : null,
        evaluation,
        executionReport,
        verificationFlags: flags(raw.verification_flags ?? lineage.verification_flags),
        result,
        action,
        success: typeof raw.success === "boolean"
            ? raw.success
            : typeof lineage.success === "boolean" ? lineage.success : false,
        outcome,
        contractProposal: proposal,
        contractBinding: isRecord(lineage.contract_binding)
            ? lineage.contract_binding
            : null,
        beforeEvidence: snapshots(lineage.before_evidence),
        afterEvidence: snapshots(lineage.after_evidence),
        observationDelta: deriveRoundObservationDelta(snapshots(lineage.before_evidence), snapshots(lineage.after_evidence)),
        evidenceIncomplete: snapshots(lineage.after_evidence).length === 0,
        outputSummary: typeof evaluationRaw.output_summary === "string"
            ? evaluationRaw.output_summary
            : undefined,
        constraintViolations: strings(evaluationRaw.constraint_violations),
        discoveredConstraints: strings(evaluationRaw.discovered_constraints),
        activeConstraints: strings(raw.constraints_active ?? lineage.constraints_active),
        retractedConstraints: strings(evaluationRaw.retracted_constraints),
        emergedSubtasks: strings(evaluationRaw.emerged_subtasks),
        subgoalUpdates: subGoalUpdates(evaluationRaw.subgoal_updates),
        backtrack: action === "backtrack" ? decodeBacktrackRecord(lineage) : null,
    };
}
/** Normalize committed history: rollback directives disappear, later records
 * replace earlier records for the same logical round, and output is ascending. */
/** Decode a committed round from either representation: an engine-hydrated
 *  merged lineage entry first (decodeMergedRound), then a durable :feedback
 *  entry. Compile-side callers used to inline this chain as a private
 *  `committedView` helper. */
export function decodeRound(entry) {
    return decodeMergedRound(entry) ?? decodeCommittedRound(entry);
}
/** Lineage sub-object of an entry (`loop_lineage`; v3.7: the legacy
 *  top-level `lineage` alias was removed), or {} when absent. */
export function entryLineage(entry) {
    if (!isRecord(entry))
        return {};
    const value = entry.loop_lineage;
    return isRecord(value) ? value : {};
}
/** Extract execution_report from an entry, handling both direct-field and
 *  lineage-nested shapes. The decoded committed view wins when the entry is
 *  a committed round. Returns null when absent. Moved from loop-compiler so
 *  field-shape interpretation lives in this module only. */
export function entryExecutionReport(entry) {
    const view = decodeRound(entry);
    if (view)
        return view.executionReport;
    const record = isRecord(entry) ? entry : {};
    const direct = record.execution_report;
    if (isRecord(direct))
        return direct;
    const nested = entryLineage(entry).execution_report;
    return isRecord(nested) ? nested : null;
}
/** Read the criteria the agent claimed met from an entry's execution_report. */
export function entryCriteriaMet(entry) {
    const view = decodeRound(entry);
    if (view)
        return claimedMetCriteria(view.executionReport);
    const ev = entryExecutionReport(entry);
    if (!ev)
        return [];
    return rawCriterionClaims(ev, "met");
}
/** Read the criteria the agent declared outstanding from an entry. */
export function entryCriteriaRemaining(entry) {
    const view = decodeRound(entry);
    if (view)
        return claimedRemainingCriteria(view.executionReport);
    const ev = entryExecutionReport(entry);
    if (!ev)
        return [];
    return rawCriterionClaims(ev, "remaining");
}
/** Shape-tolerant reader for a raw entry's criterion claims (the durable
 *  shape, before the typed parse). */
function rawCriterionClaims(report, outcome) {
    const claims = report.criterion_claims;
    if (!Array.isArray(claims))
        return [];
    return claims
        .filter(isRecord)
        .filter((claim) => claim.outcome === outcome && typeof claim.criterion_id === "string")
        .map((claim) => claim.criterion_id);
}
/** Read constraints_active from an entry's lineage. */
export function entryActiveConstraints(entry) {
    const view = decodeRound(entry);
    if (view)
        return view.activeConstraints ?? [];
    const arr = entryLineage(entry).constraints_active;
    return Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
}
/** Read retracted_constraints from an entry (direct field, else nested in
 *  the lineage). */
export function entryRetractedConstraints(entry) {
    const view = decodeRound(entry);
    if (view)
        return view.retractedConstraints ?? [];
    const record = isRecord(entry) ? entry : {};
    const direct = record.retracted_constraints;
    if (Array.isArray(direct))
        return direct.filter((v) => typeof v === "string");
    const nested = entryLineage(entry).retracted_constraints;
    if (Array.isArray(nested))
        return nested.filter((v) => typeof v === "string");
    return [];
}
/** Read progress_estimate from an entry's execution_report (0 when
 *  absent). */
export function entryProgressEstimate(entry) {
    const ev = entryExecutionReport(entry);
    if (!ev)
        return 0;
    const pe = ev.progress_estimate;
    return typeof pe === "number" ? pe : 0;
}
/** Read emerged_subtasks from an entry (handles direct + lineage nesting). */
export function entryEmergedSubtasks(entry) {
    const view = decodeRound(entry);
    if (view)
        return view.emergedSubtasks ?? [];
    const record = isRecord(entry) ? entry : {};
    const direct = record.emerged_subtasks;
    if (Array.isArray(direct))
        return direct.filter((v) => typeof v === "string");
    const nested = entryLineage(entry).emerged_subtasks;
    if (Array.isArray(nested))
        return nested.filter((v) => typeof v === "string");
    return [];
}
/** Read subgoal_updates from an entry (handles direct + lineage nesting).
 *  v3.7.1: committed status transitions are replayed in round order by the
 *  compiler — every derivation replays ALL committed rounds, not just the
 *  last one. */
export function entrySubGoalUpdates(entry) {
    const view = decodeRound(entry);
    if (view)
        return view.subgoalUpdates ?? [];
    const record = isRecord(entry) ? entry : {};
    const direct = record.subgoal_updates;
    if (Array.isArray(direct))
        return subGoalUpdates(direct);
    const nested = entryLineage(entry).subgoal_updates;
    if (Array.isArray(nested))
        return subGoalUpdates(nested);
    return [];
}
/** Read constraint_violations from an entry (entry-level, stored from the
 *  previous round's last_round_result at persist time — distinct from the
 *  evaluation-level violations on the committed view). Moved from
 *  verification-gate so lineage-shape reads live in this module only. */
export function entryViolations(entry) {
    const record = isRecord(entry) ? entry : {};
    const viols = record.constraint_violations;
    if (Array.isArray(viols))
        return viols.filter((v) => typeof v === "string");
    return [];
}
export function historyRounds(views, beforeRound = Number.POSITIVE_INFINITY) {
    const byRound = new Map();
    for (const view of views) {
        if (!view || view.action === "backtrack" || view.round >= beforeRound)
            continue;
        byRound.set(view.round, view);
    }
    return [...byRound.values()].sort((a, b) => a.round - b.round);
}
/** v3.8.1: the ONE committed-history window every derivation reads.
 *
 * `decodeRound` (hydrated merged lineage first, then the durable feedback
 * entry) plus the rollback handling in `historyRounds` — so the compile path,
 * the projection, the live coordinator, audit and explain can no longer
 * disagree about which rounds are this branch's history, nor about how their
 * envelope was interpreted.
 *
 * `currentRound` bounds the window exactly as before (default: unbounded). It
 * is NOT a rollback fence: the redo re-commits the round numbers the abandoned
 * rounds occupied, so abandonment is temporal, not numeric, and cannot be
 * expressed as a bound here. */
export function derivationRounds(entries, currentRound = Number.POSITIVE_INFINITY) {
    return historyRounds(entries.map(decodeRound), currentRound);
}
/** The machine-evidence set that best represents a committed round: the
 *  after-phase observations (captured post-execution), else the derived round
 *  delta, else the pre-round baseline. Shared selector for the
 *  evidence-fallback chains that audit, claims, and backtrack-restore each
 *  used to inline with subtly different tiers. Distinct from
 *  machineGitMotionSeries, which deliberately reads the delta alone for the
 *  motion signal. */
export function machineEvidenceForRound(view) {
    if (view.afterEvidence.length > 0)
        return view.afterEvidence;
    if (view.observationDelta.length > 0)
        return view.observationDelta;
    return view.beforeEvidence;
}
export function legacyTransactionRounds(entries) {
    const out = [];
    for (const entry of entries) {
        if (!isRecord(entry))
            continue;
        const lineage = entryLineage(entry);
        const envelope = isRecord(lineage.round_transaction)
            ? lineage.round_transaction
            : isRecord(entry.round_transaction) ? entry.round_transaction : null;
        if (!envelope || !isRecord(envelope.snapshot))
            continue;
        const round = entryRound(entry);
        if (round < 1)
            continue;
        const version = transactionSchemaVersionOf(envelope.snapshot);
        if (version !== null && version !== ROUND_TRANSACTION_SCHEMA_VERSION) {
            out.push({ round, schemaVersion: version, envelope: "transaction" });
            continue;
        }
        // v3.8.1: the PromptArtifact schema is versioned separately, and the
        // transaction parser rejects a snapshot whose artifact version it does
        // not know — dropping the whole round. Reporting only the transaction
        // version would let an artifact-version break delete committed history
        // silently, which is the one thing this function exists to prevent.
        const snapshot = envelope.snapshot;
        if (isRecord(snapshot.promptArtifact)) {
            const artifactVersion = snapshot.promptArtifact.schemaVersion;
            if (typeof artifactVersion === "number" &&
                artifactVersion !== PROMPT_ARTIFACT_SCHEMA_VERSION) {
                out.push({ round, schemaVersion: artifactVersion, envelope: "prompt_artifact" });
            }
        }
    }
    return out.sort((a, b) => a.round - b.round);
}
/** Machine-observed git motion for the most recent contiguous window.
 * Consumers must decode durable or hydrated entries before calling this;
 * transaction-envelope interpretation stays confined to this module. */
export function machineGitMotionSeries(rounds, currentRound, lookback) {
    const byRound = new Map();
    for (const round of rounds) {
        if (round.round < 1 || round.round >= currentRound)
            continue;
        const git = round.observationDelta.find((snapshot) => snapshot.providerId === "git");
        if (!git)
            continue;
        byRound.set(round.round, Array.isArray(git.files) && git.files.length > 0);
    }
    if (byRound.size < lookback)
        return null;
    const recent = [...byRound.keys()].sort((a, b) => a - b).slice(-lookback);
    if (recent[0] < currentRound - lookback)
        return null;
    return recent.map((round) => byRound.get(round));
}
//# sourceMappingURL=committed-round.js.map