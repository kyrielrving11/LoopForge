/** Pure prompt-freshness derivation over one COMMITTED round.
 *
 *  "Did the previous round produce anything the next prompt must respect?"
 *  The answer is a fact about the committed round, never a caller's mutable
 *  projection:
 *
 *  - machine progress is the shared provider-neutral rule (`deriveRoundProgress`);
 *  - machine activity is an after-phase command with an attributable result;
 *  - declared evolution is a committed semantic declaration the compiler
 *    already consumes.
 *
 *  `observableNewInformation` is false ONLY when the machine PROVES no
 *  progress and the Agent declared no evolution. An unobservable/unknown
 *  progress signal is `unknown` and must never be read as "nothing changed":
 *  that is the epistemic error that created the L0 feedback loop.
 *
 *  Nothing here is persisted, and nothing here is a second history source.
 */

import type { PromptFreshness, PromptFreshnessReason } from "./protocol.js";
import type { CommittedRoundView } from "./committed-round.js";
import { deriveRoundProgress } from "./progress.js";

export type { PromptFreshness, PromptFreshnessReason } from "./protocol.js";

/** No committed previous round: freshness is unknown, never "stale". */
export const UNKNOWN_PROMPT_FRESHNESS: PromptFreshness = {
  machineProgress: "unknown",
  providers: [],
  machineActivity: false,
  declaredEvolution: false,
  observableNewInformation: true,
  reasons: ["no_previous_committed_round"],
};

/** Command statuses that prove the command actually produced a result.
 *  `unavailable` is structural absence, not activity. */
const AFTER_COMMAND_ACTIVITY = new Set([
  "passed",
  "failed",
  "timeout",
  "aborted",
  "error",
]);

function declaredEvolution(previous: CommittedRoundView): boolean {
  const evaluation = previous.evaluation;
  return (
    (previous.discoveredConstraints?.length ?? 0) > 0 ||
    Boolean(evaluation?.objective_refinement?.trim()) ||
    (previous.emergedSubtasks?.length ?? 0) > 0 ||
    (previous.subgoalUpdates?.length ?? 0) > 0 ||
    (previous.retractedConstraints?.length ?? 0) > 0 ||
    (evaluation?.wrong_assumptions?.length ?? 0) > 0 ||
    (evaluation?.worker_results?.length ?? 0) > 0 ||
    previous.contractProposal !== null ||
    evaluation?.compression_checkpoint === true
  );
}

function machineActivity(previous: CommittedRoundView): boolean {
  return previous.afterEvidence.some(
    (observation) =>
      observation.kind === "command" &&
      observation.phase === "after" &&
      AFTER_COMMAND_ACTIVITY.has(observation.status),
  );
}

export function derivePromptFreshness(
  previous: CommittedRoundView,
): PromptFreshness {
  const progress = deriveRoundProgress(previous.observationDelta);
  const activity = machineActivity(previous);
  const declared = declaredEvolution(previous);
  const observableNewInformation =
    progress.state !== "unchanged" || activity || declared;

  const reasons: PromptFreshnessReason[] = [];
  if (progress.state === "changed") reasons.push("progress_changed");
  else if (progress.state === "unchanged") reasons.push("progress_unchanged");
  else if (progress.state === "unknown") reasons.push("progress_unknown");
  else reasons.push("no_progress_provider");
  if (activity) reasons.push("after_command_activity");
  if (declared) reasons.push("declared_evolution");
  if (!observableNewInformation) reasons.push("no_observable_activity");

  return {
    machineProgress: progress.state,
    providers: progress.providers,
    machineActivity: activity,
    declaredEvolution: declared,
    observableNewInformation,
    reasons,
  };
}
