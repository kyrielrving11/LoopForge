/** LoopForge Agent — Technique router + quality scoring.
 *
 * Two pure-function responsibilities:
 *   1. Technique selection — keyword heuristic, fast + zero-cost
 *   2. Quality scoring — deterministic 1-5 from feedback signals
 */
import { type Analysis } from "./protocol.js";
export declare const TECHNIQUE_REFERENCE: Record<string, string>;
export declare function routeTechnique(task: string): Analysis;
export declare function scoreQuality(feedback: {
    success: boolean;
    constraint_violations?: unknown[];
    manual_fixes_needed?: string;
} | null): number;
export declare function routeTechniqueAdaptive(task: string, vaultContext?: Record<string, unknown> | null, loopId?: string): Analysis;
export declare function extractGlobalConstraints(hydrateResults: Record<string, unknown> | null): string[];
//# sourceMappingURL=builder.d.ts.map