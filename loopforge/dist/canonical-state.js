/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */
import { createHash } from "node:crypto";
export const CANONICAL_STATE_SCHEMA_VERSION = 1;
function unique(values) {
    return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}
/** Deterministic JSON serialization used by state and prompt hashes. */
export function stableStringify(value) {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(",")}]`;
    }
    const record = value;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
export function hashCanonicalState(state) {
    return createHash("sha256").update(stableStringify(state)).digest("hex");
}
function addList(lines, title, values) {
    if (values.length === 0)
        return;
    lines.push(`## ${title}`, "");
    for (const value of values)
        lines.push(`- ${value}`);
    lines.push("");
}
/** Human/Agent-readable materialized view. It is always reproducible from the
 * canonical state and is never consulted as transaction truth. */
export function renderCanonicalStateMarkdown(state) {
    const lines = [
        `# LoopForge State — ${state.loopId}`,
        "",
        `**Schema**: ${state.schemaVersion}`,
        `**Round**: ${state.round}/${state.maxRounds}`,
        `**Goal ID**: ${state.goalId}`,
        "",
        "## Loop Objective",
        "",
        state.objective,
        "",
        "## Current Task",
        "",
        state.currentTask,
        "",
    ];
    addList(lines, "Success Criteria", state.successCriteria);
    addList(lines, "Hard Constraints", state.hardConstraints);
    addList(lines, "Active Constraints", state.activeConstraints);
    addList(lines, "Changes Since Last Round", state.changesSinceLastRound);
    if (state.progress.estimate !== null ||
        state.progress.criteriaMet.length > 0 ||
        state.progress.criteriaRemaining.length > 0 ||
        state.progress.filesChanged.length > 0 ||
        state.progress.tests !== null) {
        const total = state.progress.criteriaMet.length + state.progress.criteriaRemaining.length;
        lines.push("## Progress Dashboard", "");
        if (total > 0) {
            lines.push(`**Criteria**: ${state.progress.criteriaMet.length}/${total}`);
        }
        if (state.progress.estimate !== null) {
            lines.push(`**Estimated Completion**: ${(state.progress.estimate * 100).toFixed(0)}%`);
        }
        if (state.progress.tests) {
            lines.push(`**Tests**: ${state.progress.tests.passed} passed, ` +
                `${state.progress.tests.failed} failed, ${state.progress.tests.skipped} skipped`);
        }
        if (state.progress.filesChanged.length > 0) {
            lines.push("", "**Files Changed**:");
            for (const file of state.progress.filesChanged)
                lines.push(`- ${file}`);
        }
        lines.push("");
    }
    addList(lines, "Remaining", state.remainingCriteria);
    addList(lines, "Blockers", state.blockers);
    addList(lines, "Discoveries", state.discoveries);
    addList(lines, "Cross-Round Outcomes", state.rollingOutcomes);
    addList(lines, "Recurring Issues", state.recurringIssues);
    addList(lines, "Failed Patterns", state.failedPatterns);
    addList(lines, "Retired Constraints", state.retiredConstraints);
    if (state.nextAction) {
        lines.push("## Next Action", "", state.nextAction, "");
    }
    if (state.verificationFlags.length > 0) {
        lines.push("## Verification", "");
        for (const flag of state.verificationFlags) {
            lines.push(`- [${flag.severity}] [${flag.check}] ${flag.detail}`);
        }
        lines.push("");
    }
    if (state.externalContext) {
        lines.push("## External Context", "", state.externalContext, "");
    }
    return lines.join("\n").trimEnd() + "\n";
}
export function createCanonicalLoopState(request, response, stateFilePath) {
    const last = request.last_round_result;
    const objective = response.loop_objective;
    const verificationFlags = request.verification_flags ?? [];
    const rolling = response.rolling_summary;
    const executionEvidence = last?.execution_evidence;
    const changes = unique([
        request.new_since_last_round,
        last?.output_summary,
        ...(last?.wrong_assumptions ?? []).map((value) => `Corrected assumption: ${value}`),
    ]);
    const discoveries = unique([
        ...(last?.discovered_constraints ?? []),
        ...(last?.emerged_subtasks ?? []),
    ]);
    const blockers = unique([
        ...(last?.constraint_violations ?? []),
        last?.manual_fixes_needed,
        request.rejection_notice,
        ...response.warnings,
    ]);
    return {
        schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
        loopId: response.loop_id || request.loop_id,
        round: response.round || request.round,
        maxRounds: request.max_rounds ?? 20,
        goalId: response.goal_id,
        objective: objective?.objective || request.task,
        objectiveVersion: objective?.version ?? 1,
        currentTask: request.task,
        successCriteria: unique(objective?.success_criteria ?? []),
        hardConstraints: unique(objective?.hard_constraints ?? []),
        activeConstraints: unique(response.constraints_active),
        retiredConstraints: unique(response.constraints_retired),
        changesSinceLastRound: changes,
        remainingCriteria: unique(last?.execution_evidence?.success_criteria_remaining ?? []),
        blockers,
        verificationFlags,
        discoveries,
        nextAction: last?.next_action?.trim() || response.suggested_next_task,
        rollingOutcomes: unique(rolling?.key_outcomes ?? []),
        recurringIssues: unique(rolling?.recurring_issues ?? []),
        failedPatterns: unique(rolling?.failed_patterns ?? []),
        checkpoints: response.checkpoint_summary
            ? [response.checkpoint_summary]
            : [],
        suggestedNextTask: response.suggested_next_task,
        externalContext: request.external_context?.trim() ?? "",
        stateFilePath,
        progress: {
            estimate: executionEvidence?.progress_estimate ?? null,
            criteriaMet: unique(executionEvidence?.success_criteria_met ?? []),
            criteriaRemaining: unique(executionEvidence?.success_criteria_remaining ?? []),
            filesChanged: unique(executionEvidence?.files_changed ?? []),
            tests: executionEvidence?.test_results ?? null,
        },
    };
}
//# sourceMappingURL=canonical-state.js.map