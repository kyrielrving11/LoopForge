/** LoopForge — Autonomous loop driver (v1.1).
 *
 *  Closes the feedback loop: compile → agent executes → extract self-eval →
 *  auto-feedback → compile next → ... until task complete or circuit breaker.
 *
 *  Zero API dependencies — LoopForge does NOT call AI APIs. The caller
 *  provides an execute callback or feeds agent output round by round.
 */
import { type LoopHealth, type SelfEvaluation } from "./protocol.js";
import { LoopForgeEngine } from "./engine.js";
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
export type StopReason = "task_complete" | "circuit_breaker" | "max_rounds" | "stalled" | "extraction_failed";
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
export declare function runOneRound(engine: LoopForgeEngine, config: AutonomousConfig, currentRound: number, agentOutput: string | null): RunOneRoundResult;
/** Execute callback: takes a compiled prompt, returns the agent's output. */
export type AgentExecutor = (prompt: string, round: number) => Promise<string>;
/** Run a fully autonomous loop from start to finish.
 *
 *  The `execute` callback is called with each compiled prompt.
 *  LoopForge does NOT call any AI API — the caller provides execution.
 *
 *  Stops when: task complete, circuit breaker triggered, max rounds
 *  reached, or self-eval extraction fails. */
export declare function runAutonomousLoop(engine: LoopForgeEngine, config: AutonomousConfig, execute: AgentExecutor): Promise<AutonomousResult>;
//# sourceMappingURL=autonomous.d.ts.map