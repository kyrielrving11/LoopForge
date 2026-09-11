/** ReplayBackend — time-travel queries over loop lineage.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */
import { queryLoopEntries } from "./loop-store.js";
import { decodeCommittedRound, readOnlyRounds } from "./committed-round.js";
// ═══════════════════════════════════════════════════════════════════════════
// ReplayBackend
// ═══════════════════════════════════════════════════════════════════════════
export class ReplayBackend {
    store;
    constructor(store) {
        this.store = store;
    }
    // ── Single-round lookup ────────────────────────────────────────────────
    getRound(loopId, roundNum) {
        const prefix = `loop:${loopId}:r${roundNum}`;
        const entries = queryLoopEntries(this.store, loopId, { prefix });
        const lineageEntries = entries.filter((e) => !String(e.task_id ?? "").endsWith(":feedback"));
        const fbEntries = queryLoopEntries(this.store, loopId, {
            prefix,
            feedbackOnly: true,
        });
        const committed = fbEntries.map(decodeCommittedRound)
            .find((view) => view?.round === roundNum && view.action !== "backtrack");
        if (!committed)
            return null;
        const base = lineageEntries[0] ?? committed.sourceEntry;
        const entry = { ...base };
        entry.success = committed.success;
        entry.output_summary = committed.evaluation?.output_summary ?? entry.output_summary;
        entry.round_contract = committed.contractProposal ?? undefined;
        entry.loop_lineage = {
            ...(entry.loop_lineage ?? {}),
            success: committed.success,
            committed_action: committed.action,
        };
        return entry;
    }
    // ── Multi-round replay ─────────────────────────────────────────────────
    replay(loopId, opts) {
        const start = opts?.start ?? 1;
        let end = opts?.end;
        if (end === undefined) {
            end = this.maxRound(loopId);
            if (end === 0)
                return [];
        }
        const results = [];
        for (let rnd = start; rnd <= end; rnd++) {
            const entry = this.getRound(loopId, rnd);
            if (entry)
                results.push(entry);
        }
        return results;
    }
    // ── Timeline ──────────────────────────────────────────────────────────
    timeline(loopId) {
        const entries = this.replay(loopId);
        const timeline = [];
        for (const entry of entries) {
            const lineage = (entry.loop_lineage ?? {});
            timeline.push({
                round: lineage.round ?? 0,
                recompile_level: lineage.recompile_level ?? "l2",
                success: entry.success ?? lineage.success ?? false,
                task: lineage.task ?? "",
                goal_id: lineage.goal_id ?? "",
                // v3.5: the round's declared contract (proposal for the next round),
                // when it committed one — lets replay show the contract arc.
                ...(entry.round_contract ? { proposal: entry.round_contract } : {}),
            });
        }
        timeline.sort((a, b) => a.round - b.round);
        return timeline;
    }
    // ── Helpers ─────────────────────────────────────────────────────────────
    maxRound(loopId) {
        const prefix = `loop:${loopId}:r`;
        const feedback = queryLoopEntries(this.store, loopId, { prefix, feedbackOnly: true });
        const rounds = readOnlyRounds(feedback);
        return rounds.length > 0 ? rounds[rounds.length - 1].round : 0;
    }
}
//# sourceMappingURL=replay.js.map