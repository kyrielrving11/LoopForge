/** v3.4: Round Contract lifecycle — proposal vs active semantics.
 *
 * A submission's `round_contract` is a PROPOSAL for the NEXT round. It
 * becomes the ACTIVE contract (rendered as the Current Task and the target
 * of the round_scope_drift / premature_boundary checks) only after the
 * declaring round commits, and stays active until a committed eval closes
 * it:
 *   (i)  complete — every active done_when item is listed in that eval's
 *        execution_evidence.success_criteria_met (claims-based matching;
 *        per-item machine backing is future work), or
 *   (ii) blocked — the eval's declared outcome is "blocked".
 * On close the closing eval's own proposal (if any) becomes active; with
 * none, the Current Task reverts to the original task text. A different
 * proposal declared while the active contract is NOT closed is ignored —
 * the durable work item wins. The declaration round's own met claims never
 * satisfy its own proposal (it only becomes active the round AFTER the
 * declaration commits).
 *
 * Pure derivation over committed evals only — never reads in-flight or
 * rejected submissions. No persistence lives here; committed round
 * documents remain the single source of truth and both sides (compile-time
 * merged lineage view, verification-time raw :feedback view) translate
 * their entry shape into CommittedRoundEvaluation before calling
 * deriveActiveRoundContract.
 */
import type { RoundContract, RoundOutcome } from "./protocol.js";
import type { VaultEntry } from "./loop-store.js";
import { deriveItemId, entryRound, isRecord, jaccardSimilarity } from "./token-utils.js";
import { getPolicy } from "./policy.js";

/** One committed round's evaluation, in the shape both adapters produce. */
export interface CommittedRoundEvaluation {
  round: number;
  /** The contract the eval PROPOSED for the next round (null = none). */
  proposal: RoundContract | null;
  /** Committed eval outcome; null when the committed eval had none. */
  outcome: RoundOutcome | null;
  /** success_criteria_met claims of the committed eval. */
  met: string[];
}

// ── Criterion reference matching ──────────────────────────────────────────
// Mirrors criteriaMatch (loop-compiler.ts) without importing loop-compiler
// (round-contract is imported BY loop-compiler — importing back would be a
// cycle). Parity is locked by round-contract.test.ts.

const CRITERION_ID_RE = /^cr-[a-f0-9]{8}$/;

function isCriterionId(ref: string): boolean {
  return CRITERION_ID_RE.test(ref);
}

function deriveCriterionId(text: string): string {
  return "cr-" + deriveItemId(text);
}

/** Match two done_when / met-claim references for completion testing.
 *  cr-ID-aware + Jaccard fallback, identical to criteriaMatch. */
export function contractItemMatches(a: string, b: string): boolean {
  const aIsId = isCriterionId(a);
  const bIsId = isCriterionId(b);
  if (aIsId && bIsId) return a === b;
  if (aIsId) return a === deriveCriterionId(b);
  if (bIsId) return deriveCriterionId(a) === b;
  return jaccardSimilarity(a, b) >= getPolicy().evolution.criteria_dedup_threshold;
}

/** Whether every done_when item of `contract` matches a claim in `met`.
 *  Vacuous when done_when is empty (such contracts were already warned
 *  round_underspecified at declaration; they close at the first eval
 *  committed while active). */
export function contractDoneWhenSatisfied(
  contract: RoundContract,
  met: string[],
): boolean {
  if (contract.done_when.length === 0) return true;
  return contract.done_when.every((item) =>
    met.some((claim) => contractItemMatches(item, claim)),
  );
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
export function deriveActiveRoundContract(
  committed: ReadonlyArray<CommittedRoundEvaluation>,
): RoundContract | null {
  let active: RoundContract | null = null;
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
export function committedContractRounds(
  vaultEntries: VaultEntry[],
  currentRound: number,
): CommittedRoundEvaluation[] {
  const byRound = new Map<number, CommittedRoundEvaluation>();
  for (const entry of vaultEntries) {
    const tid = String(entry.task_id ?? "");
    if (!tid.endsWith(":feedback")) continue;
    const rnd = entryRound(entry as unknown as Record<string, unknown>);
    if (!(rnd >= 1 && rnd < currentRound)) continue;
    const raw = entry as unknown as Record<string, unknown>;
    const lineage = raw.loop_lineage;
    if (!isRecord(lineage)) continue;
    const tx = lineage.round_transaction;
    if (!isRecord(tx)) continue;
    const result = tx.result;
    if (isRecord(result) && result.action === "backtrack") continue;
    const snapshot = tx.snapshot;
    if (!isRecord(snapshot)) continue;
    const evaluation = snapshot.evaluation;
    if (!isRecord(evaluation)) continue;
    const proposal = evaluation.round_contract;
    const outcome = evaluation.outcome;
    const ev = evaluation.execution_evidence;
    const met = isRecord(ev) && Array.isArray(ev.success_criteria_met)
      ? ev.success_criteria_met.filter((v: unknown): v is string => typeof v === "string")
      : [];
    const isOutcome =
      outcome === "success" || outcome === "partial" ||
      outcome === "failed" || outcome === "blocked";
    byRound.set(rnd, {
      round: rnd,
      proposal: isRecord(proposal) ? proposal as unknown as RoundContract : null,
      outcome: isOutcome ? outcome : null,
      met,
    });
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}
