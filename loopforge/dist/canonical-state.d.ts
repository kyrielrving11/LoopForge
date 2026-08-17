/** Canonical data used by prompt and Markdown projections. */
import type { ConstraintMeta, GraphSliceSummary, LoopCompileRequest, LoopCompileResponse, MilestoneSummary, PromptCompilationContext, RoundCheckReport, VerificationFlag } from "./protocol.js";
export declare const CANONICAL_STATE_SCHEMA_VERSION: 3;
export interface CanonicalLoopState {
    schemaVersion: typeof CANONICAL_STATE_SCHEMA_VERSION;
    loopId: string;
    round: number;
    maxRounds: number;
    goalId: string;
    objective: string;
    objectiveVersion: number;
    currentTask: string;
    compilationContext: PromptCompilationContext | null;
    successCriteria: string[];
    hardConstraints: string[];
    activeConstraints: string[];
    constraintMetadata: ConstraintMeta[];
    changesSinceLastRound: string[];
    blockers: string[];
    verificationFlags: VerificationFlag[];
    discoveries: string[];
    rollingOutcomes: string[];
    recurringIssues: string[];
    failedPatterns: string[];
    milestones: MilestoneSummary[];
    loopSynthesis: string;
    externalContext: string;
    stateFilePath: string;
    evidence: {
        files: string[];
        checks: RoundCheckReport[];
        coveredClaims: string[];
        evidenceGaps: string[];
    };
    graphSlice: GraphSliceSummary | null;
}
export declare function stableStringify(value: unknown): string;
export declare function hashCanonicalState(state: CanonicalLoopState): string;
export declare function formatCompilationContext(context: PromptCompilationContext | null, fallbackTask: string): string;
/** Markdown is a rebuildable view. Typed session and round JSON is truth. */
export declare function renderCanonicalStateMarkdown(state: CanonicalLoopState): string;
export declare function createCanonicalLoopState(request: LoopCompileRequest, response: LoopCompileResponse, stateFilePath: string): CanonicalLoopState;
//# sourceMappingURL=canonical-state.d.ts.map