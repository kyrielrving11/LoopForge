/** Structured self-evaluation parsing and normalization — pure functions.
 * The MCP boundary validates required fields before these helpers run.
 */

import {
  makeExecutionEvidence,
  makeSelfEvaluation,
  type CriterionRevision,
  type ExecutionEvidence,
  type PromptRequests,
  type RoundContract,
  type RoundOutcome,
  type SelfEvaluation,
  type SubGoalUpdate,
} from "./protocol.js";

// ── Raw parsing helpers ───────────────────────────────────────────────────

function boundedString(value: unknown, maxChars: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxChars) : undefined;
}

function boundedStringArray(
  value: unknown,
  maxItems: number,
  maxChars: number,
): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, maxChars))
        .slice(0, maxItems)
    : [];
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

/** v2.12: Parse retroactive claims — {round ≥ 1, claim non-empty}, capped at
 *  20 entries. Invalid entries are silently dropped (lenient parsing). */
function parseRetroactiveClaims(raw: unknown): { round: number; claim: string }[] {
  if (!Array.isArray(raw)) return [];
  const claims: { round: number; claim: string }[] = [];
  for (const item of raw) {
    if (claims.length >= 20) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
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
export function parseExecutionEvidence(
  raw: Record<string, unknown> | undefined | null,
): ExecutionEvidence | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const testResults = raw.test_results && typeof raw.test_results === "object" &&
      !Array.isArray(raw.test_results)
    ? raw.test_results as Record<string, unknown>
    : undefined;
  return makeExecutionEvidence({
    files_changed: boundedStringArray(raw.files_changed, 200, 500),
    test_results: testResults && typeof testResults.passed === "number" &&
        Number.isFinite(testResults.passed)
      ? {
          passed: nonNegativeInteger(testResults.passed),
          failed: nonNegativeInteger(testResults.failed),
          skipped: nonNegativeInteger(testResults.skipped),
        }
      : null,
    success_criteria_met: boundedStringArray(raw.success_criteria_met, 100, 500),
    success_criteria_remaining: boundedStringArray(raw.success_criteria_remaining, 100, 500),
    progress_estimate: typeof raw.progress_estimate === "number" &&
        Number.isFinite(raw.progress_estimate)
      ? Math.max(0, Math.min(1, raw.progress_estimate))
      : 0.0,
  });
}

/** Parse CriterionRevision[] from a raw JSON array. */
export function parseCriterionRevisions(
  raw: unknown,
): CriterionRevision[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v: unknown) =>
      typeof v === "object" && v !== null &&
      typeof (v as Record<string, unknown>).old === "string" &&
      typeof (v as Record<string, unknown>).new === "string")
    .slice(0, 20)
    .map((v: unknown) => {
      const r = v as Record<string, unknown>;
      return { old: (r.old as string).slice(0, 500), new: (r.new as string).slice(0, 500) };
    });
}

/** Parse SubGoalUpdate[] from a raw JSON array.
 *  v3.7.1: lenient per-entry filtering (id/status shape) with fixed caps
 *  (20 entries, id ≤ 64, note ≤ 300). Referential validity — unknown IDs
 *  and illegal migrations — is NOT checked here: that needs the committed
 *  sub-goal set and runs as a pre-advance validation (evaluation_invalid). */
export function parseSubGoalUpdates(raw: unknown): SubGoalUpdate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null &&
      typeof (v as Record<string, unknown>).id === "string" &&
      ((v as Record<string, unknown>).status === "in_progress" ||
        (v as Record<string, unknown>).status === "done" ||
        (v as Record<string, unknown>).status === "blocked" ||
        (v as Record<string, unknown>).status === "canceled"))
    .slice(0, 20)
    .map((u: Record<string, unknown>): SubGoalUpdate => {
      const update: SubGoalUpdate = {
        id: (u.id as string).trim().slice(0, 64),
        status: u.status as SubGoalUpdate["status"],
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
export function parseWorkerResults(
  raw: unknown,
): import("./protocol.js").WorkerResult[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v: unknown) => {
      if (typeof v !== "object" || v === null) return false;
      const w = v as Record<string, unknown>;
      return typeof w.agentId === "string" &&
        typeof w.subTask === "string" &&
        typeof w.resultSummary === "string" &&
        (w.outcome === "success" || w.outcome === "partial" || w.outcome === "failed");
    })
    .slice(0, 20)
    .map((v: unknown) => {
      const w = v as Record<string, unknown>;
      return {
        agentId: (w.agentId as string).slice(0, 200),
        subAgentType: typeof w.subAgentType === "string"
          ? w.subAgentType.slice(0, 100)
          : "general-purpose",
        subTask: (w.subTask as string).slice(0, 500),
        resultSummary: (w.resultSummary as string).slice(0, 1000),
        outcome: w.outcome as "success" | "partial" | "failed",
        discoveredConstraints: boundedStringArray(w.discoveredConstraints, 50, 500),
      };
    });
}

/** v2.12: The effective round outcome — declared outcome wins, otherwise
 *  derived from `success`. "partial" can only be declared explicitly (never
 *  silently derived from success=false, which would quietly change the
 *  success-class enforcement surface). */
export function effectiveOutcome(selfEval: SelfEvaluation): RoundOutcome {
  if (selfEval.outcome === "success" || selfEval.outcome === "partial" ||
      selfEval.outcome === "failed" || selfEval.outcome === "blocked") {
    return selfEval.outcome;
  }
  return selfEval.success ? "success" : "failed";
}

/** v2.12: Whether the effective outcome is a success claim. Shared by the
 *  verification gate (success-class checks) and enforcement gate (R3). */
export function effectiveSuccess(selfEval: SelfEvaluation): boolean {
  return effectiveOutcome(selfEval) === "success";
}

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
 *  gates, no rejection counters, retry with the same roundId.
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
    if (u.note !== undefined && typeof u.note !== "string") {
      errors.push({
        field: "subgoal_updates",
        reason: "invalid_note",
        detail: `entry ${index} note must be a string`,
      });
    }
  });
  return errors;
}

/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults. */
export function buildSelfEvaluation(
  raw: Record<string, unknown>,
): SelfEvaluation {
  const executionEvidence = parseExecutionEvidence(
    raw.execution_evidence as Record<string, unknown> | undefined,
  );

  const retractedConstraints = boundedStringArray(raw.retracted_constraints, 50, 500);
  const revisedCriteria: CriterionRevision[] = parseCriterionRevisions(raw.revised_success_criteria);
  const wrongAssumptions = boundedStringArray(raw.wrong_assumptions, 50, 500);
  const workerResults = parseWorkerResults(raw.worker_results);

  return makeSelfEvaluation({
    success: typeof raw.success === "boolean" ? raw.success : false,
    output_summary: typeof raw.output_summary === "string" ? raw.output_summary : "",
    constraint_violations: Array.isArray(raw.constraint_violations)
      ? raw.constraint_violations.filter((v: unknown) => typeof v === "string")
      : [],
    should_continue: typeof raw.should_continue === "boolean" ? raw.should_continue : true,
    discovered_constraints: boundedStringArray(raw.discovered_constraints, 50, 500),
    objective_refinement: boundedString(raw.objective_refinement, 1000) ?? "",
    emerged_subtasks: boundedStringArray(raw.emerged_subtasks, 50, 500),
    execution_evidence: executionEvidence,
    retracted_constraints: retractedConstraints,
    revised_success_criteria: revisedCriteria,
    wrong_assumptions: wrongAssumptions,
    worker_results: workerResults,
    compression_checkpoint:
      typeof raw.compression_checkpoint === "boolean" ? raw.compression_checkpoint : false,
    checkpoint_label: boundedString(raw.checkpoint_label, 200) ?? "",
    next_action: boundedString(raw.next_action, 500),
    subgoal_updates: parseSubGoalUpdates(raw.subgoal_updates),
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
    gate_ids: boundedStringArray(raw.gate_ids, 20, 64),
    retroactiveClaims: parseRetroactiveClaims(raw.retroactiveClaims),
    no_change_reason:
      typeof raw.no_change_reason === "string" && raw.no_change_reason.trim().length > 0
        ? raw.no_change_reason.slice(0, 200)
        : undefined,
    drift_clarification: boundedString(raw.drift_clarification, 1000),
    prompt_requests: parsePromptRequests(raw.prompt_requests),
    round_contract: parseRoundContract(raw.round_contract),
  });
}

/** Parse a RoundContract object from raw JSON input. Lenient: non-string
 *  entries are dropped, strings are trimmed and capped. An object that IS
 *  present is returned even with empty arrays — an empty contract is a
 *  real declaration the round_underspecified check must see. Returns
 *  undefined only when the raw value is absent or not an object. */
export function parseRoundContract(
  raw: unknown,
): RoundContract | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const capStrings = (value: unknown, max: number, cap: number): string[] =>
    Array.isArray(value)
      ? value
          .filter((v: unknown): v is string => typeof v === "string")
          .map((v) => v.trim().slice(0, max))
          .filter(Boolean)
          .slice(0, cap)
      : [];
  return {
    work_item:
      typeof obj.work_item === "string" && obj.work_item.trim().length > 0
        ? obj.work_item.trim().slice(0, 200)
        : undefined,
    done_when: capStrings(obj.done_when, 200, 20),
    verification_plan: capStrings(obj.verification_plan, 200, 20),
    scope: capStrings(obj.scope, 500, 50),
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
export function parsePromptRequests(
  raw: unknown,
): PromptRequests | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
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
