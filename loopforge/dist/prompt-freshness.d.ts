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
import type { CommittedRoundView } from "./committed-round.js";
export type PromptFreshnessReason = "git_content_changed" | "git_head_moved" | "after_command_activity" | "declared_evolution" | "git_boundary_unknown" | "no_git_provider" | "no_observable_activity" | "no_previous_committed_round";
export interface PromptFreshness {
    /** true = motion, false = observed no motion, null = unknown. */
    machineMotion: boolean | null;
    /** An after-phase command produced a structured, attributable result. */
    machineActivity: boolean;
    /** The committed evaluation declared evolution the compiler consumes. */
    declaredEvolution: boolean;
    /** false ONLY when no-activity is proven; unknown counts as fresh. */
    observableNewInformation: boolean;
    /** Stable, deterministic order. */
    reasons: PromptFreshnessReason[];
}
/** No committed previous round: freshness is unknown, never "stale". */
export declare const UNKNOWN_PROMPT_FRESHNESS: PromptFreshness;
export declare function derivePromptFreshness(previous: CommittedRoundView): PromptFreshness;
//# sourceMappingURL=prompt-freshness.d.ts.map