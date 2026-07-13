/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */
import type { CheckpointSummary, LoopCompileRequest, LoopCompileResponse, VerificationFlag } from "./protocol.js";
export declare const CANONICAL_STATE_SCHEMA_VERSION: 1;
export interface CanonicalLoopState {
    schemaVersion: typeof CANONICAL_STATE_SCHEMA_VERSION;
    loopId: string;
    round: number;
    maxRounds: number;
    goalId: string;
    objective: string;
    objectiveVersion: number;
    currentTask: string;
    successCriteria: string[];
    hardConstraints: string[];
    activeConstraints: string[];
    retiredConstraints: string[];
    changesSinceLastRound: string[];
    remainingCriteria: string[];
    blockers: string[];
    verificationFlags: VerificationFlag[];
    discoveries: string[];
    nextAction: string;
    rollingOutcomes: string[];
    recurringIssues: string[];
    failedPatterns: string[];
    checkpoints: CheckpointSummary[];
    suggestedNextTask: string;
    externalContext: string;
    stateFilePath: string;
    progress: {
        estimate: number | null;
        criteriaMet: string[];
        criteriaRemaining: string[];
        filesChanged: string[];
        tests: {
            passed: number;
            failed: number;
            skipped: number;
        } | null;
    };
}
/** Deterministic JSON serialization used by state and prompt hashes. */
export declare function stableStringify(value: unknown): string;
export declare function hashCanonicalState(state: CanonicalLoopState): string;
/** Human/Agent-readable materialized view. It is always reproducible from the
 * canonical state and is never consulted as transaction truth. */
export declare function renderCanonicalStateMarkdown(state: CanonicalLoopState): string;
export declare function createCanonicalLoopState(request: LoopCompileRequest, response: LoopCompileResponse, stateFilePath: string): CanonicalLoopState;
//# sourceMappingURL=canonical-state.d.ts.map