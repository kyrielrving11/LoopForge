/** v2.12: Read-only, replayable end-of-loop audit — the verification view.
 *
 *  Positioning vs loopforge_replay: replay is the factual timeline (what
 *  happened per round); audit is the assessment layer (which claims are
 *  machine-verified, which gates were decided, is the sequence intact).
 *  Everything is derived from committed vault entries — audit never writes.
 *
 *  v3.8: the CONTRACT ITEM axis is the primary completion basis. The criterion
 *  claims stay as an advisory second view — a criterion claim is an agent
 *  statement whose machine backing is mediated by the contract items, so it
 *  cannot be the completion signal. Both axes read the same committed-round
 *  model and the same item reducer the coordinator and explain use.
 */
import { eventSequence, StorageCorruptionError } from "./loop-store.js";
import { auditOrder, deriveGate } from "./cognitive-governance.js";
import { rederiveClaimViewWithFlags, listVerifiedClaims } from "./evidence-claims.js";
import { isRecord, entryRound } from "./token-utils.js";
import { committedRoundsFromEntries, decodeCommittedRound, legacyTransactionRounds, machineEvidenceForRound, } from "./committed-round.js";
import { deriveRoundContractView } from "./round-contract.js";
import { getPolicy } from "./policy.js";
/** Build the audit from committed vault entries. Pure, read-only.
 *  @param store Optional LoopStore — when provided, sequence integrity is
 *  checked and provenanceAvailable becomes true. */
export function buildAudit(loopId, entries, store) {
    const ordered = auditOrder(entries);
    // v3.8: the shared committed-round read model — ordering, dedup and rollback
    // exclusion come from it, not from a private rule.
    const views = committedRoundsFromEntries(entries).filter((view) => view.loopId === loopId);
    const commands = getPolicy().evidence.commands ?? [];
    const viewByRound = new Map(views.map((view) => [view.round, view]));
    // The executed contract per round, through the ONE derivation explain and
    // the live coordinator also call. Re-derived per round rather than walked
    // incrementally on purpose: a private incremental walker would be a second
    // history interpretation, which is exactly what this project forbids.
    const contractByRound = new Map();
    for (const view of views) {
        contractByRound.set(view.round, deriveRoundContractView({
            rounds: views,
            round: view.round,
            report: view.executionReport,
            observations: view.observationDelta,
            outcome: view.outcome,
            commands,
        }));
    }
    // ── Rounds: per-round claims + checks from committed snapshots ─────────
    const rounds = [];
    for (const entry of ordered) {
        const taskId = String(entry.task_id ?? "");
        if (!taskId.startsWith(`loop:${loopId}:r`) || !taskId.endsWith(":feedback"))
            continue;
        const committed = decodeCommittedRound(entry);
        if (!committed)
            continue;
        // v2.14: rounds committed with action="backtrack" were rolled back —
        // they are not part of the loop's final history. Counting them would
        // inflate the round list and let their error flags flip the verdict.
        if (committed.action === "backtrack")
            continue;
        const round = entryRound(entry);
        const outcome = committed.outcome ?? "unknown";
        const claimView = committed.evaluation
            ? rederiveClaimViewWithFlags(committed.evaluation, machineEvidenceForRound(committed), committed.verificationFlags)
            : null;
        const executed = contractByRound.get(round);
        rounds.push({
            round,
            outcome,
            claims: claimView
                ? claimView.claims.map((claim) => ({
                    text: claim.targetId,
                    status: claim.status === "verified" ? "verified" : "unverified",
                }))
                : [],
            checks: committed.verificationFlags.map((flag) => ({
                check: flag.check,
                severity: flag.severity,
                verdict: flag.severity === "error" ? "failed" : flag.severity,
            })),
            contract: executed?.contract && executed.statuses.contractId
                ? {
                    id: executed.statuses.contractId,
                    declared_at_round: executed.contract.declared_at_round,
                    closure: executed.statuses.closure,
                    items: executed.statuses.items.map((item) => ({
                        itemId: item.itemId,
                        status: item.status,
                    })),
                }
                : null,
        });
    }
    // ── Contract item axis — the verification skeleton ─────────────────────
    const contractsById = new Map();
    for (const view of views) {
        const executed = contractByRound.get(view.round);
        if (!executed?.contract || !executed.statuses.contractId)
            continue;
        const id = executed.statuses.contractId;
        const existing = contractsById.get(id);
        contractsById.set(id, {
            contract_id: id,
            declared_at_round: existing?.declared_at_round ?? executed.contract.declared_at_round,
            first_active_round: existing?.first_active_round ?? view.round,
            last_active_round: view.round,
            closure: executed.statuses.closure,
            closed_at_round: executed.statuses.closed_at_round,
            items: executed.statuses.items.map((item) => ({
                itemId: item.itemId,
                description: item.description,
                status: item.status,
            })),
        });
    }
    const contracts = [...contractsById.values()]
        .sort((a, b) => a.first_active_round - b.first_active_round || a.contract_id.localeCompare(b.contract_id));
    const flatItems = contracts.flatMap((contract) => contract.items);
    const contractsSummary = {
        contracts,
        open: contracts.filter((contract) => contract.closure === "open").length,
        verifiedItems: flatItems.filter((item) => item.status === "verified").length,
        insufficientItems: flatItems.filter((item) => item.status === "insufficient").length,
        contradictedItems: flatItems.filter((item) => item.status === "contradicted").length,
        pendingItems: flatItems.filter((item) => item.status === "pending").length,
    };
    // ── Gates: latest decision wins; opened-without-decision stays open ────
    const decisionsByGate = new Map();
    const openedGates = new Map();
    for (const entry of ordered) {
        const gateId = String(entry.gate_id ?? "");
        if (!gateId)
            continue;
        if (entry.task_type === "gate_decision" && isRecord(entry.gate_decision)) {
            const decision = entry.gate_decision;
            decisionsByGate.set(gateId, {
                gateId,
                kind: decision.kind === "agent" ? "agent" : "user",
                actionHash: typeof decision.actionHash === "string" ? decision.actionHash : "",
                approved: decision.approved === true,
                decidedAt: typeof decision.decidedAt === "string" ? decision.decidedAt : "",
                round: entryRound(entry),
            });
        }
        else if (entry.task_type === "gate_opened") {
            openedGates.set(gateId, {
                description: typeof entry.gate_action === "string" ? entry.gate_action : gateId,
                round: entryRound(entry),
            });
        }
    }
    const gates = [...decisionsByGate.values()];
    const unresolvedUserGates = [];
    for (const [gateId, opened] of openedGates) {
        if (decisionsByGate.has(gateId))
            continue;
        // Re-derive the classification from the recorded action text.
        const { gate } = deriveGate(opened.description);
        if (gate.kind === "user") {
            unresolvedUserGates.push(`${gateId} (round ${opened.round}): ${opened.description}`);
        }
    }
    // ── Sequence integrity (P0) ────────────────────────────────────────────
    let sequenceComplete = true;
    let provenanceAvailable = store !== undefined;
    if (store) {
        try {
            const sequences = eventSequence(store, loopId);
            const max = sequences.length > 0 ? Math.max(...sequences) : 0;
            sequenceComplete = sequences.length === max;
        }
        catch (error) {
            sequenceComplete = false;
            if (!(error instanceof StorageCorruptionError))
                throw error;
        }
    }
    // ── Criteria accounting (advisory second axis) + verdict ───────────────
    //
    // v3.8 fix: `declared` used to be a PER-ROUND SUM while `evidenced` was a
    // DEDUPLICATED count — a criterion claimed in three rounds read as three
    // declared against one evidenced, so `missing` was fiction. Both sides are
    // now distinct-id counts over the same history and compare directly.
    const verified = listVerifiedClaims(entries, loopId);
    const declaredIds = new Set(rounds.flatMap((round) => round.claims.map((claim) => claim.text)));
    const declared = declaredIds.size;
    const evidenced = verified.length;
    // v3.8: the contract item axis decides completion. A contradicted item is a
    // machine denial; an open contract is unfinished verification; the claim
    // axis only speaks when no contract item exists to speak for it.
    let verdict = "passed";
    if (rounds.some((round) => round.checks.some((check) => check.verdict === "failed")) ||
        contractsSummary.contradictedItems > 0) {
        verdict = "contradicted";
    }
    else if (unresolvedUserGates.length > 0 || contractsSummary.open > 0 ||
        (declared > 0 && evidenced === 0)) {
        verdict = "incomplete";
    }
    return {
        loopId,
        verdict,
        rounds,
        gates,
        unresolvedUserGates,
        contracts: contractsSummary,
        criteria: { declared, evidenced, missing: Math.max(0, declared - evidenced) },
        sequenceComplete,
        provenanceAvailable,
        legacyRounds: legacyTransactionRounds(entries).map((item) => item.round),
    };
}
//# sourceMappingURL=audit.js.map