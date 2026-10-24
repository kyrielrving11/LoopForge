/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */
import { type CriterionStatus, type RecurringFlag, type LoopCompileRequest, type LoopCompileResponse, type LoopObjective, type LoopRoundResult, type OperatorAcceptance, type VerificationFlag } from "./protocol.js";
import { type CommittedRoundView } from "./committed-round.js";
import { type PromptFreshness } from "./prompt-freshness.js";
import type { CriterionMachineFact } from "./round-facts.js";
import { type SelfEvalPromptContext } from "./submission-guidance.js";
export interface PreviousRound {
    round: number;
    goal_id: string;
    success: boolean;
    task: string;
    constraints_active: string[];
    output_summary: string;
}
/** ONE bundle of previous-round facts for a compile.
 *
 *  Every consumer (level policy, canonical state, evaluation block) reads
 *  this bundle instead of re-reading the caller's mutable projection. It is
 *  derived exclusively from the committed view; the typed request contributes
 *  only this attempt's verification findings. */
export interface PreviousRoundFacts {
    view: CommittedRoundView | null;
    result: LoopRoundResult | null;
    verificationFlags: VerificationFlag[];
    freshness: PromptFreshness;
    /** A committed backtrack directive targets this compile round's redo. */
    recoveryBoundary: boolean;
}
export declare function computeGoalTextHash(text: string): string;
export declare function deriveGoalId(loopId: string, task: string, explicit?: string): string;
export declare function getPreviousRound(loopId: string, round: number, context: Record<string, unknown> | null): PreviousRound | null;
/** The operator objective from the immutable acceptance carried by a committed
 *  evaluation or rollback directive. Acceptance is byte-identical across
 *  copies (enforced by the history loader), so it does not need a round or
 *  branch window. */
export declare function latestObjective(loopId: string, context: Record<string, unknown> | null): LoopObjective | null;
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
 *  vertical view. Each objective criterion gets claimed/remaining/unknown
 *  (from per-round criterion_claims, ID-first or normalized-exact matching)
 *  and the round it was first reported met. Zero persistence — re-derived
 *  from committed rounds every compile.
 *
 *  v3.9.6: the derivation lives in `criterion-status.ts` so the submission
 *  boundary and guidance can read the same rows without importing this module
 *  (which would close the `loop-compiler → submission-guidance` cycle). */
export declare function deriveCriterionStatuses(loopId: string, context: Record<string, unknown> | null, objective: LoopObjective | null, currentRound: number, lastRoundResult?: LoopRoundResult | null,
/** v3.8.1: the criterion machine facts from the shared bundle. A criterion
 *  is `verified` / `contradicted` / `insufficient` only through an item that
 *  references it — a claim alone can never reach `verified` — and the fact
 *  is derived over the WHOLE committed history, so it survives its contract
 *  closing (see `deriveCriterionFacts`). */
criterionFacts?: ReadonlyArray<CriterionMachineFact>): CriterionStatus[];
/** v3.8: Rank item statuses so the strongest machine fact wins when several
 *  items reference the same criterion. */
/** Match two criterion references. If either is a criterion id
 *  (cr-XXXXXXXX), compares ids; otherwise requires the two texts to be
 *  EXACTLY equal after normalization (v3.8.1 — the similarity fallback is
 *  gone, so a paraphrase is a different criterion). */
export declare function criteriaMatch(a: string, b: string): boolean;
export { deriveConstraintId, deriveCriterionId, isCriterionId, } from "./token-utils.js";
export declare function decideLevel(request: LoopCompileRequest, context: Record<string, unknown> | null): "l0" | "l1" | "l2";
/** The prompt's evaluation block. All content (examples, contract/sub-goal
 *  guidance, flag-specific hints) comes from the one FIELD_GUIDES table in
 *  submission-guidance.ts; this function owns no second copy. */
export declare function buildSelfEvalBlock(ctx: SelfEvalPromptContext): string;
export declare function compileLoop(request: LoopCompileRequest, context: Record<string, unknown> | null, options?: {
    operatorAcceptance?: OperatorAcceptance;
}): LoopCompileResponse;
//# sourceMappingURL=loop-compiler.d.ts.map