/** v4.0.3: ONE projection of a round's Git facts for read-only surfaces.
 *
 *  Replay, explain and metrics previously picked the FIRST `kind === "git"`
 *  delta for `files_changed`/heads while the gate/receipt used the UNION
 *  selector. With several Git providers those views could describe different
 *  change sets. This module is the one selector: the change set is the union
 *  of every Git delta; a head pair is reported only when every Git provider
 *  agrees, otherwise it is unknown.
 */

import type { ObservationDelta } from "./evidence-provider.js";
import { gitDeltaState } from "./evidence-provider.js";
import { observedGitHead } from "./git-motion.js";

export interface GitRoundFacts {
  state: "observed" | "unknown" | "not_applicable";
  /** Union change set; null when unknown/not applicable. */
  changedFiles: string[] | null;
  /** A head is known only when every Git provider reports the same value. */
  headBefore: string | null;
  headAfter: string | null;
  /** First non-null after status, in delta order. */
  status: string | null;
}

export function gitRoundFacts(
  deltas: ReadonlyArray<ObservationDelta>,
): GitRoundFacts {
  const gitDeltas = deltas.filter((delta) => delta.kind === "git");
  const state = gitDeltaState(deltas);
  const single = (values: Array<string | null>): string | null =>
    values.length > 0 &&
      values.every((value) => value !== null && value === values[0])
      ? values[0]!
      : null;
  return {
    state: state.state,
    changedFiles: state.state === "observed" ? [...state.changedFiles] : null,
    headBefore: single(gitDeltas.map((delta) =>
      observedGitHead(delta.before ?? undefined))),
    headAfter: single(gitDeltas.map((delta) =>
      observedGitHead(delta.after ?? undefined))),
    status: gitDeltas
      .map((delta) => delta.after?.status ?? null)
      .find((value) => value !== null) ?? null,
  };
}
