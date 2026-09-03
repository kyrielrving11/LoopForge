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
/** Match two done_when / met-claim references for completion testing.
 *  cr-ID-aware + Jaccard fallback, identical to criteriaMatch. */
export declare function contractItemMatches(a: string, b: string): boolean;
/** Whether every done_when item of `contract` matches a claim in `met`.
 *  Vacuous when done_when is empty (such contracts were already warned
 *  round_underspecified at declaration; they close at the first eval
 *  committed while active). */
export declare function contractDoneWhenSatisfied(contract: RoundContract, met: string[]): boolean;
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
export declare function deriveActiveRoundContract(committed: ReadonlyArray<CommittedRoundEvaluation>): RoundContract | null;
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
export declare function committedContractRounds(vaultEntries: VaultEntry[], currentRound: number): CommittedRoundEvaluation[];
/** v3.5.1: Extract ONE merged lineage entry into walker-record shape —
 *  shared by loop-compiler.deriveActiveContract and the view-parity test so
 *  the extraction logic exists once (a test-side copy would silently drift
 *  from production). Rules mirror committedContractRounds' contract for the
 *  compile-side view: only entries with a committed decision participate
 *  (committed_action gate), backtrack rounds are roll-back directives and
 *  are skipped, and eval fields are read top-level first with the lineage
 *  fallback (engine hydration writes merged fields to both). Null when the
 *  entry is not a committed merged round. */
export declare function mergedEntryEvaluation(entry: unknown): CommittedRoundEvaluation | null;
//# sourceMappingURL=round-contract.d.ts.map