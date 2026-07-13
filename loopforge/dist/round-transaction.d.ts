/** Schema-versioned round transaction shared by Runtime and MCP.
 *
 * A logical round has one deterministic roundId. Rejected attempts keep the
 * same identity and before snapshot; only accepted decisions are committed to
 * feedback storage. The committed feedback embeds the decision so replay after
 * a process crash is idempotent.
 */
import type { VaultBackend } from "./backends/interface.js";
import { LoopForgeEngine } from "./engine.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { SelfEvaluation } from "./protocol.js";
import type { PromptArtifact } from "./protocol.js";
import { type RoundProcessResult } from "./round-coordinator.js";
import type { RoundCommitStore } from "./storage.js";
export declare const ROUND_TRANSACTION_SCHEMA_VERSION: 1;
export type RoundTransactionPhase = "prepared" | "prompted" | "evaluated" | "rejected" | "committed" | "terminated";
export interface RoundTransactionSnapshot {
    schemaVersion: typeof ROUND_TRANSACTION_SCHEMA_VERSION;
    roundId: string;
    loopId: string;
    round: number;
    attempt: number;
    phase: RoundTransactionPhase;
    beforeEvidence: ProviderSnapshot[];
    afterEvidence?: ProviderSnapshot[];
    roundEvidence?: ProviderSnapshot[];
    evaluation?: SelfEvaluation;
    result?: RoundProcessResult;
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
    extractionSucceeded: boolean;
    lastSelfEval?: SelfEvaluation;
    consecutiveRejections: number;
    successTrajectory: boolean[];
    actualEvidence: ProviderSnapshot[];
}
export interface RoundTransactionOutcome {
    snapshot: RoundTransactionSnapshot;
    result: RoundProcessResult;
    /** true when a prior committed decision was replayed from the vault. */
    replayed: boolean;
}
export declare function makeRoundId(loopId: string, round: number): string;
export declare function prepareRoundTransaction(loopId: string, round: number, beforeEvidence: ProviderSnapshot[], promptArtifact?: PromptArtifact): RoundTransactionSnapshot;
/** Attach the next prompt attempt to a rejected logical round without changing
 * its identity or evidence baseline. Evaluation fields belong to the previous
 * attempt and are cleared before the Agent receives the retry prompt. */
export declare function prepareRejectedAttempt(rejected: RoundTransactionSnapshot, promptArtifact: PromptArtifact): RoundTransactionSnapshot;
/** Parse a persisted snapshot without trusting arbitrary vault data. */
export declare function parseRoundTransactionSnapshot(value: unknown): RoundTransactionSnapshot | null;
export declare class RoundTransactionCoordinator {
    private readonly engine;
    private readonly backend;
    private readonly commitStore;
    constructor(engine: LoopForgeEngine, backend?: VaultBackend, commitStore?: RoundCommitStore);
    process(input: RoundTransactionInput): RoundTransactionOutcome;
    /** Recover an already committed decision without evaluating or writing. */
    recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null;
    private readCommitted;
    private outcomeFromEntry;
}
//# sourceMappingURL=round-transaction.d.ts.map