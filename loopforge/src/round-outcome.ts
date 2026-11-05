/** v3.9.7 / v4.0.6: the ONE round-outcome predicates.
 *
 *  Kept in a neutral module so contract closure, the contract walker, the
 *  verification gate, the coordinator and the gate record all share the same
 *  blocked definition without an import cycle through self-eval.
 *
 *  v4.0.6: `outcome` is the SOLE round conclusion — `success` and
 *  `agent_stop_reason` are gone, so these predicates read one field.
 */

import type { RoundOutcome, SelfEvaluation } from "./protocol.js";

/** v2.12 / v4.0.6: the round outcome. `outcome` is required on every
 *  evaluation; the defensive fallback only protects malformed library input
 *  and never invents success. */
export function effectiveOutcome(selfEval: SelfEvaluation): RoundOutcome {
  const outcome = selfEval.outcome;
  if (outcome === "success" || outcome === "partial" ||
      outcome === "failed" || outcome === "blocked") {
    return outcome;
  }
  return "failed";
}

/** v2.12 / v4.0.6: Whether the outcome is a success claim. */
export function effectiveSuccess(selfEval: SelfEvaluation): boolean {
  return effectiveOutcome(selfEval) === "success";
}

/** v3.8.3 / v4.0.6: the ONE definition of "this round declares itself
 *  blocked" — a declared `outcome: "blocked"`. `needs_human_input` is now
 *  expressed by the blocker text, not a separate field. */
export function declaresBlocked(selfEval: SelfEvaluation): boolean {
  return selfEval.outcome === "blocked";
}
