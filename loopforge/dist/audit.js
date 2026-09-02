/** v2.12: Read-only, replayable end-of-loop audit — the verification view.
 *
 *  Positioning vs loopforge_replay: replay is the factual timeline (what
 *  happened per round); audit is the assessment layer (which claims are
 *  machine-verified, which gates were decided, is the sequence intact).
 *  Everything is derived from committed vault entries — audit never writes.
 */
import { eventSequence, StorageCorruptionError } from "./loop-store.js";
import { auditOrder, deriveGate } from "./cognitive-governance.js";
import { rederiveClaimViewWithFlags, listVerifiedClaims } from "./evidence-claims.js";
import { effectiveOutcome } from "./self-eval.js";
import { isRecord, entryRound as sharedEntryRound } from "./token-utils.js";
function entryRound(entry) {
    return sharedEntryRound(entry);
}
/** Committed transaction payload from a feedback entry. */
function committedTransaction(entry) {
    if (!isRecord(entry.loop_lineage))
        return null;
    const transaction = entry.loop_lineage.round_transaction;
    if (!isRecord(transaction) || !isRecord(transaction.snapshot))
        return null;
    const snapshot = transaction.snapshot;
    const evaluation = isRecord(snapshot.evaluation)
        ? snapshot.evaluation
        : null;
    const result = isRecord(snapshot.result) ? snapshot.result : null;
    const flags = Array.isArray(result?.verificationFlags)
        ? result.verificationFlags
        : [];
    const evidence = Array.isArray(snapshot.afterEvidence)
        ? snapshot.afterEvidence
        : Array.isArray(snapshot.roundEvidence)
            ? snapshot.roundEvidence
            : [];
    return {
        evaluation,
        flags,
        afterEvidence: evidence,
        action: typeof result?.action === "string" ? result.action : undefined,
    };
}
/** Build the audit from committed vault entries. Pure, read-only.
 *  @param store Optional LoopStore — when provided, sequence integrity is
 *  checked and provenanceAvailable becomes true. */
export function buildAudit(loopId, entries, store) {
    const ordered = auditOrder(entries);
    // ── Rounds: per-round claims + checks from committed snapshots ─────────
    const rounds = [];
    for (const entry of ordered) {
        const taskId = String(entry.task_id ?? "");
        if (!taskId.startsWith(`loop:${loopId}:r`) || !taskId.endsWith(":feedback"))
            continue;
        const committed = committedTransaction(entry);
        if (!committed)
            continue;
        // v2.14: rounds committed with action="backtrack" were rolled back —
        // they are not part of the loop's final history. Counting them would
        // inflate the round list and let their error flags flip the verdict.
        if (committed.action === "backtrack")
            continue;
        const round = entryRound(entry);
        const outcome = committed.evaluation
            ? effectiveOutcome(committed.evaluation)
            : "unknown";
        const claimView = committed.evaluation
            ? rederiveClaimViewWithFlags(committed.evaluation, committed.afterEvidence, committed.flags)
            : null;
        rounds.push({
            round,
            outcome,
            claims: claimView
                ? claimView.claims.map((claim) => ({
                    text: claim.targetId,
                    status: claim.status === "verified" ? "verified" : "unverified",
                }))
                : [],
            checks: committed.flags.map((flag) => ({
                check: flag.check,
                severity: flag.severity,
                verdict: flag.severity === "error" ? "failed" : flag.severity,
            })),
        });
    }
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
    // ── Criteria accounting + verdict ──────────────────────────────────────
    const verified = listVerifiedClaims(entries, loopId);
    const declared = rounds.reduce((sum, round) => sum + round.claims.length, 0);
    const evidenced = verified.length;
    let verdict = "passed";
    if (rounds.some((round) => round.checks.some((check) => check.verdict === "failed"))) {
        verdict = "contradicted";
    }
    else if (unresolvedUserGates.length > 0 || (declared > 0 && evidenced === 0)) {
        verdict = "incomplete";
    }
    return {
        loopId,
        verdict,
        rounds,
        gates,
        unresolvedUserGates,
        criteria: { declared, evidenced, missing: Math.max(0, declared - evidenced) },
        sequenceComplete,
        provenanceAvailable,
    };
}
//# sourceMappingURL=audit.js.map