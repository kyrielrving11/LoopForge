import { deriveItemId, jaccardSimilarity } from "./token-utils.js";
import { getPolicy } from "./policy.js";
// ── Criterion reference matching ──────────────────────────────────────────
// Mirrors criteriaMatch (loop-compiler.ts) without importing loop-compiler
// (round-contract is imported BY loop-compiler — importing back would be a
// cycle). Parity is locked by round-contract.test.ts.
const CRITERION_ID_RE = /^cr-[a-f0-9]{8}$/;
function isCriterionId(ref) {
    return CRITERION_ID_RE.test(ref);
}
function deriveCriterionId(text) {
    return "cr-" + deriveItemId(text);
}
/** Match two done_when / met-claim references for completion testing.
 *  cr-ID-aware + Jaccard fallback, identical to criteriaMatch. */
export function contractItemMatches(a, b) {
    const aIsId = isCriterionId(a);
    const bIsId = isCriterionId(b);
    if (aIsId && bIsId)
        return a === b;
    if (aIsId)
        return a === deriveCriterionId(b);
    if (bIsId)
        return deriveCriterionId(a) === b;
    return jaccardSimilarity(a, b) >= getPolicy().evolution.criteria_dedup_threshold;
}
/** Whether every done_when item of `contract` matches a claim in `met`.
 *  Vacuous when done_when is empty (such contracts were already warned
 *  round_underspecified at declaration; they close at the first eval
 *  committed while active). */
export function contractDoneWhenSatisfied(contract, met) {
    if (contract.done_when.length === 0)
        return true;
    return contract.done_when.every((item) => met.some((claim) => contractItemMatches(item, claim)));
}
/** Walk committed evals (ASCENDING by round; the caller already restricts
 *  them to rounds earlier than the compile/verify round) and return the
 *  ACTIVE contract for the round after the last committed one — null means
 *  the Current Task falls back to the original task text.
 *
 *  State machine per committed eval r, with `active` the contract carried
 *  into r (null = whole-task round):
 *    - active && r.outcome === "blocked"          → active = r.proposal
 *    - active && all done_when in r.met           → active = r.proposal
 *    - active && neither                          → active unchanged (r's
 *      different proposal is a premature replacement and is ignored)
 *    - !active                                    → active = r.proposal
 *  (a proposal never activates on its own declaration round — it becomes
 *  active only for the rounds that follow the commit). */
export function deriveActiveRoundContract(committed) {
    let active = null;
    for (const r of committed) {
        if (active === null) {
            active = r.proposal ?? null;
            continue;
        }
        if (r.outcome === "blocked") {
            active = r.proposal ?? null;
            continue;
        }
        if (contractDoneWhenSatisfied(active, r.met)) {
            active = r.proposal ?? null;
            continue;
        }
        // active !== null and not closed — it continues; r's proposal (if any)
        // is a premature replacement and is ignored.
    }
    return active;
}
//# sourceMappingURL=round-contract.js.map