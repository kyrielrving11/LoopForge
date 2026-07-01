/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 */
import { randomUUID } from "node:crypto";
import { LoopForgeEngine, extractSelfEvaluation, heuristicSelfEvaluation } from "../engine.js";
import { checkLoopHealth, tokenize, jaccard } from "../loop-compiler.js";
import { getPolicy, resolveAllowedPhases } from "../policy.js";
import { Mode, makeLoopCompileRequest, makeVaultConfig } from "../protocol.js";
import { ReplayBackend } from "../replay.js";
import { FSBackend } from "../backends/fs.js";
import { verifySelfEvaluation } from "../verification-gate.js";
import { logEvent } from "../observability.js";
// ── Helpers ────────────────────────────────────────────────────────────────
function buildLoopRequest(session, lastEval, lastQuality, verificationFlags) {
    const req = {
        task: session.task,
        mode: Mode.LOOP_COMPILE,
        vault_config: makeVaultConfig(),
        feedback: null,
        skill_name: null,
        task_id: null,
        loop_id: session.loopId,
        round: session.currentRound,
        verification_flags: verificationFlags ?? [],
    };
    if (lastEval && lastQuality !== undefined) {
        req.last_round_result = {
            round: session.currentRound - 1,
            success: lastEval.success,
            output_summary: lastEval.output_summary,
            constraint_violations: lastEval.constraint_violations,
            manual_fixes_needed: "",
            quality_score: lastQuality,
            // P0–P2: Forward evolution fields to next compile
            discovered_constraints: lastEval.discovered_constraints ?? [],
            objective_refinement: lastEval.objective_refinement ?? "",
            emerged_subtasks: lastEval.emerged_subtasks ?? [],
            // P4: Execution evidence
            execution_evidence: lastEval.execution_evidence ?? undefined,
            // P5: Self-correction
            retracted_constraints: lastEval.retracted_constraints ?? [],
            revised_success_criteria: lastEval.revised_success_criteria ?? [],
            wrong_assumptions: lastEval.wrong_assumptions ?? [],
        };
    }
    return req;
}
function parseLevel(rationale) {
    if (!rationale)
        return "l2";
    if (rationale.includes("l0"))
        return "l0";
    if (rationale.includes("l1"))
        return "l1";
    return "l2";
}
function parseWarnings(prompt) {
    if (!prompt)
        return [];
    const warnings = [];
    const warnSection = prompt.match(/### Warnings\n([\s\S]*?)(?=\n###|\n\*\*|$)/);
    if (warnSection) {
        for (const line of warnSection[1].split("\n")) {
            const m = line.match(/- ⚠️\s*(.+)/);
            if (m)
                warnings.push(m[1]);
        }
    }
    return warnings;
}
// ── SessionManager ─────────────────────────────────────────────────────────
export class SessionManager {
    sessions = new Map();
    backend;
    /** Optional provider for long-term memory context retrieval. */
    memoryProvider;
    /** Optional writer for persisting loop knowledge back to long-term memory. */
    memoryWriter;
    constructor(backend) {
        this.backend = backend;
    }
    async create(input) {
        const sessionId = randomUUID();
        const loopId = input.loopId ?? randomUUID();
        const engine = new LoopForgeEngine("skills", this.backend);
        const maxRounds = input.maxRounds ?? getPolicy().runtime.max_rounds;
        // Populate extra fields for the first round
        const request = buildLoopRequest({
            sessionId, loopId, task: input.task, engine, currentRound: 1,
            maxRounds, qualityTrajectory: [], status: "running", createdAt: Date.now(),
            injectionCount: 0, lastInjectionRound: 0, injectedContexts: [],
            phase2Triggered: false, phase3Triggered: false,
        });
        request.domain = input.domain ?? "";
        request.plan_source = input.planSource ?? null;
        request.constraints_from_plan = input.constraints ?? [];
        // v1.8: Phase 1 memory injection (Round 1) — only if allowed by tier
        const miPolicy = getPolicy().memory_injection;
        const allowedPhases = new Set(resolveAllowedPhases(maxRounds, miPolicy.round_tiers));
        if (miPolicy.enabled && this.memoryProvider && allowedPhases.has(1)) {
            try {
                const ctx = {
                    loopId,
                    round: 1,
                    task: input.task,
                    domain: input.domain ?? "",
                    phase: 1,
                    progressEstimate: 0,
                    accumulatedContext: {
                        recurringIssues: [],
                        failedPatterns: [],
                        keyLessons: [],
                        remainingCriteria: [],
                    },
                };
                const rawContext = await this.memoryProvider(ctx);
                if (rawContext?.trim()) {
                    request.external_context = rawContext.trim().slice(0, miPolicy.max_context_length);
                    logEvent("memory_injected", {
                        loopId, round: 1, phase: 1, injectionCount: 1,
                        contextLength: request.external_context.length,
                    });
                }
            }
            catch {
                // memoryProvider failed — degrade gracefully
                logEvent("memory_provider_error", { loopId, round: 1 });
            }
        }
        const result = engine.invokeLoopCompile(request);
        const injectedCtx = request.external_context;
        const session = {
            sessionId, loopId, task: input.task, engine,
            currentRound: 1, maxRounds, qualityTrajectory: [],
            status: "running", createdAt: Date.now(),
            // v1.7: Memory integration state
            injectionCount: injectedCtx ? 1 : 0,
            lastInjectionRound: injectedCtx ? 1 : 0,
            injectedContexts: injectedCtx ? [injectedCtx] : [],
            phase2Triggered: false,
            phase3Triggered: false,
        };
        this.sessions.set(sessionId, session);
        // Persist to vault for cross-process recovery
        this.save(session);
        logEvent("session_start", {
            sessionId,
            loopId,
            task: input.task.slice(0, 80),
            maxRounds,
        });
        return {
            sessionId,
            round: 1,
            prompt: result.response?.prompt ?? null,
            technique: result.response?.analysis?.technique ?? "zero-shot",
            level: parseLevel(result.response?.analysis?.rationale),
            quality: 0,
            warnings: parseWarnings(result.response?.prompt ?? null),
        };
    }
    get(sessionId) {
        return this.sessions.get(sessionId);
    }
    delete(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        session.status = "stopped";
        void this.doWriteback(session, "stopped");
        this.sessions.delete(sessionId);
        logEvent("session_end", {
            sessionId,
            loopId: session.loopId,
            stopReason: "stopped",
            roundsCompleted: session.currentRound,
        });
        return true;
    }
    /** Persist session state to vault for cross-process recovery.
     *  Uses upsert: removes any previous session_state entry for this loop,
     *  then appends a new one with current state.
     *  Entire read→filter→write→append is wrapped in a file lock to prevent
     *  lost updates from concurrent processes. */
    save(session) {
        if (!this.backend)
            return;
        const doSave = () => {
            // Upsert: remove old session_state entries for this loop
            const vault = this.backend.readVault();
            const entries = vault.entries || [];
            vault.entries = entries.filter((e) => !(e.task_type === "session_state" && e.loop_id === session.loopId));
            this.backend.writeVault(vault);
            // Append fresh session state
            this.backend.appendEntry({
                task_id: `loop:${session.loopId}:session`,
                task_type: "session_state",
                timestamp: new Date().toISOString(),
                loop_id: session.loopId,
                task: session.task,
                loop_lineage: {
                    session_id: session.sessionId,
                    current_round: session.currentRound,
                    max_rounds: session.maxRounds,
                    quality_trajectory: session.qualityTrajectory,
                    status: session.status,
                    created_at: session.createdAt,
                    // v1.7: Memory integration state for cross-process recovery
                    injection_count: session.injectionCount,
                    last_injection_round: session.lastInjectionRound,
                    phase2_triggered: session.phase2Triggered,
                    phase3_triggered: session.phase3Triggered,
                },
            });
        };
        // Use FSBackend's file lock if available (only FSBackend implements withLock)
        if ("withLock" in this.backend &&
            typeof this.backend.withLock === "function") {
            this.backend.withLock(doSave);
        }
        else {
            doSave();
        }
    }
    /** Resume a loop from vault state.
     *  Reconstructs the session and compiles the prompt for the next round.
     *  Returns null if no session_state entry exists for this loopId. */
    resume(loopId) {
        if (!this.backend)
            return null;
        const entries = this.backend.queryEntries({
            prefix: `loop:${loopId}:session`,
        });
        const sessionEntry = entries.find((e) => e.task_type === "session_state");
        if (!sessionEntry)
            return null;
        const lineage = (sessionEntry.loop_lineage ?? {});
        const status = lineage.status ?? "running";
        const currentRound = lineage.current_round ?? 1;
        const qualityTrajectory = lineage.quality_trajectory ?? [];
        const task = sessionEntry.task ?? "";
        const maxRounds = lineage.max_rounds ?? getPolicy().runtime.max_rounds;
        // If the loop was already stopped or stalled, return immediately
        if (status !== "running") {
            return {
                sessionId: "",
                round: currentRound,
                prompt: null,
                stopReason: status,
            };
        }
        // Reconstruct session with a fresh engine
        const engine = new LoopForgeEngine("skills", this.backend);
        const sessionId = randomUUID();
        const session = {
            sessionId,
            loopId,
            task,
            engine,
            currentRound,
            maxRounds,
            qualityTrajectory,
            status: "running",
            createdAt: lineage.created_at ?? Date.now(),
            // v1.7: Memory integration state restored from vault
            injectionCount: lineage.injection_count ?? 0,
            lastInjectionRound: lineage.last_injection_round ?? 0,
            injectedContexts: [],
            phase2Triggered: lineage.phase2_triggered ?? false,
            phase3Triggered: lineage.phase3_triggered ?? false,
        };
        this.sessions.set(sessionId, session);
        // Compile the next round's prompt from vault lineage
        const request = buildLoopRequest(session);
        const result = engine.invokeLoopCompile(request);
        return {
            sessionId,
            round: currentRound,
            prompt: result.response?.prompt ?? null,
            technique: result.response?.analysis?.technique ?? "zero-shot",
            level: parseLevel(result.response?.analysis?.rationale),
            quality: 0,
            warnings: parseWarnings(result.response?.prompt ?? null),
        };
    }
    list() {
        const seen = new Set();
        const result = [];
        // In-memory sessions first (take priority)
        for (const s of this.sessions.values()) {
            seen.add(s.loopId);
            result.push({
                sessionId: s.sessionId,
                loopId: s.loopId,
                round: s.currentRound,
                status: s.status,
            });
        }
        // Merge vault-persisted sessions not already in memory
        if (this.backend) {
            const vault = this.backend.readVault();
            const entries = vault.entries ?? [];
            for (const e of entries) {
                if (e.task_type !== "session_state")
                    continue;
                const lid = e.loop_id ?? "";
                if (!lid || seen.has(lid))
                    continue;
                seen.add(lid);
                const lineage = (e.loop_lineage ?? {});
                result.push({
                    sessionId: "",
                    loopId: lid,
                    round: lineage.current_round ?? 1,
                    status: (lineage.status || "running"),
                });
            }
        }
        return result;
    }
    /** Get loop health for a loop (in-memory or vault).
     *  Computes goal alignment, constraint integrity, drift, strategy stability. */
    getHealth(loopId) {
        // Find the task — check in-memory sessions first, then vault
        let task = "";
        let goalId = loopId;
        for (const s of this.sessions.values()) {
            if (s.loopId === loopId) {
                task = s.task;
                if (s.engine.state?.task_id) {
                    goalId = s.engine.state.task_id;
                }
                break;
            }
        }
        // Fall back to vault for task
        if (!task && this.backend) {
            const entries = this.backend.queryEntries({
                prefix: `loop:${loopId}:session`,
            });
            const sessionEntry = entries.find((e) => e.task_type === "session_state");
            if (sessionEntry) {
                task = sessionEntry.task ?? "";
            }
        }
        if (!task)
            return null;
        // Hydrate vault context
        const engine = new LoopForgeEngine("skills", this.backend);
        const vaultContext = engine.hydrateLoopContext(loopId);
        // Build a minimal request for health check
        const request = makeLoopCompileRequest({
            task,
            loop_id: loopId,
            goal_id: goalId,
            round: 1, // round doesn't matter for health check
        });
        const health = checkLoopHealth(loopId, request, vaultContext);
        return {
            loopId,
            goal_alignment: health.goal_alignment,
            constraint_integrity: health.constraint_integrity,
            drift_detected: health.drift_detected,
            strategy_stability: health.strategy_stability,
            task_continuity: health.task_continuity,
        };
    }
    /** Core cycle: extract self-eval → record feedback → check stop → compile next.
     *  @param preExtractedEval Optional pre-built SelfEvaluation from MCP tool parameter.
     *    When provided (MCP path with evaluation parameter), skips regex extraction.
     *    When undefined (runtime/CLI path), falls back to regex extraction from output. */
    async advance(sessionId, output, preExtractedEval) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return { sessionId, round: 0, prompt: null, stopReason: "session_not_found" };
        if (session.status !== "running") {
            return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status };
        }
        // 1. Extract self-evaluation (structured param preferred → regex → heuristic)
        let extractionFailed = false;
        let selfEval;
        if (preExtractedEval) {
            selfEval = preExtractedEval;
            extractionFailed = false;
        }
        else {
            const structured = extractSelfEvaluation(output);
            extractionFailed = structured === null;
            selfEval = structured ?? heuristicSelfEvaluation(output);
        }
        // Guard: if both extraction methods returned null, stop
        if (!selfEval) {
            session.status = "stalled";
            this.save(session);
            void this.doWriteback(session, "stalled");
            logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "stalled", round: session.currentRound });
            return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", quality: 0 };
        }
        // 1.5. Verification gate — cross-round consistency check (v1.6)
        let verificationFlags = [];
        let gateVerdict = "trusted";
        {
            const vaultEntries = this.backend
                ? this.backend.queryEntries({ prefix: `loop:${session.loopId}:r` })
                : [];
            const verifyResult = verifySelfEvaluation(selfEval, session.currentRound, vaultEntries, session.lastSelfEval ?? null);
            verificationFlags = verifyResult.flags;
            gateVerdict = verifyResult.verdict;
        }
        // 2. Record feedback (flushes immediately so next compile sees scores)
        const quality = session.engine.autoFeedback(selfEval, session.loopId, session.currentRound, session.task);
        // Contradicted verdict: skip quality trend (quality score is unreliable)
        if (gateVerdict !== "contradicted") {
            session.qualityTrajectory.push(quality);
        }
        // Note: feedback vault entry is always persisted via autoFeedback above.
        // Only the in-memory trend is skipped — the raw data stays for audit.
        // Store selfEval for next round's verification gate.
        // NOTE: lastSelfEval is intentionally NOT persisted to vault (save()).
        // A resumed session starts with lastSelfEval=undefined, which means the
        // first round after resumption runs with degraded verification (most
        // checks skip without prevSelfEval). The gate recovers on the next round.
        session.lastSelfEval = selfEval;
        // 3. Stop conditions (extraction-first order — see memory)
        if (extractionFailed) {
            session.status = "stalled";
            this.save(session);
            void this.doWriteback(session, "stalled");
            logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "stalled", round: session.currentRound });
            return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", quality };
        }
        if (!selfEval.should_continue) {
            session.status = "stopped";
            this.save(session);
            void this.doWriteback(session, "task_complete");
            logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "task_complete", round: session.currentRound });
            return { sessionId, round: session.currentRound, prompt: null, stopReason: "task_complete", quality };
        }
        if (session.engine.shouldBreak()) {
            session.status = "stopped";
            this.save(session);
            void this.doWriteback(session, "circuit_breaker");
            logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "circuit_breaker", round: session.currentRound });
            return { sessionId, round: session.currentRound, prompt: null, stopReason: "circuit_breaker", quality };
        }
        if (session.currentRound >= session.maxRounds) {
            session.status = "stopped";
            this.save(session);
            void this.doWriteback(session, "max_rounds");
            logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "max_rounds", round: session.currentRound });
            return { sessionId, round: session.currentRound, prompt: null, stopReason: "max_rounds", quality };
        }
        // 4. Compile next round
        session.currentRound++;
        // v1.8: Memory injection for phases 2/3 — tier-aware
        let externalCtx = "";
        const miPolicy = getPolicy().memory_injection;
        if (miPolicy.enabled && this.memoryProvider) {
            const allowedPhases = new Set(resolveAllowedPhases(session.maxRounds, miPolicy.round_tiers));
            if (session.injectionCount < allowedPhases.size &&
                session.currentRound - session.lastInjectionRound >= miPolicy.min_rounds_between_injections) {
                const progress = selfEval.execution_evidence?.progress_estimate;
                const hasProgress = typeof progress === "number" && progress >= 0;
                let phase = null;
                if (allowedPhases.has(2) &&
                    !session.phase2Triggered &&
                    hasProgress &&
                    progress >= miPolicy.phase_thresholds.phase2.threshold) {
                    phase = 2;
                    session.phase2Triggered = true;
                }
                else if (allowedPhases.has(3) &&
                    !session.phase3Triggered &&
                    hasProgress &&
                    progress >= miPolicy.phase_thresholds.phase3.threshold) {
                    phase = 3;
                    session.phase3Triggered = true;
                }
                if (phase !== null) {
                    try {
                        const accCtx = {
                            recurringIssues: selfEval.constraint_violations ?? [],
                            failedPatterns: [],
                            keyLessons: selfEval.emerged_subtasks ?? [],
                            remainingCriteria: selfEval.execution_evidence?.success_criteria_remaining ?? [],
                        };
                        const ctx = {
                            loopId: session.loopId,
                            round: session.currentRound,
                            task: session.task,
                            domain: "",
                            phase,
                            progressEstimate: hasProgress ? progress : -1,
                            accumulatedContext: accCtx,
                        };
                        const rawContext = await this.memoryProvider(ctx);
                        if (rawContext?.trim()) {
                            // Dedup
                            const newTokens = tokenize(rawContext);
                            let isDuplicate = false;
                            for (const old of session.injectedContexts) {
                                if (jaccard(newTokens, tokenize(old)) > miPolicy.dedup_threshold) {
                                    isDuplicate = true;
                                    break;
                                }
                            }
                            if (!isDuplicate) {
                                externalCtx = rawContext.trim().slice(0, miPolicy.max_context_length);
                                session.injectionCount++;
                                session.lastInjectionRound = session.currentRound;
                                session.injectedContexts.push(externalCtx);
                                logEvent("memory_injected", {
                                    loopId: session.loopId, round: session.currentRound,
                                    phase, injectionCount: session.injectionCount,
                                    contextLength: externalCtx.length,
                                });
                            }
                        }
                    }
                    catch {
                        logEvent("memory_provider_error", {
                            loopId: session.loopId, round: session.currentRound,
                        });
                    }
                }
            }
        }
        const request = buildLoopRequest(session, selfEval, quality, verificationFlags);
        if (externalCtx) {
            request.external_context = externalCtx;
        }
        const result = session.engine.invokeLoopCompile(request);
        this.save(session);
        return {
            sessionId,
            round: session.currentRound,
            prompt: result.response?.prompt ?? null,
            technique: result.response?.analysis?.technique ?? "zero-shot",
            level: parseLevel(result.response?.analysis?.rationale),
            quality,
            warnings: parseWarnings(result.response?.prompt ?? null),
        };
    }
    /** Write back loop knowledge to long-term memory.
     *  Called when a loop terminates for any reason. */
    async doWriteback(session, stopReason) {
        if (!this.memoryWriter)
            return;
        const wp = getPolicy().memory_writeback;
        if (!wp.enabled)
            return;
        if (wp.write_on_outcomes.length > 0 && !wp.write_on_outcomes.includes(stopReason))
            return;
        if (session.currentRound < 1)
            return;
        const outcome = ["completed", "circuit_breaker", "stalled", "max_rounds", "stopped"].find((o) => stopReason === o) ?? "stopped";
        try {
            const payload = {
                loopId: session.loopId,
                task: session.task,
                outcome,
                roundsCompleted: session.currentRound,
                qualityTrajectory: [...session.qualityTrajectory],
                projectEntry: {
                    title: `${session.task.slice(0, 80)} — ${outcome}`,
                    objective: session.task.slice(0, 200),
                    keyOutcome: outcome === "completed"
                        ? `Completed successfully in ${session.currentRound} rounds.`
                        : `Terminated with reason '${stopReason}' after ${session.currentRound} rounds.`,
                    keyDiscoveries: [],
                    date: new Date().toISOString().split("T")[0],
                },
                feedbackEntries: [],
                referenceEntry: {
                    description: `LoopForge vault data for "${session.task.slice(0, 80)}"`,
                    vaultLocation: `.promptcraft/prompt_vault.json → loop:${session.loopId}:*`,
                },
            };
            await this.memoryWriter(payload);
            logEvent("memory_writeback", {
                loopId: session.loopId, stopReason,
                feedbackCount: payload.feedbackEntries.length,
            });
        }
        catch {
            logEvent("memory_writeback_error", {
                loopId: session.loopId, stopReason,
            });
        }
    }
    /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
    replayTimeline(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        const vaultBackend = this.backend ?? new FSBackend();
        const replay = new ReplayBackend(vaultBackend);
        return replay.timeline(session.loopId);
    }
}
//# sourceMappingURL=session.js.map