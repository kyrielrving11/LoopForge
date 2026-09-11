/** Sub-goal lifecycle — the single implementation (v3.8).
 *
 * A SubGoal is the AGENT's declaration event, not a machine boundary:
 *   - `emerged_subtasks` creates items (always `pending`);
 *   - `subgoal_updates` is the only channel that changes a status;
 *   - machine verification NEVER writes a status. A verified contract item
 *     that references a sub-goal produces a derived `VerifiedSubGoalFact`
 *     (cognitive-facts.ts) instead.
 *
 * Identity (v3.8): `sg-<hash(loopId, declarationRound, declarationOrdinal,
 * normalizedDescription)>`. The round is part of the identity, so
 * re-declaring the same text in a later round creates a NEW sub-goal — the
 * previous one may be terminal, and the old text-only hash silently dropped
 * the re-declaration. Within one round, exactly-equal text keeps only the
 * first entry. Jaccard similarity no longer merges anything: it only feeds
 * the `possible_duplicate_subgoal` diagnostic.
 *
 * Input is committed round views plus the in-flight report — never raw vault
 * envelopes, so there is exactly one history interpretation.
 */

import { createHash } from "node:crypto";
import type { SubGoal, SubGoalUpdate } from "./protocol.js";
import { makeSubGoal } from "./protocol.js";
import { jaccardSimilarity } from "./token-utils.js";

/** Normalize a description for identity purposes: trim, collapse internal
 *  whitespace, lowercase. Mirrors deriveItemId's normalization. */
function normalizeDescription(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** v3.8: Stable sub-goal id scoped to its declaration event. */
export function deriveSubGoalId(
  loopId: string,
  declaredAtRound: number,
  ordinal: number,
  description: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([loopId, declaredAtRound, ordinal, normalizeDescription(description)]))
    .digest("hex")
    .slice(0, 8);
  return `sg-${digest}`;
}

/** v3.8: The items a round's emerged list will create, in order. Exact
 *  duplicates within the round keep only their first entry, and ordinals
 *  count the surviving entries — the pre-advance preflight and the compile
 *  path must agree on this list. */
export function deriveEmergedItems(
  loopId: string,
  declaredAtRound: number,
  descriptions: ReadonlyArray<string>,
): Array<{ id: string; description: string }> {
  const items: Array<{ id: string; description: string }> = [];
  const seen = new Set<string>();
  for (const raw of descriptions) {
    const normalized = normalizeDescription(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push({
      id: deriveSubGoalId(loopId, declaredAtRound, items.length, raw),
      description: raw.trim(),
    });
  }
  return items;
}

/** Closed migration matrix. done/canceled are terminal (no out-edges); the
 *  matrix rejects re-opening. blocked → in_progress is the recovery path. */
export const SUBGOAL_TRANSITIONS: Record<SubGoalUpdate["status"], readonly SubGoal["status"][]> = {
  in_progress: ["pending", "blocked"],
  done: ["pending", "in_progress", "blocked"],
  blocked: ["pending", "in_progress"],
  canceled: ["pending", "in_progress", "blocked"],
};

/** Whether a transition is legal. Same-status is a legal no-op (used by
 *  replay idempotency). References to terminal sub-goals are rejected by
 *  validateSubGoalUpdates before this is consulted. */
export function canTransitionSubGoal(
  from: SubGoal["status"],
  to: SubGoalUpdate["status"],
): boolean {
  if (from === to) return true;
  return SUBGOAL_TRANSITIONS[to].includes(from);
}

/** Referential validation of a payload's subgoal_updates against the
 *  derived sub-goal set. Returns one error per invalid entry:
 *  unknown_id | terminal_reference | illegal_transition. */
export function validateSubGoalUpdates(
  subGoals: SubGoal[],
  updates: SubGoalUpdate[],
): Array<{ id: string; reason: string }> {
  const byId = new Map(subGoals.map((sg) => [sg.id, sg]));
  const errors: Array<{ id: string; reason: string }> = [];
  for (const update of updates) {
    const target = byId.get(update.id);
    if (!target) {
      errors.push({ id: update.id, reason: "unknown_id" });
      continue;
    }
    if (target.status === "done" || target.status === "canceled") {
      errors.push({ id: update.id, reason: "terminal_reference" });
      continue;
    }
    if (!canTransitionSubGoal(target.status, update.status)) {
      errors.push({ id: update.id, reason: "illegal_transition" });
    }
  }
  return errors;
}

/** Apply one transition to the accumulated list. Guards make replay of
 *  committed history idempotent: terminal sub-goals never change and
 *  same-status updates are no-ops. */
function applySubGoalUpdate(
  subGoals: SubGoal[],
  update: SubGoalUpdate,
  rnd: number,
): void {
  const target = subGoals.find((sg) => sg.id === update.id);
  if (!target) return;
  if (target.status === "done" || target.status === "canceled") return;
  if (!canTransitionSubGoal(target.status, update.status)) return;
  if (target.status === update.status) return;
  target.status = update.status;
  target.status_changed_at_round = rnd;
  if (update.note && update.note.trim().length > 0) {
    target.status_note = update.note.trim().slice(0, 300);
  }
  if (update.status === "done") target.completed_at_round = rnd;
}

/** One round's declaration channel: what the agent declared, in order.
 *  Field names match CommittedRoundView so views can be passed directly. */
export interface SubGoalDeclarationRound {
  round: number;
  emergedSubtasks?: ReadonlyArray<string>;
  subgoalUpdates?: ReadonlyArray<SubGoalUpdate>;
}

/** Create the round's emerged items (exact-text dedup within the round). */
function createEmerged(
  subGoals: SubGoal[],
  loopId: string,
  descriptions: ReadonlyArray<string>,
  rnd: number,
): void {
  const existing = new Set(subGoals.map((sg) => sg.id));
  for (const item of deriveEmergedItems(loopId, rnd, descriptions)) {
    if (existing.has(item.id)) continue; // idempotent replay of the same round
    subGoals.push(makeSubGoal({
      id: item.id,
      description: item.description,
      status: "pending",
      declared_at_round: rnd,
      status_changed_at_round: rnd,
      priority: subGoals.length,
    }));
  }
}

/** v3.8: Derive the full sub-goal set from committed round facts plus the
 *  in-flight round's report. Replays every round in order — older
 *  transitions never regress, and no status is ever inferred. */
export function deriveSubGoals(input: {
  loopId: string;
  currentRound: number;
  /** Committed rounds below `currentRound`, ascending, rollback-excluded
   *  (the caller passes CommittedRoundView[] — one history interpretation). */
  rounds: ReadonlyArray<SubGoalDeclarationRound>;
  /** The in-flight round's own report (idempotent replay of the last
   *  committed round on the vault path). */
  currentReport?: SubGoalDeclarationRound | null;
}): SubGoal[] {
  const subGoals: SubGoal[] = [];

  for (const round of input.rounds) {
    createEmerged(subGoals, input.loopId, round.emergedSubtasks ?? [], round.round);
    for (const update of round.subgoalUpdates ?? []) {
      applySubGoalUpdate(subGoals, update, round.round);
    }
  }

  const report = input.currentReport;
  if (report) {
    const rnd = report.round || input.currentRound - 1;
    createEmerged(subGoals, input.loopId, report.emergedSubtasks ?? [], rnd);
    for (const update of report.subgoalUpdates ?? []) {
      applySubGoalUpdate(subGoals, update, rnd);
    }
  }

  // Display order: in_progress, then pending by age, then blocked, then
  // done (most recent first), then canceled.
  subGoals.sort((a, b) => {
    const rank = (s: SubGoal): number => {
      switch (s.status) {
        case "in_progress": return 0;
        case "pending": return 1;
        case "blocked": return 2;
        case "done": return 3;
        case "canceled": return 4;
      }
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.status === "pending") return a.declared_at_round - b.declared_at_round;
    if (a.status === "done") return (b.completed_at_round ?? 0) - (a.completed_at_round ?? 0);
    return a.declared_at_round - b.declared_at_round;
  });

  return subGoals;
}

/** v3.8: Similarity is DIAGNOSTIC ONLY — it never merges or blocks a
 *  declaration. Pairs above the threshold are reported so the prompt can
 *  suggest consolidating them. */
export function possibleDuplicateSubGoals(
  subGoals: ReadonlyArray<SubGoal>,
  threshold: number,
): Array<{ left: string; right: string; score: number }> {
  const out: Array<{ left: string; right: string; score: number }> = [];
  for (let i = 0; i < subGoals.length; i++) {
    for (let j = i + 1; j < subGoals.length; j++) {
      if (subGoals[i].status === "done" || subGoals[i].status === "canceled") continue;
      if (subGoals[j].status === "done" || subGoals[j].status === "canceled") continue;
      const score = jaccardSimilarity(subGoals[i].description, subGoals[j].description);
      if (score >= threshold) {
        out.push({ left: subGoals[i].id, right: subGoals[j].id, score });
      }
    }
  }
  return out;
}
