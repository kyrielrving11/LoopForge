/** v4.0.6: contract coverage — the ONE shared requirement derivation.
 *
 *  A round that continues with contract capability must leave an ACTIVE
 *  contract for the next round. This module answers only that structural
 *  question: does the next round have a contract, and where does the current
 *  proposal leave it? It never judges whether the slice is a real
 *  deliverable, whether an item is a good acceptance condition, or whether a
 *  command is the right test.
 *
 *  It is a PURE function of facts the caller already derived — it reads no
 *  store, no session and no policy global. The compile-time caller, the
 *  pre-advance submission boundary and the post-evidence coordinator all pass
 *  the same facts through this one rule, so they cannot disagree about
 *  whether a contract was required.
 *
 *  The active contract is the one derived from committed rounds
 *  (`ActiveContractView`); `closure` is the item reducer's verdict for the
 *  round being decided (or `"open"` before evidence exists).
 */
export function deriveContractRequirement(input) {
    const activeContractId = input.activeContract?.id ?? null;
    if (!input.shouldContinue) {
        return { required: false, reason: "not_continuing", activeContractId };
    }
    if (input.blocked) {
        return { required: false, reason: "blocked", activeContractId };
    }
    if (!input.contractCapability) {
        return { required: false, reason: "no_contract_capability", activeContractId };
    }
    if (!input.activeContract) {
        return input.proposalPresent
            ? { required: false, reason: "satisfied_by_proposal", activeContractId }
            : { required: true, reason: "no_active_contract", activeContractId };
    }
    if (input.closure === "open") {
        // Omitting the proposal continues the same contract. A different proposal
        // is a separate structural question (`contract_premature`); coverage
        // itself is already satisfied by the continuing contract.
        return { required: false, reason: "active_contract_continues", activeContractId };
    }
    // verified / superseded / blocked: the current contract will not govern the
    // next round, so a successor proposal must be present.
    return input.proposalPresent
        ? { required: false, reason: "satisfied_by_successor", activeContractId }
        : { required: true, reason: "active_contract_closed", activeContractId };
}
//# sourceMappingURL=contract-requirement.js.map