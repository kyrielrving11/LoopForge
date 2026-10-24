/** The read-only history loader.
 *
 * One store read and one decode pass produce the committed-round views, the
 * current branch, its directives, the pending directive and the explicit
 * legacy report. This module owns no state and performs no derivation of its
 * own: it composes the existing read models (`decodeCommittedRecord`,
 * `resolveBranchViews`, `legacyTransactionRounds`) so every consumer sees the
 * same window instead of re-scanning the Vault with its own query pair.
 */
import { decodeCommittedRecord, legacyTransactionRounds, resolveBranchViews, } from "./committed-round.js";
import { OperatorAcceptanceConflictError } from "./errors.js";
/** Stable canonical text for the immutable operator surface. The field order
 *  is fixed by the protocol shape, so every copy serializes identically. */
export function operatorAcceptanceKey(value) {
    return JSON.stringify([
        value.task,
        value.success_criteria,
        value.hard_constraints,
    ]);
}
export function emptyCommittedHistory(loopId = "") {
    return {
        loopId,
        entries: [],
        views: [],
        branch: { loopId, branchId: "", rounds: [], directives: [], pendingDirective: null },
        rounds: [],
        directives: [],
        pendingDirective: null,
        legacyRounds: [],
    };
}
/** Build the read model from an already-loaded flat entry view. */
export function buildCommittedHistory(entries) {
    const copy = [...entries];
    const views = copy
        .map(decodeCommittedRecord)
        .filter((view) => view !== null);
    const branch = resolveBranchViews(views);
    const loopId = branch.loopId ||
        copy.find((entry) => typeof entry.loop_id === "string" && entry.loop_id.length > 0)?.loop_id ||
        "";
    let acceptance = null;
    for (const view of views) {
        if (!view.operatorAcceptance)
            continue;
        if (acceptance === null) {
            acceptance = view.operatorAcceptance;
            continue;
        }
        if (operatorAcceptanceKey(acceptance) !== operatorAcceptanceKey(view.operatorAcceptance)) {
            throw new OperatorAcceptanceConflictError(loopId);
        }
    }
    return {
        loopId,
        entries: copy,
        views,
        branch,
        rounds: branch.rounds,
        directives: branch.directives,
        pendingDirective: branch.pendingDirective,
        legacyRounds: legacyTransactionRounds(copy),
    };
}
/** The one Vault read used by the runtime's read paths. */
export function loadCommittedHistory(store, loopId) {
    return buildCommittedHistory(store.listEntries(loopId));
}
/** The compile window: current-branch evaluation rounds below `currentRound`.
 *  This is the same rule as `derivationRounds(entries, currentRound)`, but it
 *  reads the branch already resolved by the loader instead of decoding the
 *  entries again. */
export function historyWindow(history, currentRound = Number.POSITIVE_INFINITY) {
    return history.rounds.filter((view) => view.round < currentRound);
}
//# sourceMappingURL=history.js.map