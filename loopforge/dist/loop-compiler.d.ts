/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */
import { type CriterionStatus, type Lesson, type LoopCompileRequest, type LoopCompileResponse, type LoopHealth, type LoopObjective, type LoopRoundResult, type RollingSummary, type SubGoal, type TaskAlignment, type VerificationFlag } from "./protocol.js";
import type { PresentedStateSnapshot } from "./canonical-state.js";
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
/** v3.2: Read the previous round's persisted L1 presentation snapshot — the
 *  diff baseline for L1 collapse. Returns null when the previous round's
 *  lineage entry exists but lacks all three presented_* fields (old-format
 *  entries, L0/L2 compiles) — callers then render in full, which keeps
 *  existing fixtures and pre-v3.2 loops on the full-render path. */
export declare function readPresentedBaseline(loopId: string, round: number, context: Record<string, unknown> | null): PresentedStateSnapshot | null;
export declare function getPreviousRound(loopId: string, round: number, context: Record<string, unknown> | null): PreviousRound | null;
/** v3.2: Deterministic lessons learned — constraints violated repeatedly or
 *  verification checks failing repeatedly across rounds (full history, unlike
 *  the enforcement gate's R2 3-round window). Presentation only: the output
 *  never feeds enforcement decisions. */
export declare function deriveLessons(loopId: string, context: Record<string, unknown> | null, currentRound: number): Lesson[];
/** v3.2: Derive per-criterion status — the "goal → criteria → evidence"
 *  vertical view. Each objective criterion gets: met/remaining/unknown
 *  (from per-round success_criteria_met/remaining reports, ID-first
 *  matching), the round it was first reported met, and any sub-goals whose
 *  description matches it (Jaccard). Zero persistence — re-derived from the
 *  vault every compile. */
export declare function deriveCriterionStatuses(loopId: string, context: Record<string, unknown> | null, objective: LoopObjective | null, currentRound: number, subGoals: SubGoal[], lastRoundResult?: LoopRoundResult | null): CriterionStatus[];
/** v2.11: Match two criterion references for deduplication.
 *  If either is a criterion ID (cr-XXXXXXXX), uses exact ID comparison.
 *  Otherwise falls back to Jaccard similarity.
 *  v3.3: exported for the verification gate's windowed criteria-completion
 *  scan (R4/R5 exculpatory cross-check). */
export declare function criteriaMatch(a: string, b: string): boolean;
export declare function buildRollingSummary(loopId: string, currentRound: number, context: Record<string, unknown> | null, sinceRound?: number, level?: string): RollingSummary | null;
/** Derive a stable sub-goal ID from its description hash.
 *  Exported as the single source of truth (verification-gate imports it). */
export declare function deriveSubGoalId(description: string): string;
/** v2.11: Derive a stable constraint ID from its text hash (c-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
export declare function deriveConstraintId(text: string): string;
/** v2.11: Derive a stable criterion ID from its text hash (cr-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
export declare function deriveCriterionId(text: string): string;
/** v2.11: Check whether a user-provided reference looks like a constraint ID.
 *  Matches the pattern c-XXXXXXXX where X is a hex digit. */
export declare function isConstraintId(ref: string): boolean;
/** v2.11: Check whether a user-provided reference looks like a criterion ID.
 *  Matches the pattern cr-XXXXXXXX where X is a hex digit. */
export declare function isCriterionId(ref: string): boolean;
export declare function alignTask(proposedTask: string, request: LoopCompileRequest, context: Record<string, unknown> | null): TaskAlignment;
export declare function checkLoopHealth(loopId: string, request: LoopCompileRequest, context: Record<string, unknown> | null): LoopHealth;
export declare function decideLevel(request: LoopCompileRequest, context: Record<string, unknown> | null): "l0" | "l1" | "l2";
export declare function buildSelfEvalBlock(round: number, prevDriftFlags?: VerificationFlag[], 
/** v2.12: L0 is the minimal retry template — the v2.12 declarative fields
 *  (outcome/blocker/retroactiveClaims) are L1/L2 additions so the retry
 *  prompt stays within its tight budget. */
level?: "l0" | "l1" | "l2", 
/** v3.3/v3.4: Whether this round's Current Task IS the ACTIVE Round
 *  Contract (derived from committed rounds — compileLoop passes
 *  `activeContract != null`). Only then does the template ask the agent
 *  to restate/propose it — a generic empty contract template would invite
 *  placeholder submissions that trigger round_underspecified noise. */
hasContract?: boolean, 
/** v3.5: L2-only prose suggesting a Round Contract declaration when the
 *  Current Task is NOT one (contract_nudge_on_l2 policy, computed at the
 *  compileLoop call site). Mutually exclusive with hasContract. The prose
 *  must never contain the JSON key name `round_contract` — contract-less
 *  L2 tests assert its lowercase absence. */
proposalNudge?: boolean): string;
export declare function compileLoop(request: LoopCompileRequest, context: Record<string, unknown> | null): LoopCompileResponse;
//# sourceMappingURL=loop-compiler.d.ts.map