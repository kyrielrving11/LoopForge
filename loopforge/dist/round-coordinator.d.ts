/** RoundCoordinator — Unified round-boundary state machine (v1.17).
 *
 * Encapsulates the shared round processing pipeline used by
 * SessionManager (mcp/session.ts):
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
import type { LoopStore } from "./loop-store.js";
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
    /** The previous round's validated SelfEvaluation (null for round 1). */
    lastSelfEval?: SelfEvaluation;
    /** How many consecutive rounds have been rejected by enforcement. */
    consecutiveRejections: number;
    /** L4 (v3.7.x): which check rejected the previous round — lets uniform
     *  escalation rows act on their own streak, not an unrelated one. */
    lastRejectionCheck?: string;
    /** v1.18: Evidence snapshots from configured providers. */
    evidenceSnapshots?: ProviderSnapshot[];
    /** Success values from already committed rounds. */
    successTrajectory?: boolean[];
    /** v2.13: Files from skipped backtrack rounds. Passed to verification
     *  gate for post-backtrack workspace restore check. */
    backtrackSkippedFiles?: string[];
    /** M3 (v3.7.x): git fingerprint of each skipped file as recorded at its
     *  failed round — machine proof of "untouched since the rollback" for
     *  the restore check. */
    backtrackSkippedFingerprints?: Record<string, string>;
    /** v2.12: Git HEAD of the backtrack restore point. The verification gate
     *  checks the workspace returns to this commit before accepting work. */
    backtrackTargetGitHead?: string;
}
/** Result of processing a round through the coordinator. */
export interface RoundProcessResult {
    /** What the caller should do next. */
    action: "continue" | "stop" | "reject" | "terminate" | "backtrack";
    /** Reason for stop (set when action is "stop" or "terminate"). */
    stopReason?: StopReason;
    /** Rejection prompt (set when action is "reject"). */
    rejectionPrompt?: string;
    /** v2.10: Backtrack prompt (set when action is "backtrack"). */
    backtrackPrompt?: string;
    /** v2.10: Round to restore state from (set when action is "backtrack"). */
    backtrackTarget?: number;
    /** v2.10: Discovered constraints from skipped rounds to preserve. */
    backtrackSkippedDiscoveries?: string[];
    /** v2.10: Which enforcement rule triggered the backtrack. */
    backtrackTriggerRule?: string;
    /** v3.7.1: Rounds rolled back (exclusive range above the restore point).
     *  Derived from committed facts + the in-flight attempt — rejected
     *  payloads are not durable history and never become a source. */
    backtrackFailedRounds?: number[];
    /** v3.7.1: One approach per failed round (committed output_summary or the
     *  in-flight attempt's), truncated — what must NOT be repeated. */
    backtrackApproaches?: string[];
    /** v3.7.1: Falsified assumptions from the failed rounds. */
    backtrackWrongAssumptions?: string[];
    /** M3 (v3.7.x): per-file git fingerprint at the failed round — lets the
     *  restore check prove a skipped file was never touched since the rollback. */
    backtrackSkippedFingerprints?: Record<string, string>;
    /** Verification flags from this round (for injection into next prompt). */
    verificationFlags: VerificationFlag[];
    /** Enforcement action for observability. */
    enforcementAction?: "accept" | "reject" | "terminate" | "backtrack";
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
    /** v2.12: True when this round's intent_drift was waived via substantive
     *  drift_clarification. The caller uses this to track clarification streaks.
     *  v3.3.1: false when R7 itself rejected/terminated on a weak or missing
     *  clarification (the caller increments the streak); undefined when R7 did
     *  not participate in the decision — a higher-priority rule's rejection
     *  must never touch the streak. */
    clarificationAccepted?: boolean;
    /** v2.13: Git HEAD commit hash of the backtrack target round.
     *  Set when action is "backtrack". The verification gate uses this
     *  to check that the agent restored the workspace before working. */
    backtrackTargetGitHead?: string;
    /** v2.13: Files changed in skipped rounds during backtrack.
     *  The next round's verification gate checks that these files are
     *  not still dirty (agent must restore workspace first). */
    backtrackSkippedFiles?: string[];
}
export declare class RoundCoordinator {
    private store;
    constructor(store?: LoopStore);
    /** Process a single round's self-evaluation through the decision pipeline:
     *  verify → enforce → stop decision.
     *
     *  This is the single entry point called by SessionManager.
     *  The caller is responsible for:
     *  - Compiling the next prompt (if action is "continue")
     *  - Managing heartbeat / signal handlers (runtime only)
     *  - Memory injection (both paths, before calling processRound)
     *  - Transactional feedback commit (accepted rounds only)
     *  - State file I/O (both paths, after compiling)
     *
     * @param driftClarificationStreak v2.12: Current clarification streak
     *  from session state. Passed through to enforceRound for R7 escalation. */
    processRound(input: RoundProcessInput, driftClarificationStreak?: number): RoundProcessResult;
}
//# sourceMappingURL=round-coordinator.d.ts.map