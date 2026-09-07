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
import { LoopForgeEngine } from "../engine.js";
import { deriveGate } from "../cognitive-governance.js";
import { Mode, makeLoopCompileRequest, makeLoopRoundResult, } from "../protocol.js";
import { EvidenceCollector, runBacktrackAutoRestore } from "../evidence-provider.js";
import { makeRoundId, parseRoundTransactionSnapshot, prepareRoundTransaction, } from "../round-transaction.js";
import { RoundDriver } from "../round-driver.js";
import { getPolicy } from "../policy.js";
import { checkRoundSequence, queryLoopEntries } from "../loop-store.js";
import { logEvent } from "../observability.js";
import { policyMetrics } from "../policy-metrics.js";
// ── Types ──────────────────────────────────────────────────────────────────
/** M3: parse a persisted skipped-file fingerprint map (string → string). */
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
// ── Helpers ────────────────────────────────────────────────────────────────
export function buildLoopRequest(session, lastEval, verificationFlags) {
    const req = {
        task: session.task,
        mode: Mode.LOOP_COMPILE,
        feedback: null,
        skill_name: null,
        task_id: null,
        loop_id: session.loopId,
        round: session.currentRound,
        max_rounds: session.maxRounds,
        verification_flags: verificationFlags ?? [],
    };
    if (lastEval) {
        req.last_round_result = makeLoopRoundResult({
            round: session.currentRound - 1,
            success: lastEval.success,
            output_summary: lastEval.output_summary,
            constraint_violations: lastEval.constraint_violations,
            manual_fixes_needed: "",
            // P0–P2: Forward evolution fields to next compile
            // Merge sub-agent discovered constraints into the active set
            discovered_constraints: [
                ...new Set([
                    ...(lastEval.discovered_constraints ?? []),
                    ...(lastEval.worker_results ?? []).flatMap((w) => w.discoveredConstraints ?? []).filter((c) => c.length > 0),
                ]),
            ],
            objective_refinement: lastEval.objective_refinement ?? "",
            emerged_subtasks: lastEval.emerged_subtasks ?? [],
            // P4: Execution evidence
            execution_evidence: lastEval.execution_evidence ?? undefined,
            // P5: Self-correction
            retracted_constraints: lastEval.retracted_constraints ?? [],
            revised_success_criteria: lastEval.revised_success_criteria ?? [],
            wrong_assumptions: lastEval.wrong_assumptions ?? [],
            // Multi-agent: Forward delegation results to next compile
            worker_results: lastEval.worker_results ?? [],
            // v1.10: Checkpoint boundary
            compression_checkpoint: lastEval.compression_checkpoint ?? false,
            checkpoint_label: lastEval.checkpoint_label ?? "",
            // v1.16: Agent's declared next action
            next_action: lastEval.next_action,
            // v3.7.1: Sub-goal lifecycle — explicit transitions
            subgoal_updates: lastEval.subgoal_updates ?? [],
            // v2.8: Drift clarification
            drift_clarification: lastEval.drift_clarification,
            // v2.9: Model's information needs for the next prompt
            prompt_requests: lastEval.prompt_requests,
            // v2.12: Tri-state outcome + blocker + retroactive claims
            outcome: lastEval.outcome,
            blocker: lastEval.blocker,
            retroactiveClaims: lastEval.retroactiveClaims ?? [],
            // v3.3: round_contract was carried here so it could drive the next
            // round's Current Task. v3.4: intentionally NOT forwarded — the
            // submission's round_contract is a PROPOSAL for the next round, and
            // the ACTIVE contract is derived from committed rounds at compile time
            // (loop-compiler.deriveActiveContract), which also keeps it correct on
            // retry / resume / unpause / backtrack compiles that have no
            // last_round_result. Reading this field again would reintroduce the
            // second source of truth the derivation replaced.
        });
    }
    return req;
}
// ── RoundLifecycle ─────────────────────────────────────────────────────────
export class RoundLifecycle {
    store;
    sessionStore;
    registry;
    terminalSinks;
    ownerId;
    leaseMs;
    getContext;
    constructor(deps) {
        this.store = deps.store;
        this.sessionStore = deps.sessionStore;
        this.registry = deps.registry;
        this.terminalSinks = deps.terminalSinks;
        this.ownerId = deps.ownerId;
        this.leaseMs = deps.leaseMs;
        this.getContext = deps.getContext;
    }
    /** Persist session state to vault for cross-process recovery.
     *  The filtered vault and replacement entry are written once under the
     *  backend lock, so recovery never observes the old two-write gap. */
    save(session) {
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
                success_trajectory: session.successTrajectory,
                status: session.status,
                created_at: session.createdAt,
                // v1.13: Enforcement gate state
                consecutive_rejections: session.consecutiveRejections,
                last_rejection_check: session.lastRejectionCheck,
                // v2.12: Clarification streak
                drift_clarification_streak: session.driftClarificationStreak,
                // v2.13: Backtrack skipped files for workspace restore check
                backtrack_skipped_files: session.backtrackSkippedFiles,
                // M3: skipped-file fingerprints at their failed rounds (restore
                // check machine arm) — empty unless a backtrack is pending
                backtrack_skipped_fingerprints: session.backtrackSkippedFingerprints,
                // v2.12: Backtrack restore-point git HEAD (crash recovery)
                backtrack_target_git_head: session.backtrackTargetGitHead ?? null,
                // v1.19: durable round transaction state
                round_snapshot: session.roundSnapshot ?? null,
                last_self_eval: session.lastSelfEval ?? null,
                current_prompt: session.currentPrompt ?? null,
                current_level: session.currentLevel ?? "",
                // v1.20: cross-process single-owner lease
                lease_owner: leaseActive ? this.ownerId : "",
                lease_expires_at: leaseActive ? Date.now() + this.leaseMs : 0,
            },
        };
        this.sessionStore.save(sessionEntry, {
            expectedLeaseOwner: this.ownerId,
        });
    }
    /** Reconstruct a McpSession from a vault session_state entry.
     *  Returns null if the entry is not "running" status.
     *  Shared by resume() and autoResumeAll(). */
    reconstructSession(entry, allowPaused = false) {
        const lineage = (entry.loop_lineage ?? {});
        const status = lineage.status ?? "running";
        if (status !== "running" && !(allowPaused && status === "paused")) {
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
        const successTrajectory = Array.isArray(lineage.success_trajectory)
            ? lineage.success_trajectory.filter((value) => typeof value === "boolean")
            : [];
        const task = entry.task ?? "";
        const maxRounds = lineage.max_rounds ?? getPolicy().engine.max_rounds;
        const roundSnapshot = parseRoundTransactionSnapshot(lineage.round_snapshot);
        // v3.7: the synchronous evidence fallback was removed (async providers
        // could never be collected synchronously — they were skipped and logged
        // as failures). Every path that needs evidence re-collects asynchronously
        // through prepare()/unpause(); a missing snapshot starts with no baseline.
        const fallbackEvidence = [];
        const persistedEval = lineage.last_self_eval;
        const lastSelfEval = persistedEval !== null &&
            typeof persistedEval === "object" &&
            !Array.isArray(persistedEval) &&
            typeof persistedEval.success === "boolean" &&
            typeof persistedEval.output_summary === "string"
            ? persistedEval
            : undefined;
        const engine = new LoopForgeEngine(this.store);
        return {
            sessionId: typeof lineage.session_id === "string" && lineage.session_id
                ? lineage.session_id
                : randomUUID(),
            loopId, task, engine,
            currentRound, maxRounds, successTrajectory,
            status: status,
            createdAt: lineage.created_at ?? Date.now(),
            consecutiveRejections: lineage.consecutive_rejections ?? 0,
            lastRejectionCheck: typeof lineage.last_rejection_check === "string"
                ? lineage.last_rejection_check
                : "",
            driftClarificationStreak: lineage.drift_clarification_streak ?? 0,
            backtrackSkippedFiles: lineage.backtrack_skipped_files ?? [],
            backtrackSkippedFingerprints: parseFingerprintMap(lineage.backtrack_skipped_fingerprints),
            backtrackTargetGitHead: typeof lineage.backtrack_target_git_head === "string" &&
                lineage.backtrack_target_git_head.length > 0
                ? lineage.backtrack_target_git_head
                : undefined,
            evidenceBaseline: roundSnapshot?.beforeEvidence ?? fallbackEvidence,
            roundSnapshot: roundSnapshot ?? prepareRoundTransaction(loopId, currentRound, fallbackEvidence),
            lastSelfEval,
            currentPrompt: typeof lineage.current_prompt === "string"
                ? lineage.current_prompt
                : null,
            currentLevel: typeof lineage.current_level === "string"
                ? lineage.current_level
                : undefined,
        };
    }
    /** Apply a prepared round to the session, persist, and build the result.
     *  Shared by reconcileCommittedRound, resume, and unpause — the three
     *  compile-then-persist tails were previously copy-pasted. */
    persistPrepared(session, prepared, roundSuccess, warningsOverride) {
        session.evidenceBaseline = prepared.baseline;
        session.roundSnapshot = prepared.snapshot;
        session.currentPrompt = prepared.prompt;
        session.currentLevel = prepared.level;
        session.currentWarnings = prepared.warnings;
        session.lastCompileResponse = prepared.compileResponse ?? null;
        policyMetrics.recordStrategy(session.loopId, prepared.level);
        this.save(session);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt: prepared.prompt,
            level: prepared.level,
            roundSuccess,
            warnings: warningsOverride ?? session.currentWarnings ?? [],
        };
    }
    restoredPromptResult(session) {
        if (!session.currentPrompt)
            return null;
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: session.currentPrompt,
            level: session.currentLevel ?? "l2",
            roundSuccess: undefined,
            warnings: (session.currentWarnings ?? []),
        };
    }
    /** Reconcile the crash window where feedback committed but session_state
     *  still points at the old prompt. Returns null when no commit is pending.
     *  v3.7: async — the continue-after-crash branch compiles through
     *  RoundDriver.prepare (the sync prepareSync fallback was removed). */
    async reconcileCommittedRound(session) {
        if (!session.roundSnapshot)
            return null;
        const recovered = new RoundDriver(session.engine, this.store).recover(session.roundSnapshot);
        if (!recovered)
            return null;
        const pr = recovered.result;
        session.roundSnapshot = recovered.snapshot;
        // Replay the committed counter — but with per-rule tracking.
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
        if (pr.newLastSelfEval)
            session.lastSelfEval = pr.newLastSelfEval;
        // L1 (v3.7.x): trajectory push guard must use the SAME judgement as the
        // counter guard below (recovered.snapshot.round). Comparing against
        // session.currentRound conflates two windows: the crash window (persisted
        // length N-1, currentRound N — push needed) and the pause race (pause()
        // persisted the incremented counter AND the already-pushed round N —
        // length N, currentRound N+1 — pushing again duplicates the entry).
        if (pr.shouldPushSuccessTrajectory &&
            session.successTrajectory.length < recovered.snapshot.round) {
            session.successTrajectory.push(pr.roundSuccess);
        }
        session.currentPrompt = null;
        if (pr.action === "stop" || pr.action === "terminate") {
            const reason = pr.action === "terminate"
                ? "enforcement_terminated"
                : pr.stopReason ?? "stalled";
            session.status = reason === "stalled" ? "stalled" : "stopped";
            this.save(session);
            void this.notifyTerminal(session, reason);
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                roundId: recovered.snapshot.roundId,
                prompt: null,
                stopReason: reason,
                stopDetail: reason === "completed"
                    ? "Task completed successfully — the agent declared should_continue=false with success=true."
                    : reason === "blocked"
                        ? "Agent cannot proceed under current constraints. The task may need revised constraints or human intervention."
                        : reason === "failed"
                            ? "Agent declared should_continue=false with success=false — the task was not achieved."
                            : `Loop stopped: ${reason}.`,
                roundSuccess: pr.roundSuccess,
            };
        }
        if (pr.action === "backtrack") {
            // Backtrack committed but prompt not delivered (crash window).
            // Reset round counter to the restore target + 1 so the next
            // resume / unpause compiles from the correct restored state.
            const restoreTarget = pr.backtrackTarget ?? (session.currentRound - 1);
            session.currentRound = restoreTarget + 1;
            session.consecutiveRejections = 0;
            session.lastRejectionCheck = "";
            session.driftClarificationStreak = 0;
            session.lastSelfEval = undefined;
            session.currentPrompt = null;
            this.save(session);
            // Return null — caller (resume/unpause) will recompile normally
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
        const request = buildLoopRequest(session, pr.newLastSelfEval, pr.verificationFlags);
        const prepared = await new RoundDriver(session.engine, this.store).prepare(request, session.loopId, session.currentRound);
        if (!prepared) {
            session.status = "stalled";
            this.save(session);
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "RoundDriver.prepare returned null — prompt compilation failed during crash recovery. The session state may be inconsistent.",
            };
        }
        return this.persistPrepared(session, {
            prompt: prepared.prompt,
            level: prepared.level,
            baseline: prepared.evidenceBaseline,
            snapshot: prepared.snapshot,
            warnings: prepared?.warnings ?? [],
        }, pr.roundSuccess);
    }
    /** Resume tail: the session has been reconstructed and registered. Reconcile
     *  a committed-but-undelivered round, restore the held prompt, or recover a
     *  missing prompt from current round state. v3.7: async — compilation runs
     *  through RoundDriver.prepare like unpause (the prepareSync fallback was
     *  removed); a failed compile now degrades to the same stalled terminal
     *  result unpause returns instead of persisting a null prompt. */
    async resume(session) {
        const reconciled = await this.reconcileCommittedRound(session);
        if (reconciled)
            return reconciled;
        const restored = this.restoredPromptResult(session);
        if (restored)
            return restored;
        // Missing held prompt: compile (async) once, then persist it.
        const request = buildLoopRequest(session);
        const prepared = await new RoundDriver(session.engine, this.store).prepare(request, session.loopId, session.currentRound);
        if (!prepared) {
            session.status = "stopped";
            this.save(session);
            void this.notifyTerminal(session, "stalled");
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "RoundDriver.prepare returned null during resume — the compiler could not produce a prompt.",
            };
        }
        return this.persistPrepared(session, {
            prompt: prepared.prompt,
            level: prepared.level,
            baseline: prepared.evidenceBaseline,
            snapshot: prepared.snapshot,
            warnings: prepared?.warnings ?? [],
        }, false);
    }
    /** Unpause tail: the session has been reconstructed and registered with
     *  status "running". Refresh async evidence, reconcile a committed round,
     *  restore the held prompt, or compile the next prompt. */
    async unpause(session) {
        // Replace the sync-fallback evidence baseline with async evidence
        // so resumed sessions don't silently drop async provider data.
        try {
            const asyncEvidence = await EvidenceCollector.fromPolicy().collectAsync({
                loopId: session.loopId,
                phase: "before",
            });
            if (asyncEvidence.length > 0) {
                session.evidenceBaseline = asyncEvidence;
                if (!session.roundSnapshot?.beforeEvidence?.length) {
                    session.roundSnapshot = prepareRoundTransaction(session.loopId, session.currentRound, asyncEvidence);
                }
            }
        }
        catch {
            // Async evidence is best-effort; fall back to sync baseline.
        }
        const reconciled = await this.reconcileCommittedRound(session);
        if (reconciled)
            return reconciled;
        const restored = this.restoredPromptResult(session);
        if (restored) {
            this.save(session);
            return restored;
        }
        // Compile the next prompt from the current round state
        const lcr = makeLoopCompileRequest({
            loop_id: session.loopId,
            round: session.currentRound,
            goal_id: "",
            task: session.task,
            domain: undefined,
            plan_source: null,
            constraints_from_plan: [],
            health_check_interval: 1,
        });
        const compileRequest = {
            task: session.task,
            mode: Mode.LOOP_COMPILE,
            feedback: null,
            skill_name: null,
            task_id: null,
            loop_id: lcr.loop_id,
            round: lcr.round,
            goal_id: lcr.goal_id,
            domain: lcr.domain ?? "",
            plan_source: lcr.plan_source ?? null,
            constraints_from_plan: lcr.constraints_from_plan ?? [],
            health_check_interval: lcr.health_check_interval,
            max_rounds: session.maxRounds,
        };
        const prepared = await new RoundDriver(session.engine, this.store).prepare(compileRequest, session.loopId, session.currentRound);
        if (!prepared) {
            session.status = "stopped";
            this.save(session);
            void this.notifyTerminal(session, "stalled");
            return { sessionId: session.sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", stopDetail: "RoundDriver.prepare returned null during unpause — the compiler could not produce a prompt." };
        }
        return this.persistPrepared(session, {
            prompt: prepared.prompt,
            level: prepared.level,
            baseline: prepared.evidenceBaseline,
            snapshot: prepared.snapshot,
            warnings: prepared?.warnings ?? [],
        }, undefined,
        // Historical contract: unpause returns an empty warnings array even
        // though the session carries the compiled warnings.
        []);
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
        const existing = queryLoopEntries(this.store, session.loopId, { prefix: taskId })
            .some((entry) => entry.task_id === taskId);
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
        const entries = queryLoopEntries(this.store, loopId, { prefix: `loop:${loopId}:gate:` });
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
     *           session.lastRejectionCheck, session.lastSelfEval,
     *           session.successTrajectory, session.driftClarificationStreak */
    async executeRoundTransaction(session, selfEval) {
        const snapshot = session.roundSnapshot ?? prepareRoundTransaction(session.loopId, session.currentRound, session.evidenceBaseline ?? []);
        const completed = await new RoundDriver(session.engine, this.store).complete({
            snapshot,
            loopId: session.loopId,
            task: session.task,
            maxRounds: session.maxRounds,
            selfEval,
            lastSelfEval: session.lastSelfEval,
            consecutiveRejections: session.consecutiveRejections,
            lastRejectionCheck: session.lastRejectionCheck,
            successTrajectory: session.successTrajectory,
            driftClarificationStreak: session.driftClarificationStreak,
            backtrackSkippedFiles: session.backtrackSkippedFiles,
            backtrackSkippedFingerprints: session.backtrackSkippedFingerprints,
            backtrackTargetGitHead: session.backtrackTargetGitHead,
        });
        const outcome = completed.outcome;
        const actualEvidence = completed.actualEvidence;
        session.roundSnapshot = outcome.snapshot;
        const pr = outcome.result;
        // v2.12: Clarification streak tracking — independent of rejection tracking.
        // Reset on rounds without intent_drift; track substantive vs weak clarifications.
        this.updateClarificationStreak(session, pr);
        // Per-rule rejection tracking: same-check rejections accumulate;
        // a different rejection reason resets the counter.
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
        if (pr.newLastSelfEval)
            session.lastSelfEval = pr.newLastSelfEval;
        // L1 (v3.7.x): never push a REPLAYED outcome onto the trajectory. When a
        // crash/exception window left the committed round undelivered, the replay
        // re-executes the same round in memory — its success was already recorded
        // by the original attempt (crash recovery re-pushes through
        // reconcileCommittedRound instead, which uses the length-vs-round guard).
        if (pr.shouldPushSuccessTrajectory && !completed.outcome.replayed) {
            session.successTrajectory.push(pr.roundSuccess);
        }
        return { pr, verificationFlags: pr.verificationFlags, actualEvidence };
    }
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
    updateClarificationStreak(session, pr) {
        const hasIntentDrift = pr.verificationFlags.some((f) => f.check === "intent_drift");
        if (!hasIntentDrift) {
            // No drift this round — reset streak
            session.driftClarificationStreak = 0;
            return;
        }
        // R7 did not participate in this round's decision (a higher-priority
        // rule rejected/accepted first) — leave the streak untouched.
        if (pr.clarificationAccepted === undefined)
            return;
        // v2.12: Clarification accepted with anchors → substantive pivot.
        // Keep streak as-is (don't increment for genuine explanations).
        if (pr.clarificationAccepted) {
            return;
        }
        // R7 rejected (weak or no clarification). The enforcement gate
        // already used the streak to decide reject vs terminate.
        // Increment the persisted counter so crash recovery sees it.
        session.driftClarificationStreak += 1;
    }
    /** Build a rejection result: compile a retry prompt, persist, return.
     *  MUTATES: session.roundSnapshot, session.currentPrompt, session.currentLevel */
    async buildRejectionResult(sessionId, session, pr, verificationFlags) {
        const retryRequest = buildLoopRequest(session, undefined, verificationFlags);
        const preparedRetry = await new RoundDriver(session.engine, this.store).prepareRetry(retryRequest, session.roundSnapshot, pr.rejectionPrompt ?? "", session.consecutiveRejections);
        if (!preparedRetry) {
            session.status = "stalled";
            session.currentPrompt = null;
            this.save(session);
            return {
                sessionId,
                round: session.currentRound,
                roundId: session.roundSnapshot?.roundId,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "RoundDriver.prepareRetry returned null — the retry prompt could not be compiled.",
            };
        }
        session.roundSnapshot = preparedRetry.snapshot;
        session.currentPrompt = preparedRetry.prompt;
        session.currentLevel = preparedRetry.level;
        session.currentWarnings = preparedRetry.warnings ?? [];
        session.lastCompileResponse = preparedRetry.compileResponse ?? null;
        this.save(session);
        return {
            sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt: preparedRetry.prompt,
            level: preparedRetry.level,
            enforcementAction: "reject",
            enforcementReason: pr.enforcementReason,
        };
    }
    /** v2.10: Build a backtrack result — roll back to last clean round.
     *  Resets the round counter to the restore target + 1, merges preserved
     *  discoveries, compiles from the restored state, and injects the
     *  backtrack prompt at the top.
     *  MUTATES: session.currentRound, session.roundSnapshot,
     *           session.currentPrompt, session.currentLevel,
     *           session.consecutiveRejections, session.lastSelfEval */
    async buildBacktrackResult(sessionId, session, pr) {
        // v3.3.1: wire up engine.backtrack_auto_restore — the v2.13 policy
        // switch promised automatic workspace recovery and never had an
        // implementation (the flag had zero consumers, so setting it changed
        // nothing). When enabled: stash every uncommitted change (tracked +
        // untracked — nothing destroyed) and hard-reset to the restore point
        // commit so the failed rounds' state is gone before the agent redoes
        // the round. DANGEROUS by design and off by default; when off, the
        // prompt instructs manual restore and the verification gate enforces it.
        if (getPolicy().engine.backtrack_auto_restore) {
            const outcome = await runBacktrackAutoRestore(pr.backtrackTargetGitHead, session.currentRound);
            logEvent("backtrack_auto_restore", {
                sessionId,
                loopId: session.loopId,
                fromRound: session.currentRound,
                ok: outcome.ok,
                detail: outcome.detail,
            });
        }
        const restoreTarget = pr.backtrackTarget ?? (session.currentRound - 1);
        const newRound = restoreTarget + 1;
        logEvent("session_backtrack", {
            sessionId,
            loopId: session.loopId,
            fromRound: session.currentRound,
            toRound: newRound,
            triggerRule: pr.backtrackTriggerRule ?? "",
            skippedDiscoveries: (pr.backtrackSkippedDiscoveries ?? []).length,
        });
        // Reset session to the restored round
        session.currentRound = newRound;
        session.consecutiveRejections = 0;
        session.lastRejectionCheck = "";
        session.driftClarificationStreak = 0;
        session.backtrackSkippedFiles = pr.backtrackSkippedFiles ?? [];
        // M3: carry each skipped file's failed-round fingerprint for the
        // machine-proven restore check on the redo submission.
        session.backtrackSkippedFingerprints = pr.backtrackSkippedFingerprints ?? {};
        // v2.12: Remember the restore point's git HEAD — the next round's
        // verification gate confirms the workspace returned to this commit.
        session.backtrackTargetGitHead = pr.backtrackTargetGitHead;
        session.lastSelfEval = undefined; // force L2 recompile from vault state
        session.currentPrompt = null;
        // Preserve discoveries from skipped rounds as constraints_from_plan
        // so they survive the compilation and re-enter active constraints.
        const preservedDiscoveries = pr.backtrackSkippedDiscoveries ?? [];
        // Compile the restored prompt — use a fresh request with the restored round
        const request = {
            task: session.task,
            mode: Mode.LOOP_COMPILE,
            feedback: null,
            skill_name: null,
            task_id: null,
            loop_id: session.loopId,
            round: newRound,
            max_rounds: session.maxRounds,
            verification_flags: pr.verificationFlags,
            constraints_from_plan: preservedDiscoveries,
        };
        const prepared = await new RoundDriver(session.engine, this.store).prepare(request, session.loopId, newRound);
        if (!prepared || !prepared.prompt) {
            session.status = "stalled";
            session.currentPrompt = null;
            this.save(session);
            return {
                sessionId,
                round: newRound,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "Backtrack failed: RoundDriver.prepare returned null — could not compile from restore point.",
                enforcementAction: "backtrack",
                enforcementReason: pr.enforcementReason,
            };
        }
        // Inject backtrack prompt at the top of the compiled prompt
        const backtrackHeader = pr.backtrackPrompt ?? "";
        const fullPrompt = backtrackHeader
            ? backtrackHeader + "\n" + (prepared.prompt ?? "")
            : prepared.prompt ?? "";
        session.evidenceBaseline = prepared.evidenceBaseline;
        session.roundSnapshot = prepared.snapshot;
        session.currentPrompt = fullPrompt;
        session.currentLevel = prepared.level;
        session.currentWarnings = prepared?.warnings ?? [];
        session.lastCompileResponse = prepared?.compileResponse ?? null;
        this.save(session);
        return {
            sessionId,
            round: newRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: fullPrompt,
            level: prepared.level,
            enforcementAction: "backtrack",
            enforcementReason: pr.enforcementReason,
            warnings: prepared?.warnings ?? [],
        };
    }
    /** Build a termination result: persist stopped status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt */
    buildTerminationResult(sessionId, session, pr) {
        session.status = "stopped";
        session.currentPrompt = null;
        this.save(session);
        void this.notifyTerminal(session, "enforcement_terminated");
        logEvent("session_end", {
            sessionId, loopId: session.loopId,
            stopReason: "enforcement_terminated", round: session.currentRound,
        });
        return {
            sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: null,
            stopReason: "enforcement_terminated",
            stopDetail: pr.enforcementReason ?? "The enforcement gate terminated the loop.",
            enforcementAction: "terminate",
            enforcementReason: pr.enforcementReason,
        };
    }
    /** Build a stop result: persist stopped/stalled status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt */
    buildStopResult(sessionId, session, pr) {
        const reason = pr.stopReason ?? "stalled";
        session.status = reason === "stalled" ? "stalled" : "stopped";
        session.currentPrompt = null;
        this.save(session);
        void this.notifyTerminal(session, reason);
        logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: reason, round: session.currentRound });
        return {
            sessionId, round: session.currentRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: null, stopReason: reason,
            stopDetail: pr.stopReason === "max_rounds"
                ? "The configured maximum number of rounds has been reached."
                : `Loop stopped: ${reason}.`,
            roundSuccess: pr.roundSuccess,
        };
    }
    /** Compile the next round's prompt and advance the session.
     *  Includes the commit fence (pause/delete race guard) and context provider.
     *  MUTATES: session.currentRound, session.currentPrompt, session.currentLevel,
     *           session.evidenceBaseline, session.roundSnapshot */
    async advanceToNextRound(sessionId, session, selfEval, pr, verificationFlags, actualEvidence) {
        const roundSuccess = pr.roundSuccess;
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
        session.currentPrompt = null;
        // v2.13: Clear backtrack skipped files after advancing past the restore round
        session.backtrackSkippedFiles = [];
        session.backtrackSkippedFingerprints = {};
        // v2.12: The restore-point git HEAD check only applies to the first
        // post-backtrack round — clear it once we advance past it.
        session.backtrackTargetGitHead = undefined;
        // v1.8: Memory injection — tier-aware external context.
        const contextProvider = this.getContext();
        let externalCtx = "";
        if (contextProvider) {
            try {
                externalCtx = (await contextProvider({
                    loopId: session.loopId,
                    round: session.currentRound,
                    task: session.task,
                    domain: "",
                    lastEvaluation: selfEval,
                })).trim();
            }
            catch {
                logEvent("context_provider_error", {
                    loopId: session.loopId,
                    round: session.currentRound,
                });
            }
        }
        // Commit fence: pause()/delete() may have run while the context provider
        // was awaited. Do not compile if the session is no longer running.
        if (this.registry.get(sessionId) !== session || session.status !== "running") {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: session.status,
                stopDetail: `Session is no longer running (status: ${session.status}). It was paused or deleted while the context provider was running.`,
                roundSuccess,
            };
        }
        const request = buildLoopRequest(session, selfEval, verificationFlags);
        if (externalCtx) {
            request.external_context = externalCtx;
        }
        let prepared;
        try {
            prepared = await new RoundDriver(session.engine, this.store).prepare(request, session.loopId, session.currentRound);
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
            return this.stalledAfterCommit(sessionId, session, roundSuccess, `RoundDriver.prepare threw after the round committed: ${String(error).slice(0, 300)}. ` +
                `The session is stalled with the committed round still held — resume or ` +
                `resubmit the same roundId to recompile the next prompt.`);
        }
        if (!prepared) {
            // M4: align with the sibling paths (resume / unpause / reject /
            // backtrack / crash recovery) that treat a null preparation as a
            // stalled session — previously this silently returned prompt:null
            // without a stopReason while the session kept running.
            return this.stalledAfterCommit(sessionId, session, roundSuccess, "RoundDriver.prepare returned null after the round committed — the " +
                "next prompt could not be compiled. Resume or resubmit the same " +
                "roundId to retry.");
        }
        const nextPrompt = prepared.prompt;
        const nextLevel = prepared.level;
        const nextBaseline = prepared.evidenceBaseline ?? actualEvidence;
        session.evidenceBaseline = nextBaseline;
        session.roundSnapshot = prepared.snapshot;
        session.currentPrompt = nextPrompt;
        session.currentLevel = nextLevel;
        session.currentWarnings = prepared.warnings ?? [];
        session.lastCompileResponse = prepared.compileResponse ?? null;
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
            return this.stalledAfterCommit(sessionId, session, roundSuccess, `The round committed but the session state could not be persisted: ${String(error).slice(0, 300)}. ` +
                `Resume the loop to recover the held prompt.`);
        }
        return {
            sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt: nextPrompt,
            level: nextLevel,
            roundSuccess,
            warnings: prepared.warnings ?? [],
        };
    }
    /** M4: mark a session stalled after its round committed but the next
     *  prompt could not be prepared/persisted — mirrors the crash-recovery
     *  siblings (reconcileCommittedRound / resume / reject paths). The
     *  committed round stays held (roundSnapshot untouched) so a resubmission
     *  with the same roundId replays it and recompiles the next round. */
    stalledAfterCommit(sessionId, session, roundSuccess, detail) {
        session.status = "stalled";
        session.currentPrompt = null;
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
            roundId: session.roundSnapshot?.roundId,
            prompt: null,
            stopReason: "stalled",
            stopDetail: detail,
            roundSuccess,
        };
    }
    async advanceUnlocked(sessionId, output, preExtractedEval, roundId) {
        // ── 1. Validate session ──────────────────────────────────────────────
        const session = this.registry.get(sessionId);
        if (!session)
            return { sessionId, round: 0, prompt: null, stopReason: "session_not_found", stopDetail: "No session exists with this ID. It may have expired, been deleted, or never existed." };
        if (session.status !== "running" && session.status !== "stalled") {
            return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status, stopDetail: `Session is ${session.status}. Use loopforge_resume to restart a paused session, or loopforge_start for a new task.` };
        }
        // A stalled compiler preparation is retryable against the same held
        // round. Format errors never set this status; they return before advance.
        if (session.status === "stalled") {
            session.status = "running";
        }
        // ── 1.5 Anchor the submission to the round it reports on ─────────────
        // v3.0.1: a submission whose roundId no longer matches the current round
        // is stale — the round it reported on already committed (lost response,
        // duplicate call). Never process it against the current round; return the
        // held prompt so the agent recovers the response it missed. The reject
        // path keeps the same roundId (prepareRejectedAttempt), so retries of a
        // rejected round match normally.
        const expectedRoundId = session.roundSnapshot?.roundId
            ?? makeRoundId(session.loopId, session.currentRound);
        if (roundId !== undefined && roundId !== expectedRoundId) {
            logEvent("stale_round_id", {
                sessionId,
                loopId: session.loopId,
                submitted: roundId,
                expected: expectedRoundId,
            });
            const restored = this.restoredPromptResult(session);
            if (restored) {
                return {
                    ...restored,
                    warnings: [
                        ...(restored.warnings ?? []),
                        `Submitted roundId ${roundId} does not match the current round (${expectedRoundId}) — the round it reported on has already committed. Reusing the held prompt for round ${session.currentRound}; resubmit with its roundId when the work is done.`,
                    ],
                };
            }
            return {
                sessionId,
                round: session.currentRound,
                roundId: expectedRoundId,
                prompt: null,
                stopReason: "stale_round_id",
                stopDetail: `Submitted roundId ${roundId} does not match the current round ${expectedRoundId}, and no prompt is currently held. Call loopforge_status or loopforge_resume to re-anchor.`,
            };
        }
        // ── 2. Extract self-evaluation ───────────────────────────────────────
        const extracted = this.extractEvaluation(output, preExtractedEval);
        if (!extracted) {
            return {
                sessionId,
                round: session.currentRound,
                roundId: session.roundSnapshot?.roundId
                    ?? makeRoundId(session.loopId, session.currentRound),
                prompt: null,
                stopReason: "evaluation_invalid",
                stopDetail: "A structured evaluation object is required. Resubmit the same roundId with success, output_summary, constraint_violations, and should_continue.",
            };
        }
        const selfEval = extracted;
        // ── 3. Execute round transaction ─────────────────────────────────────
        const tx = await this.executeRoundTransaction(session, selfEval);
        // v2.12: Record a user gate when an accepted round reports a high-risk
        // blocker. Record layer only — never blocks the round decision flow.
        if (tx.pr.action !== "reject" && tx.pr.action !== "terminate" &&
            selfEval.outcome === "blocked" && typeof selfEval.blocker === "string") {
            this.recordGateFromBlocked(session, selfEval.blocker);
        }
        // ── 4. Route disposition ─────────────────────────────────────────────
        if (tx.pr.action === "reject") {
            return this.buildRejectionResult(sessionId, session, tx.pr, tx.verificationFlags);
        }
        // ── v2.10: Backtrack — roll back to last clean round ──────────────────
        if (tx.pr.action === "backtrack") {
            return this.buildBacktrackResult(sessionId, session, tx.pr);
        }
        // Accepted rounds advance the before-snapshot baseline. Rejected rounds
        // retain the original baseline so their retry remains zero-commit.
        session.evidenceBaseline = tx.actualEvidence;
        if (tx.pr.action === "terminate") {
            return this.buildTerminationResult(sessionId, session, tx.pr);
        }
        if (tx.pr.action === "stop") {
            return this.buildStopResult(sessionId, session, tx.pr);
        }
        // ── 5. Continue — compile next round ─────────────────────────────────
        return this.advanceToNextRound(sessionId, session, selfEval, tx.pr, tx.verificationFlags, tx.actualEvidence);
    }
    /** Core cycle entry used by SessionManager.advance after the queue + lease
     *  dance: validate → extract → execute transaction → route disposition
     *  → advance to next round (continue) or return terminal result.
     *  @param roundId v3.0.1: the roundId of the round this submission reports
     *    on (from the last start/next/resume response). Anchors the submission;
     *    a stale or duplicate submission returns the held prompt instead of
     *    being processed. Optional — when absent the anchor check is skipped. */
    async advance(sessionId, output, preExtractedEval, roundId) {
        return this.advanceUnlocked(sessionId, output, preExtractedEval, roundId);
    }
    /** Write back loop knowledge to long-term memory.
     *  Uses shared base builder from policy.ts. Called when a loop terminates. */
    async notifyTerminal(session, stopReason) {
        if (this.terminalSinks.size === 0)
            return;
        const event = {
            loopId: session.loopId,
            task: session.task,
            success: stopReason === "completed",
            stopReason: stopReason,
            roundsCompleted: session.currentRound,
            successTrajectory: [...session.successTrajectory],
            lastEvaluation: session.lastSelfEval,
        };
        await Promise.allSettled([...this.terminalSinks].map((sink) => Promise.resolve(sink(event))));
    }
}
//# sourceMappingURL=round-lifecycle.js.map