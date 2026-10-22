/** ReplayBackend — time-travel queries over loop lineage.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Enables audit, comparison, and timeline analysis of loop rounds.
 */

import { queryLoopEntries } from "./loop-store.js";
import type { LoopStore, VaultEntry } from "./loop-store.js";
import {
  decodeCommittedRound,
  legacyTransactionRounds,
  readOnlyRounds,
} from "./committed-round.js";
import { deriveRoundProgress } from "./progress.js";
import { observedGitHead } from "./git-motion.js";
import type { LegacyRound } from "./committed-round.js";

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
      .find((view) => view?.round === roundNum && view.kind === "evaluation");
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
    const prefix = `loop:${loopId}:r`;
    const feedback = queryLoopEntries(this.store, loopId, {
      prefix,
      feedbackOnly: true,
    });
    const views = new Map(
      readOnlyRounds(feedback).map((view) => [view.round, view]),
    );
    const timeline: Record<string, unknown>[] = [];
    // `replay()` keeps the lineage projection (task/goal/level/full_prompt)
    // while the derived delta comes from the same committed-round view.
    for (const entry of this.replay(loopId)) {
      const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
      const round = typeof lineage.round === "number" ? lineage.round : 0;
      const view = views.get(round);
      const gitDelta = view?.observationDelta.find(
        (item) => item.kind === "git",
      );
      const gitBefore = view?.beforeEvidence.find((item) => item.providerId === "git");
      const gitAfter = view?.afterEvidence.find((item) => item.providerId === "git");
      const progress = view ? deriveRoundProgress(view.observationDelta) : null;
      timeline.push({
        round,
        recompile_level: lineage.recompile_level ?? view?.promptArtifact?.level ?? "l2",
        success: entry.success ?? view?.success ?? false,
        task: (lineage.task as string) ?? "",
        goal_id: lineage.goal_id ?? "",
        // v3.9.1: the shared round delta and Git boundary facts.
        files_changed: gitDelta?.changedFiles ?? null,
        git_change_state: gitDelta === undefined
          ? "not_applicable"
          : gitDelta.changedFiles === null ? "unknown" : "observed",
        head_before: observedGitHead(gitBefore),
        head_after: observedGitHead(gitAfter),
        git_status: gitAfter?.status ?? null,
        // v3.9.7: the shared per-round progress verdict. Window verdicts are
        // not committed facts; this is the only progress value a round owns.
        machine_progress: progress?.state ?? null,
        progress_providers: progress?.providers ?? [],
        // v3.5: the round's declared contract (proposal for the next round),
        // when it committed one — lets replay show the contract arc.
        ...(entry.round_contract
          ? { proposal: entry.round_contract }
          : view?.contractProposal
            ? { proposal: view.contractProposal }
            : {}),
      });
    }
    // Unsupported envelope versions are NOT history. Keep them visible in the
    // timeline instead of letting the loop look shorter than it was.
    for (const legacy of legacyTransactionRounds(feedback)) {
      timeline.push({
        round: legacy.round,
        legacy: true,
        envelope: legacy.envelope,
        schema_version: legacy.schemaVersion,
      });
    }
    timeline.sort((a, b) => (a.round as number) - (b.round as number));
    return timeline;
  }

  /** v3.9.1: explicit legacy-envelope report for the tool envelope. */
  legacyRounds(loopId: string): LegacyRound[] {
    const prefix = `loop:${loopId}:r`;
    return legacyTransactionRounds(
      queryLoopEntries(this.store, loopId, { prefix, feedbackOnly: true }),
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private maxRound(loopId: string): number {
    const prefix = `loop:${loopId}:r`;
    const feedback = queryLoopEntries(this.store, loopId, { prefix, feedbackOnly: true });
    const rounds = readOnlyRounds(feedback);
    return rounds.length > 0 ? rounds[rounds.length - 1]!.round : 0;
  }
}
