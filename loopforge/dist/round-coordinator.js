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
import { emptyCommittedHistory, historyWindow, loadCommittedHistory, } from "./history.js";
import { CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE, verifySelfEvaluation, } from "./verification-gate.js";
import { checkpointForRoundBoundary, deriveRecoveryDirective, validateCheckpointManifest, } from "./recovery.js";
import { driftedEntrypoints } from "./evidence-provider.js";
import { declaresBlocked, effectiveOutcome, effectiveSuccess, } from "./round-outcome.js";
import { deriveRoundProgress, } from "./progress.js";
import { enforceRound, buildRejectionPrompt, findSafeRestorePoint, } from "./enforcement-gate.js";
import { logEvent } from "./observability.js";
import { getPolicy } from "./policy.js";
import { deriveRoundFacts } from "./round-facts.js";
import { deriveEvidencePosture, rollbackEvidencePosture, } from "./evidence-posture.js";
import { deriveFilesReconciliation } from "./files-reconciliation.js";
/** v3.2/v3.6/v4.0.3: Whether a round's success enters the success
 *  trajectory.
 *
 *  The trajectory counts MACHINE-BACKED success only: the Agent must
 *  effectively claim success AND the verification gate must have found a
 *  passed, untampered after command (`machineBackedSuccess`). A partial or
 *  blocked outcome, an unbacked success claim, a contradicted gate, a
 *  redirect round and an unverified contract item all keep the round out.
 *  This does not change `completed` — it only keeps progress metrics honest. */
function shouldPushSuccess(selfEval, gateContradicted, verificationFlags, machineBackedSuccess, contractStatuses) {
    if (!effectiveSuccess(selfEval))
        return false;
    if (!machineBackedSuccess)
        return false;
    if (gateContradicted)
        return false;
    // v3.9.9: a redirect round abandons a slice; it is never success evidence.
    if (contractStatuses?.closure === "superseded")
        return false;
    // v3.8: an unverified contract item (or a claimed-but-unbacked success)
    // keeps the round out of the success trajectory — an accepted-but-unverified
    // round is not evidence of progress.
    if (contractStatuses && contractStatuses.insufficientCount > 0)
        return false;
    return !verificationFlags.some((flag) => flag.severity === "warn" &&
        flag.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE);
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
export function finalizeStopReason(
/** `undefined` when the disposition named no terminal reason at all (the
 *  callers fall back to their own default) — there is nothing to guard. */
reason, selfEval, contractStatuses,
/** v3.9.9: the current round's transition. A committed redirect can never
 *  produce `completed` even if the old items were all verified. */
transition) {
    if (reason !== "completed")
        return { reason, flags: [] };
    const declared = declaresBlocked(selfEval);
    const blockedContract = contractStatuses?.closure === "blocked";
    if (declared || blockedContract) {
        return {
            reason: "blocked",
            flags: [{
                    severity: "warn",
                    field: declared ? "outcome" : "round_contract",
                    check: "completion_truth_downgraded",
                    detail: declared
                        ? "The round declared a blocked outcome but the stop decision produced " +
                            "`completed`; the declaration wins and the stop reason was downgraded " +
                            "to `blocked`."
                        : "The active contract closed on a blocked outcome but the stop decision " +
                            "produced `completed`; the stop reason was downgraded to `blocked`.",
                }],
        };
    }
    const superseded = contractStatuses?.closure === "superseded" ||
        Boolean(transition);
    if (superseded) {
        return {
            reason: "incomplete",
            flags: [{
                    severity: "warn",
                    field: "contract_transition",
                    check: "completion_truth_downgraded",
                    detail: "The round superseded its active contract, so the old slice is not " +
                        "verified and the round cannot be `completed`; the stop reason was " +
                        "downgraded to `incomplete`.",
                }],
        };
    }
    return { reason, flags: [] };
}
// ── RoundCoordinator ───────────────────────────────────────────────────────
export class RoundCoordinator {
    store;
    constructor(store) {
        this.store = store;
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
     *  - State file I/O (both paths, after compiling) */
    processRound(input) {
        const { loopId, task, currentRound, maxRounds, selfEval, consecutiveRejections, evidenceDeltas, } = input;
        const agentSuccessClaim = selfEval.success ?? false;
        const agentOutcome = effectiveOutcome(selfEval);
        // ── 1. Load committed history once ──────────────────────────────────
        // The verification gate and the contract reducer read the same flat entry
        // view and the same committed window; one store read serves both. The
        // advance path passes the history it already loaded for its own
        // pre-commit facts.
        const history = input.history ?? (this.store
            ? loadCommittedHistory(this.store, loopId)
            : emptyCommittedHistory(loopId));
        const vaultEntries = history.entries;
        // v3.9.6: the previous evaluation is the last committed branch round,
        // never a session copy.
        const committedRounds = historyWindow(history, currentRound);
        const previousCommitted = committedRounds.length > 0
            ? committedRounds[committedRounds.length - 1].evaluation
            : null;
        // ── 2. Verification gate ────────────────────────────────────────────
        // v3.9.7: the old post-backtrack restore checks/R9 are gone. LoopForge
        // verifies the restore before issuing the redo prompt; a redo submission
        // is ordinary work, so its after boundary must never be compared to the
        // restore target.
        // v4.0.3: ONE RoundFacts derivation for this round. The verification
        // gate, the stop decision, the success trajectory and the evidence
        // posture all consume this bundle; none derives the contract again.
        const commands = getPolicy().evidence.commands ?? [];
        const roundFacts = deriveRoundFacts({
            rounds: committedRounds,
            currentRound,
            inFlight: {
                currentReport: selfEval.execution_report ?? null,
                currentDeltas: evidenceDeltas ?? [],
                currentBlocked: declaresBlocked(selfEval),
                currentTransition: selfEval.contract_transition ?? null,
            },
            commands,
        });
        const verifyResult = verifySelfEvaluation(selfEval, currentRound, vaultEntries, previousCommitted, evidenceDeltas ?? [],
        // v3.7.1: gate records live under the gate: prefix — outside the round
        // entries above — and are passed separately to the gate check.
        history.entries.filter((entry) => String(entry.task_id ?? "").startsWith(`loop:${loopId}:gate:`)),
        // v3.8.3: the absolute arm of the entrypoint check. Derived here, not in
        // the gate, because it needs the filesystem and the in-flight trust map
        // captured when this round was prepared — the gate stays a pure function
        // of its inputs.
        driftedEntrypoints(input.entrypointTrust),
        // v3.9.4: the SAME manifest basis the receipt uses. An omitted
        // files_changed field is not silently treated as "a report exists".
        input.submittedFields
            ? input.submittedFields.includes("execution_report.files_changed")
            : undefined,
        // v4.0.3: the one derivation, computed above. Passing it removes the
        // gate's private contract/item/claim derivation.
        roundFacts);
        const verificationFlags = verifyResult.flags;
        const gateContradicted = verifyResult.verdict === "contradicted";
        const { activeContract, itemStatuses: activeContractStatuses } = roundFacts;
        // v4.0.3: the evidence posture is derived ONCE here, from the same raw
        // facts every other branch reads. It is persisted with an accepted round;
        // a rejected/terminated attempt carries only the transient copy.
        const verificationConfigured = commands.some((command) => command.enabled === true &&
            (command.phase === "after" || command.phase === "both"));
        const filesReconciliation = deriveFilesReconciliation(selfEval.execution_report ?? null, evidenceDeltas ?? [], input.submittedFields
            ? {
                attempted: input.submittedFields.includes("execution_report.files_changed"),
            }
            : {});
        const evaluationPosture = deriveEvidencePosture({
            round: currentRound,
            kind: "evaluation",
            selfEval,
            afterEvidence: input.afterEvidence ?? [],
            evidenceDeltas: evidenceDeltas ?? [],
            verificationFlags,
            machineBackedSuccess: verifyResult.machineBackedSuccess,
            activeContract,
            contractStatuses: activeContractStatuses,
            verificationConfigured,
            filesReconciliation,
        });
        const evaluationResult = (result) => ({
            ...result,
            evidencePosture: evaluationPosture,
            agentOutcome,
        });
        const rollbackResult = (result) => ({
            ...result,
            evidencePosture: rollbackEvidencePosture(currentRound),
            agentOutcome: null,
        });
        if (gateContradicted) {
            logEvent("gate_contradicted", {
                loopId,
                round: currentRound,
                flags: verificationFlags.map((f) => f.check),
            });
        }
        // ── 3. Enforcement gate ──────────────────────────────────────────
        // v3.3.1: extraction failures stall the round upstream (round-lifecycle,
        // v2.6 design — the runtime never guesses state from text), so every
        // transaction reaches enforcement with a fully extracted self-evaluation.
        // The old v2.5 "heuristic partial enforcement" plumbing (extractionSucceeded
        // flag, enforcement skipEvidenceRules mode) was removed as unreachable.
        const enforceResult = enforceRound(selfEval, verifyResult, currentRound, vaultEntries, consecutiveRejections, input.lastRejectionCheck ?? "",
        // v3.9.9: what THIS round moved, under the SAME Git workspace selector
        // the committed window uses. Unknown/not_applicable never gains the
        // stall excuse, and no other provider's fact can change this verdict.
        deriveRoundProgress(evidenceDeltas ?? []));
        if (enforceResult.action === "reject") {
            const newRejections = consecutiveRejections + 1;
            const rejectionPrompt = buildRejectionPrompt(currentRound, task, enforceResult, verificationFlags);
            logEvent("enforcement_reject", {
                loopId,
                round: currentRound,
                reason: enforceResult.reason.slice(0, 120),
                check: enforceResult.check ?? "",
                consecutiveRejections: newRejections,
            });
            return evaluationResult({
                action: "reject",
                rejectionPrompt,
                verificationFlags,
                enforcementAction: "reject",
                enforcementReason: enforceResult.reason,
                rejectionCheck: enforceResult.check,
                agentSuccessClaim,
                gateContradicted,
                newConsecutiveRejections: newRejections,
                shouldPushSuccessTrajectory: false,
            });
        }
        if (enforceResult.action === "terminate") {
            // v3.8: a row may name the stop reason it terminates with (the
            // verification-debt row reports `incomplete` — the agent stopped short
            // of machine verification, which is not the same as a contradiction).
            const terminateReason = enforceResult.stopReason ?? "enforcement_terminated";
            logEvent("session_end", {
                loopId,
                stopReason: terminateReason,
                round: currentRound,
            });
            return evaluationResult({
                action: "terminate",
                stopReason: terminateReason,
                verificationFlags,
                enforcementAction: "terminate",
                enforcementReason: enforceResult.reason,
                rejectionCheck: enforceResult.check,
                agentSuccessClaim,
                gateContradicted,
                newConsecutiveRejections: 0,
                shouldPushSuccessTrajectory: false,
            });
        }
        // ── v2.10 / v3.9.7: Backtrack ─────────────────────────────────────────
        if (enforceResult.action === "backtrack") {
            const maxDepth = getPolicy().engine.backtrack_max_depth;
            // The state after round T is the before-image of round T+1. A candidate
            // is eligible only when that image was materialized and its manifest is
            // readable; there is no verification-only fallback.
            const resolveRef = (restoreRound) => {
                const redoRound = restoreRound + 1;
                const ref = checkpointForRoundBoundary({
                    entries: vaultEntries,
                    heldRound: currentRound,
                    heldBeforeCheckpoint: input.beforeCheckpoint,
                    redoRound,
                });
                if (!ref)
                    return null;
                if (input.resolveCheckpointManifest) {
                    const manifest = input.resolveCheckpointManifest(ref);
                    // Machine target selection must prove the ref and manifest are
                    // self-consistent BEFORE committing an immutable directive. Blob
                    // and HEAD checks still run in the post-commit preflight.
                    if (!manifest || !validateCheckpointManifest(ref, manifest).ok) {
                        return null;
                    }
                }
                return ref;
            };
            const restorePoint = findSafeRestorePoint(currentRound, vaultEntries, maxDepth, (restoreRound) => resolveRef(restoreRound) !== null);
            if (!restorePoint) {
                // No clean round with a materialized restore point within maxDepth.
                logEvent("session_end", {
                    loopId,
                    stopReason: "enforcement_terminated",
                    round: currentRound,
                });
                return evaluationResult({
                    action: "terminate",
                    stopReason: "enforcement_terminated",
                    verificationFlags,
                    enforcementAction: "terminate",
                    enforcementReason: `${enforceResult.reason} (backtrack failed: no materialized restore point within ${maxDepth} rounds)`,
                    rejectionCheck: enforceResult.check,
                    agentSuccessClaim,
                    gateContradicted,
                    newConsecutiveRejections: 0,
                    shouldPushSuccessTrajectory: false,
                });
            }
            const targetRef = resolveRef(restorePoint.round);
            const targetManifest = targetRef && input.resolveCheckpointManifest
                ? input.resolveCheckpointManifest(targetRef)
                : null;
            if (!targetRef || !targetManifest) {
                logEvent("session_end", {
                    loopId,
                    stopReason: "enforcement_terminated",
                    round: currentRound,
                });
                return evaluationResult({
                    action: "terminate",
                    stopReason: "enforcement_terminated",
                    verificationFlags,
                    enforcementAction: "terminate",
                    enforcementReason: `${enforceResult.reason} (backtrack failed: restore point manifest unavailable)`,
                    rejectionCheck: enforceResult.check,
                    agentSuccessClaim,
                    gateContradicted,
                    newConsecutiveRejections: 0,
                    shouldPushSuccessTrajectory: false,
                });
            }
            const abandonedRounds = committedRounds
                .filter((view) => view.round >= targetRef.redoRound);
            const recovery = deriveRecoveryDirective({
                origin: "machine",
                reason: enforceResult.reason,
                ...(enforceResult.check ? { triggerRule: enforceResult.check } : {}),
                // The transaction layer fills the directive transaction id, which
                // depends on the prompt hash/branch identity.
                transactionId: "",
                targetRef,
                targetManifest,
                abandonedRounds,
                currentAfterEvidence: input.afterEvidence ?? [],
                triggerEvaluation: selfEval,
                triggerRound: currentRound,
                triggerFindings: verificationFlags,
            });
            logEvent("enforcement_backtrack", {
                loopId,
                round: currentRound,
                reason: enforceResult.reason.slice(0, 120),
                check: enforceResult.check ?? "",
                backtrackTarget: targetRef.redoRound,
                skippedDiscoveries: recovery.skipped_discoveries.length,
            });
            return rollbackResult({
                action: "backtrack",
                origin: "machine",
                reason: enforceResult.reason,
                recovery,
                verificationFlags,
                enforcementAction: "backtrack",
                enforcementReason: enforceResult.reason,
                rejectionCheck: enforceResult.check,
                agentSuccessClaim,
                gateContradicted,
                newConsecutiveRejections: 0, // reset — fresh start
                shouldPushSuccessTrajectory: false,
            });
        }
        // Accept: reset rejection counter
        // (consecutiveRejections reset to 0 — caller persists)
        // ── 4. Auto-feedback (AFTER enforcement, only if accepted) ──────────
        // ── 5. Stop condition checks ────────────────────────────────────────
        // 5b. Agent says stop
        if (!selfEval.should_continue) {
            // v3.8: `completed` is a machine claim. It requires the active contract
            // to be closed — every item `verified` — or no contract at all. A stop
            // with claimed-but-unverified items is `incomplete`, never `completed`.
            // An empty contract id means no contract is active (the reducer's
            // sentinel view) — a contract-less loop completes on the success claim
            // alone, exactly as before v3.8.
            //
            // A `blocked` closure deliberately does NOT satisfy `contractClosed`: a
            // contract closed by its own blocked outcome is not a verified one, and
            // the declaration arm below already owns that posture.
            const contractClosed = activeContractStatuses.contractId === "" ||
                activeContractStatuses.closure === "verified";
            // The agent's explicit declaration of a blocked stop outranks the
            // success claim. It is checked FIRST so `success: true` + a declared
            // `outcome`/`stop_reason` of blocked can never be reported as
            // `completed` — the two fields contradict, and the honest reading is the
            // declared one. A contradicted item also never reaches `completed`
            // (closure is `verified` only when EVERY item is), so the
            // contradicted-and-stopping posture lands on `incomplete` at worst; the
            // reject/terminate path for it is the enforcement gate's, evaluated
            // before this point.
            const declaredBlocked = declaresBlocked(selfEval);
            let reason;
            if (declaredBlocked) {
                reason = "blocked";
            }
            else if (effectiveSuccess(selfEval) && contractClosed) {
                reason = "completed";
            }
            else if (effectiveSuccess(selfEval)) {
                reason = "incomplete";
            }
            else {
                reason = "failed";
            }
            // v3.8.3: the guard runs BEFORE the transaction commits — this reason
            // is written into the committed round document below, so it must be
            // truthful at the moment it becomes a fact, not only when it is
            // returned to the client.
            const finalized = finalizeStopReason(reason, selfEval, activeContractStatuses, selfEval.contract_transition ?? null);
            return evaluationResult({
                action: "stop",
                stopReason: finalized.reason,
                verificationFlags: finalized.flags.length > 0
                    ? [...verificationFlags, ...finalized.flags]
                    : verificationFlags,
                agentSuccessClaim,
                gateContradicted,
                newConsecutiveRejections: 0,
                shouldPushSuccessTrajectory: shouldPushSuccess(selfEval, gateContradicted, verificationFlags, verifyResult.machineBackedSuccess, activeContractStatuses),
            });
        }
        // 5c. Max rounds reached
        //
        // Progress stalls are handled before this point by the R4 delta tier and
        // R5 flatline tier. Max rounds is an independent hard boundary.
        if (currentRound >= maxRounds) {
            return evaluationResult({
                action: "stop",
                stopReason: "max_rounds",
                verificationFlags,
                agentSuccessClaim,
                gateContradicted,
                newConsecutiveRejections: 0,
                shouldPushSuccessTrajectory: shouldPushSuccess(selfEval, gateContradicted, verificationFlags, verifyResult.machineBackedSuccess, activeContractStatuses),
            });
        }
        // ── 6. Continue — caller compiles next round ────────────────────────
        return evaluationResult({
            action: "continue",
            verificationFlags,
            enforcementAction: "accept",
            agentSuccessClaim,
            gateContradicted,
            newConsecutiveRejections: 0,
            shouldPushSuccessTrajectory: shouldPushSuccess(selfEval, gateContradicted, verificationFlags, verifyResult.machineBackedSuccess, activeContractStatuses),
        });
    }
}
//# sourceMappingURL=round-coordinator.js.map