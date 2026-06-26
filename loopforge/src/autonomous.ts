/** LoopForge — Autonomous loop driver (v1.1).
 *
 *  Closes the feedback loop: compile → agent executes → extract self-eval →
 *  auto-feedback → compile next → ... until task complete or circuit breaker.
 *
 *  Zero API dependencies — LoopForge does NOT call AI APIs. The caller
 *  provides an execute callback or feeds agent output round by round.
 */

import {
  makeLoopCompileRequest,
  makeLoopRoundResult,
  makeVaultConfig,
  type LoopCompileRequest,
  type LoopHealth,
  type SelfEvaluation,
} from "./protocol.js";
import {
  LoopForgeEngine,
  extractSelfEvaluation,
  heuristicSelfEvaluation,
  type EngineMetrics,
} from "./engine.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface AutonomousConfig {
  /** The task description — becomes the loop objective. */
  task: string;
  /** Kebab-case loop identifier. */
  loopId: string;
  /** Optional explicit goal ID. Derived from task if omitted. */
  goalId?: string;
  /** Maximum rounds before forced stop. Default 20. */
  maxRounds?: number;
  /** Health check interval (rounds). Default 3. */
  healthCheckInterval?: number;
  /** Optional path to a plan/spec file for constraint extraction. */
  planSource?: string;
  /** Constraints extracted from the plan (provided by caller). */
  constraintsFromPlan?: string[];
  /** Domain hint for technique routing. */
  domain?: string;
}

export interface RoundOutput {
  round: number;
  /** The compiled prompt — ready for agent execution. */
  prompt: string;
  /** L0 | L1 | L2 */
  recompileLevel: string;
  /** Selected prompting technique. */
  techniqueUsed: string;
  /** Cross-round health snapshot (null on round 1 if no prior data). */
  health: LoopHealth | null;
  /** Quality score from the PREVIOUS round (null on round 1). */
  lastQualityScore: number | null;
}

export type StopReason =
  | "task_complete"       // Agent reported should_continue = false
  | "circuit_breaker"     // Quality trend triggered circuit breaker
  | "max_rounds"          // Reached configured maximum
  | "stalled"             // Engine state is STALLED
  | "extraction_failed";  // Could not parse self-eval from agent output

export interface AutonomousResult {
  /** Total rounds completed. */
  roundsCompleted: number;
  /** Why the loop stopped. */
  stopReason: StopReason;
  /** Health snapshot at stop. */
  healthAtStop: LoopHealth | null;
  /** Quality trajectory [round1_score, round2_score, ...]. */
  qualityTrajectory: number[];
  /** Whether the loop achieved its objective. */
  success: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Single-round runner
// ═══════════════════════════════════════════════════════════════════════════

export interface RunOneRoundResult {
  /** If stopNow is true, the loop should terminate. */
  stopNow: boolean;
  stopReason: StopReason | null;
  /** The compiled prompt (null if stopping). */
  roundOutput: RoundOutput | null;
  /** Extracted self-evaluation (null on round 1 or if extraction failed). */
  selfEval: SelfEvaluation | null;
  /** Whether structured extraction succeeded. */
  extractionSucceeded: boolean;
}

/** Run one round of the autonomous loop.
 *
 *  Round 1 (agentOutput = null): compile the first prompt (L2 full build).
 *  Round N (agentOutput = string): extract self-eval, record auto-feedback,
 *    compile next prompt (L0/L1/L2 decided by the 4-gate router).
 *
 *  Returns stopNow = true when the loop should terminate. */
export function runOneRound(
  engine: LoopForgeEngine,
  config: AutonomousConfig,
  currentRound: number,
  agentOutput: string | null,
): RunOneRoundResult {
  const maxRounds = config.maxRounds ?? 20;
  const healthInterval = config.healthCheckInterval ?? 3;

  // ── Check max rounds before doing anything ──────────────────────────
  if (currentRound > maxRounds) {
    return {
      stopNow: true,
      stopReason: "max_rounds",
      roundOutput: null,
      selfEval: null,
      extractionSucceeded: false,
    };
  }

  // ── Round N (N > 1): Extract self-eval and record feedback ──────────
  let selfEval: SelfEvaluation | null = null;
  let extractionSucceeded = false;

  if (agentOutput !== null && currentRound > 1) {
    // Try structured extraction first
    selfEval = extractSelfEvaluation(agentOutput);
    extractionSucceeded = selfEval !== null;

    // Fallback to heuristic if structured extraction failed
    const usedHeuristic = selfEval === null;
    if (selfEval === null) {
      selfEval = heuristicSelfEvaluation(agentOutput);
    }

    // Record auto-feedback (even heuristic — best effort for vault audit trail)
    if (selfEval !== null) {
      engine.autoFeedback(
        selfEval,
        config.loopId,
        currentRound - 1, // feedback is for the PREVIOUS round
        config.task,
      );
    }

    // Stop if structured extraction failed — heuristic is too low-confidence
    // to continue the loop autonomously
    if (usedHeuristic) {
      return {
        stopNow: true,
        stopReason: "extraction_failed",
        roundOutput: null,
        selfEval,
        extractionSucceeded: false,
      };
    }

    // Check stop conditions from agent's self-eval (structured only)
    if (selfEval !== null && !selfEval.should_continue) {
      return {
        stopNow: true,
        stopReason: "task_complete",
        roundOutput: null,
        selfEval,
        extractionSucceeded,
      };
    }

    // Check circuit breaker after recording feedback
    if (engine.shouldBreak()) {
      return {
        stopNow: true,
        stopReason: "circuit_breaker",
        roundOutput: null,
        selfEval,
        extractionSucceeded,
      };
    }

    // Check if extraction failed entirely
    if (selfEval === null) {
      return {
        stopNow: true,
        stopReason: "extraction_failed",
        roundOutput: null,
        selfEval: null,
        extractionSucceeded: false,
      };
    }
  }

  // ── Compile the next prompt ────────────────────────────────────────
  const lcr = makeLoopCompileRequest({
    loop_id: config.loopId,
    round: currentRound,
    goal_id: config.goalId ?? "",
    task: config.task,
    domain: config.domain ?? "",
    plan_source: config.planSource ?? null,
    constraints_from_plan: config.constraintsFromPlan ?? [],
    health_check_interval: healthInterval,
    vault_config: makeVaultConfig(),
  });

  // Attach last round result if we have self-eval data
  if (selfEval !== null && currentRound > 1) {
    lcr.last_round_result = makeLoopRoundResult({
      round: currentRound - 1,
      success: selfEval.success,
      output_summary: selfEval.output_summary,
      constraint_violations: selfEval.constraint_violations,
      manual_fixes_needed: "",
      quality_score: 0, // Will be backfilled from vault
    });
  }

  const result = engine.invokeLoopCompile(
    {
      task: config.task,
      mode: "loop_compile" as never,
      vault_config: makeVaultConfig(),
      feedback: null,
      skill_name: null,
      task_id: null,
      loop_id: config.loopId,
      round: currentRound,
      goal_id: config.goalId ?? "",
      domain: config.domain ?? "",
      plan_source: config.planSource ?? null,
      constraints_from_plan: config.constraintsFromPlan ?? [],
      health_check_interval: healthInterval,
      last_round_result: lcr.last_round_result ?? undefined,
    } as never,
  );

  if (result.status === "error" || !result.response?.prompt) {
    return {
      stopNow: true,
      stopReason: "stalled",
      roundOutput: null,
      selfEval,
      extractionSucceeded,
    };
  }

  // Extract health from the response (it's embedded in the prompt text as markdown)
  // The health data is in the LoopCompileResponse, but we need to get it from the engine
  const context = engine.hydrateLoopContext(config.loopId);
  let health: LoopHealth | null = null;
  if (context) {
    const results = (context.results as Record<string, unknown>[]) ?? [];
    const latest = results[results.length - 1];
    if (latest) {
      const lineage = (latest.loop_lineage ?? {}) as Record<string, unknown>;
      // Health is computed per-round, not stored directly in lineage
      // We'll report null for simplicity — the prompt text contains health info
    }
  }

  // Determine last quality score
  let lastQuality = null;
  if (selfEval !== null) {
    const fb = selfEval;
    // Recompute using the same formula as scoreQuality
    if (fb.success && fb.constraint_violations.length === 0) lastQuality = 5;
    else if (fb.success && fb.constraint_violations.length === 0) lastQuality = 4;
    else if (fb.success) lastQuality = 3;
    else if (fb.constraint_violations.length > 0) lastQuality = 2;
    else lastQuality = 1;
  }

  return {
    stopNow: false,
    stopReason: null,
    roundOutput: {
      round: currentRound,
      prompt: result.response.prompt,
      recompileLevel: result.response.analysis?.rationale?.includes("l0")
        ? "l0"
        : result.response.analysis?.rationale?.includes("l1")
          ? "l1"
          : "l2",
      techniqueUsed: result.response.analysis?.technique ?? "unknown",
      health,
      lastQualityScore: lastQuality,
    },
    selfEval,
    extractionSucceeded,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Full autonomous loop runner
// ═══════════════════════════════════════════════════════════════════════════

/** Execute callback: takes a compiled prompt, returns the agent's output. */
export type AgentExecutor = (prompt: string, round: number) => Promise<string>;

/** Run a fully autonomous loop from start to finish.
 *
 *  The `execute` callback is called with each compiled prompt.
 *  LoopForge does NOT call any AI API — the caller provides execution.
 *
 *  Stops when: task complete, circuit breaker triggered, max rounds
 *  reached, or self-eval extraction fails. */
export async function runAutonomousLoop(
  engine: LoopForgeEngine,
  config: AutonomousConfig,
  execute: AgentExecutor,
): Promise<AutonomousResult> {
  const maxRounds = config.maxRounds ?? 20;
  const qualityTrajectory: number[] = [];
  let agentOutput: string | null = null;
  let finalStopReason: StopReason = "max_rounds";

  for (let round = 1; round <= maxRounds; round++) {
    const roundResult = runOneRound(engine, config, round, agentOutput);

    if (roundResult.stopNow) {
      finalStopReason = roundResult.stopReason ?? "stalled";
      break;
    }

    if (!roundResult.roundOutput) {
      finalStopReason = "stalled";
      break;
    }

    // Track quality
    if (roundResult.roundOutput.lastQualityScore !== null) {
      qualityTrajectory.push(roundResult.roundOutput.lastQualityScore);
    }

    // Execute the prompt
    try {
      agentOutput = await execute(
        roundResult.roundOutput.prompt,
        round,
      );
    } catch {
      finalStopReason = "stalled";
      break;
    }

    // If this was the last round and we didn't stop earlier
    if (round === maxRounds) {
      finalStopReason = "max_rounds";
    }
  }

  // Get final health snapshot
  let healthAtStop: LoopHealth | null = null;
  try {
    const context = engine.hydrateLoopContext(config.loopId);
    if (context) {
      const results = (context.results as Record<string, unknown>[]) ?? [];
      if (results.length > 0) {
        const latest = results[results.length - 1];
        const lineage = (latest.loop_lineage ?? {}) as Record<string, unknown>;
        // Health is in the lineage if it was stored
        healthAtStop = (lineage.loop_health as LoopHealth) ?? null;
      }
    }
  } catch {
    // Best effort
  }

  return {
    roundsCompleted: qualityTrajectory.length,
    stopReason: finalStopReason,
    healthAtStop,
    qualityTrajectory,
    success: finalStopReason === "task_complete",
  };
}
