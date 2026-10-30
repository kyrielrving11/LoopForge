/** Pure L0/L1/L2 prompt-view policy.
 *
 * Levels describe how much canonical state is rendered. They do not select a
 * reasoning technique; the external Agent owns its reasoning strategy.
 */

import type { EvidencePosture, RoundOutcome } from "./protocol.js";

export type PromptLevel = "l0" | "l1" | "l2";

export type PromptLevelReason =
  | "explicit_override"
  | "first_round"
  | "plan_boundary"
  | "subtask_boundary"
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
}

export interface PromptLevelDecision {
  level: PromptLevel;
  reasons: PromptLevelReason[];
}

function previousRoundIsContradicted(
  previous: PromptLevelInput["previousRound"],
): boolean {
  return previous?.hasVerificationError === true ||
    previous?.evidencePosture === "contradicted";
}

function previousRoundIsProvablyStale(
  previous: PromptLevelInput["previousRound"],
): boolean {
  return previous !== null &&
    previous.agentOutcome !== "success" &&
    previous.evidencePosture !== null &&
    previous.evidencePosture !== "unknown" &&
    previous.observableNewInformation === false;
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
  if (previousRoundIsContradicted(input.previousRound)) {
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
  if (input.subtaskBoundary) {
    return { level: "l2", reasons: ["subtask_boundary"] };
  }
  if (input.goalChanged) return { level: "l2", reasons: ["goal_changed"] };
  if (input.previousStateMissing) {
    return { level: "l2", reasons: ["missing_previous_state"] };
  }
  if (
    previousRoundIsProvablyStale(input.previousRound)
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
