/** Structured self-evaluation parsing and normalization — pure functions.
 * The MCP boundary validates required fields before these helpers run.
 */
import { makeExecutionReport, makeSelfEvaluation, } from "./protocol.js";
// ── Raw parsing helpers ───────────────────────────────────────────────────
function boundedString(value, maxChars) {
    return typeof value === "string" ? value.slice(0, maxChars) : undefined;
}
function boundedStringArray(value, maxItems, maxChars) {
    return Array.isArray(value)
        ? value
            .filter((item) => typeof item === "string")
            .map((item) => item.slice(0, maxChars))
            .slice(0, maxItems)
        : [];
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
export function boundedEmergedSubtasks(value) {
    return boundedStringArray(value, EMERGED_LIMITS.items, EMERGED_LIMITS.chars);
}
function nonNegativeInteger(value) {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}
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
/** Parse ExecutionReport from a raw JSON object. */
export function parseExecutionReport(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const testResults = raw.tests_reported && typeof raw.tests_reported === "object" &&
        !Array.isArray(raw.tests_reported)
        ? raw.tests_reported
        : undefined;
    return makeExecutionReport({
        files_changed: boundedStringArray(raw.files_changed, 200, 500),
        tests_reported: testResults && typeof testResults.passed === "number" &&
            Number.isFinite(testResults.passed)
            ? {
                passed: nonNegativeInteger(testResults.passed),
                failed: nonNegativeInteger(testResults.failed),
                skipped: nonNegativeInteger(testResults.skipped),
            }
            : null,
        criterion_claims: parseCriterionClaims(raw.criterion_claims),
        contract_item_claims: parseContractItemClaims(raw.contract_item_claims),
        progress_estimate: typeof raw.progress_estimate === "number" &&
            Number.isFinite(raw.progress_estimate)
            ? Math.max(0, Math.min(1, raw.progress_estimate))
            : 0.0,
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
function parseCriterionClaims(raw) {
    if (!Array.isArray(raw))
        return [];
    const claims = [];
    for (const item of raw) {
        if (claims.length >= 100)
            break;
        if (typeof item !== "object" || item === null || Array.isArray(item))
            continue;
        const entry = item;
        if (typeof entry.criterion_id !== "string" || entry.criterion_id.trim().length === 0)
            continue;
        if (entry.outcome !== "met" && entry.outcome !== "remaining")
            continue;
        claims.push({
            criterion_id: entry.criterion_id.trim().slice(0, 500),
            outcome: entry.outcome,
        });
    }
    return claims;
}
/** v3.8: LENIENT parse of contract item claims. Referential validity is the
 *  strict pre-advance boundary in validateContractShape — this parser only
 *  normalizes what reaches the read model. */
function parseContractItemClaims(raw) {
    if (!Array.isArray(raw))
        return [];
    const claims = [];
    for (const item of raw) {
        if (claims.length >= 20)
            break;
        if (typeof item !== "object" || item === null || Array.isArray(item))
            continue;
        const entry = item;
        if (typeof entry.item_id !== "string")
            continue;
        if (entry.outcome !== "met" && entry.outcome !== "remaining")
            continue;
        claims.push({
            item_id: entry.item_id.trim().slice(0, 64),
            outcome: entry.outcome,
        });
    }
    return claims;
}
/** Parse CriterionRevision[] from a raw JSON array. */
export function parseCriterionRevisions(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((v) => typeof v === "object" && v !== null &&
        typeof v.old === "string" &&
        typeof v.new === "string")
        .slice(0, 20)
        .map((v) => {
        const r = v;
        return { old: r.old.slice(0, 500), new: r.new.slice(0, 500) };
    });
}
/** Parse SubGoalUpdate[] from a raw JSON array.
 *  v3.7.1: lenient per-entry filtering (id/status shape) with fixed caps
 *  (20 entries, id ≤ 64, note ≤ 300). Referential validity — unknown IDs
 *  and illegal migrations — is NOT checked here: that needs the committed
 *  sub-goal set and runs as a pre-advance validation (evaluation_invalid). */
export function parseSubGoalUpdates(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((v) => typeof v === "object" && v !== null &&
        typeof v.id === "string" &&
        (v.status === "in_progress" ||
            v.status === "done" ||
            v.status === "blocked" ||
            v.status === "canceled"))
        .slice(0, 20)
        .map((u) => {
        const update = {
            id: u.id.trim().slice(0, 64),
            status: u.status,
        };
        if (typeof u.note === "string" && u.note.trim().length > 0) {
            update.note = u.note.trim().slice(0, 300);
        }
        return update;
    });
}
/** Parse WorkerResult[] from a raw JSON array.
 *  v3.7.1: `outcome` is the single fact. An entry without a valid outcome
 *  is dropped (not derived, not defaulted) — the array stays informational:
 *  absent/empty arrays are accepted unchanged, so a round without any
 *  delegation can never be rejected over worker fields. */
export function parseWorkerResults(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw
        .filter((v) => {
        if (typeof v !== "object" || v === null)
            return false;
        const w = v;
        return typeof w.agentId === "string" &&
            typeof w.subTask === "string" &&
            typeof w.resultSummary === "string" &&
            (w.outcome === "success" || w.outcome === "partial" || w.outcome === "failed");
    })
        .slice(0, 20)
        .map((v) => {
        const w = v;
        return {
            agentId: w.agentId.slice(0, 200),
            subAgentType: typeof w.subAgentType === "string"
                ? w.subAgentType.slice(0, 100)
                : "general-purpose",
            subTask: w.subTask.slice(0, 500),
            resultSummary: w.resultSummary.slice(0, 1000),
            outcome: w.outcome,
            discoveredConstraints: boundedStringArray(w.discoveredConstraints, 50, 500),
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
 *  Lenient parsing: missing optional fields get sensible defaults. */
export function buildSelfEvaluation(raw) {
    const executionReport = parseExecutionReport(raw.execution_report);
    const retractedConstraints = boundedStringArray(raw.retracted_constraints, 50, 500);
    const revisedCriteria = parseCriterionRevisions(raw.revised_success_criteria);
    const wrongAssumptions = boundedStringArray(raw.wrong_assumptions, 50, 500);
    const workerResults = parseWorkerResults(raw.worker_results);
    return makeSelfEvaluation({
        success: typeof raw.success === "boolean" ? raw.success : false,
        output_summary: typeof raw.output_summary === "string" ? raw.output_summary : "",
        constraint_violations: Array.isArray(raw.constraint_violations)
            ? raw.constraint_violations.filter((v) => typeof v === "string")
            : [],
        should_continue: typeof raw.should_continue === "boolean" ? raw.should_continue : true,
        discovered_constraints: boundedStringArray(raw.discovered_constraints, 50, 500),
        objective_refinement: boundedString(raw.objective_refinement, 1000) ?? "",
        emerged_subtasks: boundedEmergedSubtasks(raw.emerged_subtasks),
        execution_report: executionReport,
        retracted_constraints: retractedConstraints,
        revised_success_criteria: revisedCriteria,
        wrong_assumptions: wrongAssumptions,
        worker_results: workerResults,
        compression_checkpoint: typeof raw.compression_checkpoint === "boolean" ? raw.compression_checkpoint : false,
        checkpoint_label: boundedString(raw.checkpoint_label, 200) ?? "",
        subgoal_updates: parseSubGoalUpdates(raw.subgoal_updates),
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
        gate_ids: boundedStringArray(raw.gate_ids, 20, 64),
        retroactiveClaims: parseRetroactiveClaims(raw.retroactiveClaims),
        no_change_reason: typeof raw.no_change_reason === "string" && raw.no_change_reason.trim().length > 0
            ? raw.no_change_reason.slice(0, 200)
            : undefined,
        prompt_requests: parsePromptRequests(raw.prompt_requests),
        round_contract: parseRoundContract(raw.round_contract),
    });
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
    const items = Array.isArray(obj.items)
        ? obj.items
            .slice(0, CONTRACT_LIMITS.items)
            .filter((item) => typeof item === "object" && item !== null && !Array.isArray(item))
            .map((item) => ({
            description: typeof item.description === "string"
                ? item.description.trim().slice(0, 200)
                : "",
            criterion_refs: capStrings(item.criterion_refs, 200, CONTRACT_LIMITS.criterionRefs),
            subgoal_refs: capStrings(item.subgoal_refs, 64, CONTRACT_LIMITS.subgoalRefs),
            verify_with: capStrings(item.verify_with, 200, CONTRACT_LIMITS.verifyWith),
        }))
        : [];
    return {
        work_item: typeof obj.work_item === "string" && obj.work_item.trim().length > 0
            ? obj.work_item.trim().slice(0, 200)
            : undefined,
        scope: capStrings(obj.scope, 500, CONTRACT_LIMITS.scope),
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
export function parsePromptRequests(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const obj = raw;
    const emphasize = boundedStringArray(obj.emphasize, 5, 500);
    const confusionPoints = boundedStringArray(obj.confusion_points, 3, 200);
    // Return undefined when all fields are empty — semantically equivalent
    // to "not set", avoids carrying an empty object through the pipeline.
    if (emphasize.length === 0 && confusionPoints.length === 0) {
        return undefined;
    }
    return { emphasize, confusion_points: confusionPoints };
}
// Free-text inference is intentionally absent. Invalid core fields are
// rejected before round advancement and may be resubmitted with the same
// roundId without changing session, gate, metric, or vault state.
//# sourceMappingURL=self-eval.js.map