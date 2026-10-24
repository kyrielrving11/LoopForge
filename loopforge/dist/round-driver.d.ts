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
import type { BoundaryCapture } from "./git-boundary.js";
import { type LoopCompileRequest, type LoopCompileResponse, type OperatorAcceptance, type PromptArtifact, type SelfEvaluation, type SubmissionDiagnostic } from "./protocol.js";
import type { RoundTransactionOutcome, RoundTransactionSnapshot } from "./round-transaction.js";
import { FileWorkspaceCheckpointStore } from "./workspace-checkpoint.js";
/** A pre-collected before baseline, used by the post-restore redo path. The
 *  boundary is the same pass's Git boundary, so the redo's own before-image
 *  is exactly the verified restored state. */
export interface PreparedBaseline {
    observations: MachineObservation[];
    boundary?: BoundaryCapture;
}
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
    compileResponse?: LoopCompileResponse;
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
    private readonly checkpointStore?;
    private readonly store;
    constructor(engine: LoopForgeEngine, store?: LoopStore, checkpointStore?: FileWorkspaceCheckpointStore | undefined);
    prepare(request: LoopCompileRequest, loopId: string, round: number, opts?: {
        branchId?: string;
        operatorAcceptance?: OperatorAcceptance;
        /** Post-restore baseline: compile only, do not capture again. */
        baseline?: PreparedBaseline;
        /** Set on the redo transaction after a verified restore. */
        restore?: RoundTransactionSnapshot["restore"];
    }): Promise<PreparedRound>;
    private compile;
    /** Compile a fresh prompt for a zero-commit enforcement retry. The logical
     * round ID and before-evidence snapshot remain stable; only attempt changes. */
    prepareRetry(request: LoopCompileRequest, rejected: RoundTransactionSnapshot, rejectionNotice: string, consecutiveRejections: number): Promise<PreparedRound>;
    private finishPrepare;
    /** The ONE coordinator construction for a write. The engine is not a write
     *  dependency. */
    private coordinator;
    complete(input: CompleteRoundInput): Promise<CompletedRound>;
    /** v3.9.6: collect the abandoned round's after evidence, then commit the
     *  rollback directive. The Agent has already decided to abandon; this path
     *  never runs verification/enforcement on the abandoned work. */
    completeRecovery(input: CompleteRecoveryInput): Promise<CompletedRound>;
    recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null;
    private collectEvidence;
}
//# sourceMappingURL=round-driver.d.ts.map