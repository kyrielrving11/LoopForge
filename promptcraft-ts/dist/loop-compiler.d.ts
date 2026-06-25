/** PromptCraft-loop_compile — Loop Compiler (v3.5 core).
 *
 * Pure-function module for per-loop-iteration prompt compilation.
 *
 * Two layers:
 *   Layer 1 (Hard Gates): decideLevel() — 4-gate routing that CAN change compile level.
 *   Layer 2 (Soft Advisories): computeAdvisories() — warnings/alignment/health, NEVER
 *     change compile level directly.
 *
 * Compilation: compileL0() / compileL1() / compileL2() produce the actual prompt.
 *
 * Python reference: loop_compiler.py (~1195 lines)
 */
import { type LoopCompileRequest, type LoopCompileResponse, type LoopHealth, type TaskAlignment } from "./protocol.js";
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
export declare function compileLoop(request: LoopCompileRequest, vaultContext?: Record<string, unknown> | null): LoopCompileResponse;
export {};
//# sourceMappingURL=loop-compiler.d.ts.map