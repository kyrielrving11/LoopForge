/** v3.9.7: the Git arm of machine progress.
 *
 *  Kept dependency-free (types only) so both the observation delta derivation
 *  and `progress.ts` can use the ONE Git motion rule without an import cycle.
 *  This is still a Git-specific correctness rule: complete boundary
 *  fingerprints and HEAD movement. A restore is NOT round progress: it happens
 *  before the redo prompt and belongs to no round delta.
 */
import type { MachineObservation, ProgressCoverage } from "./protocol.js";
/** v3.9.9: the Git workspace evidence coverage a rule must select explicitly.
 *  The descriptor is a FACT about the persisted Git observation (domain
 *  "workspace", object "git-motion", the observed boundary scope, the Git
 *  observation schema version) — not a policy key and not a provider vote.
 *  Rules match it exactly; a provider that merely mimics the strings cannot
 *  participate because selection is also kind-gated to `kind: "git"`. */
export declare const GIT_WORKSPACE_COVERAGE: ProgressCoverage;
/** The ONE definition of machine Git motion for a single round.
 *
 *  Motion is a non-empty file list or a HEAD that moved across the round. A
 *  clean worktree is not the same thing as no progress: commit-per-slice
 *  workflows leave no file delta even though HEAD advanced. A workspace
 *  restore is not a round's work; it happens before the redo prompt, so no
 *  restore-point arm exists here.
 *
 *  Observability stays the caller's concern: this answers "did this round
 *  move", never "could the round be observed". */
export declare function gitMotionSignal(input: {
    /** The round's derived Git change set; null means unknown. */
    changedFiles: ReadonlyArray<string> | null;
    headBefore?: string | null;
    headAfter?: string | null;
}): boolean | null;
/** Git HEAD as a machine observation exposes it, or null when it is silent. */
export declare function observedGitHead(observation: MachineObservation | undefined): string | null;
/** The Git observation this side of a delta actually observed, else null. */
export declare function observedGitObservation(observation: MachineObservation | null | undefined): MachineObservation | null;
//# sourceMappingURL=git-motion.d.ts.map