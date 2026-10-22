/** Pure prompt-freshness derivation over one COMMITTED round.
 *
 *  "Did the previous round produce anything the next prompt must respect?"
 *  The answer is a fact about the committed round, never a caller's mutable
 *  projection:
 *
 *  - machine motion is the shared Git motion rule (`committedRoundGitMotion`);
 *  - machine activity is an after-phase command with an attributable result;
 *  - declared evolution is a committed semantic declaration the compiler
 *    already consumes.
 *
 *  `observableNewInformation` is false ONLY when the machine PROVES no
 *  activity and the Agent declared no evolution. An unobservable boundary is
 *  `null` (unknown) and must never be read as "nothing changed": that is the
 *  epistemic error that created the L0 feedback loop.
 *
 *  Nothing here is persisted, and nothing here is a second history source.
 */
import { committedRoundGitMotion } from "./committed-round.js";
/** No committed previous round: freshness is unknown, never "stale". */
export const UNKNOWN_PROMPT_FRESHNESS = {
    machineMotion: null,
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
function declaredEvolution(previous) {
    const evaluation = previous.evaluation;
    return ((previous.discoveredConstraints?.length ?? 0) > 0 ||
        Boolean(evaluation?.objective_refinement?.trim()) ||
        (previous.emergedSubtasks?.length ?? 0) > 0 ||
        (previous.subgoalUpdates?.length ?? 0) > 0 ||
        (previous.retractedConstraints?.length ?? 0) > 0 ||
        (evaluation?.wrong_assumptions?.length ?? 0) > 0 ||
        (evaluation?.worker_results?.length ?? 0) > 0 ||
        previous.contractProposal !== null ||
        evaluation?.compression_checkpoint === true);
}
function machineActivity(previous) {
    return previous.afterEvidence.some((observation) => observation.kind === "command" &&
        observation.phase === "after" &&
        AFTER_COMMAND_ACTIVITY.has(observation.status));
}
export function derivePromptFreshness(previous) {
    const gitDeltas = previous.observationDelta.filter((delta) => delta.kind === "git");
    const machineMotion = committedRoundGitMotion(previous);
    const activity = machineActivity(previous);
    const declared = declaredEvolution(previous);
    const observableNewInformation = machineMotion !== false || activity || declared;
    const reasons = [];
    if (machineMotion === true) {
        const contentChanged = gitDeltas.some((delta) => delta.changedFiles !== null && delta.changedFiles.length > 0);
        reasons.push(contentChanged ? "git_content_changed" : "git_head_moved");
    }
    else if (machineMotion === null) {
        reasons.push(gitDeltas.length > 0 ? "git_boundary_unknown" : "no_git_provider");
    }
    if (activity)
        reasons.push("after_command_activity");
    if (declared)
        reasons.push("declared_evolution");
    if (!observableNewInformation)
        reasons.push("no_observable_activity");
    return {
        machineMotion,
        machineActivity: activity,
        declaredEvolution: declared,
        observableNewInformation,
        reasons,
    };
}
//# sourceMappingURL=prompt-freshness.js.map