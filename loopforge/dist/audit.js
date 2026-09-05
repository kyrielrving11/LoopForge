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
import { isRecord, entryRound } from "./token-utils.js";
import { decodeCommittedRound, machineEvidenceForRound } from "./committed-round.js";
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