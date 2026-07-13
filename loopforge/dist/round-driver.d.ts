/** Shared round lifecycle used by Runtime and MCP adapters.
 *
 * The driver owns compile -> state projection -> before evidence and
 * after evidence -> transaction evaluation. Transport-specific concerns such
 * as heartbeats, executor deadlines, MCP leases, and response formatting stay
 * in their adapters.
 */
import type { VaultBackend } from "./backends/interface.js";
import { LoopForgeEngine } from "./engine.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { LoopForgeRequest, PromptArtifact, SelfEvaluation } from "./protocol.js";
import type { RoundTransactionOutcome, RoundTransactionSnapshot } from "./round-transaction.js";
export interface PreparedRound {
    prompt: string;
    artifact?: PromptArtifact;
    level: "l0" | "l1" | "l2";
    evidenceBaseline: ProviderSnapshot[];
    snapshot: RoundTransactionSnapshot;
    stateFileContent?: string;
}
export interface CompleteRoundInput {
    snapshot: RoundTransactionSnapshot;
    loopId: string;
    task: string;
    maxRounds: number;
    selfEval: SelfEvaluation;
    extractionSucceeded: boolean;
    lastSelfEval?: SelfEvaluation;
    consecutiveRejections: number;
    successTrajectory: boolean[];
}
export interface CompletedRound {
    outcome: RoundTransactionOutcome;
    actualEvidence: ProviderSnapshot[];
}
export declare class RoundDriver {
    private readonly engine;
    private readonly backend;
    constructor(engine: LoopForgeEngine, backend?: VaultBackend);
    prepare(request: LoopForgeRequest, loopId: string, round: number): Promise<PreparedRound | null>;
    /** Synchronous fallback for legacy embedding APIs. Async evidence providers
     * are deliberately skipped by EvidenceCollector.collect(). */
    prepareSync(request: LoopForgeRequest, loopId: string, round: number): PreparedRound | null;
    private compile;
    /** Compile a fresh prompt for a zero-commit enforcement retry. The logical
     * round ID and before-evidence snapshot remain stable; only attempt changes. */
    prepareRetry(request: LoopForgeRequest, rejected: RoundTransactionSnapshot, rejectionNotice: string, consecutiveRejections: number): Promise<PreparedRound | null>;
    private finishPrepare;
    complete(input: CompleteRoundInput): Promise<CompletedRound>;
    recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null;
    private collectEvidence;
}
//# sourceMappingURL=round-driver.d.ts.map