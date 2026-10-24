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

import type {
  CriterionStatus,
} from "./protocol.js";
import type { CriterionMachineFact } from "./round-facts.js";
import type { CommittedRoundView } from "./committed-round.js";
import {
  criterionRefMatches,
  deriveCriterionId,
} from "./token-utils.js";

function claimedCriteria(
  view: CommittedRoundView,
  outcome: "met" | "remaining",
): string[] {
  return (view.executionReport?.criterion_claims ?? [])
    .filter((claim) => claim.outcome === outcome)
    .map((claim) => claim.criterion_id);
}

export interface CriterionStatusInput {
  /** Committed rounds below `currentRound`. */
  rounds: ReadonlyArray<CommittedRoundView>;
  currentRound: number;
  /** Only `success_criteria` is read; the rest of the objective is not a
   *  criterion fact. */
  objective: { success_criteria: ReadonlyArray<string> } | null;
  criterionFacts?: ReadonlyArray<CriterionMachineFact>;
}

/** v3.2: Derive per-criterion status — the "goal → criteria → evidence"
 *  vertical view. Each criterion gets claimed/remaining/unknown (from
 *  per-round `criterion_claims`, ID-first or normalized-exact matching) and
 *  the round it was first reported met. A machine fact from a contract item
 *  outranks the claim. Zero persistence — re-derived from committed facts
 *  every time. */
export function deriveCriterionStatuses(
  input: CriterionStatusInput,
): CriterionStatus[] {
  const objectiveCriteria = input.objective?.success_criteria ?? [];
  if (objectiveCriteria.length === 0) return [];
  const rounds = input.rounds
    .filter((round) => round.round >= 1 && round.round < input.currentRound)
    .sort((a, b) => a.round - b.round);
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1]! : null;
  const lastRemaining = lastRound ? claimedCriteria(lastRound, "remaining") : [];
  const lastMet = lastRound ? claimedCriteria(lastRound, "met") : [];
  const factsByCriterion = new Map(
    (input.criterionFacts ?? []).map((fact) => [fact.criterion_id, fact] as const),
  );

  // v3.9.4: one row per derived id. The objective is authored text; a case or
  // whitespace variant derives the same cr-* and must not produce a second
  // row (nor a second contract reference space).
  const seenIds = new Set<string>();
  const statuses: CriterionStatus[] = [];
  for (const text of objectiveCriteria) {
    const id = deriveCriterionId(text);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    let metAtRound: number | null = null;
    for (const round of rounds) {
      if (claimedCriteria(round, "met").some((met) => criterionRefMatches(met, text))) {
        metAtRound = round.round;
        break; // first report wins — chronological scan
      }
    }
    if (metAtRound === null &&
        lastMet.some((met) => criterionRefMatches(met, text))) {
      metAtRound = lastRound!.round;
    }
    const claimedStatus: CriterionStatus["status"] = metAtRound !== null
      ? "claimed"
      : lastRemaining.some((remaining) => criterionRefMatches(remaining, text))
        ? "remaining"
        : "unknown";
    const fact = factsByCriterion.get(id);
    statuses.push({
      id,
      text,
      status: fact?.status ?? claimedStatus,
      ...(metAtRound !== null ? { met_at_round: metAtRound } : {}),
    });
  }
  return statuses;
}
