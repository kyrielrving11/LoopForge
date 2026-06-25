/** ReplayBackend — time-travel queries over vault lineage.
 *
 * Depends on VaultBackend interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 *
 * Python reference: replay.py (~247 lines)
 */

import type { VaultBackend, VaultEntry } from "./backends/interface.js";

// ═══════════════════════════════════════════════════════════════════════════
// ReplayBackend
// ═══════════════════════════════════════════════════════════════════════════

export class ReplayBackend {
  private readonly backend: VaultBackend;

  constructor(backend: VaultBackend) {
    this.backend = backend;
  }

  // ── Single-round lookup ────────────────────────────────────────────────

  getRound(loopId: string, roundNum: number): VaultEntry | null {
    const prefix = `loop:${loopId}:r${roundNum}`;
    const entries = this.backend.queryEntries({ prefix });

    const lineageEntries = entries.filter(
      (e) => !String(e.task_id ?? "").endsWith(":feedback"),
    );

    if (!lineageEntries.length) {
      // Try Markdown fallback
      const mdResults = this.backend.scanLineageMd(loopId);
      for (const entry of mdResults) {
        const lineage = entry.loop_lineage ?? {};
        if (lineage.round === roundNum) return entry;
      }
      return null;
    }

    const entry = { ...lineageEntries[0] };

    // Enrich with full prompt from Markdown
    if (!entry.full_prompt) {
      const mdContent = this.backend.readLineageMd(loopId, roundNum);
      if (mdContent) entry.full_prompt = mdContent;
    }

    // Merge feedback quality_score
    const fbEntries = this.backend.queryEntries({
      prefix,
      feedbackOnly: true,
    });
    if (fbEntries.length) {
      const fbScore = fbEntries[0].quality_score ?? 0;
      if (fbScore) {
        entry.quality_score = fbScore;
        const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
        lineage.quality_score = fbScore;
        entry.loop_lineage = lineage;
      }
    }

    return entry;
  }

  // ── Multi-round replay ─────────────────────────────────────────────────

  replay(
    loopId: string,
    opts?: { start?: number; end?: number },
  ): VaultEntry[] {
    const start = opts?.start ?? 1;
    let end = opts?.end;
    if (end === undefined) {
      end = this.maxRound(loopId);
      if (end === 0) return [];
    }

    const results: VaultEntry[] = [];
    for (let rnd = start; rnd <= end; rnd++) {
      const entry = this.getRound(loopId, rnd);
      if (entry) results.push(entry);
    }
    return results;
  }

  // ── Timeline ──────────────────────────────────────────────────────────

  timeline(loopId: string): Record<string, unknown>[] {
    const entries = this.replay(loopId);
    const timeline: Record<string, unknown>[] = [];

    for (const entry of entries) {
      const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
      timeline.push({
        round: lineage.round ?? 0,
        recompile_level: lineage.recompile_level ?? "l2",
        technique_used:
          entry.technique_used ?? lineage.technique_used ?? "",
        quality_score: entry.quality_score ?? lineage.quality_score ?? 0,
        task: lineage.task ?? entry.task ?? "",
        goal_id: lineage.goal_id ?? "",
      });
    }

    timeline.sort((a, b) => (a.round as number) - (b.round as number));
    return timeline;
  }

  // ── Diff ───────────────────────────────────────────────────────────────

  diff(
    loopId: string,
    roundA: number,
    roundB: number,
  ): Record<string, unknown> {
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

    const lineageA =
      (entryA.loop_lineage ?? {}) as Record<string, unknown>;
    const lineageB =
      (entryB.loop_lineage ?? {}) as Record<string, unknown>;

    const fields: [string, string][] = [
      ["goal_id", "Goal ID"],
      ["recompile_level", "Recompile Level"],
      ["technique_used", "Technique"],
      ["quality_score", "Quality Score"],
      ["task", "Task"],
    ];

    const changes: Record<string, unknown>[] = [];
    const unchanged: string[] = [];

    for (const [fieldKey, fieldLabel] of fields) {
      const valA =
        fieldKey in lineageA
          ? lineageA[fieldKey]
          : (entryA as Record<string, unknown>)[fieldKey];
      const valB =
        fieldKey in lineageB
          ? lineageB[fieldKey]
          : (entryB as Record<string, unknown>)[fieldKey];

      if (valA !== valB) {
        changes.push({
          field: fieldKey,
          label: fieldLabel,
          before: valA,
          after: valB,
        });
      } else {
        unchanged.push(fieldKey);
      }
    }

    // Compare constraints
    const constraintsA = (lineageA.constraints_active as string[]) ?? [];
    const constraintsB = (lineageB.constraints_active as string[]) ?? [];
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
    } else if (
      JSON.stringify(constraintsA) === JSON.stringify(constraintsB)
    ) {
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

  private maxRound(loopId: string): number {
    const prefix = `loop:${loopId}:r`;
    const entries = this.backend.queryEntries({ prefix });
    let maxR = 0;

    for (const e of entries) {
      const lineage = (e.loop_lineage ?? {}) as Record<string, unknown>;
      const rnd = lineage.round as number;
      if (typeof rnd === "number" && rnd > maxR) maxR = rnd;
    }

    // Also check Markdown fallback
    if (maxR === 0) {
      const mdEntries = this.backend.scanLineageMd(loopId);
      for (const e of mdEntries) {
        const lineage = (e.loop_lineage ?? {}) as Record<string, unknown>;
        const rnd = lineage.round as number;
        if (typeof rnd === "number" && rnd > maxR) maxR = rnd;
      }
    }
    return maxR;
  }
}
