/** Self-evaluation extraction and parsing — pure functions.
 *
 * These functions parse an Agent's raw output into a structured
 * SelfEvaluation. They have no dependency on Engine state, file I/O,
 * or external services. They are shared by both the MCP tool handler
 * (which receives structured JSON directly) and the legacy invoke
 * path (which regex-scans free-text Agent output).
 */
import { makeExecutionEvidence, makeSelfEvaluation, SELF_EVAL_REGEX, } from "./protocol.js";
// ── Raw parsing helpers ───────────────────────────────────────────────────
/** v2.12: Parse retroactive claims — {round ≥ 1, claim non-empty}, capped at
 *  20 entries. Invalid entries are silently dropped (lenient parsing). */
function parseRetroactiveClaims(raw) {
    if (!Array.isArray(raw))
        return [];
    const claims = [];
    for (const item of raw) {
        if (claims.length >= 20)
            break;
        if (typeof item !== "object" || item === null || Array.isArray(item))
            continue;
        const record = item;
        if (typeof record.round !== "number" || !Number.isInteger(record.round) ||
            record.round < 1 || typeof record.claim !== "string" ||
            record.claim.trim().length === 0) {
            continue;
        }
        claims.push({ round: record.round, claim: record.claim.slice(0, 500) });
    }
    return claims;
}
/** Parse ExecutionEvidence from a raw JSON object. */
export function parseExecutionEvidence(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const testResults = raw.test_results;
    return makeExecutionEvidence({
        files_changed: Array.isArray(raw.files_changed)
            ? raw.files_changed.filter((v) => typeof v === "string")
            : [],
        test_results: testResults && typeof testResults.passed === "number"
            ? {
                passed: testResults.passed,
                failed: testResults.failed ?? 0,
                skipped: testResults.skipped ?? 0,
            }
            : null,
        success_criteria_met: Array.isArray(raw.success_criteria_met)
            ? raw.success_criteria_met.filter((v) => typeof v === "string")
            : [],
        success_criteria_remaining: Array.isArray(raw.success_criteria_remaining)
            ? raw.success_criteria_remaining.filter((v) => typeof v === "string")
            : [],
        progress_estimate: typeof raw.progress_estimate === "number"
            ? Math.max(0, Math.min(1, raw.progress_estimate))
            : 0.0,
    });
}
/** Parse CriterionRevision[] from a raw JSON array. */
export function parseCriterionRevisions(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((v) => typeof v === "object" && v !== null &&
        typeof v.old === "string" &&
        typeof v.new === "string")
        .map((v) => {
        const r = v;
        return { old: r.old, new: r.new };
    });
}
/** Parse WorkerResult[] from a raw JSON array. */
export function parseWorkerResults(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((v) => typeof v === "object" && v !== null &&
        typeof v.agentId === "string" &&
        typeof v.subTask === "string" &&
        typeof v.resultSummary === "string")
        .map((v) => {
        const w = v;
        return {
            agentId: w.agentId,
            subAgentType: typeof w.subAgentType === "string" ? w.subAgentType : "general-purpose",
            subTask: w.subTask,
            resultSummary: w.resultSummary,
            success: typeof w.success === "boolean" ? w.success : false,
            // v2.12: Declared outcome wins; derived from success when absent.
            outcome: w.outcome === "success" || w.outcome === "partial" || w.outcome === "failed"
                ? w.outcome
                : undefined,
            discoveredConstraints: Array.isArray(w.discoveredConstraints)
                ? w.discoveredConstraints.filter((c) => typeof c === "string")
                : [],
        };
    });
}
// ── Self-evaluation extraction ───────────────────────────────────────────
/** Extract a structured SelfEvaluation from agent output text.
 *  Returns null if no valid self-eval block is found.
 *  The agent is instructed to output JSON between the delimiters. */
export function extractSelfEvaluation(text) {
    return extractSelfEvaluationWithDiagnostics(text).selfEval;
}
/** v2.12: The effective round outcome — declared outcome wins, otherwise
 *  derived from `success`. "partial" can only be declared explicitly (never
 *  silently derived from success=false, which would quietly change the
 *  success-class enforcement surface). */
export function effectiveOutcome(selfEval) {
    if (selfEval.outcome === "success" || selfEval.outcome === "partial" ||
        selfEval.outcome === "failed" || selfEval.outcome === "blocked") {
        return selfEval.outcome;
    }
    return selfEval.success ? "success" : "failed";
}
/** v2.12: Whether the effective outcome is a success claim. Shared by the
 *  verification gate (success-class checks) and enforcement gate (R3). */
export function effectiveSuccess(selfEval) {
    return effectiveOutcome(selfEval) === "success";
}
/** v2.12: Minimal outcome inference from free text — DIAGNOSTICS ONLY.
 *  The runtime never guesses state from text; this only tells the agent
 *  what was recognizable so it can resubmit a structured evaluation. */
export function inferOutcomeFromText(text) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length === 0)
        return null;
    let outcome = "partial";
    // NOTE: \b is ASCII-word based, so CJK keywords are matched without it.
    if (/(?:completed?|success|done|finished)\b|完成|成功/i.test(trimmed))
        outcome = "success";
    else if (/(?:failed?|error|cannot|unable)\b|失败|错误/i.test(trimmed))
        outcome = "failed";
    const summary = trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
    return { outcome, summary };
}
/** v2.12: Extraction with a structured failure reason. Behavior identical
 *  to extractSelfEvaluation on success; the reason powers the stalled
 *  diagnostic message so the agent knows exactly what to fix. */
export function extractSelfEvaluationWithDiagnostics(text) {
    const match = text.match(SELF_EVAL_REGEX);
    if (!match)
        return { selfEval: null, reason: "no_eval_block" };
    let parsed;
    try {
        parsed = JSON.parse(match[1]);
    }
    catch {
        return { selfEval: null, reason: "json_parse_failed" };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { selfEval: null, reason: "json_parse_failed" };
    }
    const record = parsed;
    if (typeof record.success !== "boolean" ||
        typeof record.output_summary !== "string" ||
        !Array.isArray(record.constraint_violations) ||
        typeof record.should_continue !== "boolean") {
        return { selfEval: null, reason: "missing_required_fields" };
    }
    return { selfEval: buildSelfEvaluation(record), reason: null };
}
/** v2.12: Field-level validation gaps — diagnostics only. Collects what
 *  buildSelfEvaluation silently tolerates, without changing acceptance. */
export function collectSelfEvalGaps(raw) {
    const gaps = [];
    if (typeof raw.success !== "boolean")
        gaps.push({ field: "success", issue: "must be a boolean" });
    if (typeof raw.output_summary !== "string") {
        gaps.push({ field: "output_summary", issue: "must be a string" });
    }
    if (!Array.isArray(raw.constraint_violations)) {
        gaps.push({ field: "constraint_violations", issue: "must be an array" });
    }
    if (typeof raw.should_continue !== "boolean") {
        gaps.push({ field: "should_continue", issue: "must be a boolean" });
    }
    if (raw.outcome !== undefined && typeof raw.outcome !== "string") {
        gaps.push({ field: "outcome", issue: "must be a string enum (success|partial|failed|blocked)" });
    }
    if (raw.blocker !== undefined && typeof raw.blocker !== "string") {
        gaps.push({ field: "blocker", issue: "must be a string" });
    }
    if (raw.retroactiveClaims !== undefined && !Array.isArray(raw.retroactiveClaims)) {
        gaps.push({ field: "retroactiveClaims", issue: "must be an array of {round, claim}" });
    }
    return gaps;
}
/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults. */
export function buildSelfEvaluation(raw) {
    const executionEvidence = parseExecutionEvidence(raw.execution_evidence);
    const retractedConstraints = Array.isArray(raw.retracted_constraints)
        ? raw.retracted_constraints.filter((v) => typeof v === "string")
        : [];
    const revisedCriteria = parseCriterionRevisions(raw.revised_success_criteria);
    const wrongAssumptions = Array.isArray(raw.wrong_assumptions)
        ? raw.wrong_assumptions.filter((v) => typeof v === "string")
        : [];
    const workerResults = parseWorkerResults(raw.worker_results);
    return makeSelfEvaluation({
        success: typeof raw.success === "boolean" ? raw.success : false,
        output_summary: typeof raw.output_summary === "string" ? raw.output_summary : "",
        constraint_violations: Array.isArray(raw.constraint_violations)
            ? raw.constraint_violations.filter((v) => typeof v === "string")
            : [],
        should_continue: typeof raw.should_continue === "boolean" ? raw.should_continue : true,
        discovered_constraints: Array.isArray(raw.discovered_constraints)
            ? raw.discovered_constraints.filter((v) => typeof v === "string")
            : [],
        objective_refinement: typeof raw.objective_refinement === "string"
            ? raw.objective_refinement
            : "",
        emerged_subtasks: Array.isArray(raw.emerged_subtasks)
            ? raw.emerged_subtasks.filter((v) => typeof v === "string")
            : [],
        execution_evidence: executionEvidence,
        retracted_constraints: retractedConstraints,
        revised_success_criteria: revisedCriteria,
        wrong_assumptions: wrongAssumptions,
        worker_results: workerResults,
        compression_checkpoint: typeof raw.compression_checkpoint === "boolean" ? raw.compression_checkpoint : false,
        checkpoint_label: typeof raw.checkpoint_label === "string" ? raw.checkpoint_label : "",
        next_action: typeof raw.next_action === "string" ? raw.next_action : undefined,
        completed_subtasks: Array.isArray(raw.completed_subtasks)
            ? raw.completed_subtasks.filter((v) => typeof v === "string")
            : [],
        blocked_subtasks: Array.isArray(raw.blocked_subtasks)
            ? raw.blocked_subtasks.filter((v) => typeof v === "string")
            : [],
        canceled_subtasks: Array.isArray(raw.canceled_subtasks)
            ? raw.canceled_subtasks.filter((v) => typeof v === "string")
            : [],
        stop_reason: raw.stop_reason === "gave_up" || raw.stop_reason === "blocked" || raw.stop_reason === "needs_human_input"
            ? raw.stop_reason
            : undefined,
        outcome: raw.outcome === "success" || raw.outcome === "partial" ||
            raw.outcome === "failed" || raw.outcome === "blocked"
            ? raw.outcome
            : undefined,
        blocker: typeof raw.blocker === "string" && raw.blocker.trim().length > 0
            ? raw.blocker.slice(0, 500)
            : undefined,
        retroactiveClaims: parseRetroactiveClaims(raw.retroactiveClaims),
        no_change_reason: typeof raw.no_change_reason === "string" && raw.no_change_reason.trim().length > 0
            ? raw.no_change_reason.slice(0, 200)
            : undefined,
        drift_clarification: typeof raw.drift_clarification === "string" ? raw.drift_clarification : undefined,
        prompt_requests: parsePromptRequests(raw.prompt_requests),
        round_contract: parseRoundContract(raw.round_contract),
    });
}
/** Parse a RoundContract object from raw JSON input. Lenient: non-string
 *  entries are dropped, strings are trimmed and capped. An object that IS
 *  present is returned even with empty arrays — an empty contract is a
 *  real declaration the round_underspecified check must see. Returns
 *  undefined only when the raw value is absent or not an object. */
export function parseRoundContract(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const obj = raw;
    const capStrings = (value, max, cap) => Array.isArray(value)
        ? value
            .filter((v) => typeof v === "string")
            .map((v) => v.trim().slice(0, max))
            .filter(Boolean)
            .slice(0, cap)
        : [];
    return {
        work_item: typeof obj.work_item === "string" && obj.work_item.trim().length > 0
            ? obj.work_item.trim().slice(0, 200)
            : undefined,
        done_when: capStrings(obj.done_when, 200, 20),
        verification_plan: capStrings(obj.verification_plan, 200, 20),
        scope: capStrings(obj.scope, 500, 50),
        boundary_reason: typeof obj.boundary_reason === "string" && obj.boundary_reason.trim().length > 0
            ? obj.boundary_reason.trim().slice(0, 500)
            : undefined,
    };
}
/** Parse a PromptRequests object from raw JSON input.
 *  Lenient: missing or invalid fields get sensible defaults.
 *  Returns undefined if the raw value is absent or not an object,
 *  so makeSelfEvaluation can distinguish "not set" from "empty".
 *  Exported for the engine's last_round_result rebuild — the MCP
 *  lifecycle assembles prompt_requests into the request, but every
 *  compile path funnels through engine.invokeLoopCompile, whose
 *  field-by-field reconstruction must preserve them (v3.3.1). */
export function parsePromptRequests(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const obj = raw;
    const emphasize = Array.isArray(obj.emphasize)
        ? obj.emphasize.filter((v) => typeof v === "string").slice(0, 10)
        : [];
    const validExpands = new Set([
        "milestones", "sub_goals", "constraint_lifecycle",
        "agent_trust", "progress", "loop_synthesis",
    ]);
    const expand = Array.isArray(obj.expand)
        ? obj.expand.filter((v) => typeof v === "string" && validExpands.has(v))
        : [];
    const confusionPoints = Array.isArray(obj.confusion_points)
        ? obj.confusion_points.filter((v) => typeof v === "string").slice(0, 5)
        : [];
    // Return undefined when all fields are empty — semantically equivalent
    // to "not set", avoids carrying an empty object through the pipeline.
    if (emphasize.length === 0 && expand.length === 0 && confusionPoints.length === 0) {
        return undefined;
    }
    return { emphasize, expand, confusion_points: confusionPoints };
}
// v2.6: heuristicSelfEvaluation removed — if structured extraction fails,
// the round is stalled. The 20-line keyword heuristic was dead weight; an
// agent that can't produce a structured self-evaluation is genuinely stuck.
//# sourceMappingURL=self-eval.js.map