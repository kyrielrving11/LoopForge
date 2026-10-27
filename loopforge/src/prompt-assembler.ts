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
  formatActiveSubGoals,
  formatCriterionRows,
  formatRoundContractWithIds,
  constraintProvenanceLabel,
  hashCanonicalState,
  partitionActiveConstraints,
} from "./canonical-state.js";
import type {
  PromptArtifact,
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
  deriveFindingId,
  deriveItemId,
  normalizeText,
} from "./token-utils.js";
import { verificationActionFor } from "./verification-actions.js";
import { LOST_HANDLE_ROUTING } from "./recovery-guidance.js";
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

/** v3.9.7: the ONE finding renderer, shared by the Verification Gate, the L0
 *  retry section and Critical Context. The `f-` id is the stable handle the
 *  Agent can cite; the detail is a machine fact and the action is the one
 *  canonical short action from `verification-actions.ts`. */
export function verificationFlagLine(
  flag: CanonicalLoopState["verificationFlags"][number],
  level?: "l0" | "l1" | "l2",
): string {
  const icon = flag.severity === "error"
    ? "🚫"
    : flag.severity === "warn" ? "⚠️" : "ℹ️";
  const ref = flag.ref ? ` [ref: \`${flag.ref}\`]` : "";
  const base = `- [\`${deriveFindingId(flag)}\`] ${icon} [${flag.check}] ` +
    `\`${flag.field}\` — ${flag.detail}${ref}`;
  if (level === "l0" || flag.severity === "info") return base;
  const label = flag.severity === "error" ? "Fix" : "Action";
  return `${base}\n  → ${label}: ${verificationActionFor(flag.check)}`;
}

function verificationText(
  state: CanonicalLoopState,
  level?: "l0" | "l1" | "l2",
): string {
  const lines = state.verificationFlags.map((flag) =>
    verificationFlagLine(flag, level));
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
    const meta = state.constraintMetadata.find((entry) => entry.text === text);
    const violated = meta?.last_violated_at_round === state.round;
    return `- [\`${identityForText(state, text)}\`] ${text}` +
      constraintProvenanceLabel(meta) +
      (violated ? " (violated this round)" : "");
  }).join("\n");
}

/** v4.0.1: the active normative id set coverage must prove. The set is
 *  derived directly from the canonical state; sections render independently
 *  and declare the ids they emitted. There is no prompt-request movement any
 *  more, so a second "normative object" representation is unnecessary. */
function activeNormativeIds(
  state: CanonicalLoopState,
  _level: "l0" | "l1" | "l2",
  recoveryBrief?: ReadonlyArray<string>,
): ActiveNormativeId[] {
  const out: ActiveNormativeId[] = [];
  const partition = partitionActiveConstraints(state);
  for (const text of [...partition.hard, ...partition.other]) {
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
    if (subGoal.status === "done" || subGoal.status === "canceled") continue;
    out.push({ id: subGoal.id, kind: "subgoal" });
  }
  for (const flag of state.verificationFlags) {
    out.push({ id: deriveFindingId(flag), kind: "finding" });
  }
  const brief = state.recoveryBrief ?? recoveryBrief;
  if (brief && brief.length > 0) out.push({ id: "recovery", kind: "recovery" });

  const rank: Record<CoverageKind, number> = {
    recovery: 0,
    contract: 1,
    contract_item: 2,
    criterion: 3,
    constraint: 4,
    subgoal: 5,
    finding: 6,
  };
  const byId = new Map<string, ActiveNormativeId>();
  for (const object of out) {
    const existing = byId.get(object.id);
    if (!existing || rank[object.kind] < rank[existing.kind]) {
      byId.set(object.id, object);
    }
  }
  return [...byId.values()].sort((left, right) =>
    rank[left.kind] - rank[right.kind] ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
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
  const hard = partition.hard;
  const other = partition.other;
  const criteriaTexts = state.successCriteria;
  const sections: Section[] = [
    {
      id: "objective",
      text: section("Objective", state.objective),
      mandatory: true,
      coverageIds: [],
    },
  ];

  if (state.roundContract) {
    const formatted = formatRoundContractWithIds(
      state.roundContract,
      state.contractItemStatuses ?? null,
    );
    sections.push({
      id: "current_task",
      text: section("Current Task", formatted.text),
      mandatory: true,
      coverageIds: formatted.emittedIds,
    });
  } else {
    sections.push({
      id: "current_task",
      text: section("Current Task", state.currentTask),
      mandatory: true,
      coverageIds: [],
    });
  }

  const criteria = formatCriterionRows(
    state.criterionStatuses,
    criteriaTexts,
  );
  if (criteria.lines.length > 0) {
    sections.push({
      id: "criteria",
      text: section("Success Criteria", criteria.lines.join("\n")),
      mandatory: true,
      coverageIds: criteria.ids,
    });
  }
  if (hard.length > 0) {
    sections.push({
      id: "hard_constraints",
      text: section(
        "Active Hard Constraints",
        constraintLines(state, hard),
      ),
      mandatory: true,
      coverageIds: hard.map((text) => identityForText(state, text)),
    });
  }
  if (other.length > 0) {
    sections.push({
      id: "active_constraints",
      text: section(
        "Active Constraints",
        constraintLines(state, other),
      ),
      mandatory: true,
      coverageIds: other.map((text) => identityForText(state, text)),
    });
  }
  if (state.subGoals.length > 0) {
    const subGoals = formatActiveSubGoals(
      state.subGoals,
      state.round,
    );
    sections.push({
      id: "sub_goals",
      text: section("Active Sub-Goals", subGoals.lines.join("\n")),
      mandatory: true,
      coverageIds: subGoals.ids,
    });
  }
  const brief = state.recoveryBrief ?? recoveryBrief;
  if (brief && brief.length > 0) {
    sections.push({
      id: "recovery",
      text: section("Recovery Brief", brief.join("\n")),
      mandatory: true,
      coverageIds: ["recovery"],
    });
  }
  const findings = state.verificationFlags;
  if (findings.length > 0) {
    sections.push({
      id: "verification",
      text: section(
        "Verification Gate",
        verificationText({ ...state, verificationFlags: findings }, level),
      ),
      mandatory: true,
      coverageIds: findings.map((flag) => deriveFindingId(flag)),
    });
  }
  return sections;
}

/** v3.9.7: the enforcement notice is a protected protocol fact, not an
 *  optional narrative. It renders at every level and is never budget-dropped.
 *  Findings stay in the mandatory Verification Gate; this section does not
 *  repeat their full detail. */
function retryRequirementsSection(
  state: CanonicalLoopState,
  level: "l0" | "l1" | "l2",
): Section | null {
  const parts: string[] = [];
  if (state.rejectionNotice) parts.push(state.rejectionNotice.trim());
  if (level === "l0" && state.blockers.length > 0) {
    parts.push(bullets(state.blockers));
  }
  if (parts.length === 0) return null;
  return {
    id: "retry_requirements",
    text: section("Retry Requirements", parts.join("\n\n")),
    mandatory: true,
    coverageIds: [],
  };
}

function l0Sections(
  state: CanonicalLoopState,
  recoveryBrief?: ReadonlyArray<string>,
): Section[] {
  const sections = commonMandatorySections(state, "l0", recoveryBrief);
  const retry = retryRequirementsSection(state, "l0");
  if (retry) sections.push(retry);
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
  const retry = retryRequirementsSection(state, "l1");
  if (retry) sections.push(retry);
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
  const retry = retryRequirementsSection(state, "l2");
  if (retry) sections.push(retry);
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
  return sections;
}

function selectSections(
  input: PromptAssemblyInput,
): Section[] {
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
  // ── optional current-governance / anchor sections ───────────────────────
  blockers: 20,
  corrections: 21,
  active_warnings: 25,
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
    "2. Call **`loopforge_next`** with the `submissionHandle` object returned",
    "   with the current prompt; never edit or reconstruct it. A",
    "   rejection keeps the logical round but returns a new handle; an invalid",
    "   evaluation keeps the same handle. Call **`loopforge_checkpoint`** with",
    "   the same handle to save an explicit mid-round checkpoint.",
    "   " + LOST_HANDLE_ROUTING + " An old handle never submits work.",
    "3. Use the JSON template below for `evaluation`.",
    "",
    evaluation,
  ].join("\n");

  const footer = [pointer, howToRespond].join("");

  const sections = selectSections(input);
  const fixedText = header;
  const sectionBudget = budget - footer.length;
  const selected = renderWithinBudget(sections, fixedText, sectionBudget);
  const renderedPrompt = selected.rendered + footer;
  const promptHash = createHash("sha256").update(renderedPrompt).digest("hex");

  // v3.9.4: coverage is derived from the ORIGINAL state and the sections that
  // actually rendered. It is not text-scanned and not a second fact source.
  // An incomplete projection fails closed — no prompt or artifact escapes.
  const active = activeNormativeIds(
    input.state,
    input.level,
    input.recoveryBrief,
  );
  const renderedIds = new Set<string>();
  for (const sectionId of selected.included) {
    const section = sections.find((entry) => entry.id === sectionId);
    if (!section) continue;
    for (const id of section.coverageIds) renderedIds.add(id);
  }
  const coverage = derivePromptCoverage({
    active,
    rendered: renderedIds,
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
    coverage,
  };
}
