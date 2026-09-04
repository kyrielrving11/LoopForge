/** ReplayBackend — time-travel queries over loop lineage.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */

import { queryLoopEntries } from "./loop-store.js";
import type { LoopStore, VaultEntry } from "./loop-store.js";
import { committedRoundsFromEntries, decodeCommittedRound } from "./committed-round.js";

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

    const fbEntries = queryLoopEntries(this.store, loopId, {
      prefix,
      feedbackOnly: true,
    });
    const committed = fbEntries.map(decodeCommittedRound)
      .find((view) => view?.round === roundNum && view.action !== "backtrack");
    if (!committed) return null;
    const base = lineageEntries[0] ?? committed.sourceEntry;
    const entry = { ...base } as VaultEntry;
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
    const feedback = queryLoopEntries(this.store, loopId, { prefix, feedbackOnly: true });
    const rounds = committedRoundsFromEntries(feedback);
    return rounds.length > 0 ? rounds[rounds.length - 1]!.round : 0;
  }
}
