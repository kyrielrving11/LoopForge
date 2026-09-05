/** Single-pass prompt renderer for canonical LoopForge state.
 *
 * L0/L1/L2 control state density only. Reasoning strategy belongs to the
 * external Agent. Mandatory task, hard-constraint, and verification sections
 * are never truncated; budgets are soft and overflow is recorded.
 */
import type { CanonicalLoopState, PresentedStateSnapshot } from "./canonical-state.js";
import type { PromptArtifact, PromptRequests } from "./protocol.js";
import type { ConstraintMeta, MilestoneSummary, SubGoal } from "./protocol.js";
import type { PromptLevel, PromptLevelReason } from "./prompt-policy.js";
export declare const PROMPT_ARTIFACT_SCHEMA_VERSION: 1;
export interface PromptBudgets {
    l0: number;
    l1: number;
    l2: number;
}
export declare const DEFAULT_PROMPT_BUDGETS: PromptBudgets;
export interface PromptAssemblyInput {
    state: CanonicalLoopState;
    level: PromptLevel;
    reasons: PromptLevelReason[];
    budgets?: Partial<PromptBudgets>;
    attempt?: number;
    selfEvaluationBlock: string;
    fullStateMarkdown?: string;
    /** v2.9: Model's information needs for this prompt. L0: ignored. */
    promptRequests?: PromptRequests;
    /** v3.2: Previous round's L1 presentation (persisted diff baseline).
     *  When present, L1 collapses unchanged content against it. */
    presentedBaseline?: PresentedStateSnapshot | null;
}
/** v3.2: The actionable instruction for a verification check. Exported for
 *  the coverage test (which imports the CHECK_* constants). */
export declare function verificationActionFor(check: string): string;
/** v3.2: Collapse only when at least this many items are unchanged — a tiny
 *  unchanged set renders in full (nothing worth saving). */
export declare const COLLAPSE_MIN_UNCHANGED = 3;
/** v3.2: Recent-rounds items kept in full when older ones collapse. */
export declare const KEEP_RECENT_ROUNDS = 3;
export interface ConstraintDiff {
    /** Constraint texts to render in full (new or violated this round). */
    changed: string[];
    /** Same-ID items unchanged since the baseline. */
    unchangedCount: number;
    /** Baseline items absent now, excluding emphasized items (they were moved
     *  to Critical Context, not demoted). */
    removedCount: number;
}
export declare function diffConstraints(baseline: PresentedStateSnapshot | null, activeTexts: string[], metadata: ConstraintMeta[], round: number, emphasized: Set<string>): ConstraintDiff;
export interface SubGoalDiff {
    /** Sub-goals to render in full (new or status transition). */
    changed: SubGoal[];
    unchangedCount: number;
    /** Baseline sub-goals no longer in the active set (done/canceled/blocked). */
    removedCount: number;
}
export declare function diffSubGoals(baseline: PresentedStateSnapshot | null, activeSubs: SubGoal[]): SubGoalDiff;
/** v3.2: True when a milestone boundary was crossed since the baseline —
 *  the Recent Rounds section then renders in full (a phase ended). */
export declare function milestoneBoundaryChanged(baseline: PresentedStateSnapshot | null, milestones: MilestoneSummary[]): boolean;
export declare function assemblePromptArtifact(input: PromptAssemblyInput): PromptArtifact;
//# sourceMappingURL=prompt-assembler.d.ts.map