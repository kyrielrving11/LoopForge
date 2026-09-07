/** Shared round lifecycle used by Runtime and MCP adapters.
 *
 * The driver owns compile -> state projection -> before evidence and
 * after evidence -> transaction evaluation. Transport-specific concerns such
 * as heartbeats, executor deadlines, MCP leases, and response formatting stay
 * in their adapters.
 */
import type { LoopStore } from "./loop-store.js";
import { LoopForgeEngine } from "./engine.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { LoopForgeRequest, LoopForgeResponse, PromptArtifact, SelfEvaluation } from "./protocol.js";
import type { RoundTransactionOutcome, RoundTransactionSnapshot } from "./round-transaction.js";
export interface PreparedRound {
    prompt: string;
    artifact?: PromptArtifact;
    level: "l0" | "l1" | "l2";
    evidenceBaseline: ProviderSnapshot[];
    snapshot: RoundTransactionSnapshot;
    stateFileContent?: string;
    warnings?: string[];
    /** v3.0.1: The full compile response. Callers may cache it (e.g. for the
     *  typed projection) instead of recompiling for derived views. */
    compileResponse?: LoopForgeResponse;
}
export interface CompleteRoundInput {
    snapshot: RoundTransactionSnapshot;
    loopId: string;
    task: string;
    maxRounds: number;
    selfEval: SelfEvaluation;
    lastSelfEval?: SelfEvaluation;
    consecutiveRejections: number;
    /** L4 (v3.7.x): previous round's rejection check (own-streak basis). */
    lastRejectionCheck?: string;
    successTrajectory: boolean[];
    /** v2.12: Current clarification streak for R7 escalation. */
    driftClarificationStreak?: number;
    /** v2.13: Files from skipped backtrack rounds for restore check. */
    backtrackSkippedFiles?: string[];
    /** M3 (v3.7.x): skipped-file git fingerprints at their failed rounds. */
    backtrackSkippedFingerprints?: Record<string, string>;
    /** v2.12: Git HEAD of the backtrack restore point (workspace restore check). */
    backtrackTargetGitHead?: string;
}
export interface CompletedRound {
    outcome: RoundTransactionOutcome;
    actualEvidence: ProviderSnapshot[];
}
export declare class RoundDriver {
    private readonly engine;
    private readonly store;
    constructor(engine: LoopForgeEngine, store?: LoopStore);
    prepare(request: LoopForgeRequest, loopId: string, round: number): Promise<PreparedRound | null>;
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