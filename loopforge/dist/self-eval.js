/** Structured self-evaluation parsing and normalization — pure functions.
 * The MCP boundary validates required fields before these helpers run.
 */
import { makeExecutionReport, makeSelfEvaluation, } from "./protocol.js";
import { retiredFieldDetail, submittedFieldPaths, unknownExecutionReportEntryFields, unknownTopLevelFields, } from "./submission-guidance.js";
import { DIAG_ALL_ENTRIES_DROPPED, DIAG_EMPTY_VALUE, } from "./submission-diagnostics.js";
import { canonicalContractItemText, criterionRefMatches, isCriterionId, } from "./token-utils.js";
import { isOpenQuestionId } from "./open-question.js";
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
export function parseExecutionReport(raw, sink, knownCriterionRefs) {
    if (raw === undefined || raw === null)
        return undefined;
    if (typeof raw !== "object" || Array.isArray(raw)) {
        sink?.push("execution_report", "invalid_entry", "dropped", "expected an object; the value was dropped");
        return undefined;
    }
    for (const key of unknownExecutionReportEntryFields(raw)) {
        const path = `execution_report.${key}`;
        sink?.push(path, "unknown_field", "dropped", retiredFieldDetail(path) ?? "not a declared execution_report field; it was dropped");
    }
    return makeExecutionReport({
        files_changed: boundedStringArray(raw.files_changed, 200, 500, sink, "execution_report.files_changed"),
        claims: parseExecutionClaims(raw.claims, sink, knownCriterionRefs),
    });
}
const CLAIM_ID_RE = /^(cr|rci)-[a-f0-9]{8}$/;
function isCriterionClaimId(id) {
    return id.startsWith("cr-");
}
/** v4.0.6: the claimed `cr-` criterion ids with the given outcome. */
function claimedCriteria(report, outcome) {
    return (report?.claims ?? [])
        .filter((claim) => claim.outcome === outcome && isCriterionClaimId(claim.id))
        .map((claim) => claim.id);
}
/** v4.0.6: The criterion ids the agent claims met this round. */
export function claimedMetCriteria(report) {
    return claimedCriteria(report, "met");
}
/** v4.0.6: The criterion ids the agent declares still outstanding. */
export function claimedRemainingCriteria(report) {
    return claimedCriteria(report, "remaining");
}
/** v4.0.6: LENIENT parse of the ONE claims channel.
 *
 *  `cr-` claims are advisory: unknown/malformed entries are dropped with a
 *  diagnostic, never a rejection. `rci-` claims are STRICT at the submission
 *  boundary (`validateContractShape` checks format, uniqueness and the ACTIVE
 *  item set); this parser only normalizes what reaches the read model and
 *  drops structurally malformed entries on library paths. */
function parseExecutionClaims(raw, sink, knownCriterionRefs) {
    if (raw === undefined || raw === null)
        return [];
    if (!Array.isArray(raw)) {
        sink?.push("execution_report.claims", "not_array", "dropped", "expected an array of { id, outcome } claims; the value was dropped");
        return [];
    }
    const claims = [];
    let invalid = 0;
    let unknown = 0;
    for (let index = 0; index < raw.length; index++) {
        if (claims.length >= 100)
            break;
        const item = raw[index];
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            invalid++;
            continue;
        }
        const entry = item;
        if (typeof entry.id !== "string" ||
            (entry.outcome !== "met" && entry.outcome !== "remaining")) {
            invalid++;
            continue;
        }
        const trimmed = entry.id.trim();
        if (trimmed !== entry.id) {
            sink?.push(`execution_report.claims[${index}].id`, "normalized", "normalized", "leading/trailing whitespace was trimmed");
        }
        if (trimmed.length > 64) {
            sink?.push(`execution_report.claims[${index}].id`, "truncated", "truncated", "longer than 64 chars; truncated to the limit");
        }
        const id = trimmed.slice(0, 64);
        if (!CLAIM_ID_RE.test(id)) {
            invalid++;
            continue;
        }
        if (isCriterionClaimId(id) && knownCriterionRefs !== undefined &&
            knownCriterionRefs !== null &&
            !knownCriterionRefs.some((criterion) => criterionRefMatches(id, criterion))) {
            unknown++;
            continue;
        }
        claims.push({ id, outcome: entry.outcome });
    }
    if (invalid > 0 || unknown > 0) {
        if (claims.length === 0) {
            const parts = [];
            if (invalid > 0)
                parts.push(`${invalid} malformed`);
            if (unknown > 0)
                parts.push(`${unknown} unknown criterion`);
            sink?.push("execution_report.claims", DIAG_ALL_ENTRIES_DROPPED, "dropped", `all ${invalid + unknown} claims were dropped (${parts.join(", ")}; ` +
                "malformed/unreferenced claims never reject a round)");
        }
        else {
            if (invalid > 0) {
                sink?.push("execution_report.claims", "invalid_entry", "dropped", `${invalid} malformed claim${invalid === 1 ? "" : "s"} dropped`);
            }
            if (unknown > 0) {
                sink?.push("execution_report.claims", "unknown_id", "dropped", `${unknown} cr- claim${unknown === 1 ? "" : "s"} cited a criterion the ` +
                    "prompt did not render; dropped (advisory)");
            }
        }
    }
    if (raw.length > 100) {
        sink?.push("execution_report.claims", "too_many", "truncated", "only the first 100 claims are kept");
    }
    return claims;
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
            if (!["agentId", "subTask", "resultSummary", "outcome"].includes(key)) {
                sink?.push(`worker_results[${index}].${key}`, "unknown_field", "dropped", "not a declared worker-result field; it was dropped");
            }
        }
        for (const [key, cap] of [
            ["agentId", 200], ["subTask", 500], ["resultSummary", 1000],
        ]) {
            const value = w[key];
            if (typeof value === "string" && value.length > cap) {
                sink?.push(`worker_results[${index}].${key}`, "truncated", "truncated", `longer than ${cap} chars; truncated to the limit`);
            }
        }
        return {
            agentId: (w.agentId.slice(0, 200)),
            subTask: (w.subTask.slice(0, 500)),
            resultSummary: (w.resultSummary.slice(0, 1000)),
            outcome: w.outcome,
        };
    });
}
// v3.9.7: the outcome predicates live in round-outcome.ts so contract
// closure, the walker, the verification gate and the coordinator share one
// definition. Re-exported for the existing public surface.
export { effectiveOutcome, effectiveSuccess, declaresBlocked, } from "./round-outcome.js";
export const OBJECTIVE_REFINEMENT_MAX = 1000;
export const BLOCKER_MAX = 500;
export function validateCoreSelfEvaluation(raw) {
    const missing = [];
    const invalid = [];
    const required = ["outcome", "output_summary", "constraint_violations", "should_continue"];
    for (const field of required) {
        if (!(field in raw))
            missing.push(field);
    }
    const outcome = raw.outcome;
    if ("outcome" in raw &&
        (outcome !== "success" && outcome !== "partial" &&
            outcome !== "failed" && outcome !== "blocked")) {
        invalid.push({
            field: "outcome",
            expected: "success | partial | failed | blocked",
        });
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
    // v4.0.6: strict outcome/blocker combinations. A non-blocked blocker is NOT
    // rejected — it is dropped with a diagnostic by the parser.
    if (outcome === "success" && raw.should_continue === true) {
        invalid.push({
            field: "outcome",
            expected: "outcome=success requires should_continue=false",
        });
    }
    if (outcome === "blocked") {
        if (raw.should_continue === true) {
            invalid.push({
                field: "outcome",
                expected: "outcome=blocked requires should_continue=false",
            });
        }
        if (typeof raw.blocker !== "string" || raw.blocker.trim().length === 0) {
            invalid.push({
                field: "blocker",
                expected: "a non-empty blocker string is required when outcome=blocked",
            });
        }
        else if (raw.blocker.length > BLOCKER_MAX) {
            invalid.push({
                field: "blocker",
                expected: `a string of at most ${BLOCKER_MAX} chars when outcome=blocked`,
            });
        }
    }
    if (raw.objective_refinement !== undefined) {
        const refinement = raw.objective_refinement;
        if (typeof refinement !== "string" || refinement.trim().length === 0) {
            invalid.push({
                field: "objective_refinement",
                expected: "a non-empty string",
            });
        }
        else if (refinement.length > OBJECTIVE_REFINEMENT_MAX) {
            invalid.push({
                field: "objective_refinement",
                expected: `a string of at most ${OBJECTIVE_REFINEMENT_MAX} chars`,
            });
        }
    }
    return { missing, invalid };
}
/** v3.7.1: Strict structural checks for the sub-goal protocol fields
 *  (subgoal_updates / emerged_subtasks). Runs in the same pre-advance
 *  evaluation_invalid boundary as the four core fields: an error here is a
 *  payload defect, never a work-quality rejection — no session state, no
 *  gates, no rejection counters, retry with the same submissionHandle.
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
const CONTRACT_ID_RE = /^rc-[a-f0-9]{8}$/;
export const CONTRACT_SUPERSEDE_REASON_MAX = 500;
function declaresBlockedRaw(raw) {
    return raw.outcome === "blocked";
}
/** v4.0.6: LENIENT parser for the `supersedes` modifier inside a committed
 *  Round Contract proposal. Historical/externally written data produces a
 *  diagnostic and is dropped; it never closes a contract and never throws.
 *  The strict submission boundary is the only commit check. */
export function parseContractSupersede(raw, sink, path = "round_contract.supersedes") {
    if (raw === undefined)
        return undefined;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        sink?.push(path, "invalid_entry", "dropped", "expected a { contract_id, reason? } object; the value was dropped");
        return undefined;
    }
    const obj = raw;
    for (const key of Object.keys(obj)) {
        if (key !== "contract_id" && key !== "reason") {
            sink?.push(`${path}.${key}`, "unknown_field", "dropped", "not a declared supersedes field; it was dropped");
        }
    }
    if (typeof obj.contract_id !== "string" ||
        !CONTRACT_ID_RE.test(obj.contract_id.trim())) {
        sink?.push(path, "invalid_id", "dropped", "contract_id must be an rc-XXXXXXXX id; the redirect was dropped");
        return undefined;
    }
    const contractId = obj.contract_id.trim();
    let reason;
    if (obj.reason !== undefined) {
        if (typeof obj.reason !== "string") {
            sink?.push(`${path}.reason`, "invalid_value", "dropped", "expected a string; the reason was dropped");
        }
        else if (obj.reason.length > CONTRACT_SUPERSEDE_REASON_MAX) {
            sink?.push(`${path}.reason`, "truncated", "truncated", `longer than ${CONTRACT_SUPERSEDE_REASON_MAX} chars; truncated to the limit`);
            reason = obj.reason.slice(0, CONTRACT_SUPERSEDE_REASON_MAX);
        }
        else {
            reason = obj.reason;
        }
    }
    return {
        contract_id: contractId,
        ...(reason !== undefined ? { reason } : {}),
    };
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
    for (const key of Object.keys(entry)) {
        if (!["description", "criterion_refs", "verify_with"].includes(key)) {
            errors.push({
                field: "round_contract",
                reason: "unknown_field",
                detail: `item ${index} has unknown field "${key}"`,
            });
        }
    }
    if (typeof entry.description !== "string" || entry.description.trim().length === 0) {
        errors.push({
            field: "round_contract",
            reason: "empty_item_description",
            detail: `item ${index} needs a non-empty description`,
        });
    }
    else if (entry.description.trim().length > CONTRACT_LIMITS.itemDescription) {
        errors.push({
            field: "round_contract",
            reason: "item_description_too_long",
            detail: `item ${index} description may be at most ` +
                `${CONTRACT_LIMITS.itemDescription} chars`,
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
            const seen = new Set();
            criterionRefs.forEach((ref, refIndex) => {
                if (typeof ref !== "string" || !isCriterionId(ref.trim())) {
                    errors.push({
                        field: "round_contract",
                        reason: "invalid_criterion_ref",
                        detail: `item ${index} criterion_refs entry ${refIndex} must be a cr-XXXXXXXX id`,
                    });
                    return;
                }
                const id = ref.trim();
                if (seen.has(id)) {
                    errors.push({
                        field: "round_contract",
                        reason: "duplicate_criterion_ref",
                        detail: `item ${index} criterion_refs repeats ${id}`,
                    });
                }
                seen.add(id);
                if (context.knownCriterionIds && !context.knownCriterionIds.has(id)) {
                    errors.push({
                        field: "round_contract",
                        reason: "unknown_criterion_ref",
                        detail: `item ${index} references ${id}, which is not an active criterion of this loop`,
                    });
                }
            });
        }
    }
}
/** v3.9.4: the normalized content identity of a RAW proposal item. Malformed
 *  items return null (their own shape errors already fire); valid items use
 *  the same canonical text as `deriveContractItemIds`. */
function rawContractItemIdentity(item) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
        return null;
    const entry = item;
    const strings = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    return canonicalContractItemText({
        description: typeof entry.description === "string" ? entry.description : "",
        criterion_refs: strings(entry.criterion_refs),
        verify_with: strings(entry.verify_with),
    });
}
/** v4.0.6: strict `round_contract.supersedes` boundary. Every failure is
 *  `contract_invalid`; the same submissionHandle may retry with a corrected
 *  payload. The rules migrated from the former standalone
 *  `contract_transition` field:
 *  - the target must exist and equal the ACTIVE contract id;
 *  - the successor (this same proposal) must carry different acceptance items;
 *  - a redirect cannot be combined with a blocked outcome or a stop.
 *  `scope`/`work_item` differences alone are not a new slice. */
function validateContractSupersede(raw, proposal, context, errors) {
    const value = proposal.supersedes;
    if (value === undefined)
        return;
    const field = "round_contract.supersedes";
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        errors.push({
            field,
            reason: "not_object",
            detail: "round_contract.supersedes must be a { contract_id, reason? } object",
        });
        return;
    }
    const obj = value;
    for (const key of Object.keys(obj)) {
        if (key !== "contract_id" && key !== "reason") {
            errors.push({
                field,
                reason: "unknown_field",
                detail: `round_contract.supersedes has unknown field "${key}"`,
            });
        }
    }
    const contractId = typeof obj.contract_id === "string"
        ? obj.contract_id.trim()
        : "";
    if (!CONTRACT_ID_RE.test(contractId)) {
        errors.push({
            field,
            reason: "invalid_contract_id",
            detail: "round_contract.supersedes.contract_id must be an rc-XXXXXXXX id",
        });
    }
    if (obj.reason !== undefined &&
        (typeof obj.reason !== "string" ||
            obj.reason.length > CONTRACT_SUPERSEDE_REASON_MAX)) {
        errors.push({
            field,
            reason: "invalid_reason",
            detail: `round_contract.supersedes.reason must be a string of at most ` +
                `${CONTRACT_SUPERSEDE_REASON_MAX} chars`,
        });
    }
    if (declaresBlockedRaw(raw)) {
        errors.push({
            field,
            reason: "supersede_conflicts_with_blocked",
            detail: "a contract redirect cannot be combined with a blocked outcome",
        });
    }
    if (raw.should_continue === false) {
        errors.push({
            field,
            reason: "supersede_on_stop",
            detail: "a contract redirect activates a successor next round; it cannot be submitted with should_continue=false",
        });
    }
    if (context.observed === false)
        return;
    if (context.activeContractId === undefined)
        return;
    if (context.activeContractId === null) {
        errors.push({
            field,
            reason: "no_active_contract",
            detail: "there is no active contract to supersede",
        });
        return;
    }
    if (contractId !== context.activeContractId) {
        errors.push({
            field,
            reason: "supersede_target_mismatch",
            detail: `round_contract.supersedes.contract_id must equal the active contract ` +
                `(${context.activeContractId})`,
        });
    }
    // "Substantive change" means the ACCEPTANCE CONTENT changed. A new
    // work_item/scope label alone is not a new slice.
    const activeIdentities = context.activeItemIdentities;
    const rawItems = proposal.items;
    if (activeIdentities && Array.isArray(rawItems)) {
        const identities = new Set();
        for (const item of rawItems) {
            const identity = rawContractItemIdentity(item);
            if (identity !== null)
                identities.add(identity);
        }
        if (identities.size > 0 &&
            identities.size === activeIdentities.size &&
            [...identities].every((identity) => activeIdentities.has(identity))) {
            errors.push({
                field,
                reason: "supersede_without_change",
                detail: "the successor's acceptance items are identical to the active " +
                    "contract's; changing only work_item/scope is not a new slice",
            });
        }
    }
}
/** v3.8: Strict STRUCTURAL boundary for the Round Contract declaration and
 *  the contract item claims — the same pre-advance contract as
 *  subgoal_updates: an error here is a payload defect, never a work-quality
 *  rejection (no session state, no gates, no rejection counters, retry with
 *  the same submissionHandle as `contract_invalid`).
 *
 *  Declaration strictness: items must exist and stay within CONTRACT_LIMITS;
 *  every item must bind at least one configured, enabled, after-capable
 *  command; criterion and sub-goal references must be well-formed, and
 *  sub-goal references must name a sub-goal that actually exists. `scope` is
 *  deliberately NOT part of this boundary (v3.9.9): it is optional,
 *  report-only intent and is normalized leniently. The limits are enforced HERE rather than
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
            for (const key of Object.keys(obj)) {
                if (!["work_item", "scope", "supersedes", "items"].includes(key)) {
                    errors.push({
                        field: "round_contract",
                        reason: "unknown_field",
                        detail: `round_contract has unknown field "${key}"`,
                    });
                }
            }
            if (obj.work_item === undefined) {
                errors.push({
                    field: "round_contract",
                    reason: "missing_work_item",
                    detail: "a contract must name the deliverable in work_item",
                });
            }
            else if (typeof obj.work_item !== "string") {
                errors.push({
                    field: "round_contract",
                    reason: "invalid_work_item",
                    detail: "work_item must be a string",
                });
            }
            else if (obj.work_item.trim().length === 0) {
                errors.push({
                    field: "round_contract",
                    reason: "empty_work_item",
                    detail: "work_item must not be empty",
                });
            }
            else if (obj.work_item.trim().length > CONTRACT_LIMITS.workItem) {
                errors.push({
                    field: "round_contract",
                    reason: "work_item_too_long",
                    detail: `work_item may be at most ${CONTRACT_LIMITS.workItem} chars`,
                });
            }
            // v3.9.9: `scope` is optional, report-only intent. It is normalized
            // leniently by parseRoundContract (trim, cap, drop non-strings) and no
            // longer participates in this strict boundary — no required key, no
            // workspace containment, no whole-contract rejection.
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
                const seenItems = new Map();
                items.forEach((item, index) => {
                    validateContractItem(item, index, context, errors);
                    // v3.9.4: two identical normalized items would derive two rci- ids
                    // for one semantic object. Reject the restatement instead of
                    // letting a citation become ambiguous.
                    const identity = rawContractItemIdentity(item);
                    if (identity === null)
                        return;
                    const first = seenItems.get(identity);
                    if (first !== undefined) {
                        errors.push({
                            field: "round_contract",
                            reason: "duplicate_contract_item",
                            detail: `item ${index} duplicates item ${first} by normalized content`,
                        });
                        return;
                    }
                    seenItems.set(identity, index);
                });
            }
            validateContractSupersede(raw, obj, context, errors);
        }
    }
    // v4.0.6: `execution_report.claims` is the ONE claims channel. Only `rci-`
    // entries are STRICT here (format, uniqueness, ACTIVE item membership);
    // `cr-` entries stay advisory and are normalized by the lenient parser.
    const report = raw.execution_report;
    if (typeof report === "object" && report !== null && !Array.isArray(report)) {
        const claims = report.claims;
        if (claims !== undefined) {
            if (!Array.isArray(claims)) {
                errors.push({
                    field: "execution_report.claims",
                    reason: "not_array",
                    detail: "execution_report.claims must be an array of { id, outcome } entries",
                });
            }
            else {
                const seen = new Set();
                claims.forEach((claim, index) => {
                    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
                        errors.push({
                            field: "execution_report.claims",
                            reason: "invalid_entry",
                            detail: `entry ${index} is not an object`,
                        });
                        return;
                    }
                    const entry = claim;
                    const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
                    const strictItem = rawId.startsWith("rci-");
                    if (strictItem) {
                        if (!/^rci-[a-f0-9]{8}$/.test(rawId)) {
                            errors.push({
                                field: "execution_report.claims",
                                reason: "invalid_item_id",
                                detail: `entry ${index} must reference an rci-XXXXXXXX contract item id`,
                            });
                        }
                        else {
                            if (seen.has(rawId)) {
                                errors.push({
                                    field: "execution_report.claims",
                                    reason: "duplicate_item_id",
                                    detail: `entry ${index} repeats item id ${rawId}`,
                                });
                            }
                            seen.add(rawId);
                            if (context.activeItemIds && !context.activeItemIds.has(rawId)) {
                                errors.push({
                                    field: "execution_report.claims",
                                    reason: "unknown_item_id",
                                    detail: `entry ${index} references ${rawId}, which is not an item of the ACTIVE contract`,
                                });
                            }
                        }
                    }
                    if (entry.outcome !== "met" && entry.outcome !== "remaining") {
                        errors.push({
                            field: "execution_report.claims",
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
export function buildSelfEvaluation(raw, sink, facts) {
    const executionReport = parseExecutionReport(raw.execution_report, sink, facts?.knownCriterionRefs);
    const retractedConstraints = boundedStringArray(raw.retracted_constraints, 50, 500, sink, "retracted_constraints");
    const wrongAssumptions = boundedStringArray(raw.wrong_assumptions, 50, 500, sink, "wrong_assumptions");
    // v4.0.2: strictly report-only. The window/caps are the field's contract,
    // not policy: at most 3 entries, 300 chars each.
    const openQuestions = boundedStringArray(raw.open_questions, 3, 300, sink, "open_questions");
    const resolvedOpenQuestionIds = boundedStringArray(raw.resolved_open_question_ids, 20, 80, sink, "resolved_open_question_ids")
        .filter((value) => {
        if (isOpenQuestionId(value))
            return true;
        sink?.push("resolved_open_question_ids", "invalid_value", "dropped", `invalid open-question id: ${value}`);
        return false;
    });
    const workerResults = parseWorkerResults(raw.worker_results, sink);
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
    if (raw.outcome !== undefined &&
        raw.outcome !== "success" && raw.outcome !== "partial" &&
        raw.outcome !== "failed" && raw.outcome !== "blocked") {
        sink?.push("outcome", "invalid_enum", "dropped", "expected success | partial | failed | blocked; the value was dropped (core validation rejects it)");
    }
    if (raw.objective_refinement !== undefined) {
        if (typeof raw.objective_refinement !== "string") {
            sink?.push("objective_refinement", "invalid_value", "dropped", "expected a string; the value was dropped (core validation rejects it)");
        }
        else if (raw.objective_refinement.trim().length === 0) {
            sink?.push("objective_refinement", DIAG_EMPTY_VALUE, "dropped", "empty objective_refinement was dropped (core validation rejects it)");
        }
        else if (raw.objective_refinement.length > OBJECTIVE_REFINEMENT_MAX) {
            sink?.push("objective_refinement", "truncated", "truncated", `longer than ${OBJECTIVE_REFINEMENT_MAX} chars; truncated to the limit (core validation rejects it)`);
        }
    }
    if (raw.subtask_boundary !== undefined &&
        typeof raw.subtask_boundary !== "boolean") {
        sink?.push("subtask_boundary", "invalid_value", "dropped", "expected a boolean; normalized to false");
    }
    if (raw.blocker !== undefined) {
        if (raw.outcome !== "blocked") {
            sink?.push("blocker", "not_applicable", "dropped", `blocker is meaningful only when outcome=blocked (outcome=${typeof raw.outcome === "string" ? raw.outcome : "missing"}); the value was dropped`);
        }
        else if (typeof raw.blocker !== "string") {
            sink?.push("blocker", "invalid_value", "dropped", "expected a string; the value was dropped (core validation rejects it)");
        }
        else if (raw.blocker.trim().length === 0) {
            sink?.push("blocker", DIAG_EMPTY_VALUE, "dropped", "empty blocker was dropped (core validation rejects it)");
        }
        else if (raw.blocker.length > BLOCKER_MAX) {
            sink?.push("blocker", "truncated", "truncated", `longer than ${BLOCKER_MAX} chars; truncated to the limit (core validation rejects it)`);
        }
    }
    const noChangeReason = boundedString(raw.no_change_reason, 200, sink, "no_change_reason");
    if (raw.no_change_reason === "") {
        sink?.push("no_change_reason", DIAG_EMPTY_VALUE, "dropped", "empty reason was dropped");
    }
    return makeSelfEvaluation({
        outcome: raw.outcome === "success" || raw.outcome === "partial" ||
            raw.outcome === "failed" || raw.outcome === "blocked"
            ? raw.outcome
            : "failed",
        output_summary: typeof raw.output_summary === "string" ? raw.output_summary : "",
        constraint_violations: constraintViolations,
        should_continue: typeof raw.should_continue === "boolean" ? raw.should_continue : true,
        discovered_constraints: boundedStringArray(raw.discovered_constraints, facts?.maxDiscoveredConstraints ?? 50, 500, sink, "discovered_constraints"),
        emerged_subtasks: boundedEmergedSubtasks(raw.emerged_subtasks, sink),
        execution_report: executionReport,
        retracted_constraints: retractedConstraints,
        wrong_assumptions: wrongAssumptions,
        open_questions: openQuestions,
        resolved_open_question_ids: resolvedOpenQuestionIds,
        worker_results: workerResults,
        subtask_boundary: typeof raw.subtask_boundary === "boolean" ? raw.subtask_boundary : false,
        subtask_boundary_label: boundedString(raw.subtask_boundary_label, 200, sink, "subtask_boundary_label") ?? "",
        subgoal_updates: parseSubGoalUpdates(raw.subgoal_updates, sink),
        objective_refinement: typeof raw.objective_refinement === "string" &&
            raw.objective_refinement.trim().length > 0
            ? raw.objective_refinement.trim().slice(0, OBJECTIVE_REFINEMENT_MAX)
            : undefined,
        blocker: raw.outcome === "blocked" &&
            typeof raw.blocker === "string" && raw.blocker.trim().length > 0
            ? raw.blocker.slice(0, BLOCKER_MAX)
            : undefined,
        gate_ids: boundedStringArray(raw.gate_ids, 20, 64, sink, "gate_ids"),
        retroactiveClaims: parseRetroactiveClaims(raw.retroactiveClaims, sink),
        no_change_reason: noChangeReason || undefined,
        round_contract: parseRoundContract(raw.round_contract, sink),
    });
}
/** Normalize a raw submission and report every lossy decision. Unknown and
 *  retired fields are diagnosed and dropped; they are never silently accepted. */
export function normalizeSelfEvaluation(raw, facts) {
    const collector = new DiagnosticsCollector();
    for (const key of unknownTopLevelFields(raw)) {
        collector.push(key, "unknown_field", "dropped", retiredFieldDetail(key) ?? "not a declared evaluation field; it was dropped");
    }
    const evaluation = buildSelfEvaluation(raw, collector, facts);
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
    workItem: 200,
    itemDescription: 200,
    items: 20,
    scope: 50,
    criterionRefs: 20,
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
        if (!["work_item", "scope", "supersedes", "items"].includes(key)) {
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
            if (!["description", "criterion_refs", "verify_with"].includes(key)) {
                sink?.push(`round_contract.items[${index}].${key}`, "unknown_field", "dropped", "not a declared contract-item field; it was dropped");
            }
        }
        if (item.description !== undefined && typeof item.description !== "string") {
            sink?.push(`round_contract.items[${index}].description`, "invalid_value", "dropped", "expected a string; the description was dropped");
        }
        if (typeof item.description === "string" &&
            item.description.trim().length > CONTRACT_LIMITS.itemDescription) {
            sink?.push(`round_contract.items[${index}].description`, "truncated", "truncated", `longer than ${CONTRACT_LIMITS.itemDescription} chars; truncated to the limit`);
        }
        return {
            description: typeof item.description === "string"
                ? item.description.trim().slice(0, CONTRACT_LIMITS.itemDescription)
                : "",
            criterion_refs: capStrings(item.criterion_refs, 200, CONTRACT_LIMITS.criterionRefs, `round_contract.items[${index}].criterion_refs`),
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
    else if (typeof obj.work_item === "string" &&
        obj.work_item.trim().length > CONTRACT_LIMITS.workItem) {
        sink?.push("round_contract.work_item", "truncated", "truncated", `longer than ${CONTRACT_LIMITS.workItem} chars; truncated to the limit`);
    }
    const supersedes = parseContractSupersede(obj.supersedes, sink);
    return {
        work_item: typeof obj.work_item === "string" && obj.work_item.trim().length > 0
            ? obj.work_item.trim().slice(0, CONTRACT_LIMITS.workItem)
            : undefined,
        scope: capStrings(obj.scope, 500, CONTRACT_LIMITS.scope, "round_contract.scope"),
        ...(supersedes !== undefined ? { supersedes } : {}),
        items,
    };
}
// Free-text inference is intentionally absent. Invalid core fields are
// rejected before round advancement and may be resubmitted with the same
// roundId without changing session, gate, metric, or vault state.
//# sourceMappingURL=self-eval.js.map