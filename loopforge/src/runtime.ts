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
import {
  Mode,
  RuntimeStatus,
  makeLoopCompileRequest,
  makeLoopRoundResult,
  makeSelfEvaluation,
  makeTaskId,
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
  type ExternalContextProvider,
  type LoopTerminalSink,
  type LoopForgeRequest,
} from "./protocol.js";
import { getPolicy } from "./policy.js";
import {
  prepareRoundTransaction,
  type RoundTransactionSnapshot,
} from "./round-transaction.js";
import { RoundDriver } from "./round-driver.js";
import type { VerificationFlag } from "./protocol.js";
import { logEvent } from "./observability.js";
import { policyMetrics } from "./policy-metrics.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function resolveConfig(raw: RuntimeConfig): RequiredConfig {
  const policy = getPolicy();
  const rtPolicy = policy.runtime;
  const config: RequiredConfig = {
    task: raw.task,
    execute: raw.execute,
    loopId: raw.loopId || makeTaskId(raw.task),
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
    contextProvider: raw.contextProvider,
    terminalSinks: raw.terminalSinks ?? [],
  };

  // Auto-detect claude-mem if no explicit provider was given
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
  contextProvider?: ExternalContextProvider;
  terminalSinks: LoopTerminalSink[];
}

class RoundStalledError extends Error {
  constructor() {
    super("Round exceeded timeout and stall grace period");
    this.name = "RoundStalledError";
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LoopRuntime
// ═══════════════════════════════════════════════════════════════════════════

export class LoopRuntime extends EventEmitter {
  private config: RequiredConfig;
  private engine: LoopForgeEngine;
  private roundDriver: RoundDriver;
  private _status: RuntimeStatus = RuntimeStatus.IDLE;
  private currentRound = 1;
  private successTrajectory: boolean[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;

  // Verification gate state (v1.6 unified — was MCP-only, now also in runtime)
  private lastSelfEval: SelfEvaluation | null = null;
  private pendingVerificationFlags: VerificationFlag[] = [];

  // Enforcement gate state (v1.13)
  private consecutiveRejections = 0;
  /** Which enforcement check triggered the last rejection.
   *  Only same-check rejections accumulate; a different check resets the counter. */
  private lastRejectionCheck = "";
  private pendingRejectionNotice = "";
  private roundSnapshot: RoundTransactionSnapshot | null = null;

  // Pause/resume state (v1.18)
  private pauseTimestamp = 0;
  private pauseRequested = false;
  private driverPromise: Promise<RunResult> | null = null;

  // Explicit Agent-supplied context for the next compilation.
  private pendingExternalContext = "";

  // Shared mutable state between the main loop and the heartbeat tick
  private roundStartTime = 0;
  private lastProgressTime = 0;
  private activeCtx: RoundContext | null = null;
  private activeAbortController: AbortController | null = null;
  private timedOut = false;

  constructor(rawConfig: RuntimeConfig) {
    super();
    this.config = resolveConfig(rawConfig);
    this.engine = createEngine();
    this.roundDriver = new RoundDriver(this.engine);
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

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Start the loop. Returns when the loop terminates (task complete,
   *  circuit breaker, max rounds, stalled, paused, or manual stop).
   *  Can only be called from IDLE state. */
  async start(): Promise<RunResult> {
    if (this._status !== RuntimeStatus.IDLE) {
      throw new Error(`Cannot start: runtime is ${this._status}`);
    }
    this._status = RuntimeStatus.RUNNING;
    this.registerSignalHandlers();
    this.startHeartbeat();
    this.emit("start");
    return this.launchDriver(false);
  }

  /** Start the one allowed loop driver and clear its ownership on exit. */
  private launchDriver(isResume: boolean): Promise<RunResult> {
    if (this.driverPromise) return this.driverPromise;
    const driver = this._continue(isResume);
    this.driverPromise = driver;
    void driver.then(
      () => {
        if (this.driverPromise === driver) this.driverPromise = null;
      },
      () => {
        if (this.driverPromise === driver) this.driverPromise = null;
      },
    );
    return driver;
  }

  /** Internal loop driver. Called by both start() (isResume=false) and
   *  resume() (isResume=true). When resuming, skips the currentRound=1
   *  reset — the loop picks up exactly where it left off. */
  private async _continue(isResume: boolean): Promise<RunResult> {
    let stopReason: StopReason = "max_rounds";
    let previousAgentOutput: string | null = null;
    let consecutiveErrors = 0;

    try {
      // When starting fresh (not resuming), reset to round 1
      if (!isResume) {
        this.currentRound = 1;
      }

      for (
        ;
        this.currentRound <= this.config.maxRounds;
        this.currentRound++
      ) {
        if (this.pauseRequested) {
          this.pauseRequested = false;
          this._status = RuntimeStatus.PAUSED;
          stopReason = "paused";
          break;
        }
        if (this._status !== RuntimeStatus.RUNNING) {
          if (this._status === RuntimeStatus.PAUSED) {
            stopReason = "paused";
          } else if (this._status === RuntimeStatus.STALLED) {
            stopReason = "stalled";
          } else {
            stopReason = "cancelled";
          }
          break;
        }

      // ── Explicit external context ─────────────────────────────────
      this.pendingExternalContext = "";
      if (this.config.contextProvider) {
        try {
          this.pendingExternalContext = (await this.config.contextProvider({
            loopId: this.config.loopId,
            round: this.currentRound,
            task: this.config.task,
            domain: this.config.domain,
            lastEvaluation: this.lastSelfEval ?? undefined,
          })).trim();
        } catch {
          // Provider failures are isolated from loop execution.
          this.pendingExternalContext = "";
          logEvent("context_provider_error", {
            loopId: this.config.loopId,
            round: this.currentRound,
          });
        }
      }

      // ── Compile ──────────────────────────────────────────────────
      let prompt: string;
      let level: string;
      if (this.pendingRejectionNotice) {
        if (!this.roundSnapshot || this.roundSnapshot.phase !== "rejected") {
          stopReason = "stalled";
          break;
        }
        const retryRequest = this.buildEngineCompileRequest(null);
        const prepared = await this.roundDriver.prepareRetry(
          retryRequest,
          this.roundSnapshot,
          this.pendingRejectionNotice,
          this.consecutiveRejections,
        );
        if (!prepared) {
          stopReason = "stalled";
          break;
        }
        prompt = prepared.prompt;
        level = prepared.level;
        this.roundSnapshot = prepared.snapshot;
      } else {
        const compileRequest = this.buildEngineCompileRequest(previousAgentOutput);
        const prepared = await this.roundDriver.prepare(
          compileRequest,
          this.config.loopId,
          this.currentRound,
        );

        if (!prepared) {
          stopReason = "stalled";
          break;
        }

        prompt = prepared.prompt;
        level = prepared.level;
        this.roundSnapshot = prepared.snapshot;
      }

      // ── Emit round:start ──────────────────────────────────────────
      if (!this.roundSnapshot) {
        this.roundSnapshot = prepareRoundTransaction(
          this.config.loopId,
          this.currentRound,
          [],
        );
      }
      const roundId = this.roundSnapshot.roundId;
      policyMetrics.recordStrategy(this.config.loopId, level);

      const startInfo: RoundStartInfo = {
        round: this.currentRound,
        roundId,
        level,
        prompt,
      };
      this.emit("round:start", startInfo);
      this.config.onRoundStart?.(startInfo);

      // ── Execute ───────────────────────────────────────────────────
      this.roundStartTime = Date.now();
      this.lastProgressTime = this.roundStartTime;
      this.timedOut = false;

      const abortController = new AbortController();
      const ctx: RoundContext = {
        round: this.currentRound,
        roundId,
        signal: abortController.signal,
        reportProgress: (message: string) => {
          this.lastProgressTime = Date.now();
          void message; // consumed by heartbeat via lastProgressTime
        },
      };
      this.activeCtx = ctx;
      this.activeAbortController = abortController;

      let agentOutput: string;
      try {
        agentOutput = await this.executeWithDeadline(prompt, ctx);
        consecutiveErrors = 0;
      } catch (err) {
        // Calls from timers/signal handlers can mutate status while this await
        // is pending; TypeScript's control-flow narrowing cannot observe that.
        const statusAfterExecution = this._status as RuntimeStatus;
        // A cooperative executor may reject as soon as its AbortSignal fires,
        // winning the race against RoundStalledError.  The runtime's state is
        // authoritative in that case: timeout/stall is not an executor fault.
        if (
          err instanceof RoundStalledError ||
          this.timedOut ||
          statusAfterExecution === RuntimeStatus.STALLED
        ) {
          this.activeCtx = null;
          this.activeAbortController = null;
          stopReason = "stalled";
          break;
        }
        if (statusAfterExecution === RuntimeStatus.STOPPED) {
          this.activeCtx = null;
          this.activeAbortController = null;
          stopReason = "cancelled";
          break;
        }
        consecutiveErrors++;
        const dur = Date.now() - this.roundStartTime;
        this.activeCtx = null;
        this.activeAbortController = null;

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
        // Build a synthetic self-eval so the next round's compilation
        // sees the failure context (forces L1/L2). A null previousAgentOutput
        // would hide the crash from the compiler entirely.
        previousAgentOutput = `---loopforge-eval\n${JSON.stringify(errInfo.selfEval)}\n---end-loopforge-eval`;
        continue;
      }

      const durationMs = Date.now() - this.roundStartTime;
      this.activeCtx = null;
      this.activeAbortController = null;

      // ── Extract self-eval ─────────────────────────────────────────
      let selfEval: SelfEvaluation | null = extractSelfEvaluation(agentOutput);
      let extractionSucceeded = selfEval !== null;

      if (selfEval === null) {
        selfEval = heuristicSelfEvaluation(agentOutput);
        extractionSucceeded = false;
      }

      // ── Unified round transaction: evaluate → verify → commit/reject ──
      this.pendingVerificationFlags = [];
      let roundSuccess = selfEval?.success ?? false;
      if (selfEval !== null) {
        const completed = await this.roundDriver.complete({
          snapshot: this.roundSnapshot,
          loopId: this.config.loopId,
          task: this.config.task,
          maxRounds: this.config.maxRounds,
          selfEval,
          extractionSucceeded,
          lastSelfEval: this.lastSelfEval ?? undefined,
          consecutiveRejections: this.consecutiveRejections,
          successTrajectory: this.successTrajectory,
        });
        const outcome = completed.outcome;
        this.roundSnapshot = outcome.snapshot;
        const pr = outcome.result;
        policyMetrics.recordStrategyOutcome(
          this.config.loopId,
          level,
          pr,
          outcome.replayed,
        );

        this.pendingVerificationFlags = pr.verificationFlags;
        roundSuccess = pr.roundSuccess;
        // Track per-rule rejections: only same-check rejections
        // accumulate. A different rejection reason resets the counter.
        if (pr.action === "reject" && pr.rejectionCheck) {
          this.consecutiveRejections =
            pr.rejectionCheck === this.lastRejectionCheck
              ? pr.newConsecutiveRejections
              : 1;
          this.lastRejectionCheck = pr.rejectionCheck;
        } else {
          this.consecutiveRejections = pr.newConsecutiveRejections;
          if (pr.action !== "reject") this.lastRejectionCheck = "";
        }
        if (pr.newLastSelfEval) this.lastSelfEval = pr.newLastSelfEval;
        if (pr.shouldPushSuccessTrajectory) this.successTrajectory.push(roundSuccess);

        if (pr.action === "reject") {
          this.pendingRejectionNotice = pr.rejectionPrompt ?? "";
          this.currentRound--;
          continue;
        }
        // The retry was accepted. Future rounds must return to normal compile.
        this.pendingRejectionNotice = "";
        if (pr.action === "terminate") {
          stopReason = (pr.stopReason ?? "enforcement_terminated") as StopReason;
          break;
        }
        if (pr.action === "stop") {
          stopReason = (pr.stopReason ?? "stalled") as StopReason;
          break;
        }
      } else {
        // Null selfEval: extraction completely failed
        stopReason = "stalled";
        break;
      }

      // ── Emit round:complete ───────────────────────────────────────
      const completeInfo: RoundCompleteInfo = {
        round: this.currentRound,
        roundId,
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
      });

      // ── Post-round state ──────────────────────────────────────────
      if (this.timedOut) {
        // Next round will be forced L2 via the compile request
        this.timedOut = false;
      }

      previousAgentOutput = agentOutput;
    }
    } finally {
      // ── Cleanup — always runs even if the loop body throws ──────────
      // Only fully stop if we're not paused (paused loops stay alive)
      if (this._status !== RuntimeStatus.PAUSED) {
        this.stopHeartbeat();
        this.unregisterSignalHandlers();
        if (this._status === RuntimeStatus.RUNNING) {
          this._status = RuntimeStatus.STOPPED;
        }
      }
    }

    const result: RunResult = {
      success: stopReason === "completed",
      stopReason,
      roundsCompleted: this.currentRound > this.config.maxRounds
        ? this.config.maxRounds
        : this.currentRound,
      successTrajectory: [...this.successTrajectory],
    };

    // ── v1.7: Memory Writeback ───────────────────────────────────────
    // Skip writeback for paused loops — they may be resumed later
    if (stopReason !== "paused" && this.config.terminalSinks.length > 0) {
      const event = {
        ...result,
        loopId: this.config.loopId,
        task: this.config.task,
        lastEvaluation: this.lastSelfEval ?? undefined,
      };
      await Promise.allSettled(
        this.config.terminalSinks.map((sink) => Promise.resolve(sink(event))),
      );
    }

    this.emit("done", result);
    return result;
  }

  /** Execute one round with a hard driver deadline. The AbortSignal lets a
   *  cooperative executor stop early; the race guarantees the runtime itself
   *  still resolves when an executor ignores cancellation. */
  private async executeWithDeadline(
    prompt: string,
    ctx: RoundContext,
  ): Promise<string> {
    if (this.config.interactive) {
      return this.config.execute(prompt, ctx);
    }

    const deadlineMs = this.config.roundTimeoutMs + this.config.stallGraceMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const elapsed = Date.now() - this.roundStartTime;
        this.triggerTimeout(elapsed);
        this.triggerStall(elapsed);
        reject(new RoundStalledError());
      }, deadlineMs);
    });

    try {
      return await Promise.race([this.config.execute(prompt, ctx), deadline]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private triggerTimeout(elapsed: number): void {
    if (this.timedOut) return;
    this.timedOut = true;
    this.activeAbortController?.abort();
    const timeoutInfo: TimeoutInfo = {
      round: this.currentRound,
      elapsedMs: elapsed,
    };
    this.emit("timeout", timeoutInfo);
    this.config.onTimeout?.(timeoutInfo);
  }

  private triggerStall(elapsed: number): void {
    if (this._status === RuntimeStatus.STALLED) return;
    this._status = RuntimeStatus.STALLED;
    const stallMsg = `Round ${this.currentRound} stalled after ${elapsed}ms`;
    this.emit("stalled", {
      reason: "round_timeout",
      lastRound: this.currentRound,
      elapsedMs: elapsed,
      message: stallMsg,
    });
  }

  /** Stop the loop gracefully. Safe to call from any thread/timer. */
  stop(): void {
    if (
      this._status === RuntimeStatus.RUNNING ||
      this._status === RuntimeStatus.PAUSED
    ) {
      const driverActive = this.driverPromise !== null;
      this.pauseRequested = false;
      this.activeAbortController?.abort();
      this._status = RuntimeStatus.STOPPED;
      this.emit("stop");
      if (!driverActive) {
        this.stopHeartbeat();
        this.unregisterSignalHandlers();
      }
    }
  }

  /** Pause the loop gracefully. Completes the current round, then suspends.
   *  Safe to call from signal handlers or callbacks.
   *  Only has effect when the loop is RUNNING. */
  pause(): void {
    if (this._status === RuntimeStatus.RUNNING && !this.pauseRequested) {
      this.pauseRequested = true;
      this.pauseTimestamp = Date.now();
      this.emit("pause");
    }
  }

  /** Resume a paused loop. Re-enters the main loop from currentRound.
   *  The loop continues exactly where it was suspended. */
  async resume(): Promise<RunResult> {
    // A resume requested before the current round reaches its pause boundary
    // cancels that pending pause and reuses the existing driver.
    if (this._status === RuntimeStatus.RUNNING && this.pauseRequested) {
      this.pauseRequested = false;
      this.pauseTimestamp = 0;
      this.emit("resume");
      if (!this.driverPromise) {
        throw new Error("Cannot resume: active runtime has no driver");
      }
      return this.driverPromise;
    }
    if (this._status !== RuntimeStatus.PAUSED) {
      throw new Error(`Cannot resume: runtime is ${this._status}`);
    }
    this._status = RuntimeStatus.RUNNING;
    this.pauseTimestamp = 0;
    this.emit("resume");
    return this.launchDriver(true);
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
          // v1.16: Agent's declared next action
          next_action: selfEval.next_action,
        });
      }
    }

    return lcr;
  }

  /** Adapt the typed compiler request to the engine envelope once for both
   * normal rounds and enforcement retry attempts. */
  private buildEngineCompileRequest(
    previousAgentOutput: string | null,
  ): LoopForgeRequest {
    const lcr = this.buildCompileRequest(previousAgentOutput);
    return {
      task: this.config.task,
      mode: Mode.LOOP_COMPILE,
      feedback: null,
      skill_name: null,
      task_id: null,
      loop_id: lcr.loop_id,
      round: lcr.round,
      goal_id: lcr.goal_id,
      domain: lcr.domain,
      plan_source: lcr.plan_source,
      constraints_from_plan: lcr.constraints_from_plan,
      health_check_interval: lcr.health_check_interval,
      last_round_result: lcr.last_round_result ?? undefined,
      verification_flags: this.pendingVerificationFlags,
      external_context: this.pendingExternalContext || undefined,
      max_rounds: this.config.maxRounds,
    };
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
        this.triggerTimeout(elapsed);
      }

      // Stall — timeout + grace period elapsed, execute still hasn't returned
      if (
        this.activeCtx !== null &&
        elapsed > this.config.roundTimeoutMs + this.config.stallGraceMs
      ) {
        this.triggerStall(elapsed);
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
      const policy = getPolicy();
      const doubleTapMs = policy.runtime.pause_double_tap_ms;
      const now = Date.now();
      const withinDoubleTapWindow =
        doubleTapMs > 0 &&
        this.pauseTimestamp > 0 &&
        now - this.pauseTimestamp <= doubleTapMs;

      // First SIGINT requests a boundary pause. A second signal stops only
      // inside the configured window; after it expires, it starts a new window.
      if (
        (this.pauseRequested || this._status === RuntimeStatus.PAUSED) &&
        withinDoubleTapWindow
      ) {
        this.stop();
      } else if (doubleTapMs > 0 && this._status === RuntimeStatus.RUNNING) {
        this.pause();
      } else if (doubleTapMs > 0 && this._status === RuntimeStatus.PAUSED) {
        this.pauseTimestamp = now;
      } else {
        this.stop();
      }
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
