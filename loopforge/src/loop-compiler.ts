/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */

import { createHash } from "node:crypto";
import { getPolicy } from "./policy.js";
import type { SummaryPolicy } from "./policy.js";
import {
  AgentStatus,
  makeLoopCompileResponse,
  makeLoopObjective,
  makeConstraintMeta,
  makeMilestoneSummary,
  makeRollingSummary,
  makeSubGoal,
  type ConstraintMeta,
  type CriterionStatus,
  type RecurringFlag,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type LoopObjective,
  type LoopRoundResult,
  type MilestoneSummary,
  type RollingSummary,
  type ContractItemStatus,
  type SubGoal,
  type SubGoalUpdate,
  type VerificationFlag,
} from "./protocol.js";
import {
  createCanonicalLoopState,
  renderCanonicalStateMarkdown,
} from "./canonical-state.js";
import type { MachineStatus } from "./canonical-state.js";
import {
  decodeBacktrackRecord,
  decodeRound,
  entryLineage,
  entryExecutionReport,
  entryCriteriaMet,
  entryCriteriaRemaining,
  entryActiveConstraints,
  entryRetractedConstraints,
  entryProgressEstimate,
  entryEmergedSubtasks,
  entrySubGoalUpdates,
  type CommittedRoundView,
  machineGitMotionSeries,
  derivationRounds,
} from "./committed-round.js";
import { deriveActiveRoundContract, type ActiveContractView } from "./round-contract.js";
import { NO_IN_FLIGHT_ROUND, deriveRoundFacts } from "./round-facts.js";
import { recoveryBriefLines } from "./enforcement-gate.js";
import { deriveSubGoals, duplicateEmergedDeclarations } from "./subgoal-state.js";
import type { ContractItemStatusView } from "./contract-items.js";
import { claimedMetCriteria, claimedRemainingCriteria } from "./self-eval.js";
import { assemblePromptArtifact } from "./prompt-assembler.js";
import {
  decidePromptLevel,
  type PromptLevelDecision,
} from "./prompt-policy.js";
import { deriveItemId, STABLE_ID_RE, normalizeText, unique, entryRound, isRecord } from "./token-utils.js";

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
): LoopObjective | null {
  const candidates = loopEntries(loopId, context).reverse();
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
): LoopObjective {
  const current = request.loop_objective ?? latestObjective(request.loop_id, context) ??
    makeLoopObjective({
      objective: request.task,
      success_criteria: ["Task goal achieved with verifiable evidence"],
      hard_constraints: unique(request.constraints_from_plan),
      created_at_round: 1,
      loop_id: request.loop_id,
    });
  const last = request.last_round_result;
  const history = [...(current.refinement_history ?? [])];
  let objective = current.objective || request.task;
  let version = current.version ?? 1;
  if (last?.objective_refinement?.trim()) {
    const refinement = last.objective_refinement.trim();
    // M5: fold each refinement exactly once per persisted objective state.
    // A retry recompiles the same round against the same committed
    // last_round_result; without this guard every retry attempt re-appends
    // the refinement and inflates the version — the objective text and the
    // state file grew "Refinement: X" once per attempt.
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
    success_criteria: unique(current.success_criteria.map((item) => revisions.get(item) ?? item)),
    hard_constraints: unique(current.hard_constraints),
    loop_id: request.loop_id,
  });
}

function evolveConstraints(
  request: LoopCompileRequest,
  objective: LoopObjective,
  previous: PreviousRound | null,
  context: Record<string, unknown> | null,
): { active: string[]; retired: string[] } {
  const retired = unique(request.last_round_result?.retracted_constraints ?? []);
  const retiredSet = new Set(retired);
  const discovered = unique(request.last_round_result?.discovered_constraints ?? [])
    .slice(0, getPolicy().evolution.max_discovered_constraints_per_round);
  // v2.14: agent-declared retractions of plan/hard/criteria constraints
  // persist for constraints.retire_window rounds (they are re-merged from
  // the request/objective every round, so without this the documented
  // "Removed from the active constraint set" never held for them). The
  // retraction rounds are derived from vault entries — no new persistence
  // format. After the window the constraint returns (hard/plan/criteria
  // constraints never auto-decay — only agent action removes them, and the
  // action's memory expires).
  const window = getPolicy().constraints.retire_window;
  const lastRetractedRound = new Map<string, number>();
  if (window > 0) {
    for (const entry of loopEntries(request.loop_id, context)) {
      const retractedList = entryLineage(entry).retracted_constraints;
      if (!Array.isArray(retractedList)) continue;
      const rnd = entryRound(entry);
      for (const text of retractedList) {
        if (typeof text !== "string" || !text) continue;
        const prev = lastRetractedRound.get(text);
        if (prev === undefined || rnd > prev) lastRetractedRound.set(text, rnd);
      }
    }
  }
  const active = unique([
    ...(previous?.constraints_active ?? []),
    ...request.constraints_from_plan,
    ...objective.hard_constraints,
    ...objective.success_criteria,
    ...discovered,
  ]).filter((item) => {
    if (retiredSet.has(item)) return false;
    const retractedRound = lastRetractedRound.get(item);
    if (retractedRound !== undefined && request.round - retractedRound < window) {
      return false;
    }
    return true;
  }).slice(0, getPolicy().evolution.max_active_constraints);
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
    const key = `${kind} ${subject} ${ref}`;
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

/** v3.4: ACTIVE Round Contract for the compile round — derived from the
 *  committed evals of earlier rounds only, never from request data. Reads
 *  the hydrated merged lineage entries (one per round; a committed decision
 *  is merged onto the round's lineage entry with `committed_action` set),
 *  skipping rounds whose committed action was "backtrack" (a roll-back
 *  directive, not an executed round). Because it runs identically on every
 *  compile path — including rejection retries and resume / unpause /
 *  backtrack compiles that carry no last_round_result — a contract round's
 *  re-compiles keep showing its contract as the Current Task. Null when no
 *  active contract: the Current Task falls back to the original task text. */
function deriveActiveContract(
  loopId: string,
  context: Record<string, unknown> | null,
  currentRound: number,
): ActiveContractView | null {
  const entries = loopEntries(loopId, context);
  const canonical = Array.from({ length: Math.max(0, currentRound - 1) }, (_, index) =>
    roundCanonicalEntry(entries, index + 1),
  ).filter((entry): entry is Entry => entry !== null);
  return deriveActiveRoundContract(
    derivationRounds(canonical, currentRound),
  );
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
  subGoals: SubGoal[],
  lastRoundResult?: LoopRoundResult | null,
  /** v3.8: the ACTIVE contract and its derived item statuses. A criterion is
   *  `verified` / `contradicted` / `insufficient` only through an item that
   *  references it — a claim alone can never reach `verified`. */
  verification?: {
    activeContract: ActiveContractView | null;
    itemStatuses: ContractItemStatusView;
  },
): CriterionStatus[] {
  if (!objective || objective.success_criteria.length === 0) return [];
  const entries = loopEntries(loopId, context).filter(
    (entry) => entryRound(entry) >= 1 && entryRound(entry) < currentRound,
  );
  // The current round's report lives in last_round_result (the vault only
  // gains it on commit); treat it as the report for round currentRound - 1.
  const lastEv = lastRoundResult?.execution_report;
  const lastMet = claimedMetCriteria(lastEv);
  const lastRemaining = claimedRemainingCriteria(lastEv);
  const lastEntry = entries[entries.length - 1] ?? null;
  const lastEntryRemaining = lastEntry ? entryCriteriaRemaining(lastEntry) : [];
  // v3.8: criterion → item status, derived from the contract's item refs.
  type MachineCriterionStatus = Exclude<ContractItemStatus, "pending">;
  const itemStatusByCriterion = new Map<string, MachineCriterionStatus>();
  // v3.8.1: criterion → the sub-goals an item referencing it also names.
  // EXPLICIT refs only (`ContractItemProposal.subgoal_refs`); the former
  // Jaccard guess at "which sub-goal is this criterion about" is gone, so a
  // criterion is never linked to a sub-goal it merely resembles.
  const subGoalsByCriterion = new Map<string, string[]>();
  const activeContract = verification?.activeContract ?? null;
  if (activeContract) {
    for (const item of activeContract.items) {
      if (item.subgoal_refs.length === 0) continue;
      for (const ref of item.criterion_refs) {
        const criterionId = isCriterionId(ref) ? ref : deriveCriterionId(ref);
        const linked = subGoalsByCriterion.get(criterionId) ?? [];
        for (const subgoalId of item.subgoal_refs) {
          if (!linked.includes(subgoalId)) linked.push(subgoalId);
        }
        subGoalsByCriterion.set(criterionId, linked);
      }
    }
  }
  if (activeContract) {
    for (const item of activeContract.items) {
      const status = verification?.itemStatuses.items
        .find((entry) => entry.itemId === item.id)?.status;
      // `pending` is "no claim yet" — it says nothing about the criterion, so
      // the criterion keeps its own claim-derived status.
      if (!status || status === "pending") continue;
      for (const ref of item.criterion_refs) {
        const criterionId = isCriterionId(ref) ? ref : deriveCriterionId(ref);
        const existing = itemStatusByCriterion.get(criterionId);
        // Machine facts outrank each other by strength; a claim never
        // weakens a machine verdict about the same criterion.
        itemStatusByCriterion.set(criterionId, strongestStatus(existing, status));
      }
    }
  }

  return objective.success_criteria.map((text) => {
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
    const machineStatus = itemStatusByCriterion.get(deriveCriterionId(text));
    const status: CriterionStatus["status"] = machineStatus ?? claimedStatus;
    return {
      id: deriveCriterionId(text),
      text,
      status,
      ...(metAtRound !== null ? { met_at_round: metAtRound } : {}),
      // v3.8.1: explicit refs only — empty when no contract item links this
      // criterion to a sub-goal.
      related_subgoal_ids: subGoalsByCriterion.get(deriveCriterionId(text)) ?? [],
    };
  });
}

/** v3.8: Rank item statuses so the strongest machine fact wins when several
 *  items reference the same criterion. */
function strongestStatus(
  left: Exclude<ContractItemStatus, "pending"> | undefined,
  right: Exclude<ContractItemStatus, "pending">,
): Exclude<ContractItemStatus, "pending"> {
  const rank: Record<Exclude<ContractItemStatus, "pending">, number> = {
    contradicted: 3,
    verified: 2,
    insufficient: 1,
  };
  if (!left) return right;
  return rank[right] > rank[left] ? right : left;
}

/** Match two criterion references. If either is a criterion id
 *  (cr-XXXXXXXX), compares ids; otherwise requires the two texts to be
 *  EXACTLY equal after normalization (v3.8.1 — the similarity fallback is
 *  gone, so a paraphrase is a different criterion). */
export function criteriaMatch(a: string, b: string): boolean {
  const aIsId = isCriterionId(a);
  const bIsId = isCriterionId(b);
  // Both are IDs — exact string comparison
  if (aIsId && bIsId) return a === b;
  // One is an ID — derive ID from the other and compare
  if (aIsId) return a === deriveCriterionId(b);
  if (bIsId) return deriveCriterionId(a) === b;
  // v3.8.1: normalized text must be EXACTLY equal. The former Jaccard
  // fallback let two merely-similar criterion strings count as the same
  // criterion, which could fuse distinct criteria (and suppress or invent a
  // criteria milestone) on a similarity score rather than on an identity.
  return normalizeText(a) === normalizeText(b);
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
  const progress = last ? entryProgressEstimate(last) : 0;

  return makeMilestoneSummary({
    label,
    round_range: { start: startRound, end: endRound },
    outcome,
    carried_constraints: carried,
    resolved_constraints: resolved,
    progress_at_boundary: progress,
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
  level?: string,
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
    const violations = view
      ? view.constraintViolations ?? []
      : Array.isArray(entry.constraint_violations)
        ? entry.constraint_violations
        : Array.isArray(data.constraint_violations) ? data.constraint_violations : [];
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

/** v2.11: Derive a stable criterion ID from its text hash (cr-XXXXXXXX).
 *  Same hash strategy as SubGoal — deterministic across rounds. */
export function deriveCriterionId(text: string): string {
  return "cr-" + deriveItemId(text);
}

/** v2.11: Check whether a user-provided reference looks like a criterion ID.
 *  Matches the pattern cr-XXXXXXXX where X is a hex digit. Module-local:
 *  consumers with the same need (round-contract.ts) keep their own copy to
 *  avoid an import cycle. */
function isCriterionId(ref: string): boolean {
  return /^cr-[a-f0-9]{8}$/.test(ref);
}


// ═══════════════════════════════════════════════════════════════════════════
// Time-Aware Constraint Management (v2.3)
// ═══════════════════════════════════════════════════════════════════════════

/** Determine the source of a constraint by matching against known sources. */
function constraintSource(
  text: string,
  objective: LoopObjective,
  constraintsFromPlan: string[],
): "hard" | "plan" | "criteria" | "discovered" {
  const norm = text.toLowerCase().trim();
  if (objective.hard_constraints.some((c) => c.toLowerCase().trim() === norm)) return "hard";
  if (constraintsFromPlan.some((c) => c.toLowerCase().trim() === norm)) return "plan";
  if (objective.success_criteria.some((c) => c.toLowerCase().trim() === norm)) return "criteria";
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

function levelDecision(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): PromptLevelDecision {
  const previous = getPreviousRound(request.loop_id, request.round - 1, context);
  const last = request.last_round_result;
  const hasNewInformation = Boolean(
    request.new_since_last_round.trim() ||
    last?.discovered_constraints?.length ||
    last?.objective_refinement?.trim() ||
    last?.emerged_subtasks?.length ||
    last?.retracted_constraints?.length ||
    last?.revised_success_criteria?.length ||
    last?.wrong_assumptions?.length,
  );
  // v2.14: a backtrack committed for this round means the loop is
  // re-walking restored state — the recovery boundary forces L2
  // rehydration (the decidePromptLevel recovery_boundary branch existed
  // but no caller ever set it).
  const recoveryBoundary = loopEntries(request.loop_id, context)
    .some((entry) =>
      entryLineage(entry).committed_action === "backtrack" &&
      entryRound(entry) === request.round,
    );
  return decidePromptLevel({
    round: request.round,
    attempt: request.attempt,
    forceLevel: request.force_level,
    hasPlanSource: Boolean(request.plan_source),
    recoveryBoundary,
    checkpointBoundary: last?.compression_checkpoint === true,
    goalChanged: previous !== null && previous.goal_id !== deriveGoalId(
      request.loop_id,
      request.task,
      request.goal_id,
    ),
    previousStateMissing: request.round > 1 && previous === null,
    previousFailedWithoutNewInformation: last?.success === false && !hasNewInformation,
    verificationContradicted: (request.verification_flags ?? [])
      .some((flag) => flag.severity === "error"),
    consecutiveRejections: request.consecutive_rejections,
  });
}

export function decideLevel(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): "l0" | "l1" | "l2" {
  return levelDecision(request, context).level;
}

export function buildSelfEvalBlock(
  round: number,
  /** v2.12: L0 is the minimal retry template — the v2.12 declarative fields
   *  (outcome/blocker/retroactiveClaims) are L1/L2 additions so the retry
   *  prompt stays within its tight budget. */
  level?: "l0" | "l1" | "l2",
  /** v3.3/v3.4: Whether this round's Current Task IS the ACTIVE Round
   *  Contract (derived from committed rounds — compileLoop passes
   *  `activeContract != null`). Only then does the template ask the agent
   *  to restate/propose it — a generic empty contract template would invite
   *  placeholder submissions that trigger round_underspecified noise. */
  hasContract = false,
): string {
  const declareOutcome = level !== "l0";
  const restateContract = hasContract && declareOutcome;

  const evalObj: Record<string, unknown> = {
    success: false,
    output_summary: `<verified result of round ${round}>`,
    constraint_violations: ["<c-XXXXXXXX or text>"],
    should_continue: true,
    discovered_constraints: ["<new constraint>"],
    emerged_subtasks: [],
    execution_report: {
      files_changed: [],
      tests_reported: { passed: 0, failed: 0, skipped: 0 },
      // The contract claim is functional (it is what advances an item), so it
      // stays at every level. The advisory criterion claim is an L1/L2
      // addition — the L0 retry template is a lean delta kept under budget.
      contract_item_claims: [
        { item_id: "<rci-XXXXXXXX from the Current Task>", outcome: "met" },
      ],
      progress_estimate: 0,
    },
    wrong_assumptions: [],
    subgoal_updates: [
      { id: "<sg-XXXXXXXX from the Sub-Goal Dashboard>", status: "done" },
    ],
  };

  // v2.12: Declarative tri-state outcome (L1/L2 only — keeps L0 retry lean)
  if (declareOutcome) {
    evalObj.outcome = "<success|partial|failed|blocked>";
    evalObj.blocker = "<required only when outcome=blocked>";
    evalObj.retroactiveClaims = [];
    // v3.8: the advisory criterion claim rides with the other L1/L2 additions.
    (evalObj.execution_report as Record<string, unknown>).criterion_claims = [
      { criterion_id: "<cr-XXXXXXXX or text>", outcome: "met" },
    ];
  }

  // v3.3/v3.4: Round Contract proposal template (L1/L2, active-contract
  // rounds only — L0 retry stays lean, and rounds without an active
  // contract never see the template). When the prompt's Current Task IS the
  // ACTIVE contract, the agent restates it unchanged as its proposal; when
  // the active contract's done_when are all satisfied (or the round is
  // blocked), a NEW contract is declared for the next round instead.
  if (restateContract) {
    evalObj.round_contract = {
      work_item: "<this round's focus, or empty>",
      done_when: [],
      verification_plan: [],
      scope: [],
    };
  }

  const lines = [
    "### LoopForge Evaluation (Required)",
    "",
    `After completing Round ${round}, replace the placeholder values below`,
    "with your actual results and pass this object as `loopforge_next.evaluation`.",
  ];

  lines.push("```json");
  lines.push(JSON.stringify(evalObj, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("IMPORTANT: Replace every <placeholder> with your actual data.");
  lines.push("Set success=true only when the full goal and ALL hard constraints are verified.");
  lines.push("Use IDs for exact matching: c-XXXXXXXX, cr-XXXXXXXX, sg-XXXXXXXX.");
  lines.push("Sub-goal changes go through `subgoal_updates` (active sub-goal IDs only;");
  lines.push("done/canceled are terminal — reopen via `emerged_subtasks`; bad IDs reject).");
  if (restateContract) {
    lines.push(
      "Round Contract: restate the Current Task's contract UNCHANGED in",
      "`round_contract` (work_item/items/scope) and run each item's Verify",
      "commands; claim the items you completed in",
      "`execution_report.contract_item_claims` using the `rci-XXXXXXXX` ids",
      "the Current Task renders. An item only becomes verified when its bound",
      "command is observed passing — a claim alone leaves it insufficient.",
      "When every item is verified, or the round is blocked (outcome=blocked",
      "+ blocker), declare the NEXT round's contract instead (or omit",
      "`round_contract` when the whole task is done — the Current Task",
      "reverts to the original task).",
    );
  }

  return lines.join("\n");
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
  const entry = loopEntries(loopId, context).find(
    (e) => entryLineage(e).committed_action === "backtrack" && entryRound(e) === round,
  );
  if (!entry) return undefined;
  // v3.8.1: one decoder for the committed rollback record and one renderer for
  // the brief. The facts ride on the merged lineage entry (engine.ts stamps
  // them from the committed decision) and the same `decodeBacktrackRecord`
  // reads the durable :feedback envelope, so both carriers decode to one shape
  // — and this brief and the rollback prompt no longer render the same
  // rollback with two hand-written line builders.
  const record = decodeBacktrackRecord(entryLineage(entry));
  if (!record) return undefined;
  return recoveryBriefLines({
    target: record.target,
    triggerRule: record.triggerRule,
    failedRounds: record.failedRounds,
    approaches: record.approaches,
    wrongAssumptions: record.wrongAssumptions,
  });
}

export function compileLoop(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): LoopCompileResponse {
  const decision = levelDecision(request, context);
  const previous = getPreviousRound(request.loop_id, request.round - 1, context);
  const objective = evolveObjective(request, context);
  const constraints = evolveConstraints(request, objective, previous, context);
  const constraintLifecycle = manageConstraintLifecycle(
    constraints.active,
    objective,
    request.constraints_from_plan,
    context,
    request.round,
    request.last_round_result?.constraint_violations ?? [],
  );
  const rolling = buildRollingSummary(request.loop_id, request.round, context, 0, decision.level);
  // v3.8: ONE committed-round derivation feeds every projection below
  // (sub-goals, the active contract, its item statuses, criteria).
  const windowRounds = derivationRounds(
    loopEntries(request.loop_id, context),
    request.round,
  );
  // v3.8: sub-goal lifecycle lives in subgoal-state.ts and consumes the
  // shared committed-round view — one history interpretation.
  const subGoals = deriveSubGoals({
    loopId: request.loop_id,
    currentRound: request.round,
    rounds: windowRounds,
    currentReport: request.last_round_result
      ? {
          round: request.last_round_result.round || (request.round - 1),
          emergedSubtasks: request.last_round_result.emerged_subtasks ?? [],
          subgoalUpdates: request.last_round_result.subgoal_updates ?? [],
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
  const { activeContract, itemStatuses: contractItemStatuses } = roundFacts;
  // v3.2: Goal → criteria → evidence vertical view (derived, zero persistence).
  const criterionStatuses = deriveCriterionStatuses(
    request.loop_id,
    context,
    objective,
    request.round,
    subGoals,
    request.last_round_result,
    { activeContract, itemStatuses: contractItemStatuses },
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
  const repeatedDeclarations = duplicateEmergedDeclarations(
    request.last_round_result?.emerged_subtasks ?? [],
  );
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
  const completedEntries = loopEntries(request.loop_id, context)
    .filter((e) => entryRound(e) >= 1 && entryRound(e) < request.round);
  const committedRounds = derivationRounds(completedEntries, request.round);

  // v3.3/v3.8.1: machine git-motion (display-only, derived). The per-round
  // "round stats" table is deleted: its only renderer was the L2 prompt
  // section removed above, so it was computed, put into the canonical state
  // (and therefore into stateHash) and read by nothing.
  const machineStatus = deriveMachineStatus(committedRounds, request.round);

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
  });
  const markdown = renderCanonicalStateMarkdown(state, {
    // v3.7.1: retry attempts are marked in the derived view (attempt is
    // request context, not a committed fact). The Recovery Brief renders in
    // the Recent tier only while a committed backtrack decision is this
    // round's record; the redo commit removes it by construction.
    attempt: request.attempt,
    recoveryBrief: committedBacktrackBrief(request.loop_id, request.round, context),
  });

  // v3.8.1: the L2 budget is a FIXED ceiling. The v2.4 adaptive budget
  // scaled it by round count, milestone count and sub-goal count, which made
  // the prompt's allowed content depend on how long the loop had been running
  // rather than on the facts of this round — the same loop could render a
  // section at round 5 and silently drop it at round 50.
  //
  // v2.8: L2 pointer mode — when enabled, skip the monolithic markdown blob.
  // Structured L2 sections (milestones, sub-goals, trust, progress) still
  // render. The state file on disk is the durable source of truth.
  // L7: pointer mode REQUIRES the file — with state_file disabled it would
  // silently drop the full state from L2 prompts and point at nothing.
  const l2Pointer = policy.state_file.enabled &&
    policy.prompt.l2_pointer_enabled && decision.level === "l2";

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
    selfEvaluationBlock: buildSelfEvalBlock(
      request.round,
      decision.level,
      // v3.4: restate the contract only when this prompt's Current Task IS
      // the ACTIVE contract (derived — not the previous submission's field,
      // which is a proposal and may differ from what this round executes).
      activeContract != null,
    ),
    fullStateMarkdown: l2Pointer ? undefined : markdown,
    // v2.9: Model's information needs from the previous round's SelfEvaluation
    promptRequests: request.last_round_result?.prompt_requests,
  });
  response.prompt = artifact.renderedPrompt;
  response.prompt_artifact = artifact;
  response.state_file_content = policy.state_file.enabled ? markdown : undefined;
  return response;
}
