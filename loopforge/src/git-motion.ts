/** v3.9.7: the Git arm of machine progress.
 *
 *  Kept dependency-free (types only) so both the observation delta derivation
 *  and `progress.ts` can use the ONE Git motion rule without an import cycle.
 *  This is still a Git-specific correctness rule: complete boundary
 *  fingerprints, HEAD movement, and landing on a rollback restore point.
 */

import type { MachineObservation } from "./protocol.js";

/** The ONE definition of machine Git motion for a single round.
 *
 *  Motion is a non-empty file list, a HEAD that moved across the round, or a
 *  HEAD that landed on the rollback's restore point — restoring the workspace
 *  IS that round's work, and would otherwise read as a round that did
 *  nothing. A clean worktree is not the same thing as no progress:
 *  commit-per-slice workflows leave no file delta even though HEAD advanced.
 *
 *  Observability stays the caller's concern: this answers "did this round
 *  move", never "could the round be observed". The restore-point arm compares
 *  short hashes, the rule `checkBacktrackGitHeadRestore` uses; the
 *  before/after arm compares the observations themselves. */
export function gitMotionSignal(input: {
  /** The round's derived Git change set; null means unknown. */
  changedFiles: ReadonlyArray<string> | null;
  headBefore?: string | null;
  headAfter?: string | null;
  restoreTargetHead?: string | null;
}): boolean | null {
  if (input.changedFiles !== null && input.changedFiles.length > 0) return true;
  const { headBefore, headAfter, restoreTargetHead } = input;
  if (headAfter && headBefore && headAfter !== headBefore) return true;
  if (headAfter && restoreTargetHead &&
      headAfter.slice(0, 12) === restoreTargetHead.slice(0, 12)) return true;
  if (input.changedFiles === null) return null;
  // An observed empty change set is no motion only when both HEADs are known;
  // otherwise a commit-only slice could still have moved HEAD.
  if (!headBefore || !headAfter) return null;
  return false;
}

/** Git HEAD as a machine observation exposes it, or null when it is silent. */
export function observedGitHead(
  observation: MachineObservation | undefined,
): string | null {
  return observation && observation.kind === "git" &&
      typeof observation.data.head === "string" && observation.data.head
    ? observation.data.head
    : null;
}

/** The Git observation this side of a delta actually observed, else null. */
export function observedGitObservation(
  observation: MachineObservation | null | undefined,
): MachineObservation | null {
  return observation && observation.kind === "git" && observation.status === "observed"
    ? observation
    : null;
}
