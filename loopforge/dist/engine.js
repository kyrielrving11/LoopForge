/** LoopForge-loop_compile — Engine (outer loop manager).
 *
 * 2-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeFeedback.
 * Circuit breaker prevents infinite stall loops.
 * EngineMetrics tracks silent-failure counters for observability.
 */
import { randomUUID } from "node:crypto";
import { getPolicy } from "./policy.js";
import { FileLoopStore, LoopStoreBackend } from "./loop-store.js";
import { AgentStatus, Mode, makeExecutionFeedback, makeLoopCompileRequest, makeLoopObjective, makeLoopRoundResult, makeSessionState, makeTaskId, } from "./protocol.js";
import { compileLoop } from "./loop-compiler.js";
import { logEvent } from "./observability.js";
import { parseExecutionEvidence, parseCriterionRevisions, parseWorkerResults, } from "./self-eval.js";
import { parseLoopExtras } from "./loop-extras-parser.js";
// ── Re-export self-evaluation utilities (moved to self-eval.ts) ──────────
export { parseExecutionEvidence, parseCriterionRevisions, parseWorkerResults, extractSelfEvaluation, buildSelfEvaluation, heuristicSelfEvaluation, } from "./self-eval.js";
function makeEngineMetrics() {
    return {
        vaultWriteErrors: 0,
        vaultWriteTimeouts: 0,
        vaultWriteBytes: 0,
        silentAnalysisErrors: 0,
        hydrateCacheMisses: 0,
        feedbackBufferFlushes: 0,
        feedbackBufferMaxSize: 0,
        sessionStart: Date.now(),
    };
}
// ═══════════════════════════════════════════════════════════════════════════
// LoopForgeEngine
// ═══════════════════════════════════════════════════════════════════════════
export class LoopForgeEngine {
    state = null;
    backend = null;
    metrics = null;
    feedbackWriteBuffer = [];
    lastTask = null;
    constructor(storeOrBackend) {
        if (storeOrBackend) {
            this.backend = "readSession" in storeOrBackend
                ? new LoopStoreBackend(storeOrBackend)
                : storeOrBackend;
        }
    }
    resolveBackend() {
        if (this.backend === null) {
            this.backend = new LoopStoreBackend(new FileLoopStore(getPolicy().backend.root_dir));
        }
        return this.backend;
    }
    /** Public accessor for the vault backend — used by runtime/verification gate. */
    getBackend() {
        return this.resolveBackend();
    }
    /** Expose engine health counters for observability (MCP status, logging). */
    getMetrics() {
        if (this.metrics === null) {
            this.metrics = makeEngineMetrics();
        }
        return this.metrics;
    }
    ensureInit(request) {
        if (this.state === null) {
            this.state = makeSessionState(request.task_id || makeTaskId(request.task));
        }
        if (this.metrics === null) {
            this.metrics = makeEngineMetrics();
        }
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Feedback persistence
    // ═══════════════════════════════════════════════════════════════════════
    persistFeedbackToVault(signal) {
        if (this.metrics === null) {
            this.metrics = makeEngineMetrics();
        }
        this.feedbackWriteBuffer.push(signal);
        const bufLen = this.feedbackWriteBuffer.length;
        if (bufLen > this.metrics.feedbackBufferMaxSize) {
            this.metrics.feedbackBufferMaxSize = bufLen;
        }
        const policy = getPolicy();
        if (bufLen >= policy.engine.feedback_flush_interval) {
            this.flushFeedbackBuffer();
        }
    }
    flushFeedbackBuffer() {
        if (!this.feedbackWriteBuffer.length)
            return 0;
        const records = this.feedbackWriteBuffer.splice(0);
        if (this.metrics)
            this.metrics.feedbackBufferFlushes++;
        const now = new Date().toISOString().replace(/\.\d+Z$/, "");
        const entries = [];
        for (const signal of records) {
            try {
                const entry = {
                    id: randomUUID(),
                    task_id: signal.task_id ?? "feedback",
                    version_tag: "v1",
                    is_active: true,
                    timestamp: now,
                    user_intent: String(signal.task_type ?? "").slice(0, 200),
                    success: signal.success ?? false,
                    execution_feedback: JSON.stringify({
                        success: signal.success ?? false,
                        status: signal.success
                            ? "success"
                            : "partial",
                        constraint_compliance: {
                            all_hard_constraints_met: !Array.isArray(signal.violations) || signal.violations.length === 0,
                            violations: signal.violations ?? [],
                        },
                        output_summary: signal.task_type ?? "",
                        improvement_notes: signal.manual_fixes ?? "",
                    }),
                    task_type: signal.task_type ?? "",
                    tags: signal.skill_used ? [signal.skill_used] : [],
                    skill_used: signal.skill_used ?? "",
                    loop_id: signal.loop_id,
                    loop_lineage: signal.loop_lineage ?? {},
                };
                entries.push(entry);
            }
            catch {
                if (this.metrics)
                    this.metrics.vaultWriteErrors++;
                logEvent("vault_write_error", { error: "feedback_entry_build" });
            }
        }
        if (entries.length > 0) {
            try {
                this.resolveBackend().appendEntries(entries);
            }
            catch {
                if (this.metrics)
                    this.metrics.vaultWriteErrors += entries.length;
                logEvent("vault_write_error", { error: "feedback_append_entries", count: entries.length });
                return 0;
            }
        }
        return entries.length;
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Lineage persistence
    // ═══════════════════════════════════════════════════════════════════════
    persistLoopLineage(response, request) {
        if (this.metrics === null)
            this.metrics = makeEngineMetrics();
        const loopObjDict = response.loop_objective
            ? response.loop_objective
            : null;
        const structuredLineage = {
            loop_id: response.loop_id,
            round: response.round,
            goal_id: response.goal_id,
            goal_text_hash: response.goal_text_hash,
            recompile_level: response.recompile_level,
            constraints_active: response.constraints_active,
            task: request.task,
            success: true,
        };
        let lastOutputSummary = "";
        let lastViolations = [];
        if (request.last_round_result) {
            lastOutputSummary = request.last_round_result.output_summary || "";
            lastViolations = request.last_round_result.constraint_violations || [];
        }
        const entry = {
            id: randomUUID(),
            task_id: `loop:${response.loop_id}:r${response.round}`,
            version_tag: "v1",
            is_active: true,
            timestamp: new Date().toISOString().replace(/\.\d+Z$/, ""),
            user_intent: `loop_compile round ${response.round} — ${response.goal_id}`,
            task_type: "loop_lineage",
            loop_id: response.loop_id,
            loop_lineage: structuredLineage,
            loop_objective: loopObjDict,
            task: request.task,
            output_summary: lastOutputSummary,
            constraint_violations: lastViolations,
            tags: [response.loop_id, response.recompile_level, response.goal_id],
        };
        // 1. JSON vault write (primary)
        let vaultOk = false;
        try {
            this.resolveBackend().appendEntry(entry);
            vaultOk = true;
        }
        catch {
            if (this.metrics)
                this.metrics.vaultWriteErrors++;
            logEvent("vault_write_error", { error: "persist_lineage_json" });
        }
        return vaultOk;
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Delegation journal (v1.9 — AgentTool mode)
    // ═══════════════════════════════════════════════════════════════════════
    /** Record sub-agent delegations for this round into the vault.
     *  Written as a lightweight journal entry so the main agent's rolling
     *  summary can reference delegation history in subsequent rounds. */
    recordDelegation(loopId, round, entries) {
        if (!entries.length)
            return;
        const taskId = `loop:${loopId}:r${round}:delegations`;
        const existing = this.resolveBackend().queryEntries({ prefix: taskId })
            .some((candidate) => candidate.task_id === taskId);
        if (existing)
            return;
        const entry = {
            id: randomUUID(),
            task_id: taskId,
            version_tag: "v1",
            is_active: true,
            timestamp: new Date().toISOString().replace(/\.\d+Z$/, ""),
            user_intent: `Delegation journal — round ${round}`,
            task_type: "delegation_journal",
            loop_id: loopId,
            loop_lineage: {
                round,
                delegations: entries.map((e) => ({
                    index: e.index,
                    agentId: e.agentId,
                    subAgentType: e.subAgentType,
                    subTask: e.subTask,
                    resultSummary: e.resultSummary,
                    success: e.success,
                    discoveredConstraints: e.discoveredConstraints,
                })),
            },
        };
        try {
            this.resolveBackend().appendEntry(entry);
        }
        catch {
            if (this.metrics)
                this.metrics.vaultWriteErrors++;
            logEvent("vault_write_error", { error: "record_delegation" });
        }
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Hydrate loop context from vault
    // ═══════════════════════════════════════════════════════════════════════
    hydrateLoopContext(loopId) {
        const prefix = `loop:${loopId}:r`;
        const results = this.resolveBackend().queryEntries({ prefix });
        // Merge feedback success flags into lineage entries
        const fbEntries = this.resolveBackend().queryEntries({
            prefix,
            feedbackOnly: true,
        });
        const fbSuccess = new Map();
        for (const fe of fbEntries) {
            const tid = String(fe.task_id ?? "");
            const parts = tid.split(":r");
            if (parts.length >= 2) {
                const roundStr = parts[1].split(":")[0];
                const fbRound = parseInt(roundStr, 10);
                if (!Number.isNaN(fbRound) && fe.success !== undefined) {
                    fbSuccess.set(fbRound, fe.success);
                }
            }
        }
        for (const entry of results) {
            const lineage = (entry.loop_lineage ?? entry.lineage ?? {});
            const rnd = lineage.round;
            if (rnd && fbSuccess.has(rnd)) {
                lineage.success = fbSuccess.get(rnd);
                entry.success = fbSuccess.get(rnd);
            }
        }
        const finalResults = results;
        for (const entry of finalResults) {
            const lineage = (entry.loop_lineage ?? entry.lineage ?? {});
            if (!entry.output_summary) {
                entry.output_summary = lineage.output_summary ?? "";
            }
            if (!entry.constraint_violations) {
                entry.constraint_violations =
                    lineage.constraint_violations ?? [];
            }
        }
        if (!finalResults.length)
            return null;
        return { results: finalResults, global_entries: [] };
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Feedback (public)
    // ═══════════════════════════════════════════════════════════════════════
    invokeFeedback(request, _hydrateResults) {
        this.ensureInit(request);
        this.lastTask = request.task;
        const fb = request.feedback;
        if (!fb) {
            return {
                status: AgentStatus.ERROR,
                response: {
                    status: AgentStatus.ERROR,
                    prompt: null,
                    error: "Feedback mode requires a feedback payload.",
                },
            };
        }
        const success = fb.success;
        const violations = fb.constraint_violations ?? [];
        const fixes = fb.manual_fixes_needed ?? "";
        // Loop-aware task_id for feedback→lineage backfill
        const loopId = request.loop_id;
        const loopRound = request.round;
        let taskId;
        if (loopId && loopRound !== undefined) {
            taskId = `loop:${loopId}:r${loopRound}:feedback`;
        }
        else {
            taskId = request.task_id ?? request.task.slice(0, 60);
        }
        const signal = {
            task_id: taskId,
            task_type: request.task.slice(0, 80),
            success,
            skill_used: request.skill_name ?? "",
            violations,
            manual_fixes: fixes,
            loop_id: loopId,
            round: loopRound,
        };
        this.persistFeedbackToVault(signal);
        // Flush immediately so next compile cycle sees success flags
        this.flushFeedbackBuffer();
        // Update state
        this.state.call_count++;
        this.state.success_trend.push(success);
        if (this.state.success_trend.length > 20) {
            this.state.success_trend = this.state.success_trend.slice(-20);
        }
        // Circuit breaker
        if (this.shouldBreak()) {
            this.state.circuit_breaker_count++;
        }
        else {
            this.state.circuit_breaker_count = 0;
        }
        logEvent("round_complete", {
            success,
            loopId: loopId ?? "unknown",
            round: loopRound ?? this.state.call_count,
        });
        return {
            status: AgentStatus.OK,
            response: {
                status: AgentStatus.OK,
                prompt: `## Feedback Recorded\n\nSuccess: ${success}\nSignals: 1`,
                error: null,
            },
        };
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Auto-Feedback (v1.1 — autonomous loop, no human in the loop)
    // ═══════════════════════════════════════════════════════════════════════
    /** Record self-evaluation from agent output without human intervention.
     *  Converts SelfEvaluation → ExecutionFeedback → vault persistence.
     *  P0–P2: Also persists discovered_constraints, objective_refinement,
     *  and emerged_subtasks for the compiler to consume next round.
     *  Call this BEFORE invokeLoopCompile for the next round so that
     *  hydrateLoopContext picks up the latest success flags. */
    autoFeedback(selfEval, loopId, round, task, roundTransaction) {
        this.ensureInit({ task, mode: Mode.FEEDBACK, feedback: null, skill_name: null, task_id: null });
        const fb = makeExecutionFeedback({
            output: selfEval.output_summary,
            success: selfEval.success,
            constraint_violations: selfEval.constraint_violations,
            manual_fixes_needed: "",
        });
        const taskId = `loop:${loopId}:r${round}:feedback`;
        const transactionId = typeof roundTransaction?.round_id === "string"
            ? roundTransaction.round_id
            : null;
        const transactionPersisted = () => {
            if (!transactionId)
                return false;
            return this.resolveBackend().queryEntries({
                prefix: taskId,
                feedbackOnly: true,
            }).some((entry) => {
                if (entry.task_id !== taskId)
                    return false;
                const lineage = entry.loop_lineage;
                const transaction = lineage?.round_transaction;
                return transaction !== null &&
                    typeof transaction === "object" &&
                    !Array.isArray(transaction) &&
                    transaction.round_id === transactionId;
            });
        };
        const alreadyCommitted = transactionPersisted();
        // Multi-agent: Merge sub-agent discovered constraints into the main constraint flow
        const subDiscovered = (selfEval.worker_results ?? [])
            .flatMap((w) => w.discoveredConstraints ?? [])
            .filter((c) => c.length > 0);
        const mergedDiscovered = [
            ...new Set([...(selfEval.discovered_constraints ?? []), ...subDiscovered]),
        ];
        const signal = {
            task_id: taskId,
            task_type: task.slice(0, 80),
            success: fb.success,
            skill_used: "",
            violations: selfEval.constraint_violations,
            manual_fixes: "",
            loop_id: loopId,
            round,
            // P0–P2: Evolution fields
            discovered_constraints: mergedDiscovered,
            objective_refinement: selfEval.objective_refinement ?? "",
            emerged_subtasks: selfEval.emerged_subtasks ?? [],
            // P4: Execution evidence
            execution_evidence: selfEval.execution_evidence ?? null,
            // P5: Self-correction
            retracted_constraints: selfEval.retracted_constraints ?? [],
            revised_success_criteria: selfEval.revised_success_criteria ?? [],
            wrong_assumptions: selfEval.wrong_assumptions ?? [],
            // Multi-agent: Worker delegation results
            worker_results: selfEval.worker_results ?? [],
            loop_lineage: roundTransaction
                ? {
                    round,
                    round_id: roundTransaction.round_id,
                    round_transaction: roundTransaction,
                }
                : {},
        };
        if (!alreadyCommitted) {
            this.persistFeedbackToVault(signal);
            this.flushFeedbackBuffer();
            if (transactionId && !transactionPersisted()) {
                throw new Error(`Round feedback commit failed: ${transactionId}`);
            }
        }
        // Multi-agent: Auto-record delegation journal from worker_results
        if (selfEval.worker_results && selfEval.worker_results.length > 0) {
            const entries = selfEval.worker_results.map((w, i) => ({
                index: i + 1,
                agentId: w.agentId,
                subAgentType: w.subAgentType,
                subTask: w.subTask,
                resultSummary: w.resultSummary,
                success: w.success,
                discoveredConstraints: w.discoveredConstraints ?? [],
            }));
            this.recordDelegation(loopId, round, entries);
        }
        // Replaying a committed transaction may repair derived delegation data,
        // but must never apply the feedback to mutable engine state twice.
        if (alreadyCommitted)
            return fb.success;
        // Update state
        this.state.call_count++;
        this.state.success_trend.push(fb.success);
        if (this.state.success_trend.length > 20) {
            this.state.success_trend = this.state.success_trend.slice(-20);
        }
        // Circuit breaker
        if (this.shouldBreak()) {
            this.state.circuit_breaker_count++;
        }
        else {
            this.state.circuit_breaker_count = 0;
        }
        logEvent("round_complete", {
            loopId,
            round,
            success: fb.success,
        });
        return fb.success;
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Loop Compile (public, primary)
    // ═══════════════════════════════════════════════════════════════════════
    invokeLoopCompile(request, hydrateResults, options = {}) {
        this.ensureInit(request);
        this.lastTask = request.task;
        // Parse extras via typed extraction pipeline (loop-extras-parser.ts).
        // Errors are collected but never thrown — the compiler always gets
        // best-effort defaults so a malformed request doesn't crash the engine.
        const extras = request;
        const { parsed, ctx } = parseLoopExtras(extras, request.task_id ?? "");
        if (ctx.errors.length > 0) {
            logEvent("extras_parse_errors", {
                errors: ctx.errors.map((e) => `${e.field}: ${e.message}`),
            });
        }
        const lcr = makeLoopCompileRequest({
            loop_id: parsed.loop_id,
            round: parsed.round,
            goal_id: parsed.goal_id,
            task: request.task,
            domain: parsed.domain,
            next_task_proposal: parsed.next_task_proposal,
            plan_source: parsed.plan_source,
            constraints_from_plan: parsed.constraints_from_plan,
            new_since_last_round: parsed.new_since_last_round,
            force_level: parsed.force_level,
            health_check_interval: parsed.health_check_interval,
            external_context: parsed.external_context,
            max_rounds: parsed.max_rounds,
            verification_flags: parsed.verification_flags,
            attempt: parsed.attempt,
            consecutive_rejections: parsed.consecutive_rejections,
            rejection_notice: parsed.rejection_notice,
        });
        // Convert last_round_result if present (object already validated by parser)
        if (parsed.last_round_result) {
            const rr = parsed.last_round_result;
            // Parse P4 execution evidence (shared helper)
            const executionEvidence = parseExecutionEvidence(rr.execution_evidence);
            // Parse P5 revised_success_criteria (shared parser)
            const revisedCriteria = parseCriterionRevisions(rr.revised_success_criteria);
            lcr.last_round_result = makeLoopRoundResult({
                round: rr.round ?? 0,
                success: rr.success ?? false,
                output_summary: rr.output_summary ?? "",
                constraint_violations: rr.constraint_violations ?? [],
                manual_fixes_needed: rr.manual_fixes_needed ?? "",
                // P0–P2: Cognitive evolution fields
                discovered_constraints: Array.isArray(rr.discovered_constraints)
                    ? rr.discovered_constraints.filter((v) => typeof v === "string")
                    : [],
                objective_refinement: typeof rr.objective_refinement === "string"
                    ? rr.objective_refinement
                    : "",
                emerged_subtasks: Array.isArray(rr.emerged_subtasks)
                    ? rr.emerged_subtasks.filter((v) => typeof v === "string")
                    : [],
                // P4: Execution evidence
                execution_evidence: executionEvidence,
                // P5: Self-correction
                retracted_constraints: Array.isArray(rr.retracted_constraints)
                    ? rr.retracted_constraints.filter((v) => typeof v === "string")
                    : [],
                revised_success_criteria: revisedCriteria,
                wrong_assumptions: Array.isArray(rr.wrong_assumptions)
                    ? rr.wrong_assumptions.filter((v) => typeof v === "string")
                    : [],
                // v1.10: Checkpoint boundary
                compression_checkpoint: typeof rr.compression_checkpoint === "boolean" ? rr.compression_checkpoint : false,
                checkpoint_label: typeof rr.checkpoint_label === "string" ? rr.checkpoint_label : "",
                // Multi-agent: Worker delegation results (shared parser)
                worker_results: parseWorkerResults(rr.worker_results),
            });
        }
        // Convert loop_objective if present (object already validated by parser)
        if (parsed.loop_objective) {
            const obj = parsed.loop_objective;
            lcr.loop_objective = makeLoopObjective({
                objective: obj.objective ?? "",
                success_criteria: obj.success_criteria ?? [],
                hard_constraints: obj.hard_constraints ?? [],
                created_at_round: obj.created_at_round ?? 1,
                loop_id: obj.loop_id ?? "",
            });
        }
        // Hydrate vault context for cross-round memory
        let context = hydrateResults ?? null;
        if (context === null && lcr.loop_id && lcr.round > 1) {
            context = this.hydrateLoopContext(lcr.loop_id);
        }
        // Delegate to pure-function compiler
        let response;
        try {
            response = compileLoop(lcr, context);
        }
        catch (exc) {
            return {
                status: AgentStatus.ERROR,
                response: {
                    status: AgentStatus.ERROR,
                    prompt: null,
                    error: `loop_compile failed: ${exc}`,
                },
            };
        }
        // Persist lineage to vault
        if (options.persistLineage !== false) {
            this.persistLoopLineage(response, lcr);
        }
        return {
            status: AgentStatus.OK,
            response: {
                status: AgentStatus.OK,
                prompt: response.prompt,
                error: null,
                state_file_content: response.state_file_content,
                prompt_artifact: response.prompt_artifact,
            },
        };
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Circuit breaker
    // ═══════════════════════════════════════════════════════════════════════
    shouldBreak() {
        if (!this.state)
            return false;
        const policy = getPolicy();
        const maxCB = policy.engine.max_circuit_breaker;
        if (this.state.success_trend.length < maxCB)
            return false;
        const recent = this.state.success_trend.slice(-maxCB);
        // Trip only when all recent rounds are failures (no false-positives on all-success)
        const allFailed = recent.every((v) => v === false);
        if (allFailed) {
            logEvent("circuit_breaker", {
                trend: recent,
                totalRounds: this.state.success_trend.length,
            });
        }
        return allFailed;
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════
export function createEngine(store) {
    return new LoopForgeEngine(store);
}
//# sourceMappingURL=engine.js.map