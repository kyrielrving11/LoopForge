/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */
import type { MachineObservation } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { VaultEntry } from "./loop-store.js";
import type { ContractBinding, ExecutionReport, LoopRoundResult, PromptArtifact, RoundContractProposal, RoundOutcome, SelfEvaluation, SubmissionDiagnostic, SubGoalUpdate, VerificationFlag } from "./protocol.js";
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
    /** v3.8: derived before→after delta — never persisted (the transaction
     *  stores only the two factual collections). */
    readonly observationDelta: ObservationDelta[];
    /** v3.9.1: persisted normalization metadata. */
    readonly normalizationDiagnostics: SubmissionDiagnostic[];
    readonly submittedFields: string[];
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
export declare function decodeCommittedRound(entry: VaultEntry): CommittedRoundView | null;
/** Decode an in-memory lineage entry after the engine merged its committed
 * feedback. The merged entry MUST carry the embedded transaction snapshot;
 * the old raw top-level evaluation reconstruction is gone, so a partial
 * lineage entry cannot become a second history. */
export declare function decodeMergedRound(entry: unknown): CommittedRoundView | null;
/** Normalize committed history: rollback directives disappear, later records
 * replace earlier records for the same logical round, and output is ascending. */
/** Decode a committed round from either representation: an engine-hydrated
 *  merged lineage entry first (decodeMergedRound), then a durable :feedback
 *  entry. Compile-side callers used to inline this chain as a private
 *  `committedView` helper. */
export declare function decodeRound(entry: unknown): CommittedRoundView | null;
/** THE committed-view → compiler-request projection.
 *
 *  The compiler once received these fields from the caller's mutable
 *  `last_round_result`, which existed on the live path and was absent on
 *  resume/unpause/backtrack compiles. This projection lets one committed
 *  fact source feed every consumer. Optional declarations are read from the
 *  decoded view where it exposes them; `manual_fixes_needed` has no
 *  committed source and stays empty. */
export declare function roundResultFromCommittedRound(view: CommittedRoundView): LoopRoundResult;
/** The ONE pending-backtrack lookup for a redo round.
 *
 *  A backtrack commits at the failed round R, while the redo targets
 *  `backtrackTarget + 1`, which is lower than R for a deep restore. Matching
 *  the decoded target (with the legacy exact-round fallback when the record
 *  carries no target) keeps the recovery boundary AND the Recovery Brief
 *  correct for every backtrack depth. */
export declare function pendingBacktrackRecord(entries: ReadonlyArray<unknown>, redoRound: number): CommittedRoundView | null;
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
/** v3.8.1: the loop's durable round frontier — the session document's
 *  `current_round`. Null when no session document is in the entry set, so
 *  callers fail OPEN rather than inventing a bound. */
export declare function persistedFrontier(entries: ReadonlyArray<unknown>): number | null;
/** v3.8.1: THE window for a READ-ONLY view of a loop — audit, explain, replay,
 *  the projection, the metrics replay. Same decoder and same rollback handling
 *  as `derivationRounds`, plus the bound those callers cannot compute
 *  themselves.
 *
 *  The live paths bound their window at the round being compiled, and that
 *  bound is what keeps a backtracked branch out of this branch's history. A
 *  read-only view has no compile round, so it reads the SAME frontier from the
 *  durable session document and applies it only while a committed rollback
 *  directive is still in effect — a directive stops being history the moment
 *  the redo commit replaces its round's record, which is exactly when the
 *  abandoned rounds have been re-committed and must count again.
 *
 *  With no directive in effect the window stays UNBOUNDED on purpose: after a
 *  stop, terminate or max_rounds the session's `current_round` sits ON the
 *  round it just committed, so bounding there would silently drop the loop's
 *  final round. An unobservable frontier fails open the same way — a read-only
 *  view never invents a fence, it only applies the one the runtime recorded. */
export declare function readOnlyRounds(entries: ReadonlyArray<unknown>): CommittedRoundView[];
/** The machine-evidence set that best represents a committed round: the
 *  after-phase observations (captured post-execution), else the pre-round
 *  baseline. The derived delta is never evidence — it is a change-set view
 *  over these facts, not a second observation collection. */
export declare function machineEvidenceForRound(view: CommittedRoundView): MachineObservation[];
/** v3.8: Rounds whose persisted transaction carries a LEGACY schema version.
 *  A hard version break must be visible, not silent: these rounds drop out of
 *  history views, so audit/status surface them here instead of letting the
 *  loop look complete while rounds are missing. */
export interface LegacyRound {
    round: number;
    schemaVersion: number;
    /** v3.8.1: which versioned envelope rejected the round. All are hard
     *  breaks — a round that fails any check is not committed history — so all
     *  must be REPORTED, not just the transaction one.
     *  v3.9.1 adds "observation": a transaction whose embedded Git/command
     *  observation schema is unsupported. */
    envelope: "transaction" | "prompt_artifact" | "observation";
}
export declare function legacyTransactionRounds(entries: unknown[]): LegacyRound[];
/** The ONE definition of machine Git motion for a single round.
 *
 *  Motion is a non-empty file list, a HEAD that moved across the round, or a
 *  HEAD that landed on the rollback's restore point — restoring the workspace
 *  IS that round's work, and would otherwise read as a round that did
 *  nothing. A clean worktree is not the same thing as no progress:
 *  commit-per-slice workflows leave no file delta even though HEAD advanced.
 *
 *  Observability stays the caller's concern: this answers "did this round
 *  move", never "could the round be observed". The restore-point arm compares
 *  short hashes, the rule `checkBacktrackGitHeadRestore` uses; the
 *  before/after arm compares the observations themselves. */
export declare function gitMotionSignal(input: {
    /** The round's derived Git change set; null means unknown. */
    changedFiles: ReadonlyArray<string> | null;
    headBefore?: string | null;
    headAfter?: string | null;
    restoreTargetHead?: string | null;
}): boolean | null;
/** Git HEAD as a machine observation exposes it, or null when it is silent. */
export declare function observedGitHead(observation: MachineObservation | undefined): string | null;
/** A round's own motion, from its derived Git deltas. A Git boundary that
 *  cannot be compared yields `null` unless HEAD movement or the restore point
 *  independently proves motion. Every Git delta participates: one moving
 *  provider is motion, one undecidable provider makes the aggregate unknown,
 *  and only an all-provider observed no-change is `false`. */
export declare function inFlightGitMotion(deltas: ReadonlyArray<ObservationDelta>, restoreTargetHead?: string): boolean | null;
/** The committed-round form of the same motion rule. Named separately so a
 *  reader can see that prompt freshness never passes an in-flight restore
 *  head (a committed round has no pending backtrack of its own). */
export declare function committedRoundGitMotion(view: CommittedRoundView): boolean | null;
/** Machine-observed git motion for the most recent contiguous window.
 * A clean worktree is not the same thing as no progress: commit-per-slice
 * workflows leave no file delta even though HEAD advanced. Unknown motion in
 * any round makes the window undecidable rather than falsely empty. */
export declare function machineGitMotionSeries(rounds: ReadonlyArray<CommittedRoundView>, currentRound: number, lookback: number): boolean[] | null;
//# sourceMappingURL=committed-round.d.ts.map