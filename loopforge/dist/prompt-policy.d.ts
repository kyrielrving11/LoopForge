/** Pure L0/L1/L2 prompt-view policy.
 *
 * Levels describe how much canonical state is rendered. They do not select a
 * reasoning technique; the external Agent owns its reasoning strategy.
 */
import type { EvidencePosture, RoundOutcome } from "./protocol.js";
export type PromptLevel = "l0" | "l1" | "l2";
export type PromptLevelReason = "explicit_override" | "first_round" | "plan_boundary" | "subtask_boundary" | "goal_changed" | "missing_previous_state" | "verification_contradicted" | "same_round_retry" | "failed_without_observable_new_information" | "rejection_rehydrate" | "recovery_boundary" | "invocation_recovery" | "state_capsule";
export interface PromptLevelInput {
    round: number;
    attempt?: number;
    forceLevel?: string;
    hasPlanSource: boolean;
    subtaskBoundary: boolean;
    goalChanged: boolean;
    previousStateMissing: boolean;
    /** Facts from the previous committed round, interpreted here once for the
     *  prompt density decision. A null posture/outcome means unavailable. */
    previousRound: {
        agentOutcome: RoundOutcome | null;
        evidencePosture: EvidencePosture["status"] | null;
        observableNewInformation: boolean | null;
        hasVerificationError: boolean;
    } | null;
    consecutiveRejections?: number;
    recoveryBoundary?: boolean;
    /** v4.0.5: a held retry recompiled because the original invocation is gone.
     *  A cold handoff has no transcript to rely on, so it rehydrates at L2. */
    invocationRecovery?: boolean;
}
export interface PromptLevelDecision {
    level: PromptLevel;
    reasons: PromptLevelReason[];
}
export declare function decidePromptLevel(input: PromptLevelInput): PromptLevelDecision;
//# sourceMappingURL=prompt-policy.d.ts.map