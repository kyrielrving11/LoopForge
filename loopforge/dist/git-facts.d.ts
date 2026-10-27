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
export declare function gitRoundFacts(deltas: ReadonlyArray<ObservationDelta>): GitRoundFacts;
//# sourceMappingURL=git-facts.d.ts.map