/** The read-only history loader.
 *
 * One store read and one decode pass produce the committed-round views, the
 * current branch, its directives, the pending directive and the explicit
 * legacy report. This module owns no state and performs no derivation of its
 * own: it composes the existing read models (`decodeCommittedRecord`,
 * `resolveBranchViews`, `legacyTransactionRounds`) so every consumer sees the
 * same window instead of re-scanning the Vault with its own query pair.
 */
import { type BranchView, type CommittedRoundView, type LegacyRound } from "./committed-round.js";
import type { LoopStore, VaultEntry } from "./loop-store.js";
import type { OperatorAcceptance } from "./protocol.js";
/** Stable canonical text for the immutable operator surface. The field order
 *  is fixed by the protocol shape, so every copy serializes identically. */
export declare function operatorAcceptanceKey(value: OperatorAcceptance): string;
export interface CommittedHistory {
    loopId: string;
    /** The flat entry view this history was built from (session, feedback,
     *  rollback directives, gate records). Read-only. */
    entries: VaultEntry[];
    /** Decoded evaluation + rollback records. */
    views: CommittedRoundView[];
    branch: BranchView;
    /** Current-branch evaluation rounds, ascending. */
    rounds: CommittedRoundView[];
    /** Committed rollback directives on the current branch chain. */
    directives: CommittedRoundView[];
    /** The last directive whose child branch has no evaluation commit yet. */
    pendingDirective: CommittedRoundView | null;
    /** Rounds whose persisted envelope is an unsupported schema. They are NOT
     *  history; the explicit list makes the loss visible. */
    legacyRounds: LegacyRound[];
}
export declare function emptyCommittedHistory(loopId?: string): CommittedHistory;
/** Build the read model from an already-loaded flat entry view. */
export declare function buildCommittedHistory(entries: ReadonlyArray<VaultEntry>): CommittedHistory;
/** The one Vault read used by the runtime's read paths. */
export declare function loadCommittedHistory(store: LoopStore, loopId: string): CommittedHistory;
/** The compile window: current-branch evaluation rounds below `currentRound`.
 *  This is the same rule as `derivationRounds(entries, currentRound)`, but it
 *  reads the branch already resolved by the loader instead of decoding the
 *  entries again. */
export declare function historyWindow(history: CommittedHistory, currentRound?: number): CommittedRoundView[];
//# sourceMappingURL=history.d.ts.map