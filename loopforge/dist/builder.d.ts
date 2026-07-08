/** LoopForge Agent — Technique router.
 *
 * Pure-function technique selection via keyword heuristic with tier gating.
 * Tier 1 (zero-shot / few-shot / CoT): always available.
 * Tier 2 (step-back / least-to-most / ToT): checkpoint boundaries or
 * after consecutive failures only.
 */
import { type Analysis } from "./protocol.js";
export declare const TECHNIQUE_REFERENCE: Record<string, string>;
export declare function routeTechnique(task: string): Analysis;
export declare function routeTechniqueAdaptive(task: string, vaultContext?: Record<string, unknown> | null, loopId?: string, isCheckpoint?: boolean): Analysis;
//# sourceMappingURL=builder.d.ts.map