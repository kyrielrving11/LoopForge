/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */
import { type CriterionStatus, type RecurringFlag, type LoopCompileRequest, type LoopCompileResponse, type LoopObjective, type LoopRoundResult, type RollingSummary, type SubGoal } from "./protocol.js";
import { type CommittedRoundView } from "./committed-round.js";
import { type ActiveContractView } from "./round-contract.js";
import type { ContractItemStatusView } from "./contract-items.js";
export interface PreviousRound {
    round: number;
    goal_id: string;
    goal_text_hash: string;
    success: boolean;
    task: string;
    constraints_active: string[];
    output_summary: string;
}
export declare function computeGoalTextHash(text: string): string;
export declare function deriveGoalId(loopId: string, task: string, explicit?: string): string;
export declare function getPreviousRound(loopId: string, round: number, context: Record<string, unknown> | null): PreviousRound | null;
/** v3.8.1: THE recurring-fact derivation — one walk over the committed
 *  history, grouping repeated machine facts by what they are ABOUT.
 *
 *  This replaces three separate answers to "what keeps going wrong":
 *  `deriveLessons` (whole history, count >= 2, keyed by constraint text or
 *  check id), `rolling_summary.recurring_issues` (the last 5 rounds' raw
 *  violation texts, with NO threshold at all despite the name), and the L1/L2
 *  sections built on top of each. Three windows over one fact set is exactly
 *  the parallel semantics this release removes.
 *
 *  Callers FILTER this list rather than re-deriving: the state file renders
 *  the genuinely recurring set (count >= 2), the prompt renders the recent
 *  tail as Active Warnings.
 *
 *  Presentation only: the result never feeds enforcement. */
export declare function deriveRecurringFlags(committedRounds: ReadonlyArray<CommittedRoundView>): RecurringFlag[];
/** v3.2: Derive per-criterion status — the "goal → criteria → evidence"
 *  vertical view. Each objective criterion gets: met/remaining/unknown
 *  (from per-round criterion_claims, ID-first or normalized-exact matching),
 *  the round it was first reported met, and the sub-goals a contract item
 *  referencing it also names (explicit `subgoal_refs`, never a text guess).
 *  Zero persistence — re-derived from the vault every compile. */
export declare function deriveCriterionStatuses(loopId: string, context: Record<string, unknown> | null, objective: LoopObjective | null, currentRound: number, subGoals: SubGoal[], lastRoundResult?: LoopRoundResult | null,
/** v3.8: the ACTIVE contract and its derived item statuses. A criterion is
 *  `verified` / `contradicted` / `insufficient` only through an item that
 *  references it — a claim alone can never reach `verified`. */
verification?: {
    activeContract: ActiveContractView | null;
    itemStatuses: ContractItemStatusView;
}): CriterionStatus[];
/** Match two criterion references. If either is a criterion id
 *  (cr-XXXXXXXX), compares ids; otherwise requires the two texts to be
 *  EXACTLY equal after normalization (v3.8.1 — the similarity fallback is
 *  gone, so a paraphrase is a different criterion). */
export declare function criteriaMatch(a: string, b: string): boolean;
export declare function buildRollingSummary(loopId: string, currentRound: number, context: Record<string, unknown> | null, sinceRound?: number, level?: string): RollingSummary | null;
/** v2.11: Derive a stable constraint ID from its text hash (c-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
export declare function deriveConstraintId(text: string): string;
/** v2.11: Derive a stable criterion ID from its text hash (cr-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
export declare function deriveCriterionId(text: string): string;
export declare function decideLevel(request: LoopCompileRequest, context: Record<string, unknown> | null): "l0" | "l1" | "l2";
export declare function buildSelfEvalBlock(round: number,
/** v2.12: L0 is the minimal retry template — the v2.12 declarative fields
 *  (outcome/blocker/retroactiveClaims) are L1/L2 additions so the retry
 *  prompt stays within its tight budget. */
level?: "l0" | "l1" | "l2",
/** v3.3/v3.4: Whether this round's Current Task IS the ACTIVE Round
 *  Contract (derived from committed rounds — compileLoop passes
 *  `activeContract != null`). Only then does the template ask the agent
 *  to restate/propose it — a generic empty contract template would invite
 *  placeholder submissions that trigger round_underspecified noise. */
hasContract?: boolean): string;
export declare function compileLoop(request: LoopCompileRequest, context: Record<string, unknown> | null): LoopCompileResponse;
//# sourceMappingURL=loop-compiler.d.ts.map