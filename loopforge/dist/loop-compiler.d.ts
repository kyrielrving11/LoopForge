/** LoopForge-loop_compile — Loop Compiler (v3.5 core).
 *
 * Pure-function module for per-loop-iteration prompt compilation.
 *
 * Two layers:
 *   Layer 1 (Hard Gates): decideLevel() — 4-gate routing that CAN change compile level.
 *   Layer 2 (Soft Advisories): computeAdvisories() — warnings/alignment/health, NEVER
 *     change compile level directly.
 *
 * Compilation: compileL0() / compileL1() / compileL2() produce the actual prompt.
 */
import { type LoopCompileRequest, type LoopCompileResponse, type LoopHealth, type RollingSummary, type TaskAlignment } from "./protocol.js";
export declare function tokenize(text: string): Set<string>;
export declare function jaccard(a: Set<string>, b: Set<string>): number;
/** Filter relevant constraints for a sub-agent task using Jaccard token similarity.
 *  Returns constraints whose token overlap with the subTask exceeds the threshold.
 *  Default threshold 0.15 is intentionally lower than the 0.3/0.5 alignment thresholds
 *  — constraint filtering should err on the side of inclusion. */
export declare function filterConstraintsForSubTask(allConstraints: string[], subTask: string, threshold?: number): string[];
/** Format a self-contained delegation prompt for a sub-agent.
 *  Produces a prompt that stands alone — no references to parent conversation,
 *  no "based on above", no "continue from previous". This matches the AgentTool
 *  contract: "Workers can't see your conversation." */
export declare function formatDelegationPrompt(subTask: string, subAgentType: string, relevantConstraints: string[], options?: {
    context?: string;
    outputFormat?: string;
}): string;
/** Build a delegation history summary from vault context (v1.9 — multi-agent).
 *  Scans vault for delegation_journal entries and formats them as a table.
 *  Returns empty string if no delegation history exists. */
export declare function buildDelegationSummary(vaultContext: Record<string, unknown> | null): string;
export declare function computeGoalTextHash(task: string): string;
export declare function deriveGoalId(loopId: string, task: string, explicitGoalId?: string): string;
interface PreviousRound {
    goal_id: string;
    goal_text_hash: string;
    quality_score: number;
    success: boolean;
    task: string;
    constraints_active: string[];
    prompt_text: string;
}
export declare function getPreviousRound(loopId: string, roundNum: number, vaultContext: Record<string, unknown> | null): PreviousRound | null;
export declare function buildRollingSummary(loopId: string, currentRound: number, vaultContext: Record<string, unknown> | null): RollingSummary | null;
export declare function formatRollingSummaryForPrompt(rs: RollingSummary | null): string;
/** Format an external context string for injection into an L2 prompt.
 *  Wraps the raw context in a marked section with a priority disclaimer.
 *  Returns empty string if context is empty or injection is disabled by policy. */
export declare function formatExternalContext(externalContext: string | undefined, sectionTitle: string, maxLength: number): string;
export declare function decideLevel(request: LoopCompileRequest, vaultContext: Record<string, unknown> | null): string;
export declare function alignTask(proposedTask: string, request: LoopCompileRequest, vaultContext: Record<string, unknown> | null): TaskAlignment;
export declare function checkLoopHealth(loopId: string, request: LoopCompileRequest, vaultContext: Record<string, unknown> | null): LoopHealth;
export declare function computeAdvisories(request: LoopCompileRequest, vaultContext: Record<string, unknown> | null): {
    warnings: string[];
    suggestedNextTask: string;
    alignment: TaskAlignment | null;
    health: LoopHealth | null;
};
export declare function compileL2(request: LoopCompileRequest, vaultContext: Record<string, unknown> | null): LoopCompileResponse;
/** Build the standardized self-evaluation block appended to every compiled prompt.
 *  The agent MUST output a JSON self-evaluation between the delimiters.
 *  4 required fields + 3 optional evolution fields (P0–P2) —
 *  each consumed by at least one downstream function. */
export declare function buildSelfEvalBlock(round: number): string;
export declare function compileLoop(request: LoopCompileRequest, vaultContext?: Record<string, unknown> | null): LoopCompileResponse;
export {};
//# sourceMappingURL=loop-compiler.d.ts.map