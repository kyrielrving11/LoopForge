import { makeEnforcementResult } from "./protocol.js";
import { entryRound } from "./verification-gate.js";
import { getPolicy } from "./policy.js";
function entryAdvancement(entry) {
    const value = entry.material_advancement;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const raw = value;
    return typeof raw.stepId === "string" && typeof raw.material === "boolean"
        ? { stepId: raw.stepId, material: raw.material }
        : null;
}
function flatline(evaluation, entries, window) {
    const stepId = evaluation.activeStepId;
    if (!stepId || evaluation.report.status !== "in_progress")
        return false;
    const history = entries
        .map((entry) => ({ round: entryRound(entry), advancement: entryAdvancement(entry) }))
        .filter((item) => item.round > 0 && item.advancement !== null && item.advancement.stepId === stepId)
        .sort((a, b) => a.round - b.round)
        .map((item) => item.advancement.material);
    history.push(evaluation.materialAdvancement?.material ?? false);
    return history.length >= window && history.slice(-window).every((material) => !material);
}
export function findSafeRestorePoint(currentRound, vaultEntries, maxDepth) {
    const byRound = new Map();
    for (const entry of vaultEntries) {
        const round = entryRound(entry);
        if (round > 0 && round < currentRound) {
            byRound.set(round, [...(byRound.get(round) ?? []), entry]);
        }
    }
    for (let round = currentRound - 1; round >= Math.max(1, currentRound - maxDepth); round--) {
        const entries = byRound.get(round) ?? [];
        const dirty = entries.some((entry) => {
            const flags = Array.isArray(entry.verification_flags) ? entry.verification_flags : [];
            return flags.some((flag) => flag && typeof flag === "object" &&
                flag.severity === "error");
        });
        if (dirty || entries.length === 0)
            continue;
        const skippedDiscoveries = [];
        for (let skipped = round + 1; skipped < currentRound; skipped++) {
            for (const entry of byRound.get(skipped) ?? []) {
                const report = entry.round_report;
                if (!report || typeof report !== "object" || Array.isArray(report))
                    continue;
                const discoveries = report.discoveries;
                if (!discoveries || typeof discoveries !== "object" || Array.isArray(discoveries))
                    continue;
                for (const value of Object.values(discoveries)) {
                    if (Array.isArray(value)) {
                        for (const item of value)
                            if (typeof item === "string" && !skippedDiscoveries.includes(item))
                                skippedDiscoveries.push(item);
                    }
                }
            }
        }
        return { round, skippedDiscoveries };
    }
    return null;
}
export function buildBacktrackPrompt(currentRound, targetRound, trigger, discoveries = [], files = []) {
    const lines = [
        `## Round ${currentRound} - BACKTRACK REQUIRED`,
        "",
        `Restore the workspace to the last clean boundary after Round ${targetRound}.`,
        `Trigger: ${trigger}.`,
        "Do not reuse the failed approach. Preserve only independently verified discoveries.",
    ];
    if (discoveries.length)
        lines.push("", "### Preserved discoveries", ...discoveries.map((item) => `- ${item}`));
    if (files.length)
        lines.push("", "### Files to restore or re-check", ...files.slice(0, 20).map((item) => `- ${item}`));
    return lines.join("\n");
}
export function enforceRound(evaluation, verification, _currentRound, vaultEntries, consecutiveRejections) {
    const error = verification.flags.find((flag) => flag.severity === "error");
    if (error) {
        if (consecutiveRejections >= 2) {
            return makeEnforcementResult({
                action: "terminate",
                reason: `Repeated rejected round: ${error.detail}`,
                check: "max_rejections",
            });
        }
        return makeEnforcementResult({
            action: "reject",
            reason: error.detail,
            fix_instructions: "Correct the evidence contradiction and resubmit the same roundId.",
            check: error.check,
        });
    }
    const violations = evaluation.report.violations ?? [];
    if (evaluation.report.status === "completed" && violations.length) {
        return makeEnforcementResult({
            action: "reject",
            reason: "A completed report cannot contain known constraint violations.",
            fix_instructions: "Resolve the violations or report in_progress/blocked.",
            check: "completion_with_violation",
        });
    }
    const stallWindow = Math.max(1, getPolicy().evolution.progress_stall_rounds);
    if (flatline(evaluation, vaultEntries, stallWindow)) {
        const repeated = consecutiveRejections > 0;
        const reason = `The active step has ${stallWindow} accepted rounds without material evidence advancement.`;
        if (getPolicy().engine.backtrack_enabled && repeated) {
            return makeEnforcementResult({
                action: "backtrack",
                reason,
                check: "evidence_stall",
            });
        }
        return makeEnforcementResult({
            action: "reject",
            reason,
            fix_instructions: "Produce a new verified claim, changed file, improved check, or justified plan change.",
            check: "evidence_stall",
        });
    }
    return makeEnforcementResult({ action: "accept" });
}
export function buildRejectionPrompt(currentRound, task, result, flags = []) {
    const details = flags.map((flag) => `- [${flag.severity}] ${flag.check}: ${flag.detail}`);
    return [
        `## Round ${currentRound} - REJECTED`,
        "",
        "### Reason",
        result.reason,
        "",
        "### Evidence gaps",
        ...(details.length ? details : ["- No additional verification flags."]),
        "",
        "### Retry",
        `Continue the same task and roundId: ${task}`,
        result.fix_instructions,
    ].join("\n");
}
//# sourceMappingURL=enforcement-gate.js.map