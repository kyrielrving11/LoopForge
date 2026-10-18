/** Structured self-evaluation parsing and normalization — pure functions.
 * The MCP boundary validates required fields before these helpers run.
 */
import { makeExecutionReport, makeSelfEvaluation, } from "./protocol.js";
import { retiredFieldDetail, submittedFieldPaths, unknownExecutionReportEntryFields, unknownTopLevelFields, } from "./submission-guidance.js";
import { DIAG_ALL_ENTRIES_DROPPED, DIAG_EMPTY_VALUE, } from "./submission-diagnostics.js";
const DIAGNOSTICS_LIMIT = 100;
class DiagnosticsCollector {
    entries = [];
    omitted = 0;
    push(path, code, handling, detail) {
        if (this.entries.length >= DIAGNOSTICS_LIMIT) {
            this.omitted++;
            return;
        }
        this.entries.push({ path, code, handling, detail });
    }
    finish() {
        if (this.omitted > 0) {
            this.entries.push({
                path: "diagnostics",
                code: "diagnostics_truncated",
                handling: "truncated",
                detail: `${this.omitted} more diagnostic(s) omitted`,
            });
        }
        return this.entries;
    }
}
// ── Raw parsing helpers ───────────────────────────────────────────────────
function boundedString(value, maxChars, sink, path = "") {
    if (value === undefined)
        return undefined;
    if (value === null) {
        sink?.push(path, "invalid_value", "dropped", "expected a string; null was dropped");
        return undefined;
    }
    if (typeof value !== "string") {
        sink?.push(path, "invalid_value", "dropped", `expected a string; the value was dropped`);
        return undefined;
    }
    if (value.length > maxChars) {
        sink?.push(path, "truncated", "truncated", `longer than ${maxChars} chars; truncated to the limit`);
        return value.slice(0, maxChars);
    }
    return value;
}
function boundedStringArray(value, maxItems, maxChars, sink, path = "") {
    if (value === undefined || value === null)
        return [];
    if (!Array.isArray(value)) {
        sink?.push(path, "not_array", "dropped", `expected an array of strings; the value was dropped`);
        return [];
    }
    const strings = value.filter((item) => typeof item === "string");
    const invalid = value.length - strings.length;
    if (invalid > 0) {
        if (strings.length === 0) {
            sink?.push(path, DIAG_ALL_ENTRIES_DROPPED, "dropped", `all ${invalid} entr${invalid === 1 ? "y was" : "ies were"} invalid; the value was dropped`);
        }
        else {
            sink?.push(path, "invalid_entry", "dropped", `${invalid} non-string entr${invalid === 1 ? "y" : "ies"} dropped`);
        }
    }
    let truncated = 0;
    const bounded = strings.map((item) => {
        if (item.length > maxChars) {
            truncated++;
            return item.slice(0, maxChars);
        }
        return item;
    });
    if (truncated > 0) {
        sink?.push(path, "truncated", "truncated", `${truncated} entr${truncated === 1 ? "y was" : "ies were"} longer than ${maxChars} chars`);
    }
    if (bounded.length > maxItems) {
        sink?.push(path, "too_many", "truncated", `${bounded.length - maxItems} entr${bounded.length - maxItems === 1 ? "y" : "ies"} over the ${maxItems}-item cap were dropped`);
        return bounded.slice(0, maxItems);
    }
    return bounded;
}
/** v3.8.1: the emerged-subtask intake bound — ONE constant, because the
 *  sub-goal ids are derived by ORDINAL over this list. The strict submission
 *  boundary builds the reference space the agent may transition from, and the
 *  lenient normalizer builds the committed list every prompt compiles from;
 *  bounding them differently let the boundary accept a transition to a
 *  sub-goal the prompt could never carry, and the migration was then dropped
 *  by the compile path without a word. */
export const EMERGED_LIMITS = { items: 50, chars: 500 };
/** THE emerged-list normalization. Both the boundary and the committed
 *  evaluation call this, so the two sets cannot disagree. */
export function boundedEmergedSubtasks(value, sink) {
    return boundedStringArray(value, EMERGED_LIMITS.items, EMERGED_LIMITS.chars, sink, "emerged_subtasks");
}
function nonNegativeInteger(value, sink, path = "") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        if (value !== undefined && value !== null) {
            sink?.push(path, "invalid_value", "normalized", "expected a finite number; defaulted to 0");
        }
        return 0;
    }
    const normalized = Math.max(0, Math.trunc(value));
    if (normalized !== value) {
        sink?.push(path, "normalized", "normalized", `expected a non-negative integer; normalized to ${normalized}`);
    }
    return normalized;
}
/** v2.12: Parse retroactive claims — {round ≥ 1, claim non-empty}, capped at
 *  20 entries. Invalid entries are silently dropped (lenient parsing). */
function parseRetroactiveClaims(raw, sink) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        sink?.push("retroactiveClaims", "not_array", "dropped", "expected an array of { round, claim }; the value was dropped");
        return [];
    }
    const claims = [];
    let invalid = 0;
    for (const item of raw) {
        if (claims.length >= 20)
            break;
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            invalid++;
            continue;
        }
        const record = item;
        if (typeof record.round !== "number" || !Number.isInteger(record.round) ||
            record.round < 1 || typeof record.claim !== "string" ||
            record.claim.trim().length === 0) {
            invalid++;
            continue;
        }
        const claim = record.claim.length > 500 ? record.claim.slice(0, 500) : record.claim;
        if (claim !== record.claim) {
            sink?.push("retroactiveClaims", "truncated", "truncated", "a claim was longer than 500 chars and was truncated");
        }
        claims.push({ round: record.round, claim });
    }
    if (invalid > 0) {
        sink?.push("retroactiveClaims", claims.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped", claims.length === 0
            ? `all ${invalid} entries were malformed; the value was dropped`
            : `${invalid} malformed entr${invalid === 1 ? "y" : "ies"} dropped`);
    }
    if (raw.length > 20) {
        sink?.push("retroactiveClaims", "too_many", "truncated", `only the first 20 of ${raw.length} entries are kept`);
    }
    return claims;
}
/** Parse ExecutionReport from a raw JSON object. */
export function parseExecutionReport(raw, sink) {
    if (raw === undefined || raw === null)
        return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) {
        sink?.push("execution_report", "invalid_entry", "dropped", "expected an object; the value was dropped");
        return undefined;
    }
    for (const key of unknownExecutionReportEntryFields(raw)) {
        sink?.push(`execution_report.${key}`, "unknown_field", "dropped", "not a declared execution_report field; it was dropped");
    }
    const testResults = raw.tests_reported && typeof raw.tests_reported === "object" &&
        !Array.isArray(raw.tests_reported)
        ? raw.tests_reported
        : undefined;
    let tests = null;
    if (raw.tests_reported !== undefined && raw.tests_reported !== null) {
        if (!testResults) {
            sink?.push("execution_report.tests_reported", "invalid_entry", "dropped", "expected { passed, failed, skipped }; the value was dropped");
        }
        else if (typeof testResults.passed !== "number" ||
            !Number.isFinite(testResults.passed)) {
            sink?.push("execution_report.tests_reported", "invalid_value", "dropped", "`passed` must be a finite number; the whole object was dropped");
        }
        else {
            for (const key of Object.keys(testResults)) {
                if (key !== "passed" && key !== "failed" && key !== "skipped") {
                    sink?.push(`execution_report.tests_reported.${key}`, "unknown_field", "dropped", "not a declared test-count field; it was dropped");
                }
            }
            tests = {
                passed: nonNegativeInteger(testResults.passed, sink, "execution_report.tests_reported.passed"),
                failed: nonNegativeInteger(testResults.failed, sink, "execution_report.tests_reported.failed"),
                skipped: nonNegativeInteger(testResults.skipped, sink, "execution_report.tests_reported.skipped"),
            };
        }
    }
    return makeExecutionReport({
        files_changed: boundedStringArray(raw.files_changed, 200, 500, sink, "execution_report.files_changed"),
        tests_reported: tests,
        criterion_claims: parseCriterionClaims(raw.criterion_claims, sink),
        contract_item_claims: parseContractItemClaims(raw.contract_item_claims, sink),
    });
}
/** v3.8: The criterion ids the agent claims met this round. */
export function claimedMetCriteria(report) {
    return (report?.criterion_claims ?? [])
        .filter((claim) => claim.outcome === "met")
        .map((claim) => claim.criterion_id);
}
/** v3.8: The criterion ids the agent declares still outstanding. */
export function claimedRemainingCriteria(report) {
    return (report?.criterion_claims ?? [])
        .filter((claim) => claim.outcome === "remaining")
        .map((claim) => claim.criterion_id);
}
/** v3.8: LENIENT parse of advisory criterion claims — unknown or malformed
 *  entries are dropped, never a rejection (the contract item layer is the
 *  strict one). */
function parseCriterionClaims(raw, sink) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        sink?.push("execution_report.criterion_claims", "not_array", "dropped", "expected an array of claims; the value was dropped");
        return [];
    }
    const claims = [];
    let invalid = 0;
    for (let index = 0; index < raw.length; index++) {
        if (claims.length >= 100)
            break;
        const item = raw[index];
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            invalid++;
            continue;
        }
        const entry = item;
        if (typeof entry.criterion_id !== "string" ||
            entry.criterion_id.trim().length === 0 ||
            (entry.outcome !== "met" && entry.outcome !== "remaining")) {
            invalid++;
            continue;
        }
        const trimmed = entry.criterion_id.trim();
        if (trimmed !== entry.criterion_id) {
            sink?.push(`execution_report.criterion_claims[${index}].criterion_id`, "normalized", "normalized", "leading/trailing whitespace was trimmed");
        }
        if (trimmed.length > 500) {
            sink?.push(`execution_report.criterion_claims[${index}].criterion_id`, "truncated", "truncated", "longer than 500 chars; truncated to the limit");
        }
        claims.push({
            criterion_id: trimmed.slice(0, 500),
            outcome: entry.outcome,
        });
    }
    if (invalid > 0) {
        sink?.push("execution_report.criterion_claims", claims.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped", claims.length === 0
            ? `all ${invalid} claims were malformed; the value was dropped (advisory)`
            : `${invalid} malformed claim${invalid === 1 ? "" : "s"} dropped (advisory)`);
    }
    if (raw.length > 100) {
        sink?.push("execution_report.criterion_claims", "too_many", "truncated", "only the first 100 claims are kept");
    }
    return claims;
}
/** v3.8: LENIENT parse of contract item claims. Referential validity is the
 *  strict pre-advance boundary in validateContractShape — this parser only
 *  normalizes what reaches the read model. */
function parseContractItemClaims(raw, sink) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        sink?.push("execution_report.contract_item_claims", "not_array", "dropped", "expected an array of claims; the value was dropped");
        return [];
    }
    const claims = [];
    let invalid = 0;
    for (let index = 0; index < raw.length; index++) {
        if (claims.length >= 20)
            break;
        const item = raw[index];
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            invalid++;
            continue;
        }
        const entry = item;
        if (typeof entry.item_id !== "string" ||
            (entry.outcome !== "met" && entry.outcome !== "remaining")) {
            invalid++;
            continue;
        }
        const trimmed = entry.item_id.trim();
        if (trimmed !== entry.item_id) {
            sink?.push(`execution_report.contract_item_claims[${index}].item_id`, "normalized", "normalized", "leading/trailing whitespace was trimmed");
        }
        if (trimmed.length > 64) {
            sink?.push(`execution_report.contract_item_claims[${index}].item_id`, "truncated", "truncated", "longer than 64 chars; truncated to the limit");
        }
        claims.push({
            item_id: trimmed.slice(0, 64),
            outcome: entry.outcome,
        });
    }
    if (invalid > 0) {
        sink?.push("execution_report.contract_item_claims", claims.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped", claims.length === 0
            ? `all ${invalid} claims were malformed; the value was dropped`
            : `${invalid} malformed claim${invalid === 1 ? "" : "s"} dropped`);
    }
    if (raw.length > 20) {
        sink?.push("execution_report.contract_item_claims", "too_many", "truncated", "only the first 20 claims are kept");
    }
    return claims;
}
/** Parse CriterionRevision[] from a raw JSON array. */
export function parseCriterionRevisions(raw, sink) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        sink?.push("revised_success_criteria", "not_array", "dropped", "expected an array of { old, new }; the value was dropped");
        return [];
    }
    const valid = raw.filter((v) => typeof v === "object" && v !== null &&
        typeof v.old === "string" &&
        typeof v.new === "string");
    const invalid = raw.length - valid.length;
    if (invalid > 0) {
        sink?.push("revised_success_criteria", valid.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped", valid.length === 0
            ? `all ${invalid} entries lacked string old/new; the value was dropped`
            : `${invalid} entr${invalid === 1 ? "y" : "ies"} without string old/new dropped`);
    }
    if (valid.length > 20) {
        sink?.push("revised_success_criteria", "too_many", "truncated", "only the first 20 revisions are kept");
    }
    return valid.slice(0, 20).map((v, index) => {
        const r = v;
        for (const key of ["old", "new"]) {
            if (r[key].length > 500) {
                sink?.push(`revised_success_criteria[${index}].${key}`, "truncated", "truncated", "longer than 500 chars; truncated to the limit");
            }
        }
        return {
            old: r.old.slice(0, 500),
            new: r.new.slice(0, 500),
        };
    });
}
/** Parse SubGoalUpdate[] from a raw JSON array.
 *  v3.7.1: lenient per-entry filtering (id/status shape) with fixed caps
 *  (20 entries, id ≤ 64, note ≤ 300). Referential validity — unknown IDs
 *  and illegal migrations — is NOT checked here: that needs the committed
 *  sub-goal set and runs as a pre-advance validation (evaluation_invalid). */
export function parseSubGoalUpdates(raw, sink) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        sink?.push("subgoal_updates", "not_array", "dropped", "expected an array of { id, status }; the value was dropped");
        return [];
    }
    const valid = raw.filter((v) => typeof v === "object" && v !== null &&
        typeof v.id === "string" &&
        (v.status === "in_progress" ||
            v.status === "done" ||
            v.status === "blocked" ||
            v.status === "canceled"));
    const invalid = raw.length - valid.length;
    if (invalid > 0) {
        sink?.push("subgoal_updates", valid.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped", valid.length === 0
            ? `all ${invalid} transitions were malformed; the value was dropped`
            : `${invalid} malformed transition${invalid === 1 ? "" : "s"} dropped`);
    }
    if (valid.length > 20) {
        sink?.push("subgoal_updates", "too_many", "truncated", "only the first 20 transitions are kept");
    }
    return valid.slice(0, 20).map((u, index) => {
        const rawId = u.id;
        const trimmedId = rawId.trim();
        if (trimmedId !== rawId) {
            sink?.push(`subgoal_updates[${index}].id`, "normalized", "normalized", "leading/trailing whitespace was trimmed");
        }
        if (trimmedId.length > 64) {
            sink?.push(`subgoal_updates[${index}].id`, "truncated", "truncated", "longer than 64 chars; truncated to the limit");
        }
        const update = {
            id: trimmedId.slice(0, 64),
            status: u.status,
        };
        if (u.note !== undefined) {
            if (typeof u.note !== "string") {
                sink?.push(`subgoal_updates[${index}].note`, "invalid_value", "dropped", "expected a string; the note was dropped");
            }
            else if (u.note.trim().length === 0) {
                sink?.push(`subgoal_updates[${index}].note`, DIAG_EMPTY_VALUE, "dropped", "empty note was dropped");
            }
            else {
                const note = u.note.trim();
                if (note.length > 300) {
                    sink?.push(`subgoal_updates[${index}].note`, "truncated", "truncated", "a note was longer than 300 chars and was truncated");
                }
                update.note = note.slice(0, 300);
            }
        }
        return update;
    });
}
/** Parse WorkerResult[] from a raw JSON array.
 *  v3.7.1: `outcome` is the single fact. An entry without a valid outcome
 *  is dropped (not derived, not defaulted) — the array stays informational:
 *  absent/empty arrays are accepted unchanged, so a round without any
 *  delegation can never be rejected over worker fields. */
export function parseWorkerResults(raw, sink) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        sink?.push("worker_results", "not_array", "dropped", "expected an array of worker reports; the value was dropped");
        return [];
    }
    const valid = raw.filter((v) => {
        if (typeof v !== "object" || v === null || Array.isArray(v))
            return false;
        const w = v;
        return typeof w.agentId === "string" &&
            typeof w.subTask === "string" &&
            typeof w.resultSummary === "string" &&
            (w.outcome === "success" || w.outcome === "partial" || w.outcome === "failed");
    });
    const invalid = raw.length - valid.length;
    if (invalid > 0) {
        sink?.push("worker_results", valid.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped", valid.length === 0
            ? `all ${invalid} reports were malformed; the value was dropped`
            : `${invalid} report${invalid === 1 ? "" : "s"} missing a string agentId/subTask/resultSummary or a valid outcome dropped`);
    }
    if (valid.length > 20) {
        sink?.push("worker_results", "too_many", "truncated", "only the first 20 worker reports are kept");
    }
    return valid.slice(0, 20).map((v, index) => {
        const w = v;
        for (const key of Object.keys(w)) {
            if (!["agentId", "subAgentType", "subTask", "resultSummary", "outcome",
                "discoveredConstraints"].includes(key)) {
                sink?.push(`worker_results[${index}].${key}`, "unknown_field", "dropped", "not a declared worker-result field; it was dropped");
            }
        }
        if (w.subAgentType !== undefined && typeof w.subAgentType !== "string") {
            sink?.push(`worker_results[${index}].subAgentType`, "invalid_value", "normalized", "expected a string; defaulted to general-purpose");
        }
        for (const [key, cap] of [
            ["agentId", 200], ["subAgentType", 100], ["subTask", 500], ["resultSummary", 1000],
        ]) {
            const value = w[key];
            if (typeof value === "string" && value.length > cap) {
                sink?.push(`worker_results[${index}].${key}`, "truncated", "truncated", `longer than ${cap} chars; truncated to the limit`);
            }
        }
        return {
            agentId: (w.agentId.slice(0, 200)),
            subAgentType: typeof w.subAgentType === "string"
                ? w.subAgentType.slice(0, 100)
                : "general-purpose",
            subTask: (w.subTask.slice(0, 500)),
            resultSummary: (w.resultSummary.slice(0, 1000)),
            outcome: w.outcome,
            discoveredConstraints: boundedStringArray(w.discoveredConstraints, 50, 500, sink, `worker_results[${index}].discoveredConstraints`),
        };
    });
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
/** v3.8.3: The ONE definition of "this round declares itself blocked".
 *
 *  A declared `outcome: "blocked"` and a `stop_reason` of `blocked` or
 *  `needs_human_input` say the same thing — the agent is stopping because it
 *  cannot continue, not because it finished. The stop decision
 *  (round-coordinator) and the scope-drift waiver (enforcement gate) both read
 *  this function, so "declared blocked" cannot mean two different things at
 *  two different boundaries. `effectiveOutcome` alone is NOT this predicate:
 *  it reads `outcome` only. */
export function declaresBlocked(selfEval) {
    return selfEval.outcome === "blocked" ||
        selfEval.stop_reason === "blocked" ||
        selfEval.stop_reason === "needs_human_input";
}
export function validateCoreSelfEvaluation(raw) {
    const missing = [];
    const invalid = [];
    const required = ["success", "output_summary", "constraint_violations", "should_continue"];
    for (const field of required) {
        if (!(field in raw))
            missing.push(field);
    }
    if ("success" in raw && typeof raw.success !== "boolean") {
        invalid.push({ field: "success", expected: "boolean" });
    }
    if ("output_summary" in raw && typeof raw.output_summary !== "string") {
        invalid.push({ field: "output_summary", expected: "string" });
    }
    if ("constraint_violations" in raw &&
        (!Array.isArray(raw.constraint_violations) ||
            raw.constraint_violations.some((value) => typeof value !== "string"))) {
        invalid.push({ field: "constraint_violations", expected: "array of strings" });
    }
    if ("should_continue" in raw && typeof raw.should_continue !== "boolean") {
        invalid.push({ field: "should_continue", expected: "boolean" });
    }
    return { missing, invalid };
}
/** v3.7.1: Strict structural checks for the sub-goal protocol fields
 *  (subgoal_updates / emerged_subtasks). Runs in the same pre-advance
 *  evaluation_invalid boundary as the four core fields: an error here is a
 *  payload defect, never a work-quality rejection — no session state, no
 *  gates, no rejection counters, retry with the same roundId.
 *
 *  Shape-only (no vault): entry shape, id pattern, status enum, caps, and
 *  the sg-XXXXXXXX creation prohibition on emerged_subtasks. Referential
 *  validity (unknown IDs / terminal references / illegal migrations) needs
 *  the committed sub-goal set and is checked against the compiled
 *  sub_goals right before advance (validateSubGoalUpdates in
 *  loop-compiler.ts). */
export function validateSubGoalUpdatesShape(raw) {
    const errors = [];
    const emerged = raw.emerged_subtasks;
    if (Array.isArray(emerged)) {
        for (const item of emerged) {
            if (typeof item === "string" && /^sg-[a-f0-9]{8}$/.test(item.trim())) {
                errors.push({
                    field: "emerged_subtasks",
                    reason: "id_in_creation",
                    detail: `"${item.trim()}" matches the sg-XXXXXXXX ID pattern — the creation channel never accepts ID references`,
                });
            }
        }
    }
    const updates = raw.subgoal_updates;
    if (updates === undefined)
        return errors;
    if (!Array.isArray(updates)) {
        errors.push({
            field: "subgoal_updates",
            reason: "not_array",
            detail: "subgoal_updates must be an array of { id, status, note? } entries",
        });
        return errors;
    }
    if (updates.length > 20) {
        errors.push({
            field: "subgoal_updates",
            reason: "too_many",
            detail: "at most 20 subgoal_updates entries per round",
        });
    }
    updates.forEach((entry, index) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            errors.push({
                field: "subgoal_updates",
                reason: "invalid_entry",
                detail: `entry ${index} is not an object`,
            });
            return;
        }
        const u = entry;
        const id = u.id;
        if (typeof id !== "string" || !/^sg-[a-f0-9]{8}$/.test(id.trim())) {
            errors.push({
                field: "subgoal_updates",
                reason: "invalid_id",
                detail: `entry ${index} must reference an sg-XXXXXXXX sub-goal ID`,
            });
        }
        const status = u.status;
        if (status !== "in_progress" && status !== "done" &&
            status !== "blocked" && status !== "canceled") {
            errors.push({
                field: "subgoal_updates",
                reason: "invalid_status",
                detail: `entry ${index} status must be one of in_progress | done | blocked | canceled`,
            });
        }
        // v3.8.1: `note` is deliberately NOT validated. protocol.ts documents it
        // as "lenient — never validated" free text, and `parseSubGoalUpdates`
        // drops a non-string note. Rejecting the WHOLE submission over a
        // reporting annotation contradicted that boundary: it was the only
        // lenient field that hard-rejected a round.
    });
    return errors;
}
const SUBGOAL_ID_RE = /^sg-[a-f0-9]{8}$/;
/** v3.8: `scope` is the round's declared file boundary, so containment is a
 *  trust boundary like every other workspace path — a declaration that names
 *  `/etc` or `../outside` is rejected, not silently normalized into a string
 *  the drift check can never match. */
function validateContractScope(scope, checkScopeEntry, errors) {
    if (scope === undefined)
        return;
    if (!Array.isArray(scope)) {
        errors.push({
            field: "round_contract",
            reason: "invalid_scope",
            detail: "scope must be an array of workspace-relative paths",
        });
        return;
    }
    if (scope.length > CONTRACT_LIMITS.scope) {
        errors.push({
            field: "round_contract",
            reason: "too_many_scope_entries",
            detail: `scope may list at most ${CONTRACT_LIMITS.scope} entries (got ${scope.length})`,
        });
    }
    scope.forEach((entry, index) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
            errors.push({
                field: "round_contract",
                reason: "invalid_scope_entry",
                detail: `scope entry ${index} must be a non-empty string`,
            });
            return;
        }
        const detail = checkScopeEntry(entry.trim());
        if (detail) {
            errors.push({
                field: "round_contract",
                reason: "scope_outside_workspace",
                detail: `scope entry ${index} "${entry.trim()}" ${detail}`,
            });
        }
    });
}
function validateContractItem(item, index, context, errors) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
        errors.push({
            field: "round_contract",
            reason: "invalid_item",
            detail: `item ${index} is not an object`,
        });
        return;
    }
    const entry = item;
    if (typeof entry.description !== "string" || entry.description.trim().length === 0) {
        errors.push({
            field: "round_contract",
            reason: "empty_item_description",
            detail: `item ${index} needs a non-empty description`,
        });
    }
    const verifyWith = entry.verify_with;
    if (!Array.isArray(verifyWith) || verifyWith.length === 0) {
        errors.push({
            field: "round_contract",
            reason: "no_verify_with",
            detail: `item ${index} must bind at least one evidence command in verify_with`,
        });
    }
    else {
        if (verifyWith.length > CONTRACT_LIMITS.verifyWith) {
            errors.push({
                field: "round_contract",
                reason: "too_many_verify_with",
                detail: `item ${index} verify_with may name at most ${CONTRACT_LIMITS.verifyWith} commands ` +
                    `(got ${verifyWith.length})`,
            });
        }
        for (const name of verifyWith) {
            if (typeof name !== "string" || !context.isConfiguredCommand(name)) {
                errors.push({
                    field: "round_contract",
                    reason: "unknown_command",
                    detail: `item ${index} verify_with names "${String(name)}", which is not a ` +
                        "configured, enabled, after-capable evidence command",
                });
            }
        }
    }
    const criterionRefs = entry.criterion_refs;
    if (criterionRefs !== undefined) {
        if (!Array.isArray(criterionRefs)) {
            errors.push({
                field: "round_contract",
                reason: "invalid_criterion_refs",
                detail: `item ${index} criterion_refs must be an array of strings`,
            });
        }
        else {
            if (criterionRefs.length > CONTRACT_LIMITS.criterionRefs) {
                errors.push({
                    field: "round_contract",
                    reason: "too_many_criterion_refs",
                    detail: `item ${index} criterion_refs may list at most ` +
                        `${CONTRACT_LIMITS.criterionRefs} ids (got ${criterionRefs.length})`,
                });
            }
            criterionRefs.forEach((ref, refIndex) => {
                if (typeof ref !== "string" || ref.trim().length === 0) {
                    errors.push({
                        field: "round_contract",
                        reason: "invalid_criterion_ref",
                        detail: `item ${index} criterion_refs entry ${refIndex} must be a non-empty string`,
                    });
                }
            });
        }
    }
    const subgoalRefs = entry.subgoal_refs;
    if (subgoalRefs !== undefined) {
        if (!Array.isArray(subgoalRefs)) {
            errors.push({
                field: "round_contract",
                reason: "invalid_subgoal_refs",
                detail: `item ${index} subgoal_refs must be an array of sg-XXXXXXXX ids`,
            });
        }
        else {
            if (subgoalRefs.length > CONTRACT_LIMITS.subgoalRefs) {
                errors.push({
                    field: "round_contract",
                    reason: "too_many_subgoal_refs",
                    detail: `item ${index} subgoal_refs may list at most ` +
                        `${CONTRACT_LIMITS.subgoalRefs} ids (got ${subgoalRefs.length})`,
                });
            }
            const seen = new Set();
            for (const ref of subgoalRefs) {
                if (typeof ref !== "string" || !SUBGOAL_ID_RE.test(ref.trim())) {
                    errors.push({
                        field: "round_contract",
                        reason: "invalid_subgoal_ref",
                        detail: `item ${index} subgoal_refs entry "${String(ref)}" must be an sg-XXXXXXXX id`,
                    });
                    continue;
                }
                const id = ref.trim();
                if (seen.has(id)) {
                    errors.push({
                        field: "round_contract",
                        reason: "duplicate_subgoal_ref",
                        detail: `item ${index} subgoal_refs repeats ${id}`,
                    });
                }
                seen.add(id);
                if (context.knownSubGoalIds && !context.knownSubGoalIds.has(id)) {
                    errors.push({
                        field: "round_contract",
                        reason: "unknown_subgoal_ref",
                        detail: `item ${index} references ${id}, which is not a sub-goal of this loop`,
                    });
                }
            }
        }
    }
}
/** v3.8: Strict STRUCTURAL boundary for the Round Contract declaration and
 *  the contract item claims — the same pre-advance contract as
 *  subgoal_updates: an error here is a payload defect, never a work-quality
 *  rejection (no session state, no gates, no rejection counters, retry with
 *  the same roundId as `contract_invalid`).
 *
 *  Declaration strictness: items must exist and stay within CONTRACT_LIMITS;
 *  every item must bind at least one configured, enabled, after-capable
 *  command; scope entries must stay inside the workspace; criterion and
 *  sub-goal references must be well-formed, and sub-goal references must name
 *  a sub-goal that actually exists. The limits are enforced HERE rather than
 *  by silently truncating in the lenient parser — a declaration is a
 *  boundary, not a suggestion.
 *
 *  Claim strictness: item ids must be well formed, unique, and — when the
 *  active contract is known — reference an item of the ACTIVE contract. */
export function validateContractShape(raw, context) {
    const errors = [];
    const contract = raw.round_contract;
    if (contract !== undefined) {
        if (typeof contract !== "object" || contract === null || Array.isArray(contract)) {
            errors.push({
                field: "round_contract",
                reason: "not_object",
                detail: "round_contract must be an object with an items array",
            });
        }
        else {
            const obj = contract;
            validateContractScope(obj.scope, context.checkScopeEntry, errors);
            const items = obj.items;
            if (!Array.isArray(items) || items.length === 0) {
                errors.push({
                    field: "round_contract",
                    reason: "no_items",
                    detail: "a contract must declare at least one item (description + verify_with)",
                });
            }
            else if (items.length > CONTRACT_LIMITS.items) {
                errors.push({
                    field: "round_contract",
                    reason: "too_many_items",
                    detail: `a contract may declare at most ${CONTRACT_LIMITS.items} items (got ${items.length})`,
                });
            }
            else {
                items.forEach((item, index) => {
                    validateContractItem(item, index, context, errors);
                });
            }
        }
    }
    const report = raw.execution_report;
    if (typeof report === "object" && report !== null && !Array.isArray(report)) {
        const claims = report.contract_item_claims;
        if (claims !== undefined) {
            if (!Array.isArray(claims)) {
                errors.push({
                    field: "execution_report.contract_item_claims",
                    reason: "not_array",
                    detail: "contract_item_claims must be an array of { item_id, outcome } entries",
                });
            }
            else {
                const seen = new Set();
                claims.forEach((claim, index) => {
                    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
                        errors.push({
                            field: "execution_report.contract_item_claims",
                            reason: "invalid_entry",
                            detail: `entry ${index} is not an object`,
                        });
                        return;
                    }
                    const entry = claim;
                    const id = typeof entry.item_id === "string" ? entry.item_id.trim() : "";
                    if (!/^rci-[a-f0-9]{8}$/.test(id)) {
                        errors.push({
                            field: "execution_report.contract_item_claims",
                            reason: "invalid_item_id",
                            detail: `entry ${index} must reference an rci-XXXXXXXX contract item id`,
                        });
                    }
                    else {
                        if (seen.has(id)) {
                            errors.push({
                                field: "execution_report.contract_item_claims",
                                reason: "duplicate_item_id",
                                detail: `entry ${index} repeats item id ${id}`,
                            });
                        }
                        seen.add(id);
                        if (context.activeItemIds && !context.activeItemIds.has(id)) {
                            errors.push({
                                field: "execution_report.contract_item_claims",
                                reason: "unknown_item_id",
                                detail: `entry ${index} references ${id}, which is not an item of the ACTIVE contract`,
                            });
                        }
                    }
                    if (entry.outcome !== "met" && entry.outcome !== "remaining") {
                        errors.push({
                            field: "execution_report.contract_item_claims",
                            reason: "invalid_outcome",
                            detail: `entry ${index} outcome must be "met" or "remaining"`,
                        });
                    }
                });
            }
        }
    }
    return errors;
}
/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults. When a
 *  diagnostic sink is supplied, every drop/truncation/normalization is
 *  reported; without one (the engine's historical payload parse) the values
 *  are normalized as before. */
export function buildSelfEvaluation(raw, sink) {
    const executionReport = parseExecutionReport(raw.execution_report, sink);
    const retractedConstraints = boundedStringArray(raw.retracted_constraints, 50, 500, sink, "retracted_constraints");
    const revisedCriteria = parseCriterionRevisions(raw.revised_success_criteria, sink);
    const wrongAssumptions = boundedStringArray(raw.wrong_assumptions, 50, 500, sink, "wrong_assumptions");
    const workerResults = parseWorkerResults(raw.worker_results, sink);
    if (raw.success !== undefined && typeof raw.success !== "boolean") {
        sink?.push("success", "invalid_value", "dropped", "expected a boolean; normalized to false (core validation rejects it)");
    }
    if (raw.output_summary !== undefined && typeof raw.output_summary !== "string") {
        sink?.push("output_summary", "invalid_value", "dropped", "expected a string; normalized to the empty string (core validation rejects it)");
    }
    let constraintViolations = [];
    if (raw.constraint_violations !== undefined) {
        if (!Array.isArray(raw.constraint_violations)) {
            sink?.push("constraint_violations", "not_array", "dropped", "expected an array of strings; normalized to [] (core validation rejects it)");
        }
        else {
            constraintViolations = raw.constraint_violations
                .filter((v) => typeof v === "string");
            const invalid = raw.constraint_violations.length - constraintViolations.length;
            if (invalid > 0) {
                sink?.push("constraint_violations", constraintViolations.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped", constraintViolations.length === 0
                    ? `all ${invalid} entries were non-strings; the value was dropped`
                    : `${invalid} non-string entr${invalid === 1 ? "y" : "ies"} dropped`);
            }
        }
    }
    if (raw.should_continue !== undefined && typeof raw.should_continue !== "boolean") {
        sink?.push("should_continue", "invalid_value", "dropped", "expected a boolean; normalized to true (core validation rejects it)");
    }
    if (raw.stop_reason !== undefined &&
        raw.stop_reason !== "gave_up" && raw.stop_reason !== "blocked" &&
        raw.stop_reason !== "needs_human_input") {
        sink?.push("stop_reason", "invalid_enum", "dropped", "expected gave_up | blocked | needs_human_input; the value was dropped");
    }
    if (raw.outcome !== undefined &&
        raw.outcome !== "success" && raw.outcome !== "partial" &&
        raw.outcome !== "failed" && raw.outcome !== "blocked") {
        sink?.push("outcome", "invalid_enum", "dropped", "expected success | partial | failed | blocked; the value was dropped");
    }
    if (raw.compression_checkpoint !== undefined &&
        typeof raw.compression_checkpoint !== "boolean") {
        sink?.push("compression_checkpoint", "invalid_value", "dropped", "expected a boolean; normalized to false");
    }
    if (raw.blocker !== undefined) {
        if (typeof raw.blocker !== "string") {
            sink?.push("blocker", "invalid_value", "dropped", "expected a string; the value was dropped");
        }
        else if (raw.blocker.trim().length === 0) {
            sink?.push("blocker", DIAG_EMPTY_VALUE, "dropped", "empty blocker was dropped");
        }
        else if (raw.blocker.length > 500) {
            sink?.push("blocker", "truncated", "truncated", "longer than 500 chars; truncated to the limit");
        }
    }
    const noChangeReason = boundedString(raw.no_change_reason, 200, sink, "no_change_reason");
    if (raw.no_change_reason === "") {
        sink?.push("no_change_reason", DIAG_EMPTY_VALUE, "dropped", "empty reason was dropped");
    }
    return makeSelfEvaluation({
        success: typeof raw.success === "boolean" ? raw.success : false,
        output_summary: typeof raw.output_summary === "string" ? raw.output_summary : "",
        constraint_violations: constraintViolations,
        should_continue: typeof raw.should_continue === "boolean" ? raw.should_continue : true,
        discovered_constraints: boundedStringArray(raw.discovered_constraints, 50, 500, sink, "discovered_constraints"),
        objective_refinement: boundedString(raw.objective_refinement, 1000, sink, "objective_refinement") ?? "",
        emerged_subtasks: boundedEmergedSubtasks(raw.emerged_subtasks, sink),
        execution_report: executionReport,
        retracted_constraints: retractedConstraints,
        revised_success_criteria: revisedCriteria,
        wrong_assumptions: wrongAssumptions,
        worker_results: workerResults,
        compression_checkpoint: typeof raw.compression_checkpoint === "boolean" ? raw.compression_checkpoint : false,
        checkpoint_label: boundedString(raw.checkpoint_label, 200, sink, "checkpoint_label") ?? "",
        subgoal_updates: parseSubGoalUpdates(raw.subgoal_updates, sink),
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
        gate_ids: boundedStringArray(raw.gate_ids, 20, 64, sink, "gate_ids"),
        retroactiveClaims: parseRetroactiveClaims(raw.retroactiveClaims, sink),
        no_change_reason: noChangeReason || undefined,
        prompt_requests: parsePromptRequests(raw.prompt_requests, sink),
        round_contract: parseRoundContract(raw.round_contract, sink),
    });
}
/** Normalize a raw submission and report every lossy decision. Unknown and
 *  retired fields are diagnosed and dropped; they are never silently accepted. */
export function normalizeSelfEvaluation(raw) {
    const collector = new DiagnosticsCollector();
    for (const key of unknownTopLevelFields(raw)) {
        collector.push(key, "unknown_field", "dropped", retiredFieldDetail(key) ?? "not a declared evaluation field; it was dropped");
    }
    const evaluation = buildSelfEvaluation(raw, collector);
    return {
        evaluation,
        diagnostics: collector.finish(),
        submittedFields: submittedFieldPaths(raw),
    };
}
/** v3.8: The ONE set of contract-declaration limits. `validateContractShape`
 *  (the strict boundary) rejects a declaration over these; `parseRoundContract`
 *  (the lenient path, reached only after the strict boundary passed) truncates
 *  to the same numbers. One source, so the two can never drift. */
export const CONTRACT_LIMITS = {
    items: 20,
    scope: 50,
    criterionRefs: 20,
    subgoalRefs: 20,
    verifyWith: 20,
};
/** Parse a Round Contract PROPOSAL from raw JSON input. Lenient on shapes
 *  the strict declaration boundary already rejected: strings are trimmed and
 *  capped, non-string array entries are dropped. Item ORDER and COUNT are
 *  preserved — the derived rci- ids depend on them. Returns undefined only
 *  when the raw value is absent or not an object. */
export function parseRoundContract(raw, sink) {
    if (raw === undefined)
        return undefined;
    if (raw === null) {
        sink?.push("round_contract", "invalid_value", "dropped", "expected a contract object; null was dropped");
        return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        sink?.push("round_contract", "invalid_entry", "dropped", "expected a contract object; the value was dropped");
        return undefined;
    }
    const obj = raw;
    for (const key of Object.keys(obj)) {
        if (!["work_item", "scope", "items"].includes(key)) {
            sink?.push(`round_contract.${key}`, "unknown_field", "dropped", "not a declared contract field; it was dropped");
        }
    }
    const capStrings = (value, max, cap, path) => {
        if (value === undefined)
            return [];
        if (!Array.isArray(value)) {
            sink?.push(path, "invalid_entry", "dropped", "expected an array of strings; the value was dropped");
            return [];
        }
        const strings = value.filter((v) => typeof v === "string");
        const invalid = value.length - strings.length;
        if (invalid > 0) {
            sink?.push(`${path}[]`, strings.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped", strings.length === 0
                ? `all ${invalid} entries were invalid; the value was dropped`
                : `${invalid} non-string entr${invalid === 1 ? "y" : "ies"} dropped`);
        }
        const trimmed = strings.map((v) => v.trim()).filter(Boolean);
        const empty = strings.length - trimmed.length;
        if (empty > 0) {
            sink?.push(`${path}[]`, DIAG_EMPTY_VALUE, "dropped", `${empty} empty entr${empty === 1 ? "y was" : "ies were"} dropped`);
        }
        const bounded = trimmed.map((v) => v.slice(0, max));
        if (bounded.some((v, index) => v !== trimmed[index])) {
            sink?.push(`${path}[]`, "truncated", "truncated", `a contract string was longer than ${max} chars`);
        }
        if (bounded.length > cap) {
            sink?.push(path, "too_many", "truncated", `only the first ${cap} entries are kept`);
        }
        return bounded.slice(0, cap);
    };
    const rawItems = obj.items;
    if (rawItems === undefined) {
        sink?.push("round_contract", "invalid_value", "dropped", "expected an items array; the proposal was dropped");
        return undefined;
    }
    if (!Array.isArray(rawItems)) {
        sink?.push("round_contract", "invalid_value", "dropped", "items must be an array; the proposal was dropped");
        return undefined;
    }
    const objectItems = rawItems.filter((item) => typeof item === "object" && item !== null && !Array.isArray(item));
    const nonObject = rawItems.length - objectItems.length;
    if (nonObject > 0) {
        sink?.push("round_contract.items", "invalid_entry", "dropped", `${nonObject} non-object item${nonObject === 1 ? "" : "s"} dropped`);
    }
    const items = objectItems
        .slice(0, CONTRACT_LIMITS.items)
        .map((item, index) => {
        for (const key of Object.keys(item)) {
            if (!["description", "criterion_refs", "subgoal_refs", "verify_with"].includes(key)) {
                sink?.push(`round_contract.items[${index}].${key}`, "unknown_field", "dropped", "not a declared contract-item field; it was dropped");
            }
        }
        if (item.description !== undefined && typeof item.description !== "string") {
            sink?.push(`round_contract.items[${index}].description`, "invalid_value", "dropped", "expected a string; the description was dropped");
        }
        if (typeof item.description === "string" &&
            item.description.trim().length > 200) {
            sink?.push(`round_contract.items[${index}].description`, "truncated", "truncated", "longer than 200 chars; truncated to the limit");
        }
        return {
            description: typeof item.description === "string"
                ? item.description.trim().slice(0, 200)
                : "",
            criterion_refs: capStrings(item.criterion_refs, 200, CONTRACT_LIMITS.criterionRefs, `round_contract.items[${index}].criterion_refs`),
            subgoal_refs: capStrings(item.subgoal_refs, 64, CONTRACT_LIMITS.subgoalRefs, `round_contract.items[${index}].subgoal_refs`),
            verify_with: capStrings(item.verify_with, 200, CONTRACT_LIMITS.verifyWith, `round_contract.items[${index}].verify_with`),
        };
    });
    if (rawItems.length > CONTRACT_LIMITS.items) {
        sink?.push("round_contract.items", "too_many", "truncated", `only the first ${CONTRACT_LIMITS.items} items are kept`);
    }
    if (items.length === 0) {
        sink?.push("round_contract", DIAG_ALL_ENTRIES_DROPPED, "dropped", "no valid items; the proposal was dropped");
        return undefined;
    }
    if (obj.work_item !== undefined && typeof obj.work_item !== "string") {
        sink?.push("round_contract.work_item", "invalid_value", "dropped", "expected a string; the work_item was dropped");
    }
    else if (typeof obj.work_item === "string" && obj.work_item.trim().length === 0) {
        sink?.push("round_contract.work_item", DIAG_EMPTY_VALUE, "dropped", "empty work_item was dropped");
    }
    else if (typeof obj.work_item === "string" && obj.work_item.trim().length > 200) {
        sink?.push("round_contract.work_item", "truncated", "truncated", "longer than 200 chars; truncated to the limit");
    }
    return {
        work_item: typeof obj.work_item === "string" && obj.work_item.trim().length > 0
            ? obj.work_item.trim().slice(0, 200)
            : undefined,
        scope: capStrings(obj.scope, 500, CONTRACT_LIMITS.scope, "round_contract.scope"),
        items,
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
export function parsePromptRequests(raw, sink) {
    if (raw === undefined)
        return undefined;
    if (raw === null) {
        sink?.push("prompt_requests", "invalid_value", "dropped", "expected an object with emphasize/confusion_points; null was dropped");
        return undefined;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        sink?.push("prompt_requests", "invalid_entry", "dropped", "expected an object with emphasize/confusion_points; the value was dropped");
        return undefined;
    }
    const obj = raw;
    for (const key of Object.keys(obj)) {
        if (key !== "emphasize" && key !== "confusion_points") {
            sink?.push(`prompt_requests.${key}`, "unknown_field", "dropped", "not a declared prompt-request field; it was dropped");
        }
    }
    const emphasize = boundedStringArray(obj.emphasize, 5, 500, sink, "prompt_requests.emphasize");
    const confusionPoints = boundedStringArray(obj.confusion_points, 3, 200, sink, "prompt_requests.confusion_points");
    // Return undefined when all fields are empty — semantically equivalent
    // to "not set", avoids carrying an empty object through the pipeline.
    if (emphasize.length === 0 && confusionPoints.length === 0) {
        sink?.push("prompt_requests", DIAG_EMPTY_VALUE, "dropped", "emphasize and confusion_points are both empty; treated as not set");
        return undefined;
    }
    return { emphasize, confusion_points: confusionPoints };
}
// Free-text inference is intentionally absent. Invalid core fields are
// rejected before round advancement and may be resubmitted with the same
// roundId without changing session, gate, metric, or vault state.
//# sourceMappingURL=self-eval.js.map