/** Compile typed v3 workflow state into one prompt artifact. */
import { AgentStatus, makeConstraintMeta, makeExecutionHistorySummary, makeLoopCompileResponse, makeLoopObjective, makeMilestoneSummary, } from "./protocol.js";
import { createCanonicalLoopState, renderCanonicalStateMarkdown } from "./canonical-state.js";
import { assemblePromptArtifact } from "./prompt-assembler.js";
import { decidePromptLevel } from "./prompt-policy.js";
import { getPolicy } from "./policy.js";
import { deriveStableItemId, entryRound, unique } from "./token-utils.js";
function contextEntries(context) {
    if (!context || !Array.isArray(context.results))
        return [];
    return context.results.filter((item) => item !== null && typeof item === "object" && !Array.isArray(item));
}
function lineage(entry) {
    const value = entry.loop_lineage;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function loopEntries(loopId, context) {
    return contextEntries(context)
        .filter((entry) => entry.loop_id === loopId || lineage(entry).loop_id === loopId)
        .sort((left, right) => entryRound(left) - entryRound(right));
}
export function computeGoalTextHash(text) {
    return deriveStableItemId(text, 12);
}
export function deriveGoalId(loopId, task, explicit = "") {
    if (explicit.trim())
        return explicit.trim();
    const slug = task.trim().toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48);
    return `${loopId}:${slug || computeGoalTextHash(task)}`;
}
function roundReport(entry) {
    const value = entry.round_report;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
export function getPreviousRound(loopId, round, context) {
    const entries = loopEntries(loopId, context);
    const entry = [...entries].reverse()
        .find((candidate) => entryRound(candidate) === round && roundReport(candidate));
    if (!entry)
        return null;
    const data = lineage(entry);
    const compileLineage = [...entries].reverse()
        .map((candidate) => ({ candidate, data: lineage(candidate) }))
        .find(({ candidate, data: candidateLineage }) => entryRound(candidate) === round &&
        typeof candidateLineage.goal_id === "string" &&
        candidateLineage.goal_id.length > 0);
    const report = roundReport(entry);
    const status = ["completed", "blocked", "in_progress"].includes(String(report.status))
        ? report.status
        : "in_progress";
    return {
        round,
        goal_id: typeof data.goal_id === "string" && data.goal_id.length > 0
            ? data.goal_id
            : typeof compileLineage?.data.goal_id === "string" ? compileLineage.data.goal_id : "",
        goal_text_hash: typeof data.goal_text_hash === "string" && data.goal_text_hash.length > 0
            ? data.goal_text_hash
            : typeof compileLineage?.data.goal_text_hash === "string" ? compileLineage.data.goal_text_hash : "",
        status,
        task: typeof entry.task === "string" && entry.task.length > 0
            ? entry.task
            : typeof compileLineage?.candidate.task === "string" ? compileLineage.candidate.task : "",
        constraints_active: Array.isArray(data.constraints_active)
            ? data.constraints_active.filter((item) => typeof item === "string") : [],
        summary: typeof report.summary === "string" ? report.summary : "",
    };
}
function latestObjective(loopId, context) {
    for (const entry of [...loopEntries(loopId, context)].reverse()) {
        const raw = entry.loop_objective;
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            continue;
        const value = raw;
        return makeLoopObjective({
            objective: typeof value.objective === "string" ? value.objective : "",
            success_criteria: Array.isArray(value.success_criteria)
                ? value.success_criteria.filter((item) => typeof item === "string") : [],
            hard_constraints: Array.isArray(value.hard_constraints)
                ? value.hard_constraints.filter((item) => typeof item === "string") : [],
            created_at_round: typeof value.created_at_round === "number" ? value.created_at_round : 1,
            loop_id: loopId,
            version: typeof value.version === "number" ? value.version : 1,
            refinement_history: [],
        });
    }
    return null;
}
function objectiveFor(request, context) {
    return request.loop_objective ?? latestObjective(request.loop_id, context) ?? makeLoopObjective({
        objective: request.task,
        success_criteria: ["Task goal achieved with verifiable evidence"],
        hard_constraints: unique(request.constraints_from_plan),
        created_at_round: 1,
        loop_id: request.loop_id,
    });
}
function constraintProjection(objective, planConstraints) {
    const active = unique([...objective.hard_constraints, ...objective.success_criteria, ...planConstraints])
        .slice(0, getPolicy().evolution.max_active_constraints);
    const hard = new Set(objective.hard_constraints);
    const criteria = new Set(objective.success_criteria);
    return {
        active,
        metadata: active.map((text) => makeConstraintMeta({
            id: `c-${deriveStableItemId(text)}`,
            text,
            discovered_at_round: 1,
            last_violated_at_round: 0,
            source: hard.has(text) ? "hard" : criteria.has(text) ? "criteria" : "plan",
            status: "active",
        })),
    };
}
function workflowMilestones(entries) {
    const milestones = [];
    for (const entry of entries) {
        const data = lineage(entry);
        const event = typeof data.event_type === "string" ? data.event_type : "";
        if (!["step_result", "plan_updated", "plan_submitted", "backtrack", "audit_completed"].includes(event))
            continue;
        const round = entryRound(entry);
        const kind = event === "step_result" ? "step_boundary"
            : event === "backtrack" ? "backtrack"
                : event === "audit_completed" ? "audit" : "plan_refinement";
        const label = event === "step_result" && typeof data.step_id === "string"
            ? `Step ${data.step_id}` : event.replace(/_/g, " ");
        milestones.push(makeMilestoneSummary({
            label,
            round_range: { start: round, end: round },
            outcome: typeof data.summary === "string" ? data.summary : label,
            kind,
            generated_at_round: round,
        }));
    }
    return milestones.slice(-getPolicy().summary.max_milestones);
}
function buildExecutionHistory(loopId, context) {
    const entries = loopEntries(loopId, context);
    const reports = entries.map(roundReport).filter((item) => item !== null);
    const outcomes = reports.map((report) => typeof report.summary === "string" ? report.summary : "").filter(Boolean);
    const blocked = reports.filter((report) => report.status === "blocked")
        .map((report) => typeof report.summary === "string" ? report.summary : "").filter(Boolean);
    return makeExecutionHistorySummary({
        recentOutcomes: outcomes.slice(-getPolicy().summary.window),
        blockedOutcomes: unique(blocked).slice(-getPolicy().summary.window),
        roundsSampled: reports.length,
        latestRound: entries.reduce((max, entry) => Math.max(max, entryRound(entry)), 0),
        milestones: workflowMilestones(entries),
        synthesis: outcomes.length ? outcomes.slice(-3).join(" ") : "",
    });
}
function levelDecision(request, context) {
    const previous = getPreviousRound(request.loop_id, request.round - 1, context);
    const entries = loopEntries(request.loop_id, context);
    const lastFullRound = entries.filter((entry) => lineage(entry).recompile_level === "l2")
        .map(entryRound).filter((round) => round < request.round).at(-1) ?? 1;
    return decidePromptLevel({
        round: request.round,
        attempt: request.attempt,
        forceLevel: request.force_level,
        hasPlanSource: request.plan_boundary === true,
        checkpointBoundary: request.last_evaluation?.status === "completed",
        goalChanged: previous !== null && previous.goal_id !== deriveGoalId(request.loop_id, request.task, request.goal_id),
        previousStateMissing: request.round > 1 && previous === null,
        previousFailedWithoutNewInformation: request.last_evaluation?.status === "in_progress" &&
            request.last_evaluation.materialAdvancement?.material === false,
        verificationContradicted: (request.verification_flags ?? []).some((flag) => flag.severity === "error"),
        consecutiveRejections: request.consecutive_rejections,
        fullRefreshInterval: getPolicy().prompt.full_refresh_interval,
        lastFullRound,
    });
}
export function decideLevel(request, context) {
    return levelDecision(request, context).level;
}
export function buildRoundReportBlock(request) {
    const mode = request.attempt > 1 ? "step_retry" : request.report_mode ?? "step_continue";
    const targets = request.report_claim_targets ?? [];
    return [
        "### Round Report Contract",
        `Mode: ${mode}`,
        targets.length ? `Required claims: ${targets.map((target) => target.id).join(", ")}` : "Required claims: none",
        "Use status `in_progress`, `completed`, or `blocked`. Completed requires evidence for every required claim; blocked requires a blocker.",
        "Evidence references use `file:`, `check:`, or `provider:` prefixes. Omit unused optional fields.",
    ].join("\n");
}
export function compileLoop(request, context) {
    const decision = levelDecision(request, context);
    const objective = objectiveFor(request, context);
    const constraints = constraintProjection(objective, request.constraints_from_plan);
    const history = buildExecutionHistory(request.loop_id, context);
    const warnings = unique(request.last_evaluation?.evidenceEnvelope.contradictions ?? []);
    const response = makeLoopCompileResponse({
        status: AgentStatus.OK,
        recompile_level: decision.level,
        diff_from_previous: decision.reasons.join(","),
        lineage: [`${request.loop_id}:r${request.round}`],
        constraints_active: constraints.active,
        constraint_metadata: constraints.metadata,
        loop_id: request.loop_id,
        round: request.round,
        goal_id: deriveGoalId(request.loop_id, request.task, request.goal_id),
        goal_text_hash: computeGoalTextHash(request.task),
        loop_objective: objective,
        executionHistory: history,
        warnings,
    });
    const policy = getPolicy();
    const statePath = `${policy.state_file.directory}/${request.loop_id}-state.md`;
    const state = createCanonicalLoopState(request, response, statePath);
    const markdown = renderCanonicalStateMarkdown(state);
    const adaptiveL2 = policy.prompt.l2_adaptive_enabled
        ? Math.min(policy.prompt.l2_max_chars + request.round * policy.prompt.l2_adaptive_round_factor +
            history.milestones.length * policy.prompt.l2_adaptive_milestone_factor, policy.prompt.l2_adaptive_max_chars)
        : policy.prompt.l2_max_chars;
    const artifact = assemblePromptArtifact({
        state,
        level: decision.level,
        reasons: decision.reasons,
        mode: policy.prompt.injection_mode,
        budgets: { l0: policy.prompt.l0_max_chars, l1: policy.prompt.l1_max_chars, l2: adaptiveL2 },
        attempt: request.attempt,
        roundId: request.round_id,
        reportInstructions: buildRoundReportBlock(request),
        reportMode: request.attempt > 1 ? "step_retry" : request.report_mode ?? "step_continue",
        fullStateMarkdown: policy.prompt.l2_pointer_enabled ? undefined : markdown,
        contextRequest: request.last_evaluation?.contextRequest,
        graphSliceMaxChars: policy.prompt.graph_slice_max_chars,
    });
    response.prompt = artifact.renderedPrompt;
    response.prompt_artifact = artifact;
    response.state_file_content = policy.state_file.enabled ? markdown : undefined;
    return response;
}
//# sourceMappingURL=loop-compiler.js.map