/** ReplayBackend — time-travel queries over committed rounds.
 *
 * Depends on LoopStore interface — no direct filesystem access.
 * Every query loads the same committed history once and reads the branch's
 * `CommittedRoundView`s; there is no second decode pass and no synthesized
 * lineage-shaped entry.
 */
import { loadCommittedHistory } from "./history.js";
import { deriveRoundProgress } from "./progress.js";
import { observedGitHead } from "./git-motion.js";
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
        const history = loadCommittedHistory(this.store, loopId);
        return history.rounds.find((view) => view.kind === "evaluation" && view.round === roundNum) ?? null;
    }
    // ── Multi-round replay ─────────────────────────────────────────────────
    replay(loopId, opts) {
        const start = opts?.start ?? 1;
        const end = opts?.end ?? Number.POSITIVE_INFINITY;
        return loadCommittedHistory(this.store, loopId).rounds.filter((view) => view.kind === "evaluation" && view.round >= start && view.round <= end);
    }
    // ── Timeline ──────────────────────────────────────────────────────────
    timeline(loopId) {
        // ONE history read feeds the whole timeline: rounds, branch and legacy
        // report are already decoded. `replay()` is not called per round.
        const history = loadCommittedHistory(this.store, loopId);
        const timeline = [];
        for (const view of history.rounds) {
            if (view.kind !== "evaluation")
                continue;
            const gitDelta = view.observationDelta.find((item) => item.kind === "git");
            const gitBefore = view.beforeEvidence.find((item) => item.providerId === "git");
            const gitAfter = view.afterEvidence.find((item) => item.providerId === "git");
            // v3.9.9: replay is a display surface, so it selects every fact. The
            // per-fact list below makes the coverage of each fact visible.
            const progress = deriveRoundProgress(view.observationDelta);
            const progressFacts = view.observationDelta
                .filter((delta) => delta.progress !== null)
                .map((delta) => ({
                kind: delta.progress.kind,
                providerId: delta.providerId,
                coverage: delta.progress.coverage,
                state: delta.progress.state,
                complete: delta.progress.complete,
            }));
            timeline.push({
                round: view.round,
                recompile_level: view.promptArtifact?.level ?? "l2",
                success: view.success,
                // v4.0.1: task and goal identity are compile facts stamped at commit.
                task: view.compiled?.task ?? "",
                goal_id: view.compiled?.goalId ?? "",
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
                progress_coverages: progress?.coverages ?? [],
                progress_facts: progressFacts,
                // v3.5: the round's declared contract (proposal for the next round),
                // when it committed one — lets replay show the contract arc.
                ...(view.contractProposal ? { proposal: view.contractProposal } : {}),
                // v3.9.9: the committed redirect, report-only.
                contract_transition: view.contractTransition ?? null,
            });
        }
        // Unsupported envelope versions are NOT history. Keep them visible in the
        // timeline instead of letting the loop look shorter than it was.
        for (const legacy of history.legacyRounds) {
            timeline.push({
                round: legacy.round,
                legacy: true,
                envelope: legacy.envelope,
                schema_version: legacy.schemaVersion,
            });
        }
        timeline.sort((a, b) => a.round - b.round);
        return timeline;
    }
    /** v3.9.1: explicit legacy-envelope report for the tool envelope. */
    legacyRounds(loopId) {
        return loadCommittedHistory(this.store, loopId).legacyRounds;
    }
}
//# sourceMappingURL=replay.js.map