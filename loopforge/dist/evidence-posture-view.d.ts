/** v4.0.3: the ONE renderer of a persisted evidence posture.
 *
 *  The prompt's Machine Evidence section and the state file's Machine Evidence
 *  section read the same formatter, so a committed round cannot be described
 *  two different ways. `compact` only shortens the displayed arrays; it never
 *  changes the posture, its status or its counts.
 */
import type { EvidencePosture } from "./protocol.js";
export interface EvidencePostureViewOptions {
    /** Prompt/profile display: shorter arrays and no per-item reasons. */
    compact?: boolean;
}
/** Render the body lines of a Machine Evidence section. The caller owns the
 *  heading and the authority sentence. */
export declare function formatEvidencePostureLines(posture: EvidencePosture, options?: EvidencePostureViewOptions): string[];
/** The fixed sentence that keeps Machine Evidence distinct from a judgment of
 *  the Agent's work. */
export declare const MACHINE_EVIDENCE_AUTHORITY: string;
//# sourceMappingURL=evidence-posture-view.d.ts.map