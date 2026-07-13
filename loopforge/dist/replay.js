/** ReplayBackend — time-travel queries over vault lineage.
 *
 * Depends on VaultBackend interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */
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
        const entry = { ...lineageEntries[0] };
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
            timeline.push({
                round: lineage.round ?? 0,
                recompile_level: lineage.recompile_level ?? "l2",
                success: entry.success ?? lineage.success ?? false,
                task: lineage.task ?? entry.task ?? "",
                goal_id: lineage.goal_id ?? "",
            });
        }
        timeline.sort((a, b) => a.round - b.round);
        return timeline;
    }
    // ── Diff ───────────────────────────────────────────────────────────────
    diff(loopId, roundA, roundB) {
        const entryA = this.getRound(loopId, roundA);
        const entryB = this.getRound(loopId, roundB);
        if (entryA === null && entryB === null) {
            return {
                round_a: roundA,
                round_b: roundB,
                changes: [],
                unchanged: [],
                missing: "both",
            };
        }
        if (entryA === null) {
            return {
                round_a: roundA,
                round_b: roundB,
                changes: [],
                unchanged: [],
                missing: "round_a",
            };
        }
        if (entryB === null) {
            return {
                round_a: roundA,
                round_b: roundB,
                changes: [],
                unchanged: [],
                missing: "round_b",
            };
        }
        const lineageA = (entryA.loop_lineage ?? {});
        const lineageB = (entryB.loop_lineage ?? {});
        const fields = [
            ["goal_id", "Goal ID"],
            ["recompile_level", "Recompile Level"],
            ["success", "Success"],
            ["task", "Task"],
        ];
        const changes = [];
        const unchanged = [];
        for (const [fieldKey, fieldLabel] of fields) {
            const valA = fieldKey in lineageA
                ? lineageA[fieldKey]
                : entryA[fieldKey];
            const valB = fieldKey in lineageB
                ? lineageB[fieldKey]
                : entryB[fieldKey];
            if (valA !== valB) {
                changes.push({
                    field: fieldKey,
                    label: fieldLabel,
                    before: valA,
                    after: valB,
                });
            }
            else {
                unchanged.push(fieldKey);
            }
        }
        // Compare constraints
        const constraintsA = lineageA.constraints_active ?? [];
        const constraintsB = lineageB.constraints_active ?? [];
        const added = constraintsB.filter((c) => !constraintsA.includes(c));
        const removed = constraintsA.filter((c) => !constraintsB.includes(c));
        if (added.length || removed.length) {
            changes.push({
                field: "constraints_active",
                label: "Active Constraints",
                before: constraintsA,
                after: constraintsB,
                added,
                removed,
            });
        }
        else if (JSON.stringify(constraintsA) === JSON.stringify(constraintsB)) {
            unchanged.push("constraints_active");
        }
        return {
            round_a: roundA,
            round_b: roundB,
            changes,
            unchanged,
            missing: null,
        };
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