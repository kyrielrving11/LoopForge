/** Canonical data used by prompt and Markdown projections. */
import { createHash } from "node:crypto";
import { unique } from "./token-utils.js";
export const CANONICAL_STATE_SCHEMA_VERSION = 3;
export function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
export function hashCanonicalState(state) {
    return createHash("sha256").update(stableStringify(state)).digest("hex");
}
function addList(lines, title, values) {
    if (!values.length)
        return;
    lines.push(`## ${title}`, "", ...values.map((value) => `- ${value}`), "");
}
export function formatCompilationContext(context, fallbackTask) {
    if (!context)
        return fallbackTask;
    const lines = [
        `Plan version: ${context.planVersion ?? "none"}`,
        `Prompt mode: ${context.promptMode}`,
    ];
    if (context.promptMode === "audit")
        lines.push("LoopForge Final Audit");
    if (context.activeStep) {
        lines.push(`Step: ${context.activeStep.id}: ${context.activeStep.title}`, `Kind: ${context.activeStep.kind}`);
        if (context.activeStep.scope.length)
            lines.push(`Scope: ${context.activeStep.scope.join(", ")}`);
        if (context.activeStep.acceptanceCriteria.length)
            lines.push("Acceptance criteria:", ...context.activeStep.acceptanceCriteria.map((item) => `- ${item}`));
        if (context.activeStep.evidenceRequirements.length)
            lines.push("Evidence requirements:", ...context.activeStep.evidenceRequirements.map((item) => `- ${item}`));
    }
    if (context.evidenceGaps.length)
        lines.push("Evidence gaps:", ...context.evidenceGaps.map((item) => `- ${item.id}: ${item.text}`));
    if (context.failedChecks.length)
        lines.push("Failed checks:", ...context.failedChecks.map((item) => `- ${item.name}: ${item.status}${item.summary ? ` - ${item.summary}` : ""}`));
    lines.push(`Instruction: ${context.instruction}`);
    return lines.join("\n");
}
/** Markdown is a rebuildable view. Typed session and round JSON is truth. */
export function renderCanonicalStateMarkdown(state) {
    const lines = [
        `# LoopForge State - ${state.loopId}`,
        "",
        `**Schema**: ${state.schemaVersion}`,
        `**Round**: ${state.round}/${state.maxRounds}`,
        `**Goal ID**: ${state.goalId}`,
        "",
        "## Objective",
        "",
        state.objective,
        "",
        "## Assigned Work",
        "",
        formatCompilationContext(state.compilationContext, state.currentTask),
        "",
    ];
    addList(lines, "Success Criteria", state.successCriteria);
    addList(lines, "Hard Constraints", state.hardConstraints);
    addList(lines, "Active Constraints", state.activeConstraints);
    addList(lines, "Evidence Gaps", state.evidence.evidenceGaps);
    addList(lines, "Covered Claims", state.evidence.coveredClaims);
    addList(lines, "Files", state.evidence.files);
    if (state.evidence.checks.length) {
        addList(lines, "Checks", state.evidence.checks.map((check) => `${check.name}: ${check.status}${check.summary ? ` - ${check.summary}` : ""}`));
    }
    addList(lines, "Changes Since Last Round", state.changesSinceLastRound);
    addList(lines, "Blockers", state.blockers);
    addList(lines, "Discoveries", state.discoveries);
    addList(lines, "Recent Outcomes", state.rollingOutcomes);
    addList(lines, "Recurring Issues", state.recurringIssues);
    addList(lines, "Failed Patterns", state.failedPatterns);
    if (state.verificationFlags.length) {
        addList(lines, "Verification", state.verificationFlags.map((flag) => `[${flag.severity}] [${flag.check}] ${flag.detail}`));
    }
    if (state.milestones.length) {
        lines.push("## Phase History", "");
        for (const milestone of state.milestones) {
            lines.push(`### ${milestone.label}`, `Rounds ${milestone.round_range.start}-${milestone.round_range.end}`, "", milestone.outcome, "");
        }
    }
    if (state.loopSynthesis)
        lines.push("## Loop Summary", "", state.loopSynthesis, "");
    if (state.externalContext)
        lines.push("## External Context", "", state.externalContext, "");
    if (state.graphSlice) {
        lines.push("## Active Graph Slice", "", `Plan version: ${state.graphSlice.planVersion ?? "none"}`, `Active step: ${state.graphSlice.activeStepId ?? "audit"}`, `Parent outline: ${state.graphSlice.parentOutlineId ?? "none"}`, `Blocked descendants: ${state.graphSlice.blockedDescendantCount}`, "");
    }
    return lines.join("\n").trimEnd() + "\n";
}
function planEvidenceGaps(request) {
    if (!request.report_claim_targets?.length)
        return [];
    const covered = new Set(request.last_evaluation?.evidenceEnvelope.claims.map((claim) => claim.targetId) ?? []);
    return request.report_claim_targets.filter((target) => !covered.has(target.id))
        .map((target) => `${target.id}: ${target.text}`);
}
export function createCanonicalLoopState(request, response, stateFilePath) {
    const last = request.last_evaluation;
    const objective = response.loop_objective;
    const report = last;
    const discoveries = report?.discoveries;
    return {
        schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
        loopId: response.loop_id || request.loop_id,
        round: response.round || request.round,
        maxRounds: request.max_rounds ?? 20,
        goalId: response.goal_id,
        objective: objective?.objective || request.task,
        objectiveVersion: objective?.version ?? 1,
        currentTask: request.task,
        compilationContext: request.compilation_context ?? null,
        successCriteria: unique(objective?.success_criteria ?? []),
        hardConstraints: unique(objective?.hard_constraints ?? []),
        activeConstraints: unique(response.constraints_active),
        constraintMetadata: response.constraint_metadata ?? [],
        changesSinceLastRound: unique([request.new_since_last_round, report?.summary]),
        blockers: unique([
            ...(report?.violations ?? []),
            report?.status === "blocked" ? report.summary : "",
            request.rejection_notice,
            ...response.warnings,
        ]),
        verificationFlags: request.verification_flags ?? [],
        discoveries: unique([
            ...(discoveries?.wrongAssumptions ?? []).map((item) => `Corrected assumption: ${item}`),
            ...(discoveries?.emergedWork ?? []),
            ...(discoveries?.facts ?? []),
            ...(discoveries?.newConstraints ?? []),
        ]),
        rollingOutcomes: unique(response.executionHistory.recentOutcomes),
        recurringIssues: unique(response.executionHistory.blockedOutcomes),
        failedPatterns: [],
        milestones: response.executionHistory.milestones,
        loopSynthesis: response.executionHistory.synthesis,
        externalContext: request.external_context?.trim() ?? "",
        stateFilePath,
        evidence: {
            files: unique(report?.evidenceEnvelope.files.value ?? []),
            checks: report?.evidenceEnvelope.checks.value ?? [],
            coveredClaims: unique(report?.evidenceEnvelope.claims.map((claim) => claim.targetId) ?? []),
            evidenceGaps: planEvidenceGaps(request),
        },
        graphSlice: request.graph_slice ?? null,
    };
}
//# sourceMappingURL=canonical-state.js.map