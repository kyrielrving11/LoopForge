/** v3.9.7: the ONE constraint provenance and retraction resolver.
 *
 *  Both are pure derivations over committed facts. The compiler, the
 *  submission boundary and the receipt must call these functions rather than
 *  maintaining their own text/ID matching rules — a second resolver would
 *  let the boundary reject a target the compiler applied (or the reverse).
 *
 *  Provenance is a derived display fact, never a second ledger. It answers
 *  "where did this active constraint come from in the current branch's
 *  committed history?" — not "is the constraint true?".
 */

import type { ConstraintMeta, LoopObjective } from "./protocol.js";
import type { CommittedRoundView } from "./committed-round.js";
import {
  STABLE_ID_RE,
  deriveConstraintId,
  normalizeText,
} from "./token-utils.js";


export interface ConstraintProvenance {
  source: ConstraintMeta["source"];
  source_round?: number;
}

export interface ConstraintProvenanceInput {
  text: string;
  objective: LoopObjective | null;
  /** Current branch committed rounds below the compile round. */
  windowRounds: ReadonlyArray<CommittedRoundView>;
  /** Plan constraints accepted at round 1 only. */
  roundOnePlan: ReadonlyArray<string>;
  /** Discoveries preserved by the pending rollback directive. */
  preservedDiscoveries: ReadonlyArray<string>;
  /** Directive trigger round, when known. */
  preservedRound?: number;
}

function hasNormalized(values: ReadonlyArray<string> | undefined, key: string): boolean {
  return (values ?? []).some((value) => normalizeText(value) === key);
}

/** Derive the provenance of one active constraint from committed facts.
 *
 *  Precedence is fixed: operator criterion > operator hard constraint >
 *  round-1 plan > preserved rollback discovery > current-streak Agent
 *  discovery > carried active-since > unrecorded. `source` and
 *  `source_round` always come from this one classifier.
 */
export function deriveConstraintProvenance(
  input: ConstraintProvenanceInput,
): ConstraintProvenance {
  const key = normalizeText(input.text);
  const created = input.objective?.created_at_round;

  if (hasNormalized(input.objective?.success_criteria, key)) {
    return {
      source: "criteria",
      ...(created !== undefined && created >= 1 ? { source_round: created } : {}),
    };
  }
  if (hasNormalized(input.objective?.hard_constraints, key)) {
    return {
      source: "hard",
      ...(created !== undefined && created >= 1 ? { source_round: created } : {}),
    };
  }
  if (hasNormalized(input.roundOnePlan, key)) {
    return { source: "plan", source_round: 1 };
  }
  if (hasNormalized(input.preservedDiscoveries, key)) {
    return {
      source: "preserved",
      ...(input.preservedRound !== undefined && input.preservedRound >= 1
        ? { source_round: input.preservedRound }
        : {}),
    };
  }

  // Walk the current branch in order. A round's active set was compiled
  // BEFORE that round's evaluation, so its retraction/discovery applies to
  // the next compile. Processing active -> retraction -> discovery matches
  // that lifecycle.
  let activeSince: number | undefined;
  let discoveredSince: number | undefined;
  for (const view of input.windowRounds) {
    if (hasNormalized(view.activeConstraints, key) && activeSince === undefined) {
      activeSince = view.round;
    }
    if (hasNormalized(view.retractedConstraints, key) && activeSince !== undefined) {
      activeSince = undefined;
      discoveredSince = undefined;
    }
    if (hasNormalized(view.discoveredConstraints, key)) {
      // A duplicate discovery while the constraint is already active must not
      // reset its origin. A discovery after a retirement starts a new streak.
      // A same-round active snapshot plus discovery is treated as a
      // discovery: fixtures/hand-built lineage may stamp both together.
      if (activeSince === undefined || activeSince === view.round) {
        discoveredSince = view.round;
      }
    }
  }

  // This function is called for a text in the CURRENT active set, so a
  // discovery with no earlier active appearance is the origin of the current
  // streak even though the current round is not in `windowRounds` yet.
  if (discoveredSince !== undefined) {
    return { source: "discovered", source_round: discoveredSince };
  }
  if (activeSince !== undefined) {
    return { source: "plan", source_round: activeSince };
  }
  return { source: "unrecorded" };
}

export type ConstraintRetractionReason =
  | "unknown_target"
  | "not_active"
  | "already_retired"
  | "operator_immutable"
  | "plan_not_retractable"
  | "unrecorded_target"
  | "same_round_discovery"
  | "duplicate_request";

export interface ConstraintRetractionTarget {
  text: string;
  provenance: ConstraintProvenance;
}

export interface ConstraintRetractionInput {
  targets: ReadonlyArray<string>;
  /** Active constraints at the START of the submitting round. */
  active: ReadonlyArray<ConstraintRetractionTarget>;
  /** Discoveries declared by the same submission (never retractable). */
  newDiscoveries: ReadonlyArray<string>;
  /** Targets already retired by committed rounds. */
  previouslyRetired: ReadonlyArray<string>;
}

export interface ConstraintRetractionResult {
  /** Effective retraction targets, as active texts, deduplicated. */
  effective: string[];
  /** Accepted-but-inert requests with a stable reason. */
  noops: Array<{ target: string; reason: ConstraintRetractionReason }>;
  /** Structural boundary violations (the submission must be rejected). */
  errors: Array<{
    target: string;
    reason: "immutable_constraint" | "not_retractable";
    detail: string;
  }>;
}

function isConstraintId(value: string): boolean {
  return STABLE_ID_RE.test(value) && value.startsWith("c-");
}

function isCriterionId(value: string): boolean {
  return STABLE_ID_RE.test(value) && value.startsWith("cr-");
}

/** Resolve retraction targets against the active set before this
 *  submission's new discoveries. Only active Agent-discovered (or preserved)
 *  constraints are retractable. Operator criteria/hard constraints and plan
 *  constraints are structural errors; unknown/inactive/already-retired
 *  targets are inert no-ops with a machine reason. */
export function resolveConstraintRetractions(
  input: ConstraintRetractionInput,
): ConstraintRetractionResult {
  const byKey = new Map<string, ConstraintRetractionTarget>();
  const byId = new Map<string, ConstraintRetractionTarget>();
  for (const target of input.active) {
    byKey.set(normalizeText(target.text), target);
    const id = deriveConstraintId(target.text);
    if (!byId.has(id)) byId.set(id, target);
  }
  const newKeys = new Set(input.newDiscoveries.map(normalizeText));
  const retiredKeys = new Set(input.previouslyRetired.map(normalizeText));
  const effective: string[] = [];
  const effectiveKeys = new Set<string>();
  const noops: ConstraintRetractionResult["noops"] = [];
  const errors: ConstraintRetractionResult["errors"] = [];
  const seen = new Set<string>();

  for (const raw of input.targets) {
    const target = typeof raw === "string" ? raw.trim() : "";
    if (!target) {
      noops.push({ target: raw, reason: "unknown_target" });
      continue;
    }
    if (seen.has(target)) {
      noops.push({ target, reason: "duplicate_request" });
      continue;
    }
    seen.add(target);

    if (isCriterionId(target)) {
      errors.push({
        target,
        reason: "immutable_constraint",
        detail: `${target} is an operator criterion and cannot be retracted`,
      });
      continue;
    }

    const resolved = isConstraintId(target)
      ? byId.get(target)
      : byKey.get(normalizeText(target));

    if (!resolved) {
      const key = normalizeText(target);
      const reason: ConstraintRetractionReason = newKeys.has(key)
        ? "same_round_discovery"
        : retiredKeys.has(key)
          ? "already_retired"
          : "unknown_target";
      noops.push({ target, reason });
      continue;
    }

    if (resolved.provenance.source === "hard" ||
        resolved.provenance.source === "criteria") {
      errors.push({
        target,
        reason: "immutable_constraint",
        detail: `${resolved.text} belongs to the operator acceptance surface and cannot be retracted`,
      });
      continue;
    }
    if (resolved.provenance.source === "plan") {
      errors.push({
        target,
        reason: "not_retractable",
        detail: `${resolved.text} is a plan/operator constraint; only active Agent-discovered constraints may be retracted`,
      });
      continue;
    }
    if (resolved.provenance.source === "unrecorded") {
      noops.push({ target, reason: "unrecorded_target" });
      continue;
    }

    const key = normalizeText(resolved.text);
    if (effectiveKeys.has(key)) {
      noops.push({ target, reason: "duplicate_request" });
      continue;
    }
    effectiveKeys.add(key);
    effective.push(resolved.text);
  }

  return { effective, noops, errors };
}
