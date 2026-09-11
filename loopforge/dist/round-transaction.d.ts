/** Schema-versioned round transaction shared by Runtime and MCP.
 *
 * A logical round has one deterministic roundId. Rejected attempts keep the
 * same identity and before snapshot; only accepted decisions are committed to
 * feedback storage. The committed feedback embeds the decision so replay after
 * a process crash is idempotent.
 */
import type { LoopStore } from "./loop-store.js";
import { LoopForgeEngine } from "./engine.js";
import type { ContractBinding, MachineObservation } from "./protocol.js";
import type { SelfEvaluation } from "./protocol.js";
import type { PromptArtifact } from "./protocol.js";
import { type RoundProcessResult } from "./round-coordinator.js";
import type { RoundCommitStore } from "./storage.js";
export declare const ROUND_TRANSACTION_SCHEMA_VERSION: 2;
export type RoundTransactionPhase = "prepared" | "prompted" | "evaluated" | "rejected" | "committed" | "terminated";
export interface RoundTransactionSnapshot {
    schemaVersion: typeof ROUND_TRANSACTION_SCHEMA_VERSION;
    roundId: string;
    loopId: string;
    round: number;
    attempt: number;
    phase: RoundTransactionPhase;
    beforeEvidence: MachineObservation[];
    afterEvidence?: MachineObservation[];
    evaluation?: SelfEvaluation;
    result?: RoundProcessResult;
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
    lastSelfEval?: SelfEvaluation;
    consecutiveRejections: number;
    /** L4 (v3.7.x): previous round's rejection check (own-streak basis). */
    lastRejectionCheck?: string;
    successTrajectory: boolean[];
    /** v2.13: Files from skipped backtrack rounds for restore check. */
    backtrackSkippedFiles?: string[];
    /** M3 (v3.7.x): skipped-file git fingerprints at their failed rounds. */
    backtrackSkippedFingerprints?: Record<string, string>;
    /** v2.12: Git HEAD of the backtrack restore point. The verification gate
     *  checks the workspace returns to this commit before accepting work. */
    backtrackTargetGitHead?: string;
    actualEvidence: MachineObservation[];
}
export interface RoundTransactionOutcome {
    snapshot: RoundTransactionSnapshot;
    result: RoundProcessResult;
    /** true when a prior committed decision was replayed from the vault. */
    replayed: boolean;
}
/** v3.8: The round's observation delta (before → after) — files that
 *  appeared, disappeared, or changed content. DERIVED, never persisted: the
 *  transaction stores only the two factual observation collections, and every
 *  reader (gates, metrics, git-motion series, replay, audit) consumes this one
 *  derivation. */
export declare function deriveRoundObservationDelta(before: MachineObservation[], after: MachineObservation[]): MachineObservation[];
/** v3.8: The schema version stamped on a persisted transaction envelope, or
 *  null when the value is not a transaction envelope at all. Used to surface
 *  legacy documents explicitly instead of letting them vanish from history. */
export declare function transactionSchemaVersionOf(value: unknown): number | null;
export declare function makeRoundId(loopId: string, round: number): string;
export declare function prepareRoundTransaction(loopId: string, round: number, beforeEvidence: MachineObservation[], promptArtifact?: PromptArtifact): RoundTransactionSnapshot;
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
    /** Recover an already committed decision without evaluating or writing. */
    recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null;
    private readCommitted;
    private outcomeFromEntry;
}
//# sourceMappingURL=round-transaction.d.ts.map