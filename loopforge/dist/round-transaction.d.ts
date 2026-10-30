/** Schema-versioned round transaction shared by Runtime and MCP.
 *
 * A logical round has one deterministic roundId. Rejected attempts keep the
 * same identity and before snapshot; only accepted decisions are committed to
 * feedback storage. The committed feedback embeds the decision so replay after
 * a process crash is idempotent.
 */
import type { LoopStore } from "./loop-store.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { CheckpointRef, CompiledRoundFacts, ContractBinding, EvidencePosture, MachineObservation, OperatorAcceptance, PromptArtifact, RecoveryDirective, RecoveryTarget, SelfEvaluation, SubmissionDiagnostic, VerificationFlag, WorkspaceCheckpointManifest } from "./protocol.js";
import { type RoundProcessResult } from "./round-coordinator.js";
import type { RoundCommitStore } from "./storage.js";
/** v3.9.7: schema 5 adds the transaction before-image, explicit mid-round
 *  checkpoints and the redo restore marker. v4.0.3: schema 7 requires the
 *  persisted `EvidencePosture` on every result and adds the transient
 *  `RetryContext`. v4.0.4: schema 8 embeds the schema-10 PromptArtifact
 *  (`fresh_invocation`) and the renamed `SelfEvaluation.agent_stop_reason`;
 *  schema 7 documents are reported as legacy, never migrated or silently
 *  re-read under the new field name. Unsupported versions are reported by
 *  `legacyTransactionRounds`; there is no compatibility migration. */
export declare const ROUND_TRANSACTION_SCHEMA_VERSION: 8;
/** Maximum distinct mid-round checkpoints one transaction may reference. */
export declare const MAX_MID_CHECKPOINTS_PER_TRANSACTION = 32;
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
    recovery?: {
        target: RecoveryTarget;
        reason: string;
        /** v4.0.3: directive facts that distinguish two rollbacks of the same
         *  target/reason (stable, sorted, never arbitrary object order). */
        abandonedRounds?: number[];
        failedRounds?: number[];
        observedSkippedFiles?: string[];
        reportedSkippedFiles?: string[];
        triggerFindings?: string[];
    };
}): string;
export type RoundTransactionPhase = "prepared" | "prompted" | "evaluated" | "rejected" | "committed" | "terminated";
/** v4.0.3: the transient facts a held retry needs, attached to the REJECTED
 *  snapshot before the retry prompt is compiled.
 *
 *  It is in-flight transaction state, never committed history: a rejected
 *  attempt writes no Vault entry, and the retry commit clears this context
 *  together with the evaluation/result of the rejected attempt. Keeping it on
 *  the held snapshot (rather than only in the process that produced the
 *  rejection) is what lets `loopforge_resume`/a stalled retry still know the
 *  attempt number, rejection notice, findings and transient posture.
 *
 *  `attempt` is the attempt the NEXT compile/submission uses — it equals
 *  `rejectedAttempt + 1`. */
export interface RetryContext {
    /** The next attempt; equals `rejectedAttempt + 1`. */
    attempt: number;
    rejectedAttempt: number;
    /** The enforcement gate's protected rejection notice. */
    rejectionNotice: string;
    /** Findings from the rejected attempt — authority for the retry, never for
     *  committed history. */
    verificationFlags: VerificationFlag[];
    /** The rejected attempt's transient evidence posture. It is rendered only
     *  as "not committed" and never enters the Vault, Working Memory or a gate. */
    evidencePosture: EvidencePosture;
    rejectedAt: number;
}
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
    /** v4.0.1: the immutable operator surface, carried byte-identically on every
     *  evaluation transaction and rollback directive. A same-round redo may
     *  replace the numeric round slot, so the fact must travel with each durable
     *  document rather than existing only on the root. */
    operatorAcceptance?: OperatorAcceptance;
    /** v4.0.1: the compile facts that produced this evaluation. Absent on a
     *  rollback directive. */
    compiled?: CompiledRoundFacts;
    /** v3.9.6: committed rollback directive facts (rollback kind only). */
    recovery?: RecoveryDirective;
    result?: RoundProcessResult;
    /** v4.0.3: transient retry facts. Present only on a rejected attempt or its
     *  held retry prompt; never on a committed transaction, a directive or a
     *  terminated attempt. It is cleared before the retry commit. */
    retryContext?: RetryContext;
    /** v3.9.1: every lossy normalization decision for this submission. Saved
     *  with the transaction; strict boundary failures never reach here. */
    normalizationDiagnostics?: SubmissionDiagnostic[];
    /** v3.9.1: the known evaluation paths present in the raw submission. The
     *  receipt uses this manifest; unknown paths live in diagnostics only. */
    submittedFields?: string[];
    /** v3.9.7: the automatic transaction before-image. Required when the
     *  before-phase Git boundary was observed and materialized. */
    beforeCheckpoint?: CheckpointRef;
    /** v3.9.7: explicit machine fact when the automatic before-image failed.
     *  The round may continue; it is simply not a recovery target. */
    beforeCheckpointError?: {
        code: string;
        detail: string;
        at: number;
    };
    /** v3.9.7: Agent-created mid-round savepoints, creation order, capped. */
    checkpoints?: CheckpointRef[];
    /** v3.9.7: only on the redo transaction. Proves this round's before state
     *  was produced by a verified restore of the named directive. The target
     *  checkpoint id/hash live only in the directive. */
    restore?: {
        directiveTransactionId: string;
        redoRound: number;
        verifiedAt: number;
    };
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
    /** v4.0.1: the pre-commit history loaded by the advance path. Absent for
     *  direct callers, which let the round coordinator load it. */
    history?: import("./history.js").CommittedHistory;
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
    /** The in-flight transaction's before-image, for machine backtrack target
     *  mapping. Never a cognitive input. */
    beforeCheckpoint?: CheckpointRef;
    /** Reads a checkpoint manifest from the store (machine backtrack only). */
    resolveCheckpointManifest?: (ref: CheckpointRef) => WorkspaceCheckpointManifest | null;
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
    compiled?: CompiledRoundFacts;
    kind?: "evaluation";
    beforeCheckpoint?: CheckpointRef;
    beforeCheckpointError?: {
        code: string;
        detail: string;
        at: number;
    };
}): RoundTransactionSnapshot;
/** Attach the next prompt attempt to a rejected logical round without changing
 * its identity or evidence baseline. Evaluation fields belong to the previous
 * attempt and are cleared before the Agent receives the retry prompt. */
export declare function prepareRejectedAttempt(rejected: RoundTransactionSnapshot, promptArtifact: PromptArtifact, compiled?: CompiledRoundFacts, operatorAcceptance?: OperatorAcceptance): RoundTransactionSnapshot;
/** v4.0.3: schema 7 structural validation of the persisted evidence posture.
 *  A committed round without a well-formed posture is a HARD break — it is not
 *  committed history and is reported as legacy, never silently re-derived. */
export declare function isEvidencePosture(value: unknown): value is EvidencePosture;
/** v4.0.3: structural validation of the transient retry context. It is only
 *  legal on a rejected attempt or its held retry prompt. */
export declare function isRetryContext(value: unknown): value is RetryContext;
export declare function isProcessResult(value: unknown): value is RoundProcessResult;
/** Parse a persisted snapshot without trusting arbitrary vault data. */
export declare function parseRoundTransactionSnapshot(value: unknown): RoundTransactionSnapshot | null;
export declare class RoundTransactionCoordinator {
    private readonly store;
    private readonly commitStore;
    constructor(store: LoopStore, commitStore?: RoundCommitStore);
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