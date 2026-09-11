/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */
import type { MachineObservation } from "./protocol.js";
import type { VaultEntry } from "./loop-store.js";
import type { ContractBinding, ExecutionReport, PromptArtifact, RoundContractProposal, RoundOutcome, SelfEvaluation, SubGoalUpdate, VerificationFlag } from "./protocol.js";
import type { RoundProcessResult } from "./round-coordinator.js";
export type CommittedAction = "continue" | "stop" | "backtrack";
/** v3.8.1: the rolled-back branch's facts, decoded from a committed rollback
 *  directive. One shape for the compile-side Recovery Brief, the state file's
 *  Recent tier and the rollback prompt — these were three renderers over two
 *  independent derivations (the committed record and an in-memory walk).
 *
 *  Note the target is a RESTORE POINT, not an upper bound: the redo re-commits
 *  the same round numbers the abandoned rounds occupied (round-lifecycle.ts
 *  sets `currentRound = backtrackTarget + 1`), so this is never a window
 *  fence. Abandonment is temporal, not numeric. */
export interface BacktrackRecoveryRecord {
    readonly target: number;
    readonly triggerRule: string;
    readonly failedRounds: number[];
    readonly approaches: string[];
    readonly wrongAssumptions: string[];
    readonly skippedFiles: string[];
    readonly skippedFingerprints: Record<string, string>;
    readonly targetGitHead?: string;
}
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
    readonly executionReport: ExecutionReport | null;
    readonly verificationFlags: VerificationFlag[];
    readonly result: RoundProcessResult | null;
    readonly action: CommittedAction;
    readonly success: boolean;
    readonly outcome: RoundOutcome | null;
    readonly contractProposal: RoundContractProposal | null;
    /** v3.8: the machine binding stamped when the declaring round committed. */
    readonly contractBinding: ContractBinding | null;
    readonly beforeEvidence: MachineObservation[];
    readonly afterEvidence: MachineObservation[];
    /** v3.8: derived before→after delta — never persisted (transaction
     *  schema 2 stores only the two factual collections). */
    readonly observationDelta: MachineObservation[];
    /** v3.8: true when the round committed without after-phase observations —
     *  its machine evidence is incomplete and must never be substituted with
     *  the before baseline. */
    readonly evidenceIncomplete: boolean;
    /** Normalized round-level declarations used by compiler projections. */
    readonly outputSummary?: string;
    readonly constraintViolations?: string[];
    readonly discoveredConstraints?: string[];
    readonly activeConstraints?: string[];
    readonly retractedConstraints?: string[];
    readonly emergedSubtasks?: string[];
    readonly subgoalUpdates?: SubGoalUpdate[];
    /** v3.8.1: present only on a committed rollback directive, null elsewhere.
     *  Decoded from `result.*` on the durable feedback entry and from the
     *  `lineage.backtrack*` stamps on a hydrated merged entry. */
    readonly backtrack: BacktrackRecoveryRecord | null;
}
/** v3.8.1: decode a rollback directive's facts from either carrier —
 *  `result.*` on a durable :feedback entry, `lineage.*` on a hydrated merged
 *  entry. Returns null when no restore point is recorded, which is also the
 *  signal that the record cannot serve as recovery guidance. */
export declare function decodeBacktrackRecord(source: unknown): BacktrackRecoveryRecord | null;
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
/** Extract execution_report from an entry, handling both direct-field and
 *  lineage-nested shapes. The decoded committed view wins when the entry is
 *  a committed round. Returns null when absent. Moved from loop-compiler so
 *  field-shape interpretation lives in this module only. */
export declare function entryExecutionReport(entry: unknown): Record<string, unknown> | null;
/** Read the criteria the agent claimed met from an entry's execution_report. */
export declare function entryCriteriaMet(entry: unknown): string[];
/** Read the criteria the agent declared outstanding from an entry. */
export declare function entryCriteriaRemaining(entry: unknown): string[];
/** Read constraints_active from an entry's lineage. */
export declare function entryActiveConstraints(entry: unknown): string[];
/** Read retracted_constraints from an entry (direct field, else nested in
 *  the lineage). */
export declare function entryRetractedConstraints(entry: unknown): string[];
/** Read progress_estimate from an entry's execution_report (0 when
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
/** v3.8.1: the ONE committed-history window every derivation reads.
 *
 * `decodeRound` (hydrated merged lineage first, then the durable feedback
 * entry) plus the rollback handling in `historyRounds` — so the compile path,
 * the projection, the live coordinator, audit and explain can no longer
 * disagree about which rounds are this branch's history, nor about how their
 * envelope was interpreted.
 *
 * `currentRound` bounds the window exactly as before (default: unbounded). It
 * is NOT a rollback fence: the redo re-commits the round numbers the abandoned
 * rounds occupied, so abandonment is temporal, not numeric, and cannot be
 * expressed as a bound here. */
export declare function derivationRounds(entries: ReadonlyArray<unknown>, currentRound?: number): CommittedRoundView[];
/** The machine-evidence set that best represents a committed round: the
 *  after-phase observations (captured post-execution), else the derived round
 *  delta, else the pre-round baseline. Shared selector for the
 *  evidence-fallback chains that audit, claims, and backtrack-restore each
 *  used to inline with subtly different tiers. Distinct from
 *  machineGitMotionSeries, which deliberately reads the delta alone for the
 *  motion signal. */
export declare function machineEvidenceForRound(view: CommittedRoundView): MachineObservation[];
/** v3.8: Rounds whose persisted transaction carries a LEGACY schema version.
 *  A hard version break must be visible, not silent: these rounds drop out of
 *  history views, so audit/status surface them here instead of letting the
 *  loop look complete while rounds are missing. */
export interface LegacyRound {
    round: number;
    schemaVersion: number;
    /** v3.8.1: which versioned envelope rejected the round. Both are hard
     *  breaks — a round that fails either check is not committed history — so
     *  both must be REPORTED, not just the transaction one. */
    envelope: "transaction" | "prompt_artifact";
}
export declare function legacyTransactionRounds(entries: unknown[]): LegacyRound[];
/** Machine-observed git motion for the most recent contiguous window.
 * Consumers must decode durable or hydrated entries before calling this;
 * transaction-envelope interpretation stays confined to this module. */
export declare function machineGitMotionSeries(rounds: ReadonlyArray<CommittedRoundView>, currentRound: number, lookback: number): boolean[] | null;
//# sourceMappingURL=committed-round.d.ts.map