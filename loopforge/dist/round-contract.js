import { deriveItemId, entryRound, isRecord, jaccardSimilarity } from "./token-utils.js";
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
// ── Raw-vault committed view (shared by verification, session views) ───────
/** Committed :feedback evals of rounds earlier than `currentRound`, in
 *  ascending round order — the input for the ACTIVE-contract walker over
 *  raw vault entries. Reads snapshot.evaluation (the only committed copy of
 *  round_contract / outcome / met claims; top-level feedback fields do not
 *  carry the contract) and skips rounds whose committed action was
 *  "backtrack" — a roll-back directive, not an executed round. An eval
 *  under verification is not committed yet, so it structurally can never
 *  participate. Shared by the verification gate and the status/session
 *  views — every consumer derives from the same adapter + walker so a
 *  second interpretation of the committed record can never exist. */
export function committedContractRounds(vaultEntries, currentRound) {
    const byRound = new Map();
    for (const entry of vaultEntries) {
        const tid = String(entry.task_id ?? "");
        if (!tid.endsWith(":feedback"))
            continue;
        const rnd = entryRound(entry);
        if (!(rnd >= 1 && rnd < currentRound))
            continue;
        const raw = entry;
        const lineage = raw.loop_lineage;
        if (!isRecord(lineage))
            continue;
        const tx = lineage.round_transaction;
        if (!isRecord(tx))
            continue;
        const result = tx.result;
        if (isRecord(result) && result.action === "backtrack")
            continue;
        const snapshot = tx.snapshot;
        if (!isRecord(snapshot))
            continue;
        const evaluation = snapshot.evaluation;
        if (!isRecord(evaluation))
            continue;
        const proposal = evaluation.round_contract;
        const outcome = evaluation.outcome;
        const ev = evaluation.execution_evidence;
        const met = isRecord(ev) && Array.isArray(ev.success_criteria_met)
            ? ev.success_criteria_met.filter((v) => typeof v === "string")
            : [];
        const isOutcome = outcome === "success" || outcome === "partial" ||
            outcome === "failed" || outcome === "blocked";
        byRound.set(rnd, {
            round: rnd,
            proposal: isRecord(proposal) ? proposal : null,
            outcome: isOutcome ? outcome : null,
            met,
        });
    }
    return [...byRound.values()].sort((a, b) => a.round - b.round);
}
/** v3.5.1: Extract ONE merged lineage entry into walker-record shape —
 *  shared by loop-compiler.deriveActiveContract and the view-parity test so
 *  the extraction logic exists once (a test-side copy would silently drift
 *  from production). Rules mirror committedContractRounds' contract for the
 *  compile-side view: only entries with a committed decision participate
 *  (committed_action gate), backtrack rounds are roll-back directives and
 *  are skipped, and eval fields are read top-level first with the lineage
 *  fallback (engine hydration writes merged fields to both). Null when the
 *  entry is not a committed merged round. */
export function mergedEntryEvaluation(entry) {
    if (!isRecord(entry))
        return null;
    const raw = entry;
    const linRaw = raw.loop_lineage ?? raw.lineage;
    const lin = isRecord(linRaw) ? linRaw : {};
    const action = lin.committed_action ?? raw.committed_action;
    if (typeof action !== "string" || action.length === 0)
        return null;
    if (action === "backtrack")
        return null;
    const rnd = lin.round;
    if (typeof rnd !== "number" || !Number.isInteger(rnd) || rnd < 1)
        return null;
    const contract = raw.round_contract ?? lin.round_contract;
    const outcome = raw.outcome ?? lin.outcome;
    const evRaw = raw.execution_evidence ?? lin.execution_evidence;
    const ev = isRecord(evRaw) ? evRaw : null;
    const met = ev && Array.isArray(ev.success_criteria_met)
        ? ev.success_criteria_met.filter((v) => typeof v === "string")
        : [];
    const isOutcome = outcome === "success" || outcome === "partial" ||
        outcome === "failed" || outcome === "blocked";
    return {
        round: rnd,
        proposal: isRecord(contract) ? contract : null,
        outcome: isOutcome ? outcome : null,
        met,
    };
}
//# sourceMappingURL=round-contract.js.map