/** Single-pass prompt renderer for canonical LoopForge state.
 *
 * L0/L1/L2 control state density only. Reasoning strategy belongs to the
 * external Agent. Mandatory task, hard-constraint, and verification sections
 * are never truncated and always render. Budgets are soft CEILINGS applied
 * to optional sections: optional sections are appended in priority order
 * while the rendered length stays under the level's budget, and the rest are
 * dropped from the prompt (the dropped content stays derivable from the
 * vault). Prompt length can exceed the ceiling when the mandatory sections
 * alone are over it — truncation of mandatory content never happens.
 */
import type { CanonicalLoopState } from "./canonical-state.js";
import type { PromptArtifact, PromptRequests } from "./protocol.js";
import type { PromptLevel, PromptLevelReason } from "./prompt-policy.js";
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
}
/** v3.2: The actionable instruction for a verification check. Exported for
 *  the coverage test (which imports the CHECK_* constants). */
export declare function verificationActionFor(check: string): string;
export declare function assemblePromptArtifact(input: PromptAssemblyInput): PromptArtifact;
//# sourceMappingURL=prompt-assembler.d.ts.map