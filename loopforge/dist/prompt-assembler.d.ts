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
import type { PromptArtifact, PromptContextMode, PromptContextReason } from "./protocol.js";
import type { WorkingMemory } from "./working-memory.js";
import type { PromptLevel } from "./prompt-policy.js";
export interface PromptBudgets {
    l0: number;
    l1: number;
    l2: number;
}
export declare const DEFAULT_PROMPT_BUDGETS: PromptBudgets;
export interface PromptAssemblyInput {
    state: CanonicalLoopState;
    level: PromptLevel;
    budgets?: Partial<PromptBudgets>;
    attempt?: number;
    selfEvaluationBlock: string;
    /** v3.9.4: the committed-backtrack recovery facts, from the SAME
     *  `committedBacktrackBrief` the state file renders. Present only while a
     *  committed rollback directive is the current redo boundary. */
    recoveryBrief?: string[];
    /** v4.0.2/v4.0.4: the compiler-derived context boundary. REQUIRED: the
     *  assembler has no fallback, so the compiler remains the single derivation
     *  point. Not Agent input. */
    contextMode: PromptContextMode;
    contextReason: PromptContextReason;
    /** v4.0.2: the same bounded Working Memory the canonical state carries.
     *  Rendered only for `fresh_invocation`. */
    workingMemory?: WorkingMemory;
    /** v4.0.3: compile warnings recorded on the artifact by the assembler
     *  itself, so a direct `compileLoop` caller gets a complete artifact
     *  without a driver-side post-fix. */
    warnings?: string[];
}
/** 3.9.3: The action table lives in a neutral module so the evaluation-field
 *  guidance can quote the same wording without depending on a renderer.
 *  Re-exported here for the existing CHECK_* coverage test. */
export { verificationActionFor } from "./verification-actions.js";
export declare function assemblePromptArtifact(input: PromptAssemblyInput): PromptArtifact;
//# sourceMappingURL=prompt-assembler.d.ts.map