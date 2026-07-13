/** RoundCoordinator — Unified round-boundary state machine (v1.17).
 *
 * Encapsulates the shared round processing pipeline used by both
 * LoopRuntime (runtime.ts) and SessionManager (mcp/session.ts):
 *
 *   verify → enforce → stop decision
 *
 * Before this module, runtime.ts and session.ts each maintained their
 * own copy of the pipeline (~60 lines each). Drift between the two
 * paths (e.g. git verification only wired into one side) was a known
 * risk. The RoundCoordinator is the single source of truth.
 *
 * State transitions:
 *   RoundStarted → EvidenceCaptured → EvaluationSubmitted
 *   → VerificationCompleted → EnforcementDecided
 *
 * Persistence is owned by round-transaction.ts so reject paths remain
 * side-effect free and accepted decisions can be replayed idempotently.
 */
import type { VaultBackend } from "./backends/interface.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { SelfEvaluation, StopReason, VerificationFlag } from "./protocol.js";
/** Input to a single round processing step. */
export interface RoundProcessInput {
    loopId: string;
    task: string;
    currentRound: number;
    maxRounds: number;
    /** The agent's self-evaluation for this round. */
    selfEval: SelfEvaluation;
    /** Whether structured extraction succeeded (false = heuristic fallback). */
    extractionSucceeded: boolean;
    /** The previous round's validated SelfEvaluation (null for round 1). */
    lastSelfEval?: SelfEvaluation;
    /** How many consecutive rounds have been rejected by enforcement. */
    consecutiveRejections: number;
    /** v1.16: Files detected as changed by git diff. null if git unavailable. */
    runtimeFilesChanged?: string[] | null;
    /** v1.18: Evidence snapshots from configured providers. */
    evidenceSnapshots?: ProviderSnapshot[];
    /** Success values from already committed rounds. */
    successTrajectory?: boolean[];
}
/** Result of processing a round through the coordinator. */
export interface RoundProcessResult {
    /** What the caller should do next. */
    action: "continue" | "stop" | "reject" | "terminate";
    /** Reason for stop (set when action is "stop" or "terminate"). */
    stopReason?: StopReason;
    /** Rejection prompt (set when action is "reject"). */
    rejectionPrompt?: string;
    /** Verification flags from this round (for injection into next prompt). */
    verificationFlags: VerificationFlag[];
    /** Enforcement action for observability. */
    enforcementAction?: "accept" | "reject" | "terminate";
    /** Enforcement reason (set when rejected or terminated). */
    enforcementReason?: string;
    /** Whether this round was successful (from selfEval.success). */
    roundSuccess: boolean;
    /** Whether the verification gate returned "contradicted". */
    gateContradicted: boolean;
    /** Updated consecutiveRejections count — caller must persist. */
    newConsecutiveRejections: number;
    /** Which enforcement check fired (set when action is "reject" or "terminate").
     *  Used by callers to track per-rule rejection counters. */
    rejectionCheck?: string;
    /** The selfEval to store as lastSelfEval for the next round
     *  (undefined when action is "reject" — caller should NOT update). */
    newLastSelfEval?: SelfEvaluation;
    /** Whether the caller should push roundSuccess onto the success trajectory.
     *  false when gateContradicted or when action is "reject". */
    shouldPushSuccessTrajectory: boolean;
}
export declare class RoundCoordinator {
    private backend;
    constructor(backend?: VaultBackend);
    /** Process a single round's self-evaluation through the decision pipeline:
     *  verify → enforce → stop decision.
     *
     *  This is the single entry point called by both LoopRuntime and
     *  SessionManager. The caller is responsible for:
     *  - Compiling the next prompt (if action is "continue")
     *  - Managing heartbeat / signal handlers (runtime only)
     *  - Memory injection (both paths, before calling processRound)
     *  - Transactional feedback commit (accepted rounds only)
     *  - State file I/O (both paths, after compiling)
     */
    processRound(input: RoundProcessInput): RoundProcessResult;
}
//# sourceMappingURL=round-coordinator.d.ts.map