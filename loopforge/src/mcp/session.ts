/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LoopForgeEngine, extractSelfEvaluation, heuristicSelfEvaluation } from "../engine.js";
import { checkLoopHealth, tokenize, jaccard } from "../loop-compiler.js";
import { getPolicy, resolveAllowedPhases, resolveInjectionPhase, buildAccumulatedMemoryContext, buildBaseMemoryWriteback } from "../policy.js";
import { Mode, makeLoopCompileRequest, makeVaultConfig } from "../protocol.js";
import { ReplayBackend } from "../replay.js";
import { FSBackend } from "../backends/fs.js";
import type { VaultBackend, VaultEntry } from "../backends/interface.js";
import type {
  LoopForgeRequest, SelfEvaluation, VerificationFlag,
  LoopMemoryWriteback, MemoryProviderContext,
} from "../protocol.js";
import { verifySelfEvaluation } from "../verification-gate.js";
import { enforceRound, buildRejectionPrompt } from "../enforcement-gate.js";
import { logEvent } from "../observability.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface McpSession {
  sessionId: string;
  loopId: string;
  task: string;
  engine: LoopForgeEngine;
  currentRound: number;
  maxRounds: number;
  successTrajectory: boolean[];
  status: "running" | "stopped" | "stalled";
  createdAt: number;
  /** Previous round's validated SelfEvaluation — used by verification gate. */
  lastSelfEval?: SelfEvaluation;
  // v1.7: Memory integration state
  injectionCount: number;
  lastInjectionRound: number;
  injectedContexts: string[];
  phase2Triggered: boolean;
  phase3Triggered: boolean;
  // v1.13: Enforcement gate state
  consecutiveRejections: number;
}

export interface McpSessionSummary {
  sessionId: string;
  loopId: string;
  round: number;
  status: "running" | "stopped" | "stalled";
}

export interface StartInput {
  task: string;
  loopId?: string;
  maxRounds?: number;
  domain?: string;
  planSource?: string;
  constraints?: string[];
}

export interface AdvanceResult {
  sessionId: string;
  round: number;
  prompt: string | null;
  stopReason?: string;
  technique?: string;
  level?: string;
  /** @deprecated Use roundSuccess instead. Derived: roundSuccess ? 5 : 1 */
  quality?: number;
  roundSuccess?: boolean;
  warnings?: string[];
  /** v1.13: Enforcement action for this round. accept/reject/terminate.
   *  When "reject", the prompt contains a rejection notice and the agent
   *  must redo the same round. Round counter does NOT increment. */
  enforcementAction?: "accept" | "reject" | "terminate";
  /** v1.13: When enforcementAction is "reject" or "terminate", the reason
   *  why the round was rejected or the loop was terminated. */
  enforcementReason?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildLoopRequest(
  session: McpSession,
  lastEval?: SelfEvaluation,
  _lastQuality?: number, // deprecated — kept for backward compat
  verificationFlags?: VerificationFlag[],
): Record<string, unknown> {
  const req: Record<string, unknown> = {
    task: session.task,
    mode: Mode.LOOP_COMPILE,
    vault_config: makeVaultConfig(),
    feedback: null,
    skill_name: null,
    task_id: null,
    loop_id: session.loopId,
    round: session.currentRound,
    max_rounds: session.maxRounds,
    verification_flags: verificationFlags ?? [],
  };

  if (lastEval) {
    req.last_round_result = {
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
    };
  }

  return req;
}

function parseLevel(rationale?: string): string {
  if (!rationale) return "l2";
  if (rationale.includes("l0")) return "l0";
  if (rationale.includes("l1")) return "l1";
  return "l2";
}

function parseWarnings(prompt: string | null): string[] {
  if (!prompt) return [];
  const warnings: string[] = [];
  const warnSection = prompt.match(/### Warnings\n([\s\S]*?)(?=\n###|\n\*\*|$)/);
  if (warnSection) {
    for (const line of warnSection[1].split("\n")) {
      const m = line.match(/- ⚠️\s*(.+)/);
      if (m) warnings.push(m[1]);
    }
  }
  return warnings;
}

// ── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, McpSession>();
  private backend: VaultBackend | undefined;
  /** Optional provider for long-term memory context retrieval. */
  memoryProvider?: (ctx: MemoryProviderContext) => Promise<string>;
  /** Optional writer for persisting loop knowledge back to long-term memory. */
  memoryWriter?: (payload: LoopMemoryWriteback) => Promise<void>;

  constructor(backend?: VaultBackend) {
    this.backend = backend;
  }

  async create(input: StartInput): Promise<AdvanceResult> {
    const sessionId = randomUUID();
    const loopId = input.loopId ?? randomUUID();
    const engine = new LoopForgeEngine("skills", this.backend);
    const maxRounds = input.maxRounds ?? getPolicy().runtime.max_rounds;

    // Populate extra fields for the first round
    const request = buildLoopRequest({
      sessionId, loopId, task: input.task, engine, currentRound: 1,
      maxRounds, successTrajectory: [], status: "running", createdAt: Date.now(),
      injectionCount: 0, lastInjectionRound: 0, injectedContexts: [],
      phase2Triggered: false, phase3Triggered: false, consecutiveRejections: 0,
    });
    request.domain = input.domain ?? "";
    request.plan_source = input.planSource ?? null;
    request.constraints_from_plan = input.constraints ?? [];

    // v1.8: Phase 1 memory injection (Round 1) — only if allowed by tier
    const miPolicy = getPolicy().memory_injection;
    const allowedPhases = new Set(
      resolveAllowedPhases(maxRounds, miPolicy.round_tiers),
    );
    if (miPolicy.enabled && this.memoryProvider && allowedPhases.has(1)) {
      try {
        const ctx: MemoryProviderContext = {
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
            contextLength: (request.external_context as string).length,
          });
        }
      } catch {
        // memoryProvider failed — degrade gracefully
        logEvent("memory_provider_error", { loopId, round: 1 });
      }
    }

    const result = engine.invokeLoopCompile(request as unknown as LoopForgeRequest);

    // v1.14: Write state file if the compiler produced one and policy allows it
    const sfContent = result.response?.state_file_content;
    if (sfContent && getPolicy().state_file.enabled) {
      const sfDir = join(process.cwd(), getPolicy().state_file.directory);
      mkdirSync(sfDir, { recursive: true });
      writeFileSync(join(sfDir, `${loopId}-state.md`), sfContent, "utf-8");
    }

    const injectedCtx = request.external_context as string | undefined;
    const session: McpSession = {
      sessionId, loopId, task: input.task, engine,
      currentRound: 1, maxRounds, successTrajectory: [],
      status: "running", createdAt: Date.now(),
      // v1.7: Memory integration state
      injectionCount: injectedCtx ? 1 : 0,
      lastInjectionRound: injectedCtx ? 1 : 0,
      injectedContexts: injectedCtx ? [injectedCtx] : [],
      phase2Triggered: false,
      phase3Triggered: false,
      // v1.13: Enforcement gate state
      consecutiveRejections: 0,
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
      roundSuccess: false,
      quality: 0,
      warnings: parseWarnings(result.response?.prompt ?? null),
    };
  }

  get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
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
  save(session: McpSession): void {
    if (!this.backend) return;

    const doSave = () => {
      // Upsert: remove old session_state entries for this loop
      const vault = this.backend!.readVault();
      const entries = (vault.entries as VaultEntry[]) || [];
      vault.entries = entries.filter(
        (e: VaultEntry) =>
          !(e.task_type === "session_state" && e.loop_id === session.loopId),
      );
      this.backend!.writeVault(vault);

      // Append fresh session state
      this.backend!.appendEntry({
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
          // v1.7: Memory integration state for cross-process recovery
          injection_count: session.injectionCount,
          last_injection_round: session.lastInjectionRound,
          phase2_triggered: session.phase2Triggered,
          phase3_triggered: session.phase3Triggered,
          // v1.13: Enforcement gate state
          consecutive_rejections: session.consecutiveRejections,
        },
      });
    };

    // Use FSBackend's file lock if available (only FSBackend implements withLock)
    if (
      "withLock" in this.backend &&
      typeof (this.backend as FSBackend).withLock === "function"
    ) {
      (this.backend as FSBackend).withLock(doSave);
    } else {
      doSave();
    }
  }

  /** Resume a loop from vault state.
   *  Reconstructs the session and compiles the prompt for the next round.
   *  Returns null if no session_state entry exists for this loopId. */
  resume(loopId: string): AdvanceResult | null {
    if (!this.backend) return null;

    const entries = this.backend.queryEntries({
      prefix: `loop:${loopId}:session`,
    });
    const sessionEntry = entries.find(
      (e) => e.task_type === "session_state",
    );
    if (!sessionEntry) return null;

    const lineage = (sessionEntry.loop_lineage ?? {}) as Record<
      string,
      unknown
    >;
    const status = (lineage.status as string) ?? "running";
    const currentRound = (lineage.current_round as number) ?? 1;
    const successTrajectory =
      (lineage.success_trajectory as boolean[]) ?? (lineage.quality_trajectory as boolean[]) ?? [];
    const task = (sessionEntry.task as string) ?? "";
    const maxRounds =
      (lineage.max_rounds as number) ?? getPolicy().runtime.max_rounds;

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
    const session: McpSession = {
      sessionId,
      loopId,
      task,
      engine,
      currentRound,
      maxRounds,
      successTrajectory,
      status: "running",
      createdAt: (lineage.created_at as number) ?? Date.now(),
      // v1.7: Memory integration state restored from vault
      injectionCount: (lineage.injection_count as number) ?? 0,
      lastInjectionRound: (lineage.last_injection_round as number) ?? 0,
      injectedContexts: [],
      phase2Triggered: (lineage.phase2_triggered as boolean) ?? false,
      phase3Triggered: (lineage.phase3_triggered as boolean) ?? false,
      // v1.13: Enforcement gate state restored from vault
      consecutiveRejections: (lineage.consecutive_rejections as number) ?? 0,
    };
    this.sessions.set(sessionId, session);

    // Compile the next round's prompt from vault lineage
    const request = buildLoopRequest(session);
    const result = engine.invokeLoopCompile(
      request as unknown as LoopForgeRequest,
    );

    return {
      sessionId,
      round: currentRound,
      prompt: result.response?.prompt ?? null,
      technique: result.response?.analysis?.technique ?? "zero-shot",
      level: parseLevel(result.response?.analysis?.rationale),
      roundSuccess: false,
      quality: 0,
      warnings: parseWarnings(result.response?.prompt ?? null),
    };
  }

  list(): McpSessionSummary[] {
    const seen = new Set<string>();
    const result: McpSessionSummary[] = [];

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
      const entries = (vault.entries as VaultEntry[]) ?? [];
      for (const e of entries) {
        if (e.task_type !== "session_state") continue;
        const lid = e.loop_id ?? "";
        if (!lid || seen.has(lid)) continue;
        seen.add(lid);
        const lineage = (e.loop_lineage ?? {}) as Record<string, unknown>;
        result.push({
          sessionId: "",
          loopId: lid,
          round: (lineage.current_round as number) ?? 1,
          status: ((lineage.status as string) || "running") as McpSession["status"],
        });
      }
    }

    return result;
  }

  /** Get loop health for a loop (in-memory or vault).
   *  Computes goal alignment, constraint integrity, drift, strategy stability. */
  getHealth(loopId: string): Record<string, unknown> | null {
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
      const sessionEntry = entries.find(
        (e) => e.task_type === "session_state",
      );
      if (sessionEntry) {
        task = (sessionEntry.task as string) ?? "";
      }
    }

    if (!task) return null;

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
  async advance(sessionId: string, output: string, preExtractedEval?: SelfEvaluation): Promise<AdvanceResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, round: 0, prompt: null, stopReason: "session_not_found" };
    if (session.status !== "running") {
      return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status };
    }

    // 1. Extract self-evaluation (structured param preferred → regex → heuristic)
    let extractionFailed = false;
    let selfEval: SelfEvaluation | null;
    if (preExtractedEval) {
      selfEval = preExtractedEval;
      extractionFailed = false;
    } else {
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
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", roundSuccess: false, quality: 0 };
    }

    // 1.5. Verification gate — cross-round consistency check (v1.6)
    let verificationFlags: VerificationFlag[] = [];
    let gateVerdict: string = "trusted";
    let vaultEntries: VaultEntry[] = [];
    {
      vaultEntries = this.backend
        ? this.backend.queryEntries({ prefix: `loop:${session.loopId}:r` })
        : [];
      const verifyResult = verifySelfEvaluation(
        selfEval,
        session.currentRound,
        vaultEntries,
        session.lastSelfEval ?? null,
      );
      verificationFlags = verifyResult.flags;
      gateVerdict = verifyResult.verdict;
    }

    // 1.6. Enforcement gate — round-boundary runtime enforcement (v1.13)
    // Runs AFTER verification so it can use the flags as input.
    // Runs BEFORE feedback recording so rejected rounds don't pollute the vault.
    // Only runs when the self-eval came from structured extraction (not heuristic
    // fallback) — heuristic evaluations have no reliable execution_evidence.
    if (!extractionFailed) {
      const enforceResult = enforceRound(
        selfEval,
        { verdict: gateVerdict as "trusted" | "suspect" | "contradicted", flags: verificationFlags },
        session.currentRound,
        vaultEntries,
        session.consecutiveRejections,
      );

      if (enforceResult.action === "reject") {
        session.consecutiveRejections++;
        this.save(session);
        const rejectionPrompt = buildRejectionPrompt(
          session.currentRound, session.task, enforceResult,
        );
        logEvent("enforcement_reject", {
          sessionId,
          loopId: session.loopId,
          round: session.currentRound,
          reason: enforceResult.reason.slice(0, 120),
          consecutiveRejections: session.consecutiveRejections,
        });
        return {
          sessionId,
          round: session.currentRound,
          prompt: rejectionPrompt,
          enforcementAction: "reject",
          enforcementReason: enforceResult.reason,
        };
      }

      if (enforceResult.action === "terminate") {
        session.status = "stopped";
        this.save(session);
        void this.doWriteback(session, "enforcement_terminated");
        logEvent("session_end", {
          sessionId, loopId: session.loopId,
          stopReason: "enforcement_terminated", round: session.currentRound,
        });
        return {
          sessionId,
          round: session.currentRound,
          prompt: null,
          stopReason: "enforcement_terminated",
          enforcementAction: "terminate",
          enforcementReason: enforceResult.reason,
        };
      }

      // Accept: reset rejection counter and continue
      session.consecutiveRejections = 0;
    }

    // 2. Record feedback (flushes immediately so next compile sees success flags)
    const roundSuccess = session.engine.autoFeedback(
      selfEval, session.loopId, session.currentRound, session.task,
    );

    // Contradicted verdict: skip success trend
    if (gateVerdict !== "contradicted") {
      session.successTrajectory.push(roundSuccess);
    }
    // Note: feedback vault entry is always persisted via autoFeedback above.
    // Only the in-memory trend is skipped — the raw data stays for audit.

    // Store selfEval for next round's verification gate.
    // NOTE: lastSelfEval is intentionally NOT persisted to vault (save()).
    // A resumed session starts with lastSelfEval=undefined, which means the
    // first round after resumption runs with degraded verification (most
    // checks skip without prevSelfEval). The gate recovers on the next round.
    session.lastSelfEval = selfEval;

    // Build deprecated quality alias for backward compat
    const deprecatedQuality = roundSuccess ? 5 : 1;

    // 3. Stop conditions (extraction-first order — see memory)
    if (extractionFailed) {
      session.status = "stalled";
      this.save(session);
      void this.doWriteback(session, "stalled");
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "stalled", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", roundSuccess, quality: deprecatedQuality };
    }
    if (!selfEval.should_continue) {
      session.status = "stopped";
      this.save(session);
      void this.doWriteback(session, "task_complete");
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "task_complete", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "task_complete", roundSuccess, quality: deprecatedQuality };
    }
    if (session.engine.shouldBreak()) {
      session.status = "stopped";
      this.save(session);
      void this.doWriteback(session, "circuit_breaker");
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "circuit_breaker", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "circuit_breaker", roundSuccess, quality: deprecatedQuality };
    }
    if (session.currentRound >= session.maxRounds) {
      session.status = "stopped";
      this.save(session);
      void this.doWriteback(session, "max_rounds");
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "max_rounds", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "max_rounds", roundSuccess, quality: deprecatedQuality };
    }

    // 4. Compile next round
    session.currentRound++;

    // v1.8: Memory injection for phases 2/3 — tier-aware
    let externalCtx = "";
    const miPolicy = getPolicy().memory_injection;
    if (miPolicy.enabled && this.memoryProvider) {
      const allowedPhases = new Set(
        resolveAllowedPhases(session.maxRounds, miPolicy.round_tiers),
      );
      if (session.injectionCount < allowedPhases.size &&
          session.currentRound - session.lastInjectionRound >= miPolicy.min_rounds_between_injections) {
        const progress = selfEval.execution_evidence?.progress_estimate ?? -1;
        const phase = resolveInjectionPhase(
          session.currentRound,
          session.injectionCount,
          allowedPhases,
          typeof progress === "number" ? progress : -1,
          session.phase2Triggered,
          session.phase3Triggered,
          {
            phase2: miPolicy.phase_thresholds.phase2.threshold,
            phase3: miPolicy.phase_thresholds.phase3.threshold,
          },
        );
        if (phase === 2) session.phase2Triggered = true;
        if (phase === 3) session.phase3Triggered = true;

      if (phase !== 0) {
        try {
          const accCtx = buildAccumulatedMemoryContext(selfEval);
          const ctx: MemoryProviderContext = {
            loopId: session.loopId,
            round: session.currentRound,
            task: session.task,
            domain: "",
            phase,
            progressEstimate: typeof progress === "number" && progress >= 0 ? progress : -1,
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
        } catch {
          logEvent("memory_provider_error", {
            loopId: session.loopId, round: session.currentRound,
          });
        }
      }
      }
    }

    const request = buildLoopRequest(session, selfEval, deprecatedQuality, verificationFlags);
    if (externalCtx) {
      request.external_context = externalCtx;
    }
    const result = session.engine.invokeLoopCompile(request as unknown as LoopForgeRequest);

    // v1.14: Write state file if the compiler produced one and policy allows it
    const sfContent = result.response?.state_file_content;
    if (sfContent && getPolicy().state_file.enabled) {
      const sfDir = join(process.cwd(), getPolicy().state_file.directory);
      mkdirSync(sfDir, { recursive: true });
      writeFileSync(join(sfDir, `${session.loopId}-state.md`), sfContent, "utf-8");
    }

    this.save(session);

    return {
      sessionId,
      round: session.currentRound,
      prompt: result.response?.prompt ?? null,
      technique: result.response?.analysis?.technique ?? "zero-shot",
      level: parseLevel(result.response?.analysis?.rationale),
      roundSuccess,
      quality: deprecatedQuality,
      warnings: parseWarnings(result.response?.prompt ?? null),
    };
  }

  /** Write back loop knowledge to long-term memory.
   *  Uses shared base builder from policy.ts. Called when a loop terminates. */
  private async doWriteback(
    session: McpSession,
    stopReason: string,
  ): Promise<void> {
    if (!this.memoryWriter) return;
    const wp = getPolicy().memory_writeback;
    if (!wp.enabled) return;
    if (wp.write_on_outcomes.length > 0 && !wp.write_on_outcomes.includes(stopReason)) return;
    if (session.currentRound < 1) return;

    try {
      const lastEval = session.lastSelfEval;
      const discoveries = lastEval
        ? [
            ...(lastEval.wrong_assumptions ?? []),
            ...(lastEval.emerged_subtasks ?? []),
            ...(lastEval.discovered_constraints ?? []),
          ].slice(0, wp.max_discoveries_in_project)
        : [];
      const base = buildBaseMemoryWriteback({
        loopId: session.loopId,
        task: session.task,
        stopReason,
        roundsCompleted: session.currentRound,
        discoveries,
      });
      const payload: LoopMemoryWriteback = {
        ...base,
        feedbackEntries: [],
      };
      await this.memoryWriter(payload);
      logEvent("memory_writeback", {
        loopId: session.loopId, stopReason,
        feedbackCount: 0,
      });
    } catch {
      logEvent("memory_writeback_error", {
        loopId: session.loopId, stopReason,
      });
    }
  }

  /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
  replayTimeline(sessionId: string): Record<string, unknown>[] | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const vaultBackend = this.backend ?? new FSBackend();
    const replay = new ReplayBackend(vaultBackend);
    return replay.timeline(session.loopId);
  }
}
