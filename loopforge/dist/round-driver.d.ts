/** Shared round lifecycle used by Runtime and MCP adapters.
 *
 * The driver owns compile -> state projection -> before evidence and
 * after evidence -> transaction evaluation. Transport-specific concerns such
 * as heartbeats, executor deadlines, MCP leases, and response formatting stay
 * in their adapters.
 */
import type { LoopStore } from "./loop-store.js";
import { LoopForgeEngine } from "./engine.js";
import type { MachineObservation } from "./protocol.js";
import type { LoopForgeRequest, LoopForgeResponse, OperatorAcceptance, PromptArtifact, SelfEvaluation, SubmissionDiagnostic } from "./protocol.js";
import type { RoundTransactionOutcome, RoundTransactionSnapshot } from "./round-transaction.js";
export interface PreparedRound {
    prompt: string;
    artifact?: PromptArtifact;
    level: "l0" | "l1" | "l2";
    evidenceBaseline: MachineObservation[];
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
    consecutiveRejections: number;
    /** L4 (v3.7.x): previous round's rejection check (own-streak basis). */
    lastRejectionCheck?: string;
    /** v3.8.3: trusted round-start entrypoint fingerprints (see RoundProcessInput). */
    entrypointTrust?: Record<string, string>;
    /** v3.9.1: normalization diagnostics and the submitted-field manifest. */
    normalizationDiagnostics?: SubmissionDiagnostic[];
    submittedFields?: string[];
}
export interface CompletedRound {
    outcome: RoundTransactionOutcome;
    actualEvidence: MachineObservation[];
}
export interface CompleteRecoveryInput {
    snapshot: RoundTransactionSnapshot;
    loopId: string;
    /** Built after the after-phase evidence has been collected, because the
     *  directive's skipped-file facts depend on it. */
    buildRecovery: (actualEvidence: MachineObservation[]) => import("./protocol.js").RecoveryDirective;
}
export declare class RoundDriver {
    private readonly engine;
    private readonly store;
    constructor(engine: LoopForgeEngine, store?: LoopStore);
    prepare(request: LoopForgeRequest, loopId: string, round: number, opts?: {
        branchId?: string;
        operatorAcceptance?: OperatorAcceptance;
    }): Promise<PreparedRound | null>;
    private compile;
    /** Compile a fresh prompt for a zero-commit enforcement retry. The logical
     * round ID and before-evidence snapshot remain stable; only attempt changes. */
    prepareRetry(request: LoopForgeRequest, rejected: RoundTransactionSnapshot, rejectionNotice: string, consecutiveRejections: number): Promise<PreparedRound | null>;
    private finishPrepare;
    complete(input: CompleteRoundInput): Promise<CompletedRound>;
    /** v3.9.6: collect the abandoned round's after evidence, then commit the
     *  rollback directive. The Agent has already decided to abandon; this path
     *  never runs verification/enforcement on the abandoned work. */
    completeRecovery(input: CompleteRecoveryInput): Promise<CompletedRound>;
    recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null;
    private collectEvidence;
}
//# sourceMappingURL=round-driver.d.ts.map