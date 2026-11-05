/** v4.0.4 / v4.0.6: the ONE presentation of a round's result facts.
 *
 *  Three kinds of facts stay separate and always appear in this order:
 *    1. Agent report   — what the Agent claimed (never machine evidence).
 *    2. LoopForge decision — the disposition and the loop terminal reason.
 *    3. Machine evidence — the persisted EvidencePosture, rendered by the
 *       single `formatEvidencePostureLines` renderer.
 *
 *  This module derives nothing. It formats facts that were already committed
 *  or are already computed by the runtime; it never re-derives `completed`,
 *  `machineBackedSuccess` or a "conflict"/"verdict" boolean.
 *
 *  v4.0.6: `outcome` is always declared (there is no `success`-derived
 *  branch), so the `outcomeDeclared` projection and the Agent stop-reason
 *  field are gone; the Agent's blocker text replaces that report detail.
 *  The success claim remains a derived read projection.
 */
import type { EvidencePosture, RoundOutcome, StopReason } from "./protocol.js";
export interface ResultFacts {
    /** null = a rollback directive or no evaluation: there is no Agent report. */
    agent: {
        successClaim: boolean | null;
        /** The Agent-declared outcome (`outcome` is required on an evaluation). */
        outcome: RoundOutcome | null;
        shouldContinue: boolean | null;
        /** The Agent's blocker text; required by the boundary when blocked, null
         *  when the round declared none. */
        blocker: string | null;
    } | null;
    loopforge: {
        action: "continue" | "stop" | "reject" | "terminate" | "backtrack" | "recovery";
        loopStopReason: StopReason | null;
        enforcementReason: string | null;
    };
    machine: {
        posture: EvidencePosture | null;
        /** false = a transient rejected/terminated attempt, not committed history. */
        committed: boolean;
    };
}
/** Render the three fact blocks. The caller owns any heading above them.
 *  `density` selects the shared posture renderer's compact form for terminal
 *  responses; it never changes the facts. */
export declare function renderResultFacts(facts: ResultFacts, density: "explain" | "terminal"): string[];
//# sourceMappingURL=result-facts.d.ts.map