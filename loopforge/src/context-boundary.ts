/** v4.0.2 / v4.0.4: derive the ONE context boundary of a prompt delivery.
 *
 *  The boundary is a fact about how the host should start the Agent
 *  invocation, not an instruction the Agent submits. The compiler derives it
 *  once from compile inputs and committed facts and writes it into the
 *  PromptArtifact; every prompt-bearing MCP response projects it from that
 *  artifact instead of re-deriving it.
 *
 *  Strategy (see `round-guidance.ts` for the prose):
 *  - `fresh_invocation` = clean context. It may be the SAME logical round (L2
 *    rehydrate retry, library-level L1 defensive branch) or the next logical
 *    round. It never resets the workspace.
 *  - `same_round_retry` = in-context repair. Only the FIRST L0 enforcement
 *    retry keeps the original invocation.
 *  - L2 always uses a clean context, whatever triggered it.
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
 *  2. attempt > 1, L1/L2     → fresh_invocation / enforcement_retry
 *  3. recovery boundary      → fresh_invocation / recovery_redo
 *  4. round 1, no prior      → fresh_invocation / first_round
 *  5. otherwise              → fresh_invocation / next_round
 *
 *  Priority 2 is the library-level defensive branch: the current compiler
 *  policy maps `attempt > 1` to L0, so an L1/L2 retry is not reachable through
 *  the normal ladder. It is still clean context when a direct caller forces
 *  that level.
 *
 *  A retried recovery redo keeps `enforcement_retry` here (attempt wins the
 *  priority) while the prompt still renders the Recovery Brief; the display
 *  label carries the recovery-lesson fact explicitly.
 */
export function derivePromptContextBoundary(
  input: ContextBoundaryInput,
): PromptContextBoundary {
  const attempt = Number.isFinite(input.attempt)
    ? Math.max(1, Math.trunc(input.attempt))
    : 1;
  if (attempt > 1) {
    return {
      mode: input.level === "l0" ? "same_round_retry" : "fresh_invocation",
      reason: "enforcement_retry",
    };
  }
  if (input.recoveryBoundary) {
    return { mode: "fresh_invocation", reason: "recovery_redo" };
  }
  if (input.round === 1 && !input.hasPreviousCommittedRound) {
    return { mode: "fresh_invocation", reason: "first_round" };
  }
  return { mode: "fresh_invocation", reason: "next_round" };
}

export interface PromptContextPairInput {
  level: "l0" | "l1" | "l2";
  mode: PromptContextMode;
  reason: PromptContextReason;
  attempt: number;
  round: number;
}

/** The ONE legality guard for a (level, contextMode, contextReason, attempt,
 *  round) tuple. Shared by the prompt assembler and the transaction decoder so
 *  an illegal pair can neither be produced nor read back.
 *
 *  Rules (codifying I11/I12):
 *  - L2 is always a clean context; L2 + same_round_retry is illegal.
 *  - same_round_retry is legal only at L0, attempt > 1, enforcement_retry.
 *  - fresh_invocation + enforcement_retry requires attempt > 1.
 *  - fresh_invocation + first_round requires round 1.
 *
 *  Returns a stable diagnostic, or null when the tuple is legal. Callers fail
 *  closed; nothing is silently corrected. */
export function promptContextPairIssue(
  input: PromptContextPairInput,
): string | null {
  const attempt = Number.isFinite(input.attempt)
    ? Math.max(1, Math.trunc(input.attempt))
    : 1;
  if (input.mode === "same_round_retry") {
    if (input.level !== "l0") {
      return `same_round_retry requires level l0, got ${input.level}`;
    }
    if (attempt <= 1) {
      return "same_round_retry requires attempt > 1";
    }
    if (input.reason !== "enforcement_retry") {
      return `same_round_retry requires reason enforcement_retry, got ${input.reason}`;
    }
    return null;
  }
  if (input.reason === "enforcement_retry" && attempt <= 1) {
    return "fresh_invocation + enforcement_retry requires attempt > 1";
  }
  if (input.reason === "first_round" && input.round !== 1) {
    return `fresh_invocation + first_round requires round 1, got ${input.round}`;
  }
  return null;
}
