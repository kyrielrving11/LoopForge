/** Schema-versioned round transaction shared by Runtime and MCP.
 *
 * A logical round has one deterministic roundId. Rejected attempts keep the
 * same identity and before snapshot; only accepted decisions are committed to
 * feedback storage. The committed feedback embeds the decision so replay after
 * a process crash is idempotent.
 */
import type { LoopStore } from "./loop-store.js";
import { LoopForgeEngine } from "./engine.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { ContractBinding, MachineObservation, OperatorAcceptance, PromptArtifact, RecoveryDirective, SelfEvaluation, SubmissionDiagnostic } from "./protocol.js";
import { type RoundProcessResult } from "./round-coordinator.js";
import type { RoundCommitStore } from "./storage.js";
/** v3.9.6: schema 4 adds transaction/branch identity, kind, operator
 *  acceptance and rollback directives. Schema 3 is unsupported. */
export declare const ROUND_TRANSACTION_SCHEMA_VERSION: 4;
/** The root branch identity for every loop. */
export declare function rootBranchId(loopId: string): string;
/** v3.9.6: deterministic transaction identity. The logical round identity is
 *  still `roundId`; this id prevents a deep redo from replaying an abandoned
 *  commit at the same numeric round. */
export declare function deriveTransactionId(input: {
    kind: "evaluation" | "rollback";
    branchId: string;
    roundId: string;
    attempt: number;
    promptHash?: string;
    recovery?: Pick<RecoveryDirective, "target" | "reason" | "target_transaction_id">;
}): string;
export type RoundTransactionPhase = "prepared" | "prompted" | "evaluated" | "rejected" | "committed" | "terminated";
export interface RoundTransactionSnapshot {
    schemaVersion: typeof ROUND_TRANSACTION_SCHEMA_VERSION;
    /** v3.9.6: the transaction's branch. The root branch is
     *  `loop:<loopId>:branch:root`; a rollback directive's transactionId names
     *  the child branch used by its redo and all later transactions. */
    branchId: string;
    /** v3.9.6: stable identity of this transaction. `roundId` remains the
     *  logical round; `transactionId` distinguishes a redo from an abandoned
     *  commit at the same numeric round. */
    transactionId: string;
    /** v3.9.6: evaluations are normal work rounds; rollbacks are directives
     *  that abandon a round without claiming work. */
    kind: "evaluation" | "rollback";
    roundId: string;
    loopId: string;
    round: number;
    attempt: number;
    phase: RoundTransactionPhase;
    beforeEvidence: MachineObservation[];
    afterEvidence?: MachineObservation[];
    evaluation?: SelfEvaluation;
    /** v3.9.6: operator acceptance, written once on the root branch's round 1
     *  evaluation transaction. Absent on every later transaction. */
    operatorAcceptance?: OperatorAcceptance;
    /** v3.9.6: committed rollback directive facts (rollback kind only). */
    recovery?: RecoveryDirective;
    result?: RoundProcessResult;
    /** v3.9.1: every lossy normalization decision for this submission. Saved
     *  with the transaction; strict boundary failures never reach here. */
    normalizationDiagnostics?: SubmissionDiagnostic[];
    /** v3.9.1: the known evaluation paths present in the raw submission. The
     *  receipt uses this manifest; unknown paths live in diagnostics only. */
    submittedFields?: string[];
    /** v3.8: the contract binding resolved at commit time (see ContractBinding).
     *  Absent when the committing round declared no contract. */
    contractBinding?: ContractBinding;
    createdAt: number;
    updatedAt: number;
    /** Exact prompt delivered for the current attempt. */
    promptArtifact?: PromptArtifact;
}
export interface RoundTransactionInput {
    snapshot: RoundTransactionSnapshot;
    task: string;
    maxRounds: number;
    selfEval: SelfEvaluation;
    consecutiveRejections: number;
    /** L4 (v3.7.x): previous round's rejection check (own-streak basis). */
    lastRejectionCheck?: string;
    /** v3.8.3: trusted round-start entrypoint fingerprints (see RoundProcessInput). */
    entrypointTrust?: Record<string, string>;
    /** v3.9.1: normalization metadata carried into the evaluated snapshot. */
    normalizationDiagnostics?: SubmissionDiagnostic[];
    submittedFields?: string[];
    actualEvidence: MachineObservation[];
}
export interface RoundTransactionOutcome {
    snapshot: RoundTransactionSnapshot;
    result: RoundProcessResult;
    /** true when a prior committed decision was replayed from the vault. */
    replayed: boolean;
}
/** v3.9.6: a first-class rollback directive. `snapshot` is the held
 *  evaluation snapshot of the abandoned round; `recovery.transaction_id` is
 *  both the directive transaction and the child branch identity. */
export interface RecoveryTransactionInput {
    snapshot: RoundTransactionSnapshot;
    loopId: string;
    recovery: RecoveryDirective;
    actualEvidence: MachineObservation[];
}
/** v3.8/v3.9.1: The round's observation delta (before → after). Each entry
 *  carries raw before/after references; Git's `changedFiles` is the only
 *  file-change fact and is null when the pair cannot be compared. DERIVED,
 *  never persisted: the transaction stores only the two factual observation
 *  collections, and every reader (gates, metrics, git-motion series, replay,
 *  audit) consumes this one derivation. */
export declare function deriveRoundObservationDelta(before: MachineObservation[], after: MachineObservation[]): ObservationDelta[];
/** v3.8: The schema version stamped on a persisted transaction envelope, or
 *  null when the value is not a transaction envelope at all. Used to surface
 *  legacy documents explicitly instead of letting them vanish from history. */
export declare function transactionSchemaVersionOf(value: unknown): number | null;
export declare function makeRoundId(loopId: string, round: number): string;
export declare function prepareRoundTransaction(loopId: string, round: number, beforeEvidence: MachineObservation[], promptArtifact?: PromptArtifact, opts?: {
    branchId?: string;
    operatorAcceptance?: OperatorAcceptance;
    kind?: "evaluation";
}): RoundTransactionSnapshot;
/** Attach the next prompt attempt to a rejected logical round without changing
 * its identity or evidence baseline. Evaluation fields belong to the previous
 * attempt and are cleared before the Agent receives the retry prompt. */
export declare function prepareRejectedAttempt(rejected: RoundTransactionSnapshot, promptArtifact: PromptArtifact): RoundTransactionSnapshot;
export declare function isProcessResult(value: unknown): value is RoundProcessResult;
/** Parse a persisted snapshot without trusting arbitrary vault data. */
export declare function parseRoundTransactionSnapshot(value: unknown): RoundTransactionSnapshot | null;
export declare class RoundTransactionCoordinator {
    private readonly engine;
    private readonly store;
    private readonly commitStore;
    constructor(engine: LoopForgeEngine, store?: LoopStore, commitStore?: RoundCommitStore);
    process(input: RoundTransactionInput): RoundTransactionOutcome;
    /** v3.9.6: commit an Agent-initiated rollback directive. This path does not
     *  run verification or enforcement: abandoning work is an action, not a
     *  success claim. The directive is a typed event, not a `:feedback` round. */
    commitRecovery(input: RecoveryTransactionInput): RoundTransactionOutcome;
    private readRecoveryCommitted;
    /** Recover an already committed decision without evaluating or writing. */
    recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null;
    private readCommitted;
    private outcomeFromEntry;
}
//# sourceMappingURL=round-transaction.d.ts.map