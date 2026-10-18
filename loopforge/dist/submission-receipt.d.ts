/** v3.9.1 — the submission receipt.
 *
 * A receipt is a READ-ONLY projection: it compares existing derivations and
 * reports what the transaction actually did. It is never persisted as its own
 * ledger; a committed round's receipt is rebuilt from its transaction snapshot
 * plus the shared `CommittedRoundView` window.
 *
 * The three facts are deliberately separate:
 *   - reports:   what was saved (or dropped/truncated/not applied);
 *   - effects:   which derived state actually changed;
 *   - verification: what the machine observed/verified.
 * A saved report is never a verified fact.
 */
import type { ContractItemStatus, PromptArtifact, SelfEvaluation, SubmissionDiagnostic, SubmissionReceipt, SubGoal } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { RoundProcessResult } from "./round-coordinator.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
import type { CommittedRoundView } from "./committed-round.js";
export interface ReceiptFacts {
    contractBefore: string | null;
    contractAfter: string | null;
    subGoalsBefore: ReadonlyArray<SubGoal>;
    subGoalsAfter: ReadonlyArray<SubGoal> | null;
    /** The next compile's active constraint set, or null when not observed. */
    constraintsActiveAfter: string[] | null;
}
export interface ReceiptInput {
    snapshot: RoundTransactionSnapshot;
    selfEval: SelfEvaluation;
    pr: RoundProcessResult;
    disposition: SubmissionReceipt["disposition"];
    diagnostics: SubmissionDiagnostic[];
    submittedFields: string[];
    facts: ReceiptFacts;
    nextArtifact?: PromptArtifact | null;
    contractItems: Array<{
        item_id: string;
        status: ContractItemStatus;
    }>;
    /** The round delta (already derived) used by the evidence posture. */
    evidenceDeltas: ObservationDelta[];
}
/** Build a receipt from explicitly supplied before/after facts. */
export declare function deriveSubmissionReceipt(input: ReceiptInput): SubmissionReceipt;
/** Rebuild the same receipt from committed history. No new persistence and
 *  no second history: `allViews` is the caller's `readOnlyRounds` window. */
export declare function deriveCommittedSubmissionView(view: CommittedRoundView, allViews: ReadonlyArray<CommittedRoundView>): SubmissionReceipt;
//# sourceMappingURL=submission-receipt.d.ts.map