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
import { verifySelfEvaluation } from "./verification-gate.js";
import { enforceRound, buildRejectionPrompt } from "./enforcement-gate.js";
import { logEvent } from "./observability.js";
import { getPolicy } from "./policy.js";
// ── RoundCoordinator ───────────────────────────────────────────────────────
export class RoundCoordinator {
    backend;
    constructor(backend) {
        this.backend = backend;
    }
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
     */
    processRound(input) {
        const { loopId, task, currentRound, maxRounds, selfEval, extractionSucceeded, lastSelfEval, consecutiveRejections, runtimeFilesChanged, evidenceSnapshots, } = input;
        const roundSuccess = selfEval.success ?? false;
        // ── 1. Query vault entries ──────────────────────────────────────────
        const vaultEntries = this.backend
            ? this.backend.queryEntries({ prefix: `loop:${loopId}:r` })
            : [];
        // ── 2. Verification gate ────────────────────────────────────────────
        const verifyResult = verifySelfEvaluation(selfEval, currentRound, vaultEntries, lastSelfEval ?? null, runtimeFilesChanged ?? null, evidenceSnapshots ?? []);
        const verificationFlags = verifyResult.flags;
        const gateContradicted = verifyResult.verdict === "contradicted";
        if (gateContradicted) {
            logEvent("gate_contradicted", {
                loopId,
                round: currentRound,
                flags: verificationFlags.map((f) => f.check),
            });
        }
        // ── 3. Enforcement gate (structured extractions only) ───────────────
        // Heuristic evaluations have no reliable execution_evidence —
        // enforcement rules that depend on evidence are skipped.
        if (extractionSucceeded) {
            const enforceResult = enforceRound(selfEval, verifyResult, currentRound, vaultEntries, consecutiveRejections);
            if (enforceResult.action === "reject") {
                const newRejections = consecutiveRejections + 1;
                const rejectionPrompt = buildRejectionPrompt(currentRound, task, enforceResult);
                logEvent("enforcement_reject", {
                    loopId,
                    round: currentRound,
                    reason: enforceResult.reason.slice(0, 120),
                    check: enforceResult.check ?? "",
                    consecutiveRejections: newRejections,
                });
                return {
                    action: "reject",
                    rejectionPrompt,
                    verificationFlags,
                    enforcementAction: "reject",
                    enforcementReason: enforceResult.reason,
                    rejectionCheck: enforceResult.check,
                    roundSuccess,
                    gateContradicted,
                    newConsecutiveRejections: newRejections,
                    // Don't update lastSelfEval on reject — the agent redoes the same round
                    newLastSelfEval: undefined,
                    shouldPushSuccessTrajectory: false,
                };
            }
            if (enforceResult.action === "terminate") {
                logEvent("session_end", {
                    loopId,
                    stopReason: "enforcement_terminated",
                    round: currentRound,
                });
                return {
                    action: "terminate",
                    stopReason: "enforcement_terminated",
                    verificationFlags,
                    enforcementAction: "terminate",
                    enforcementReason: enforceResult.reason,
                    rejectionCheck: enforceResult.check,
                    roundSuccess,
                    gateContradicted,
                    newConsecutiveRejections: 0,
                    newLastSelfEval: selfEval,
                    shouldPushSuccessTrajectory: false,
                };
            }
            // Accept: reset rejection counter
            // (consecutiveRejections reset to 0 — caller persists)
        }
        // ── 4. Auto-feedback (AFTER enforcement, only if accepted) ──────────
        // ── 5. Stop condition checks ────────────────────────────────────────
        // 5a. Extraction failed → stalled
        if (!extractionSucceeded) {
            return {
                action: "stop",
                stopReason: "stalled",
                verificationFlags,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        // 5b. Agent says stop
        if (!selfEval.should_continue) {
            const reason = roundSuccess ? "completed" : "failed";
            return {
                action: "stop",
                stopReason: reason,
                verificationFlags,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        // 5c. Circuit breaker
        const projectedTrajectory = [...(input.successTrajectory ?? [])];
        if (!gateContradicted)
            projectedTrajectory.push(roundSuccess);
        const breakerSize = getPolicy().engine.max_circuit_breaker;
        const circuitBroken = projectedTrajectory.length >= breakerSize &&
            projectedTrajectory.slice(-breakerSize).every((value) => !value);
        if (circuitBroken) {
            return {
                action: "stop",
                stopReason: "circuit_breaker",
                verificationFlags,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        // 5d. Max rounds reached
        if (currentRound >= maxRounds) {
            return {
                action: "stop",
                stopReason: "max_rounds",
                verificationFlags,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        // ── 6. Continue — caller compiles next round ────────────────────────
        return {
            action: "continue",
            verificationFlags,
            enforcementAction: "accept",
            roundSuccess,
            gateContradicted,
            newConsecutiveRejections: 0,
            newLastSelfEval: selfEval,
            shouldPushSuccessTrajectory: !gateContradicted,
        };
    }
}
//# sourceMappingURL=round-coordinator.js.map