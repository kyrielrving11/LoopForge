/** Single-pass prompt renderer for canonical LoopForge state.
 *
 * L0/L1/L2 control state density only. Reasoning strategy belongs to the
 * external Agent. Mandatory task, hard-constraint, and verification sections
 * are never truncated; budgets are soft and overflow is recorded.
 */
import type { CanonicalLoopState } from "./canonical-state.js";
import type { PromptArtifact } from "./protocol.js";
import type { PromptLevel, PromptLevelReason } from "./prompt-policy.js";
export declare const PROMPT_ARTIFACT_SCHEMA_VERSION: 1;
export declare const BASE_PROMPT_VERSION = "2.0.0";
export type InjectionMode = "adaptive" | "full" | "pointer";
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
    mode?: InjectionMode;
    budgets?: Partial<PromptBudgets>;
    attempt?: number;
    selfEvaluationBlock: string;
    fullStateMarkdown?: string;
}
export declare function assemblePromptArtifact(input: PromptAssemblyInput): PromptArtifact;
//# sourceMappingURL=prompt-assembler.d.ts.map