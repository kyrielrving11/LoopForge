/** Derive the ONE context boundary of a prompt delivery.
 *
 *  The boundary is a fact about how the host should start the Agent
 *  invocation, not an instruction the Agent submits. The compiler derives it
 *  once from compile inputs and committed facts and writes it into the
 *  PromptArtifact; every prompt-bearing MCP response projects it from that
 *  artifact instead of re-deriving it.
 *
 *  Strategy (see `round-guidance.ts` for the prose):
 *  - `fresh_invocation` = clean context. It may be the SAME logical round
 *    (rejection escalation or a recovered retry) or the next logical round.
 *    It never resets the workspace.
 *  - `same_round_retry` = in-context repair while the rejection streak is
 *    below the escalation threshold.
 *  - A repeated same-check rejection explicitly escalates to a clean context;
 *    prompt density does not select the invocation boundary.
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
  /** Existing same-check rejection streak used by prompt and context policy. */
  consecutiveRejections: number;
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
 *  1. attempt > 1, rejection streak >= 2 → fresh_invocation / rejection_escalation
 *  2. attempt > 1, rejection streak < 2  → same_round_retry / enforcement_retry
 *  3. recovery boundary      → fresh_invocation / recovery_redo
 *  4. round 1, no prior      → fresh_invocation / first_round
 *  5. otherwise              → fresh_invocation / next_round
 *
 *  A retried recovery redo keeps its Recovery Brief. At the rejection
 *  escalation threshold, `rejection_escalation` identifies why the host must
 *  start a clean context; the rollback directive remains a separate fact.
 */
export function derivePromptContextBoundary(
  input: ContextBoundaryInput,
): PromptContextBoundary {
  const attempt = Number.isFinite(input.attempt)
    ? Math.max(1, Math.trunc(input.attempt))
    : 1;
  if (attempt > 1) {
    if (input.consecutiveRejections >= 2) {
      return { mode: "fresh_invocation", reason: "rejection_escalation" };
    }
    return { mode: "same_round_retry", reason: "enforcement_retry" };
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
 *  - same_round_retry is legal at any prompt level, only for attempt > 1 and
 *    reason enforcement_retry.
 *  - rejection_escalation is a clean context and requires attempt > 1.
 *  - enforcement_retry is only an in-context boundary; escalated retries use
 *    rejection_escalation with fresh_invocation.
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
    if (attempt <= 1) {
      return "same_round_retry requires attempt > 1";
    }
    if (input.reason !== "enforcement_retry") {
      return `same_round_retry requires reason enforcement_retry, got ${input.reason}`;
    }
    return null;
  }
  if (input.reason === "enforcement_retry") {
    return "enforcement_retry requires same_round_retry";
  }
  if (input.reason === "rejection_escalation" && attempt <= 1) {
    return "rejection_escalation requires attempt > 1";
  }
  if (input.reason === "first_round" && input.round !== 1) {
    return `fresh_invocation + first_round requires round 1, got ${input.round}`;
  }
  return null;
}
