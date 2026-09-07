/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { VaultEntry } from "./loop-store.js";
import type { ExecutionEvidence, PromptArtifact, RoundContract, RoundOutcome, SelfEvaluation, SubGoalUpdate, VerificationFlag } from "./protocol.js";
import type { RoundProcessResult } from "./round-coordinator.js";
export type CommittedAction = "continue" | "stop" | "backtrack";
export interface CommittedRoundView {
    readonly source: "feedback" | "merged";
    readonly sourceEntry: VaultEntry | Record<string, unknown>;
    readonly loopId: string;
    readonly round: number;
    readonly roundId: string;
    readonly sequence?: number;
    readonly attempt: number;
    readonly promptArtifact: PromptArtifact | null;
    readonly evaluation: SelfEvaluation | null;
    readonly executionEvidence: ExecutionEvidence | null;
    readonly verificationFlags: VerificationFlag[];
    readonly result: RoundProcessResult | null;
    readonly action: CommittedAction;
    readonly success: boolean;
    readonly outcome: RoundOutcome | null;
    readonly contractProposal: RoundContract | null;
    readonly beforeEvidence: ProviderSnapshot[];
    readonly afterEvidence: ProviderSnapshot[];
    readonly roundEvidence: ProviderSnapshot[];
    /** Normalized round-level declarations used by compiler projections. */
    readonly outputSummary?: string;
    readonly constraintViolations?: string[];
    readonly discoveredConstraints?: string[];
    readonly activeConstraints?: string[];
    readonly retractedConstraints?: string[];
    readonly emergedSubtasks?: string[];
    readonly subgoalUpdates?: SubGoalUpdate[];
}
/** Decode a durable :feedback entry. Reject/terminate/in-flight envelopes are
 * not committed history and therefore do not produce a view. */
export declare function decodeCommittedRound(entry: VaultEntry): CommittedRoundView | null;
/** Decode an in-memory lineage entry after the engine merged its committed
 * feedback. The merged shape is intentionally accepted only when stamped
 * with committed_action. */
export declare function decodeMergedRound(entry: unknown): CommittedRoundView | null;
/** Normalize committed history: rollback directives disappear, later records
 * replace earlier records for the same logical round, and output is ascending. */
/** Decode a committed round from either representation: an engine-hydrated
 *  merged lineage entry first (decodeMergedRound), then a durable :feedback
 *  entry. Compile-side callers used to inline this chain as a private
 *  `committedView` helper. */
export declare function decodeRound(entry: unknown): CommittedRoundView | null;
/** Lineage sub-object of an entry (`loop_lineage`; v3.7: the legacy
 *  top-level `lineage` alias was removed), or {} when absent. */
export declare function entryLineage(entry: unknown): Record<string, unknown>;
/** Extract execution_evidence from an entry, handling both direct-field and
 *  lineage-nested shapes. The decoded committed view wins when the entry is
 *  a committed round. Returns null when absent. Moved from loop-compiler so
 *  field-shape interpretation lives in this module only. */
export declare function entryExecutionEvidence(entry: unknown): Record<string, unknown> | null;
/** Read success_criteria_met from an entry's execution_evidence. */
export declare function entryCriteriaMet(entry: unknown): string[];
/** Read success_criteria_remaining from an entry's execution_evidence. */
export declare function entryCriteriaRemaining(entry: unknown): string[];
/** Read constraints_active from an entry's lineage. */
export declare function entryActiveConstraints(entry: unknown): string[];
/** Read retracted_constraints from an entry (direct field, else nested in
 *  the lineage). */
export declare function entryRetractedConstraints(entry: unknown): string[];
/** Read progress_estimate from an entry's execution_evidence (0 when
 *  absent). */
export declare function entryProgressEstimate(entry: unknown): number;
/** Read emerged_subtasks from an entry (handles direct + lineage nesting). */
export declare function entryEmergedSubtasks(entry: unknown): string[];
/** Read subgoal_updates from an entry (handles direct + lineage nesting).
 *  v3.7.1: committed status transitions are replayed in round order by the
 *  compiler — every derivation replays ALL committed rounds, not just the
 *  last one. */
export declare function entrySubGoalUpdates(entry: unknown): SubGoalUpdate[];
/** Read constraint_violations from an entry (entry-level, stored from the
 *  previous round's last_round_result at persist time — distinct from the
 *  evaluation-level violations on the committed view). Moved from
 *  verification-gate so lineage-shape reads live in this module only. */
export declare function entryViolations(entry: unknown): string[];
export declare function historyRounds(views: Iterable<CommittedRoundView | null>, beforeRound?: number): CommittedRoundView[];
export declare function committedRoundsFromEntries(entries: VaultEntry[], beforeRound?: number): CommittedRoundView[];
/** The machine-evidence set that best represents a committed round: the
 *  after-phase evidence (captured post-execution), else the round's committed
 *  diff evidence, else the pre-round baseline. Shared selector for the
 *  evidence-fallback chains that audit, claims, and backtrack-restore each
 *  used to inline with subtly different tiers — the enforcement-gate variant
 *  previously skipped roundEvidence entirely. Distinct from
 *  machineGitMotionSeries, which deliberately reads roundEvidence alone for
 *  the diffed motion signal. */
export declare function machineEvidenceForRound(view: CommittedRoundView): ProviderSnapshot[];
export declare function mergedRoundsFromEntries(entries: unknown[], beforeRound?: number): CommittedRoundView[];
/** Machine-observed git motion for the most recent contiguous window.
 * Consumers must decode durable or hydrated entries before calling this;
 * transaction-envelope interpretation stays confined to this module. */
export declare function machineGitMotionSeries(rounds: ReadonlyArray<CommittedRoundView>, currentRound: number, lookback: number): boolean[] | null;
//# sourceMappingURL=committed-round.d.ts.map