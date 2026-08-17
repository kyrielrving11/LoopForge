/** ReplayBackend — time-travel queries over vault lineage.
 *
 * Depends on VaultBackend interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */
import { buildGovernanceGraph } from "./governance-graph.js";
import { parseWorkflowEventEntry } from "./workflow-events.js";
// ═══════════════════════════════════════════════════════════════════════════
// ReplayBackend
// ═══════════════════════════════════════════════════════════════════════════
export class ReplayBackend {
    backend;
    constructor(backend) {
        this.backend = backend;
    }
    // ── Single-round lookup ────────────────────────────────────────────────
    getRound(loopId, roundNum) {
        const prefix = `loop:${loopId}:r${roundNum}`;
        const entries = this.backend.queryEntries({ prefix });
        const lineageEntries = entries.filter((e) => !String(e.task_id ?? "").endsWith(":feedback"));
        if (!lineageEntries.length)
            return null;
        const preferred = lineageEntries.find((entry) => entry.task_type === "loop_lineage")
            ?? lineageEntries.find((entry) => entry.task_type === "feedback")
            ?? lineageEntries[0];
        const entry = { ...preferred };
        // Merge feedback success flag
        const fbEntries = this.backend.queryEntries({
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
            const round = Number(lineage.round ?? 0);
            const workflowEvents = this.backend.queryEntries({ prefix: `loop:${loopId}:r${round}:workflow:` });
            const parsedWorkflow = workflowEvents.map(parseWorkflowEventEntry).filter((event) => event !== null);
            const latestWorkflow = parsedWorkflow.at(-1);
            timeline.push({
                round,
                recompile_level: lineage.recompile_level ?? "l2",
                success: entry.success ?? lineage.success ?? false,
                task: lineage.task ?? "",
                goal_id: lineage.goal_id ?? "",
                phase: latestWorkflow?.phase ?? null,
                plan_version: latestWorkflow?.planVersion ?? null,
                active_step_id: latestWorkflow?.activeStepId ?? null,
                workflow_events: parsedWorkflow.map((event) => ({
                    type: event.eventType,
                    step_id: "step_id" in event.payload ? event.payload.step_id : null,
                    step_status: event.eventType === "step_result" ? event.payload.step_status : null,
                })),
            });
        }
        timeline.sort((a, b) => a.round - b.round);
        return timeline;
    }
    graph(loopId, options) {
        const entries = this.backend.queryEntries({ prefix: `loop:${loopId}:` });
        return buildGovernanceGraph(loopId, entries, options);
    }
    // ── Helpers ─────────────────────────────────────────────────────────────
    maxRound(loopId) {
        const prefix = `loop:${loopId}:r`;
        const entries = this.backend.queryEntries({ prefix });
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