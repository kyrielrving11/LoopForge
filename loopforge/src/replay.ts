/** ReplayBackend — time-travel queries over loop lineage.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */

import { queryLoopEntries } from "./loop-store.js";
import type { LoopStore, VaultEntry } from "./loop-store.js";
import { parseRoundContract } from "./self-eval.js";

// ═══════════════════════════════════════════════════════════════════════════
// ReplayBackend
// ═══════════════════════════════════════════════════════════════════════════

export class ReplayBackend {
  private readonly store: LoopStore;

  constructor(store: LoopStore) {
    this.store = store;
  }

  // ── Single-round lookup ────────────────────────────────────────────────

  getRound(loopId: string, roundNum: number): VaultEntry | null {
    const prefix = `loop:${loopId}:r${roundNum}`;
    const entries = queryLoopEntries(this.store, loopId, { prefix });

    const lineageEntries = entries.filter(
      (e) => !String(e.task_id ?? "").endsWith(":feedback"),
    );

    if (!lineageEntries.length) return null;

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
        const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
        (lineage as Record<string, unknown>).success = fbSuccess;
        entry.loop_lineage = lineage;
      }
      // v3.5: surface the round's DECLARED Round Contract (the committed
      // proposal) so replay/timeline can follow the contract arc. The
      // contract lives only in the transaction snapshot — read it
      // defensively and keep the parsed shape (same normalization the
      // verification gate applies).
      const raw = fbEntries[0] as unknown as Record<string, unknown>;
      const fbLineage = raw.loop_lineage;
      if (fbLineage && typeof fbLineage === "object" && !Array.isArray(fbLineage)) {
        const tx = (fbLineage as Record<string, unknown>).round_transaction;
        if (tx && typeof tx === "object" && !Array.isArray(tx)) {
          const snapshot = (tx as Record<string, unknown>).snapshot;
          if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
            const evaluation = (snapshot as Record<string, unknown>).evaluation;
            if (evaluation && typeof evaluation === "object" && !Array.isArray(evaluation)) {
              const proposal = parseRoundContract(
                (evaluation as Record<string, unknown>).round_contract,
              );
              if (proposal) entry.round_contract = proposal;
            }
          }
        }
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
        success: entry.success ?? lineage.success ?? false,
        task: (lineage.task as string) ?? "",
        goal_id: lineage.goal_id ?? "",
        // v3.5: the round's declared contract (proposal for the next round),
        // when it committed one — lets replay show the contract arc.
        ...(entry.round_contract ? { proposal: entry.round_contract } : {}),
      });
    }

    timeline.sort((a, b) => (a.round as number) - (b.round as number));
    return timeline;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private maxRound(loopId: string): number {
    const prefix = `loop:${loopId}:r`;
    const entries = queryLoopEntries(this.store, loopId, { prefix });
    let maxR = 0;

    for (const e of entries) {
      const lineage = (e.loop_lineage ?? {}) as Record<string, unknown>;
      const rnd = lineage.round as number;
      if (typeof rnd === "number" && rnd > maxR) maxR = rnd;
    }

    return maxR;
  }
}
