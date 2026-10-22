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
import type { LoopStore, VaultEntry } from "./loop-store.js";
import type { MachineObservation } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { SelfEvaluation, RoundVerificationStatus, StopReason, VerificationFlag } from "./protocol.js";
import { type ContractItemStatusView } from "./contract-items.js";
/** Input to a single round processing step. */
export interface RoundProcessInput {
    loopId: string;
    task: string;
    currentRound: number;
    maxRounds: number;
    /** The agent's self-evaluation for this round. */
    selfEval: SelfEvaluation;
    /** How many consecutive rounds have been rejected by enforcement. */
    consecutiveRejections: number;
    /** L4 (v3.7.x): which check rejected the previous round — lets uniform
     *  escalation rows act on their own streak, not an unrelated one. */
    lastRejectionCheck?: string;
    /** v1.18: Evidence snapshots from configured providers. */
    evidenceDeltas?: ObservationDelta[];
    /** Full round-start observations for post-backtrack restore validation. */
    beforeEvidence?: MachineObservation[];
    /** v3.8.3: the trusted round-start fingerprint of every configured
     *  command's entrypoint files, captured when this round was prepared. Only
     *  the in-flight round has one — a round whose preparation predates the
     *  baseline (or whose session lost it) simply runs without the absolute
     *  arm and falls back to the git-delta rule. */
    entrypointTrust?: Record<string, string>;
    /** v3.9.4: the persisted submitted-field manifest. The files-reconciliation
     *  gate uses the same `execution_report.files_changed` attempt basis as the
     *  receipt; undefined keeps the legacy "report exists" fallback. */
    submittedFields?: string[];
}
/** Result of processing a round through the coordinator. */
export interface RoundProcessResult {
    /** What the caller should do next. */
    action: "continue" | "stop" | "reject" | "terminate" | "backtrack" | "recovery";
    /** v3.9.6: who produced the disposition. Evaluations are ordinary work;
     *  machine/agent recoveries are rollback directives. */
    origin?: "evaluation" | "machine" | "agent";
    /** v3.9.6: machine failure reason or agent recovery reason. */
    reason?: string;
    /** v3.9.6: committed rollback directive facts. */
    recovery?: import("./protocol.js").RecoveryDirective;
    /** Reason for stop (set when action is "stop" or "terminate"). */
    stopReason?: StopReason;
    /** Rejection prompt (set when action is "reject"). */
    rejectionPrompt?: string;
    /** Verification flags from this round (for injection into next prompt). */
    verificationFlags: VerificationFlag[];
    /** Enforcement action for observability. */
    enforcementAction?: "accept" | "reject" | "terminate" | "backtrack" | "recovery";
    /** Enforcement reason (set when rejected or terminated). */
    enforcementReason?: string;
    /** Whether this round was successful (from selfEval.success). */
    roundSuccess: boolean;
    /** Whether the verification gate returned "contradicted". */
    gateContradicted: boolean;
    /** v3.8: The round-level verification posture, derived from the ACTIVE
     *  contract's item statuses and this round's claims: `trusted` (everything
     *  claimed is machine-backed), `insufficient` (claims unbacked, nothing
     *  contradicted), `contradicted` (a machine fact denies a claim). */
    verificationStatus: RoundVerificationStatus;
    /** Updated consecutiveRejections count — caller must persist. */
    newConsecutiveRejections: number;
    /** Which enforcement check fired (set when action is "reject" or "terminate").
     *  Used by callers to track per-rule rejection counters. */
    rejectionCheck?: string;
    /** Whether the caller should push roundSuccess onto the success trajectory.
     *  false when gateContradicted or when action is "reject". */
    shouldPushSuccessTrajectory: boolean;
}
/** v3.8.3: Completion truth as a guard, not a convention.
 *
 *  A round that declares itself blocked is NOT a finished round — whatever
 *  else it claims — and neither is one whose contract closed on a `blocked`
 *  outcome. The stop decision below already orders `declaredBlocked` first,
 *  and `contractClosed` admits only `verified` or no contract, so this can
 *  never fire on the ordinary path. It is the SECOND line, called at the two
 *  points where the reason becomes durable or visible:
 *
 *  - the coordinator, BEFORE the transaction commits — the committed round
 *    document carries `result.stopReason`, so an unguarded reason here would
 *    be a false fact in the Vault, not just a wrong reply;
 *  - the lifecycle end, where the disposition is finalized into the reported
 *    stop reason and the terminal notification.
 *
 *  A violation can only mean a code defect routed a blocked round to
 *  `completed`. Throwing mid-lifecycle would kill the loop over a reporting
 *  bug, so the guard degrades to the honest reason and returns the downgrade
 *  as a flag: the loop keeps a truthful, observable stop instead of a false
 *  completion. */
export declare function finalizeStopReason(
/** `undefined` when the disposition named no terminal reason at all (the
 *  callers fall back to their own default) — there is nothing to guard. */
reason: StopReason | undefined, selfEval: SelfEvaluation, contractStatuses?: ContractItemStatusView | null): {
    reason: StopReason | undefined;
    flags: VerificationFlag[];
};
/** v3.8.1: The rolled-back branch's facts — the ONE derivation of which rounds
 *  failed, which approaches must not be repeated, which assumptions were
 *  falsified, and which files (with their failed-round git fingerprints) the
 *  agent must restore.
 *
 *  Sources are COMMITTED rounds above the restore point; rejected attempts are
 *  not durable history and never become a source. The in-flight attempt that
 *  triggered the rollback is the one exception — its evaluation lives in this
 *  process, not in committed history.
 *
 *  Extracted from the coordinator's inline walk so it is unit-testable without
 *  driving a whole rollback, and so the prompt, the state file and the
 *  committed decision all describe one event. */
export declare function deriveBacktrackRecoveryFacts(input: {
    currentRound: number;
    restoreRound: number;
    vaultEntries: VaultEntry[];
    selfEval: SelfEvaluation;
}): {
    skippedFiles: string[];
    skippedFingerprints: Record<string, string>;
    skippedDiscoveries: string[];
    failedRounds: number[];
    approaches: string[];
    wrongAssumptions: string[];
};
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
     *  - State file I/O (both paths, after compiling) */
    processRound(input: RoundProcessInput): RoundProcessResult;
}
//# sourceMappingURL=round-coordinator.d.ts.map