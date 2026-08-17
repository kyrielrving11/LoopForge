import { verifyRoundEvaluation, entryRound } from "./verification-gate.js";
import { enforceRound, buildRejectionPrompt, findSafeRestorePoint, buildBacktrackPrompt, } from "./enforcement-gate.js";
import { getPolicy } from "./policy.js";
function filesFromEntry(entry) {
    const envelope = entry.evidence_envelope;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
        return [];
    const files = envelope.files;
    if (!files || typeof files !== "object" || Array.isArray(files))
        return [];
    const value = files.value;
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
export class RoundCoordinator {
    backend;
    constructor(backend) {
        this.backend = backend;
    }
    processRound(input) {
        const { loopId, task, currentRound, maxRounds, evaluation, previousEvaluation, consecutiveRejections, } = input;
        const roundSuccess = evaluation.report.status === "completed";
        const prefix = `loop:${loopId}:r`;
        const vaultEntries = this.backend
            ? [
                ...this.backend.queryEntries({ prefix }),
                ...this.backend.queryEntries({ prefix, feedbackOnly: true }),
            ]
            : [];
        const verification = verifyRoundEvaluation(evaluation, currentRound, vaultEntries, previousEvaluation ?? null, input.evidenceSnapshots ?? [], input.backtrackSkippedFiles ?? []);
        const gateContradicted = verification.verdict === "contradicted";
        const enforcement = enforceRound(evaluation, verification, currentRound, vaultEntries, consecutiveRejections);
        const base = {
            verificationFlags: verification.flags,
            roundSuccess,
            gateContradicted,
        };
        if (enforcement.action === "reject") {
            return {
                ...base,
                action: "reject",
                rejectionPrompt: buildRejectionPrompt(currentRound, task, enforcement, verification.flags),
                enforcementAction: "reject",
                enforcementReason: enforcement.reason,
                rejectionCheck: enforcement.check,
                newConsecutiveRejections: consecutiveRejections + 1,
                shouldPushSuccessTrajectory: false,
            };
        }
        if (enforcement.action === "terminate") {
            return {
                ...base,
                action: "terminate",
                stopReason: "enforcement_terminated",
                enforcementAction: "terminate",
                enforcementReason: enforcement.reason,
                rejectionCheck: enforcement.check,
                newConsecutiveRejections: 0,
                newLastEvaluation: evaluation,
                shouldPushSuccessTrajectory: false,
            };
        }
        if (enforcement.action === "backtrack") {
            const restore = findSafeRestorePoint(currentRound, vaultEntries, getPolicy().engine.backtrack_max_depth);
            if (!restore) {
                return {
                    ...base,
                    action: "terminate",
                    stopReason: "enforcement_terminated",
                    enforcementAction: "terminate",
                    enforcementReason: `${enforcement.reason} (no clean restore point)`,
                    rejectionCheck: enforcement.check,
                    newConsecutiveRejections: 0,
                    newLastEvaluation: evaluation,
                    shouldPushSuccessTrajectory: false,
                };
            }
            const skippedFiles = vaultEntries
                .filter((entry) => entryRound(entry) > restore.round && entryRound(entry) < currentRound)
                .flatMap(filesFromEntry)
                .filter((file, index, all) => all.indexOf(file) === index);
            return {
                ...base,
                action: "backtrack",
                backtrackPrompt: buildBacktrackPrompt(currentRound, restore.round, enforcement.check ?? "evidence_stall", getPolicy().engine.backtrack_preserve_discoveries ? restore.skippedDiscoveries : [], skippedFiles),
                backtrackTarget: restore.round,
                backtrackSkippedDiscoveries: getPolicy().engine.backtrack_preserve_discoveries
                    ? restore.skippedDiscoveries
                    : [],
                backtrackSkippedFiles: skippedFiles,
                backtrackTriggerRule: enforcement.check,
                enforcementAction: "backtrack",
                enforcementReason: enforcement.reason,
                rejectionCheck: enforcement.check,
                newConsecutiveRejections: 0,
                shouldPushSuccessTrajectory: false,
            };
        }
        if (evaluation.report.status === "blocked") {
            return {
                ...base,
                action: "stop",
                stopReason: "blocked",
                enforcementAction: "accept",
                newConsecutiveRejections: 0,
                newLastEvaluation: evaluation,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        if (evaluation.phase === "auditing" && evaluation.report.status === "completed") {
            return {
                ...base,
                action: "stop",
                stopReason: "completed",
                enforcementAction: "accept",
                newConsecutiveRejections: 0,
                newLastEvaluation: evaluation,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        if (currentRound >= maxRounds) {
            return {
                ...base,
                action: "stop",
                stopReason: "max_rounds",
                enforcementAction: "accept",
                newConsecutiveRejections: 0,
                newLastEvaluation: evaluation,
                shouldPushSuccessTrajectory: !gateContradicted,
            };
        }
        return {
            ...base,
            action: "continue",
            enforcementAction: "accept",
            newConsecutiveRejections: 0,
            newLastEvaluation: evaluation,
            shouldPushSuccessTrajectory: !gateContradicted,
        };
    }
}
//# sourceMappingURL=round-coordinator.js.map