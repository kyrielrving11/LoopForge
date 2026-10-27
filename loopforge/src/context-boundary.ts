/** v4.0.2: derive the ONE context boundary of a prompt delivery.
 *
 *  The boundary is a fact about how the host should start the Agent
 *  invocation, not an instruction the Agent submits. The compiler derives it
 *  once from compile inputs and committed facts and writes it into the
 *  PromptArtifact; every prompt-bearing MCP response projects it from that
 *  artifact instead of re-deriving it.
 *
 *  This module is pure: no I/O, no policy, no randomness.
 */

import type {
  PromptContextMode,
  PromptContextReason,
} from "./protocol.js";

export interface ContextBoundaryInput {
  /** The logical round being compiled. */
  round: number;
  /** One-based attempt within the same logical round. */
  attempt: number;
  /** The final prompt density selected for this delivery. */
  level: "l0" | "l1" | "l2";
  /** A committed rollback directive controls this round's redo. */
  recoveryBoundary: boolean;
  /** A committed evaluation round exists before this one. */
  hasPreviousCommittedRound: boolean;
}

export interface PromptContextBoundary {
  mode: PromptContextMode;
  reason: PromptContextReason;
}

/** Fixed priority:
 *  1. attempt > 1, L0        → same_round_retry / enforcement_retry
 *  2. attempt > 1, L1/L2     → fresh_round / enforcement_retry
 *  3. recovery boundary      → fresh_round / recovery_redo
 *  4. round 1, no prior      → fresh_round / first_round
 *  5. otherwise              → fresh_round / next_round
 */
export function derivePromptContextBoundary(
  input: ContextBoundaryInput,
): PromptContextBoundary {
  const attempt = Number.isFinite(input.attempt)
    ? Math.max(1, Math.trunc(input.attempt))
    : 1;
  if (attempt > 1) {
    return {
      mode: input.level === "l0" ? "same_round_retry" : "fresh_round",
      reason: "enforcement_retry",
    };
  }
  if (input.recoveryBoundary) {
    return { mode: "fresh_round", reason: "recovery_redo" };
  }
  if (input.round === 1 && !input.hasPreviousCommittedRound) {
    return { mode: "fresh_round", reason: "first_round" };
  }
  return { mode: "fresh_round", reason: "next_round" };
}
