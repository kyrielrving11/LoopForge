/** v3.9.7: the ONE round-outcome predicates.
 *
 *  Kept in a neutral module so contract closure, the contract walker, the
 *  verification gate, the coordinator and the gate record all share the same
 *  blocked definition without an import cycle through self-eval.
 */
import type { RoundOutcome, SelfEvaluation } from "./protocol.js";
/** v2.12: The effective round outcome — declared outcome wins, otherwise
 *  derived from `success`. "partial" can only be declared explicitly. */
export declare function effectiveOutcome(selfEval: SelfEvaluation): RoundOutcome;
/** v2.12: Whether the effective outcome is a success claim. */
export declare function effectiveSuccess(selfEval: SelfEvaluation): boolean;
/** v3.8.3/v3.9.7: the ONE definition of "this round declares itself blocked".
 *  A declared `outcome: "blocked"` and a `stop_reason` of `blocked` or
 *  `needs_human_input` say the same thing. `effectiveOutcome` alone is NOT
 *  this predicate: it reads `outcome` only. */
export declare function declaresBlocked(selfEval: SelfEvaluation): boolean;
//# sourceMappingURL=round-outcome.d.ts.map