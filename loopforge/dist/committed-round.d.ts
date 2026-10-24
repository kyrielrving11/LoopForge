/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */
import type { MachineObservation } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { VaultEntry } from "./loop-store.js";
import type { CheckpointRef, CompiledRoundFacts, ContractBinding, ContractTransition, ExecutionReport, LoopRoundResult, OperatorAcceptance, PromptArtifact, RecoveryDirective, RoundContractProposal, RoundOutcome, SelfEvaluation, SubmissionDiagnostic, SubGoalUpdate, VerificationFlag } from "./protocol.js";
import type { RoundProcessResult } from "./round-coordinator.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
export type CommittedAction = "continue" | "stop" | "recovery" | "backtrack";
export interface CommittedRoundView {
    readonly source: "feedback" | "rollback";
    readonly sourceEntry: VaultEntry | Record<string, unknown>;
    readonly loopId: string;
    readonly round: number;
    readonly roundId: string;
    /** v3.9.6: transaction/branch identity. Optional on hand-built/library
     *  views; committed decoders always set them. The branch read model
     *  normalizes a missing kind/branch to an evaluation on the root branch. */
    readonly transactionId?: string;
    readonly branchId?: string;
    readonly kind?: "evaluation" | "rollback";
    /** v3.9.6: evaluation for ordinary work; agent/machine for a directive. */
    readonly origin?: "evaluation" | "agent" | "machine";
    /** v3.9.6: rollback directive facts; null for ordinary evaluation rounds. */
    readonly recovery?: RecoveryDirective | null;
    /** v3.9.7: the transaction's automatic before-image, if one was captured. */
    readonly beforeCheckpoint: CheckpointRef | null;
    /** v3.9.7: Agent-created mid-round savepoints on this transaction. */
    readonly checkpoints: CheckpointRef[];
    /** v3.9.7: present only on a redo transaction that completed a verified
     *  restore. The directive remains the target's one source. */
    readonly restore: RoundTransactionSnapshot["restore"] | null;
    /** Operator-owned immutable acceptance, when this transaction carries it. */
    readonly operatorAcceptance: OperatorAcceptance | null;
    /** v4.0.1: the compile facts stamped at commit, when present. */
    readonly compiled: CompiledRoundFacts | null;
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
    /** v3.9.9: this round's explicit contract redirection, if it declared one.
     *  Read from the committed evaluation; a target the reducer cannot match is
     *  inert, never a reason to close a contract. */
    readonly contractTransition: ContractTransition | null;
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
    /** Effective retirements from the compile that produced this round. */
    readonly compiledRetirements?: string[];
    readonly retractedConstraints?: string[];
    readonly emergedSubtasks?: string[];
    readonly subgoalUpdates?: SubGoalUpdate[];
}
export declare function decodeCommittedRound(entry: VaultEntry): CommittedRoundView | null;
/** v3.9.6: decode a committed rollback directive event. It is a typed event
 *  in the round document, never a normal feedback round. */
export declare function decodeRollbackEvent(entry: VaultEntry): CommittedRoundView | null;
/** Normalize committed history: rollback directives disappear, later records
 * replace earlier records for the same logical round, and output is ascending. */
/** v4.0.1: decode either an ordinary committed round or a rollback event.
 *  There is no merged-lineage representation any more: a committed round is
 *  exactly its durable :feedback envelope, and a rollback is its event. */
export declare function decodeCommittedRecord(entry: unknown): CommittedRoundView | null;
/** THE committed-view → compiler-request projection.
 *
 *  The compiler once received these fields from the caller's mutable
 *  `last_round_result`, which existed on the live path and was absent on
 *  resume/unpause/backtrack compiles. This projection lets one committed
 *  fact source feed every consumer. Optional declarations are read from the
 *  decoded view where it exposes them; `manual_fixes_needed` has no
 *  committed source and stays empty. */
export declare function roundResultFromCommittedRound(view: CommittedRoundView): LoopRoundResult;
/** The ONE pending-directive lookup for a redo round. The directive's
 *  `target.redo_round` is the branch fence, so a deep restore and a
 *  same-round redo match the same way. */
export declare function pendingBacktrackRecord(entries: ReadonlyArray<unknown>, redoRound: number): CommittedRoundView | null;
/** Lineage sub-object of an entry (`loop_lineage`; v3.7: the legacy
 *  top-level `lineage` alias was removed), or {} when absent. */
export declare function entryLineage(entry: unknown): Record<string, unknown>;
export declare function historyRounds(views: Iterable<CommittedRoundView | null>, beforeRound?: number): CommittedRoundView[];
/** v3.9.6: the ONE branch read model. */
export interface BranchView {
    loopId: string;
    branchId: string;
    /** Evaluation rounds on the current branch, ascending. */
    rounds: CommittedRoundView[];
    /** Rollback directives on the chain, chronological. */
    directives: CommittedRoundView[];
    /** The last directive whose child branch has no evaluation commit yet. */
    pendingDirective: CommittedRoundView | null;
}
/** Resolve the current branch from already-decoded committed views. This is
 *  the branch walker itself; `resolveBranch` is only the entry-decoding
 *  wrapper, so a caller that already holds the views (the history loader)
 *  never decodes the same entries twice. */
export declare function resolveBranchViews(records: ReadonlyArray<CommittedRoundView>): BranchView;
/** Resolve the current branch from committed records in the raw entry view.
 *  Decoding happens once here; the walker itself is `resolveBranchViews`. */
export declare function resolveBranch(entries: ReadonlyArray<unknown>): BranchView;
/** v3.9.6: current-branch evaluation rounds. */
export declare function branchRounds(entries: ReadonlyArray<unknown>): CommittedRoundView[];
/** v3.9.6: rollback directive chain. */
export declare function branchDirectives(entries: ReadonlyArray<unknown>): CommittedRoundView[];
/** v3.9.6: the pending directive controlling a redo round. */
export declare function pendingRollbackDirective(entries: ReadonlyArray<unknown>, redoRound?: number): CommittedRoundView | null;
/** v3.9.6: machine deadlock guard. Agent-origin directives never consume it. */
export declare function hasCommittedMachineBacktrack(entries: ReadonlyArray<unknown>, currentRound: number): boolean;
/** v3.9.6: the latest current-branch evaluation round. */
export declare function lastCommittedView(entries: ReadonlyArray<unknown>): CommittedRoundView | null;
/** v3.9.6: live history window = current branch below the round being
 *  compiled. `currentRound` is the round being prepared/submitted. */
export declare function derivationRounds(entries: ReadonlyArray<unknown>, currentRound?: number): CommittedRoundView[];
/** Kept for read-only callers/tests that still inspect the persisted cursor;
 *  branch fencing no longer depends on it. */
export declare function persistedFrontier(entries: ReadonlyArray<unknown>): number | null;
/** v3.9.6: read-only history = current branch rounds. No session frontier,
 *  no numeric fence, no second cursor. */
export declare function readOnlyRounds(entries: ReadonlyArray<unknown>): CommittedRoundView[];
/** v3.9.6: read-only rollback events = committed directive chain. */
export declare function readOnlyRollbacks(entries: ReadonlyArray<unknown>): CommittedRoundView[];
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
//# sourceMappingURL=committed-round.d.ts.map