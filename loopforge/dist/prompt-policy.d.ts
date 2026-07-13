/** Pure L0/L1/L2 prompt-view policy.
 *
 * Levels describe how much canonical state is rendered. They do not select a
 * reasoning technique; the external Agent owns its reasoning strategy.
 */
export type PromptLevel = "l0" | "l1" | "l2";
export type PromptLevelReason = "explicit_override" | "first_round" | "plan_boundary" | "checkpoint_boundary" | "goal_changed" | "missing_previous_state" | "verification_contradicted" | "retry_delta" | "rejection_rehydrate" | "recovery_boundary" | "state_drift" | "periodic_refresh" | "state_capsule";
export interface PromptLevelInput {
    round: number;
    attempt?: number;
    forceLevel?: string;
    hasPlanSource: boolean;
    checkpointBoundary: boolean;
    goalChanged: boolean;
    previousStateMissing: boolean;
    previousFailedWithoutNewInformation: boolean;
    verificationContradicted: boolean;
    consecutiveRejections?: number;
    recoveryBoundary?: boolean;
    stateDrift?: boolean;
    fullRefreshInterval: number;
    lastFullRound?: number;
}
export interface PromptLevelDecision {
    level: PromptLevel;
    reasons: PromptLevelReason[];
}
export declare function decidePromptLevel(input: PromptLevelInput): PromptLevelDecision;
//# sourceMappingURL=prompt-policy.d.ts.map