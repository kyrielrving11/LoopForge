/** Enforcement Gate — Layer 2 round-boundary runtime enforcement (v1.13).
 *
 * Pure-function module. Receives the verification gate's findings plus
 * round-level context and decides whether to accept the round, reject it
 * (force the agent to redo), or terminate the loop.
 *
 * This is the "runtime" that prompt-only constraint systems lack.
 * Verification gate detects WHAT is wrong; enforcement gate decides
 * what to DO about it.
 *
 * Decision semantics:
 * - accept:    round passes all checks; advance to next round as normal.
 * - reject:    agent's self-evaluation or round output is invalid; the
 *              agent receives a rejection prompt and must redo the SAME
 *              round. Round counter does NOT increment.
 * - terminate: loop has reached an unrecoverable state; stop immediately
 *              with stopReason "enforcement_terminated".
 */
import type { VaultEntry } from "./backends/interface.js";
import type { EnforcementResult, SelfEvaluation, VerificationResult } from "./protocol.js";
/** Enforce round-boundary rules based on the verification gate's findings
 *  and the agent's self-evaluation integrity.
 *
 *  Rules run in priority order (R1 → R5). The first rule that fires wins.
 *
 * @param selfEval              The agent's self-evaluation for the current round.
 * @param verifyResult          The verification gate's output (from verifySelfEvaluation).
 * @param currentRound          Current round number (1-based, BEFORE increment).
 * @param vaultEntries          Vault entries for this loop (used for progress tracking).
 * @param consecutiveRejections How many consecutive rounds have already been rejected.
 *                              Starts at 0; increments on each reject; resets on accept.
 */
export declare function enforceRound(selfEval: SelfEvaluation, verifyResult: VerificationResult, currentRound: number, vaultEntries: VaultEntry[], consecutiveRejections?: number): EnforcementResult;
/** Build a rejection prompt for the agent.
 *
 *  The prompt clearly states the round was rejected, why, what the agent
 *  must fix, and that the agent must redo the SAME round (not advance).
 *
 * @param currentRound  The round number that was rejected (NOT incremented).
 * @param task          The original loop task description.
 * @param enforceResult The enforcement decision with reason and fix instructions.
 */
export declare function buildRejectionPrompt(currentRound: number, task: string, enforceResult: EnforcementResult): string;
//# sourceMappingURL=enforcement-gate.d.ts.map