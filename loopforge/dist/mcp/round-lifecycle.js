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
import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { LoopForgeEngine } from "../engine.js";
import { deriveGate } from "../cognitive-governance.js";
import { makeLoopObjective, } from "../protocol.js";
import { captureEntrypointTrust } from "../evidence-provider.js";
import { deriveRoundObservationDelta, deriveTransactionId, parseRoundTransactionSnapshot, rootBranchId, } from "../round-transaction.js";
import { deriveActiveRoundContract } from "../round-contract.js";
import { deriveSubGoals } from "../subgoal-state.js";
import { declaresBlocked, effectiveOutcome } from "../round-outcome.js";
import { deriveCommittedSubmissionView, deriveSubmissionReceipt, } from "../submission-receipt.js";
import { rollbackEvidencePosture } from "../evidence-posture.js";
import { RoundDriver } from "../round-driver.js";
import { deriveRecoveryDirective, findCheckpointRef, validateCheckpointManifest, } from "../recovery.js";
import { executeRestore, preflightRestore, RestoreFailure, } from "../workspace-restore.js";
import { resolveStateDirectory } from "../policy.js";
import { finalizeStopReason } from "../round-coordinator.js";
import { getPolicy } from "../policy.js";
import { checkRoundSequence } from "../loop-store.js";
import { branchRounds } from "../committed-round.js";
import { historyWindow, loadCommittedHistory, } from "../history.js";
import { deriveSubmissionGuidance } from "../submission-guidance.js";
import { latestObjective } from "../loop-compiler.js";
import { heldPromptSnapshot, makeSubmissionHandle, } from "./submission-handle.js";
import { logEvent } from "../observability.js";
import { policyMetrics } from "../policy-metrics.js";
import { SessionLeaseConflictError } from "../storage.js";
import { isRecord, normalizeText } from "../token-utils.js";
import { ProjectionCoverageError } from "../prompt-coverage.js";
import { CompileFailureError, LegacyHistoryError } from "../errors.js";
import { renderResultFacts } from "../result-facts.js";
// ── Types ──────────────────────────────────────────────────────────────────
/** M3: parse a persisted skipped-file fingerprint map (string → string).
 *  Lenient by design — v3.8.3 reuses it for the entrypoint trust baseline,
 *  where a corrupt or absent entry must degrade to "no baseline for that
 *  file", never fail the round that would carry it. */
function parseFingerprintMap(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const out = {};
    for (const [file, fp] of Object.entries(value)) {
        if (typeof fp === "string")
            out[file] = fp;
    }
    return out;
}
/** Parse the session's operator-acceptance cursor leniently. A corrupt copy
 *  degrades to the committed root transaction; it never invents criteria. */
function parseOperatorAcceptance(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.task !== "string" ||
        !Array.isArray(value.success_criteria) ||
        !value.success_criteria.every((item) => typeof item === "string") ||
        !Array.isArray(value.hard_constraints) ||
        !value.hard_constraints.every((item) => typeof item === "string")) {
        return undefined;
    }
    return value;
}
/** v4.0.5: a structural defect in invocation input. The MCP handlers map this
 *  to `invalid_argument`; it is never a policy or round defect. */
export class InvocationInputError extends Error {
    code = "invalid_argument";
}
/** v4.0.5: normalize the invocation instruction at the transport boundary.
 *  `undefined`/absent stays absent ("not provided"); non-string or
 *  empty/whitespace is a structural defect. The trimmed text is stored
 *  verbatim — no case folding, no internal-whitespace folding. */
export function normalizeCurrentUserInstruction(raw) {
    if (raw === undefined || raw === null)
        return undefined;
    if (typeof raw !== "string") {
        throw new InvocationInputError("currentUserInstruction must be a non-empty string");
    }
    const text = raw.trim();
    if (text.length === 0) {
        throw new InvocationInputError("currentUserInstruction must be a non-empty string");
    }
    return text;
}
/** v4.0.5: normalize a whole transport input bundle before any state is read
 *  or mutated. */
export function normalizeInvocationInputs(inputs) {
    if (!inputs)
        return undefined;
    const instruction = normalizeCurrentUserInstruction(inputs.currentUserInstruction);
    if (instruction === undefined && inputs.currentUserInstruction === undefined) {
        return inputs;
    }
    return { ...inputs, currentUserInstruction: instruction };
}
/** v3.9.4: a structural defect in the start criteria argument. The MCP
 *  handler maps this to `invalid_argument`; it is never a policy defect. */
export class StartCriteriaError extends Error {
    code = "invalid_argument";
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
export function normalizeStartCriteria(raw) {
    if (raw === undefined)
        return { criteria: [], warnings: [] };
    if (!Array.isArray(raw)) {
        throw new StartCriteriaError("criteria must be an array of non-empty strings");
    }
    const values = [];
    let empty = 0;
    for (const entry of raw) {
        if (typeof entry !== "string") {
            throw new StartCriteriaError("criteria entries must be strings");
        }
        const text = entry.trim();
        if (!text) {
            empty++;
            continue;
        }
        values.push(text);
    }
    const warnings = [];
    if (empty > 0) {
        warnings.push(`start_criteria_empty: dropped ${empty} empty criteria`);
    }
    const seen = new Set();
    const unique = [];
    let duplicates = 0;
    for (const text of values) {
        const key = normalizeText(text);
        if (seen.has(key)) {
            duplicates++;
            continue;
        }
        seen.add(key);
        unique.push(text);
    }
    if (duplicates > 0) {
        warnings.push(`start_criteria_duplicate: dropped ${duplicates} duplicate criteria`);
    }
    const cap = Math.max(0, getPolicy().evolution.max_start_criteria);
    const criteria = unique.slice(0, cap);
    if (unique.length > criteria.length) {
        warnings.push(`start_criteria_capped: kept ${criteria.length} of ${unique.length} ` +
            `(max_start_criteria=${cap})`);
    }
    return { criteria, warnings };
}
/** v4.0.4: the terminal reason a manual `loopforge_stop` reports to the
 *  terminal sink and in its response. It is never persisted as a committed
 *  round fact, so status/resume after a restart still report "no committed
 *  terminal reason". One constant keeps the response and the sink aligned. */
export const MANUAL_STOP_REASON = "cancelled";
// ── Helpers ────────────────────────────────────────────────────────────────
export function buildLoopRequest(session,
/** v4.0.5: the host's explicit invocation input for THIS compile. */
inputs) {
    // The request carries CURRENT-ROUND context only. Every previous-round
    // fact is read from the Vault's committed rounds by the compiler, so live,
    // resume, unpause and backtrack compiles cannot disagree about the same
    // history. `attempt` is restored only while the held snapshot belongs to
    // the current round; entering the next round resets it to 1.
    const held = session.roundSnapshot?.round === session.currentRound
        ? session.roundSnapshot
        : undefined;
    // v4.0.3: a held retry carries its attempt/notice/findings/posture even
    // after a process restart or a failed retry compile.
    const retry = held?.retryContext;
    const heldAttempt = retry?.attempt ?? held?.attempt ?? 1;
    const acceptance = session.operatorAcceptance ?? session.roundSnapshot?.operatorAcceptance;
    return {
        loop_id: session.loopId,
        round: session.currentRound,
        goal_id: "",
        task: session.task,
        // Round 1 has no committed acceptance to read from history; the session
        // cursor is the bootstrap. Later rounds read the committed copy.
        loop_objective: session.currentRound === 1 && acceptance
            ? makeLoopObjective({
                objective: acceptance.task,
                success_criteria: [...acceptance.success_criteria],
                hard_constraints: [...acceptance.hard_constraints],
                created_at_round: 1,
                loop_id: session.loopId,
            })
            : null,
        plan_source: null,
        constraints_from_plan: [],
        force_level: "auto",
        max_rounds: session.maxRounds,
        verification_flags: retry ? [...retry.verificationFlags] : [],
        attempt: heldAttempt,
        consecutive_rejections: session.consecutiveRejections,
        rejection_notice: retry?.rejectionNotice ?? "",
        ...(retry ? { retry_evidence_posture: retry.evidencePosture } : {}),
        // v4.0.5: invocation input only. It never replaces `task`; the compiler
        // and assembler project it into the current prompt/state/artifact.
        ...(inputs?.currentUserInstruction !== undefined
            ? { current_user_instruction: inputs.currentUserInstruction }
            : {}),
    };
}
// ── RoundLifecycle ─────────────────────────────────────────────────────────
export class RoundLifecycle {
    store;
    sessionStore;
    registry;
    terminalSinks;
    ownerId;
    leaseMs;
    checkpointStoreFor;
    constructor(deps) {
        this.checkpointStoreFor = deps.checkpointStoreFor;
        this.store = deps.store;
        this.sessionStore = deps.sessionStore;
        this.registry = deps.registry;
        this.terminalSinks = deps.terminalSinks;
        this.ownerId = deps.ownerId;
        this.leaseMs = deps.leaseMs;
    }
    /** v3.9.7: the one RoundDriver construction site. Every prepare must carry
     *  the per-loop checkpoint store, or no round can produce a before-image. */
    driver(engine, loopId) {
        return new RoundDriver(engine, this.store, this.checkpointStoreFor?.(loopId));
    }
    /** v3.9.1: the submission-guidance projection for a session's held round.
     *  One history read and one compile window, no writes.
     *  Findings from a rejected/retried attempt are supplied by the caller. */
    guidanceFor(session, extras = {}) {
        const history = loadCommittedHistory(this.store, session.loopId);
        const criteria = this.objectiveCriteriaFor(session, history.entries);
        const { verificationFlags: explicitFlags, ...restExtras } = extras;
        // v4.0.3: a held retry projects its findings even after resume/stall.
        const verificationFlags = explicitFlags ??
            session.roundSnapshot?.retryContext?.verificationFlags;
        return deriveSubmissionGuidance(session, {
            rounds: historyWindow(history, session.currentRound),
            ...(criteria ? { objective: { success_criteria: criteria } } : {}),
            ...restExtras,
            ...(verificationFlags ? { verificationFlags } : {}),
            // A pending directive is a current fact. Unless the caller supplied a
            // more specific projection, expose it so status/resume agree.
            recovery: extras.recovery !== undefined
                ? extras.recovery
                : this.pendingRecoveryGuidance(session),
        });
    }
    /** The operator criteria the held prompt's reference space was built from.
     *  The held acceptance wins; committed objective lineage is the fallback for
     *  a session whose snapshot predates the acceptance field. Null when neither
     *  is observable — callers fail open. */
    objectiveCriteriaFor(session, entries) {
        const acceptance = session.operatorAcceptance ?? session.roundSnapshot?.operatorAcceptance;
        if (acceptance)
            return acceptance.success_criteria;
        return latestObjective(session.loopId, { results: entries })?.success_criteria ?? null;
    }
    /** v3.9.1: the before facts of the round being submitted, from the SAME
     *  history window the compile uses. Works on a replay too: rounds below the
     *  logical round exclude the round itself. */
    beforeFactsFor(session, loaded) {
        const history = loaded ?? loadCommittedHistory(this.store, session.loopId);
        const rounds = historyWindow(history, session.currentRound);
        const pending = history.pendingDirective?.recovery?.target.redo_round ===
            session.currentRound
            ? history.pendingDirective
            : null;
        return {
            contractId: deriveActiveRoundContract(rounds, getPolicy().evidence.commands ?? [])?.id ?? null,
            subGoals: deriveSubGoals({
                loopId: session.loopId,
                currentRound: session.currentRound,
                rounds,
            }),
            // Captured before the transaction commits. A redo commit consumes the
            // pending directive, so reading it afterwards would lose the fact.
            recoveryDirective: pending?.recovery ?? null,
        };
    }
    /** v3.9.1: derive this submission's receipt from the transaction and the
     *  shared read model. Never writes and never invents an applied effect. */
    buildReceipt(base, opts) {
        const history = loadCommittedHistory(this.store, base.snapshot.loopId);
        const committed = opts.disposition === "accepted" || opts.disposition === "stopped";
        const rounds = historyWindow(history, committed ? base.snapshot.round + 1 : base.snapshot.round);
        const commands = getPolicy().evidence.commands ?? [];
        const roundDeltas = deriveRoundObservationDelta(base.snapshot.beforeEvidence, base.actualEvidence);
        const contractAfterId = opts.contractAfterId !== undefined
            ? opts.contractAfterId
            : committed
                ? deriveActiveRoundContract(rounds, commands)?.id ?? null
                : base.beforeContractId;
        const afterSubGoals = opts.afterSubGoals !== undefined
            ? opts.afterSubGoals
            : committed
                ? deriveSubGoals({
                    loopId: base.snapshot.loopId,
                    currentRound: base.snapshot.round + 1,
                    rounds,
                })
                : base.beforeSubGoals;
        // The pre-commit capture is authoritative. The committed-directive
        // fallback covers a replayed transaction whose pending directive was
        // consumed by a commit this process never observed.
        const recoveryDirective = base.recoveryDirective ??
            (base.snapshot.kind === "rollback"
                ? null
                : [...history.directives].reverse().find((item) => item.recovery !== null && item.recovery !== undefined &&
                    item.recovery.target.redo_round === base.snapshot.round &&
                    item.recovery.transaction_id === base.snapshot.branchId)?.recovery ?? null);
        return deriveSubmissionReceipt({
            snapshot: base.snapshot,
            selfEval: base.selfEval,
            pr: base.pr,
            disposition: opts.disposition,
            diagnostics: base.diagnostics,
            submittedFields: base.submittedFields,
            recoveryDirective,
            ...(opts.restoreVerified !== undefined
                ? { recoveryRestoreVerified: opts.restoreVerified }
                : {}),
            facts: {
                contractBefore: base.beforeContractId,
                contractAfter: contractAfterId,
                subGoalsBefore: base.beforeSubGoals,
                subGoalsAfter: afterSubGoals,
                constraintsActiveAfter: opts.constraintsActiveAfter ?? null,
                constraintsRetiredAfter: opts.constraintsRetiredAfter ?? null,
            },
            nextArtifact: opts.nextArtifact ?? null,
            evidenceDeltas: roundDeltas,
        });
    }
    /** Persist session state to vault for cross-process recovery.
     *  The filtered vault and replacement entry are written once under the
     *  backend lock, so recovery never observes the old two-write gap. */
    save(session, options = {}) {
        if (!this.sessionStore)
            return;
        const leaseActive = session.status === "running";
        const sessionEntry = {
            task_id: `loop:${session.loopId}:session`,
            task_type: "session_state",
            timestamp: new Date().toISOString(),
            loop_id: session.loopId,
            task: session.task,
            loop_lineage: {
                session_id: session.sessionId,
                current_round: session.currentRound,
                max_rounds: session.maxRounds,
                status: session.status,
                created_at: session.createdAt,
                // v1.13: Enforcement gate state
                consecutive_rejections: session.consecutiveRejections,
                last_rejection_check: session.lastRejectionCheck,
                // v3.8.3: the in-flight entrypoint trust baseline. Read back
                // leniently (parseFingerprintMap) so a corrupt or absent value
                // degrades to "no absolute arm" instead of costing the round.
                entrypoint_trust: session.entrypointTrust ?? null,
                // v3.9.7: the operator-owned immutable acceptance cursor. The root
                // committed round-1 transaction remains the authority.
                operator_acceptance: session.operatorAcceptance ?? null,
                // v1.19: durable round transaction state
                round_snapshot: session.roundSnapshot ?? null,
                // v1.20: cross-process single-owner lease
                lease_owner: leaseActive ? this.ownerId : "",
                lease_expires_at: leaseActive ? Date.now() + this.leaseMs : 0,
            },
        };
        this.sessionStore.save(sessionEntry, {
            expectedLeaseOwner: this.ownerId,
            ...options,
        });
    }
    /** Reconstruct a McpSession from a vault session_state entry.
     *  Returns null if the entry is not "running" status.
     *  Shared by resume() and autoResumeAll(). */
    reconstructSession(entry, allowPaused = false) {
        const lineage = (entry.loop_lineage ?? {});
        const status = lineage.status ?? "running";
        // v3.9.7: a persisted `stalled` recovery state MUST be resumable. It is
        // how a committed directive with an unfinished restore survives a
        // process restart; refusing it would strand the loop forever.
        if (status !== "running" && status !== "stalled" &&
            !(allowPaused && status === "paused")) {
            return null;
        }
        const loopId = entry.loop_id;
        // v2.14: load-time gap detection — a runtime loop whose round sequence
        // has holes (deleted/tampered round documents) must not be resumed
        // silently. Legacy loops without stamps are exempt; gaps and corruption
        // surface as StorageCorruptionError. Previously checkRoundSequence was
        // only reachable through the read-only audit.
        checkRoundSequence(this.store, loopId);
        const currentRound = lineage.current_round ?? 1;
        const task = entry.task ?? "";
        const maxRounds = lineage.max_rounds ?? getPolicy().engine.max_rounds;
        const rawSnapshot = lineage.round_snapshot;
        const parsedSnapshot = parseRoundTransactionSnapshot(rawSnapshot);
        // v4.0.4: a held snapshot written by an unsupported schema must fail
        // closed. Silently recompiling would discard the held attempt (and, for a
        // 4.0.3 session, rewrite history this runtime cannot read).
        if (rawSnapshot !== undefined && rawSnapshot !== null && !parsedSnapshot) {
            throw new LegacyHistoryError(loopId, [currentRound]);
        }
        const history = loadCommittedHistory(this.store, loopId);
        // Legacy rounds are NOT history. Recompiling over them would overwrite
        // data this runtime cannot read; refuse and leave the loop read-only.
        if (history.legacyRounds.length > 0) {
            throw new LegacyHistoryError(loopId, history.legacyRounds.map((round) => round.round));
        }
        const branch = history.branch;
        // The session cursor is the primary copy; the held snapshot and the
        // visible root transaction are fallbacks. Losing the operator surface
        // during a restore/restart would be unrecoverable.
        const operatorAcceptance = parseOperatorAcceptance(lineage.operator_acceptance) ??
            parsedSnapshot?.operatorAcceptance ??
            [...branch.rounds, ...branch.directives].find((view) => view.operatorAcceptance !== null)?.operatorAcceptance ??
            undefined;
        // No synthesized evaluation snapshot: a held prompt is exactly the parsed
        // session snapshot. Resume/unpause recompile from committed history.
        const roundSnapshot = parsedSnapshot ?? undefined;
        const engine = new LoopForgeEngine(this.store);
        return {
            sessionId: typeof lineage.session_id === "string" && lineage.session_id
                ? lineage.session_id
                : randomUUID(),
            loopId, task, engine,
            currentRound, maxRounds,
            status: status,
            createdAt: lineage.created_at ?? Date.now(),
            // v3.9.9: a retired check's persisted counter is not a current problem.
            ...(() => {
                const check = typeof lineage.last_rejection_check === "string"
                    ? lineage.last_rejection_check
                    : "";
                if (check === "round_scope_drift") {
                    return { consecutiveRejections: 0, lastRejectionCheck: "" };
                }
                return {
                    consecutiveRejections: lineage.consecutive_rejections ?? 0,
                    lastRejectionCheck: check,
                };
            })(),
            // v4.0.3: an absent baseline stays absent. `{}` must not masquerade as
            // a trusted baseline (there is nothing to compare, and re-capturing it
            // from a modified workspace would launder the change).
            entrypointTrust: (() => {
                const trust = parseFingerprintMap(lineage.entrypoint_trust);
                return Object.keys(trust).length > 0 ? trust : undefined;
            })(),
            ...(operatorAcceptance ? { operatorAcceptance } : {}),
            roundSnapshot,
        };
    }
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
    applyRoundCounters(session, pr) {
        // v3.9.9: scope drift is no longer an enforcement row. A session restored
        // from an older runtime may still carry that check's rejection streak;
        // draining it here keeps the deleted check from reaching the
        // max_rejections catch-all as unresolved persistence.
        if (session.lastRejectionCheck === "round_scope_drift") {
            session.lastRejectionCheck = "";
            session.consecutiveRejections = 0;
        }
        if (pr.action === "reject" && pr.rejectionCheck) {
            session.consecutiveRejections =
                pr.rejectionCheck === session.lastRejectionCheck
                    ? pr.newConsecutiveRejections
                    : 1;
            session.lastRejectionCheck = pr.rejectionCheck;
        }
        else {
            session.consecutiveRejections = pr.newConsecutiveRejections;
            if (pr.action !== "reject")
                session.lastRejectionCheck = "";
        }
    }
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
    seedEntrypointTrust(session) {
        try {
            session.entrypointTrust = captureEntrypointTrust(getPolicy());
        }
        catch {
            session.entrypointTrust = undefined;
        }
    }
    /** v4.0.3: warnings for a resumed round whose trusted baseline is absent.
     *  The workspace may already have been modified; re-capturing it would
     *  launder the change, so the round runs with the Git-delta arm only. */
    resumeWarnings(session, warnings) {
        const out = [...(warnings ?? [])];
        if (!session.entrypointTrust) {
            out.push("entrypoint_trust_missing: no trusted round-start baseline is held; " +
                "only the Git-delta entrypoint arm runs for this resumed round.");
        }
        return out;
    }
    /** v3.9.7: operator acceptance and branch identity travel with the session
     *  cursor (not only the held snapshot). Every prepare carries them forward;
     *  a recovery that clears the held snapshot must not reset the branch to
     *  root or lose the operator's acceptance surface. */
    prepareOptions(session, branchId) {
        const acceptance = session.operatorAcceptance ?? session.roundSnapshot?.operatorAcceptance;
        const effectiveBranchId = branchId ?? session.roundSnapshot?.branchId;
        return {
            ...(effectiveBranchId ? { branchId: effectiveBranchId } : {}),
            ...(acceptance ? { operatorAcceptance: acceptance } : {}),
        };
    }
    persistPrepared(session, prepared, agentSuccessClaim, warningsOverride,
    /** v4.0.3: a resumed round must NOT re-capture its baseline from a
     *  possibly modified workspace. */
    seedTrust = true) {
        // v4.0.5: the shared compile → save → result tail is ATOMIC. If the save
        // fails, the in-memory session must not keep the new snapshot/trust: a
        // caller would otherwise receive a handle for a prompt that was never
        // persisted. The old held snapshot and handle stay valid, and the session
        // becomes resumable.
        const previousSnapshot = session.roundSnapshot;
        const previousTrust = session.entrypointTrust;
        session.roundSnapshot = prepared.snapshot;
        if (seedTrust)
            this.seedEntrypointTrust(session);
        try {
            this.save(session);
        }
        catch (error) {
            session.roundSnapshot = previousSnapshot;
            session.entrypointTrust = previousTrust;
            if (error instanceof SessionLeaseConflictError)
                throw error;
            logEvent("session_save_failed", {
                loopId: session.loopId,
                round: session.currentRound,
                error: String(error),
            });
            session.status = "stalled";
            try {
                this.save(session);
            }
            catch {
                // The store is still unavailable; the in-memory held facts remain the
                // best available state and the next resume retries the save.
            }
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                ...this.heldHandle(session),
                ...this.transactionFacts(session),
                prompt: null,
                stopReason: "stalled",
                stopDetail: "The prompt was compiled but the session could not be saved: " +
                    `${String(error).slice(0, 300)}. The previous held prompt and ` +
                    "handle are unchanged; call loopforge_resume to retry.",
            };
        }
        policyMetrics.recordStrategy(session.loopId, prepared.level);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            ...this.heldHandle(session),
            ...this.transactionFacts(session),
            ...this.contextFacts(prepared.snapshot.promptArtifact),
            prompt: prepared.prompt,
            level: prepared.level,
            agentSuccessClaim,
            agentOutcome: session.roundSnapshot?.result?.agentOutcome ?? null,
            // v4.0.3: the posture of the round that just committed — read from the
            // transaction's committed result, never recomputed here.
            evidencePosture: session.roundSnapshot?.result?.evidencePosture,
            warnings: warningsOverride ??
                session.roundSnapshot?.promptArtifact?.warnings ??
                prepared.warnings ?? [],
            submission_guidance: this.guidanceFor(session),
        };
    }
    /** v4.0.2: the context boundary carried by a prompt-bearing result. It is
     *  a PROJECTION of the artifact that produced the prompt — never a second
     *  derivation from live session state. */
    contextFacts(artifact) {
        if (!artifact)
            return {};
        return {
            contextMode: artifact.contextMode,
            contextReason: artifact.contextReason,
        };
    }
    /** v3.9.7: execution metadata attached to every held/prepared prompt. These
     *  are transport facts, never prompt governance content. v4.0.0: the anchor
     *  itself is the separate `submissionHandle`; this bundle owns only the
     *  checkpoint facts. */
    transactionFacts(session) {
        const snapshot = session.roundSnapshot;
        if (!snapshot)
            return {};
        const checkpoints = [
            ...(snapshot.beforeCheckpoint ? [snapshot.beforeCheckpoint] : []),
            ...(snapshot.checkpoints ?? []),
        ];
        return {
            ...(checkpoints.length > 0 ? { checkpoints } : {}),
            ...(snapshot.beforeCheckpointError
                ? {
                    beforeCheckpointError: {
                        code: snapshot.beforeCheckpointError.code,
                        detail: snapshot.beforeCheckpointError.detail,
                    },
                }
                : {}),
        };
    }
    /** v4.0.0: the transport handle for the current held snapshot, or absent. */
    heldHandle(session) {
        const handle = makeSubmissionHandle(session);
        return handle ? { submissionHandle: handle } : {};
    }
    /** v3.9.7: guidance facts for a redo whose restore is already verified.
     *  They are derived from the still-pending committed directive, so a
     *  restart returns the same surface as the original recovery response. */
    pendingRecoveryGuidance(session) {
        const pending = loadCommittedHistory(this.store, session.loopId).pendingDirective;
        const directive = pending?.recovery;
        if (!directive)
            return null;
        return {
            pending: true,
            redo_round: directive.target.redo_round,
            checkpoint_id: directive.target.checkpoint_id,
            restore_verified: session.roundSnapshot?.restore?.directiveTransactionId ===
                directive.transaction_id,
            origin: directive.origin,
            reason: directive.reason,
        };
    }
    /** v4.0.0: return the exact stored prompt plus the CURRENT handle. This is
     *  the ONE path that re-delivers a prompt without compiling. It fails closed
     *  unless the full held predicate holds (phase, round, attempt, rendered
     *  prompt), so a committed/terminated/retrying snapshot can never masquerade
     *  as held. The warning is appended without mutating the artifact. Public so
     *  SessionManager can use it on its pre-queue stale-handle path. */
    heldPromptResult(session, warning) {
        const snapshot = heldPromptSnapshot(session);
        const artifact = snapshot?.promptArtifact;
        if (!snapshot || !artifact)
            return null;
        const handle = makeSubmissionHandle(session);
        if (!handle)
            return null;
        const warnings = [...(artifact.warnings ?? [])];
        if (warning && !warnings.includes(warning))
            warnings.push(warning);
        // v4.0.3: a held-prompt redelivery carries the most recent committed
        // receipt, so the response it missed is recoverable from history.
        const history = loadCommittedHistory(this.store, session.loopId);
        const latestRound = history.rounds[history.rounds.length - 1];
        const pending = history.pendingDirective;
        const latestRecord = pending &&
            (!latestRound || pending.round >= latestRound.round)
            ? pending
            : latestRound;
        const receipt = latestRecord
            ? deriveCommittedSubmissionView(latestRecord, history.rounds, history.directives)
            : undefined;
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            submissionHandle: handle,
            ...this.transactionFacts(session),
            ...this.contextFacts(artifact),
            prompt: artifact.renderedPrompt,
            level: artifact.level,
            agentSuccessClaim: undefined,
            warnings,
            submission_guidance: this.guidanceFor(session, {
                recovery: this.pendingRecoveryGuidance(session),
            }),
            ...(receipt ? { submission_receipt: receipt } : {}),
        };
    }
    /** Reconcile the crash window where feedback committed but session_state
     *  still points at the old prompt. Returns null when no commit is pending.
     *  v3.7: async — the continue-after-crash branch compiles through
     *  RoundDriver.prepare (the sync prepareSync fallback was removed). */
    async reconcileCommittedRound(session, inputs) {
        if (!session.roundSnapshot)
            return null;
        const recovered = this.driver(session.engine, session.loopId).recover(session.roundSnapshot);
        if (!recovered)
            return null;
        const pr = recovered.result;
        session.roundSnapshot = recovered.snapshot;
        this.applyRoundCounters(session, pr);
        if (pr.action === "stop" || pr.action === "terminate") {
            // v3.8.3: a replayed termination carries the gate's own reason for the
            // same reason the live path does (see buildTerminationResult) — the
            // crash-recovery path must report the fact it replayed, not a generic
            // substitute. Only a stop without a named reason falls back.
            const reason = pr.stopReason
                ?? (pr.action === "terminate" ? "enforcement_terminated" : "stalled");
            session.status = reason === "stalled" ? "stalled" : "stopped";
            this.save(session);
            void this.notifyTerminal(session, reason);
            // v4.0.4: the crash-recovery stop renders the SAME three fact blocks as
            // the live path. A committed stop also carries the equivalent receipt;
            // a termination never fabricates one.
            const history = loadCommittedHistory(this.store, session.loopId);
            const committedView = pr.action === "stop"
                ? history.rounds.find((view) => view.round === recovered.snapshot.round) ?? null
                : null;
            const receipt = committedView
                ? deriveCommittedSubmissionView(committedView, history.rounds, history.directives)
                : undefined;
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: reason,
                sessionStatus: session.status,
                stopDetail: renderResultFacts(this.terminalFacts(pr, reason, recovered.snapshot.evaluation ?? null, pr.action === "stop"), "terminal").join("\n"),
                agentSuccessClaim: pr.agentSuccessClaim,
                agentOutcome: pr.agentOutcome,
                agentStopReason: recovered.snapshot.evaluation?.agent_stop_reason,
                agentShouldContinue: recovered.snapshot.evaluation?.should_continue,
                ...(receipt ? { submission_receipt: receipt } : {}),
            };
        }
        if (pr.action === "backtrack" || pr.action === "recovery") {
            // Backtrack/directive committed but the redo prompt was not delivered
            // (crash window). The pending-directive-first path in resume/unpause
            // performs the restore; here we only align the cursor.
            session.currentRound = pr.recovery?.target.redo_round ?? session.currentRound;
            session.consecutiveRejections = 0;
            session.lastRejectionCheck = "";
            this.save(session);
            // Return null — caller (resume/unpause) will restore/recompile.
            return null;
        }
        if (pr.action !== "continue")
            return null;
        // v2.14: only advance when the persisted counter has not already moved
        // past the committed round. The pause/delete race leaves currentRound
        // incremented (the commit fence returns before compiling, and pause()
        // persisted the incremented value) — replaying must compile the NEXT
        // round, not skip it by incrementing again.
        if (session.currentRound <= recovered.snapshot.round) {
            session.currentRound = recovered.snapshot.round + 1;
        }
        // v4.0.5: a host instruction explicitly supplied with THIS resume call
        // carries into the next round's compile. It is never inherited from an
        // older artifact here.
        const request = buildLoopRequest(session, inputs);
        let prepared;
        try {
            prepared = await this.driver(session.engine, session.loopId).prepare(request, session.loopId, session.currentRound, this.prepareOptions(session));
        }
        catch (error) {
            if (error instanceof ProjectionCoverageError) {
                return this.stalledAfterCommit(session.sessionId, session, pr.agentSuccessClaim, error.message, { code: "projection_incomplete", details: { coverage: error.coverage } });
            }
            if (error instanceof CompileFailureError) {
                return this.stalledAfterCommit(session.sessionId, session, pr.agentSuccessClaim, `The committed round is held, but the next prompt could not be compiled: ${error.message}. Call loopforge_resume to retry.`);
            }
            throw error;
        }
        return this.persistPrepared(session, {
            prompt: prepared.prompt,
            level: prepared.level,
            baseline: prepared.evidenceBaseline,
            snapshot: prepared.snapshot,
            warnings: prepared.warnings ?? [],
        }, pr.agentSuccessClaim);
    }
    /** v3.9.7: a committed directive with no verified redo snapshot must be
     *  completed BEFORE any ordinary compile/held-prompt path. The restore and
     *  redo prepare are idempotent; a verified held redo prompt is returned
     *  without re-checking the workspace (the Agent may already have worked). */
    async completePendingRecovery(session, inputs) {
        const pending = loadCommittedHistory(this.store, session.loopId).pendingDirective;
        if (!pending?.recovery)
            return null;
        const directive = pending.recovery;
        const verified = session.roundSnapshot?.restore?.directiveTransactionId ===
            directive.transaction_id &&
            session.roundSnapshot.round === directive.target.redo_round;
        if (verified) {
            // v4.0.5: the verified redo prompt goes through the SAME held-prompt
            // entry as every other resume/unpause path, so a new instruction is
            // never silently dropped on this branch.
            return this.heldPromptWithInputs(session, inputs);
        }
        session.currentRound = directive.target.redo_round;
        session.roundSnapshot = undefined;
        session.status = "running";
        const pr = {
            action: directive.origin === "agent" ? "recovery" : "backtrack",
            origin: directive.origin,
            reason: directive.reason,
            recovery: directive,
            // v4.0.3: replay the directive's compact trigger findings instead of
            // losing them with the process that produced the backtrack.
            verificationFlags: [...(directive.trigger_findings ?? [])],
            agentSuccessClaim: false,
            agentOutcome: null,
            gateContradicted: false,
            evidencePosture: rollbackEvidencePosture(directive.target.redo_round),
            newConsecutiveRejections: 0,
            shouldPushSuccessTrajectory: false,
        };
        // The receipt base is the committed directive's own snapshot, not a
        // freshly synthesized empty transaction. It is readable history (the
        // legacy guard already ran) and carries the operator acceptance the
        // recovery preserved.
        const source = pending.sourceEntry;
        const lineage = isRecord(source.loop_lineage) ? source.loop_lineage : {};
        const transaction = isRecord(lineage.round_transaction)
            ? lineage.round_transaction
            : {};
        const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
        if (!snapshot) {
            session.status = "stalled";
            this.save(session);
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "The committed rollback directive is unreadable; its history must be repaired before the restore can continue.",
            };
        }
        const beforeFacts = this.beforeFactsFor(session);
        return this.buildBacktrackResult(session.sessionId, session, pr, {
            snapshot,
            selfEval: {
                success: false,
                output_summary: "",
                constraint_violations: [],
                should_continue: true,
            },
            pr,
            actualEvidence: [],
            diagnostics: [],
            submittedFields: [],
            beforeContractId: beforeFacts.contractId,
            beforeSubGoals: beforeFacts.subGoals,
            recoveryDirective: directive,
            replayed: true,
        }, inputs);
    }
    /** v4.0.5: the zero-side-effect refusal for a cold handoff whose held retry
     *  facts are missing or inconsistent. Nothing is saved, compiled or
     *  advanced; the held snapshot and handle are unchanged. */
    invocationRecoveryUnavailable(session, detail) {
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            ...this.heldHandle(session),
            ...this.transactionFacts(session),
            prompt: null,
            submissionError: {
                code: "invalid_argument",
                details: { reason_code: "invocation_recovery_unavailable", detail },
            },
            stopDetail: detail,
        };
    }
    /** v4.0.5: map a compile failure onto the existing stalled/coverage result.
     *  Returns null for an unexpected error so the caller can rethrow it. */
    compileStalledResult(session, error, detail) {
        if (error instanceof ProjectionCoverageError) {
            return this.stalledAfterCommit(session.sessionId, session, false, error.message, { code: "projection_incomplete", details: { coverage: error.coverage } });
        }
        if (error instanceof CompileFailureError) {
            return this.stalledAfterCommit(session.sessionId, session, false, `${detail}: ${error.message}. The previous prompt and handle are ` +
                "unchanged; call loopforge_resume to retry.");
        }
        return null;
    }
    /** v4.0.5: ONE held-prompt entry for resume/unpause/recovery. With no new
     *  instruction it re-delivers the stored prompt and handle unchanged; with a
     *  new instruction it recompiles the SAME round/attempt and preserves the
     *  held context boundary (including an existing invocation recovery). */
    async heldPromptWithInputs(session, inputs) {
        const held = heldPromptSnapshot(session);
        if (!held?.promptArtifact)
            return null;
        const instruction = inputs?.currentUserInstruction;
        if (instruction === undefined ||
            instruction === held.promptArtifact.currentUserInstruction) {
            return this.heldPromptResult(session);
        }
        return this.recompileHeldPrompt(session, held, {
            currentUserInstruction: instruction,
        });
    }
    /** v4.0.5: the public `loopforge_next` instruction-recompile entry. It only
     *  recompiles the held prompt for a new invocation instruction: no
     *  submission, no round/attempt change, no evidence collection. The handle
     *  was validated by SessionManager before its queue and lease heartbeat. */
    async recompileHeldWithInstruction(session, instruction) {
        const held = heldPromptSnapshot(session);
        if (!held?.promptArtifact) {
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                prompt: null,
                submissionError: {
                    code: "invalid_argument",
                    details: {
                        reason_code: "no_held_prompt",
                        detail: "No held prompt exists to recompile.",
                    },
                },
            };
        }
        if (instruction === held.promptArtifact.currentUserInstruction) {
            // Idempotent: the exact same instruction returns the same prompt and
            // handle without compiling again.
            return this.heldPromptResult(session) ?? {
                sessionId: session.sessionId,
                round: session.currentRound,
                prompt: null,
            };
        }
        return this.recompileHeldPrompt(session, held, {
            currentUserInstruction: instruction,
        });
    }
    /** v4.0.5: compile a held prompt again without collecting evidence, writing
     *  the Vault, changing attempt/round or touching retry counters. */
    async recompileHeldPrompt(session, held, inputs) {
        const request = buildLoopRequest(session, inputs);
        if (inputs.invocationRecovery)
            request.invocation_recovery = true;
        let prepared;
        try {
            prepared = await this.driver(session.engine, session.loopId)
                .recompileHeld(request, held);
        }
        catch (error) {
            const stalled = this.compileStalledResult(session, error, "The held prompt could not be recompiled");
            if (stalled)
                return stalled;
            throw error;
        }
        return this.persistPrepared(session, {
            prompt: prepared.prompt,
            level: prepared.level,
            baseline: prepared.evidenceBaseline,
            snapshot: prepared.snapshot,
            warnings: prepared.warnings ?? [],
        }, undefined, this.resumeWarnings(session, prepared.warnings), false);
    }
    /** v4.0.5: compile the retry prompt for a rejected attempt that has no held
     *  prompt (its retry compile failed before). This is the one path that
     *  creates the next attempt for such a session. */
    async prepareRetryWithInputs(session, rejected, opts) {
        const retryContext = rejected.retryContext;
        if (!retryContext) {
            throw new Error("prepareRetryWithInputs requires a retry context");
        }
        const request = buildLoopRequest(session, opts);
        let prepared;
        try {
            prepared = await this.driver(session.engine, session.loopId).prepareRetry(request, rejected, retryContext.rejectionNotice, session.consecutiveRejections, opts.invocationRecovery ? { invocationRecovery: true } : {});
        }
        catch (error) {
            const stalled = this.compileStalledResult(session, error, "The retry prompt could not be compiled");
            if (stalled)
                return stalled;
            throw error;
        }
        return this.persistPrepared(session, {
            prompt: prepared.prompt,
            level: prepared.level,
            baseline: prepared.evidenceBaseline,
            snapshot: prepared.snapshot,
            warnings: prepared.warnings ?? [],
        }, undefined, this.resumeWarnings(session, prepared.warnings), false);
    }
    /** v4.0.5: recompile the SAME retry attempt when the host declared the
     *  original invocation lost, or when a submitted retry prompt never existed
     *  (rejected snapshot). Returns null when this session has no retry material
     *  or when the held prompt is already a clean context (idempotent no-op). */
    async recompileRetryAttempt(session, inputs) {
        const invocationLost = inputs.invocationLost === true;
        if (!invocationLost && inputs.currentUserInstruction === undefined) {
            return null;
        }
        const held = session.roundSnapshot?.round === session.currentRound
            ? session.roundSnapshot
            : undefined;
        // A rejected attempt whose retry prompt never compiled: there is nothing
        // to re-deliver, so the retry prompt is compiled for real. Instruction
        // inheritance is scoped to this same logical round.
        if (held?.phase === "rejected" && held.retryContext) {
            const instruction = inputs.currentUserInstruction ??
                held.promptArtifact?.currentUserInstruction;
            return this.prepareRetryWithInputs(session, held, {
                ...(instruction !== undefined
                    ? { currentUserInstruction: instruction }
                    : {}),
                invocationRecovery: invocationLost && session.consecutiveRejections < 2,
            });
        }
        // Only an in-context retry has an invocation to recover. A held clean
        // prompt (first/next round, escalation, recovery redo) is already the
        // cold-context prompt, so `invocationLost` is an idempotent no-op.
        if (held?.phase !== "prompted" || !held.promptArtifact)
            return null;
        if (held.promptArtifact.contextMode !== "same_round_retry")
            return null;
        // A plain instruction recompile is handled by the unified held-prompt
        // entry; only the lost invocation rebuilds the context boundary.
        if (!invocationLost)
            return null;
        if (!held.retryContext) {
            return this.invocationRecoveryUnavailable(session, "The held in-context retry has no retry context, so the same attempt " +
                "cannot be recompiled in cold context.");
        }
        if (held.retryContext.attempt !== held.attempt ||
            held.retryContext.rejectedAttempt + 1 !== held.attempt) {
            return this.invocationRecoveryUnavailable(session, "The held retry context does not match the held attempt, so the same " +
                "attempt cannot be recompiled in cold context.");
        }
        if (session.consecutiveRejections >= 2) {
            return this.invocationRecoveryUnavailable(session, "The retry has reached the rejection escalation threshold; it is " +
                "already clean context and is not rewritten as an invocation recovery.");
        }
        const instruction = inputs.currentUserInstruction ??
            held.promptArtifact.currentUserInstruction;
        return this.recompileHeldPrompt(session, held, {
            ...(instruction !== undefined ? { currentUserInstruction: instruction } : {}),
            invocationRecovery: true,
        });
    }
    /** A rejected round still owns its original before-image. Recover its next
     *  attempt through the same retry preparation used by a live rejection;
     *  ordinary prepare would recapture evidence and reset snapshot.attempt.
     *  v4.0.5: the instruction travels with the compile and is inherited from
     *  the rejected prompt within the same logical round. */
    prepareMissingPrompt(session, inputs) {
        const driver = this.driver(session.engine, session.loopId);
        const rejected = session.roundSnapshot;
        if (rejected?.phase === "rejected" && rejected.retryContext) {
            const instruction = inputs?.currentUserInstruction ??
                rejected.promptArtifact?.currentUserInstruction;
            const request = buildLoopRequest(session, instruction !== undefined ? { currentUserInstruction: instruction } : undefined);
            return driver.prepareRetry(request, rejected, rejected.retryContext.rejectionNotice, session.consecutiveRejections);
        }
        return driver.prepare(buildLoopRequest(session, inputs), session.loopId, session.currentRound, this.prepareOptions(session));
    }
    /** Resume tail: the session has been reconstructed and registered. Reconcile
     *  a committed-but-undelivered round, restore the held prompt, or recover a
     *  missing prompt from current round state. v3.7: async — compilation runs
     *  through RoundDriver.prepare like unpause (the prepareSync fallback was
     *  removed); a failed compile now degrades to the same stalled terminal
     *  result unpause returns instead of persisting a null prompt.
     *  v4.0.5: an `invocationLost` retry is recompiled as a cold-context prompt
     *  for the SAME logical round/attempt, before the ordinary held-prompt path. */
    async resume(session, inputs) {
        const pendingRecovery = await this.completePendingRecovery(session, inputs);
        if (pendingRecovery)
            return pendingRecovery;
        const reconciled = await this.reconcileCommittedRound(session, inputs);
        if (reconciled)
            return reconciled;
        const retryRecovery = await this.recompileRetryAttempt(session, inputs ?? {});
        if (retryRecovery)
            return retryRecovery;
        const restored = await this.heldPromptWithInputs(session, inputs);
        if (restored)
            return restored;
        // Missing held prompt: compile (async) once, then persist it.
        let prepared;
        try {
            prepared = await this.prepareMissingPrompt(session, inputs);
        }
        catch (error) {
            if (error instanceof ProjectionCoverageError) {
                return this.stalledAfterCommit(session.sessionId, session, false, error.message, { code: "projection_incomplete", details: { coverage: error.coverage } });
            }
            if (error instanceof CompileFailureError) {
                return this.stalledAfterCommit(session.sessionId, session, false, `The compiler could not produce a prompt during resume: ${error.message}. Call loopforge_resume to retry.`);
            }
            throw error;
        }
        return this.persistPrepared(session, {
            prompt: prepared.prompt,
            level: prepared.level,
            baseline: prepared.evidenceBaseline,
            snapshot: prepared.snapshot,
            warnings: prepared.warnings ?? [],
        }, false, this.resumeWarnings(session, prepared.warnings), false);
    }
    /** Unpause tail: the session has been reconstructed and registered with
     *  status "running". Reconcile a committed round, restore the held prompt,
     *  or compile the next prompt from the committed window. v4.0.5: the same
     *  invocation inputs and cold-handoff recompile apply here. */
    async unpause(session, inputs) {
        const pendingRecovery = await this.completePendingRecovery(session, inputs);
        if (pendingRecovery)
            return pendingRecovery;
        const reconciled = await this.reconcileCommittedRound(session, inputs);
        if (reconciled)
            return reconciled;
        const retryRecovery = await this.recompileRetryAttempt(session, inputs ?? {});
        if (retryRecovery)
            return retryRecovery;
        const restored = await this.heldPromptWithInputs(session, inputs);
        if (restored) {
            this.save(session);
            return restored;
        }
        let prepared;
        try {
            prepared = await this.prepareMissingPrompt(session, inputs);
        }
        catch (error) {
            if (error instanceof ProjectionCoverageError) {
                return this.stalledAfterCommit(session.sessionId, session, false, error.message, { code: "projection_incomplete", details: { coverage: error.coverage } });
            }
            if (error instanceof CompileFailureError) {
                return this.stalledAfterCommit(session.sessionId, session, false, `The compiler could not produce a prompt during unpause: ${error.message}. Call loopforge_resume to retry.`);
            }
            throw error;
        }
        return this.persistPrepared(session, {
            prompt: prepared.prompt,
            level: prepared.level,
            baseline: prepared.evidenceBaseline,
            snapshot: prepared.snapshot,
            warnings: prepared.warnings ?? [],
        }, undefined, this.resumeWarnings(session, prepared.warnings), false);
    }
    /** Record a gate_opened entry when an accepted round reports a high-risk
     *  blocker (USER_RISK hit). Idempotent per gate. The gate is a record
     *  layer — it never blocks the round decision flow. */
    recordGateFromBlocked(session, blocker) {
        if (!getPolicy().gate.enabled)
            return;
        const { id, gate } = deriveGate(blocker);
        if (gate.kind !== "user")
            return;
        const taskId = `loop:${session.loopId}:gate:${id}`;
        const existing = loadCommittedHistory(this.store, session.loopId)
            .entries.some((entry) => entry.task_id === taskId);
        if (existing)
            return;
        const entry = {
            id: randomUUID(),
            task_id: taskId,
            task_type: "gate_opened",
            loop_id: session.loopId,
            timestamp: new Date().toISOString(),
            gate_id: id,
            gate_action: blocker,
            loop_lineage: {
                round: session.currentRound,
                gate_id: id,
            },
        };
        this.store.appendEntry(entry);
        logEvent("gate_opened", { loopId: session.loopId, gateId: id, round: session.currentRound });
    }
    /** Undecided user gate descriptions for a loop (recorded but unresolved). */
    listOpenGateDescriptions(loopId) {
        const gatePrefix = `loop:${loopId}:gate:`;
        const entries = loadCommittedHistory(this.store, loopId).entries
            .filter((entry) => String(entry.task_id ?? "").startsWith(gatePrefix));
        const decided = new Set(entries.filter((entry) => entry.task_type === "gate_decision")
            .map((entry) => String(entry.gate_id ?? "")));
        return entries
            .filter((entry) => entry.task_type === "gate_opened" &&
            !decided.has(String(entry.gate_id ?? "")))
            .map((entry) => typeof entry.gate_action === "string"
            ? entry.gate_action
            : String(entry.gate_id ?? ""));
    }
    /** The boundary supplies the typed evaluation. Free-text parsing is
     *  deliberately not part of the round state machine. */
    extractEvaluation(_output, preExtractedEval) {
        return preExtractedEval ?? null;
    }
    /** Execute the round transaction and apply per-rule rejection tracking.
     *  MUTATES: session.roundSnapshot, session.consecutiveRejections,
     *           session.lastRejectionCheck */
    async executeRoundTransaction(session, selfEval, normalizationDiagnostics, submittedFields, history) {
        const snapshot = session.roundSnapshot;
        if (!snapshot) {
            throw new Error("No held round transaction — the submission boundary must reject this attempt.");
        }
        const completed = await this.driver(session.engine, session.loopId).complete({
            snapshot,
            loopId: session.loopId,
            task: session.task,
            maxRounds: session.maxRounds,
            ...(history ? { history } : {}),
            selfEval,
            consecutiveRejections: session.consecutiveRejections,
            lastRejectionCheck: session.lastRejectionCheck,
            entrypointTrust: session.entrypointTrust,
            normalizationDiagnostics,
            submittedFields,
        });
        const outcome = completed.outcome;
        const actualEvidence = completed.actualEvidence;
        session.roundSnapshot = outcome.snapshot;
        const pr = outcome.result;
        this.applyRoundCounters(session, pr);
        return {
            pr,
            verificationFlags: pr.verificationFlags,
            actualEvidence,
            replayed: completed.outcome.replayed,
        };
    }
    /** Build a rejection result: compile a retry prompt, persist, return.
     *  MUTATES: session.roundSnapshot, session.currentPrompt, session.currentLevel */
    async buildRejectionResult(sessionId, session, pr, verificationFlags, receiptBase, inputs) {
        const rejectedSnapshot = session.roundSnapshot;
        if (!rejectedSnapshot) {
            throw new Error("A rejected attempt must keep its held transaction snapshot.");
        }
        // v4.0.3: persist the retry facts BEFORE compiling the retry prompt. A
        // compile failure (or a process restart) must not lose the attempt,
        // notice, findings or transient posture.
        const retryContext = {
            attempt: rejectedSnapshot.attempt + 1,
            rejectedAttempt: rejectedSnapshot.attempt,
            rejectionNotice: pr.rejectionPrompt ?? "",
            verificationFlags: [...verificationFlags],
            evidencePosture: pr.evidencePosture,
            rejectedAt: Date.now(),
        };
        session.roundSnapshot = { ...rejectedSnapshot, retryContext };
        try {
            this.save(session);
        }
        catch (error) {
            return this.stalledAfterCommit(sessionId, session, false, `The rejected attempt could not be persisted: ${String(error).slice(0, 300)}. ` +
                "Call loopforge_resume to retry; the rejection facts are still held in memory.");
        }
        // In-flight attempt findings are authority for THIS attempt, not
        // committed history: buildLoopRequest now projects them from retryContext.
        // v4.0.5: a same-round retry inherits the rejected prompt's instruction
        // unless the host supplied a new one for this submission.
        const inheritedInstruction = inputs?.currentUserInstruction ??
            rejectedSnapshot.promptArtifact?.currentUserInstruction;
        const retryRequest = buildLoopRequest(session, inheritedInstruction !== undefined
            ? { currentUserInstruction: inheritedInstruction }
            : undefined);
        retryRequest.verification_flags = verificationFlags;
        retryRequest.rejection_notice = pr.rejectionPrompt ?? "";
        let preparedRetry;
        try {
            preparedRetry = await this.driver(session.engine, session.loopId).prepareRetry(retryRequest, session.roundSnapshot, pr.rejectionPrompt ?? "", session.consecutiveRejections);
        }
        catch (error) {
            if (error instanceof ProjectionCoverageError) {
                return this.stalledAfterCommit(sessionId, session, false, error.message, { code: "projection_incomplete", details: { coverage: error.coverage } });
            }
            if (error instanceof CompileFailureError) {
                return this.stalledAfterCommit(sessionId, session, false, `The retry prompt could not be compiled: ${error.message}. Call loopforge_resume to retry.`);
            }
            throw error;
        }
        session.roundSnapshot = preparedRetry.snapshot;
        this.save(session);
        const retryArtifact = preparedRetry.artifact ??
            preparedRetry.compileResponse?.prompt_artifact ?? null;
        return {
            sessionId,
            round: session.currentRound,
            ...this.heldHandle(session),
            ...this.transactionFacts(session),
            ...this.contextFacts(retryArtifact),
            prompt: preparedRetry.prompt,
            level: preparedRetry.level,
            agentSuccessClaim: pr.agentSuccessClaim,
            agentOutcome: pr.agentOutcome,
            enforcementAction: "reject",
            evidencePosture: pr.evidencePosture,
            enforcementReason: pr.enforcementReason,
            submission_guidance: this.guidanceFor(session, {
                verificationFlags: pr.verificationFlags,
            }),
            submission_receipt: this.buildReceipt(receiptBase, {
                disposition: "rejected",
                nextArtifact: retryArtifact,
                afterSubGoals: null,
                constraintsActiveAfter: null,
                contractAfterId: receiptBase.beforeContractId,
            }),
        };
    }
    /** v3.9.7: the workspace/state-dir facts shared by restore preflight and
     *  execution. The state directory is never part of the restored boundary. */
    restoreContext() {
        const workspace = process.cwd();
        let stateDir;
        try {
            stateDir = resolveStateDirectory(workspace, getPolicy().backend.root_dir);
        }
        catch (error) {
            throw new RestoreFailure("state_directory_invalid", `The runtime state directory could not be resolved: ${String(error)}`);
        }
        const exclude = (path) => {
            const absolute = resolve(workspace, path);
            const rel = relative(stateDir, absolute);
            return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
        };
        return { workspace, stateDir, exclude };
    }
    /** Execute the committed directive's restore, verify it, then compile the
     *  redo from the SAME baseline. The directive is never rewritten. */
    async runRestoreAndPrepare(session, directive, extra = {}) {
        const store = this.checkpointStoreFor?.(session.loopId);
        if (!store) {
            return {
                ok: false,
                result: this.restoreFailedResult(session, directive, "store_unavailable", "no workspace checkpoint store is attached to this runtime"),
            };
        }
        const manifest = store.readManifest(directive.target.checkpoint_id);
        const ref = {
            checkpointId: directive.target.checkpoint_id,
            contentHash: directive.target.content_hash,
            role: directive.target.role,
            round: directive.target.round,
            roundId: directive.target.round_id,
            transactionId: directive.target.transaction_id,
            branchId: session.roundSnapshot?.branchId ?? rootBranchId(session.loopId),
            redoRound: directive.target.redo_round,
            createdAt: Date.now(),
        };
        const validated = validateCheckpointManifest(ref, manifest);
        if (!validated.ok) {
            return {
                ok: false,
                result: this.restoreFailedResult(session, directive, validated.reason, validated.detail),
            };
        }
        const redoRound = directive.target.redo_round;
        // In-memory only: the session stays running and keeps the lease through
        // the restore. The first persisted state is either the verified redo or an
        // explicit stalled session.
        session.currentRound = redoRound;
        session.roundSnapshot = undefined;
        session.status = "running";
        let restore;
        try {
            const context = this.restoreContext();
            await preflightRestore({
                manifest: validated.manifest,
                workspace: context.workspace,
                store,
                stateDir: context.stateDir,
                exclude: context.exclude,
            });
            restore = await executeRestore({
                manifest: validated.manifest,
                workspace: context.workspace,
                store,
                directiveTransactionId: directive.transaction_id,
                stateDir: context.stateDir,
                exclude: context.exclude,
            });
        }
        catch (error) {
            return {
                ok: false,
                result: this.restoreFailedResult(session, directive, error instanceof RestoreFailure ? error.reasonCode : "restore_failed", String(error instanceof Error ? error.message : error)),
            };
        }
        const request = buildLoopRequest(session, extra.inputs);
        if (extra.verificationFlags) {
            request.verification_flags = [...extra.verificationFlags];
        }
        let prepared;
        try {
            prepared = await new RoundDriver(session.engine, this.store, this.checkpointStoreFor?.(session.loopId)).prepare(request, session.loopId, redoRound, {
                branchId: directive.transaction_id,
                ...(session.operatorAcceptance
                    ? { operatorAcceptance: session.operatorAcceptance }
                    : {}),
                baseline: {
                    observations: restore.baseline,
                    ...(restore.baselineBoundary
                        ? { boundary: restore.baselineBoundary }
                        : {}),
                },
                restore: {
                    directiveTransactionId: directive.transaction_id,
                    redoRound,
                    verifiedAt: restore.verifiedAt,
                },
            });
        }
        catch (error) {
            return {
                ok: false,
                result: this.restoreFailedResult(session, directive, "prepare_failed", String(error instanceof Error ? error.message : error)),
            };
        }
        return { ok: true, restore, prepared };
    }
    /** Failed restore: the directive remains pending, no prompt exists, and the
     *  session is resumable. */
    restoreFailedResult(session, directive, reasonCode, detail) {
        const redoRound = directive.target.redo_round;
        session.currentRound = redoRound;
        session.roundSnapshot = undefined;
        session.status = "stalled";
        this.save(session);
        return {
            sessionId: session.sessionId,
            round: redoRound,
            prompt: null,
            stopReason: "stalled",
            stopDetail: `Workspace restore failed (${reasonCode}). The rollback directive remains pending; ` +
                "call loopforge_resume to retry the same restore.",
            submissionError: {
                code: "restore_failed",
                details: {
                    loopId: session.loopId,
                    directive_transaction_id: directive.transaction_id,
                    redo_round: redoRound,
                    reason_code: reasonCode,
                    detail,
                },
            },
        };
    }
    /** v2.10: Build a backtrack result. The directive is already committed;
     *  LoopForge executes and verifies the restore, then compiles the redo from
     *  the verified baseline. A failed restore leaves the directive pending and
     *  the session stalled — no redo prompt is ever issued unverified. */
    async buildBacktrackResult(sessionId, session, pr, receiptBase, inputs) {
        const directive = pr.recovery;
        if (!directive) {
            session.status = "stalled";
            this.save(session);
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "A backtrack was committed without a rollback directive.",
            };
        }
        const newRound = directive.target.redo_round;
        logEvent("session_recovery", {
            sessionId,
            loopId: session.loopId,
            fromRound: session.currentRound,
            toRound: newRound,
            origin: directive.origin,
            triggerRule: directive.trigger_rule ?? "",
            checkpointId: directive.target.checkpoint_id,
            skippedDiscoveries: directive.skipped_discoveries.length,
        });
        session.consecutiveRejections = 0;
        session.lastRejectionCheck = "";
        const recoveryFlags = pr.verificationFlags.length > 0
            ? pr.verificationFlags
            : (directive.trigger_findings ?? []);
        const outcome = await this.runRestoreAndPrepare(session, directive, {
            verificationFlags: recoveryFlags,
            ...(inputs ? { inputs } : {}),
        });
        if (!outcome.ok) {
            return {
                ...outcome.result,
                agentSuccessClaim: pr.agentSuccessClaim,
                agentOutcome: pr.agentOutcome,
                enforcementAction: directive.origin === "agent" ? "recovery" : "backtrack",
                evidencePosture: pr.evidencePosture,
                enforcementReason: pr.reason ?? pr.enforcementReason,
            };
        }
        const { restore, prepared } = outcome;
        session.roundSnapshot = prepared.snapshot;
        this.seedEntrypointTrust(session);
        this.save(session);
        const nextArtifact = prepared.artifact ??
            prepared.compileResponse?.prompt_artifact ?? null;
        return {
            sessionId,
            round: newRound,
            ...this.heldHandle(session),
            ...this.transactionFacts(session),
            ...this.contextFacts(nextArtifact),
            prompt: prepared.prompt,
            level: prepared.level,
            agentSuccessClaim: pr.agentSuccessClaim,
            agentOutcome: pr.agentOutcome,
            enforcementAction: directive.origin === "agent" ? "recovery" : "backtrack",
            evidencePosture: pr.evidencePosture,
            enforcementReason: pr.reason ?? pr.enforcementReason,
            recovery: {
                origin: directive.origin,
                reason: directive.reason,
                target_checkpoint_id: directive.target.checkpoint_id,
                redo_round: newRound,
                restore: {
                    status: "verified",
                    ...(restore.head ? { head: restore.head } : {}),
                    ...(restore.previousHead ? { previous_head: restore.previousHead } : {}),
                    ...(restore.safetyRef ? { safety_ref: restore.safetyRef } : {}),
                    files_written: restore.filesWritten,
                    files_deleted: restore.filesDeleted,
                    verified_at: restore.verifiedAt,
                },
            },
            warnings: prepared.warnings ?? [],
            submission_guidance: this.guidanceFor(session, {
                verificationFlags: recoveryFlags,
                recovery: {
                    pending: true,
                    redo_round: newRound,
                    checkpoint_id: directive.target.checkpoint_id,
                    restore_verified: session.roundSnapshot.restore?.directiveTransactionId ===
                        directive.transaction_id,
                    origin: directive.origin,
                    reason: directive.reason,
                },
            }),
            submission_receipt: this.buildReceipt(receiptBase, {
                disposition: "backtracked",
                nextArtifact,
                afterSubGoals: null,
                constraintsActiveAfter: null,
                contractAfterId: receiptBase.beforeContractId,
                // The SAME verified-restore fact the top-level recovery reports.
                restoreVerified: true,
            }),
        };
    }
    /** v4.0.4: the ONE terminal stop-detail formatter. Live stop, termination,
     *  crash-recovered stop and resume-of-stopped read the same three fact
     *  blocks; a committed fact is described identically on every path. */
    terminalFacts(pr, reason, selfEval, committed) {
        return {
            agent: selfEval
                ? {
                    successClaim: selfEval.success,
                    outcome: effectiveOutcome(selfEval),
                    outcomeDeclared: selfEval.outcome ?? null,
                    shouldContinue: selfEval.should_continue,
                    agentStopReason: selfEval.agent_stop_reason ?? null,
                }
                : null,
            loopforge: {
                action: pr.action,
                loopStopReason: reason,
                enforcementReason: pr.enforcementReason ?? null,
            },
            machine: {
                posture: pr.evidencePosture ?? null,
                committed,
            },
        };
    }
    /** v4.0.4: the terminal result of an already-stopped loop, built from
     *  committed history. This is the ONE read path for `resume` of a stopped
     *  loop: it reports the committed `StopReason` and renders the same three
     *  fact blocks as a live stop. A loop with no committed stop round reports
     *  the session status and says so instead of inventing a reason. */
    stoppedLoopResult(loopId, currentRound) {
        const history = loadCommittedHistory(this.store, loopId);
        if (history.legacyRounds.length > 0) {
            throw new LegacyHistoryError(loopId, history.legacyRounds.map((round) => round.round));
        }
        const terminal = [...history.rounds].reverse().find((view) => view.result?.stopReason !== undefined &&
            view.result?.stopReason !== null);
        const reason = terminal?.result?.stopReason;
        if (!terminal || !reason) {
            return {
                sessionId: "",
                round: currentRound,
                prompt: null,
                sessionStatus: "stopped",
                stopDetail: "Loop is stopped; there is no committed terminal reason for this " +
                    "loop (it may have been cancelled before a stop round committed).",
            };
        }
        return {
            sessionId: "",
            round: currentRound,
            prompt: null,
            stopReason: reason,
            sessionStatus: "stopped",
            stopDetail: renderResultFacts(this.terminalFacts(terminal.result, reason, terminal.evaluation ?? null, true), "terminal").join("\n"),
            agentSuccessClaim: terminal.agentSuccessClaim,
            agentOutcome: terminal.agentOutcome,
            agentStopReason: terminal.evaluation?.agent_stop_reason,
            agentShouldContinue: terminal.evaluation?.should_continue,
            submission_receipt: deriveCommittedSubmissionView(terminal, history.rounds, history.directives),
        };
    }
    /** Build a termination result: persist stopped status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt
     *
     *  v3.8.3: the enforcement gate may NAME its own stop reason (the
     *  contract-debt row terminates as `incomplete`). This used to hard-code
     *  `enforcement_terminated`, so the specific reason reached observability
     *  and the client as a generic one — the fact was computed and then thrown
     *  away. Pass it through, falling back only when the gate named nothing. */
    buildTerminationResult(sessionId, session, pr,
    /** v3.8.3: see buildStopResult. */
    guardedReason, receiptBase) {
        const reason = guardedReason ?? pr.stopReason ?? "enforcement_terminated";
        session.status = "stopped";
        // v3.8.3: no round is in flight once the loop stops — the in-flight trust
        // baseline goes with it, so a later resume cannot compare against a state
        // from a previous life.
        session.entrypointTrust = undefined;
        this.save(session);
        void this.notifyTerminal(session, reason);
        logEvent("session_end", {
            sessionId, loopId: session.loopId,
            stopReason: reason, round: session.currentRound,
        });
        return {
            sessionId,
            round: session.currentRound,
            prompt: null,
            stopReason: reason,
            sessionStatus: "stopped",
            agentSuccessClaim: pr.agentSuccessClaim,
            agentOutcome: pr.agentOutcome,
            agentStopReason: receiptBase.selfEval.agent_stop_reason,
            agentShouldContinue: receiptBase.selfEval.should_continue,
            // v4.0.4: a terminated attempt never committed, so its posture is
            // explicitly transient; no committed receipt is fabricated.
            stopDetail: renderResultFacts(this.terminalFacts(pr, reason, receiptBase.selfEval, false), "terminal").join("\n"),
            enforcementAction: "terminate",
            evidencePosture: pr.evidencePosture,
            enforcementReason: pr.enforcementReason,
            submission_receipt: this.buildReceipt(receiptBase, {
                disposition: "terminated",
                nextArtifact: null,
                afterSubGoals: null,
                constraintsActiveAfter: null,
                contractAfterId: receiptBase.beforeContractId,
            }),
        };
    }
    /** Build a stop result: persist stopped/stalled status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt */
    buildStopResult(sessionId, session, pr,
    /** v3.8.3: the reason AFTER the completion-truth guard (advanceUnlocked).
     *  Absent on the replay paths, which then read `pr.stopReason` directly. */
    guardedReason, receiptBase) {
        const reason = guardedReason ?? pr.stopReason ?? "stalled";
        session.status = reason === "stalled" ? "stalled" : "stopped";
        // v3.8.3: see buildTerminationResult — the in-flight trust baseline dies
        // with the in-flight round.
        session.entrypointTrust = undefined;
        this.save(session);
        void this.notifyTerminal(session, reason);
        logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: reason, round: session.currentRound });
        return {
            sessionId, round: session.currentRound,
            prompt: null, stopReason: reason,
            sessionStatus: session.status,
            agentSuccessClaim: pr.agentSuccessClaim,
            agentOutcome: pr.agentOutcome,
            agentStopReason: receiptBase.selfEval.agent_stop_reason,
            agentShouldContinue: receiptBase.selfEval.should_continue,
            // v4.0.4: `completed` no longer implies machine success; the three
            // fact blocks state the Agent report, the LoopForge decision and the
            // persisted posture separately.
            stopDetail: renderResultFacts(this.terminalFacts(pr, reason, receiptBase.selfEval, true), "terminal").join("\n"),
            evidencePosture: pr.evidencePosture,
            submission_receipt: this.buildReceipt(receiptBase, {
                disposition: "stopped",
                nextArtifact: null,
                constraintsActiveAfter: null,
            }),
        };
    }
    /** Compile the next round's prompt and advance the session.
     *  Includes the commit fence (pause/delete race guard) and context provider.
     *  MUTATES: session.currentRound, session.currentPrompt, session.currentLevel,
     *           session.evidenceBaseline, session.roundSnapshot */
    async advanceToNextRound(sessionId, session, selfEval, pr, actualEvidence, receiptBase, inputs) {
        const agentSuccessClaim = pr.agentSuccessClaim;
        // M4 (v3.7.x): replay guard. The counter may already point past the
        // committed round when this continue is a REPLAY — after a crash or an
        // in-process exception between the round's commit and this compile, the
        // previous attempt already incremented currentRound but never compiled
        // the next round. An unconditional ++ would silently skip that round's
        // prompt and poison the vault sequence (see reconcileCommittedRound's
        // v2.14 counter guard — the live path must use the same judgement).
        if (!session.roundSnapshot || session.currentRound <= session.roundSnapshot.round) {
            session.currentRound++;
        }
        // Commit fence: pause()/delete() may run while prepare is awaited.
        if (this.registry.get(sessionId) !== session || session.status !== "running") {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                sessionStatus: session.status,
                stopDetail: `Session is no longer running (status: ${session.status}). It was paused or deleted while the next prompt was being prepared.`,
                agentSuccessClaim,
            };
        }
        // v4.0.5: a new round never inherits an earlier artifact's instruction;
        // only the explicit host input for this call travels.
        const request = buildLoopRequest(session, inputs);
        let prepared;
        try {
            prepared = await this.driver(session.engine, session.loopId).prepare(request, session.loopId, session.currentRound, this.prepareOptions(session));
        }
        catch (error) {
            // M4: a post-commit compile exception must not silently strand the
            // session between rounds. The round above already committed — turn the
            // session into the same stalled state the crash-recovery siblings use,
            // so the agent gets a retryable result instead of a raw -32603 with a
            // mutated, unsaved session (which let a replay skip the next round).
            logEvent("compile_failed", {
                loopId: session.loopId,
                round: session.currentRound,
                error: String(error),
            });
            if (error instanceof ProjectionCoverageError) {
                // v3.9.4: the failure is a projection code defect, not a work-quality
                // verdict. Keep the committed round held and surface the stable code.
                return this.stalledAfterCommit(sessionId, session, agentSuccessClaim, error.message, { code: "projection_incomplete", details: { coverage: error.coverage } });
            }
            if (error instanceof CompileFailureError) {
                return this.stalledAfterCommit(sessionId, session, agentSuccessClaim, `The round committed but the next prompt could not be compiled: ${error.message}. ` +
                    `Call loopforge_resume to reconcile the commit and retry.`);
            }
            return this.stalledAfterCommit(sessionId, session, agentSuccessClaim, `RoundDriver.prepare threw after the round committed: ${String(error).slice(0, 300)}. ` +
                `The session is stalled with the committed round still held — call ` +
                `loopforge_resume to reconcile it and compile the next prompt.`);
        }
        // Commit fence after the async prepare: pause()/delete() may have run
        // while the compile/evidence collection was in flight. Do not install a
        // prompt into a session that is no longer running.
        if (this.registry.get(sessionId) !== session || session.status !== "running") {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                sessionStatus: session.status,
                stopDetail: `Session is no longer running (status: ${session.status}). It was paused or deleted while the next prompt was being prepared.`,
                agentSuccessClaim,
            };
        }
        const nextPrompt = prepared.prompt;
        const nextLevel = prepared.level;
        session.roundSnapshot = prepared.snapshot;
        // v3.8.3: the round that just committed is history; the trust baseline
        // moves to the round being prepared now.
        this.seedEntrypointTrust(session);
        policyMetrics.recordStrategy(session.loopId, nextLevel);
        try {
            this.save(session);
        }
        catch (error) {
            // The compiled prompt still lives in memory; surface it as a stalled
            // result so a resume returns the held prompt rather than re-running
            // the committed round.
            logEvent("session_save_failed", {
                loopId: session.loopId,
                round: session.currentRound,
                error: String(error),
            });
            return this.stalledAfterCommit(sessionId, session, agentSuccessClaim, `The round committed but the session state could not be persisted: ${String(error).slice(0, 300)}. ` +
                `Resume the loop to recover the held prompt.`);
        }
        const compiled = prepared.compileResponse;
        const nextArtifact = prepared.artifact ?? compiled?.prompt_artifact ?? null;
        return {
            sessionId,
            round: session.currentRound,
            ...this.heldHandle(session),
            ...this.transactionFacts(session),
            ...this.contextFacts(nextArtifact),
            prompt: nextPrompt,
            level: nextLevel,
            agentSuccessClaim,
            agentOutcome: pr.agentOutcome,
            warnings: prepared.warnings ?? [],
            submission_guidance: this.guidanceFor(session),
            submission_receipt: this.buildReceipt(receiptBase, {
                disposition: "accepted",
                nextArtifact,
                afterSubGoals: compiled?.sub_goals ?? null,
                constraintsActiveAfter: compiled?.constraints_active ?? null,
                constraintsRetiredAfter: compiled?.constraints_retired ?? null,
            }),
        };
    }
    /** M4: mark a session stalled after its round committed but the next
     *  prompt could not be prepared/persisted. v4.0.0: the committed snapshot is
     *  NOT a held prompt, so this result carries no handle; the Agent must call
     *  `loopforge_resume`, which reconciles the commit and compiles the next
     *  prompt. Re-submitting an old handle can never resurrect the old round. */
    stalledAfterCommit(sessionId, session, agentSuccessClaim, detail, projectionError) {
        session.status = "stalled";
        try {
            this.save(session);
        }
        catch (error) {
            logEvent("session_save_failed", {
                loopId: session.loopId,
                round: session.currentRound,
                error: String(error),
            });
        }
        return {
            sessionId,
            round: session.currentRound,
            prompt: null,
            stopReason: "stalled",
            stopDetail: detail,
            agentSuccessClaim,
            ...(projectionError ? { projectionError } : {}),
        };
    }
    async advanceUnlocked(sessionId, output, preExtractedEval, normalizationDiagnostics, submittedFields, inputs) {
        // ── 1. Validate session ──────────────────────────────────────────────
        // The handle identity (including the exact transaction attempt) was
        // already validated by SessionManager before its queue and lease
        // heartbeat. This lifecycle owns the round state machine, not a second
        // anchor rule.
        const session = this.registry.get(sessionId);
        if (!session) {
            return {
                sessionId,
                round: 0,
                prompt: null,
                submissionError: {
                    code: "session_not_found",
                    details: {
                        detail: "No session exists with this ID. It may have expired, been " +
                            "deleted, or never existed.",
                    },
                },
            };
        }
        if (session.status !== "running" && session.status !== "stalled") {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                sessionStatus: session.status,
                stopDetail: `Session is ${session.status}. Use loopforge_resume to restart a ` +
                    "paused session, or loopforge_start for a new task.",
            };
        }
        // v3.9.7: a pending rollback directive with no verified redo snapshot
        // means the workspace is (or may be) mid-restore. Ordinary work must not
        // be evaluated against it. Resume completes the restore first.
        // v4.0.1: this is the ONE pre-commit history read of the advance path; the
        // before facts and the evaluation coordinator share it.
        const history = loadCommittedHistory(this.store, session.loopId);
        const pending = history.pendingDirective;
        if (pending?.recovery &&
            (session.roundSnapshot?.restore?.directiveTransactionId !==
                pending.recovery.transaction_id ||
                session.roundSnapshot.round !== pending.recovery.target.redo_round)) {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: "stalled",
                submissionError: {
                    code: "restore_pending",
                    details: {
                        loopId: session.loopId,
                        directive_transaction_id: pending.recovery.transaction_id,
                        redo_round: pending.recovery.target.redo_round,
                        detail: "A pending restore must be completed by loopforge_resume before work can be submitted.",
                    },
                },
            };
        }
        // A stalled compiler preparation is retryable against the same held
        // round. Format errors never set this status; they return before advance.
        if (session.status === "stalled") {
            session.status = "running";
        }
        // ── 2. Extract self-evaluation ───────────────────────────────────────
        const extracted = this.extractEvaluation(output, preExtractedEval);
        if (!extracted) {
            return {
                sessionId,
                round: session.currentRound,
                ...this.heldHandle(session),
                prompt: null,
                submissionError: {
                    code: "evaluation_invalid",
                    details: {
                        detail: "A structured evaluation object is required. Resubmit the same " +
                            "submissionHandle with success, output_summary, " +
                            "constraint_violations, and should_continue.",
                    },
                },
                stopDetail: "A structured evaluation object is required. Resubmit the same " +
                    "submissionHandle with success, output_summary, " +
                    "constraint_violations, and should_continue.",
            };
        }
        const selfEval = extracted;
        // ── 3. Execute round transaction ─────────────────────────────────────
        // Capture the before facts from the shared compile window BEFORE the
        // transaction commits (a replay sees the same window: rounds < R).
        const beforeFacts = this.beforeFactsFor(session, history);
        const tx = await this.executeRoundTransaction(session, selfEval, normalizationDiagnostics, submittedFields, history);
        const receiptSnapshot = session.roundSnapshot;
        if (!receiptSnapshot) {
            throw new Error("The committed round transaction disappeared before the receipt was built.");
        }
        // v4.0.3: a REPLAYED commit is reported from its committed payload, not
        // from the new submission that happened to carry the same identity.
        const receiptSelfEval = tx.replayed
            ? receiptSnapshot.evaluation ?? selfEval
            : selfEval;
        const receiptBase = {
            snapshot: receiptSnapshot,
            selfEval: receiptSelfEval,
            pr: tx.pr,
            actualEvidence: tx.replayed
                ? (receiptSnapshot.afterEvidence ?? [])
                : tx.actualEvidence,
            diagnostics: tx.replayed
                ? (receiptSnapshot.normalizationDiagnostics ?? [])
                : (receiptSnapshot.normalizationDiagnostics ??
                    normalizationDiagnostics ?? []),
            submittedFields: tx.replayed
                ? (receiptSnapshot.submittedFields ?? [])
                : (receiptSnapshot.submittedFields ?? submittedFields ?? []),
            beforeContractId: beforeFacts.contractId,
            beforeSubGoals: beforeFacts.subGoals,
            recoveryDirective: beforeFacts.recoveryDirective,
            replayed: tx.replayed,
        };
        // v2.12: Record a user gate when an accepted round reports a high-risk
        // blocker. Record layer only — never blocks the round decision flow.
        if (tx.pr.action !== "reject" && tx.pr.action !== "terminate" &&
            declaresBlocked(receiptSelfEval) &&
            typeof receiptSelfEval.blocker === "string") {
            this.recordGateFromBlocked(session, receiptSelfEval.blocker);
        }
        // ── 4. Route disposition ─────────────────────────────────────────────
        if (tx.pr.action === "reject") {
            return this.buildRejectionResult(sessionId, session, tx.pr, tx.verificationFlags, receiptBase, inputs);
        }
        // ── v2.10/v3.9.6: recovery directive (machine or agent) ───────────────
        if (tx.pr.action === "backtrack" || tx.pr.action === "recovery") {
            return this.buildBacktrackResult(sessionId, session, tx.pr, receiptBase, inputs);
        }
        // Accepted rounds advance the before-snapshot baseline. Rejected rounds
        // retain the original baseline so their retry remains zero-commit.
        // v3.8.3: completion truth — the second line, at the point the disposition
        // becomes the reported stop reason. The coordinator already guards the
        // reason it COMMITS (the round document carries result.stopReason), so
        // this guards what the client and the terminal notification see. A
        // violation can only be a code defect: it degrades to the honest reason
        // and leaves an observability record instead of throwing mid-lifecycle.
        const finalized = finalizeStopReason(tx.pr.stopReason, receiptSelfEval, undefined, receiptSelfEval.contract_transition ?? null);
        if (finalized.reason !== tx.pr.stopReason) {
            logEvent("completion_truth_downgraded", {
                loopId: session.loopId,
                round: session.currentRound,
                from: tx.pr.stopReason ?? "",
                to: finalized.reason ?? "",
            });
        }
        if (tx.pr.action === "terminate") {
            return this.buildTerminationResult(sessionId, session, tx.pr, finalized.reason, receiptBase);
        }
        if (tx.pr.action === "stop") {
            return this.buildStopResult(sessionId, session, tx.pr, finalized.reason, receiptBase);
        }
        // ── 5. Continue — compile next round ─────────────────────────────────
        return this.advanceToNextRound(sessionId, session, selfEval, tx.pr, tx.actualEvidence, receiptBase, inputs);
    }
    /** v3.9.6: Agent-initiated recovery. The Agent selects the target; this
     *  method only validates it against committed facts, records the rollback
     *  directive and compiles the redo. It never runs ordinary verification or
     *  enforcement on the abandoned work. */
    async recover(sessionId, recovery, inputs) {
        const session = this.registry.get(sessionId);
        if (!session) {
            return {
                sessionId,
                round: 0,
                prompt: null,
                submissionError: {
                    code: "session_not_found",
                    details: { detail: "No session exists with this ID." },
                },
            };
        }
        if (session.status !== "running" && session.status !== "stalled") {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                sessionStatus: session.status,
                stopDetail: `Session is ${session.status}.`,
            };
        }
        if (!getPolicy().engine.agent_recovery_enabled) {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                submissionError: {
                    code: "recovery_disabled",
                    details: { policy: "engine.agent_recovery_enabled" },
                },
            };
        }
        // The handle identity (including the exact transaction attempt) was
        // validated by SessionManager before its queue and lease heartbeat.
        const held = session.roundSnapshot;
        // Pending directive first: one directive is the record, so a repeated
        // request never reads a new target and never commits a second directive.
        const pending = await this.completePendingRecovery(session, inputs);
        if (pending)
            return pending;
        if (held?.kind !== "evaluation" || held.round !== session.currentRound) {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                submissionError: {
                    code: "recovery_invalid",
                    details: {
                        reason_code: "no_held_evaluation",
                        detail: "recovery requires a held evaluation prompt for the current round",
                    },
                },
            };
        }
        const entries = loadCommittedHistory(this.store, session.loopId).entries;
        const found = findCheckpointRef({
            entries,
            held,
            checkpointId: recovery.target_checkpoint_id,
        });
        if (!found.ok) {
            return {
                sessionId,
                round: session.currentRound,
                ...this.heldHandle(session),
                ...this.transactionFacts(session),
                prompt: null,
                submissionError: {
                    code: found.code,
                    details: {
                        target_checkpoint_id: recovery.target_checkpoint_id,
                        reason_code: found.reason,
                        detail: found.detail,
                        current_round: session.currentRound,
                    },
                },
            };
        }
        const ref = found.ref;
        const store = this.checkpointStoreFor?.(session.loopId);
        if (!store) {
            return {
                sessionId,
                round: session.currentRound,
                ...this.heldHandle(session),
                ...this.transactionFacts(session),
                prompt: null,
                submissionError: {
                    code: "recovery_unavailable",
                    details: {
                        target_checkpoint_id: recovery.target_checkpoint_id,
                        reason_code: "store_unavailable",
                        detail: "no workspace checkpoint store is attached to this runtime",
                    },
                },
            };
        }
        const manifest = store.readManifest(ref.checkpointId);
        const validated = validateCheckpointManifest(ref, manifest);
        if (!validated.ok) {
            return {
                sessionId,
                round: session.currentRound,
                ...this.heldHandle(session),
                ...this.transactionFacts(session),
                prompt: null,
                submissionError: {
                    code: validated.code,
                    details: {
                        target_checkpoint_id: recovery.target_checkpoint_id,
                        reason_code: validated.reason,
                        detail: validated.detail,
                    },
                },
            };
        }
        // Deep preflight BEFORE the directive: an invalid target must leave no
        // directive and no session cursor change.
        try {
            const context = this.restoreContext();
            await preflightRestore({
                manifest: validated.manifest,
                workspace: context.workspace,
                store,
                ...(context.stateDir ? { stateDir: context.stateDir } : {}),
                exclude: context.exclude,
            });
        }
        catch (error) {
            return {
                sessionId,
                round: session.currentRound,
                ...this.heldHandle(session),
                ...this.transactionFacts(session),
                prompt: null,
                submissionError: {
                    code: "recovery_unavailable",
                    details: {
                        target_checkpoint_id: recovery.target_checkpoint_id,
                        reason_code: error instanceof RestoreFailure
                            ? error.reasonCode
                            : "preflight_failed",
                        detail: String(error instanceof Error ? error.message : error),
                    },
                },
            };
        }
        const target = {
            checkpoint_id: ref.checkpointId,
            content_hash: ref.contentHash,
            role: ref.role,
            round: ref.round,
            round_id: ref.roundId,
            transaction_id: ref.transactionId,
            redo_round: ref.redoRound,
        };
        const abandoned = branchRounds(entries).filter((view) => view.round >= ref.redoRound);
        const reportedSkippedFiles = [...new Set(abandoned.flatMap((view) => (view.executionReport?.files_changed ?? [])))].sort();
        const directiveTransactionId = deriveTransactionId({
            kind: "rollback",
            branchId: held.branchId ?? rootBranchId(session.loopId),
            roundId: held.roundId,
            attempt: 1,
            promptHash: held.promptArtifact?.promptHash,
            recovery: {
                target,
                reason: recovery.reason,
                abandonedRounds: abandoned.map((view) => view.round),
                reportedSkippedFiles,
            },
        });
        const completed = await new RoundDriver(session.engine, this.store, store).completeRecovery({
            snapshot: held,
            loopId: session.loopId,
            buildRecovery: (actualEvidence) => deriveRecoveryDirective({
                origin: "agent",
                reason: recovery.reason,
                transactionId: directiveTransactionId,
                targetRef: ref,
                targetManifest: validated.manifest,
                abandonedRounds: abandoned,
                currentAfterEvidence: actualEvidence,
                triggerRound: session.currentRound,
            }),
        });
        const directive = completed.outcome.snapshot.recovery;
        if (!directive) {
            return this.restoreFailedResult(session, {
                origin: "agent",
                reason: recovery.reason,
                target,
                skipped_files: [],
                skipped_discoveries: [],
                failed_rounds: [],
                approaches: [],
                wrong_assumptions: [],
                transaction_id: directiveTransactionId,
            }, "directive_unavailable", "the committed rollback directive could not be read back");
        }
        return this.restoreAndPrepareRedo(session, directive, inputs);
    }
    /** Execute the committed directive's restore and return the redo prompt. */
    async restoreAndPrepareRedo(session, directive, inputs) {
        const outcome = await this.runRestoreAndPrepare(session, directive, {
            ...(inputs ? { inputs } : {}),
        });
        if (!outcome.ok)
            return outcome.result;
        const { restore, prepared } = outcome;
        const result = this.persistPrepared(session, {
            prompt: prepared.prompt,
            level: prepared.level,
            baseline: prepared.evidenceBaseline,
            snapshot: prepared.snapshot,
            warnings: prepared.warnings ?? [],
        }, false);
        return {
            ...result,
            submission_guidance: this.guidanceFor(session, {
                recovery: {
                    pending: true,
                    redo_round: directive.target.redo_round,
                    checkpoint_id: directive.target.checkpoint_id,
                    restore_verified: true,
                    origin: directive.origin,
                    reason: directive.reason,
                },
            }),
            recovery: {
                origin: directive.origin,
                reason: directive.reason,
                target_checkpoint_id: directive.target.checkpoint_id,
                redo_round: directive.target.redo_round,
                restore: {
                    status: "verified",
                    ...(restore.head ? { head: restore.head } : {}),
                    ...(restore.previousHead ? { previous_head: restore.previousHead } : {}),
                    ...(restore.safetyRef ? { safety_ref: restore.safetyRef } : {}),
                    files_written: restore.filesWritten,
                    files_deleted: restore.filesDeleted,
                    verified_at: restore.verifiedAt,
                },
            },
        };
    }
    /** Core cycle entry used by SessionManager.advance after the queue + lease
     *  dance: validate → extract → execute transaction → route disposition
     *  → advance to next round (continue) or return terminal result.
     *  v4.0.0: the submission identity (the exact held transaction) is validated
     *  by SessionManager before its queue and lease heartbeat. This entry point
     *  owns the round state machine and does not re-check anchors. */
    async advance(sessionId, output, preExtractedEval, normalizationDiagnostics, submittedFields,
    /** v4.0.5: invocation input for the prompt compiled after this submission. */
    inputs) {
        return this.advanceUnlocked(sessionId, output, preExtractedEval, normalizationDiagnostics, submittedFields, inputs);
    }
    /** Write back loop knowledge to long-term memory.
     *  Uses shared base builder from policy.ts. Called when a loop terminates. */
    async notifyTerminal(session, stopReason) {
        if (this.terminalSinks.size === 0)
            return;
        const views = loadCommittedHistory(this.store, session.loopId).rounds;
        const lastView = views.length > 0 ? views[views.length - 1] : undefined;
        // v4.0.3: the trajectory records MACHINE-BACKED success only.
        const machineBackedSuccessTrajectory = views
            .filter((view) => view.result?.shouldPushSuccessTrajectory === true &&
            view.result?.evidencePosture?.machineBackedSuccess === true)
            .map((view) => view.agentSuccessClaim);
        const event = {
            loopId: session.loopId,
            task: session.task,
            completed: stopReason === "completed",
            // v4.0.4: no committed posture is unknown, never a synthesized false.
            machineBackedSuccess: lastView?.evidencePosture?.machineBackedSuccess ?? null,
            evidencePosture: lastView?.evidencePosture ?? null,
            stopReason: stopReason,
            // v4.0.4: keep the historical alias, but state the two facts separately.
            roundsCompleted: session.currentRound,
            roundCursor: session.currentRound,
            committedRounds: views.length,
            machineBackedSuccessTrajectory,
            lastEvaluation: lastView?.evaluation ?? undefined,
        };
        await Promise.allSettled([...this.terminalSinks].map((sink) => Promise.resolve(sink(event))));
    }
}
//# sourceMappingURL=round-lifecycle.js.map