/** ReplayBackend — time-travel queries over loop lineage.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */
import { queryLoopEntries } from "./loop-store.js";
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
        if (!lineageEntries.length)
            return null;
        const entry = { ...lineageEntries[0] };
        // Merge feedback success flag
        const fbEntries = queryLoopEntries(this.store, loopId, {
            prefix,
            feedbackOnly: true,
        });
        if (fbEntries.length) {
            const fbSuccess = fbEntries[0].success;
            if (fbSuccess !== undefined) {
                entry.success = fbSuccess;
                const lineage = (entry.loop_lineage ?? {});
                lineage.success = fbSuccess;
                entry.loop_lineage = lineage;
            }
        }
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
            });
        }
        timeline.sort((a, b) => a.round - b.round);
        return timeline;
    }
    // ── Helpers ─────────────────────────────────────────────────────────────
    maxRound(loopId) {
        const prefix = `loop:${loopId}:r`;
        const entries = queryLoopEntries(this.store, loopId, { prefix });
        let maxR = 0;
        for (const e of entries) {
            const lineage = (e.loop_lineage ?? {});
            const rnd = lineage.round;
            if (typeof rnd === "number" && rnd > maxR)
                maxR = rnd;
        }
        return maxR;
    }
}
//# sourceMappingURL=replay.js.map