/** The ONE criterion-status derivation over committed history.
 *
 *  The compiler and the submission boundary/guidance used to reach this fact
 *  through different inputs: the compiler re-read the caller's compile
 *  context, while `submission-guidance` read `criterion_statuses` off the
 *  session's cached compile response. That cache does not survive a restart
 *  and could disagree with the Vault after a replay. This module takes
 *  committed round views only, so both surfaces derive the same rows.
 *
 *  It deliberately lives outside `loop-compiler.ts`: `loop-compiler.ts` imports
 *  `submission-guidance.ts`, so the reverse import would be a cycle. */
import type { CriterionStatus } from "./protocol.js";
import type { CriterionMachineFact } from "./round-facts.js";
import type { CommittedRoundView } from "./committed-round.js";
export interface CriterionStatusInput {
    /** Committed rounds below `currentRound`. */
    rounds: ReadonlyArray<CommittedRoundView>;
    currentRound: number;
    /** Only `success_criteria` is read; the rest of the objective is not a
     *  criterion fact. */
    objective: {
        success_criteria: ReadonlyArray<string>;
    } | null;
    criterionFacts?: ReadonlyArray<CriterionMachineFact>;
}
/** v3.2/v4.0.3: Derive per-criterion status — the "goal → criteria →
 *  evidence" vertical view.
 *
 *  Without a machine fact the LATEST claim wins (a criterion claimed met in
 *  R2 and reported remaining in R4 is `remaining`), and the row records that
 *  claim round with `status_source: "agent"`. A machine fact from a verified
 *  contract item outranks every claim and records its own round/source. Zero
 *  persistence — re-derived from committed facts every time. */
export declare function deriveCriterionStatuses(input: CriterionStatusInput): CriterionStatus[];
//# sourceMappingURL=criterion-status.d.ts.map