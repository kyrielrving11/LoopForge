/** Structured self-evaluation parsing and normalization — pure functions.
 * The MCP boundary validates required fields before these helpers run.
 */

import {
  makeExecutionReport,
  makeSelfEvaluation,
  type ContractItemClaim,
  type ContractItemProposal,
  type ContractTransition,
  type CriterionClaim,
  type ExecutionReport,
  type RoundContractProposal,
  type SelfEvaluation,
  type SubGoalUpdate,
  type SubmissionDiagnostic,
  type SubmissionDiagnosticHandling,
} from "./protocol.js";
import {
  retiredFieldDetail,
  submittedFieldPaths,
  unknownExecutionReportEntryFields,
  unknownTopLevelFields,
} from "./submission-guidance.js";
import {
  DIAG_ALL_ENTRIES_DROPPED,
  DIAG_EMPTY_VALUE,
} from "./submission-diagnostics.js";
import {
  canonicalContractItemText,
  criterionRefMatches,
  isCriterionId,
} from "./token-utils.js";
import { isOpenQuestionId } from "./open-question.js";

// ── Diagnostics ───────────────────────────────────────────────────────────

/** A diagnostics sink. `buildSelfEvaluation` keeps working without one; the
 *  submission boundary always supplies one so dropped/normalized payload
 *  fields stay visible on the receipt. */
export interface DiagnosticSink {
  push(
    path: string,
    code: string,
    handling: SubmissionDiagnosticHandling,
    detail: string,
  ): void;
}

/** v3.9.2: reference spaces that only the submission boundary can observe.
 *  `null`/undefined = the space was not observable (fail open); an empty array
 *  = an observed empty space (every reference is unknown). */
export interface NormalizationFacts {
  knownCriterionRefs?: ReadonlyArray<{ id: string; text: string }> | null;
  /** v3.9.7: policy cap applied at the submission boundary; the compiler's
   *  defensive slice remains for library callers. */
  maxDiscoveredConstraints?: number;
}

const DIAGNOSTICS_LIMIT = 100;

class DiagnosticsCollector implements DiagnosticSink {
  private readonly entries: SubmissionDiagnostic[] = [];
  private omitted = 0;

  push(
    path: string,
    code: string,
    handling: SubmissionDiagnosticHandling,
    detail: string,
  ): void {
    if (this.entries.length >= DIAGNOSTICS_LIMIT) {
      this.omitted++;
      return;
    }
    this.entries.push({ path, code, handling, detail });
  }

  finish(): SubmissionDiagnostic[] {
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

function boundedString(
  value: unknown,
  maxChars: number,
  sink?: DiagnosticSink,
  path = "",
): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    sink?.push(path, "invalid_value", "dropped",
      "expected a string; null was dropped");
    return undefined;
  }
  if (typeof value !== "string") {
    sink?.push(path, "invalid_value", "dropped",
      `expected a string; the value was dropped`);
    return undefined;
  }
  if (value.length > maxChars) {
    sink?.push(path, "truncated", "truncated",
      `longer than ${maxChars} chars; truncated to the limit`);
    return value.slice(0, maxChars);
  }
  return value;
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxChars: number,
  sink?: DiagnosticSink,
  path = "",
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    sink?.push(path, "not_array", "dropped",
      `expected an array of strings; the value was dropped`);
    return [];
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  const invalid = value.length - strings.length;
  if (invalid > 0) {
    if (strings.length === 0) {
      sink?.push(path, DIAG_ALL_ENTRIES_DROPPED, "dropped",
        `all ${invalid} entr${invalid === 1 ? "y was" : "ies were"} invalid; the value was dropped`);
    } else {
      sink?.push(path, "invalid_entry", "dropped",
        `${invalid} non-string entr${invalid === 1 ? "y" : "ies"} dropped`);
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
    sink?.push(path, "truncated", "truncated",
      `${truncated} entr${truncated === 1 ? "y was" : "ies were"} longer than ${maxChars} chars`);
  }
  if (bounded.length > maxItems) {
    sink?.push(path, "too_many", "truncated",
      `${bounded.length - maxItems} entr${bounded.length - maxItems === 1 ? "y" : "ies"} over the ${maxItems}-item cap were dropped`);
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
export const EMERGED_LIMITS = { items: 50, chars: 500 } as const;

/** THE emerged-list normalization. Both the boundary and the committed
 *  evaluation call this, so the two sets cannot disagree. */
export function boundedEmergedSubtasks(
  value: unknown,
  sink?: DiagnosticSink,
): string[] {
  return boundedStringArray(
    value, EMERGED_LIMITS.items, EMERGED_LIMITS.chars, sink, "emerged_subtasks");
}

function nonNegativeInteger(
  value: unknown,
  sink?: DiagnosticSink,
  path = "",
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (value !== undefined && value !== null) {
      sink?.push(path, "invalid_value", "normalized",
        "expected a finite number; defaulted to 0");
    }
    return 0;
  }
  const normalized = Math.max(0, Math.trunc(value));
  if (normalized !== value) {
    sink?.push(path, "normalized", "normalized",
      `expected a non-negative integer; normalized to ${normalized}`);
  }
  return normalized;
}

/** v2.12: Parse retroactive claims — {round ≥ 1, claim non-empty}, capped at
 *  20 entries. Invalid entries are silently dropped (lenient parsing). */
function parseRetroactiveClaims(
  raw: unknown,
  sink?: DiagnosticSink,
): { round: number; claim: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    sink?.push("retroactiveClaims", "not_array", "dropped",
      "expected an array of { round, claim }; the value was dropped");
    return [];
  }
  const claims: { round: number; claim: string }[] = [];
  let invalid = 0;
  for (const item of raw) {
    if (claims.length >= 20) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      invalid++;
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.round !== "number" || !Number.isInteger(record.round) ||
        record.round < 1 || typeof record.claim !== "string" ||
        record.claim.trim().length === 0) {
      invalid++;
      continue;
    }
    const claim = record.claim.length > 500 ? record.claim.slice(0, 500) : record.claim;
    if (claim !== record.claim) {
      sink?.push("retroactiveClaims", "truncated", "truncated",
        "a claim was longer than 500 chars and was truncated");
    }
    claims.push({ round: record.round, claim });
  }
  if (invalid > 0) {
    sink?.push("retroactiveClaims",
      claims.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped",
      claims.length === 0
        ? `all ${invalid} entries were malformed; the value was dropped`
        : `${invalid} malformed entr${invalid === 1 ? "y" : "ies"} dropped`);
  }
  if (raw.length > 20) {
    sink?.push("retroactiveClaims", "too_many", "truncated",
      `only the first 20 of ${raw.length} entries are kept`);
  }
  return claims;
}

/** Parse ExecutionReport from a raw JSON object. */
export function parseExecutionReport(
  raw: Record<string, unknown> | undefined | null,
  sink?: DiagnosticSink,
  knownCriterionRefs?: ReadonlyArray<{ id: string; text: string }> | null,
): ExecutionReport | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    sink?.push("execution_report", "invalid_entry", "dropped",
      "expected an object; the value was dropped");
    return undefined;
  }
  for (const key of unknownExecutionReportEntryFields(raw)) {
    sink?.push(`execution_report.${key}`, "unknown_field", "dropped",
      "not a declared execution_report field; it was dropped");
  }
  const testResults = raw.tests_reported && typeof raw.tests_reported === "object" &&
      !Array.isArray(raw.tests_reported)
    ? raw.tests_reported as Record<string, unknown>
    : undefined;
  let tests: ExecutionReport["tests_reported"] = null;
  if (raw.tests_reported !== undefined && raw.tests_reported !== null) {
    if (!testResults) {
      sink?.push("execution_report.tests_reported", "invalid_entry", "dropped",
        "expected { passed, failed, skipped }; the value was dropped");
    } else if (typeof testResults.passed !== "number" ||
        !Number.isFinite(testResults.passed)) {
      sink?.push("execution_report.tests_reported", "invalid_value", "dropped",
        "`passed` must be a finite number; the whole object was dropped");
    } else {
      for (const key of Object.keys(testResults)) {
        if (key !== "passed" && key !== "failed" && key !== "skipped") {
          sink?.push(`execution_report.tests_reported.${key}`, "unknown_field", "dropped",
            "not a declared test-count field; it was dropped");
        }
      }
      tests = {
        passed: nonNegativeInteger(
          testResults.passed, sink, "execution_report.tests_reported.passed"),
        failed: nonNegativeInteger(
          testResults.failed, sink, "execution_report.tests_reported.failed"),
        skipped: nonNegativeInteger(
          testResults.skipped, sink, "execution_report.tests_reported.skipped"),
      };
    }
  }
  return makeExecutionReport({
    files_changed: boundedStringArray(
      raw.files_changed, 200, 500, sink, "execution_report.files_changed"),
    tests_reported: tests,
    criterion_claims: parseCriterionClaims(raw.criterion_claims, sink, knownCriterionRefs),
    contract_item_claims: parseContractItemClaims(raw.contract_item_claims, sink),
  });
}

/** v3.8: The criterion ids the agent claims met this round. */
export function claimedMetCriteria(
  report: { criterion_claims?: Array<{ criterion_id: string; outcome: string }> } | undefined | null,
): string[] {
  return (report?.criterion_claims ?? [])
    .filter((claim) => claim.outcome === "met")
    .map((claim) => claim.criterion_id);
}

/** v3.8: The criterion ids the agent declares still outstanding. */
export function claimedRemainingCriteria(
  report: { criterion_claims?: Array<{ criterion_id: string; outcome: string }> } | undefined | null,
): string[] {
  return (report?.criterion_claims ?? [])
    .filter((claim) => claim.outcome === "remaining")
    .map((claim) => claim.criterion_id);
}

/** v3.8: LENIENT parse of advisory criterion claims — unknown or malformed
 *  entries are dropped, never a rejection (the contract item layer is the
 *  strict one). */
function parseCriterionClaims(
  raw: unknown,
  sink?: DiagnosticSink,
  knownCriterionRefs?: ReadonlyArray<{ id: string; text: string }> | null,
): CriterionClaim[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    sink?.push("execution_report.criterion_claims", "not_array", "dropped",
      "expected an array of claims; the value was dropped");
    return [];
  }
  const claims: CriterionClaim[] = [];
  let invalid = 0;
  let unknown = 0;
  for (let index = 0; index < raw.length; index++) {
    if (claims.length >= 100) break;
    const item = raw[index];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      invalid++;
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.criterion_id !== "string" ||
        entry.criterion_id.trim().length === 0 ||
        (entry.outcome !== "met" && entry.outcome !== "remaining")) {
      invalid++;
      continue;
    }
    const trimmed = entry.criterion_id.trim();
    if (trimmed !== entry.criterion_id) {
      sink?.push(`execution_report.criterion_claims[${index}].criterion_id`,
        "normalized", "normalized", "leading/trailing whitespace was trimmed");
    }
    if (trimmed.length > 500) {
      sink?.push(`execution_report.criterion_claims[${index}].criterion_id`,
        "truncated", "truncated", "longer than 500 chars; truncated to the limit");
    }
    const criterionId = trimmed.slice(0, 500);
    if (knownCriterionRefs !== undefined && knownCriterionRefs !== null &&
        !knownCriterionRefs.some((criterion) => criterionRefMatches(criterionId, criterion))) {
      unknown++;
      continue;
    }
    claims.push({
      criterion_id: criterionId,
      outcome: entry.outcome,
    });
  }
  if (invalid > 0 || unknown > 0) {
    if (claims.length === 0) {
      const parts: string[] = [];
      if (invalid > 0) parts.push(`${invalid} malformed`);
      if (unknown > 0) parts.push(`${unknown} unknown criterion`);
      sink?.push("execution_report.criterion_claims", DIAG_ALL_ENTRIES_DROPPED, "dropped",
        `all ${invalid + unknown} claims were dropped (${parts.join(", ")}; advisory)`);
    } else {
      if (invalid > 0) {
        sink?.push("execution_report.criterion_claims", "invalid_entry", "dropped",
          `${invalid} malformed claim${invalid === 1 ? "" : "s"} dropped (advisory)`);
      }
      if (unknown > 0) {
        sink?.push("execution_report.criterion_claims", "unknown_id", "dropped",
          `${unknown} claim${unknown === 1 ? "" : "s"} cited a criterion the ` +
          "prompt did not render; dropped (advisory)");
      }
    }
  }
  if (raw.length > 100) {
    sink?.push("execution_report.criterion_claims", "too_many", "truncated",
      "only the first 100 claims are kept");
  }
  return claims;
}

/** v3.8: LENIENT parse of contract item claims. Referential validity is the
 *  strict pre-advance boundary in validateContractShape — this parser only
 *  normalizes what reaches the read model. */
function parseContractItemClaims(
  raw: unknown,
  sink?: DiagnosticSink,
): ContractItemClaim[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    sink?.push("execution_report.contract_item_claims", "not_array", "dropped",
      "expected an array of claims; the value was dropped");
    return [];
  }
  const claims: ContractItemClaim[] = [];
  let invalid = 0;
  for (let index = 0; index < raw.length; index++) {
    if (claims.length >= 20) break;
    const item = raw[index];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      invalid++;
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.item_id !== "string" ||
        (entry.outcome !== "met" && entry.outcome !== "remaining")) {
      invalid++;
      continue;
    }
    const trimmed = entry.item_id.trim();
    if (trimmed !== entry.item_id) {
      sink?.push(`execution_report.contract_item_claims[${index}].item_id`,
        "normalized", "normalized", "leading/trailing whitespace was trimmed");
    }
    if (trimmed.length > 64) {
      sink?.push(`execution_report.contract_item_claims[${index}].item_id`,
        "truncated", "truncated", "longer than 64 chars; truncated to the limit");
    }
    claims.push({
      item_id: trimmed.slice(0, 64),
      outcome: entry.outcome,
    });
  }
  if (invalid > 0) {
    sink?.push("execution_report.contract_item_claims",
      claims.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped",
      claims.length === 0
        ? `all ${invalid} claims were malformed; the value was dropped`
        : `${invalid} malformed claim${invalid === 1 ? "" : "s"} dropped`);
  }
  if (raw.length > 20) {
    sink?.push("execution_report.contract_item_claims", "too_many", "truncated",
      "only the first 20 claims are kept");
  }
  return claims;
}

/** Parse SubGoalUpdate[] from a raw JSON array.
 *  v3.7.1: lenient per-entry filtering (id/status shape) with fixed caps
 *  (20 entries, id ≤ 64, note ≤ 300). Referential validity — unknown IDs
 *  and illegal migrations — is NOT checked here: that needs the committed
 *  sub-goal set and runs as a pre-advance validation (evaluation_invalid). */
export function parseSubGoalUpdates(
  raw: unknown,
  sink?: DiagnosticSink,
): SubGoalUpdate[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    sink?.push("subgoal_updates", "not_array", "dropped",
      "expected an array of { id, status }; the value was dropped");
    return [];
  }
  const valid = raw.filter((v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null &&
    typeof (v as Record<string, unknown>).id === "string" &&
    ((v as Record<string, unknown>).status === "in_progress" ||
      (v as Record<string, unknown>).status === "done" ||
      (v as Record<string, unknown>).status === "blocked" ||
      (v as Record<string, unknown>).status === "canceled"));
  const invalid = raw.length - valid.length;
  if (invalid > 0) {
    sink?.push("subgoal_updates",
      valid.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped",
      valid.length === 0
        ? `all ${invalid} transitions were malformed; the value was dropped`
        : `${invalid} malformed transition${invalid === 1 ? "" : "s"} dropped`);
  }
  if (valid.length > 20) {
    sink?.push("subgoal_updates", "too_many", "truncated",
      "only the first 20 transitions are kept");
  }
  return valid.slice(0, 20).map((u: Record<string, unknown>, index: number): SubGoalUpdate => {
    const rawId = u.id as string;
    const trimmedId = rawId.trim();
    if (trimmedId !== rawId) {
      sink?.push(`subgoal_updates[${index}].id`, "normalized", "normalized",
        "leading/trailing whitespace was trimmed");
    }
    if (trimmedId.length > 64) {
      sink?.push(`subgoal_updates[${index}].id`, "truncated", "truncated",
        "longer than 64 chars; truncated to the limit");
    }
    const update: SubGoalUpdate = {
      id: trimmedId.slice(0, 64),
      status: u.status as SubGoalUpdate["status"],
    };
    if (u.note !== undefined) {
      if (typeof u.note !== "string") {
        sink?.push(`subgoal_updates[${index}].note`, "invalid_value", "dropped",
          "expected a string; the note was dropped");
      } else if (u.note.trim().length === 0) {
        sink?.push(`subgoal_updates[${index}].note`, DIAG_EMPTY_VALUE, "dropped",
          "empty note was dropped");
      } else {
        const note = u.note.trim();
        if (note.length > 300) {
          sink?.push(`subgoal_updates[${index}].note`, "truncated", "truncated",
            "a note was longer than 300 chars and was truncated");
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
export function parseWorkerResults(
  raw: unknown,
  sink?: DiagnosticSink,
): import("./protocol.js").WorkerResult[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    sink?.push("worker_results", "not_array", "dropped",
      "expected an array of worker reports; the value was dropped");
    return [];
  }
  const valid = raw.filter((v: unknown) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const w = v as Record<string, unknown>;
    return typeof w.agentId === "string" &&
      typeof w.subTask === "string" &&
      typeof w.resultSummary === "string" &&
      (w.outcome === "success" || w.outcome === "partial" || w.outcome === "failed");
  });
  const invalid = raw.length - valid.length;
  if (invalid > 0) {
    sink?.push("worker_results",
      valid.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped",
      valid.length === 0
        ? `all ${invalid} reports were malformed; the value was dropped`
        : `${invalid} report${invalid === 1 ? "" : "s"} missing a string agentId/subTask/resultSummary or a valid outcome dropped`);
  }
  if (valid.length > 20) {
    sink?.push("worker_results", "too_many", "truncated",
      "only the first 20 worker reports are kept");
  }
  return valid.slice(0, 20).map((v: unknown, index: number) => {
    const w = v as Record<string, unknown>;
    for (const key of Object.keys(w)) {
      if (!["agentId", "subTask", "resultSummary", "outcome"].includes(key)) {
        sink?.push(`worker_results[${index}].${key}`, "unknown_field", "dropped",
          "not a declared worker-result field; it was dropped");
      }
    }
    for (const [key, cap] of [
      ["agentId", 200], ["subTask", 500], ["resultSummary", 1000],
    ] as const) {
      const value = w[key];
      if (typeof value === "string" && value.length > cap) {
        sink?.push(`worker_results[${index}].${key}`, "truncated", "truncated",
          `longer than ${cap} chars; truncated to the limit`);
      }
    }
    return {
      agentId: ((w.agentId as string).slice(0, 200)),
      subTask: ((w.subTask as string).slice(0, 500)),
      resultSummary: ((w.resultSummary as string).slice(0, 1000)),
      outcome: w.outcome as "success" | "partial" | "failed",
    };
  });
}

// v3.9.7: the outcome predicates live in round-outcome.ts so contract
// closure, the walker, the verification gate and the coordinator share one
// definition. Re-exported for the existing public surface.
export {
  effectiveOutcome,
  effectiveSuccess,
  declaresBlocked,
} from "./round-outcome.js";

/** Required evaluation fields are the only format boundary. Optional fields
 * are deliberately normalized by buildSelfEvaluation instead of rejecting a
 * round for a non-authoritative reporting detail.
 *
 * v3.7.1: subgoal_updates is one documented exception — it is a strict
 * STRUCTURAL boundary (machine-processable state transitions). Its shape
 * and referential errors ride here as `subgoal_errors` and return
 * evaluation_invalid with the same guarantees: no state change, no gates,
 * no rejection counters, same-roundId retry. */
export interface EvaluationValidation {
  missing: string[];
  invalid: Array<{ field: string; expected: string }>;
  subgoal_errors?: Array<{ field: string; reason: string; detail: string }>;
}

export function validateCoreSelfEvaluation(
  raw: Record<string, unknown>,
): EvaluationValidation {
  const missing: string[] = [];
  const invalid: Array<{ field: string; expected: string }> = [];
  const required = ["success", "output_summary", "constraint_violations", "should_continue"] as const;
  for (const field of required) {
    if (!(field in raw)) missing.push(field);
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
 *  gates, no rejection counters, retry with the same submissionHandle.
 *
 *  Shape-only (no vault): entry shape, id pattern, status enum, caps, and
 *  the sg-XXXXXXXX creation prohibition on emerged_subtasks. Referential
 *  validity (unknown IDs / terminal references / illegal migrations) needs
 *  the committed sub-goal set and is checked against the compiled
 *  sub_goals right before advance (validateSubGoalUpdates in
 *  loop-compiler.ts). */
export function validateSubGoalUpdatesShape(
  raw: Record<string, unknown>,
): Array<{ field: string; reason: string; detail: string }> {
  const errors: Array<{ field: string; reason: string; detail: string }> = [];
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
  if (updates === undefined) return errors;
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
    const u = entry as Record<string, unknown>;
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

export interface ContractValidationError {
  field: string;
  reason: string;
  detail: string;
}

const CONTRACT_ID_RE = /^rc-[a-f0-9]{8}$/;
export const CONTRACT_TRANSITION_REASON_MAX = 500;

/** v3.9.9: LENIENT contract-transition parser. Historical/externally written
 *  data produces a diagnostic and is dropped; it never closes a contract and
 *  never throws. The strict submission boundary is the only commit check. */
export function parseContractTransition(
  raw: unknown,
  sink?: DiagnosticSink,
): ContractTransition | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    sink?.push("contract_transition", "invalid_entry", "dropped",
      "expected a contract-transition object; the value was dropped");
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["kind", "contract_id", "reason"].includes(key)) {
      sink?.push(`contract_transition.${key}`, "unknown_field", "dropped",
        "not a declared contract-transition field; it was dropped");
    }
  }
  if (obj.kind !== "supersede") {
    // An exact-path diagnostic: the whole transition was dropped, so field
    // accounting can explain the attempted-but-not-retained path.
    sink?.push("contract_transition", "invalid_enum", "dropped",
      "only kind \"supersede\" is supported; the transition was dropped");
    return undefined;
  }
  if (typeof obj.contract_id !== "string" ||
      !CONTRACT_ID_RE.test(obj.contract_id.trim())) {
    sink?.push("contract_transition", "invalid_id", "dropped",
      "contract_id must be an rc-XXXXXXXX id; the transition was dropped");
    return undefined;
  }
  const contractId = obj.contract_id.trim();
  let reason: string | undefined;
  if (obj.reason !== undefined) {
    if (typeof obj.reason !== "string") {
      sink?.push("contract_transition.reason", "invalid_value", "dropped",
        "expected a string; the reason was dropped");
    } else if (obj.reason.length > CONTRACT_TRANSITION_REASON_MAX) {
      sink?.push("contract_transition.reason", "truncated", "truncated",
        `longer than ${CONTRACT_TRANSITION_REASON_MAX} chars; truncated to the limit`);
      reason = obj.reason.slice(0, CONTRACT_TRANSITION_REASON_MAX);
    } else {
      reason = obj.reason;
    }
  }
  return {
    kind: "supersede",
    contract_id: contractId,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** v3.9.9: the facts the strict transition boundary needs, derived from the
 *  SAME active contract the prompt rendered. `observed: false` means the
 *  session's committed facts could not be read — structure stays strict, but
 *  the active-contract-dependent checks fail open. */
export interface ContractTransitionValidationContext {
  observed: boolean;
  activeContractId: string | null;
  /** Normalized content identity of every ACTIVE item. */
  activeItemIdentities: ReadonlySet<string> | null;
}

function declaresBlockedRaw(raw: Record<string, unknown>): boolean {
  return raw.outcome === "blocked" ||
    raw.stop_reason === "blocked" ||
    raw.stop_reason === "needs_human_input";
}

/** v3.9.9: strict transition boundary. Every failure is `contract_invalid` and
 *  the same submissionHandle may retry with a corrected payload. */
export function validateContractTransition(
  raw: Record<string, unknown>,
  context: ContractTransitionValidationContext,
): ContractValidationError[] {
  const transition = raw.contract_transition;
  if (transition === undefined) return [];
  const errors: ContractValidationError[] = [];
  if (transition === null || typeof transition !== "object" ||
      Array.isArray(transition)) {
    errors.push({
      field: "contract_transition",
      reason: "not_object",
      detail: "contract_transition must be an object",
    });
    return errors;
  }
  const obj = transition as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["kind", "contract_id", "reason"].includes(key)) {
      errors.push({
        field: "contract_transition",
        reason: "unknown_field",
        detail: `contract_transition has unknown field "${key}"`,
      });
    }
  }
  if (obj.kind !== "supersede") {
    errors.push({
      field: "contract_transition",
      reason: "invalid_kind",
      detail: "contract_transition.kind must be \"supersede\"",
    });
  }
  const contractId = typeof obj.contract_id === "string"
    ? obj.contract_id.trim()
    : "";
  if (!CONTRACT_ID_RE.test(contractId)) {
    errors.push({
      field: "contract_transition",
      reason: "invalid_contract_id",
      detail: "contract_transition.contract_id must be an rc-XXXXXXXX id",
    });
  }
  if (obj.reason !== undefined &&
      (typeof obj.reason !== "string" ||
       obj.reason.length > CONTRACT_TRANSITION_REASON_MAX)) {
    errors.push({
      field: "contract_transition",
      reason: "invalid_reason",
      detail:
        `contract_transition.reason must be a string of at most ` +
        `${CONTRACT_TRANSITION_REASON_MAX} chars`,
    });
  }

  // A transition is always a redirect to a successor, never a bare note.
  const successor = raw.round_contract;
  if (successor === undefined || successor === null ||
      typeof successor !== "object" || Array.isArray(successor)) {
    errors.push({
      field: "contract_transition",
      reason: "transition_without_successor",
      detail:
        "contract_transition must be submitted together with the successor round_contract",
    });
  }
  if (declaresBlockedRaw(raw)) {
    errors.push({
      field: "contract_transition",
      reason: "transition_conflicts_with_blocked",
      detail:
        "a contract transition cannot be combined with a blocked outcome/stop_reason",
    });
  }
  if (raw.should_continue === false) {
    errors.push({
      field: "contract_transition",
      reason: "transition_on_stop",
      detail:
        "a contract transition activates a successor next round; it cannot be submitted with should_continue=false",
    });
  }

  if (!context.observed) return errors;
  if (context.activeContractId === null) {
    errors.push({
      field: "contract_transition",
      reason: "no_active_contract",
      detail: "there is no active contract to supersede",
    });
  } else if (contractId !== context.activeContractId) {
    errors.push({
      field: "contract_transition",
      reason: "transition_target_mismatch",
      detail:
        `contract_transition.contract_id must equal the active contract ` +
        `(${context.activeContractId})`,
    });
  }

  // "Substantive change" means the ACCEPTANCE CONTENT changed. A new
  // work_item/scope label alone is not a new slice.
  if (context.activeItemIdentities && successor &&
      typeof successor === "object" && !Array.isArray(successor)) {
    const rawItems = (successor as Record<string, unknown>).items;
    if (Array.isArray(rawItems)) {
      const identities = new Set<string>();
      for (const item of rawItems) {
        const identity = rawContractItemIdentity(item);
        if (identity !== null) identities.add(identity);
      }
      if (identities.size > 0 &&
          identities.size === context.activeItemIdentities.size &&
          [...identities].every((identity) =>
            context.activeItemIdentities!.has(identity))) {
        errors.push({
          field: "contract_transition",
          reason: "transition_without_change",
          detail:
            "the successor's acceptance items are identical to the active " +
            "contract's; changing only work_item/scope is not a new slice",
        });
      }
    }
  }
  return errors;
}

function validateContractItem(
  item: unknown,
  index: number,
  context: ContractValidationContext,
  errors: ContractValidationError[],
): void {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    errors.push({
      field: "round_contract",
      reason: "invalid_item",
      detail: `item ${index} is not an object`,
    });
    return;
  }
  const entry = item as Record<string, unknown>;
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
  } else if (entry.description.trim().length > CONTRACT_LIMITS.itemDescription) {
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
  } else {
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
    } else {
      if (criterionRefs.length > CONTRACT_LIMITS.criterionRefs) {
        errors.push({
          field: "round_contract",
          reason: "too_many_criterion_refs",
          detail: `item ${index} criterion_refs may list at most ` +
            `${CONTRACT_LIMITS.criterionRefs} ids (got ${criterionRefs.length})`,
        });
      }
      const seen = new Set<string>();
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
function rawContractItemIdentity(item: unknown): string | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const entry = item as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return canonicalContractItemText({
    description: typeof entry.description === "string" ? entry.description : "",
    criterion_refs: strings(entry.criterion_refs),
    verify_with: strings(entry.verify_with),
  });
}

/** v3.8: Everything the strict contract boundary needs to judge a declaration
 *  against the SAME derived state the agent saw in its prompt. Injected rather
 *  than imported so the validator stays a pure, unit-testable function. */
export interface ContractValidationContext {
  /** rci- ids of the ACTIVE contract; null when it cannot be observed (fail
   *  open — shape checks stay strict either way). */
  activeItemIds: ReadonlySet<string> | null;
  /** v3.9.4: cr- ids of the ACTIVE criterion set rendered by the prompt. Null
   *  when the compile response cannot be observed (fail open). */
  knownCriterionIds: ReadonlySet<string> | null;
  /** Configured AND enabled AND after-capable evidence command. */
  isConfiguredCommand: (name: string) => boolean;
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
export function validateContractShape(
  raw: Record<string, unknown>,
  context: ContractValidationContext,
): ContractValidationError[] {
  const errors: ContractValidationError[] = [];
  const contract = raw.round_contract;
  if (contract !== undefined) {
    if (typeof contract !== "object" || contract === null || Array.isArray(contract)) {
      errors.push({
        field: "round_contract",
        reason: "not_object",
        detail: "round_contract must be an object with an items array",
      });
    } else {
      const obj = contract as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!["work_item", "scope", "items"].includes(key)) {
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
      } else if (typeof obj.work_item !== "string") {
        errors.push({
          field: "round_contract",
          reason: "invalid_work_item",
          detail: "work_item must be a string",
        });
      } else if (obj.work_item.trim().length === 0) {
        errors.push({
          field: "round_contract",
          reason: "empty_work_item",
          detail: "work_item must not be empty",
        });
      } else if (obj.work_item.trim().length > CONTRACT_LIMITS.workItem) {
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
      } else if (items.length > CONTRACT_LIMITS.items) {
        errors.push({
          field: "round_contract",
          reason: "too_many_items",
          detail: `a contract may declare at most ${CONTRACT_LIMITS.items} items (got ${items.length})`,
        });
      } else {
        const seenItems = new Map<string, number>();
        items.forEach((item, index) => {
          validateContractItem(item, index, context, errors);
          // v3.9.4: two identical normalized items would derive two rci- ids
          // for one semantic object. Reject the restatement instead of
          // letting a citation become ambiguous.
          const identity = rawContractItemIdentity(item);
          if (identity === null) return;
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
    }
  }

  const report = raw.execution_report;
  if (typeof report === "object" && report !== null && !Array.isArray(report)) {
    const claims = (report as Record<string, unknown>).contract_item_claims;
    if (claims !== undefined) {
      if (!Array.isArray(claims)) {
        errors.push({
          field: "execution_report.contract_item_claims",
          reason: "not_array",
          detail: "contract_item_claims must be an array of { item_id, outcome } entries",
        });
      } else {
        const seen = new Set<string>();
        claims.forEach((claim, index) => {
          if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
            errors.push({
              field: "execution_report.contract_item_claims",
              reason: "invalid_entry",
              detail: `entry ${index} is not an object`,
            });
            return;
          }
          const entry = claim as Record<string, unknown>;
          const id = typeof entry.item_id === "string" ? entry.item_id.trim() : "";
          if (!/^rci-[a-f0-9]{8}$/.test(id)) {
            errors.push({
              field: "execution_report.contract_item_claims",
              reason: "invalid_item_id",
              detail: `entry ${index} must reference an rci-XXXXXXXX contract item id`,
            });
          } else {
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
export function buildSelfEvaluation(
  raw: Record<string, unknown>,
  sink?: DiagnosticSink,
  facts?: NormalizationFacts,
): SelfEvaluation {
  const executionReport = parseExecutionReport(
    raw.execution_report as Record<string, unknown> | undefined,
    sink,
    facts?.knownCriterionRefs,
  );

  const retractedConstraints = boundedStringArray(
    raw.retracted_constraints, 50, 500, sink, "retracted_constraints");
  const wrongAssumptions = boundedStringArray(
    raw.wrong_assumptions, 50, 500, sink, "wrong_assumptions");
  // v4.0.2: strictly report-only. The window/caps are the field's contract,
  // not policy: at most 3 entries, 300 chars each.
  const openQuestions = boundedStringArray(
    raw.open_questions, 3, 300, sink, "open_questions");
  const resolvedOpenQuestionIds = boundedStringArray(
    raw.resolved_open_question_ids, 20, 80, sink,
    "resolved_open_question_ids")
    .filter((value) => {
      if (isOpenQuestionId(value)) return true;
      sink?.push("resolved_open_question_ids", "invalid_value", "dropped",
        `invalid open-question id: ${value}`);
      return false;
    });
  const workerResults = parseWorkerResults(raw.worker_results, sink);

  if (raw.success !== undefined && typeof raw.success !== "boolean") {
    sink?.push("success", "invalid_value", "dropped",
      "expected a boolean; normalized to false (core validation rejects it)");
  }
  if (raw.output_summary !== undefined && typeof raw.output_summary !== "string") {
    sink?.push("output_summary", "invalid_value", "dropped",
      "expected a string; normalized to the empty string (core validation rejects it)");
  }
  let constraintViolations: string[] = [];
  if (raw.constraint_violations !== undefined) {
    if (!Array.isArray(raw.constraint_violations)) {
      sink?.push("constraint_violations", "not_array", "dropped",
        "expected an array of strings; normalized to [] (core validation rejects it)");
    } else {
      constraintViolations = raw.constraint_violations
        .filter((v: unknown): v is string => typeof v === "string");
      const invalid = raw.constraint_violations.length - constraintViolations.length;
      if (invalid > 0) {
        sink?.push("constraint_violations",
          constraintViolations.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry",
          "dropped",
          constraintViolations.length === 0
            ? `all ${invalid} entries were non-strings; the value was dropped`
            : `${invalid} non-string entr${invalid === 1 ? "y" : "ies"} dropped`);
      }
    }
  }
  if (raw.should_continue !== undefined && typeof raw.should_continue !== "boolean") {
    sink?.push("should_continue", "invalid_value", "dropped",
      "expected a boolean; normalized to true (core validation rejects it)");
  }
  if (raw.stop_reason !== undefined &&
      raw.stop_reason !== "gave_up" && raw.stop_reason !== "blocked" &&
      raw.stop_reason !== "needs_human_input") {
    sink?.push("stop_reason", "invalid_enum", "dropped",
      "expected gave_up | blocked | needs_human_input; the value was dropped");
  }
  if (raw.outcome !== undefined &&
      raw.outcome !== "success" && raw.outcome !== "partial" &&
      raw.outcome !== "failed" && raw.outcome !== "blocked") {
    sink?.push("outcome", "invalid_enum", "dropped",
      "expected success | partial | failed | blocked; the value was dropped");
  }
  if (raw.subtask_boundary !== undefined &&
      typeof raw.subtask_boundary !== "boolean") {
    sink?.push("subtask_boundary", "invalid_value", "dropped",
      "expected a boolean; normalized to false");
  }
  if (raw.blocker !== undefined) {
    if (typeof raw.blocker !== "string") {
      sink?.push("blocker", "invalid_value", "dropped",
        "expected a string; the value was dropped");
    } else if (raw.blocker.trim().length === 0) {
      sink?.push("blocker", DIAG_EMPTY_VALUE, "dropped",
        "empty blocker was dropped");
    } else if (raw.blocker.length > 500) {
      sink?.push("blocker", "truncated", "truncated",
        "longer than 500 chars; truncated to the limit");
    }
  }
  const noChangeReason = boundedString(
    raw.no_change_reason, 200, sink, "no_change_reason");
  if (raw.no_change_reason === "") {
    sink?.push("no_change_reason", DIAG_EMPTY_VALUE, "dropped",
      "empty reason was dropped");
  }

  return makeSelfEvaluation({
    success: typeof raw.success === "boolean" ? raw.success : false,
    output_summary: typeof raw.output_summary === "string" ? raw.output_summary : "",
    constraint_violations: constraintViolations,
    should_continue: typeof raw.should_continue === "boolean" ? raw.should_continue : true,
    discovered_constraints: boundedStringArray(
      raw.discovered_constraints,
      facts?.maxDiscoveredConstraints ?? 50,
      500,
      sink,
      "discovered_constraints"),
    emerged_subtasks: boundedEmergedSubtasks(raw.emerged_subtasks, sink),
    execution_report: executionReport,
    retracted_constraints: retractedConstraints,
    wrong_assumptions: wrongAssumptions,
    open_questions: openQuestions,
    resolved_open_question_ids: resolvedOpenQuestionIds,
    worker_results: workerResults,
    subtask_boundary:
      typeof raw.subtask_boundary === "boolean" ? raw.subtask_boundary : false,
    subtask_boundary_label: boundedString(
      raw.subtask_boundary_label, 200, sink, "subtask_boundary_label") ?? "",
    subgoal_updates: parseSubGoalUpdates(raw.subgoal_updates, sink),
    stop_reason:
      raw.stop_reason === "gave_up" || raw.stop_reason === "blocked" || raw.stop_reason === "needs_human_input"
        ? raw.stop_reason
        : undefined,
    outcome:
      raw.outcome === "success" || raw.outcome === "partial" ||
      raw.outcome === "failed" || raw.outcome === "blocked"
        ? raw.outcome
        : undefined,
    blocker:
      typeof raw.blocker === "string" && raw.blocker.trim().length > 0
        ? raw.blocker.slice(0, 500)
        : undefined,
    gate_ids: boundedStringArray(raw.gate_ids, 20, 64, sink, "gate_ids"),
    retroactiveClaims: parseRetroactiveClaims(raw.retroactiveClaims, sink),
    no_change_reason: noChangeReason || undefined,
    round_contract: parseRoundContract(raw.round_contract, sink),
    contract_transition: parseContractTransition(raw.contract_transition, sink),
  });
}

/** v3.9.1: normalization result used by the submission boundary. */
export interface NormalizationResult {
  evaluation: SelfEvaluation;
  diagnostics: SubmissionDiagnostic[];
  submittedFields: string[];
}

/** Normalize a raw submission and report every lossy decision. Unknown and
 *  retired fields are diagnosed and dropped; they are never silently accepted. */
export function normalizeSelfEvaluation(
  raw: Record<string, unknown>,
  facts?: NormalizationFacts,
): NormalizationResult {
  const collector = new DiagnosticsCollector();
  for (const key of unknownTopLevelFields(raw)) {
    collector.push(
      key,
      "unknown_field",
      "dropped",
      retiredFieldDetail(key) ?? "not a declared evaluation field; it was dropped",
    );
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
} as const;

/** Parse a Round Contract PROPOSAL from raw JSON input. Lenient on shapes
 *  the strict declaration boundary already rejected: strings are trimmed and
 *  capped, non-string array entries are dropped. Item ORDER and COUNT are
 *  preserved — the derived rci- ids depend on them. Returns undefined only
 *  when the raw value is absent or not an object. */
export function parseRoundContract(
  raw: unknown,
  sink?: DiagnosticSink,
): RoundContractProposal | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) {
    sink?.push("round_contract", "invalid_value", "dropped",
      "expected a contract object; null was dropped");
    return undefined;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    sink?.push("round_contract", "invalid_entry", "dropped",
      "expected a contract object; the value was dropped");
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["work_item", "scope", "items"].includes(key)) {
      sink?.push(`round_contract.${key}`, "unknown_field", "dropped",
        "not a declared contract field; it was dropped");
    }
  }
  const capStrings = (
    value: unknown,
    max: number,
    cap: number,
    path: string,
  ): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      sink?.push(path, "invalid_entry", "dropped",
        "expected an array of strings; the value was dropped");
      return [];
    }
    const strings = value.filter((v: unknown): v is string => typeof v === "string");
    const invalid = value.length - strings.length;
    if (invalid > 0) {
      sink?.push(`${path}[]`,
        strings.length === 0 ? DIAG_ALL_ENTRIES_DROPPED : "invalid_entry", "dropped",
        strings.length === 0
          ? `all ${invalid} entries were invalid; the value was dropped`
          : `${invalid} non-string entr${invalid === 1 ? "y" : "ies"} dropped`);
    }
    const trimmed = strings.map((v) => v.trim()).filter(Boolean);
    const empty = strings.length - trimmed.length;
    if (empty > 0) {
      sink?.push(`${path}[]`, DIAG_EMPTY_VALUE, "dropped",
        `${empty} empty entr${empty === 1 ? "y was" : "ies were"} dropped`);
    }
    const bounded = trimmed.map((v) => v.slice(0, max));
    if (bounded.some((v, index) => v !== trimmed[index])) {
      sink?.push(`${path}[]`, "truncated", "truncated",
        `a contract string was longer than ${max} chars`);
    }
    if (bounded.length > cap) {
      sink?.push(path, "too_many", "truncated",
        `only the first ${cap} entries are kept`);
    }
    return bounded.slice(0, cap);
  };

  const rawItems = obj.items;
  if (rawItems === undefined) {
    sink?.push("round_contract", "invalid_value", "dropped",
      "expected an items array; the proposal was dropped");
    return undefined;
  }
  if (!Array.isArray(rawItems)) {
    sink?.push("round_contract", "invalid_value", "dropped",
      "items must be an array; the proposal was dropped");
    return undefined;
  }
  const objectItems = rawItems.filter((item): item is Record<string, unknown> =>
    typeof item === "object" && item !== null && !Array.isArray(item));
  const nonObject = rawItems.length - objectItems.length;
  if (nonObject > 0) {
    sink?.push("round_contract.items", "invalid_entry", "dropped",
      `${nonObject} non-object item${nonObject === 1 ? "" : "s"} dropped`);
  }
  const items: ContractItemProposal[] = objectItems
    .slice(0, CONTRACT_LIMITS.items)
    .map((item, index) => {
      for (const key of Object.keys(item)) {
        if (!["description", "criterion_refs", "verify_with"].includes(key)) {
          sink?.push(`round_contract.items[${index}].${key}`, "unknown_field", "dropped",
            "not a declared contract-item field; it was dropped");
        }
      }
      if (item.description !== undefined && typeof item.description !== "string") {
        sink?.push(`round_contract.items[${index}].description`, "invalid_value", "dropped",
          "expected a string; the description was dropped");
      }
      if (typeof item.description === "string" &&
          item.description.trim().length > CONTRACT_LIMITS.itemDescription) {
        sink?.push(`round_contract.items[${index}].description`, "truncated",
          "truncated", `longer than ${CONTRACT_LIMITS.itemDescription} chars; truncated to the limit`);
      }
      return {
        description: typeof item.description === "string"
          ? item.description.trim().slice(0, CONTRACT_LIMITS.itemDescription)
          : "",
        criterion_refs: capStrings(
          item.criterion_refs, 200, CONTRACT_LIMITS.criterionRefs,
          `round_contract.items[${index}].criterion_refs`),
        verify_with: capStrings(
          item.verify_with, 200, CONTRACT_LIMITS.verifyWith,
          `round_contract.items[${index}].verify_with`),
      };
    });
  if (rawItems.length > CONTRACT_LIMITS.items) {
    sink?.push("round_contract.items", "too_many", "truncated",
      `only the first ${CONTRACT_LIMITS.items} items are kept`);
  }
  if (items.length === 0) {
    sink?.push("round_contract", DIAG_ALL_ENTRIES_DROPPED, "dropped",
      "no valid items; the proposal was dropped");
    return undefined;
  }
  if (obj.work_item !== undefined && typeof obj.work_item !== "string") {
    sink?.push("round_contract.work_item", "invalid_value", "dropped",
      "expected a string; the work_item was dropped");
  } else if (typeof obj.work_item === "string" && obj.work_item.trim().length === 0) {
    sink?.push("round_contract.work_item", DIAG_EMPTY_VALUE, "dropped",
      "empty work_item was dropped");
  } else if (typeof obj.work_item === "string" &&
      obj.work_item.trim().length > CONTRACT_LIMITS.workItem) {
    sink?.push("round_contract.work_item", "truncated", "truncated",
      `longer than ${CONTRACT_LIMITS.workItem} chars; truncated to the limit`);
  }
  return {
    work_item:
      typeof obj.work_item === "string" && obj.work_item.trim().length > 0
        ? obj.work_item.trim().slice(0, CONTRACT_LIMITS.workItem)
        : undefined,
    scope: capStrings(obj.scope, 500, CONTRACT_LIMITS.scope, "round_contract.scope"),
    items,
  };
}

// Free-text inference is intentionally absent. Invalid core fields are
// rejected before round advancement and may be resubmitted with the same
// roundId without changing session, gate, metric, or vault state.
