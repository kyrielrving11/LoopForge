/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */
import { type LoopCompileRequest, type LoopCompileResponse, type LoopHealth, type RollingSummary, type TaskAlignment } from "./protocol.js";
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
export declare function getPreviousRound(loopId: string, round: number, context: Record<string, unknown> | null): PreviousRound | null;
export declare function buildRollingSummary(loopId: string, currentRound: number, context: Record<string, unknown> | null, sinceRound?: number): RollingSummary | null;
export declare function alignTask(proposedTask: string, request: LoopCompileRequest, context: Record<string, unknown> | null): TaskAlignment;
export declare function checkLoopHealth(loopId: string, request: LoopCompileRequest, context: Record<string, unknown> | null): LoopHealth;
export declare function decideLevel(request: LoopCompileRequest, context: Record<string, unknown> | null): "l0" | "l1" | "l2";
export declare function buildSelfEvalBlock(round: number): string;
export declare function compileLoop(request: LoopCompileRequest, context: Record<string, unknown> | null): LoopCompileResponse;
//# sourceMappingURL=loop-compiler.d.ts.map