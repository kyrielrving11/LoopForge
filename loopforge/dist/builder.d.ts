/** LoopForge Agent — Technique router.
 *
 * Pure-function technique selection via keyword heuristic with tier gating.
 * Tier 1 (zero-shot / few-shot / CoT): always available.
 * Tier 2 (step-back / least-to-most / ToT): checkpoint boundaries or
 * after consecutive failures only.
 */
import { type Analysis } from "./protocol.js";
/** Absolute path to the skills/ directory shipped with this package.
 *  Derived from this module's location in dist/ → ../skills/. */
export declare const SKILLS_DIR: string;
export declare const TECHNIQUE_REFERENCE: Record<string, string>;
export declare function routeTechnique(task: string): Analysis;
export declare function routeTechniqueAdaptive(task: string, 
/** @deprecated v1.15 — escalation removed; no longer read. Kept for API compat. */
_vaultContext?: Record<string, unknown> | null, 
/** @deprecated v1.15 — escalation removed; no longer read. Kept for API compat. */
_loopId?: string, isCheckpoint?: boolean): Analysis;
//# sourceMappingURL=builder.d.ts.map