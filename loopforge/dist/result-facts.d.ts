/** v4.0.4: the ONE presentation of a round's result facts.
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
 */
import type { EvidencePosture, RoundOutcome, SelfEvaluation, StopReason } from "./protocol.js";
export type AgentStopReason = NonNullable<SelfEvaluation["agent_stop_reason"]>;
export interface ResultFacts {
    /** null = a rollback directive or no evaluation: there is no Agent report. */
    agent: {
        successClaim: boolean | null;
        /** effectiveOutcome(selfEval): declared outcome wins, else success-derived. */
        outcome: RoundOutcome | null;
        /** Raw SelfEvaluation.outcome; null means it was derived from success. */
        outcomeDeclared: RoundOutcome | null;
        shouldContinue: boolean | null;
        agentStopReason: AgentStopReason | null;
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