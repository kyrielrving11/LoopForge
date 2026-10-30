/** v3.9.7: the ONE round-outcome predicates.
 *
 *  Kept in a neutral module so contract closure, the contract walker, the
 *  verification gate, the coordinator and the gate record all share the same
 *  blocked definition without an import cycle through self-eval.
 */

import type { RoundOutcome, SelfEvaluation } from "./protocol.js";

/** v2.12: The effective round outcome — declared outcome wins, otherwise
 *  derived from `success`. "partial" can only be declared explicitly. */
export function effectiveOutcome(selfEval: SelfEvaluation): RoundOutcome {
  if (selfEval.outcome === "success" || selfEval.outcome === "partial" ||
      selfEval.outcome === "failed" || selfEval.outcome === "blocked") {
    return selfEval.outcome;
  }
  return selfEval.success ? "success" : "failed";
}

/** v2.12: Whether the effective outcome is a success claim. */
export function effectiveSuccess(selfEval: SelfEvaluation): boolean {
  return effectiveOutcome(selfEval) === "success";
}

/** v3.8.3/v3.9.7/v4.0.4: the ONE definition of "this round declares itself
 *  blocked". A declared `outcome: "blocked"` and an `agent_stop_reason` of
 *  `blocked` or `needs_human_input` say the same thing. `effectiveOutcome`
 *  alone is NOT this predicate: it reads `outcome` only. */
export function declaresBlocked(selfEval: SelfEvaluation): boolean {
  return selfEval.outcome === "blocked" ||
    selfEval.agent_stop_reason === "blocked" ||
    selfEval.agent_stop_reason === "needs_human_input";
}
