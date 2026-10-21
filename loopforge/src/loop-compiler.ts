/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */

import { createHash } from "node:crypto";
import { deriveConfiguredCapability, getPolicy } from "./policy.js";
import {
  AgentStatus,
  makeLoopCompileResponse,
  makeLoopObjective,
  makeConstraintMeta,
  makeMilestoneSummary,
  makeRollingSummary,
  type ConstraintMeta,
  type CriterionStatus,
  type RecurringFlag,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type LoopObjective,
  type LoopRoundResult,
  type MilestoneSummary,
  type RollingSummary,
  type VerificationFlag,
} from "./protocol.js";
import {
  createCanonicalLoopState,
  renderCanonicalStateMarkdown,
} from "./canonical-state.js";
import type { MachineStatus } from "./canonical-state.js";
import {
  decodeRound,
  entryLineage,
  entryCriteriaMet,
  entryCriteriaRemaining,
  entryActiveConstraints,
  entryRetractedConstraints,
  pendingBacktrackRecord,
  roundResultFromCommittedRound,
  type CommittedRoundView,
  machineGitMotionSeries,
  derivationRounds,
} from "./committed-round.js";
import {
  derivePromptFreshness,
  UNKNOWN_PROMPT_FRESHNESS,
  type PromptFreshness,
} from "./prompt-freshness.js";
import { NO_IN_FLIGHT_ROUND, deriveRoundFacts } from "./round-facts.js";
import type { CriterionMachineFact } from "./round-facts.js";
import { recoveryBriefLines } from "./enforcement-gate.js";
import { deriveSubGoals, duplicateEmergedDeclarations } from "./subgoal-state.js";
import { claimedMetCriteria, claimedRemainingCriteria } from "./self-eval.js";
import { assemblePromptArtifact } from "./prompt-assembler.js";
import {
  renderSelfEvalBlock,
  type SelfEvalPromptContext,
} from "./submission-guidance.js";
import {
  decidePromptLevel,
  type PromptLevelDecision,
} from "./prompt-policy.js";
import {
  criterionRefMatches,
  deriveCriterionId,
  deriveItemId,
  isCriterionId,
  normalizeText,
  unique,
  uniqueNormalized,
  entryRound,
} from "./token-utils.js";

type Entry = Record<string, unknown>;

export interface PreviousRound {
  round: number;
  goal_id: string;
  goal_text_hash: string;
  success: boolean;
  task: string;
  constraints_active: string[];
  output_summary: string;
}

/** ONE bundle of previous-round facts for a compile.
 *
 *  Every consumer (level policy, canonical state, evaluation block) reads
 *  this bundle instead of re-reading the caller's mutable projection. The
 *  committed view wins whenever it exists; `request.last_round_result` is
 *  only the in-flight/library fallback for callers with no committed round
 *  in the context. */
export interface PreviousRoundFacts {
  view: CommittedRoundView | null;
  result: LoopRoundResult | null;
  verificationFlags: VerificationFlag[];
  freshness: PromptFreshness;
  /** A committed backtrack directive targets this compile round's redo. */
  recoveryBoundary: boolean;
}

function contextEntries(context: Record<string, unknown> | null): Entry[] {
  if (!context || !Array.isArray(context.results)) return [];
  return context.results.filter(
    (value): value is Entry => value !== null && typeof value === "object" && !Array.isArray(value),
  );
}

function loopEntries(loopId: string, context: Record<string, unknown> | null): Entry[] {
  return contextEntries(context)
    .filter((entry) => entry.loop_id === loopId || entryLineage(entry).loop_id === loopId)
    .sort((a, b) => entryRound(a) - entryRound(b));
}

/** v3.3.1: The canonical entry for a round — its compile-time lineage entry
 *  (task_type "loop_lineage"; engine hydration merges the committed
 *  decision into it, so one round = one merged lineage entry in the
 *  compiler's view). Event/journal entries (delegation journals, gate
 *  records) share lineage.round with the round but carry none of its
 *  compile-time fields; round-level consumers that matched on the round
 *  number alone could hit them first (they sort after the lineage entry of
 *  the same round), producing an empty goal_id / task / constraints_active
 *  and forcing spurious L2 recovery. A direct :feedback entry is accepted
 *  when the caller supplies a raw committed view instead of hydration. */
function roundCanonicalEntry(entries: Entry[], round: number): Entry | null {
  const candidates = entries.filter((entry) => entryRound(entry) === round);
  return (
    candidates.find((entry) => entry.task_type === "loop_lineage") ??
    candidates.find((entry) => String(entry.task_id ?? "").endsWith(":feedback")) ??
    // Untyped compiler inputs are treated as round views, not events. Known event
    // types (delegation journals, gate records) are excluded explicitly so
    // they can never shadow a round again.
    candidates.find((entry) => {
      const type = String(entry.task_type ?? "");
      return type === "" || (!type.startsWith("delegation") && !type.endsWith("journal"));
    }) ??
    null
  );
}

export function computeGoalTextHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function deriveGoalId(loopId: string, task: string, explicit = ""): string {
  return explicit.trim() || `${loopId}:${task.trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || computeGoalTextHash(task)}`;
}

export function getPreviousRound(
  loopId: string,
  round: number,
  context: Record<string, unknown> | null,
): PreviousRound | null {
  const entry = roundCanonicalEntry(loopEntries(loopId, context), round);
  if (!entry) return null;
  const data = entryLineage(entry);
  return {
    round,
    goal_id: typeof data.goal_id === "string" ? data.goal_id : "",
    goal_text_hash: typeof data.goal_text_hash === "string" ? data.goal_text_hash : "",
    success: typeof entry.success === "boolean"
      ? entry.success
      : typeof data.success === "boolean" ? data.success : false,
    task: typeof data.task === "string"
      ? data.task
      : typeof entry.task === "string" ? entry.task : "",
    constraints_active: Array.isArray(data.constraints_active)
      ? data.constraints_active.filter((value): value is string => typeof value === "string")
      : [],
    output_summary: typeof entry.output_summary === "string"
      ? entry.output_summary
      : typeof data.output_summary === "string" ? data.output_summary : "",
  };
}

function latestObjective(
  loopId: string,
  context: Record<string, unknown> | null,
  /** Exclusive compile-round bound. A deep-restore redo must never read the
   *  abandoned branch's objective (and its rolled-back refinements). */
  beforeRound: number,
  /** v3.9.4: a round-1 same-round retry has no earlier committed objective.
   *  Reading the prior compile of the SAME round recovers the initial
   *  criteria supplied to `loopforge_start`. It is never enabled for a first
   *  attempt or for later rounds, so it cannot read an abandoned branch. */
  includeRoundOne = false,
): LoopObjective | null {
  const candidates = loopEntries(loopId, context)
    .filter((entry) => {
      const round = entryRound(entry);
      return round >= 1 && (round < beforeRound || (includeRoundOne && round === 1));
    })
    .reverse();
  for (const entry of candidates) {
    const raw = entry.loop_objective;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const value = raw as Entry;
    return makeLoopObjective({
      objective: typeof value.objective === "string" ? value.objective : "",
      success_criteria: Array.isArray(value.success_criteria)
        ? value.success_criteria.filter((item): item is string => typeof item === "string")
        : [],
      hard_constraints: Array.isArray(value.hard_constraints)
        ? value.hard_constraints.filter((item): item is string => typeof item === "string")
        : [],
      created_at_round: typeof value.created_at_round === "number" ? value.created_at_round : 1,
      loop_id: loopId,
      version: typeof value.version === "number" ? value.version : 1,
      refinement_history: Array.isArray(value.refinement_history)
        ? value.refinement_history.filter((item): item is string => typeof item === "string")
        : [],
    });
  }
  return null;
}

function evolveObjective(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
  previous: PreviousRoundFacts,
): LoopObjective {
  const current = request.loop_objective ??
    latestObjective(
      request.loop_id,
      context,
      request.round,
      request.round === 1 && (request.attempt ?? 1) > 1,
    ) ??
    makeLoopObjective({
      objective: request.task,
      success_criteria: ["Task goal achieved with verifiable evidence"],
      hard_constraints: unique(request.constraints_from_plan),
      created_at_round: 1,
      loop_id: request.loop_id,
    });
  const last = previous.result;
  const history = [...(current.refinement_history ?? [])];
  let objective = current.objective || request.task;
  let version = current.version ?? 1;
  if (last?.objective_refinement?.trim()) {
    const refinement = last.objective_refinement.trim();
    // M5: fold each refinement exactly once per persisted objective state.
    // A retry recompiles the same round against the same committed
    // previous-round projection; without this guard every retry attempt
    // re-appends the refinement and inflates the version — the objective text
    // and the state file grew "Refinement: X" once per attempt.
    if (!history.includes(refinement)) {
      history.push(refinement);
      objective = `${objective}\nRefinement: ${refinement}`;
      version++;
    }
  }
  const revisions = new Map(
    (last?.revised_success_criteria ?? []).map((item) => [item.old, item.new]),
  );
  return makeLoopObjective({
    ...current,
    objective,
    version,
    refinement_history: history.slice(-getPolicy().evolution.max_objective_versions),
    // v3.9.4: one normalized-exact text, one cr-* identity. `unique` was
    // trim-only, so case/whitespace variants survived as two entries that
    // derived to the SAME criterion id.
    success_criteria: uniqueNormalized(
      current.success_criteria
        .filter((item): item is string => typeof item === "string")
        .map((item) => revisions.get(item) ?? item),
    ),
    hard_constraints: uniqueNormalized(current.hard_constraints),
    loop_id: request.loop_id,
  });
}

function evolveConstraints(
  request: LoopCompileRequest,
  objective: LoopObjective,
  previous: PreviousRoundFacts,
  windowRounds: ReadonlyArray<CommittedRoundView>,
): { active: string[]; retired: string[] } {
  const retired = unique(previous.result?.retracted_constraints ?? []);
  // v3.9.4: a revised-away criterion text is no longer an objective criterion.
  // It must not survive as a "discovered" active constraint just because the
  // previous round's active set carried it. This is a merge-time suppression,
  // not an alias and not a constraint retirement.
  const revisedAway = unique(
    (previous.result?.revised_success_criteria ?? []).map((item) => item.old),
  );
  const immediateRetired = new Set(
    [...retired, ...revisedAway].map((text) => normalizeText(text)),
  );
  const discovered = unique(previous.result?.discovered_constraints ?? [])
    .slice(0, getPolicy().evolution.max_discovered_constraints_per_round);
  // v2.14: agent-declared retractions of plan/hard/criteria constraints
  // persist for constraints.retire_window rounds (they are re-merged from
  // the request/objective every round, so without this the documented
  // "Removed from the active constraint set" never held for them). The
  // retraction rounds are derived from the SAME committed window as every
  // other compile fact — an abandoned branch above the compile round can
  // never suppress a constraint on the restored branch.
  const window = getPolicy().constraints.retire_window;
  const lastRetractedRound = new Map<string, number>();
  if (window > 0) {
    for (const round of windowRounds) {
      const retractedList = round.retractedConstraints ?? [];
      for (const text of retractedList) {
        if (!text) continue;
        const key = normalizeText(text);
        const previousRound = lastRetractedRound.get(key);
        if (previousRound === undefined || round.round > previousRound) {
          lastRetractedRound.set(key, round.round);
        }
      }
    }
  }
  // v3.9.4: normalized-exact dedupe. The trim-only `unique` let case/space
  // variants coexist while deriving the SAME c-/cr- id. The silent
  // max_active_constraints slice is gone: every merged active constraint is
  // normative, and prompt budget pressure is reported as protectedOverflow.
  const active = uniqueNormalized([
    ...(previous.view?.activeConstraints ?? []),
    ...request.constraints_from_plan,
    ...objective.hard_constraints,
    ...objective.success_criteria,
    ...discovered,
  ]).filter((item) => {
    const key = normalizeText(item);
    if (immediateRetired.has(key)) return false;
    const retractedRound = lastRetractedRound.get(key);
    if (retractedRound !== undefined && request.round - retractedRound < window) {
      return false;
    }
    return true;
  });
  return { active, retired };
}

// ═══════════════════════════════════════════════════════════════════════════
// Hierarchical Summary (v2.1)
// ═══════════════════════════════════════════════════════════════════════════

/** v3.8.1: THE recurring-fact derivation — one walk over the committed
 *  history, grouping repeated machine facts by what they are ABOUT.
 *
 *  This replaces three separate answers to "what keeps going wrong":
 *  `deriveLessons` (whole history, count >= 2, keyed by constraint text or
 *  check id), `rolling_summary.recurring_issues` (the last 5 rounds' raw
 *  violation texts, with NO threshold at all despite the name), and the L1/L2
 *  sections built on top of each. Three windows over one fact set is exactly
 *  the parallel semantics this release removes.
 *
 *  Callers FILTER this list rather than re-deriving: the state file renders
 *  the genuinely recurring set (count >= 2), the prompt renders the recent
 *  tail as Active Warnings.
 *
 *  Presentation only: the result never feeds enforcement. */
export function deriveRecurringFlags(
  committedRounds: ReadonlyArray<CommittedRoundView>,
): RecurringFlag[] {
  const byKey = new Map<string, RecurringFlag>();
  const record = (
    kind: RecurringFlag["kind"],
    subject: string,
    ref: string,
    round: number,
  ): void => {
    const key = JSON.stringify([kind, subject, ref]);
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      if (!existing.rounds.includes(round)) existing.rounds.push(round);
      return;
    }
    byKey.set(key, { subject, kind, ref, count: 1, rounds: [round] });
  };
  for (const round of committedRounds) {
    for (const text of round.constraintViolations ?? []) {
      record("constraint_violation", text, "", round.round);
    }
    for (const flag of round.verificationFlags) {
      const kind: RecurringFlag["kind"] | null = flag.severity === "error"
        ? "verification_error"
        : flag.severity === "warn" ? "verification_warning" : null;
      if (!kind) continue;
      record(kind, flag.check, flag.ref ?? "", round.round);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    b.count - a.count ||
    a.subject.localeCompare(b.subject) ||
    a.ref.localeCompare(b.ref));
}

/** v3.3: Machine git-motion cross-check over the last 3 committed rounds
 *  (the R4 window). Undefined when no committed rounds carry git snapshots
 *  — the dashboard then shows no machine row. Display-only companion to the
 *  R4/R5 exculpatory signal. */
function deriveMachineStatus(
  rounds: ReadonlyArray<CommittedRoundView>,
  currentRound: number,
): MachineStatus | undefined {
  const series = machineGitMotionSeries(rounds, currentRound, 3);
  if (series === null) return undefined;
  const motionRounds = series.filter(Boolean).length;
  return { windowRounds: 3, gitMotion: motionRounds > 0, motionRounds };
}

/** v3.2: Derive per-criterion status — the "goal → criteria → evidence"
 *  vertical view. Each objective criterion gets: met/remaining/unknown
 *  (from per-round criterion_claims, ID-first or normalized-exact matching),
 *  the round it was first reported met, and the sub-goals a contract item
 *  referencing it also names (explicit `subgoal_refs`, never a text guess).
 *  Zero persistence — re-derived from the vault every compile. */
export function deriveCriterionStatuses(
  loopId: string,
  context: Record<string, unknown> | null,
  objective: LoopObjective | null,
  currentRound: number,
  lastRoundResult?: LoopRoundResult | null,
  /** v3.8.1: the criterion machine facts from the shared bundle. A criterion
   *  is `verified` / `contradicted` / `insufficient` only through an item that
   *  references it — a claim alone can never reach `verified` — and the fact
   *  is derived over the WHOLE committed history, so it survives its contract
   *  closing (see `deriveCriterionFacts`). */
  criterionFacts: ReadonlyArray<CriterionMachineFact> = [],
): CriterionStatus[] {
  if (!objective || objective.success_criteria.length === 0) return [];
  const entries = loopEntries(loopId, context).filter(
    (entry) => entryRound(entry) >= 1 && entryRound(entry) < currentRound,
  );
  // The previous round's report, resolved from the committed view (or the
  // library fallback), is treated as the report for round currentRound - 1.
  const lastEv = lastRoundResult?.execution_report;
  const lastMet = claimedMetCriteria(lastEv);
  const lastRemaining = claimedRemainingCriteria(lastEv);
  const lastEntry = entries[entries.length - 1] ?? null;
  const lastEntryRemaining = lastEntry ? entryCriteriaRemaining(lastEntry) : [];
  // v3.8.1: criterion → machine status + explicit sub-goal links, from the
  // shared `RoundFacts` bundle (whole committed history). It used to be
  // re-derived here from the ACTIVE contract, which made both maps empty the
  // moment the contract closed — the criterion's machine fact, and the
  // sub-goal links carried on the same item, disappeared while the sub-goal
  // side of the very same fact survived. One derivation, one window.
  const factsByCriterion = new Map(
    criterionFacts.map((fact) => [fact.criterion_id, fact] as const),
  );

  // v3.9.4: one row per derived id. The objective is authored text; a case or
  // whitespace variant derives the same cr-* and must not produce a second
  // row (nor a second contract reference space).
  const seenIds = new Set<string>();
  const statuses: CriterionStatus[] = [];
  for (const text of objective.success_criteria) {
    const id = deriveCriterionId(text);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    let metAtRound: number | null = null;
    for (const entry of entries) {
      const rnd = entryRound(entry);
      if (entryCriteriaMet(entry).some((met) => criteriaMatch(met, text))) {
        metAtRound = rnd;
        break; // first report wins — chronological scan
      }
    }
    if (metAtRound === null && lastMet.some((met) => criteriaMatch(met, text))) {
      metAtRound = currentRound - 1;
    }
    // v3.8: a claim reaches `claimed` at most. Only a machine fact about a
    // contract item that references this criterion can go further.
    const claimedStatus: CriterionStatus["status"] = metAtRound !== null
      ? "claimed"
      : lastRemaining.some((remaining) => criteriaMatch(remaining, text)) ||
        lastEntryRemaining.some((remaining) => criteriaMatch(remaining, text))
        ? "remaining"
        : "unknown";
    const fact = factsByCriterion.get(id);
    const status: CriterionStatus["status"] = fact?.status ?? claimedStatus;
    statuses.push({
      id,
      text,
      status,
      ...(metAtRound !== null ? { met_at_round: metAtRound } : {}),
      // v3.8.1: explicit refs only — empty when no contract item links this
      // criterion to a sub-goal.
      related_subgoal_ids: fact?.related_subgoal_ids ?? [],
    });
  }
  return statuses;
}

/** v3.8: Rank item statuses so the strongest machine fact wins when several
 *  items reference the same criterion. */
/** Match two criterion references. If either is a criterion id
 *  (cr-XXXXXXXX), compares ids; otherwise requires the two texts to be
 *  EXACTLY equal after normalization (v3.8.1 — the similarity fallback is
 *  gone, so a paraphrase is a different criterion). */
export function criteriaMatch(a: string, b: string): boolean {
  // v3.9.2: ONE identity rule, shared with the prompt and submission boundary.
  return criterionRefMatches(a, b);
}

/** Detect newly met criteria by comparing the current entry's
 *  met criterion_claims against the previous entry's.
 *  v2.11/v3.8.1: id-first (cr-XXXXXXXX), then normalized-exact text —
 *  no similarity.
 *  Returns empty array when there is no previous entry — the first
 *  entry's criteria are the baseline, not a "new" event. */
function detectNewCriteria(current: Entry, previous: Entry | null): string[] {
  const currMet = entryCriteriaMet(current);
  if (currMet.length === 0) return [];
  if (!previous) {
    // First round with criteria is the baseline — not a milestone trigger.
    return [];
  }
  const prevMet = entryCriteriaMet(previous);
  if (prevMet.length === 0) return currMet;
  return currMet.filter((curr) =>
    prevMet.every((prev) => !criteriaMatch(curr, prev)),
  );
}

/** Build a single MilestoneSummary from a range of completed round entries. */
function buildMilestoneFromEntries(
  phaseEntries: Entry[],
  startRound: number,
  endRound: number,
  label: string,
  kind: MilestoneSummary["kind"],
): MilestoneSummary {
  const last = phaseEntries.at(-1);
  const lastView = last ? decodeRound(last) : null;
  const outcomeRaw = lastView
    ? (lastView.outputSummary ?? "")
    : last && typeof last.output_summary === "string" ? last.output_summary : "";
  const outcomeMax = getPolicy().checkpoint.outcome_max_chars;
  const outcome = outcomeRaw.length > outcomeMax
    ? outcomeRaw.slice(0, outcomeMax) + "…"
    : outcomeRaw;

  const carried = last ? entryActiveConstraints(last) : [];
  const resolved = unique(
    phaseEntries.flatMap((e) => entryRetractedConstraints(e)),
  );

  return makeMilestoneSummary({
    label,
    round_range: { start: startRound, end: endRound },
    outcome,
    carried_constraints: carried,
    resolved_constraints: resolved,
    kind,
    generated_at_round: endRound,
  });
}

/** v3.8.1: the milestone history bound. Applied identically at every prompt
 *  level and in the state file, so the milestone set is a function of
 *  committed facts rather than of which level happened to compile. (The
 *  v3.0.1 sampler chose which milestones to keep from an UNBOUNDED list and
 *  did nothing at L2 — so the state file’s phase history depended on the
 *  prompt level and had no bound of its own.) */
const MILESTONE_HISTORY_CAP = 50;

export function buildRollingSummary(
  loopId: string,
  currentRound: number,
  context: Record<string, unknown> | null,
  sinceRound = 0,
): RollingSummary | null {
  const policy = getPolicy().summary;
  const allEntries = loopEntries(loopId, context);

  // ── Phase 1: Recent Window (preserves existing behavior) ──
  const windowEntries = allEntries
    .filter((entry) => {
      const round = entryRound(entry);
      return round >= sinceRound && round < currentRound;
    })
    .slice(-policy.window);
  const outcomes: string[] = [];
  for (const entry of windowEntries) {
    const view = decodeRound(entry);
    const data = entryLineage(entry);
    const round = entryRound(entry);
    const success = view ? view.success : entry.success ?? data.success;
    const summary = view
      ? view.outputSummary ?? ""
      : typeof entry.output_summary === "string"
        ? entry.output_summary
        : typeof data.output_summary === "string" ? data.output_summary : "";
    // v2.12: Declared outcome wins the label; the default wording stays
    // "accepted" for zero regression on existing loop output.
    const declared = view ? view.outcome : entry.outcome;
    const outcomeLabel = declared === "success" || declared === "partial" ||
      declared === "failed" || declared === "blocked"
      ? declared
      : success === false ? "failed" : "accepted";
    if (summary) outcomes.push(`[R${round}] ${outcomeLabel}: ${summary}`);
  }

  // ── Phase 2: Milestone Accumulation ──
  // Scan all completed entries in round order. For each entry, check three
  // trigger signals in priority order: agent_declared > criteria_milestone > auto.
  const completedEntries = allEntries.filter(
    (entry) => entryRound(entry) >= 1 && entryRound(entry) < currentRound,
  );

  const milestones: MilestoneSummary[] = [];
  let lastMilestoneRound = 0;

  for (let i = 0; i < completedEntries.length; i++) {
    const entry = completedEntries[i];
    const rnd = entryRound(entry);
    const lin = entryLineage(entry);

    // Signal 1: Agent-declared checkpoint
    const isAgentCheckpoint = lin.compression_checkpoint === true;

    // Signal 2: New criteria met (compare with previous vault entry)
    const prev = i > 0 ? completedEntries[i - 1] : null;
    const newCriteria = detectNewCriteria(entry, prev);

    if (isAgentCheckpoint || newCriteria.length > 0) {
      const startRound = lastMilestoneRound + 1;
      const phaseEntries = completedEntries.filter(
        (e) => {
          const er = entryRound(e);
          return er >= startRound && er <= rnd;
        },
      );

      const kind: MilestoneSummary["kind"] = isAgentCheckpoint
        ? "agent_declared"
        : "criteria_milestone";

      const label = isAgentCheckpoint
        ? (typeof lin.checkpoint_label === "string" && lin.checkpoint_label.trim()
            ? lin.checkpoint_label.trim()
            : `Round ${rnd}`)
        : `Completed: ${newCriteria.join(", ")}`;

      milestones.push(
        buildMilestoneFromEntries(phaseEntries, startRound, rnd, label, kind),
      );
      lastMilestoneRound = rnd;
    }
  }

  // Signal 3: Safety net — auto milestone when gap exceeds milestone_interval.
  // v3.3.1: the policy contract (milestone_interval: "only fires when no
  // agent_declared or criteria_milestone has been created for this many
  // rounds") includes loops that NEVER created a milestone — but the guard
  // `lastMilestoneRound > 0` made the gap start from the (nonexistent) first
  // milestone, so a checkpoint-less loop could run forever with an empty
  // Phase History and no memory skeleton. With lastMilestoneRound == 0 the
  // gap is measured from round 1 and the safety net fires from the very
  // first interval.
  const gapSinceLast = (currentRound - 1) - lastMilestoneRound;
  if (
    gapSinceLast >= policy.milestone_interval &&
    completedEntries.length > 0
  ) {
    const startRound = lastMilestoneRound + 1;
    const endRound = currentRound - 1;
    const phaseEntries = completedEntries.filter(
      (e) => {
        const er = entryRound(e);
        return er >= startRound && er <= endRound;
      },
    );
    if (phaseEntries.length > 0) {
      milestones.push(
        buildMilestoneFromEntries(
          phaseEntries,
          startRound,
          endRound,
          `Rounds ${startRound}–${endRound}`,
          "auto",
        ),
      );
    }
  }

  // v3.8.1: one bound, applied identically at every prompt level. The v3.0.1
  // sampler kept head anchors + a newest tail + an even middle sample, and
  // deliberately did nothing at L2 — so the milestone set written to the state
  // file depended on which level happened to compile, not on committed facts.
  // It also did not bound growth at all (it only chose WHICH milestones to
  // keep from an unbounded list), which is why the cap has to live here.
  const cappedMilestones = milestones.slice(-MILESTONE_HISTORY_CAP);

  if (windowEntries.length === 0 && cappedMilestones.length === 0) return null;

  return makeRollingSummary({
    key_outcomes: unique(outcomes),
    rounds_sampled: windowEntries.length,
    generated_at_round: currentRound,
    failed_patterns: [],
    milestones: cappedMilestones,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Sub-Goal Structured Tracking (v2.2)
// ═══════════════════════════════════════════════════════════════════════════

/** v2.11: Derive a stable constraint ID from its text hash (c-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
export function deriveConstraintId(text: string): string {
  return "c-" + deriveItemId(text);
}

// v3.8.1: `deriveCriterionId` / `isCriterionId` moved to token-utils.ts, where
// the other stable-id helpers live — the criterion fact derivation in
// round-facts.ts needs them, and defining them here would make
// round-facts ⇄ loop-compiler an import cycle. Re-exported so this module's
// public surface ("./compiler") is unchanged.
export { deriveCriterionId, isCriterionId } from "./token-utils.js";


// ═══════════════════════════════════════════════════════════════════════════
// Time-Aware Constraint Management (v2.3)
// ═══════════════════════════════════════════════════════════════════════════

/** Determine the source of a constraint by matching against known sources. */
function constraintSource(
  text: string,
  objective: LoopObjective,
  constraintsFromPlan: string[],
): "hard" | "plan" | "criteria" | "discovered" {
  const norm = normalizeText(text);
  // v3.9.4: criteria identity wins. A text that is both a criterion and a
  // hard/plan constraint keeps its cr-* id everywhere; the prompt partition
  // renders it once, in the criteria section.
  if (objective.success_criteria.some((c) => normalizeText(c) === norm)) return "criteria";
  if (objective.hard_constraints.some((c) => normalizeText(c) === norm)) return "hard";
  if (constraintsFromPlan.some((c) => normalizeText(c) === norm)) return "plan";
  return "discovered";
}

/** True when a reported violation text matches a constraint text.
 *  v2.11: ID-first — an exact `c-XXXXXXXX` match against the derived id.
 *  v3.8.1: the Jaccard fallback is gone; the remaining arm requires the
 *  reported text to be EXACTLY equal to the constraint after normalization,
 *  so a reported violation can no longer attach itself to a constraint it
 *  merely resembles. */
function matchesConstraintText(text: string, violation: string): boolean {
  const targetId = deriveConstraintId(text);
  if (violation === targetId || deriveConstraintId(violation) === targetId) {
    return true;
  }
  return normalizeText(text) === normalizeText(violation);
}

function findLastViolatedRound(
  text: string,
  vaultEntries: Entry[],
): number {
  let latest = 0;
  for (const entry of vaultEntries) {
    const rnd = entryRound(entry);
    if (rnd < 1) continue;
    const view = decodeRound(entry);
    const violations = view
      ? view.constraintViolations ?? []
      : Array.isArray(entry.constraint_violations)
        ? entry.constraint_violations.filter((v: unknown) => typeof v === "string")
        : [];
    for (const v of violations) {
      if (matchesConstraintText(text, v)) {
        if (rnd > latest) latest = rnd;
        break;
      }
    }
  }
  return latest;
}

/**
 * Manage constraint lifecycle metadata for the active set.
 *
 * v3.7: the v2.3 time-aware decay (discovered constraints demoted to
 * inactive after N quiet rounds, auto-reactivation on a fresh violation)
 * is gone — every active constraint stays active. What remains is the
 * display metadata the v3 prompt surface needs: per-text source
 * classification (v3.3.1: criteria texts carry the cr-XXXXXXXX namespace),
 * and last_violated_at_round for the L1 collapse "(violated this round)"
 * annotation (diffConstraints compares it to the current round).
 */
function manageConstraintLifecycle(
  active: string[],
  objective: LoopObjective,
  constraintsFromPlan: string[],
  vaultContext: Record<string, unknown> | null,
  currentRound: number,
  lastRoundViolations: string[] = [],
): { active: string[]; metadata: ConstraintMeta[] } {
  const allEntries = loopEntries(
    objective.loop_id || "",
    vaultContext,
  );
  const completedEntries = allEntries.filter(
    (e) => entryRound(e) >= 1 && entryRound(e) < currentRound,
  );

  const metadata: ConstraintMeta[] = [];

  for (const text of active) {
    const source = constraintSource(text, objective, constraintsFromPlan);

    // v3.2.1: a violation reported in THIS round (last_round_result) counts
    // as a violation at currentRound — the previous rounds' scan cannot see
    // it (this round is not committed yet). This makes the L1 collapse
    // render "(violated this round)" (diffConstraints compares
    // last_violated_at_round === round).
    const violatedThisRound = lastRoundViolations.some((v) =>
      matchesConstraintText(text, v));

    // v3.3.1: one text, one identity — a success-criterion text that also
    // lives in the merged active set belongs to the cr-XXXXXXXX namespace
    // (its own Success Criteria section and the verification gate's
    // criteriaMatch are ID-first on cr-). Rendering it under c-XXXXXXXX in
    // the active list meant the same text carried two IDs in one prompt,
    // and an agent echoing the active-list ID into its criterion claims
    // could never match.
    metadata.push(makeConstraintMeta({
      id: source === "criteria" ? deriveCriterionId(text) : deriveConstraintId(text),
      text,
      last_violated_at_round: violatedThisRound
        ? currentRound
        : findLastViolatedRound(text, completedEntries),
      source,
    }));
  }

  return { active, metadata };
}

/** Resolve the ONE previous-round fact bundle for a compile.
 *
 *  The committed view wins whenever a round is committed. `last_round_result`
 *  is only the caller's in-flight projection for engine/library callers with
 *  no committed round in the context. In-flight attempt findings are
 *  authoritative even when empty: a retry must never inherit the previous
 *  committed round's flags. */
function resolvePreviousRoundFacts(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
  windowRounds?: ReadonlyArray<CommittedRoundView>,
): PreviousRoundFacts {
  const rounds = windowRounds ??
    derivationRounds(loopEntries(request.loop_id, context), request.round);
  const view = rounds.find((round) => round.round === request.round - 1) ?? null;
  const recoveryBoundary =
    pendingBacktrackRecord(loopEntries(request.loop_id, context), request.round) !== null;
  const inFlight = (request.attempt ?? 1) > 1 || recoveryBoundary;
  return {
    view,
    result: view
      ? roundResultFromCommittedRound(view)
      : request.last_round_result,
    verificationFlags: inFlight
      ? (request.verification_flags ?? [])
      : (view?.verificationFlags ?? request.verification_flags ?? []),
    freshness: view ? derivePromptFreshness(view) : UNKNOWN_PROMPT_FRESHNESS,
    recoveryBoundary,
  };
}

function levelDecision(
  request: LoopCompileRequest,
  prior: PreviousRound | null,
  previous: PreviousRoundFacts,
): PromptLevelDecision {
  return decidePromptLevel({
    round: request.round,
    attempt: request.attempt,
    forceLevel: request.force_level,
    hasPlanSource: Boolean(request.plan_source),
    recoveryBoundary: previous.recoveryBoundary,
    checkpointBoundary: previous.result?.compression_checkpoint === true,
    // An empty goal_id is unobservable, not a goal change: never fabricate L2.
    goalChanged: prior !== null && prior.goal_id !== "" &&
      prior.goal_id !== deriveGoalId(request.loop_id, request.task, request.goal_id),
    previousStateMissing: request.round > 1 && prior === null,
    previousRoundFailed: previous.view
      ? previous.view.success === false
      : previous.result?.success === false,
    previousRoundObservableNewInformation: previous.view
      ? previous.freshness.observableNewInformation
      : null,
    verificationContradicted: previous.verificationFlags
      .some((flag) => flag.severity === "error"),
    consecutiveRejections: request.consecutive_rejections,
  });
}

export function decideLevel(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): "l0" | "l1" | "l2" {
  const prior = getPreviousRound(request.loop_id, request.round - 1, context);
  return levelDecision(request, prior, resolvePreviousRoundFacts(request, context)).level;
}

/** The prompt's evaluation block. All content (examples, contract/sub-goal
 *  guidance, flag-specific hints) comes from the one FIELD_GUIDES table in
 *  submission-guidance.ts; this function owns no second copy. */
export function buildSelfEvalBlock(ctx: SelfEvalPromptContext): string {
  return renderSelfEvalBlock(ctx);
}

// v2.5: checkpoint() removed — agent_declared milestones from
// compression_checkpoint supersede the separate CheckpointSummary.
// See buildRollingSummary() signal 1.

/** v3.7.1: Derived Recovery Brief for the state-file Recent tier. Present
 *  ONLY while a committed backtrack decision is the current round's record
 *  (the recovery window); the redo commit replaces that record, so the
 *  brief exits the projection by construction. Sources are the committed
 *  rollback decision's own fields — no new persistence, no rejected
 *  payloads. */
function committedBacktrackBrief(
  loopId: string,
  round: number,
  context: Record<string, unknown> | null,
): string[] | undefined {
  // The SAME pending-backtrack lookup the recovery boundary uses: a deep
  // restore commits at the failed round while its redo targets
  // `backtrackTarget + 1`, so an exact-round match loses both the boundary
  // and this brief.
  const view = pendingBacktrackRecord(loopEntries(loopId, context), round);
  const record = view?.backtrack;
  if (!record) return undefined;
  const lines = recoveryBriefLines({
    target: record.target,
    triggerRule: record.triggerRule,
    // The committed decision's own sentence — the machine's reason for the
    // rollback, preserved as a fact (the old prose header's "Why" content).
    ...(typeof view?.result?.enforcementReason === "string" &&
        view.result.enforcementReason.trim()
      ? { failureReason: view.result.enforcementReason }
      : {}),
    failedRounds: record.failedRounds,
    approaches: record.approaches,
    wrongAssumptions: record.wrongAssumptions,
    // The redo round's stable identity is a fact the old prepended prose
    // carried; keep it inside the artifact now.
    recoveryRoundId: `loop:${loopId}:round:${record.target + 1}`,
  });
  // v3.9.4: the restore point's machine facts belong in the prompt, not only
  // in the prose backtrack header. Deterministic order and a visible overflow
  // count keep the fact complete without making the section unbounded.
  if (record.targetGitHead) {
    lines.push(`- **Restore HEAD**: \`${record.targetGitHead}\``);
  }
  if (record.skippedFiles.length > 0) {
    const files = [...record.skippedFiles].sort();
    const shown = files.slice(0, 15);
    lines.push("- **Files changed in failed rounds**:");
    for (const file of shown) lines.push(`  - \`${file}\``);
    if (files.length > shown.length) {
      lines.push(`  - … and ${files.length - shown.length} more files`);
    }
  }
  // The machine requirement the recovery checkpoint enforces. A fact, not a
  // recipe: LoopForge never says HOW to restore the workspace.
  if (record.targetGitHead || record.skippedFiles.length > 0) {
    lines.push(
      `- **Restore requirement**: the next submission's workspace is checked ` +
      `against round ${record.target}` +
      (record.targetGitHead ? ` (HEAD \`${record.targetGitHead}\`)` : "") +
      "; a leftover change from the failed rounds rejects the recovery checkpoint.",
    );
  }
  return lines;
}

export function compileLoop(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): LoopCompileResponse {
  // ONE history window and ONE previous-round fact bundle for the whole
  // compile. Every consumer below reads these values; none re-reads the
  // caller's mutable last_round_result.
  const windowRounds = derivationRounds(
    loopEntries(request.loop_id, context),
    request.round,
  );
  const prior = getPreviousRound(request.loop_id, request.round - 1, context);
  const previous = resolvePreviousRoundFacts(request, context, windowRounds);
  const decision = levelDecision(request, prior, previous);
  const objective = evolveObjective(request, context, previous);
  const constraints = evolveConstraints(
    request,
    objective,
    previous,
    windowRounds,
  );
  const constraintLifecycle = manageConstraintLifecycle(
    constraints.active,
    objective,
    request.constraints_from_plan,
    context,
    request.round,
    // "Violated this round" means the CURRENT compile round's report. A
    // committed previous round's violations are found by the committed
    // history scan at their real round, not relabelled as this round.
    previous.view ? [] : (request.last_round_result?.constraint_violations ?? []),
  );
  const rolling = buildRollingSummary(request.loop_id, request.round, context, 0);
  // v3.8: sub-goal lifecycle lives in subgoal-state.ts and consumes the
  // shared committed-round view — one history interpretation. The previous
  // round's report is idempotently replayed; a committed round is already in
  // the window, while the library fallback has no view.
  const subGoals = deriveSubGoals({
    loopId: request.loop_id,
    currentRound: request.round,
    rounds: windowRounds,
    currentReport: previous.result
      ? {
          round: previous.result.round || (request.round - 1),
          emergedSubtasks: previous.result.emerged_subtasks ?? [],
          subgoalUpdates: previous.result.subgoal_updates ?? [],
        }
      : null,
  });
  // v3.4/v3.8/v3.8.1: the ACTIVE Round Contract, its per-item statuses and the
  // verified sub-goal facts for this compile — ONE `deriveRoundFacts` call,
  // the same bundle the projection consumes. Derived from committed rounds, so
  // rejection retries, resume, unpause and backtrack compiles (which carry no
  // last_round_result) keep showing the same contract, and a verified or
  // blocked contract stops being shown. A verified item stays proven after its
  // contract closes because the bundle reads the whole history, not the active
  // contract. The compile path has no in-flight observations of its own.
  const roundFacts = deriveRoundFacts({
    rounds: windowRounds,
    currentRound: request.round,
    inFlight: NO_IN_FLIGHT_ROUND,
    subGoals,
    commands: getPolicy().evidence.commands ?? [],
  });
  // `roundFacts.verifiedSubGoals` is not read here — it reaches the state file
  // and the projection through the bundle itself.
  const { activeContract } = roundFacts;
  // v3.9.4: the criterion reference space is the ACTIVE criterion set, not
  // every text the objective ever carried. A retracted criterion must not be
  // claimable or contract-referenceable while the prompt does not render it.
  const activeConstraintKeys = new Set(
    constraintLifecycle.active.map((text) => normalizeText(text)),
  );
  const activeCriteria = uniqueNormalized(objective.success_criteria)
    .filter((text) => activeConstraintKeys.has(normalizeText(text)));
  const criterionObjective: LoopObjective = {
    ...objective,
    success_criteria: activeCriteria,
  };
  // v3.2: Goal → criteria → evidence vertical view (derived, zero persistence).
  const criterionStatuses = deriveCriterionStatuses(
    request.loop_id,
    context,
    criterionObjective,
    request.round,
    previous.result,
    roundFacts.criterionFacts,
  );
  // v3.8.1: the ONE recurring-fact derivation, over the shared window. The
  // prompt renders its recent tail; the state file renders the recurring set.
  const recurringFlags = deriveRecurringFlags(windowRounds);
  // v3.8.1: a same-round exact repeat is the only sub-goal duplication the
  // runtime can state as a fact — those entries really were dropped, so the
  // agent is told. The cross-round near-duplicate similarity diagnostic is
  // gone with the rest of the fuzzy matching, and so are the task-alignment
  // and loop-health warnings: both were Jaccard scores over task/objective
  // text, never machine facts.
  // v3.9.5: only committed declarations are history. A library fallback is
  // in-flight and must not manufacture a prompt warning.
  const repeatedDeclarations = previous.view
    ? duplicateEmergedDeclarations(previous.view.emergedSubtasks ?? [])
    : [];
  const warnings = unique([
    repeatedDeclarations.length > 0
      ? `duplicate_declaration: ${repeatedDeclarations.length} sub-goal ` +
        `declaration(s) repeated an earlier entry in the same round and were ` +
        `not created: ${repeatedDeclarations.join("; ")}`
      : "",
  ]);

  // v3.8.1: the agent trust score and trend are deleted. The score was
  // `1 - errors*0.15 - warns*0.03` — arbitrary weights with no machine
  // meaning, re-encoding flag counts that are already visible. The trend was
  // worse: `1 - violations*0.1` per round, computed from
  // `constraint_violations`, i.e. a DIFFERENT source from the score it was
  // displayed next to. "Trend" was therefore not the score's history at all.
  // Neither fed a decision.
  // v3.3/v3.8.1: machine git-motion (display-only, derived). The per-round
  // "round stats" table is deleted: its only renderer was the L2 prompt
  // section removed above, so it was computed, put into the canonical state
  // (and therefore into stateHash) and read by nothing. `windowRounds` is the
  // ONE window computed at the top of this function.
  const machineStatus = deriveMachineStatus(windowRounds, request.round);

  const response = makeLoopCompileResponse({
    status: AgentStatus.OK,
    recompile_level: decision.level,
    diff_from_previous: decision.reasons.join(","),
    lineage: [`${request.loop_id}:r${request.round}`],
    constraints_active: constraintLifecycle.active,
    constraints_retired: constraints.retired,
    constraint_metadata: constraintLifecycle.metadata,
    loop_id: request.loop_id,
    round: request.round,
    goal_id: deriveGoalId(request.loop_id, request.task, request.goal_id),
    goal_text_hash: computeGoalTextHash(request.task),
    loop_objective: objective,
    rolling_summary: rolling,
    sub_goals: subGoals,
    criterion_statuses: criterionStatuses,
    recurring_flags: recurringFlags,
    plan_source: request.plan_source,
    warnings,
  });
  const policy = getPolicy();
  // L7 (v3.7.x): the state-file path is empty when the file is disabled —
  // prompts must never point at (or collapse content behind) a file that
  // writeStateFile will not create. An empty path propagates into the
  // assembler's pointer lines and the L1 collapse gate below.
  const statePath = policy.state_file.enabled
    ? `${policy.state_file.directory}/${request.loop_id}-state.md`
    : "";
  const state = createCanonicalLoopState(request, response, statePath, {
    machineStatus,
    // v3.4/v3.8.1: the contract-fact bundle — the Current Task's source of
    // truth, its verification view and the machine-verified sub-goal facts as
    // ONE derivation. The static capability rides on the state itself.
    roundFacts,
    // 3.9.3: the same previous-round bundle the level decision used. This is
    // what keeps corrections/blockers/remaining/progress identical on live,
    // resume, and unpause compiles.
    // v3.9.5: the committed flag is what keeps a caller fallback out of the
    // prompt/state narrative.
    previousRound: { ...previous, committed: previous.view !== null },
  });
  // The recovery brief is a current-round fact, computed once and shared by
  // the state file and the evaluation block. It never becomes prompt control
  // state.
  const recoveryBrief = committedBacktrackBrief(request.loop_id, request.round, context);
  const configuredCapability = deriveConfiguredCapability(policy);
  const contractCommands = configuredCapability.commands
    .filter((command) => command.enabled)
    .map((command) => command.commandId);
  const markdown = renderCanonicalStateMarkdown(state, {
    // v3.7.1: retry attempts are marked in the derived view (attempt is
    // request context, not a committed fact). The Recovery Brief renders in
    // the Recent tier only while a committed backtrack decision is this
    // round's record; the redo commit removes it by construction.
    attempt: request.attempt,
    recoveryBrief,
  });

  // v3.8.1: the L2 budget is a FIXED ceiling. The v2.4 adaptive budget
  // scaled it by round count, milestone count and sub-goal count, which made
  // the prompt's allowed content depend on how long the loop had been running
  // rather than on the facts of this round — the same loop could render a
  // section at round 5 and silently drop it at round 50.
  //
  // v3.9.5: L2 never embeds the monolithic state markdown. The prompt is a
  // current-governance projection; full history stays in the optional state
  // file / replay / audit.
  const artifact = assemblePromptArtifact({
    state,
    level: decision.level,
    reasons: decision.reasons,
    budgets: {
      l0: policy.prompt.l0_max_chars,
      l1: policy.prompt.l1_max_chars,
      l2: policy.prompt.l2_max_chars,
    },
    attempt: request.attempt,
    selfEvaluationBlock: buildSelfEvalBlock({
      round: request.round,
      level: decision.level,
      activeContract,
      itemStatuses: roundFacts.itemStatuses,
      commands: contractCommands,
      contractVerificationAvailable: configuredCapability.contractVerificationAvailable,
      subGoals,
      verificationFlags: previous.verificationFlags,
      recovery: recoveryBrief !== undefined,
      gateEnabled: policy.gate.enabled === true,
      criteria: criterionStatuses,
      currentRequirement: state.currentTask,
    }),
    // v3.9.4: the SAME committed-backtrack facts the state file renders. The
    // recovery section is part of the artifact, so the delivered prompt is
    // exactly `artifact.renderedPrompt` (no post-compile prepend).
    recoveryBrief,
    // v3.9.5: prompt requests are committed facts. A library fallback
    // `last_round_result` is in-flight and must not steer the next prompt.
    promptRequests: previous.view?.evaluation?.prompt_requests,
  });
  response.prompt = artifact.renderedPrompt;
  response.prompt_artifact = artifact;
  response.state_file_content = policy.state_file.enabled ? markdown : undefined;
  return response;
}
