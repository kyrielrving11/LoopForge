/** Pure L0/L1/L2 prompt-view policy.
 *
 * Levels describe how much canonical state is rendered. They do not select a
 * reasoning technique; the external Agent owns its reasoning strategy.
 */

export type PromptLevel = "l0" | "l1" | "l2";

export type PromptLevelReason =
  | "explicit_override"
  | "first_round"
  | "plan_boundary"
  | "checkpoint_boundary"
  | "goal_changed"
  | "missing_previous_state"
  | "verification_contradicted"
  | "retry_delta"
  | "rejection_rehydrate"
  | "recovery_boundary"
  | "state_drift"
  | "periodic_refresh"
  | "state_capsule";

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

export function decidePromptLevel(input: PromptLevelInput): PromptLevelDecision {
  if ((input.consecutiveRejections ?? 0) >= 2) {
    return { level: "l2", reasons: ["rejection_rehydrate"] };
  }
  if (input.recoveryBoundary) {
    return { level: "l2", reasons: ["recovery_boundary"] };
  }
  if (input.stateDrift) return { level: "l2", reasons: ["state_drift"] };
  if ((input.attempt ?? 1) > 1) {
    return { level: "l0", reasons: ["retry_delta"] };
  }
  if (input.verificationContradicted) {
    return { level: "l2", reasons: ["verification_contradicted"] };
  }
  if (input.round === 1) return { level: "l2", reasons: ["first_round"] };
  if (input.hasPlanSource) return { level: "l2", reasons: ["plan_boundary"] };
  if (
    input.forceLevel &&
    input.forceLevel !== "auto" &&
    ["l0", "l1", "l2"].includes(input.forceLevel)
  ) {
    return {
      level: input.forceLevel as PromptLevel,
      reasons: ["explicit_override"],
    };
  }
  if (input.checkpointBoundary) {
    return { level: "l2", reasons: ["checkpoint_boundary"] };
  }
  if (input.goalChanged) return { level: "l2", reasons: ["goal_changed"] };
  if (input.previousStateMissing) {
    return { level: "l2", reasons: ["missing_previous_state"] };
  }
  if (input.previousFailedWithoutNewInformation) {
    return { level: "l0", reasons: ["retry_delta"] };
  }

  const lastFullRound = input.lastFullRound ?? 1;
  if (
    input.fullRefreshInterval > 0 &&
    input.round - lastFullRound >= input.fullRefreshInterval
  ) {
    return { level: "l2", reasons: ["periodic_refresh"] };
  }

  return { level: "l1", reasons: ["state_capsule"] };
}
