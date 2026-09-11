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
import { queryLoopEntries } from "./loop-store.js";
import { CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE, verifySelfEvaluation } from "./verification-gate.js";
import { entryRound, isRecord } from "./token-utils.js";
import { effectiveOutcome, effectiveSuccess } from "./self-eval.js";
import { derivationRounds, decodeCommittedRound } from "./committed-round.js";
import { makeRoundId } from "./round-transaction.js";
import { enforceRound, buildRejectionPrompt, findSafeRestorePoint, buildBacktrackPrompt, findBacktrackTargetGitHead, } from "./enforcement-gate.js";
import { logEvent } from "./observability.js";
import { getPolicy } from "./policy.js";
import { deriveRoundContractView } from "./round-contract.js";
import { roundVerificationStatus, } from "./contract-items.js";
/** v3.2/v3.6: Whether a round's success enters the success trajectory.
 *  Excluded when the gate contradicted the round, or when the success claim
 *  carries no machine-verified observation — the merged R8 check fires a
 *  warn under machine_backed_success "warn" (v3.6: success_unverified merged
 *  into R8; its warn-level trajectory exclusion moved with it) — an
 *  accepted-but-unverified round is not evidence of progress. */
function shouldPushSuccess(gateContradicted, verificationFlags, contractStatuses) {
    if (gateContradicted)
        return false;
    // v3.8: an unverified contract item (or a claimed-but-unbacked success)
    // keeps the round out of the success trajectory — an accepted-but-unverified
    // round is not evidence of progress.
    if (contractStatuses && contractStatuses.insufficientCount > 0)
        return false;
    return !verificationFlags.some((flag) => flag.severity === "warn" &&
        flag.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE);
}
// ── RoundCoordinator ───────────────────────────────────────────────────────
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
export function deriveBacktrackRecoveryFacts(input) {
    const { currentRound, restoreRound, vaultEntries, selfEval } = input;
    // v2.13: files changed in skipped rounds, for the restore prompt.
    const skippedFiles = [];
    // M3 (v3.7.x): each skipped file's git fingerprint at its failed round.
    // Recorded from the round's own after-evidence (machine data, not the
    // agent's report); later rounds overwrite earlier ones so the map holds the
    // LAST failed state of every file.
    const skippedFingerprints = {};
    const failedRounds = [];
    const approaches = [];
    const wrongAssumptions = [];
    for (let r = restoreRound + 1; r < currentRound; r++) {
        // v3.2.1: match the feedback entry (execution_report lives there) — the
        // compile-time lineage entry for the same round precedes it in the flat
        // view and carries no evidence.
        const entry = vaultEntries.find((e) => entryRound(e) === r && e.task_type !== "loop_lineage");
        const view = entry ? decodeCommittedRound(entry) : null;
        const evaluation = view?.evaluation ?? null;
        if (entry?.execution_report) {
            const ev = entry.execution_report;
            const files = Array.isArray(ev.files_changed)
                ? ev.files_changed.filter((f) => typeof f === "string")
                : [];
            const git = view?.afterEvidence.find((snapshot) => snapshot.kind === "git" &&
                isRecord(snapshot.data.fingerprints));
            const gitFingerprints = git && git.kind === "git"
                ? git.data.fingerprints
                : null;
            for (const f of files) {
                if (!skippedFiles.includes(f))
                    skippedFiles.push(f);
                const fp = gitFingerprints?.[f];
                if (typeof fp === "string")
                    skippedFingerprints[f] = fp;
            }
        }
        const summary = evaluation?.output_summary ?? "";
        if (summary.trim().length > 0) {
            failedRounds.push(r);
            approaches.push(summary.trim().slice(0, 200));
        }
        const assumptions = (evaluation?.wrong_assumptions ?? [])
            .filter((v) => typeof v === "string")
            .map((s) => s.slice(0, 500));
        for (const a of assumptions) {
            if (!wrongAssumptions.includes(a))
                wrongAssumptions.push(a);
        }
    }
    // The in-flight attempt that triggered this rollback.
    const triggerSummary = selfEval.output_summary?.trim() ?? "";
    if (triggerSummary.length > 0) {
        if (!failedRounds.includes(currentRound))
            failedRounds.push(currentRound);
        approaches.push(triggerSummary.slice(0, 200));
        for (const a of (selfEval.wrong_assumptions ?? [])
            .filter((v) => typeof v === "string")) {
            if (!wrongAssumptions.includes(a))
                wrongAssumptions.push(a.slice(0, 500));
        }
    }
    return {
        skippedFiles,
        skippedFingerprints,
        failedRounds,
        approaches,
        wrongAssumptions,
    };
}
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
        const { loopId, task, currentRound, maxRounds, selfEval, lastSelfEval, consecutiveRejections, evidenceSnapshots, } = input;
        const roundSuccess = selfEval.success ?? false;
        // ── 1. Query vault entries ──────────────────────────────────────────
        // Lineage entries (constraint violations, output summaries) and feedback
        // entries (execution_report, progress estimates) are both needed by
        // the enforcement gate. queryLoopEntries excludes feedback by default,
        // so we issue a second query and merge both result sets.
        const prefix = `loop:${loopId}:r`;
        const vaultEntries = this.store
            ? [
                ...queryLoopEntries(this.store, loopId, { prefix }),
                ...queryLoopEntries(this.store, loopId, { prefix, feedbackOnly: true }),
            ]
            : [];
        // ── 2. Verification gate ────────────────────────────────────────────
        const verifyResult = verifySelfEvaluation(selfEval, currentRound, vaultEntries, lastSelfEval ?? null, evidenceSnapshots ?? [], input.backtrackSkippedFiles ?? [], input.backtrackSkippedFingerprints ?? {}, input.backtrackTargetGitHead,
        // v3.7.1: gate records live under the gate: prefix — outside the round
        // entries above — and are passed separately to the gate check.
        this.store
            ? queryLoopEntries(this.store, loopId, { prefix: `loop:${loopId}:gate:` })
            : []);
        const verificationFlags = verifyResult.flags;
        const gateContradicted = verifyResult.verdict === "contradicted";
        // v3.8: the ACTIVE contract's derived item statuses for this round — the
        // same reducer the gate, compile path, audit and explain consume. Drives
        // the stop mapping (completed vs incomplete) and the success trajectory.
        const committedRounds = derivationRounds(vaultEntries, currentRound);
        // v3.8: the shared executed-contract derivation — the same one explain and
        // audit call, so the live posture and the read-only views cannot diverge.
        const { statuses: activeContractStatuses } = deriveRoundContractView({
            rounds: committedRounds,
            round: currentRound,
            report: selfEval.execution_report ?? null,
            observations: evidenceSnapshots ?? [],
            outcome: effectiveOutcome(selfEval),
            commands: getPolicy().evidence.commands ?? [],
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
        const enforceResult = enforceRound(selfEval, verifyResult, currentRound, vaultEntries, consecutiveRejections, input.lastRejectionCheck ?? "");
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
            return {
                action: "reject",
                verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
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
            // v3.8: a row may name the stop reason it terminates with (the
            // verification-debt row reports `incomplete` — the agent stopped short
            // of machine verification, which is not the same as a contradiction).
            const terminateReason = enforceResult.stopReason ?? "enforcement_terminated";
            logEvent("session_end", {
                loopId,
                stopReason: terminateReason,
                round: currentRound,
            });
            return {
                action: "terminate",
                verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
                stopReason: terminateReason,
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
        // ── v2.10: Backtrack ──────────────────────────────────────────────────
        if (enforceResult.action === "backtrack") {
            const maxDepth = getPolicy().engine.backtrack_max_depth;
            const restorePoint = findSafeRestorePoint(currentRound, vaultEntries, maxDepth);
            if (!restorePoint) {
                // No clean round found within maxDepth — fall through to terminate
                logEvent("session_end", {
                    loopId,
                    stopReason: "enforcement_terminated",
                    round: currentRound,
                });
                return {
                    action: "terminate",
                    verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
                    stopReason: "enforcement_terminated",
                    verificationFlags,
                    enforcementAction: "terminate",
                    enforcementReason: `${enforceResult.reason} (backtrack failed: no clean restore point within ${maxDepth} rounds)`,
                    rejectionCheck: enforceResult.check,
                    roundSuccess,
                    gateContradicted,
                    newConsecutiveRejections: 0,
                    newLastSelfEval: selfEval,
                    shouldPushSuccessTrajectory: false,
                };
            }
            // v2.13/v3.8.1: the rolled-back branch's facts — one named derivation,
            // so the walk is testable without driving a whole rollback, and the
            // prompt, the state file and the committed decision all describe one
            // event.
            const { skippedFiles, skippedFingerprints, failedRounds, approaches, wrongAssumptions, } = deriveBacktrackRecoveryFacts({
                currentRound,
                restoreRound: restorePoint.round,
                vaultEntries,
                selfEval,
            });
            // v2.12: Capture the restore point's git HEAD so the next round's
            // verification can confirm the workspace returned to this commit.
            const targetGitHead = findBacktrackTargetGitHead(restorePoint.round, vaultEntries);
            const backtrackPrompt = buildBacktrackPrompt(currentRound, restorePoint.round, enforceResult.check ?? "progress_stall", getPolicy().engine.backtrack_preserve_discoveries
                ? restorePoint.skippedDiscoveries
                : [], skippedFiles, targetGitHead ?? undefined, makeRoundId(loopId, restorePoint.round + 1), { failedRounds, approaches, wrongAssumptions });
            logEvent("enforcement_backtrack", {
                loopId,
                round: currentRound,
                reason: enforceResult.reason.slice(0, 120),
                check: enforceResult.check ?? "",
                backtrackTarget: restorePoint.round,
                skippedDiscoveries: restorePoint.skippedDiscoveries.length,
            });
            return {
                action: "backtrack",
                verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
                backtrackPrompt,
                backtrackTarget: restorePoint.round,
                backtrackSkippedDiscoveries: getPolicy().engine.backtrack_preserve_discoveries
                    ? restorePoint.skippedDiscoveries
                    : [],
                backtrackSkippedFiles: skippedFiles,
                backtrackSkippedFingerprints: skippedFingerprints,
                backtrackTargetGitHead: targetGitHead ?? undefined,
                backtrackTriggerRule: enforceResult.check,
                backtrackFailedRounds: failedRounds,
                backtrackApproaches: approaches,
                backtrackWrongAssumptions: wrongAssumptions,
                verificationFlags,
                enforcementAction: "backtrack",
                enforcementReason: enforceResult.reason,
                rejectionCheck: enforceResult.check,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0, // reset — fresh start
                newLastSelfEval: undefined,
                shouldPushSuccessTrajectory: false,
            };
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
            const declaredBlocked = selfEval.outcome === "blocked" ||
                selfEval.stop_reason === "blocked" || selfEval.stop_reason === "needs_human_input";
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
            return {
                action: "stop",
                verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
                stopReason: reason,
                verificationFlags,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: shouldPushSuccess(gateContradicted, verificationFlags, activeContractStatuses),
            };
        }
        // 5c. Max rounds reached
        //
        // Progress stalls are handled before this point by the R4 delta tier and
        // R5 flatline tier. Max rounds is an independent hard boundary.
        if (currentRound >= maxRounds) {
            return {
                action: "stop",
                verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
                stopReason: "max_rounds",
                verificationFlags,
                roundSuccess,
                gateContradicted,
                newConsecutiveRejections: 0,
                newLastSelfEval: selfEval,
                shouldPushSuccessTrajectory: shouldPushSuccess(gateContradicted, verificationFlags, activeContractStatuses),
            };
        }
        // ── 6. Continue — caller compiles next round ────────────────────────
        return {
            action: "continue",
            verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
            verificationFlags,
            enforcementAction: "accept",
            roundSuccess,
            gateContradicted,
            newConsecutiveRejections: 0,
            newLastSelfEval: selfEval,
            shouldPushSuccessTrajectory: shouldPushSuccess(gateContradicted, verificationFlags, activeContractStatuses),
        };
    }
}
//# sourceMappingURL=round-coordinator.js.map