/** Compile typed v3 workflow state into one prompt artifact. */
import { type LoopCompileRequest, type LoopCompileResponse } from "./protocol.js";
export interface PreviousRound {
    round: number;
    goal_id: string;
    goal_text_hash: string;
    status: "completed" | "blocked" | "in_progress";
    task: string;
    constraints_active: string[];
    summary: string;
}
export declare function computeGoalTextHash(text: string): string;
export declare function deriveGoalId(loopId: string, task: string, explicit?: string): string;
export declare function getPreviousRound(loopId: string, round: number, context: Record<string, unknown> | null): PreviousRound | null;
export declare function decideLevel(request: LoopCompileRequest, context: Record<string, unknown> | null): "l0" | "l1" | "l2";
export declare function buildRoundReportBlock(request: Pick<LoopCompileRequest, "report_mode" | "report_claim_targets" | "attempt">): string;
export declare function compileLoop(request: LoopCompileRequest, context: Record<string, unknown> | null): LoopCompileResponse;
//# sourceMappingURL=loop-compiler.d.ts.map