/** Attempted → retained accounting over the normalizer's persisted output.
 *
 *  `submittedFields` records what appeared in the raw payload. This module
 *  answers the second question: which of those values did the normalizer
 *  actually retain in `SelfEvaluation`? It reads ONLY persisted facts —
 *  the manifest, the diagnostics, and the normalized evaluation — so a
 *  committed round can be rebuilt without re-parsing the raw payload and
 *  without a second ledger.
 *
 *  A path is retained when it was attempted, no whole-field drop diagnostic
 *  exists, and the evaluation carries a value attributable to it. Partial
 *  losses (some array entries dropped) leave the field retained; their
 *  diagnostics remain visible in the receipt.
 */

import type { SelfEvaluation, SubmissionDiagnostic } from "./protocol.js";
import { FIELD_ORDER, type FieldPath } from "./submission-guidance.js";
import {
  DIAG_ALL_ENTRIES_DROPPED,
  DIAG_DIAGNOSTICS_TRUNCATED,
} from "./submission-diagnostics.js";

export interface FieldAccountingSource {
  submittedFields: readonly string[];
  normalizationDiagnostics: readonly SubmissionDiagnostic[];
  evaluation: SelfEvaluation | null;
}

export interface FieldAccounting {
  /** FIELD_ORDER order. */
  retained: string[];
  /** Diagnostics were truncated, the evaluation is missing, or an attempted
   *  path is neither retained nor whole-field dropped. Never a normal state. */
  incomplete: boolean;
}

const ARRAY_WHOLE_DROP_CODES = new Set(["not_array", DIAG_ALL_ENTRIES_DROPPED]);
const ROUND_CONTRACT_WHOLE_DROP_CODES = new Set([
  "invalid_value",
  "invalid_entry",
  DIAG_ALL_ENTRIES_DROPPED,
]);
const TESTS_WHOLE_DROP_CODES = new Set(["invalid_value", "invalid_entry"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldValue(evaluation: SelfEvaluation, path: FieldPath): unknown {
  if (path.startsWith("execution_report.")) {
    const report = evaluation.execution_report;
    if (!report) return undefined;
    const key = path.slice("execution_report.".length) as
      "files_changed" | "tests_reported" | "contract_item_claims" | "criterion_claims";
    return report[key];
  }
  return (evaluation as unknown as Record<string, unknown>)[path];
}

function wholeDrop(
  path: FieldPath,
  diagnostics: readonly SubmissionDiagnostic[],
): boolean {
  const exact = diagnostics.filter(
    (diagnostic) => diagnostic.path === path && diagnostic.handling === "dropped",
  );
  if (exact.length === 0) return false;
  if (path === "execution_report.tests_reported") {
    return exact.some((diagnostic) => TESTS_WHOLE_DROP_CODES.has(diagnostic.code));
  }
  if (path === "round_contract") {
    return exact.some((diagnostic) =>
      ROUND_CONTRACT_WHOLE_DROP_CODES.has(diagnostic.code));
  }
  if (path.endsWith("_claims") ||
      path === "execution_report.files_changed" ||
      path === "constraint_violations" ||
      path === "emerged_subtasks" ||
      path === "discovered_constraints" ||
      path === "retracted_constraints" ||
      path === "wrong_assumptions" ||
      path === "gate_ids" ||
      path === "retroactiveClaims" ||
      path === "worker_results" ||
      path === "subgoal_updates") {
    return exact.some((diagnostic) => ARRAY_WHOLE_DROP_CODES.has(diagnostic.code));
  }
  return true;
}

function hasValue(path: FieldPath, value: unknown): boolean {
  if (path === "round_contract") {
    return isObject(value) &&
      Array.isArray(value.items) &&
      value.items.length > 0;
  }
  // An explicit empty array is a valid declaration. It is retained; only a
  // whole-field drop removes it (checked by the caller before this point).
  if (Array.isArray(value)) return true;
  if (typeof value === "string") return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return value !== undefined && value !== null;
}

function positiveValue(path: FieldPath, value: unknown): boolean {
  if (path === "execution_report.tests_reported") return isObject(value);
  if (path === "round_contract") {
    return isObject(value) && Array.isArray(value.items) && value.items.length > 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return value !== undefined && value !== null;
}

export function deriveFieldAccounting(source: FieldAccountingSource): FieldAccounting {
  if (source.evaluation === null) {
    return { retained: [], incomplete: true };
  }
  const attempted = new Set(source.submittedFields);
  const truncated = source.normalizationDiagnostics.some(
    (diagnostic) => diagnostic.code === DIAG_DIAGNOSTICS_TRUNCATED,
  );
  const retained: string[] = [];
  let unaccounted = false;

  for (const path of FIELD_ORDER) {
    if (!attempted.has(path)) continue;
    const value = fieldValue(source.evaluation, path);
    const dropped = wholeDrop(path, source.normalizationDiagnostics);
    const kept = truncated
      ? positiveValue(path, value) && !dropped
      : path === "execution_report.tests_reported"
        ? source.evaluation.execution_report !== undefined && !dropped
        : hasValue(path, value) && !dropped;
    if (kept) {
      retained.push(path);
    } else if (!dropped && !truncated) {
      unaccounted = true;
    }
  }

  // A manifest path outside FIELD_ORDER cannot be accounted for.
  for (const path of attempted) {
    if (!(FIELD_ORDER as readonly string[]).includes(path)) unaccounted = true;
  }

  return {
    retained,
    incomplete: truncated || unaccounted,
  };
}
