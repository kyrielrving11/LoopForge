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
import type { CanonicalLoopState, PresentedStateSnapshot } from "./canonical-state.js";
import {
  activeSubGoalView,
  buildRoadmap,
  hashCanonicalState,
  milestoneHeading,
  trustBarLine,
} from "./canonical-state.js";
import type { PromptArtifact, PromptRequests } from "./protocol.js";
import type { ConstraintMeta, MilestoneSummary, SubGoal } from "./protocol.js";
import type {
  PromptLevel,
  PromptLevelReason,
} from "./prompt-policy.js";
import { deriveItemId, STABLE_ID_RE, jaccardSimilarity } from "./token-utils.js";
import { getPolicy } from "./policy.js";

export const PROMPT_ARTIFACT_SCHEMA_VERSION = 1 as const;

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
  /** v3.2: Previous round's L1 presentation (persisted diff baseline).
   *  When present, L1 collapses unchanged content against it. */
  presentedBaseline?: PresentedStateSnapshot | null;
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
 *  are rendered as-is. When constraint_id_enabled is false, renders plain bullets. */
function bulletsWithIds(values: string[], prefix: string): string {
  const idEnabled = getPolicy().evolution.constraint_id_enabled;
  if (!idEnabled) return bullets(values);
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
  const idEnabled = getPolicy().evolution.constraint_id_enabled;
  if (!idEnabled) return bullets(values);
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

/** v3.2: Collapse only when at least this many items are unchanged — a tiny
 *  unchanged set renders in full (nothing worth saving). */
export const COLLAPSE_MIN_UNCHANGED = 3;
/** v3.2: Recent-rounds items kept in full when older ones collapse. */
export const KEEP_RECENT_ROUNDS = 3;

/** v3.2: Stable ID of a constraint text as rendered by bulletsWithIds —
 *  metadata's own id when present, else the derived hash. */
function constraintIdOf(text: string, metadata: ConstraintMeta[]): string {
  const meta = metadata.find((m) => m.text === text);
  return meta?.id ?? `c-${deriveItemId(text)}`;
}

export interface ConstraintDiff {
  /** Constraint texts to render in full (new or violated this round). */
  changed: string[];
  /** Same-ID items unchanged since the baseline. */
  unchangedCount: number;
  /** Baseline items absent now, excluding emphasized items (they were moved
   *  to Critical Context, not demoted). */
  removedCount: number;
}

export function diffConstraints(
  baseline: PresentedStateSnapshot | null,
  activeTexts: string[],
  metadata: ConstraintMeta[],
  round: number,
  emphasized: Set<string>,
): ConstraintDiff {
  if (!baseline) return { changed: activeTexts, unchangedCount: 0, removedCount: 0 };
  const baselineIds = new Set(baseline.constraintIds);
  const currentIds = new Set(activeTexts.map((text) => constraintIdOf(text, metadata)));
  const changed: string[] = [];
  let unchangedCount = 0;
  for (const text of activeTexts) {
    const id = constraintIdOf(text, metadata);
    const violatedThisRound = metadata.find((m) => m.text === text)
      ?.last_violated_at_round === round;
    if (!baselineIds.has(id) || violatedThisRound) changed.push(text);
    else unchangedCount++;
  }
  let removedCount = 0;
  if (emphasized.size > 0) {
    const emphasizedIds = new Set([...emphasized].map((text) => constraintIdOf(text, metadata)));
    for (const id of baselineIds) {
      if (!currentIds.has(id) && !emphasizedIds.has(id)) removedCount++;
    }
  } else {
    for (const id of baselineIds) {
      if (!currentIds.has(id)) removedCount++;
    }
  }
  return { changed, unchangedCount, removedCount };
}

export interface SubGoalDiff {
  /** Sub-goals to render in full (new or status transition). */
  changed: SubGoal[];
  unchangedCount: number;
  /** Baseline sub-goals no longer in the active set (done/canceled/blocked). */
  removedCount: number;
}

export function diffSubGoals(
  baseline: PresentedStateSnapshot | null,
  activeSubs: SubGoal[],
): SubGoalDiff {
  if (!baseline) return { changed: activeSubs, unchangedCount: 0, removedCount: 0 };
  const baselineById = new Map(baseline.subGoals);
  const currentIds = new Set(activeSubs.map((sg) => sg.id));
  const changed: SubGoal[] = [];
  let unchangedCount = 0;
  for (const sg of activeSubs) {
    const prevStatus = baselineById.get(sg.id);
    if (prevStatus === undefined || prevStatus !== sg.status) changed.push(sg);
    else unchangedCount++;
  }
  let removedCount = 0;
  for (const [id] of baseline.subGoals) {
    if (!currentIds.has(id)) removedCount++;
  }
  return { changed, unchangedCount, removedCount };
}

/** v3.2: True when a milestone boundary was crossed since the baseline —
 *  the Recent Rounds section then renders in full (a phase ended). */
export function milestoneBoundaryChanged(
  baseline: PresentedStateSnapshot | null,
  milestones: MilestoneSummary[],
): boolean {
  if (!baseline) return false;
  const baselineRanges = new Set(
    baseline.milestoneRanges.map(([s, e]) => `${s}:${e}`),
  );
  return milestones.some(
    (m) => !baselineRanges.has(`${m.round_range.start}:${m.round_range.end}`),
  );
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

function l1Sections(
  state: CanonicalLoopState,
  baseline: PresentedStateSnapshot | null,
  emphasized: Set<string>,
): Section[] {
  const sections = commonMandatorySections(state, "l1");
  const active = activeNonHardConstraints(state);
  // L7: collapse needs the state file — its collapse line points at the file
  // for the full content. With the file disabled (stateFilePath empty),
  // collapsing would silently truncate the prompt's constraints view.
  const collapseEnabled = getPolicy().prompt.l1_collapse_enabled &&
    state.stateFilePath.length > 0;
  if (state.changesSinceLastRound.length > 0) {
    sections.push({
      id: "changes",
      text: section("Changes Since Last Round", bullets(state.changesSinceLastRound)),
      mandatory: false,
    });
  }
  // v3.2: Active Constraints — collapse unchanged items against the previous
  // round's presentation; new and violated-this-round constraints render in
  // full. The collapse line points at the state file (regenerated every
  // round), so no information is lost — only presentation is compacted.
  if (active.length > 0) {
    const diff = diffConstraints(
      baseline, active, state.constraintMetadata, state.round, emphasized,
    );
    const renderFull = !collapseEnabled || !baseline
      || diff.unchangedCount < COLLAPSE_MIN_UNCHANGED;
    if (renderFull) {
      sections.push({
        id: "active_constraints",
        text: section(
          "Active Constraints / Success Criteria",
          bulletsWithIdentities(active, state.constraintMetadata),
        ),
        mandatory: false,
      });
    } else {
      const lines = diff.changed.map((text) => {
        const id = constraintIdOf(text, state.constraintMetadata);
        const violated = state.constraintMetadata.find((m) => m.text === text)
          ?.last_violated_at_round === state.round;
        const suffix = violated ? " (violated this round)" : " (new this round)";
        return `- [\`${id}\`] ${text}${suffix}`;
      });
      lines.push(
        `- … ${diff.unchangedCount} unchanged constraints, ${diff.removedCount} demoted since R${baseline.round} (see state file)`,
      );
      sections.push({
        id: "active_constraints",
        text: section("Active Constraints / Success Criteria", lines.join("\n")),
        mandatory: false,
      });
    }
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
  // v2.2: Sub-Goal Dashboard (compact — L1). v3.2: unchanged sub-goals
  // collapse to a count line; new/transitioned ones render in full.
  // v3.7.1: only ACTIVE items (pending/in_progress/blocked) enter the view;
  // done/canceled never render as rows.
  const view = activeSubGoalView(state.subGoals, Number.POSITIVE_INFINITY);
  const activeSubs = view.active;
  if (activeSubs.length > 0) {
    const iconOf = (sg: SubGoal): string =>
      sg.status === "in_progress" ? "🔄" : sg.status === "blocked" ? "🚫" : "⏳";
    const diff = diffSubGoals(baseline, activeSubs);
    const renderFull = !collapseEnabled || !baseline
      || diff.unchangedCount < COLLAPSE_MIN_UNCHANGED;
    if (renderFull) {
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
    } else {
      const transitionCount = diff.changed.filter((sg) => {
        const prev = baseline.subGoals.find(([id]) => id === sg.id);
        return prev !== undefined && prev[1] !== sg.status;
      }).length;
      const items = diff.changed.slice(0, 5).map((sg) =>
        `${iconOf(sg)} [\`${sg.id}\`] ${sg.description}`);
      items.push(
        `- … ${diff.unchangedCount} unchanged sub-goals, ${transitionCount + diff.removedCount} changed since R${baseline.round} (see state file)`,
      );
      sections.push({
        id: "sub_goals",
        text: section("Active Sub-Goals", items.join("\n")),
        mandatory: false,
      });
    }
  }
  if (state.discoveries.length > 0) {
    sections.push({
      id: "discoveries",
      text: section("New Discoveries", bullets(state.discoveries)),
      mandatory: false,
    });
  }
  // v3.2: Recent Rounds — keep the newest KEEP_RECENT_ROUNDS in full, fold
  // older ones into one pointer line (unless a milestone boundary crossed).
  if (state.rollingOutcomes.length > 0) {
    const boundaryChanged = milestoneBoundaryChanged(baseline, state.milestones);
    const collapseable = collapseEnabled && baseline !== null
      && state.rollingOutcomes.length > KEEP_RECENT_ROUNDS && !boundaryChanged;
    if (collapseable) {
      const kept = state.rollingOutcomes.slice(-KEEP_RECENT_ROUNDS);
      const earlier = state.rollingOutcomes.length - kept.length;
      const lines = [
        ...kept,
        `- … ${earlier} earlier round${earlier === 1 ? "" : "s"} (see state file)`,
      ];
      sections.push({
        id: "rolling_outcomes",
        text: section("Recent Rounds", lines.join("\n")),
        mandatory: false,
      });
    } else {
      sections.push({
        id: "rolling_outcomes",
        text: section("Recent Rounds", bullets(state.rollingOutcomes)),
        mandatory: false,
      });
    }
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
  // v3.3: Forward-looking roadmap (same buildRoadmap as state.md and L2).
  const roadmapLines = buildRoadmap(state);
  if (roadmapLines.length > 0) {
    sections.push({
      id: "roadmap",
      text: section("Roadmap", roadmapLines.join("\n")),
      mandatory: false,
    });
  }
  // v3.2: Recurring Issues carries the deterministic violation lessons (with
  // counts and rounds) when available; falls back to the rolling window text.
  if (state.recurringIssues.length > 0 || state.lessons.length > 0) {
    const violationLessons = state.lessons
      .filter((lesson) => lesson.kind === "constraint_violation")
      .slice(0, 3);
    const body = violationLessons.length > 0
      ? violationLessons
          .map((lesson) =>
            `- ${lesson.text} (violated ${lesson.count}×: R${lesson.rounds.join(", R")})`,
          )
          .join("\n")
      : bullets(state.recurringIssues);
    sections.push({
      id: "recurring_issues",
      text: section("Recurring Issues", body),
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
    ["recurring_issues", "Recurring Issues", state.recurringIssues, null],
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
  // v3.2: Lessons learned — repeated violations / verification failures
  // across the whole loop (not just the rolling window).
  if (state.lessons.length > 0) {
    const lessonLines = state.lessons.slice(0, 8).map((lesson) => {
      const icon = lesson.kind === "constraint_violation"
        ? "🚫"
        : lesson.kind === "verification_error" ? "⚠️" : "ℹ️";
      return `- ${icon} ${lesson.text} — ${lesson.count}× (R${lesson.rounds.join(", R")})`;
    });
    if (state.lessons.length > 8) {
      lessonLines.push(`- ... and ${state.lessons.length - 8} more`);
    }
    sections.push({
      id: "lessons",
      text: section("Lessons Learned", lessonLines.join("\n")),
      mandatory: false,
    });
  }
  // v3.3: Forward-looking roadmap — rendered right before the (backward-
  // looking) Phase History so the agent sees where it is before where it's
  // been. Same buildRoadmap as state.md and L1.
  const roadmapLines = buildRoadmap(state);
  if (roadmapLines.length > 0) {
    sections.push({
      id: "roadmap",
      text: section("Roadmap", roadmapLines.join("\n")),
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

  // Progress Dashboard
  if (
    state.progress.estimate !== null ||
    state.progress.criteriaMet.length > 0 ||
    state.progress.criteriaRemaining.length > 0 ||
    state.progress.filesChanged.length > 0 ||
    state.progress.tests !== null ||
    state.machineStatus !== undefined
  ) {
    const lines: string[] = [];
    const total = state.progress.criteriaMet.length + state.progress.criteriaRemaining.length;
    if (total > 0) {
      lines.push(`**Criteria**: ${state.progress.criteriaMet.length}/${total} met`);
    }
    if (state.progress.estimate !== null) {
      lines.push(`**Estimated Completion**: ${(state.progress.estimate * 100).toFixed(0)}%`);
      // v3.3: honest labeling — the estimate is the agent's own number.
      lines.push("**Signal source**: self-reported estimate (unverified until machine-backed)");
    }
    // v3.3: machine side of the comparison — git motion over committed
    // rounds (v3.6: the object always carries definite values — no
    // "unavailable" arm).
    if (state.machineStatus) {
      const ms = state.machineStatus;
      const motion = ms.gitMotion
        ? `changes in ${ms.motionRounds}/${ms.windowRounds} recent committed rounds`
        : `no git changes in the last ${ms.windowRounds} committed rounds`;
      lines.push(`**Machine (git)**: ${motion}`);
    }
    if (state.criterionStatuses.length > 0) {
      const verifiedCount = state.criterionStatuses.filter((cs) => cs.status === "verified").length;
      const claimedCount = state.criterionStatuses.filter((cs) => cs.status === "claimed").length;
      lines.push(
        `**Machine (criteria)**: ${verifiedCount}/${state.criterionStatuses.length} verified` +
        (claimedCount > 0 ? `, ${claimedCount} claimed-but-unverified` : "") +
        " across committed rounds",
      );
    }
    if (state.progress.tests) {
      lines.push(
        `**Tests**: ${state.progress.tests.passed} passed, ` +
        `${state.progress.tests.failed} failed, ${state.progress.tests.skipped} skipped`,
      );
    }
    if (state.progress.filesChanged.length > 0) {
      lines.push("**Files Changed**:");
      for (const f of state.progress.filesChanged.slice(0, 10)) lines.push(`- ${f}`);
      if (state.progress.filesChanged.length > 10) {
        lines.push(`- ... and ${state.progress.filesChanged.length - 10} more`);
      }
    }
    // v3.2: Goal → criteria → evidence vertical view — per-criterion status
    // with the round it was met and linked sub-goals. IDs follow
    // constraint_id_enabled like every other ID-rendering path.
    if (state.criterionStatuses.length > 0) {
      const idEnabled = getPolicy().evolution.constraint_id_enabled;
      lines.push("", "**Goal → Criteria**:");
      for (const cs of state.criterionStatuses) {
        const icon = cs.status === "verified" ? "✅"
          : cs.status === "claimed" ? "🟡"
          : cs.status === "insufficient" ? "🟠"
          : cs.status === "contradicted" ? "⛔"
          : cs.status === "remaining" ? "⬜" : "❔";
        const idTag = idEnabled ? ` [\`${cs.id}\`]` : "";
        const met = cs.met_at_round !== undefined ? `(met R${cs.met_at_round})` : "";
        const related = cs.related_subgoal_ids.length > 0
          ? ` [↔ ${cs.related_subgoal_ids.join(", ")}]`
          : "";
        lines.push(`- ${icon}${idTag} ${cs.text} ${met}${related}`);
      }
    }
    sections.push({
      id: "progress",
      text: section("Progress Dashboard", lines.join("\n")),
      mandatory: false,
    });
  }

  // v3.3: Per-round statistics — lets the agent calibrate round granularity
  // (files per round, rejected attempts, self-reported progress deltas).
  // v3.6: source-labeled — files/Δ are agent-reported; only rejected
  // attempts (and the Machine (git) row above) are machine-recorded.
  if (state.roundStats && state.roundStats.length > 0) {
    const statLines = state.roundStats.map((stat) => {
      const parts: string[] = [];
      if (stat.filesChangedCount !== null) {
        parts.push(`${stat.filesChangedCount} file${stat.filesChangedCount === 1 ? "" : "s"}`);
      }
      if (stat.rejectedAttempts !== null && stat.rejectedAttempts > 0) {
        parts.push(`${stat.rejectedAttempts} rejected attempt${stat.rejectedAttempts === 1 ? "" : "s"}`);
      }
      if (stat.progressDelta !== null) {
        parts.push(`Δ${stat.progressDelta >= 0 ? "+" : ""}${stat.progressDelta.toFixed(2)}`);
      }
      return `- R${stat.round}: ${parts.length > 0 ? parts.join(", ") : "no data"}`;
    });
    statLines.push(
      "> files & Δ are agent-reported; rejected attempts are machine-recorded " +
      "(the Machine (git) row above is machine-observed)",
    );
    sections.push({
      id: "round_stats",
      text: section("Round Stats", statLines.join("\n")),
      mandatory: false,
    });
  }

  // Retired Constraints
  if (state.retiredConstraints.length > 0) {
    const lines = state.retiredConstraints.map((c) => `- ~${c}~ (retired)`);
    sections.push({
      id: "retired_constraints",
      text: section("Retired Constraints", lines.join("\n")),
      mandatory: false,
    });
  }

  // Agent Trust Score + Trend
  if (state.agentTrustScore !== undefined) {
    const lines = [
      trustBarLine(state.agentTrustScore),
    ];
    if (state.agentTrustTrend.length > 0) {
      const avg = (state.agentTrustTrend.reduce((a, b) => a + b, 0)
        / state.agentTrustTrend.length).toFixed(2);
      lines.push(
        `Trend (last ${state.agentTrustTrend.length}): ${state.agentTrustTrend.join(" → ")}`,
      );
      lines.push(`Average: ${avg}`);
    }
    sections.push({
      id: "agent_trust",
      text: section("Agent Trust", lines.join("\n")),
      mandatory: false,
    });
  }

  return sections;
}

function selectSections(
  input: PromptAssemblyInput,
  emphasized: Set<string>,
): Section[] {
  if (input.level === "l0") return l0Sections(input.state);
  if (input.level === "l1") {
    return l1Sections(input.state, input.presentedBaseline ?? null, emphasized);
  }
  return l2Sections(input.state, input.fullStateMarkdown);
}

function renderWithinBudget(
  sections: Section[],
  fixedText: string,
  budget: number,
): { rendered: string; included: string[] } {
  const mandatory = sections.filter((item) => item.mandatory);
  const optional = sections.filter((item) => !item.mandatory);
  let rendered = fixedText + mandatory.map((item) => item.text).join("");
  const included = mandatory.filter((item) => item.text).map((item) => item.id);

  for (const item of optional) {
    if (!item.text) continue;
    if (rendered.length + item.text.length <= budget) {
      rendered += item.text;
      included.push(item.id);
    }
  }
  return { rendered, included };
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.9: Prompt Requests — model-expressed information needs
// ═══════════════════════════════════════════════════════════════════════════

/** Match a free-text emphasis target against state items.
 *  v2.11: ID-first matching. When a target is an ID (c-/cr-/sg-XXXXXXXX),
 *  candidates that derive to the same ID get score 1.0. Falls back to
 *  Jaccard similarity otherwise. */
function matchEmphasize(
  targets: string[],
  candidates: string[],
  cap: number,
): string[] {
  if (targets.length === 0 || candidates.length === 0) return [];
  const scored = candidates.map((c) => {
    let best = 0;
    for (const t of targets) {
      let s = 0;
      // Phase 1: exact ID match (v2.11)
      const idMatch = t.match(STABLE_ID_RE);
      if (idMatch) {
        const candidateId = idMatch[1] + "-" + deriveItemId(c);
        if (candidateId === t) s = 1.0;
      }
      // Phase 2: Jaccard fallback
      if (s === 0) s = jaccardSimilarity(t, c);
      if (s > best) best = s;
    }
    return { text: c, score: best };
  });
  return scored
    .filter((e) => e.score >= getPolicy().evolution.constraint_match_threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((e) => e.text);
}

/** Render the "Confusion Alerts" section that appears at the prompt top.
 *  Compiler auto-matches each confusion point against state sections. */
function renderConfusionAlerts(
  points: string[],
  state: CanonicalLoopState,
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
  const sections: Array<{ keyword: string; label: string; ref: string }> = [
    { keyword: "milestone", label: "Phase History", ref: "## Phase History" },
    { keyword: "sub-goal", label: "Sub-Goal Dashboard", ref: "## Sub-Goal Dashboard" },
    { keyword: "constraint", label: "Active Constraints / Constraint Lifecycle", ref: "## Active Constraints" },
    { keyword: "trust", label: "Agent Trust", ref: "## Agent Trust" },
    { keyword: "progress", label: "Progress Dashboard", ref: "## Progress Dashboard" },
    { keyword: "criteria", label: "Success Criteria", ref: "## Success Criteria" },
    { keyword: "phase", label: "Phase History", ref: "## Phase History" },
    { keyword: "objective", label: "Loop Objective", ref: "## Loop Objective" },
  ];

  // v2.14: L2 renders up to the policy cap (was: every confusion point,
  // unbounded by max_confusion_points); L1 keeps a single alert.
  const shown = fullDensity
    ? points.slice(0, getPolicy().prompt.max_confusion_points)
    : points.slice(0, 1);
  for (const point of shown) {
    const truncated = point.length > 200 ? point.slice(0, 197) + "…" : point;
    // Find best-matching state section
    let bestSection: typeof sections[0] | null = null;
    let bestScore = 0;
    for (const sec of sections) {
      const score = jaccardSimilarity(truncated.toLowerCase(), sec.keyword);
      if (score > bestScore) { bestScore = score; bestSection = sec; }
    }
    const pointer = bestSection && bestScore >= getPolicy().prompt.confusion_section_threshold
      ? `→ Check **${bestSection.label}** (\`${bestSection.ref}\`) in the state file.`
      : "→ Read the full state file for relevant context.";
    lines.push(`- **"${truncated}"**`);
    lines.push(`  ${pointer}`);
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
function renderCriticalContext(
  emphasized: string[],
  state: CanonicalLoopState,
): string {
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
  // L2 rounds (full rehydration), recovery, rejection, and drift all
  // benefit from the model reading the durable state file rather than
  // relying on potentially-compacted conversation history.
  const fullContextReasons = new Set([
    "first_round", "plan_boundary", "checkpoint_boundary", "goal_changed",
    "missing_previous_state", "verification_contradicted",
    "rejection_rehydrate", "recovery_boundary", "state_drift",
    "periodic_refresh",
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
  const levelIsL1 = input.level === "l1";
  const levelIsL2 = input.level === "l2";

  // Confusion alerts: L1/L2 only, rendered at the top (before mandatory sections)
  const confusionText = (!levelIsL0 && pr?.confusion_points?.length)
    ? renderConfusionAlerts(pr.confusion_points, input.state, levelIsL2)
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
  const sections = selectSections({ ...input, state: stateForSections }, emphasizedSet);
  const criticalContextText = renderCriticalContext(emphasized, input.state);

  // v3.2: L1 only — snapshot what this prompt actually presented, so the
  // NEXT L1 compile can diff against it (persisted via PromptArtifact →
  // lineage). L0/L2 leave it undefined: their presentation semantics differ
  // (L2's dashboard includes done/canceled sub-goals, which would
  // contaminate the L1 active-set diff).
  let presentedState: PresentedStateSnapshot | undefined;
  if (levelIsL1) {
    const activeSubsForSnapshot = stateForSections.subGoals.filter((sg) =>
      sg.status === "in_progress" || sg.status === "pending");
    presentedState = {
      round: input.state.round,
      constraintIds: activeNonHardConstraints(stateForSections)
        .map((text) => constraintIdOf(text, stateForSections.constraintMetadata)),
      subGoals: activeSubsForSnapshot.map(
        (sg) => [sg.id, sg.status] as [string, string],
      ),
      milestoneRanges: input.state.milestones.map(
        (m) => [m.round_range.start, m.round_range.end] as [number, number],
      ),
    };
  }

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

  const selected = renderWithinBudget(augmentedSections, fixedText, budget - footer.length);
  const renderedPrompt = selected.rendered + footer;
  const promptHash = createHash("sha256").update(renderedPrompt).digest("hex");

  return {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
    roundId: `loop:${input.state.loopId}:round:${input.state.round}`,
    attempt,
    level: input.level,
    renderedPrompt,
    promptHash,
    stateHash,
    ...(presentedState ? { presentedState } : {}),
  };
}
