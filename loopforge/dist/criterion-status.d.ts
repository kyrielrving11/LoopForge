/** The ONE criterion-status derivation over committed history.
 *
 *  The compiler and the submission boundary/guidance used to reach this fact
 *  through different inputs: the compiler re-read the caller's compile
 *  context, while `submission-guidance` read `criterion_statuses` off the
 *  session's cached compile response. That cache does not survive a restart
 *  and could disagree with the Vault after a replay. This module takes
 *  committed entries only, so both surfaces derive the same rows.
 *
 *  It deliberately lives outside `loop-compiler.ts`: `loop-compiler.ts` imports
 *  `submission-guidance.ts`, so the reverse import would be a cycle. */
import type { CriterionStatus, LoopRoundResult } from "./protocol.js";
import type { CriterionMachineFact } from "./round-facts.js";
export interface CriterionStatusInput {
    /** Loop entries below `currentRound`. Callers that hold a committed-window
     *  read model pass `round.sourceEntry`; the compiler passes its context
     *  entries. */
    entries: ReadonlyArray<unknown>;
    currentRound: number;
    /** Only `success_criteria` is read; the rest of the objective is not a
     *  criterion fact. */
    objective: {
        success_criteria: ReadonlyArray<string>;
    } | null;
    /** The library fallback for a previous round that is not committed yet. */
    lastRoundResult?: LoopRoundResult | null;
    criterionFacts?: ReadonlyArray<CriterionMachineFact>;
}
/** v3.2: Derive per-criterion status — the "goal → criteria → evidence"
 *  vertical view. Each criterion gets: claimed/remaining/unknown (from
 *  per-round `criterion_claims`, ID-first or normalized-exact matching), the
 *  round it was first reported met, and the sub-goals a contract item
 *  referencing it also names (explicit `subgoal_refs`, never a text guess).
 *  A machine fact from a contract item outranks the claim. Zero persistence —
 *  re-derived from committed facts every time. */
export declare function deriveCriterionStatuses(input: CriterionStatusInput): CriterionStatus[];
//# sourceMappingURL=criterion-status.d.ts.map