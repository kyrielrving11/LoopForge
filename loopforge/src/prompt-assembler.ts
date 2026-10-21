/** Single-pass prompt renderer for canonical LoopForge state.
 *
 * L0/L1/L2 control state density only. Reasoning strategy belongs to the
 * external Agent. Mandatory task, hard-constraint, and verification sections
 * are never truncated and always render. Budgets are soft CEILINGS applied
 * to optional sections: optional sections are appended in priority order
 * while the rendered length stays under the level's budget, and the rest are
 * dropped from the prompt (the dropped content stays derivable from the
 * vault). Prompt length can exceed the ceiling when the mandatory sections
 * alone are over it — truncation of mandatory content never happens.
 */

import { createHash } from "node:crypto";
import type { CanonicalLoopState } from "./canonical-state.js";
import {
  buildPhaseLine,
  formatActiveSubGoals,
  formatCriterionRows,
  hashCanonicalState,
  milestoneHeading,
  partitionActiveConstraints,
} from "./canonical-state.js";
import type {
  PromptArtifact,
  PromptRequestEffect,
  PromptRequests,
} from "./protocol.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "./protocol.js";
import type {
  RecurringFlag,
} from "./protocol.js";
import type {
  PromptLevel,
  PromptLevelReason,
} from "./prompt-policy.js";
import {
  deriveCriterionId,
  deriveItemId,
  findingKey,
  STABLE_ID_RE,
  normalizeText,
} from "./token-utils.js";
import { getPolicy } from "./policy.js";
import { verificationActionFor } from "./verification-actions.js";
import {
  assertPromptCoverage,
  derivePromptCoverage,
  type ActiveNormativeId,
  type CoverageKind,
} from "./prompt-coverage.js";


export interface PromptBudgets {
  l0: number;
  l1: number;
  l2: number;
}

export const DEFAULT_PROMPT_BUDGETS: PromptBudgets = {
  l0: 5000,
  l1: 10000,
  l2: 18000,
};

export interface PromptAssemblyInput {
  state: CanonicalLoopState;
  level: PromptLevel;
  reasons: PromptLevelReason[];
  budgets?: Partial<PromptBudgets>;
  attempt?: number;
  selfEvaluationBlock: string;
  /** v3.9.4: the committed-backtrack recovery facts, from the SAME
   *  `committedBacktrackBrief` the state file renders. Present only while a
   *  committed rollback directive is the current redo boundary. */
  recoveryBrief?: string[];
  /** v2.9: Model's information needs for this prompt. L0: ignored. */
  promptRequests?: PromptRequests;
}

interface Section {
  id: string;
  text: string;
  mandatory: boolean;
  /** v3.9.4: the active normative ids this section actually rendered. A
   *  narrative section declares `[]`; coverage is computed from these
   *  declarations, never by scanning the prompt text. */
  coverageIds: string[];
}

function section(title: string, body: string): string {
  return body.trim() ? `### ${title}\n${body.trim()}\n\n` : "";
}

function bullets(values: string[], prefix = "- "): string {
  return values.map((value) => `${prefix}${value}`).join("\n");
}

/** 3.9.3: The action table lives in a neutral module so the evaluation-field
 *  guidance can quote the same wording without depending on a renderer.
 *  Re-exported here for the existing CHECK_* coverage test. */
export { verificationActionFor } from "./verification-actions.js";

function verificationText(
  state: CanonicalLoopState,
  level?: "l0" | "l1" | "l2",
): string {
  const lines = state.verificationFlags.map((flag) => {
    const icon = flag.severity === "error"
      ? "🚫"
      : flag.severity === "warn" ? "⚠️" : "ℹ️";
    const ref = flag.ref ? ` [ref: \`${flag.ref}\`]` : "";
    // v3.9.4: the finding names the affected field AND the concrete subject;
    // the repair surface is a fact, not a next-action instruction.
    const base = `- ${icon} [${flag.check}] \`${flag.field}\` — ${flag.detail}${ref}`;
    // v3.2: error/warn flags get an actionable continuation line in L1/L2 —
    // the verdict is translated into what to DO. L0 keeps the compact retry
    // prompt byte-identical; info flags stay informational.
    if (level === "l0" || flag.severity === "info") return base;
    const label = flag.severity === "error" ? "Fix" : "Action";
    return `${base}\n  → ${label}: ${verificationActionFor(flag.check)}`;
  });
  if (state.verificationFlags.some((flag) => flag.severity === "error")) {
    lines.push(
      "- Gate Verdict: CONTRADICTED — resolve every error before claiming success.",
    );
  }
  return lines.join("\n");
}

/** v3.9.4: the ONE identity of a text in the prompt's normative namespaces.
 *  A criterion keeps its cr-* even when it also appears in an active list;
 *  metadata supplies the id for everything else. */
function identityForText(state: CanonicalLoopState, text: string): string {
  // Criteria identity wins even if a stale/hand-built metadata row disagrees.
  const status = state.criterionStatuses.find(
    (criterion) => normalizeText(criterion.text) === normalizeText(text),
  );
  if (status) return status.id;
  if (state.successCriteria.some(
    (criterion) => normalizeText(criterion) === normalizeText(text))) {
    return deriveCriterionId(text);
  }
  const meta = state.constraintMetadata.find((entry) => entry.text === text);
  if (meta) return meta.id;
  return `c-${deriveItemId(text)}`;
}

/** v3.9.4: active constraint rows with their real ids and the machine fact
 *  that this round violated them. Shared by the hard and other partitions. */
function constraintLines(
  state: CanonicalLoopState,
  texts: ReadonlyArray<string>,
): string {
  return texts.map((text) => {
    const violated = state.constraintMetadata.find((meta) => meta.text === text)
      ?.last_violated_at_round === state.round;
    return `- [\`${identityForText(state, text)}\`] ${text}` +
      (violated ? " (violated this round)" : "");
  }).join("\n");
}

/** v3.9.4: every active normative object the current prompt MUST render. */
function activeNormativeIds(
  state: CanonicalLoopState,
  recoveryBrief: ReadonlyArray<string> | undefined,
): ActiveNormativeId[] {
  const out: ActiveNormativeId[] = [];
  const partition = partitionActiveConstraints(state);
  for (const text of partition.hard) {
    out.push({ id: identityForText(state, text), kind: "constraint" });
  }
  for (const text of partition.other) {
    out.push({ id: identityForText(state, text), kind: "constraint" });
  }
  for (const text of partition.criteria) {
    out.push({ id: identityForText(state, text), kind: "criterion" });
  }
  if (state.roundContract) {
    out.push({ id: state.roundContract.id, kind: "contract" });
    for (const item of state.roundContract.items) {
      out.push({ id: item.id, kind: "contract_item" });
    }
  }
  for (const subGoal of state.subGoals) {
    if (subGoal.status !== "done" && subGoal.status !== "canceled") {
      out.push({ id: subGoal.id, kind: "subgoal" });
    }
  }
  for (const flag of state.verificationFlags) {
    out.push({ id: findingKey(flag), kind: "finding" });
  }
  if (recoveryBrief && recoveryBrief.length > 0) {
    out.push({ id: "recovery", kind: "recovery" });
  }
  return out;
}


/** v3.9.4: the normative sections shared by L0/L1/L2. Levels change ONLY the
 *  density of narrative sections; they never change which active normative
 *  ids are rendered. Every section here is mandatory (protected). */
function commonMandatorySections(
  state: CanonicalLoopState,
  level: "l0" | "l1" | "l2",
  recoveryBrief?: ReadonlyArray<string>,
): Section[] {
  const partition = partitionActiveConstraints(state);
  const sections: Section[] = [
    {
      id: "objective",
      text: section("Objective", state.objective),
      mandatory: true,
      coverageIds: [],
    },
    {
      id: "current_task",
      text: section("Current Task", state.currentTask),
      mandatory: true,
      // Declare what this text actually carries. `createCanonicalLoopState`
      // builds currentTask with `formatRoundContract`, so this is the
      // structured source, not a text guess; an inconsistent hand-built state
      // therefore fails closed instead of claiming an id it did not render.
      coverageIds: state.roundContract
        ? [
            state.roundContract.id,
            ...state.roundContract.items.map((item) => item.id),
          ].filter((id) => state.currentTask.includes(id))
        : [],
    },
  ];

  const criteria = formatCriterionRows(
    state.criterionStatuses,
    state.successCriteria,
  );
  if (criteria.lines.length > 0) {
    sections.push({
      id: "criteria",
      text: section("Success Criteria", criteria.lines.join("\n")),
      mandatory: true,
      coverageIds: criteria.ids,
    });
  }
  if (partition.hard.length > 0) {
    sections.push({
      id: "hard_constraints",
      text: section(
        "Active Hard Constraints",
        constraintLines(state, partition.hard),
      ),
      mandatory: true,
      coverageIds: partition.hard.map((text) => identityForText(state, text)),
    });
  }
  if (partition.other.length > 0) {
    sections.push({
      id: "active_constraints",
      text: section(
        "Active Constraints",
        constraintLines(state, partition.other),
      ),
      mandatory: true,
      coverageIds: partition.other.map((text) => identityForText(state, text)),
    });
  }
  if (state.subGoals.length > 0) {
    const subGoals = formatActiveSubGoals(state.subGoals, state.round);
    sections.push({
      id: "sub_goals",
      text: section("Active Sub-Goals", subGoals.lines.join("\n")),
      mandatory: true,
      coverageIds: subGoals.ids,
    });
  }
  if (recoveryBrief && recoveryBrief.length > 0) {
    sections.push({
      id: "recovery",
      text: section("Recovery Brief", recoveryBrief.join("\n")),
      mandatory: true,
      coverageIds: ["recovery"],
    });
  }
  if (state.verificationFlags.length > 0) {
    sections.push({
      id: "verification",
      text: section("Verification Gate", verificationText(state, level)),
      mandatory: true,
      coverageIds: state.verificationFlags.map((flag) => findingKey(flag)),
    });
  }
  return sections;
}

function l0Sections(
  state: CanonicalLoopState,
  recoveryBrief?: ReadonlyArray<string>,
): Section[] {
  const retryRequirements = [
    ...state.blockers,
    ...state.verificationFlags.map((flag) => flag.detail),
  ];
  const sections = commonMandatorySections(state, "l0", recoveryBrief);
  if (retryRequirements.length > 0) {
    sections.push({
      id: "retry_requirements",
      text: section("Retry Requirements", bullets(retryRequirements)),
      mandatory: true,
      // The same finding keys as the Verification Gate: either repair surface
      // proves the finding was delivered, and both derive from the one list.
      coverageIds: state.verificationFlags.map((flag) => findingKey(flag)),
    });
  }
  return sections;
}

/** v3.8.1: the committed-round window Active Warnings reports on. */
const ACTIVE_WARNINGS_WINDOW = 3;
/** v3.8.1: hard cap on Active Warnings lines. */
const ACTIVE_WARNINGS_CAP = 5;

/** v3.8.1: the prompt's slice of the recurring-fact list — the facts still
 *  firing inside the last ACTIVE_WARNINGS_WINDOW committed rounds.
 *
 *  One list, two windows: this shows what is going wrong NOW (any count), the
 *  state file shows what keeps recurring (>= 2 rounds). Before this release
 *  the prompt carried a raw, unthresholded violation list AND a whole-history
 *  count >= 2 list, under two different headings.
 *
 *  Returns "" when nothing is firing, so the caller renders no section. */
function activeWarnings(flags: RecurringFlag[], currentRound: number): string {
  const cutoff = currentRound - ACTIVE_WARNINGS_WINDOW;
  const shown = flags
    .filter((flag) => flag.rounds.some((round) => round >= cutoff))
    .sort((a, b) =>
      Math.max(...b.rounds) - Math.max(...a.rounds) || b.count - a.count)
    .slice(0, ACTIVE_WARNINGS_CAP);
  if (shown.length === 0) return "";
  return shown.map((flag) => {
    const icon = flag.kind === "constraint_violation"
      ? "🚫"
      : flag.kind === "verification_error" ? "⚠️" : "ℹ️";
    const subject = flag.ref ? `${flag.subject} [${flag.ref}]` : flag.subject;
    return `- ${icon} ${subject} — ${flag.count}×, latest R${Math.max(...flag.rounds)}`;
  }).join("\n");
}

function l1Sections(
  state: CanonicalLoopState,
  recoveryBrief?: ReadonlyArray<string>,
): Section[] {
  const sections = commonMandatorySections(state, "l1", recoveryBrief);
  if (state.corrections.length > 0) {
    sections.push({
      id: "corrections",
      text: section(
        "Corrections (committed reports)",
        bullets(state.corrections),
      ),
      mandatory: false,
      coverageIds: [],
    });
  }
  if (state.blockers.length > 0) {
    sections.push({
      id: "blockers",
      text: section(
        "Blockers (reported/current)",
        bullets(state.blockers),
      ),
      mandatory: false,
      coverageIds: [],
    });
  }
  // v3.2: L1 also renders explicit external context supplied by the caller.
  if (state.externalContext) {
    sections.push({
      id: "external_context",
      text: section("External Context (agent-supplied)", state.externalContext),
      mandatory: false,
      coverageIds: [],
    });
  }
  // v3.8.1: one compact phase line, not the Roadmap prose.
  const l1Phase = buildPhaseLine(state);
  if (l1Phase) {
    sections.push({
      id: "phase",
      text: section("Phase", l1Phase),
      mandatory: false,
      coverageIds: [],
    });
  }
  // v3.8.1: the recent tail of the ONE recurring-fact derivation. It mixes
  // committed Agent violation reports with machine verification flags, so the
  // heading names findings rather than implying all of it is machine evidence.
  const warnings = activeWarnings(state.recurringFlags, state.round);
  if (warnings) {
    sections.push({
      id: "active_warnings",
      text: section("Recurring Findings", warnings),
      mandatory: false,
      coverageIds: [],
    });
  }
  return sections;
}

function l2Sections(
  state: CanonicalLoopState,
  recoveryBrief?: ReadonlyArray<string>,
): Section[] {
  const sections = commonMandatorySections(state, "l2", recoveryBrief);
  // v3.9.5: L2 is a boundary rehydration, not a history dump. The full state
  // lives in the optional state file / replay / audit; the prompt carries the
  // current governance projection plus a small stage anchor.
  if (state.corrections.length > 0) {
    sections.push({
      id: "corrections",
      text: section(
        "Corrections (committed reports)",
        bullets(state.corrections),
      ),
      mandatory: false,
      coverageIds: [],
    });
  }
  if (state.blockers.length > 0) {
    sections.push({
      id: "blockers",
      text: section(
        "Blockers (reported/current)",
        bullets(state.blockers),
      ),
      mandatory: false,
      coverageIds: [],
    });
  }
  // The recent tail of the ONE recurring-fact derivation. The full recurring
  // set lives in the state file; the heading names mixed provenance.
  const warnings = activeWarnings(state.recurringFlags, state.round);
  if (warnings) {
    sections.push({
      id: "active_warnings",
      text: section("Recurring Findings", warnings),
      mandatory: false,
      coverageIds: [],
    });
  }
  // One compact phase line, not the Roadmap prose.
  const l2Phase = buildPhaseLine(state);
  if (l2Phase) {
    sections.push({
      id: "phase",
      text: section("Phase", l2Phase),
      mandatory: false,
      coverageIds: [],
    });
  }
  // Stage anchors only: milestone labels/ranges, never the Agent's outcome
  // text or the carried/resolved constraint history. Those remain in the
  // derived state file, audit and replay.
  if (state.milestones.length > 0) {
    const anchors = state.milestones
      .slice(-3)
      .map((m) => milestoneHeading(m))
      .join("\n");
    sections.push({
      id: "milestones",
      text: section("Phase Anchors", anchors),
      mandatory: false,
      coverageIds: [],
    });
  }
  if (state.externalContext) {
    sections.push({
      id: "external_context",
      text: section("External Context (agent-supplied)", state.externalContext),
      mandatory: false,
      coverageIds: [],
    });
  }

  return sections;
}

function selectSections(input: PromptAssemblyInput): Section[] {
  if (input.level === "l0") {
    return l0Sections(input.state, input.recoveryBrief);
  }
  if (input.level === "l1") {
    return l1Sections(input.state, input.recoveryBrief);
  }
  return l2Sections(input.state, input.recoveryBrief);
}

/** v3.8.1: render order, in ONE place.
 *
 *  - A section absent from this table falls to DEFAULT_SECTION_PRIORITY.
 *  - A Section's `mandatory` flag means PROTECTED: never dropped, never
 *    truncated, rendered first regardless of budget.
 *  - Everything else is optional and is cut lowest-priority-first.
 *
 *  Priority belongs to the SECTION, not to policy: a budget knob must not be
 *  able to change which facts count as more important. (v3.2–v3.8 had no
 *  order at all — optional sections were appended in declaration order, so a
 *  single large early section silently pushed out every later one.)
 */
const SECTION_PRIORITY: Readonly<Record<string, number>> = {
  // ── protected (every active normative id lives here) ────────────────────
  objective: 0,
  current_task: 1,
  criteria: 2,
  hard_constraints: 3,
  active_constraints: 4,
  sub_goals: 5,
  recovery: 6,
  verification: 7,
  retry_requirements: 8,
  // Zero-token pure reorder, but it is the ONLY place emphasized items render
  // (they are MOVED out of their source sections), so dropping it would delete
  // them rather than just deprioritize them.
  critical_context: 9,
  // ── optional current-governance / anchor sections ───────────────────────
  blockers: 20,
  corrections: 21,
  phase: 24,
  active_warnings: 25,
  external_context: 26,
  milestones: 29,
};

const DEFAULT_SECTION_PRIORITY = 50;

/** v3.8.1: the smallest remaining room worth spending on a truncated
 *  section. Below this a partial render is noise, so the section is dropped
 *  whole instead. */
const TRUNCATION_MIN_CHARS = 256;

/** Cut at a line boundary so a truncated section cannot end mid-sentence. */
function truncateAtLine(text: string, room: number): string {
  const clipped = text.slice(0, room);
  const lastBreak = clipped.lastIndexOf("\n");
  return `${lastBreak > 0 ? clipped.slice(0, lastBreak) : clipped}\n`;
}

function renderWithinBudget(
  sections: Section[],
  fixedText: string,
  budget: number,
): {
  rendered: string;
  included: string[];
  dropped: string[];
  protectedOverflow: boolean;
} {
  // Total order: priority, then declaration order. Deterministic by
  // construction — no dependence on map iteration or insertion accidents.
  const ranked = sections
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      (SECTION_PRIORITY[a.item.id] ?? DEFAULT_SECTION_PRIORITY) -
        (SECTION_PRIORITY[b.item.id] ?? DEFAULT_SECTION_PRIORITY) ||
      a.index - b.index);

  let rendered = fixedText;
  const included: string[] = [];
  const dropped: string[] = [];
  for (const { item } of ranked) {
    if (!item.text || !item.mandatory) continue;
    rendered += item.text;
    included.push(item.id);
  }
  // Protected content alone can exceed the ceiling. That is RECORDED, never
  // "fixed" by truncating a protected section.
  const protectedOverflow = rendered.length > budget;

  // Optional sections, STRICT priority: find the longest optional PREFIX that
  // fits, and cut only from the tail of that ordering.
  //
  // Greedy first-fit is a different rule, and not the documented one: it can
  // render a small low-priority section into room a larger high-priority
  // section could not use, so "Blockers" could be missing while "Phase" is
  // present. "Cut lowest-priority-first" has to mean what it says.
  const optional = ranked.filter(({ item }) => item.text && !item.mandatory);
  let prefix = optional.length;
  while (prefix > 0) {
    const total = optional
      .slice(0, prefix)
      .reduce((sum, { item }) => sum + item.text.length, 0);
    if (rendered.length + total <= budget) break;
    prefix--;
  }
  for (const { item } of optional.slice(0, prefix)) {
    rendered += item.text;
    included.push(item.id);
  }
  for (const { item } of optional.slice(prefix)) {
    dropped.push(item.id);
  }

  // Whatever room is left goes to the FIRST section that did not fit, rendered
  // partially and cut at a line boundary. Exactly one section can be partial,
  // so the cut is explainable ("this one did not fit whole") rather than a
  // scatter of half-rendered sections.
  const next = optional[prefix];
  if (next) {
    const room = budget - rendered.length;
    if (room >= TRUNCATION_MIN_CHARS) {
      rendered += truncateAtLine(next.item.text, room);
      included.push(next.item.id);
      dropped.shift();
    }
  }
  return { rendered, included, dropped, protectedOverflow };
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.9: Prompt Requests — model-expressed information needs
// ═══════════════════════════════════════════════════════════════════════════

/** Match an emphasis target against state items.
 *  v2.11: ID-first — a target written as a stable id (`c-`/`cr-`/`sg-` + 8 hex)
 *  matches the candidate deriving to the same id.
 *  v3.8.1: the other arm is NORMALIZED-EXACT text. The Jaccard fallback is
 *  gone, so an emphasis can no longer pull in a near-miss because the two
 *  strings happened to share tokens. An unmatched target still renders
 *  nothing, keeping this a pure reorder with zero token overhead. */
function matchEmphasize(
  targets: string[],
  candidates: string[],
  cap: number,
): { matched: string[]; effects: PromptRequestEffect[] } {
  if (targets.length === 0) return { matched: [], effects: [] };
  const hitsByTarget = new Map<string, string[]>();
  const matched: string[] = [];
  for (const candidate of candidates) {
    const candidateText = normalizeText(candidate);
    let hit = false;
    for (const target of targets) {
      const idMatch = target.match(STABLE_ID_RE);
      const targetHit = idMatch
        ? `${idMatch[1]}-${deriveItemId(candidate)}` === target
        : normalizeText(target) === candidateText;
      if (!targetHit) continue;
      hit = true;
      const list = hitsByTarget.get(target) ?? [];
      list.push(candidate);
      hitsByTarget.set(target, list);
    }
    if (hit) matched.push(candidate);
  }
  // Candidate order, capped — deterministic, and no score to sort by.
  const kept = matched.slice(0, cap);
  const keptSet = new Set(kept);
  const effects: PromptRequestEffect[] = targets.map((target) => {
    const hits = hitsByTarget.get(target) ?? [];
    if (hits.length === 0) {
      return { field: "emphasize", request: target, status: "no_match" };
    }
    return {
      field: "emphasize",
      request: target,
      status: hits.some((candidate) => keptSet.has(candidate)) ? "applied" : "capped",
    };
  });
  return { matched: kept, effects };
}

/** Render the "Confusion Alerts" section that appears at the prompt top.
 *
 *  v3.8.1: the points are echoed back, truncated and capped — nothing more.
 *  The compiler used to score each point against eight section keywords with
 *  Jaccard similarity and point at the argmax. That pointer was both a
 *  similarity verdict and, in practice, nearly always wrong: "I don't
 *  understand milestone tracking" scores 1/8 = 0.125 against the keyword
 *  `milestone`, below the 0.15 default, so it fell through to the generic
 *  line anyway. v3.9.5: the pointer is conditional — a disabled state file
 *  must never be named as the place to look. */
function renderConfusionAlerts(
  points: string[],
  fullDensity: boolean,
  hasStateFile: boolean,
): string {
  if (points.length === 0) return "";
  const lines: string[] = [
    "## ⚠️ Confusion Alerts",
    "",
    "You flagged these as confusing in the previous round.",
    hasStateFile
      ? "Address each before proceeding — the state file has full context."
      : "Address each before proceeding — no state file is enabled; use the live prompt, replay, or status views.",
    "",
  ];
  // v2.14: L2 renders up to the policy cap (was: every confusion point,
  // unbounded by max_confusion_points); L1 keeps a single alert.
  const shown = fullDensity
    ? points.slice(0, getPolicy().prompt.max_confusion_points)
    : points.slice(0, 1);
  for (const point of shown) {
    const truncated = point.length > 200 ? point.slice(0, 197) + "…" : point;
    lines.push(`- **"${truncated}"**`);
    lines.push(hasStateFile
      ? "  → Read the full state file for relevant context."
      : "  → Use the current prompt, replay, or status views for context.");
    lines.push("");
  }

  if (!fullDensity && points.length > 1) {
    lines.push(
      hasStateFile
        ? `*… and ${points.length - 1} more confusion point(s) — see state file.*`
        : `*… and ${points.length - 1} more confusion point(s).*`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

/** Render the "Critical Context" section — current governance items the model
 *  emphasized. v3.9.5: only active constraints are candidates, so this can
 *  never resurrect a removed historical narrative. */
/** v3.9.4: an emphasized item that is also an active normative constraint
 *  reports its real id here, because it is MOVED out of its source section
 *  and this is the only place it renders. Narrative items carry no id. */
function normativeIdForText(
  state: CanonicalLoopState,
  text: string,
): string | null {
  const key = normalizeText(text);
  const normative =
    state.activeConstraints.some((item) => normalizeText(item) === key) ||
    state.successCriteria.some((item) => normalizeText(item) === key) ||
    state.hardConstraints.some((item) => normalizeText(item) === key);
  return normative ? identityForText(state, text) : null;
}

function renderCriticalContext(
  emphasized: ReadonlyArray<{ text: string; id: string | null }>,
): string {
  if (emphasized.length === 0) return "";
  const lines: string[] = [
    "## 🔴 Critical Context",
    "",
    "You flagged these as important for this round. Prioritize them.",
    "",
  ];
  for (const item of emphasized) {
    lines.push(item.id
      ? `- [\`${item.id}\`] ${item.text}`
      : `- ${item.text}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function assemblePromptArtifact(input: PromptAssemblyInput): PromptArtifact {
  const budgets = { ...DEFAULT_PROMPT_BUDGETS, ...input.budgets };
  const budget = budgets[input.level];
  const stateHash = hashCanonicalState(input.state);
  const attempt = Math.max(1, input.attempt ?? 1);
  // ── State file reference + conditional read instruction ────────────
  // L2 rounds (full rehydration), recovery and rejection all benefit from the
  // model reading the durable state file rather than relying on
  // potentially-compacted conversation history.
  const fullContextReasons = new Set([
    "first_round", "plan_boundary", "checkpoint_boundary", "goal_changed",
    "missing_previous_state", "verification_contradicted",
    "rejection_rehydrate", "recovery_boundary",
  ]);
  const needsFullContext = input.level === "l2"
    || input.reasons.some((r) => fullContextReasons.has(r));

  const stateFilePath = input.state.stateFilePath;
  // v3.2: L1 annotates the pointer with the round the freshly-regenerated
  // state file describes (it is rewritten every compile); L0/L2 keep the
  // plain pointer byte-identical.
  const stateFileRef = stateFilePath
    ? (input.level === "l1"
        ? `📄 Full state: \`${stateFilePath}\` (updated round ${input.state.round})\n`
        : `📄 Full state: \`${stateFilePath}\`\n`)
    : "";
  // v3.9.5: a static boundary rule, not a fact source. It resolves the real
  // competition between the Agent's own memory/context and LoopForge's
  // committed governance projection, and names the three decomposition layers.
  const authorityBoundary = [
    "## LoopForge authority boundary",
    "",
    "- For committed rounds, active criteria/constraints/contracts, machine",
    "  verification and recovery state, use LoopForge's current projection.",
    "- Your conversation history and long-term memory are background. They may",
    "  contain unsubmitted, rejected, or rolled-back work; if they disagree,",
    "  re-check the workspace and machine evidence. Do not treat remembered",
    "  work as committed or verified.",
    "- A current explicit user instruction defines the task; LoopForge's old",
    "  objective does not override it.",
    "- Criteria are the operator's acceptance surface; sub-goals are your",
    "  execution plan; the Round Contract is this round's deliverable and its",
    "  acceptance conditions.",
    "- You own semantic judgment, decomposition, and action; LoopForge owns",
    "  durable facts, machine checks, and governance.",
    "",
  ].join("\n");
  const readInstruction = needsFullContext && stateFilePath
    ? [
        "",
        "> ⚠️ **Read the full state file before acting when you need history.**",
        "> It contains complete phase history, the sub-goal dashboard, constraint",
        "> lifecycle, and diagnostic facts. Conversation history may be",
        "> incomplete after compaction or resume. The state file is a derived",
        "> view of committed typed rounds — not an independent ledger or a",
        "> second factual source.",
        "",
      ].join("\n")
    : "";

  const header = [
    `## LoopForge Round ${input.state.round}`,
    `State: ${stateHash.slice(0, 12)} | Level: ${input.level.toUpperCase()} | Attempt: ${attempt}`,
    "",
    authorityBoundary,
    stateFileRef,
    readInstruction,
    "",
  ].join("\n");

  const pointer = stateFilePath
    ? section("Full State", stateFilePath)
    : "";
  const evaluation = input.selfEvaluationBlock.trim()
    ? `${input.selfEvaluationBlock.trim()}\n`
    : "";
  const howToRespond = [
    "## How to Complete This Round",
    "",
    "1. Execute the task described above and submit one structured evaluation.",
    "2. Call **`loopforge_next`** with the `sessionId` from `loopforge_start` and",
    "   the latest `roundId` returned by LoopForge. A rejection keeps that same",
    "   `roundId`; correct the evaluation and submit it again.",
    "3. Use the JSON template below for `evaluation`.",
    "",
    evaluation,
  ].join("\n");

  const footer = [pointer, howToRespond].join("");

  // ── v2.9: Prompt Requests — model-expressed information needs ──────────
  const pr = input.promptRequests;
  const levelIsL0 = input.level === "l0";
  const levelIsL2 = input.level === "l2";

  // Confusion alerts: L1/L2 only, rendered at the top (before mandatory sections)
  const confusionText = (!levelIsL0 && pr?.confusion_points?.length)
    ? renderConfusionAlerts(pr.confusion_points, levelIsL2, Boolean(stateFilePath))
    : "";

  // Emphasize: L1/L2 only, matched against active state items
  const policy = getPolicy().prompt;
  const emphasizeCap = levelIsL2 ? policy.max_emphasize_l2 : policy.max_emphasize_l1;
  const emphasis = (!levelIsL0 && pr?.emphasize?.length)
    ? matchEmphasize(
        pr.emphasize,
        // v3.9.5: emphasize is a pure reorder over current governance items,
        // never a way to resurrect removed historical narrative.
        [...input.state.activeConstraints],
        emphasizeCap,
      )
    : { matched: [], effects: [] };
  const emphasized = emphasis.matched;
  // v3.9.1: prompt-request effects are OUTPUT facts about this render. They
  // are never read by compile/decision code.
  const promptRequestEffects: PromptRequestEffect[] = [...emphasis.effects];
  if (levelIsL0 && pr?.emphasize?.length) {
    for (const target of pr.emphasize) {
      promptRequestEffects.push({
        field: "emphasize",
        request: target,
        status: "level_ignored",
      });
    }
  }
  if (pr?.confusion_points?.length) {
    const shown = levelIsL0
      ? 0
      : levelIsL2
        ? policy.max_confusion_points
        : 1;
    pr.confusion_points.forEach((point, index) => {
      promptRequestEffects.push({
        field: "confusion_points",
        request: point,
        status: levelIsL0
          ? "level_ignored"
          : index < shown
            ? "applied"
            : "capped",
      });
    });
  }

  // v2.14: emphasize is a pure reorder (zero token overhead) — the matched
  // items are MOVED to the Critical Context section, not duplicated. Filter
  // them out of the source arrays before section rendering; unmatched
  // emphasizes are dropped (nothing to reorder → nothing rendered).
  // v3.2.1: hard constraints and success criteria live in BOTH their own
  // sections (Active Hard Constraints / Success Criteria) and the active
  // constraint list (loop-compiler merges objective.hard_constraints and
  // success_criteria into constraints_active), so they must be filtered
  // from BOTH sources too — otherwise the emphasized item renders twice.
  const emphasizedSet = new Set(emphasized);
  const stateForSections = emphasizedSet.size > 0
    ? {
        ...input.state,
        activeConstraints: input.state.activeConstraints.filter((item) => !emphasizedSet.has(item)),
        hardConstraints: input.state.hardConstraints.filter((item) => !emphasizedSet.has(item)),
        successCriteria: input.state.successCriteria.filter((item) => !emphasizedSet.has(item)),
        blockers: input.state.blockers.filter((item) => !emphasizedSet.has(item)),
      }
    : input.state;
  const sections = selectSections({ ...input, state: stateForSections });
  // The ID attached here comes from the ORIGINAL state: emphasize moved the
  // item out of its source section, so this is the only renderer for it.
  const emphasizedItems = emphasized.map((text) => ({
    text,
    id: normativeIdForText(input.state, text),
  }));
  const criticalContextText = renderCriticalContext(emphasizedItems);

  // v3.8.1: no presentation snapshot. The artifact records what THIS prompt
  // rendered (level, hashes, round identity, the sections it emitted) and
  // nothing about what a LATER prompt should do differently — a prompt's
  // content must follow from committed facts, not from what the previous
  // prompt happened to show.

  // Inject confusion alerts into the header area (before mandatory sections)
  const fixedText = header + confusionText;

  // Inject critical context as a mandatory section
  let augmentedSections = sections;
  if (criticalContextText) {
    augmentedSections = [
      {
        id: "critical_context",
        text: criticalContextText,
        mandatory: true,
        coverageIds: emphasizedItems.flatMap((item) => item.id ? [item.id] : []),
      },
      ...sections,
    ];
  }

  const sectionBudget = budget - footer.length;
  const selected = renderWithinBudget(augmentedSections, fixedText, sectionBudget);
  const renderedPrompt = selected.rendered + footer;
  const promptHash = createHash("sha256").update(renderedPrompt).digest("hex");

  // v3.9.4: coverage is derived from the ORIGINAL state and the sections that
  // actually rendered. It is not text-scanned and not a second fact source.
  // An incomplete projection fails closed — no prompt or artifact escapes.
  const active = activeNormativeIds(input.state, input.recoveryBrief);
  const declaredIds = new Set<string>();
  for (const section of augmentedSections) {
    for (const id of section.coverageIds) declaredIds.add(id);
  }
  const renderedIds = new Set<string>();
  for (const sectionId of selected.included) {
    const section = augmentedSections.find((entry) => entry.id === sectionId);
    if (!section) continue;
    for (const id of section.coverageIds) renderedIds.add(id);
  }
  const coverage = derivePromptCoverage({
    active,
    rendered: renderedIds,
    declared: declaredIds,
  });
  assertPromptCoverage(coverage);

  return {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
    roundId: `loop:${input.state.loopId}:round:${input.state.round}`,
    round: input.state.round,
    attempt,
    level: input.level,
    renderedPrompt,
    promptHash,
    stateHash,
    // v3.8.1: the artifact records what THIS prompt did — which sections it
    // emitted, which the budget rule dropped, and whether the protected set
    // overflowed. It records nothing about what a later prompt should do.
    sections: selected.included,
    droppedSections: selected.dropped,
    protectedOverflow: selected.protectedOverflow,
    budget: sectionBudget,
    renderedChars: selected.rendered.length,
    promptRequestEffects,
    coverage,
  };
}
