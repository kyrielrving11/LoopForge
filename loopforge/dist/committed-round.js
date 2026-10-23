/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */
import { GIT_OBSERVATION_SCHEMA_VERSION, PROMPT_ARTIFACT_SCHEMA_VERSION, makeLoopRoundResult, } from "./protocol.js";
import { ROUND_TRANSACTION_SCHEMA_VERSION, deriveRoundObservationDelta, parseRoundTransactionSnapshot, rootBranchId, transactionSchemaVersionOf, } from "./round-transaction.js";
import { claimedMetCriteria, claimedRemainingCriteria, effectiveOutcome, parseRoundContract } from "./self-eval.js";
import { entryRound, isRecord } from "./token-utils.js";
function committedAction(value) {
    return value === "continue" || value === "stop" ||
        value === "recovery" || value === "backtrack"
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
/** v3.9.1: a round is evidence-incomplete when it has no after evidence at
 *  all, or when Git was configured/appeared but either boundary is not
 *  observable. A command-only round is not incomplete merely because it has
 *  no Git observation. */
function evidenceIncomplete(after, deltas) {
    if (after.length === 0)
        return true;
    // No Git delta means Git was not part of this round. A Git delta whose
    // change set is null means the boundary pair could not be compared —
    // including a missing before baseline.
    return deltas.some((delta) => delta.kind === "git" && delta.changedFiles === null);
}
/** v3.9.1: ONE view builder over ONE transaction snapshot. Both the durable
 *  feedback entry and the engine's hydrated merged entry call it, so there is
 *  no second evaluation/history interpretation. */
function viewFromSnapshot(input) {
    const { snapshot, result, lineage } = input;
    if (snapshot.phase !== "committed")
        return null;
    const action = committedAction(result.action);
    if (!action)
        return null;
    const round = snapshot.round;
    const loopId = snapshot.loopId;
    if (round < 1 || !loopId)
        return null;
    const evaluation = snapshot.evaluation ?? null;
    const outcome = evaluation ? effectiveOutcome(evaluation) : null;
    const beforeEvidence = snapshots(snapshot.beforeEvidence);
    const afterEvidence = snapshots(snapshot.afterEvidence);
    const observationDelta = deriveRoundObservationDelta(beforeEvidence, afterEvidence);
    return {
        source: input.source,
        sourceEntry: input.sourceEntry,
        loopId,
        round,
        roundId: snapshot.roundId,
        transactionId: snapshot.transactionId,
        branchId: snapshot.branchId,
        kind: snapshot.kind,
        origin: snapshot.kind === "rollback"
            ? (snapshot.recovery?.origin ?? "machine")
            : "evaluation",
        recovery: snapshot.recovery ?? null,
        beforeCheckpoint: snapshot.beforeCheckpoint ?? null,
        checkpoints: snapshot.checkpoints ?? [],
        restore: snapshot.restore ?? null,
        operatorAcceptance: snapshot.operatorAcceptance ?? null,
        sequence: input.sequence,
        attempt: snapshot.attempt,
        promptArtifact: snapshot.promptArtifact ?? null,
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
        contractBinding: snapshot.contractBinding ?? null,
        beforeEvidence,
        afterEvidence,
        observationDelta,
        normalizationDiagnostics: snapshot.normalizationDiagnostics ?? [],
        submittedFields: snapshot.submittedFields ?? [],
        evidenceIncomplete: evidenceIncomplete(afterEvidence, observationDelta),
        outputSummary: evaluation?.output_summary,
        constraintViolations: strings(evaluation?.constraint_violations),
        discoveredConstraints: strings(evaluation?.discovered_constraints),
        activeConstraints: strings(lineage?.constraints_active),
        compiledRetirements: strings(lineage?.constraints_retired),
        retractedConstraints: strings(evaluation?.retracted_constraints),
        emergedSubtasks: strings(evaluation?.emerged_subtasks),
        subgoalUpdates: subGoalUpdates(evaluation?.subgoal_updates),
        backtrack: null,
    };
}
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
    if (!snapshot || snapshot.kind !== "evaluation")
        return null;
    const resultValue = isRecord(transaction.result)
        ? transaction.result
        : snapshot.result;
    if (!isRecord(resultValue))
        return null;
    return viewFromSnapshot({
        source: "feedback",
        sourceEntry: entry,
        lineage,
        snapshot,
        result: resultValue,
        sequence: typeof entry.sequence === "number" ? entry.sequence : undefined,
    });
}
/** v3.9.6: decode a committed rollback directive event. It is a typed event
 *  in the round document, never a normal feedback round. */
export function decodeRollbackEvent(entry) {
    if (entry.task_type !== "rollback_directive")
        return null;
    const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
    const transaction = lineage && isRecord(lineage.round_transaction)
        ? lineage.round_transaction
        : null;
    if (!transaction)
        return null;
    const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
    if (!snapshot || snapshot.kind !== "rollback" || !snapshot.recovery)
        return null;
    const resultValue = isRecord(transaction.result)
        ? transaction.result
        : snapshot.result;
    if (!isRecord(resultValue))
        return null;
    const result = resultValue;
    if (result.action !== "recovery" && result.action !== "backtrack")
        return null;
    return viewFromSnapshot({
        source: "rollback",
        sourceEntry: entry,
        lineage,
        snapshot,
        result,
        sequence: typeof entry.sequence === "number" ? entry.sequence : undefined,
    });
}
/** Decode an in-memory lineage entry after the engine merged its committed
 * feedback. The merged entry MUST carry the embedded transaction snapshot;
 * the old raw top-level evaluation reconstruction is gone, so a partial
 * lineage entry cannot become a second history. */
export function decodeMergedRound(entry) {
    if (!isRecord(entry))
        return null;
    const raw = entry;
    const lineage = isRecord(raw.loop_lineage) ? raw.loop_lineage : {};
    const action = committedAction(lineage.committed_action ?? raw.committed_action);
    if (!action)
        return null;
    const transaction = isRecord(lineage.round_transaction)
        ? lineage.round_transaction
        : isRecord(raw.round_transaction)
            ? raw.round_transaction
            : null;
    if (!transaction)
        return null;
    const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
    if (!snapshot)
        return null;
    const resultValue = isRecord(transaction.result)
        ? transaction.result
        : snapshot.result;
    if (!isRecord(resultValue))
        return null;
    return viewFromSnapshot({
        source: "merged",
        sourceEntry: raw,
        lineage,
        snapshot,
        result: resultValue,
        sequence: typeof lineage.sequence === "number" ? lineage.sequence : undefined,
    });
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
/** v3.9.6: decode either an ordinary committed round or a rollback event.
 *  The branch read model is the only caller that needs both kinds together. */
export function decodeCommittedRecord(entry) {
    return decodeRound(entry) ??
        decodeRollbackEvent(entry);
}
/** THE committed-view → compiler-request projection.
 *
 *  The compiler once received these fields from the caller's mutable
 *  `last_round_result`, which existed on the live path and was absent on
 *  resume/unpause/backtrack compiles. This projection lets one committed
 *  fact source feed every consumer. Optional declarations are read from the
 *  decoded view where it exposes them; `manual_fixes_needed` has no
 *  committed source and stays empty. */
export function roundResultFromCommittedRound(view) {
    const evaluation = view.evaluation;
    return makeLoopRoundResult({
        round: view.round,
        success: view.success,
        output_summary: evaluation?.output_summary ?? "",
        constraint_violations: [...(evaluation?.constraint_violations ?? [])],
        manual_fixes_needed: "",
        discovered_constraints: [...(view.discoveredConstraints ?? [])],
        objective_refinement: evaluation?.objective_refinement ?? "",
        emerged_subtasks: [...(view.emergedSubtasks ?? [])],
        subgoal_updates: [...(view.subgoalUpdates ?? [])],
        execution_report: view.executionReport ?? undefined,
        retracted_constraints: [...(view.retractedConstraints ?? [])],
        wrong_assumptions: [...(evaluation?.wrong_assumptions ?? [])],
        worker_results: [...(evaluation?.worker_results ?? [])],
        compression_checkpoint: evaluation?.compression_checkpoint === true,
        checkpoint_label: evaluation?.checkpoint_label ?? "",
        prompt_requests: evaluation?.prompt_requests,
        outcome: evaluation?.outcome,
        blocker: evaluation?.blocker,
        retroactiveClaims: [...(evaluation?.retroactiveClaims ?? [])],
        no_change_reason: evaluation?.no_change_reason,
    });
}
/** The ONE pending-backtrack lookup for a redo round.
 *
 *  A backtrack commits at the failed round R, while the redo targets
 *  `backtrackTarget + 1`, which is lower than R for a deep restore. Matching
 *  the decoded target (with the legacy exact-round fallback when the record
 *  carries no target) keeps the recovery boundary AND the Recovery Brief
 *  correct for every backtrack depth. */
export function pendingBacktrackRecord(entries, redoRound) {
    return pendingRollbackDirective(entries, redoRound);
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
        if (!view || (view.kind !== undefined && view.kind !== "evaluation") ||
            view.round >= beforeRound)
            continue;
        byRound.set(view.round, view);
    }
    return [...byRound.values()].sort((a, b) => a.round - b.round);
}
/** Resolve the current branch from committed branch identities. This is the
 *  only branch-fencing rule; it replaces the session frontier and every
 *  numeric/temporal approximation. */
export function resolveBranch(entries) {
    const records = entries
        .map(decodeCommittedRecord)
        .filter((view) => view !== null);
    const kindOf = (view) => view.kind ?? "evaluation";
    const first = records.find((view) => kindOf(view) === "evaluation") ?? records[0];
    if (!first) {
        return { loopId: "", branchId: "", rounds: [], directives: [], pendingDirective: null };
    }
    const loopId = first.loopId;
    const branchOf = (view) => view.branchId ?? rootBranchId(loopId);
    let branchId = rootBranchId(loopId);
    let rounds = records
        .filter((view) => kindOf(view) === "evaluation" && branchOf(view) === branchId)
        .sort((a, b) => a.round - b.round);
    const directives = [];
    const seen = new Set();
    for (;;) {
        const candidates = records
            .filter((view) => kindOf(view) === "rollback" &&
            branchOf(view) === branchId &&
            view.recovery !== null && view.recovery !== undefined)
            .sort((a, b) => a.round - b.round ||
            (a.transactionId ?? "").localeCompare(b.transactionId ?? ""));
        if (candidates.length === 0)
            break;
        // A branch closes exactly once. If corrupt data has more, the latest one
        // is the effective directive; the others remain visible in the raw log.
        const directive = candidates[candidates.length - 1];
        const directiveId = directive.transactionId ?? directive.roundId;
        if (seen.has(directiveId))
            break;
        seen.add(directiveId);
        const recovery = directive.recovery;
        // v3.9.7: the fence is the explicit redo round, not a nominal target
        // round. A before/mid checkpoint's redo round is its owning round.
        rounds = rounds.filter((view) => view.round < recovery.target.redo_round);
        const child = recovery.transaction_id;
        const childRounds = records
            .filter((view) => kindOf(view) === "evaluation" && branchOf(view) === child)
            .sort((a, b) => a.round - b.round);
        rounds = [...rounds, ...childRounds];
        directives.push(directive);
        branchId = child;
    }
    const byRound = new Map();
    for (const view of rounds)
        byRound.set(view.round, view);
    rounds = [...byRound.values()].sort((a, b) => a.round - b.round);
    let pendingDirective = null;
    const latest = directives[directives.length - 1];
    if (latest && latest.recovery) {
        const child = latest.recovery.transaction_id;
        const hasChildRound = records.some((view) => kindOf(view) === "evaluation" && branchOf(view) === child);
        if (!hasChildRound)
            pendingDirective = latest;
    }
    return { loopId, branchId, rounds, directives, pendingDirective };
}
/** v3.9.6: current-branch evaluation rounds. */
export function branchRounds(entries) {
    return resolveBranch(entries).rounds;
}
/** v3.9.6: rollback directive chain. */
export function branchDirectives(entries) {
    return resolveBranch(entries).directives;
}
/** v3.9.6: the pending directive controlling a redo round. */
export function pendingRollbackDirective(entries, redoRound) {
    const pending = resolveBranch(entries).pendingDirective;
    if (!pending?.recovery)
        return null;
    if (redoRound !== undefined && pending.recovery.target.redo_round !== redoRound) {
        return null;
    }
    return pending;
}
/** v3.9.6: machine deadlock guard. Agent-origin directives never consume it. */
export function hasCommittedMachineBacktrack(entries, currentRound) {
    return branchDirectives(entries).some((view) => {
        const recovery = view.recovery;
        return view.origin === "machine" &&
            recovery !== null && recovery !== undefined &&
            recovery.target.redo_round <= currentRound &&
            view.round >= currentRound;
    });
}
/** v3.9.6: the latest current-branch evaluation round. */
export function lastCommittedView(entries) {
    const rounds = branchRounds(entries);
    return rounds.length > 0 ? rounds[rounds.length - 1] : null;
}
/** v3.9.6: live history window = current branch below the round being
 *  compiled. `currentRound` is the round being prepared/submitted. */
export function derivationRounds(entries, currentRound = Number.POSITIVE_INFINITY) {
    return branchRounds(entries).filter((view) => view.round < currentRound);
}
/** Kept for read-only callers/tests that still inspect the persisted cursor;
 *  branch fencing no longer depends on it. */
export function persistedFrontier(entries) {
    for (const entry of entries) {
        if (!isRecord(entry) || entry.task_type !== "session_state")
            continue;
        const round = entryLineage(entry).current_round;
        return typeof round === "number" && Number.isFinite(round) && round >= 1
            ? round
            : null;
    }
    return null;
}
/** v3.9.6: read-only history = current branch rounds. No session frontier,
 *  no numeric fence, no second cursor. */
export function readOnlyRounds(entries) {
    return branchRounds(entries);
}
/** v3.9.6: read-only rollback events = committed directive chain. */
export function readOnlyRollbacks(entries) {
    return branchDirectives(entries);
}
/** The machine-evidence set that best represents a committed round: the
 *  after-phase observations (captured post-execution), else the pre-round
 *  baseline. The derived delta is never evidence — it is a change-set view
 *  over these facts, not a second observation collection. */
export function machineEvidenceForRound(view) {
    if (view.afterEvidence.length > 0)
        return view.afterEvidence;
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
                continue;
            }
        }
        // v3.9.1: an observation schema mismatch is also a hard break. The
        // transaction parser drops the whole round on it; report the loss here
        // instead of letting the round vanish from history.
        const observations = [
            ...(Array.isArray(snapshot.beforeEvidence) ? snapshot.beforeEvidence : []),
            ...(Array.isArray(snapshot.afterEvidence) ? snapshot.afterEvidence : []),
        ];
        for (const item of observations) {
            if (!isRecord(item) || typeof item.kind !== "string") {
                out.push({ round, schemaVersion: -1, envelope: "observation" });
                break;
            }
            const expected = item.kind === "git" ? GIT_OBSERVATION_SCHEMA_VERSION : 1;
            const observationVersion = item.schemaVersion;
            if (typeof observationVersion !== "number" || observationVersion !== expected) {
                out.push({
                    round,
                    schemaVersion: typeof observationVersion === "number" ? observationVersion : -1,
                    envelope: "observation",
                });
                break;
            }
        }
    }
    return out.sort((a, b) => a.round - b.round);
}
//# sourceMappingURL=committed-round.js.map