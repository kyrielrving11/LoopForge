/** Single-pass renderer for v3 plan and evidence prompts. */
import type { CanonicalLoopState } from "./canonical-state.js";
import type { ContextRequest, PromptArtifact, RoundPromptMode } from "./protocol.js";
import type { PromptLevel, PromptLevelReason } from "./prompt-policy.js";
export declare const PROMPT_ARTIFACT_SCHEMA_VERSION: 1;
export declare const BASE_PROMPT_VERSION: string;
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
    roundId?: string;
    reportInstructions: string;
    reportMode: RoundPromptMode;
    fullStateMarkdown?: string;
    contextRequest?: ContextRequest;
    graphSliceMaxChars?: number;
}
export declare function assemblePromptArtifact(input: PromptAssemblyInput): PromptArtifact;
//# sourceMappingURL=prompt-assembler.d.ts.map