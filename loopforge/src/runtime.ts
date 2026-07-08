/** LoopForge — Loop Runtime (v1.2).
 *
 *  Event-driven loop driver that wraps the compilation engine with
 *  heartbeat monitoring, timeout/stall detection, and graceful shutdown.
 *
 *  Primary API:
 *    import { run } from 'loopforge';
 *    const result = await run({ task: '...', execute: myAgent });
 *
 *  Advanced API:
 *    const rt = new LoopRuntime(config);
 *    rt.on('round:complete', (info) => console.log(info));
 *    const result = await rt.start();
 */

import { EventEmitter } from "node:events";
import {
  extractSelfEvaluation,
  heuristicSelfEvaluation,
  LoopForgeEngine,
  createEngine,
} from "./engine.js";
import { tokenize, jaccard } from "./loop-compiler.js";
import {
  Mode,
  RuntimeStatus,
  makeLoopCompileRequest,
  makeLoopRoundResult,
  makeSelfEvaluation,
  makeVaultConfig,
  type LoopCompileRequest,
  type LoopRoundResult,
  type RoundContext,
  type RoundStartInfo,
  type RoundCompleteInfo,
  type HeartbeatInfo,
  type TimeoutInfo,
  type HealthWarning,
  type RuntimeConfig,
  type RunResult,
  type SelfEvaluation,
  type StopReason,
  type LoopMemoryWriteback,
  type MemoryProviderContext,
} from "./protocol.js";
import { getPolicy, resolveAllowedPhases } from "./policy.js";
import { verifySelfEvaluation } from "./verification-gate.js";
import type { VerificationFlag } from "./protocol.js";
import { logEvent } from "./observability.js";
import { tryAutoConfigure } from "./memory-bridge.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Build a writeback payload from the loop's final state.
 *  Extracts project-level outcome, tactical lessons, and vault reference.
 *  Returns null if there is no meaningful data to write back. */
function buildWritebackPayload(
  loopId: string,
  task: string,
  stopReason: string,
  result: RunResult,
): LoopMemoryWriteback | null {
  // Only write back for meaningful loops (at least 1 round completed)
  if (result.roundsCompleted < 1) return null;

  const policy = getPolicy();
  const wp = policy.memory_writeback;

  const outcome = (
    ["completed", "circuit_breaker", "stalled", "max_rounds", "stopped"] as const
  ).find((o) => stopReason === o) ?? "stopped";

  // Build project entry
  const projectEntry = {
    title: `${task.slice(0, 80)} — ${outcome}`,
    objective: task.slice(0, 200),
    keyOutcome: stopReason === "task_complete"
      ? `Completed successfully in ${result.roundsCompleted} rounds.`
      : `Terminated with reason '${stopReason}' after ${result.roundsCompleted} rounds.`,
    keyDiscoveries: [] as string[],
    date: new Date().toISOString().split("T")[0],
  };

  // Build feedback entries from success trajectory patterns
  const feedbackEntries: LoopMemoryWriteback["feedbackEntries"] = [];
  const trajectory = result.successTrajectory;

  if (trajectory.length >= 3) {
    // Detect improving trend via success rate
    const firstHalf = trajectory.slice(0, Math.floor(trajectory.length / 2));
    const secondHalf = trajectory.slice(Math.floor(trajectory.length / 2));
    const firstRate = firstHalf.filter(Boolean).length / firstHalf.length;
    const secondRate = secondHalf.filter(Boolean).length / secondHalf.length;

    if (secondRate - firstRate > 0.3) {
      feedbackEntries.push({
        rule: `Success rate improved from ${(firstRate * 100).toFixed(0)}% to ${(secondRate * 100).toFixed(0)}% over ${trajectory.length} rounds`,
        why: `Mid-loop strategy adjustment unlocked progress in task "${task.slice(0, 80)}"`,
        howToApply: "Consider the strategy used in later rounds for similar tasks",
      });
    }
  }

  // Detect flatlining — 3 consecutive failures
  if (trajectory.length >= 3) {
    const recent = trajectory.slice(-3);
    if (recent.every((v) => v === false)) {
      feedbackEntries.push({
        rule: `Failed 3 consecutive rounds at end of loop`,
        why: `Task "${task.slice(0, 80)}" stopped with reason '${stopReason}' — strategy may have stagnated`,
        howToApply: "If re-attempting, start with a different technique than the one that produced the failures",
      });
    }
  }

  // Build reference entry pointing to vault
  const referenceEntry = {
    description: `LoopForge vault data for "${task.slice(0, 80)}"`,
    vaultLocation: `.promptcraft/prompt_vault.json → loop:${loopId}:*`,
  };

  return {
    loopId,
    task,
    outcome,
    roundsCompleted: result.roundsCompleted,
    projectEntry: {
      ...projectEntry,
      keyDiscoveries: projectEntry.keyDiscoveries.slice(0, wp.max_discoveries_in_project),
    },
    feedbackEntries: feedbackEntries.slice(0, wp.max_feedback_entries),
    referenceEntry,
  };
}

function autoLoopId(task: string): string {
  let slug = task.toLowerCase().trim().slice(0, 60);
  slug = slug.replace(/[^a-z0-9\s-]/g, "");
  slug = slug.replace(/\s+/g, "-");
  return slug || "unnamed-loop";
}

function resolveConfig(raw: RuntimeConfig): RequiredConfig {
  const policy = getPolicy();
  const rtPolicy = policy.runtime;
  const config: RequiredConfig = {
    task: raw.task,
    execute: raw.execute,
    loopId: raw.loopId || autoLoopId(raw.task),
    goalId: raw.goalId || "",
    maxRounds: raw.maxRounds ?? rtPolicy.max_rounds,
    roundTimeoutMs: raw.roundTimeoutMs ?? rtPolicy.round_timeout_ms,
    heartbeatIntervalMs:
      raw.heartbeatIntervalMs ?? rtPolicy.heartbeat_interval_ms,
    stallGraceMs: raw.stallGraceMs ?? rtPolicy.stall_grace_ms,
    maxConsecutiveErrors:
      raw.maxConsecutiveErrors ?? rtPolicy.max_consecutive_errors,
    interactive: raw.interactive ?? false,
    healthCheckInterval: raw.healthCheckInterval ?? policy.summary.health_check_interval,
    planSource: raw.planSource ?? undefined,
    constraintsFromPlan: raw.constraintsFromPlan ?? [],
    domain: raw.domain ?? "",
    onRoundStart: raw.onRoundStart,
    onRoundComplete: raw.onRoundComplete,
    onHeartbeat: raw.onHeartbeat,
    onTimeout: raw.onTimeout,
    onHealthWarning: raw.onHealthWarning,
    memoryProvider: raw.memoryProvider,
    memoryWriter: raw.memoryWriter,
  };

  // Auto-detect claude-mem if no explicit provider was given
  if (!config.memoryProvider && !config.memoryWriter) {
    const auto = tryAutoConfigure();
    if (auto.memoryProvider) config.memoryProvider = auto.memoryProvider;
    if (auto.memoryWriter) config.memoryWriter = auto.memoryWriter;
  }

  return config;
}

interface RequiredConfig {
  task: string;
  execute: (prompt: string, ctx: RoundContext) => Promise<string>;
  loopId: string;
  goalId: string;
  maxRounds: number;
  roundTimeoutMs: number;
  heartbeatIntervalMs: number;
  stallGraceMs: number;
  maxConsecutiveErrors: number;
  interactive: boolean;
  healthCheckInterval: number;
  planSource?: string;
  constraintsFromPlan: string[];
  domain: string;
  onRoundStart?: (info: RoundStartInfo) => void;
  onRoundComplete?: (info: RoundCompleteInfo) => void;
  onHeartbeat?: (info: HeartbeatInfo) => void;
  onTimeout?: (info: TimeoutInfo) => void;
  onHealthWarning?: (warning: HealthWarning) => void;
  memoryProvider?: (ctx: MemoryProviderContext) => Promise<string>;
  memoryWriter?: (payload: LoopMemoryWriteback) => Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// LoopRuntime
// ═══════════════════════════════════════════════════════════════════════════

export class LoopRuntime extends EventEmitter {
  private config: RequiredConfig;
  private engine: LoopForgeEngine;
  private _status: RuntimeStatus = RuntimeStatus.IDLE;
  private currentRound = 1;
  private successTrajectory: boolean[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;

  // Verification gate state (v1.6 unified — was MCP-only, now also in runtime)
  private lastSelfEval: SelfEvaluation | null = null;
  private pendingVerificationFlags: VerificationFlag[] = [];

  // Memory integration state (v1.7)
  private injectionCount = 0;
  private lastInjectionRound = 0;
  private injectedContexts: string[] = [];
  private phase2Triggered = false;
  private phase3Triggered = false;
  private pendingExternalContext = "";

  // Shared mutable state between the main loop and the heartbeat tick
  private roundStartTime = 0;
  private lastProgressTime = 0;
  private activeCtx: RoundContext | null = null;
  private timedOut = false;

  constructor(rawConfig: RuntimeConfig) {
    super();
    this.config = resolveConfig(rawConfig);
    this.engine = createEngine();
  }

  get status(): RuntimeStatus {
    return this._status;
  }

  getCurrentRound(): number {
    return this.currentRound;
  }

  getSuccessTrajectory(): boolean[] {
    return [...this.successTrajectory];
  }

  // ── Memory Integration (v1.7) ──────────────────────────────────────────

  /** Derive the current progress estimate from the last self evaluation.
   *  Returns -1 if no progress data is available. */
  private getCurrentProgress(): number {
    if (!this.lastSelfEval?.execution_evidence) return -1;
    const pe = this.lastSelfEval.execution_evidence.progress_estimate;
    return typeof pe === "number" ? pe : -1;
  }

  /** Determine whether memory should be injected this round based on
   *  tier-based allowed phases, progress thresholds, and round spacing. */
  private shouldInjectMemory(): boolean {
    const policy = getPolicy();
    const mi = policy.memory_injection;
    if (!mi.enabled) return false;
    if (!this.config.memoryProvider) return false;
    if (
      this.lastInjectionRound > 0 &&
      this.currentRound - this.lastInjectionRound < mi.min_rounds_between_injections
    ) {
      return false;
    }

    // Resolve which phases are allowed for this loop's maxRounds
    const allowedPhases = new Set(
      resolveAllowedPhases(this.config.maxRounds, mi.round_tiers),
    );
    const maxInjections = allowedPhases.size;
    if (this.injectionCount >= maxInjections) return false;

    const progress = this.getCurrentProgress();

    // Phase 1: round 1, always check if allowed
    if (this.currentRound === 1 && this.injectionCount === 0 && allowedPhases.has(1)) {
      return true;
    }

    // Phase 2: progress threshold (only if allowed by tier)
    if (
      allowedPhases.has(2) &&
      !this.phase2Triggered &&
      progress >= mi.phase_thresholds.phase2.threshold
    ) {
      return true;
    }

    // Phase 3: progress threshold (only if allowed by tier)
    if (
      allowedPhases.has(3) &&
      !this.phase3Triggered &&
      progress >= mi.phase_thresholds.phase3.threshold
    ) {
      return true;
    }

    return false;
  }

  /** Build the accumulated context for constructing a targeted memory query. */
  private buildAccumulatedContext() {
    const recurringIssues: string[] = [];
    const failedPatterns: string[] = [];
    const keyLessons: string[] = [];
    const remainingCriteria: string[] = [];

    if (this.lastSelfEval) {
      // Recurring issues: violations that have appeared before
      if (this.lastSelfEval.constraint_violations.length) {
        recurringIssues.push(...this.lastSelfEval.constraint_violations);
      }
      // Remaining criteria
      if (this.lastSelfEval.execution_evidence?.success_criteria_remaining?.length) {
        remainingCriteria.push(
          ...this.lastSelfEval.execution_evidence.success_criteria_remaining,
        );
      }
      // Key lessons from emerged subtasks
      if (this.lastSelfEval.emerged_subtasks?.length) {
        keyLessons.push(...this.lastSelfEval.emerged_subtasks);
      }
      // Wrong assumptions as negative lessons
      if (this.lastSelfEval.wrong_assumptions?.length) {
        keyLessons.push(
          ...this.lastSelfEval.wrong_assumptions.map((a) => `Wrong: ${a}`),
        );
      }
    }

    return { recurringIssues, failedPatterns, keyLessons, remainingCriteria };
  }

  /** Deduplicate external context against previously injected contexts.
   *  Returns empty string if the new context is too similar to any prior. */
  private dedupAndStoreContext(newContext: string): string {
    if (!newContext.trim()) return "";
    const policy = getPolicy();
    const threshold = policy.memory_injection.dedup_threshold;
    const newTokens = tokenize(newContext);

    for (const old of this.injectedContexts) {
      const oldTokens = tokenize(old);
      if (jaccard(newTokens, oldTokens) > threshold) {
        return ""; // Too similar — skip
      }
    }

    this.injectedContexts.push(newContext);
    return newContext;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Start the loop. Returns when the loop terminates (task complete,
   *  circuit breaker, max rounds, stalled, or manual stop). */
  async start(): Promise<RunResult> {
    if (this._status !== RuntimeStatus.IDLE) {
      throw new Error(`Cannot start: runtime is ${this._status}`);
    }

    this._status = RuntimeStatus.RUNNING;
    this.registerSignalHandlers();
    this.startHeartbeat();

    this.emit("start");

    let stopReason: StopReason = "max_rounds";
    let previousAgentOutput: string | null = null;
    let consecutiveErrors = 0;

    try {
      for (
        this.currentRound = 1;
        this.currentRound <= this.config.maxRounds;
        this.currentRound++
      ) {
        if (this._status !== RuntimeStatus.RUNNING) {
          stopReason = this._status === RuntimeStatus.STALLED ? "stalled" : "stopped";
          break;
        }

      // ── v1.7: Memory Injection (before compile, only at L2 phases) ──
      this.pendingExternalContext = "";
      if (this.shouldInjectMemory()) {
        const progress = this.getCurrentProgress();
        let phase: 1 | 2 | 3;
        if (this.currentRound === 1) {
          phase = 1;
        } else if (!this.phase2Triggered && progress >= getPolicy().memory_injection.phase_thresholds.phase2.threshold) {
          phase = 2;
          this.phase2Triggered = true;
        } else {
          phase = 3;
          this.phase3Triggered = true;
        }

        try {
          const ctx: MemoryProviderContext = {
            loopId: this.config.loopId,
            round: this.currentRound,
            task: this.config.task,
            domain: this.config.domain,
            phase,
            progressEstimate: progress,
            accumulatedContext: this.buildAccumulatedContext(),
          };
          const rawContext = await this.config.memoryProvider!(ctx);
          this.pendingExternalContext = this.dedupAndStoreContext(rawContext);
          if (this.pendingExternalContext) {
            this.injectionCount++;
            this.lastInjectionRound = this.currentRound;
            logEvent("memory_injected", {
              loopId: this.config.loopId,
              round: this.currentRound,
              phase,
              injectionCount: this.injectionCount,
              contextLength: this.pendingExternalContext.length,
            });
          }
        } catch {
          // memoryProvider failed — degrade gracefully, continue without context
          this.pendingExternalContext = "";
          logEvent("memory_provider_error", {
            loopId: this.config.loopId,
            round: this.currentRound,
          });
        }
      }

      // ── Compile ──────────────────────────────────────────────────
      const lcr = this.buildCompileRequest(previousAgentOutput);
      const compileResult = this.engine.invokeLoopCompile({
        task: this.config.task,
        mode: Mode.LOOP_COMPILE,
        vault_config: makeVaultConfig(),
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
        last_round_result: (lcr.last_round_result ?? undefined) as
          | Record<string, unknown>
          | undefined,
        verification_flags: this.pendingVerificationFlags,
        external_context: this.pendingExternalContext || undefined,
      });

      if (!compileResult.response?.prompt) {
        stopReason = "stalled";
        break;
      }

      const prompt = compileResult.response.prompt;
      const analysis = compileResult.response.analysis;
      const level = analysis?.rationale?.includes("l0")
        ? "l0"
        : analysis?.rationale?.includes("l1")
          ? "l1"
          : "l2";
      const technique = analysis?.technique ?? "unknown";

      // ── Emit round:start ──────────────────────────────────────────
      const startInfo: RoundStartInfo = { round: this.currentRound, level, technique, prompt };
      this.emit("round:start", startInfo);
      this.config.onRoundStart?.(startInfo);

      // ── Execute ───────────────────────────────────────────────────
      this.roundStartTime = Date.now();
      this.lastProgressTime = this.roundStartTime;
      this.timedOut = false;

      const ctx: RoundContext = {
        round: this.currentRound,
        signal: { aborted: false },
        reportProgress: (message: string) => {
          this.lastProgressTime = Date.now();
          void message; // consumed by heartbeat via lastProgressTime
        },
      };
      this.activeCtx = ctx;

      let agentOutput: string;
      try {
        agentOutput = await this.config.execute(prompt, ctx);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        const dur = Date.now() - this.roundStartTime;
        this.activeCtx = null;

        // Emit round:complete with error info
        const errInfo: RoundCompleteInfo = {
          round: this.currentRound,
          roundSuccess: false,
          selfEval: makeSelfEvaluation({
            success: false,
            output_summary: `execute threw: ${String(err).slice(0, 200)}`,
            constraint_violations: ["execute() threw an exception"],
            should_continue: true,
          }),
          durationMs: dur,
        };
        this.emit("round:complete", errInfo);
        this.config.onRoundComplete?.(errInfo);
        this.successTrajectory.push(false);

        if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
          stopReason = "executor_failure";
          break;
        }
        // Record as a failed round so the next round's compilation
        // sees the failure context (forces L1/L2)
        previousAgentOutput = null;
        continue;
      }

      const durationMs = Date.now() - this.roundStartTime;
      this.activeCtx = null;

      // ── Extract self-eval ─────────────────────────────────────────
      let selfEval: SelfEvaluation | null = extractSelfEvaluation(agentOutput);
      let extractionSucceeded = selfEval !== null;

      if (selfEval === null) {
        selfEval = heuristicSelfEvaluation(agentOutput);
        extractionSucceeded = false;
      }

      // ── Auto-feedback ─────────────────────────────────────────────
      if (selfEval !== null) {
        this.engine.autoFeedback(
          selfEval,
          this.config.loopId,
          this.currentRound,
          this.config.task,
        );
      }

      // ── Verification gate (v1.6 unified) ──────────────────────────
      // Run cross-round consistency checks between self-eval and lineage.
      // Flags are injected into the NEXT round's prompt via the engine.
      this.pendingVerificationFlags = [];
      let gateContradicted = false;
      if (selfEval !== null) {
        const vaultEntries = this.engine.getBackend().queryEntries({
          prefix: `loop:${this.config.loopId}:r`,
        });
        const verifyResult = verifySelfEvaluation(
          selfEval,
          this.currentRound,
          vaultEntries,
          this.lastSelfEval,
        );
        this.pendingVerificationFlags = verifyResult.flags;
        if (verifyResult.verdict === "contradicted") {
          gateContradicted = true;
          logEvent("gate_contradicted", {
            loopId: this.config.loopId,
            round: this.currentRound,
            flags: verifyResult.flags.map((f) => f.check),
          });
        }
        this.lastSelfEval = selfEval;
      }

      // Compute round success
      const roundSuccess = selfEval?.success ?? false;
      // Contradicted gate verdict: skip success trend (match MCP path behavior)
      if (!gateContradicted) {
        this.successTrajectory.push(roundSuccess);
      }

      // ── Emit round:complete ───────────────────────────────────────
      const completeInfo: RoundCompleteInfo = {
        round: this.currentRound,
        roundSuccess,
        selfEval,
        durationMs,
      };
      this.emit("round:complete", completeInfo);
      this.config.onRoundComplete?.(completeInfo);
      logEvent("round_complete", {
        loopId: this.config.loopId ?? "unknown",
        round: this.currentRound,
        success: roundSuccess,
        durationMs,
        technique: "loop_runtime",
      });

      // ── Check stop conditions ─────────────────────────────────────
      // Extraction check FIRST — heuristic results are low-confidence
      if (!extractionSucceeded) {
        stopReason = "stalled"; // extraction_failure mapped to stalled
        break;
      }

      if (selfEval && !selfEval.should_continue) {
        stopReason = "task_complete";
        break;
      }

      if (this.engine.shouldBreak()) {
        stopReason = "circuit_breaker";
        break;
      }

      if (this.timedOut) {
        // Next round will be forced L2 via the compile request
        this.timedOut = false;
      }

      previousAgentOutput = agentOutput;
    }
    } finally {
      // ── Cleanup — always runs even if the loop body throws ──────────
      this.stopHeartbeat();
      this.unregisterSignalHandlers();

      if (this._status === RuntimeStatus.RUNNING) {
        this._status = RuntimeStatus.STOPPED;
      }
    }

    const result: RunResult = {
      success: stopReason === "task_complete",
      stopReason,
      roundsCompleted: this.currentRound > this.config.maxRounds
        ? this.config.maxRounds
        : this.currentRound,
      successTrajectory: [...this.successTrajectory],
    };

    // ── v1.7: Memory Writeback ───────────────────────────────────────
    const wp = getPolicy().memory_writeback;
    if (wp.enabled && this.config.memoryWriter) {
      const shouldWrite = wp.write_on_outcomes.includes(stopReason) ||
        wp.write_on_outcomes.length === 0;
      if (shouldWrite && result.roundsCompleted > 0) {
        try {
          const payload = buildWritebackPayload(
            this.config.loopId,
            this.config.task,
            stopReason,
            result,
          );
          if (payload) {
            await this.config.memoryWriter(payload);
            logEvent("memory_writeback", {
              loopId: this.config.loopId,
              stopReason,
              feedbackCount: payload.feedbackEntries.length,
            });
          }
        } catch {
          // memoryWriter failed — degrade gracefully
          logEvent("memory_writeback_error", {
            loopId: this.config.loopId,
            stopReason,
          });
        }
      }
    }

    this.emit("done", result);
    return result;
  }

  /** Stop the loop gracefully. Safe to call from any thread/timer. */
  stop(): void {
    if (
      this._status === RuntimeStatus.RUNNING
    ) {
      this._status = RuntimeStatus.STOPPED;
      this.emit("stop");
    }
  }

  // ── Internal: compile request builder ─────────────────────────────────

  private buildCompileRequest(
    previousAgentOutput: string | null,
  ): LoopCompileRequest {
    const lcr = makeLoopCompileRequest({
      loop_id: this.config.loopId,
      round: this.currentRound,
      goal_id: this.config.goalId || "",
      task: this.config.task,
      domain: this.config.domain,
      plan_source: this.config.planSource ?? null,
      constraints_from_plan: this.config.constraintsFromPlan,
      health_check_interval: this.config.healthCheckInterval,
      vault_config: makeVaultConfig(),
    });

    if (this.timedOut && this.currentRound > 1) {
      lcr.force_level = "l2";
    }

    // Attach last round result from previous iteration
    if (previousAgentOutput !== null && this.currentRound > 1) {
      const selfEval =
        extractSelfEvaluation(previousAgentOutput) ??
        heuristicSelfEvaluation(previousAgentOutput);
      if (selfEval) {
        lcr.last_round_result = makeLoopRoundResult({
          round: this.currentRound - 1,
          success: selfEval.success,
          output_summary: selfEval.output_summary,
          constraint_violations: selfEval.constraint_violations,
          manual_fixes_needed: "",
          // P0–P2: Cognitive evolution
          discovered_constraints: selfEval.discovered_constraints ?? [],
          objective_refinement: selfEval.objective_refinement ?? "",
          emerged_subtasks: selfEval.emerged_subtasks ?? [],
          // P4: Execution evidence
          execution_evidence: selfEval.execution_evidence,
          // P5: Self-correction
          retracted_constraints: selfEval.retracted_constraints ?? [],
          revised_success_criteria: selfEval.revised_success_criteria ?? [],
          wrong_assumptions: selfEval.wrong_assumptions ?? [],
          // v1.10: Checkpoint
          compression_checkpoint: selfEval.compression_checkpoint ?? false,
          checkpoint_label: selfEval.checkpoint_label ?? "",
        });
      }
    }

    return lcr;
  }

  // ── Internal: heartbeat ──────────────────────────────────────────────

  private startHeartbeat(): void {
    if (this.config.heartbeatIntervalMs <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      this.heartbeatTick();
    }, this.config.heartbeatIntervalMs);

    // Allow the process to exit even if this timer is still running
    if (this.heartbeatTimer && typeof this.heartbeatTimer === "object") {
      (this.heartbeatTimer as NodeJS.Timeout).unref?.();
    }
  }

  private heartbeatTick(): void {
    if (this._status !== RuntimeStatus.RUNNING) return;
    if (this.roundStartTime === 0) return;

    try {
      const now = Date.now();
      const elapsed = now - this.roundStartTime;
      const sinceProgress = now - this.lastProgressTime;

      const hbInfo: HeartbeatInfo = {
        round: this.currentRound,
        elapsedMs: elapsed,
        sinceProgressMs: sinceProgress,
      };
      this.emit("heartbeat", hbInfo);
      this.config.onHeartbeat?.(hbInfo);

      // Interactive mode: only emit heartbeat, never timeout/stall
      if (this.config.interactive) return;

      // Approaching timeout warning (80%)
      if (elapsed > this.config.roundTimeoutMs * 0.8 && !this.timedOut) {
        const warning: HealthWarning = {
          type: "approaching_timeout",
          message:
            `Round ${this.currentRound} approaching timeout ` +
            `(${elapsed}ms / ${this.config.roundTimeoutMs}ms)`,
        };
        this.emit("health:warning", warning);
        this.config.onHealthWarning?.(warning);
      }

      // Timeout
      if (elapsed > this.config.roundTimeoutMs && !this.timedOut) {
        this.timedOut = true;
        if (this.activeCtx) {
          this.activeCtx.signal.aborted = true;
        }
        const timeoutInfo: TimeoutInfo = {
          round: this.currentRound,
          elapsedMs: elapsed,
        };
        this.emit("timeout", timeoutInfo);
        this.config.onTimeout?.(timeoutInfo);
      }

      // Stall — timeout + grace period elapsed, execute still hasn't returned
      if (
        this.activeCtx !== null &&
        elapsed > this.config.roundTimeoutMs + this.config.stallGraceMs
      ) {
        this._status = RuntimeStatus.STALLED;
        const stallMsg = `Round ${this.currentRound} stalled after ${elapsed}ms`;
        this.emit("stalled", {
          reason: "round_timeout",
          lastRound: this.currentRound,
          elapsedMs: elapsed,
          message: stallMsg,
        });
      }
    } catch {
      // heartbeatTick must never throw — silently ignore errors
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── Internal: signal handlers ────────────────────────────────────────

  private registerSignalHandlers(): void {
    this.sigintHandler = () => {
      this.stop();
    };
    this.sigtermHandler = () => {
      this.stop();
    };
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);
  }

  private unregisterSignalHandlers(): void {
    if (this.sigintHandler) {
      process.removeListener("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
    if (this.sigtermHandler) {
      process.removeListener("SIGTERM", this.sigtermHandler);
      this.sigtermHandler = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Convenience function — the 80% API
// ═══════════════════════════════════════════════════════════════════════════

/** Run a fully autonomous loop. Only `task` and `execute` are required.
 *  All other configuration has sensible defaults from `loop_policy.json`.
 *
 *  @example
 *  const result = await run({
 *    task: 'Audit ERC20 token for security vulnerabilities',
 *    execute: async (prompt) => await myAgent.call(prompt),
 *  });
 *  // result: { success, stopReason, roundsCompleted, successTrajectory }
 */
export async function run(rawConfig: RuntimeConfig): Promise<RunResult> {
  const runtime = new LoopRuntime(rawConfig);
  return runtime.start();
}
