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
  | "same_round_retry"
  | "failed_without_observable_new_information"
  | "rejection_rehydrate"
  | "recovery_boundary"
  | "state_capsule";

export interface PromptLevelInput {
  round: number;
  attempt?: number;
  forceLevel?: string;
  hasPlanSource: boolean;
  checkpointBoundary: boolean;
  goalChanged: boolean;
  previousStateMissing: boolean;
  previousRoundFailed: boolean;
  /** null = the previous round's activity could not be observed. Unknown is
   *  NOT evidence of absence and must never downgrade to L0. */
  previousRoundObservableNewInformation: boolean | null;
  verificationContradicted: boolean;
  consecutiveRejections?: number;
  recoveryBoundary?: boolean;
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
  if ((input.attempt ?? 1) > 1) {
    return { level: "l0", reasons: ["same_round_retry"] };
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
  if (
    input.previousRoundFailed &&
    input.previousRoundObservableNewInformation === false
  ) {
    return {
      level: "l0",
      reasons: ["failed_without_observable_new_information"],
    };
  }

  // v3.8.1: no periodic_refresh branch. It was gated on
  // `full_refresh_interval`, whose default is 0 — a switch that disables its
  // own branch out of the box. L2 is reachable only by FACTS about the round
  // (first round, plan boundary, recovery, machine contradiction, checkpoint,
  // repeated rejection); a round-count timer was the one that was not.
  return { level: "l1", reasons: ["state_capsule"] };
}
