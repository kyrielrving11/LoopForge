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
  activeSubGoalView,
  buildPhaseLine,
  hashCanonicalState,
  milestoneHeading,
} from "./canonical-state.js";
import type { PromptArtifact, PromptRequests } from "./protocol.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "./protocol.js";
import type {
  ConstraintMeta,
  RecurringFlag,
  SubGoal,
} from "./protocol.js";
import type {
  PromptLevel,
  PromptLevelReason,
} from "./prompt-policy.js";
import { deriveItemId, STABLE_ID_RE, normalizeText } from "./token-utils.js";
import { getPolicy } from "./policy.js";


export interface PromptBudgets {
  l0: number;
  l1: number;
  l2: number;
}

export const DEFAULT_PROMPT_BUDGETS: PromptBudgets = {
  l0: 3000,
  l1: 7000,
  l2: 18000,
};

export interface PromptAssemblyInput {
  state: CanonicalLoopState;
  level: PromptLevel;
  reasons: PromptLevelReason[];
  budgets?: Partial<PromptBudgets>;
  attempt?: number;
  selfEvaluationBlock: string;
  fullStateMarkdown?: string;
  /** v2.9: Model's information needs for this prompt. L0: ignored. */
  promptRequests?: PromptRequests;
}

interface Section {
  id: string;
  text: string;
  mandatory: boolean;
}

function section(title: string, body: string): string {
  return body.trim() ? `### ${title}\n${body.trim()}\n\n` : "";
}

function bullets(values: string[], prefix = "- "): string {
  return values.map((value) => `${prefix}${value}`).join("\n");
}

/** v2.11: Derive a stable item ID from text content.
 *  Same hash strategy as computeGoalTextHash in loop-compiler.ts. */
/** v2.11: Render a bullet list with ID prefixes for constraints/criteria.
 *  Each item gets a [prefix-XXXXXXXX] tag. Items that already look like IDs
 *  are rendered as-is. v3.8.1: IDs are always rendered — the
 *  `constraint_id_enabled` escape hatch is gone. */
function bulletsWithIds(values: string[], prefix: string): string {
  return values.map((v) => {
    const trimmed = v.trim();
    if (STABLE_ID_RE.test(trimmed)) {
      return `- [\`${trimmed}\`] ${trimmed}`;
    }
    const id = prefix + "-" + deriveItemId(trimmed);
    return `- [\`${id}\`] ${trimmed}`;
  }).join("\n");
}

/** v3.3.1: Render an identity-HETEROGENEOUS list — the merged active
 *  constraint set holds hard/plan/criteria/discovered texts together, so no
 *  single prefix fits. Each item's authoritative ID comes from constraint
 *  metadata (criteria texts carry cr-XXXXXXXX, everything else
 *  c-XXXXXXXX), keeping the active list in the same identity namespace as
 *  the item's own section — one text never renders under two prefixes in
 *  one prompt. Falls back to a c- derivation only when metadata is missing
 *  (defensive: metadata covers every active text by construction). */
function bulletsWithIdentities(
  values: string[],
  metadata: ConstraintMeta[],
): string {
  const idByText = new Map(metadata.map((meta) => [meta.text, meta.id]));
  return values.map((v) => {
    const trimmed = v.trim();
    if (STABLE_ID_RE.test(trimmed)) {
      return `- [\`${trimmed}\`] ${trimmed}`;
    }
    const id = idByText.get(trimmed) ?? `c-${deriveItemId(trimmed)}`;
    return `- [\`${id}\`] ${trimmed}`;
  }).join("\n");
}

/** v3.2: Short imperative fix/action per verification check, appended to the
 *  L1/L2 Verification Gate lines. Deliberately shorter than the rejection-
 *  prompt wording in enforcement-gate.ts; keys are the plain check-name
 *  strings (NOT imported from verification-gate.ts — it already imports
 *  loop-compiler, which imports this module, so importing back would cycle).
 *  Full coverage of every CHECK_* constant is enforced by a test that
 *  iterates the verification-gate module's CHECK_ exports (no hardcoded
 *  list — a new constant can never silently lack an action entry). */
const VERIFICATION_ACTIONS: Readonly<Record<string, string>> = {
  success_with_remaining_criteria:
    "Complete the remaining criteria before claiming success, or set success=false and report what remains.",
  success_without_verified_evidence:
    "Back the success claim with machine-verifiable evidence: run tests or a required verification command and report the actual output. If you genuinely performed no work, provide execution_report and declare no_change_reason.",
  outcome_success_contradiction:
    "Reconcile the declared outcome with the success flag and resubmit an honest evaluation.",
  blocked_without_blocker:
    "State the concrete blocker, or drop the blocked outcome.",
  retroactive_claim_bad_round:
    "Correct the referenced round number, or withdraw the retroactive claim.",
  retroactive_claim_unverified:
    "Provide evidence for the retroactive claim, or withdraw it.",
  duplicate_constraint_discovery:
    "Update the existing constraint entry instead of duplicating it.",
  recurring_violation:
    "Explain why this violation keeps recurring and try a different approach — do not repeat the failed strategy.",
  retract_fresh_constraint:
    "Justify the retraction explicitly, or restore the constraint.",
  evidence_integrity:
    "Correct the mismatch between your claims and the recorded evidence.",
  required_command_failed:
    "Re-run the required verification command and report its actual output before claiming success.",
  command_evidence_mismatch:
    "Report the true command output and reconcile the mismatch.",
  backtrack_workspace_not_restored:
    "Restore the skipped-round files and the expected git HEAD, then resubmit.",
  criteria_claims_unverified:
    "Provide evidence for each claimed success criterion.",
  // v3.3 — Round Contract checks (and the three v3.3 checks that predated
  // this table entry and fell back to the generic action).
  verification_entrypoint_modified:
    "Re-run the verification command on the changed entrypoint, or revert the entrypoint change and re-run.",
  test_files_modified:
    "Re-run the verification command after the test-file changes and report the fresh output.",
  round_scope_drift:
    "Revert the out-of-scope file changes, or close the active contract and declare the extended scope in a new proposal. Scope drift is a machine fact and is not waivable by explanation.",
  // v3.8 — item model: claimed-but-unverified debt
  contract_items_unverified:
    "Run the bound command(s) for each claimed item so they are observed passing, or report the item as remaining (or declare outcome=\"blocked\").",
  contract_premature:
    "The ACTIVE contract is still open — restate it unchanged to continue it; a different contract is ignored until every item is verified or the round reports blocked.",
  // v3.7.1 — opt-in gate layer: cited gates need an approved human decision
  user_gate_unresolved:
    "The round cites a high-risk action without an approved human decision. Run loopforge_gate_check, present the approval question, call loopforge_gate_resolve after the human decides, and resubmit with the approved gate id in evaluation.gate_ids.",
};

/** Fallback for unmapped check names (forward-compat with future checks). */
const VERIFICATION_ACTION_FALLBACK =
  "Re-examine the flagged claim and correct your evaluation before resubmitting.";

/** v3.2: The actionable instruction for a verification check. Exported for
 *  the coverage test (which imports the CHECK_* constants). */
export function verificationActionFor(check: string): string {
  return VERIFICATION_ACTIONS[check] ?? VERIFICATION_ACTION_FALLBACK;
}

function verificationText(
  state: CanonicalLoopState,
  level?: "l0" | "l1" | "l2",
): string {
  const lines = state.verificationFlags.map((flag) => {
    const icon = flag.severity === "error"
      ? "🚫"
      : flag.severity === "warn" ? "⚠️" : "ℹ️";
    const base = `- ${icon} [${flag.check}] ${flag.detail}`;
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

function activeNonHardConstraints(state: CanonicalLoopState): string[] {
  const hard = new Set(state.hardConstraints);
  return state.activeConstraints.filter((value) => !hard.has(value));
}

// ═══════════════════════════════════════════════════════════════════════════
// v3.2: L1 diff-collapse helpers
// ═══════════════════════════════════════════════════════════════════════════

/** v3.2: Stable ID of a constraint text as rendered by bulletsWithIds —
 *  metadata's own id when present, else the derived hash. */
function constraintIdOf(text: string, metadata: ConstraintMeta[]): string {
  const meta = metadata.find((m) => m.text === text);
  return meta?.id ?? `c-${deriveItemId(text)}`;
}


function commonMandatorySections(
  state: CanonicalLoopState,
  /** v2.11: L0 skips ID rendering to stay within tight budget. */
  level?: "l0" | "l1" | "l2",
): Section[] {
  const sections: Section[] = [
    {
      id: "objective",
      text: section("Objective", state.objective),
      mandatory: true,
    },
    {
      id: "current_task",
      text: section("Current Task", state.currentTask),
      mandatory: true,
    },
  ];

  if (state.hardConstraints.length > 0) {
    // v2.11: L0 uses plain bullets (tight budget); L1/L2 show constraint IDs
    const body = level === "l0"
      ? bullets(state.hardConstraints)
      : bulletsWithIds(state.hardConstraints, "c");
    sections.push({
      id: "hard_constraints",
      text: section("Active Hard Constraints", body),
      mandatory: true,
    });
  }
  if (state.verificationFlags.length > 0) {
    sections.push({
      id: "verification",
      text: section("Verification Gate", verificationText(state, level)),
      mandatory: true,
    });
  }
  return sections;
}

function l0Sections(state: CanonicalLoopState): Section[] {
  const retryRequirements = [
    ...state.blockers,
    ...state.verificationFlags.map((flag) => flag.detail),
  ];
  const sections = commonMandatorySections(state, "l0");
  if (retryRequirements.length > 0) {    sections.push({
      id: "retry_requirements",
      text: section("Retry Requirements", bullets(retryRequirements)),
      mandatory: true,
    });
  }
  if (state.changesSinceLastRound.length > 0) {
    sections.push({
      id: "changes",
      text: section("New Evidence / Changes", bullets(state.changesSinceLastRound)),
      mandatory: false,
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
): Section[] {
  const sections = commonMandatorySections(state, "l1");
  const active = activeNonHardConstraints(state);
  if (state.changesSinceLastRound.length > 0) {
    sections.push({
      id: "changes",
      text: section("Changes Since Last Round", bullets(state.changesSinceLastRound)),
      mandatory: false,
    });
  }
  // v3.8.1: Active Constraints render IN FULL. v3.2 folded unchanged items
  // into "… N unchanged constraints (see state file)" pointer lines, which
  // made the prompt's content depend on what the PREVIOUS prompt happened to
  // show rather than on committed facts — and those pointer lines fed the
  // prompt hash. The fold needed the previous round's persisted presentation
  // snapshot, which is deleted.
  if (active.length > 0) {
    // The one thing the folded branch carried that a plain bullet list does
    // not: the machine fact that this round broke the constraint. Kept so the
    // annotation is not lost along with the fold.
    const lines = active.map((text) => {
      const violated = state.constraintMetadata.find((m) => m.text === text)
        ?.last_violated_at_round === state.round;
      return `- [\`${constraintIdOf(text, state.constraintMetadata)}\`] ${text}` +
        (violated ? " (violated this round)" : "");
    });
    sections.push({
      id: "active_constraints",
      text: section("Active Constraints / Success Criteria", lines.join("\n")),
      mandatory: false,
    });
  }
  if (state.remainingCriteria.length > 0) {
    sections.push({
      id: "remaining",
      text: section("Remaining", bulletsWithIds(state.remainingCriteria, "cr")),
      mandatory: false,
    });
  }
  if (state.blockers.length > 0) {
    sections.push({
      id: "blockers",
      text: section("Blockers", bullets(state.blockers)),
      mandatory: false,
    });
  }
  // v2.2: Sub-Goal Dashboard (compact — L1). v3.7.1: only ACTIVE items
  // (pending/in_progress/blocked) enter the view; done/canceled never render
  // as rows. v3.8.1: rendered in full — the unchanged-count fold is gone.
  const view = activeSubGoalView(state.subGoals, Number.POSITIVE_INFINITY);
  const activeSubs = view.active;
  if (activeSubs.length > 0) {
    const iconOf = (sg: SubGoal): string =>
      sg.status === "in_progress" ? "🔄" : sg.status === "blocked" ? "🚫" : "⏳";
    const maxShow = 5;
    const items = activeSubs.slice(0, maxShow).map((sg) =>
      `${iconOf(sg)} [\`${sg.id}\`] ${sg.description}`);
    if (activeSubs.length > maxShow) {
      items.push(`... and ${activeSubs.length - maxShow} more`);
    }
    sections.push({
      id: "sub_goals",
      text: section("Active Sub-Goals", items.join("\n")),
      mandatory: false,
    });
  }
  if (state.discoveries.length > 0) {
    sections.push({
      id: "discoveries",
      text: section("New Discoveries", bullets(state.discoveries)),
      mandatory: false,
    });
  }
  // v3.2: Recent Rounds. v3.8.1: rendered in full — the keep-newest-N fold and
  // its milestone-boundary exception are gone.
  if (state.rollingOutcomes.length > 0) {
    sections.push({
      id: "rolling_outcomes",
      text: section("Recent Rounds", bullets(state.rollingOutcomes)),
      mandatory: false,
    });
  }
  // v3.2: L1 also renders the explicit external context (previously L2-only).
  // Placed after the changes delta, within the soft budget.
  if (state.externalContext) {
    sections.push({
      id: "external_context",
      text: section("External Context", state.externalContext),
      mandatory: false,
    });
  }
  // v3.8.1: one compact phase line, not the Roadmap prose.
  const l1Phase = buildPhaseLine(state);
  if (l1Phase) {
    sections.push({
      id: "phase",
      text: section("Phase", l1Phase),
      mandatory: false,
    });
  }
  // v3.8.1: Active Warnings — the recent tail of the ONE recurring-fact
  // derivation. It replaces two prompt sections ("Recurring Issues", fed by
  // the last 5 rounds' raw violations with no threshold, and "Lessons
  // Learned", fed by the whole-history count >= 2 view) that were two windows
  // over one fact set. What the agent needs in the prompt is the recent tail;
  // the full recurring set lives in the state file.
  const warnings = activeWarnings(state.recurringFlags, state.round);
  if (warnings) {
    sections.push({
      id: "active_warnings",
      text: section("Active Warnings", warnings),
      mandatory: false,
    });
  }
  return sections;
}

function l2Sections(
  state: CanonicalLoopState,
  fullStateMarkdown?: string,
): Section[] {
  const sections = commonMandatorySections(state, "l2");
  const fullState = fullStateMarkdown?.trim();
  if (fullState) {
    sections.push({
      id: "full_state",
      text: section("Full Rehydrated State", fullState),
      mandatory: false,
    });
    return sections;
  }

  // v2.11: Groups with an idPrefix use ID-aware rendering; others use plain bullets.
  const groups: Array<[string, string, string[], string | null]> = [
    ["success_criteria", "Success Criteria", state.successCriteria, "cr"],
    ["active_constraints", "Active Constraints", activeNonHardConstraints(state), "c"],
    ["changes", "Changes Since Last Round", state.changesSinceLastRound, null],
    ["remaining", "Remaining", state.remainingCriteria, "cr"],
    ["blockers", "Blockers", state.blockers, null],
    ["discoveries", "Discoveries", state.discoveries, null],
    ["rolling_outcomes", "Cross-Round Outcomes", state.rollingOutcomes, null],
    ["failed_patterns", "Failed Patterns", state.failedPatterns, null],
  ];
  for (const [id, title, values, idPrefix] of groups) {
    if (values.length === 0) continue;
    // v3.3.1: the active set is identity-heterogeneous (hard/plan/criteria/
    // discovered merged) — render through constraint metadata so criteria
    // texts keep their cr- identity here too (same namespace as their own
    // Success Criteria section). Every other group is homogeneous and keeps
    // its single-prefix renderer.
    const body = id === "active_constraints"
      ? bulletsWithIdentities(values, state.constraintMetadata)
      : idPrefix
        ? bulletsWithIds(values, idPrefix)
        : bullets(values);
    sections.push({ id, text: section(title, body), mandatory: false });
  }
  // v3.8.1: Active Warnings — the recent tail of the ONE recurring-fact
  // derivation (see l1Sections). The whole-history recurring set is the state
  // file's job; L2 shows the same recent slice as L1 so the two levels cannot
  // tell different stories about what is going wrong right now.
  const warnings = activeWarnings(state.recurringFlags, state.round);
  if (warnings) {
    sections.push({
      id: "active_warnings",
      text: section("Active Warnings", warnings),
      mandatory: false,
    });
  }
  // v3.8.1: one compact phase line, not the Roadmap prose — rendered right
  // before the (backward-looking) Phase History so the agent sees where it is
  // before where it has been.
  const l2Phase = buildPhaseLine(state);
  if (l2Phase) {
    sections.push({
      id: "phase",
      text: section("Phase", l2Phase),
      mandatory: false,
    });
  }
  if (state.milestones.length > 0) {
    const milestoneText = state.milestones
      .map((m) => {
        const lines = [
          milestoneHeading(m),
          `  Outcome: ${m.outcome}`,
        ];
        if (m.resolved_constraints.length > 0) {
          lines.push(`  Resolved: ${m.resolved_constraints.slice(0, 3).join("; ")}`);
        }
        return lines.join("\n");
      })
      .join("\n\n");
    sections.push({
      id: "milestones",
      text: section("Phase History", milestoneText),
      mandatory: false,
    });
  }
  if (state.subGoals.length > 0) {
    // v3.7.1: active-only rows ordered blocked → in_progress → pending
    // (priority asc, recently changed first), capped by policy; done and
    // canceled appear only in the stats line.
    const cap = getPolicy().evolution.max_active_subgoals;
    const view = activeSubGoalView(state.subGoals, cap);
    const lines: string[] = [];
    for (const sg of view.active) {
      if (sg.status === "in_progress") {
        lines.push(`🔄 [\`${sg.id}\`] ${sg.description} (since R${sg.status_changed_at_round})`);
      } else if (sg.status === "blocked") {
        lines.push(`🚫 [\`${sg.id}\`] ${sg.description} (blocked since R${sg.status_changed_at_round})`);
      } else {
        const age = state.round - sg.declared_at_round;
        const stale = age >= 10 ? " ⚠️ stale" : "";
        lines.push(`⏳ [\`${sg.id}\`] ${sg.description} (pending ${age} rounds)${stale}`);
      }
    }
    // Stats line (full counts — rows may be capped)
    lines.push(
      `─── ${view.total} total: ${view.activeTotal} active, ${view.done} done, ${view.canceled} canceled`,
    );

    sections.push({
      id: "sub_goals_full",
      text: section("Sub-Goal Dashboard", lines.join("\n")),
      mandatory: false,
    });
  }
  if (state.externalContext) {
    sections.push({
      id: "external_context",
      text: section("External Context", state.externalContext),
      mandatory: false,
    });
  }

  // ── v2.8: Path B gap fills (previously only in full state markdown) ──

  // v3.8.1: the L2 Progress Dashboard and Round Stats sections are gone.
  // The dashboard was `criterionStatuses` re-composed into a table and mixed
  // with the agent’s OWN completion estimate and test counts; Round Stats
  // re-listed per-round files and progress deltas, both self-reported. The
  // criterion list and the machine git/criteria rows still render in the
  // state file, where a human or external tool reads them — the prompt keeps
  // only the current round’s own facts.

  // Retired Constraints
  if (state.retiredConstraints.length > 0) {
    const lines = state.retiredConstraints.map((c) => `- ~${c}~ (retired)`);
    sections.push({
      id: "retired_constraints",
      text: section("Retired Constraints", lines.join("\n")),
      mandatory: false,
    });
  }

  return sections;
}

function selectSections(input: PromptAssemblyInput): Section[] {
  if (input.level === "l0") return l0Sections(input.state);
  if (input.level === "l1") return l1Sections(input.state);
  return l2Sections(input.state, input.fullStateMarkdown);
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
  // ── protected ───────────────────────────────────────────────────────────
  objective: 0,
  current_task: 1,
  hard_constraints: 2,
  verification: 3,
  retry_requirements: 4,
  // Zero-token pure reorder, but it is the ONLY place emphasized items render
  // (they are MOVED out of their source sections), so dropping it would delete
  // them rather than just deprioritize them.
  critical_context: 5,
  // ── optional, most to least important ───────────────────────────────────
  success_criteria: 10,
  active_constraints: 11,
  remaining: 12,
  sub_goals: 13,
  blockers: 14,
  changes: 15,
  discoveries: 16,
  rolling_outcomes: 17,
  phase: 18,
  active_warnings: 19,
  external_context: 20,
  failed_patterns: 21,
  retired_constraints: 22,
  milestones: 23,
  sub_goals_full: 24,
  full_state: 25,
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
): string[] {
  if (targets.length === 0 || candidates.length === 0) return [];
  const matched: string[] = [];
  for (const candidate of candidates) {
    const candidateText = normalizeText(candidate);
    const hit = targets.some((target) => {
      const idMatch = target.match(STABLE_ID_RE);
      if (idMatch) {
        return `${idMatch[1]}-${deriveItemId(candidate)}` === target;
      }
      return normalizeText(target) === candidateText;
    });
    if (hit) matched.push(candidate);
  }
  // Candidate order, capped — deterministic, and no score to sort by.
  return matched.slice(0, cap);
}

/** Render the "Confusion Alerts" section that appears at the prompt top.
 *
 *  v3.8.1: the points are echoed back, truncated and capped — nothing more.
 *  The compiler used to score each point against eight section keywords with
 *  Jaccard similarity and point at the argmax. That pointer was both a
 *  similarity verdict and, in practice, nearly always wrong: "I don't
 *  understand milestone tracking" scores 1/8 = 0.125 against the keyword
 *  `milestone`, below the 0.15 default, so it fell through to the generic
 *  line anyway. The agent names the state file itself; the prompt does not
 *  guess where to look. */
function renderConfusionAlerts(
  points: string[],
  fullDensity: boolean,
): string {
  if (points.length === 0) return "";
  const lines: string[] = [
    "## ⚠️ Confusion Alerts",
    "",
    "You flagged these as confusing in the previous round.",
    "Address each before proceeding — the state file has full context.",
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
    lines.push("  → Read the full state file for relevant context.");
    lines.push("");
  }

  if (!fullDensity && points.length > 1) {
    lines.push(`*… and ${points.length - 1} more confusion point(s) — see state file.*`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Render the "Critical Context" section — items the model emphasized.
 *  Pulled from active constraints, discoveries, and blocking issues. */
function renderCriticalContext(emphasized: string[]): string {
  if (emphasized.length === 0) return "";
  const lines: string[] = [
    "## 🔴 Critical Context",
    "",
    "You flagged these as important for this round. Prioritize them.",
    "",
  ];
  for (const item of emphasized) {
    lines.push(`- ${item}`);
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
  const readInstruction = needsFullContext && stateFilePath
    ? [
        "",
        "> ⚠️ **Read the full state file before acting.** The summary below is a",
        "> capsule. The durable state file contains complete phase history,",
        "> sub-goal dashboard, constraint lifecycle, and agent trust data.",
        "> Conversation history may be incomplete after compaction or session",
        "> resume — the state file is the source of truth.",
        "",
      ].join("\n")
    : "";

  const header = [
    `## LoopForge Round ${input.state.round}`,
    `State: ${stateHash.slice(0, 12)} | Level: ${input.level.toUpperCase()} | Attempt: ${attempt}`,
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
    "1. Execute the task described above. Do NOT generate another prompt or plan — act.",
    "2. When finished, call the MCP tool **`loopforge_next`** with these parameters:",
    "   - `sessionId`: the session ID from `loopforge_start`.",
    "   - `evaluation`: a structured self-assessment object (see schema below).",
    "",
    "### Evaluation Rules",
    "",
    "- `success`: Set to **`true` ONLY** when ALL hard constraints are met AND",
    "  the task goal is fully achieved. If anything remains incomplete, set `false`.",
    "- `should_continue`: Set to **`false` ONLY** when the ENTIRE loop task is done.",
    "  Partial progress or completed subtasks → `true`.",
    "- `constraint_violations`: Be honest. List every constraint you actually violated.",
    "- `execution_report.files_changed`: List files you modified — used for verification.",
    "- `execution_report.tests_reported`: Report actual test runner output.",
    "- `progress_estimate`: A number 0.0–1.0 reflecting overall task completion.",
    "",
    "### If the Prompt Says \"REJECTED\"",
    "",
    "- Re-execute the **same round**. Do NOT advance the round counter.",
    "- Read the Required Fix section, address every issue, then submit again.",
    "- Use `loopforge_next` with a corrected evaluation.",
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
    ? renderConfusionAlerts(pr.confusion_points, levelIsL2)
    : "";

  // Emphasize: L1/L2 only, matched against active state items
  const policy = getPolicy().prompt;
  const emphasizeCap = levelIsL2 ? policy.max_emphasize_l2 : policy.max_emphasize_l1;
  const emphasized = (!levelIsL0 && pr?.emphasize?.length)
    ? matchEmphasize(
        pr.emphasize,
        [
          ...input.state.activeConstraints,
          ...input.state.discoveries,
          ...input.state.blockers,
          ...input.state.changesSinceLastRound,
        ],
        emphasizeCap,
      )
    : [];

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
        discoveries: input.state.discoveries.filter((item) => !emphasizedSet.has(item)),
        blockers: input.state.blockers.filter((item) => !emphasizedSet.has(item)),
        changesSinceLastRound: input.state.changesSinceLastRound.filter((item) => !emphasizedSet.has(item)),
      }
    : input.state;
  const sections = selectSections({ ...input, state: stateForSections });
  const criticalContextText = renderCriticalContext(emphasized);

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
      },
      ...sections,
    ];
  }

  const sectionBudget = budget - footer.length;
  const selected = renderWithinBudget(augmentedSections, fixedText, sectionBudget);
  const renderedPrompt = selected.rendered + footer;
  const promptHash = createHash("sha256").update(renderedPrompt).digest("hex");

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
  };
}
