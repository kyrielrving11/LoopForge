/** Canonical cognitive state used to render both prompts and state projections.
 *
 * The canonical state is data, not Markdown. Prompt and state-file renderers
 * consume the same value so they cannot silently drift apart.
 */

import { createHash } from "node:crypto";
import type {
  ConstraintMeta,
  CriterionStatus,
  Lesson,
  LoopCompileRequest,
  LoopCompileResponse,
  MilestoneSummary,
  RoundContract,
  SubGoal,
  VerificationFlag,
} from "./protocol.js";
import { deriveItemId, STABLE_ID_RE, unique } from "./token-utils.js";
import { getPolicy } from "./policy.js";

export const CANONICAL_STATE_SCHEMA_VERSION = 1 as const;

/** v3.2: Durable snapshot of what an L1 prompt actually presented last round.
 *  Used as the diff baseline for L1 collapse. Persisted inside the lineage
 *  entry's loop_lineage (field extension — no new persistence format) and
 *  carried on PromptArtifact for the compile-to-persist round-trip. */
export interface PresentedStateSnapshot {
  /** Round whose presentation this snapshot describes (the baseline round). */
  round: number;
  /** Stable IDs (c-XXXXXXXX) of constraints rendered in the L1 Active
   *  Constraints section (post-emphasize, non-hard). */
  constraintIds: string[];
  /** [sub-goal id, status] pairs rendered in the L1 Active Sub-Goals section
   *  (in_progress + pending only). Statuses enable transition detection. */
  subGoals: Array<[string, string]>;
  /** [start, end] round ranges of all milestones at presentation time. */
  milestoneRanges: Array<[number, number]>;
}

/** v3.3: Per-round statistics for the display (files changed, rejected
 *  attempts, self-reported progress delta). Compiler-derived from committed
 *  entries — zero persistence. Optional: absent when no committed rounds. */
export interface RoundStat {
  round: number;
  filesChangedCount: number | null;
  rejectedAttempts: number | null;
  progressDelta: number | null;
}

/** v3.3: Machine git-motion cross-check over the last committed rounds.
 *  Display-only companion to the R4/R5 exculpatory signal. Optional:
 *  absent when no committed rounds carry git snapshots. */
export interface MachineStatus {
  windowRounds: number;
  gitMotion: boolean | null;
  motionRounds: number | null;
}

export interface CanonicalLoopState {
  schemaVersion: typeof CANONICAL_STATE_SCHEMA_VERSION;
  loopId: string;
  round: number;
  maxRounds: number;
  goalId: string;
  objective: string;
  objectiveVersion: number;
  currentTask: string;
  successCriteria: string[];
  hardConstraints: string[];
  activeConstraints: string[];
  retiredConstraints: string[];
  /** v2.3: Constraints demoted to inactive after prolonged inactivity. */
  inactiveConstraints: string[];
  /** v2.3: Per-constraint lifecycle metadata. */
  constraintMetadata: ConstraintMeta[];
  changesSinceLastRound: string[];
  remainingCriteria: string[];
  blockers: string[];
  verificationFlags: VerificationFlag[];
  discoveries: string[];
  nextAction: string;
  rollingOutcomes: string[];
  recurringIssues: string[];
  failedPatterns: string[];
  /** v2.1: Phase-boundary milestone summaries that survive window eviction. */
  milestones: MilestoneSummary[];
  /** v2.1: Single-paragraph loop-level synthesis (formulaic). */
  loopSynthesis: string;
  /** v2.2: Structured sub-goals with compiler-managed lifecycle. */
  subGoals: SubGoal[];
  /** v3.2: Derived per-criterion status (goal → criteria → evidence view). */
  criterionStatuses: CriterionStatus[];
  /** v3.2: Deterministic lessons learned (repeated violations / failures). */
  lessons: Lesson[];
  /** v2.5: Agent trust score [0, 1] from verification flags. */
  agentTrustScore: number | undefined;
  /** v2.5: Trust trend over last 10 rounds. */
  agentTrustTrend: number[];
  suggestedNextTask: string;
  externalContext: string;
  stateFilePath: string;
  progress: {
    estimate: number | null;
    criteriaMet: string[];
    criteriaRemaining: string[];
    filesChanged: string[];
    tests: { passed: number; failed: number; skipped: number } | null;
  };
  /** v3.3: Display-only round stats over the last committed rounds.
   *  Conditional presence: absent when there are no committed rounds. */
  roundStats?: RoundStat[];
  /** v3.3: Machine git-motion cross-check for the progress dashboard.
   *  Conditional presence: absent when no committed git snapshots exist. */
  machineStatus?: MachineStatus;
  /** v3.4: The ACTIVE Round Contract this round executes under —
   *  compile-derived from committed rounds (never the submission's own
   *  round_contract, which is a proposal for the NEXT round). Conditional
   *  presence: absent without an active contract — keeps state hashes
   *  byte-identical for contract-less rounds. */
  roundContract?: RoundContract;
}

// unique() imported from token-utils.ts

/** Deterministic JSON serialization used by state and prompt hashes. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  ).join(",")}}`;
}

export function hashCanonicalState(state: CanonicalLoopState): string {
  return createHash("sha256").update(stableStringify(state)).digest("hex");
}

function addList(lines: string[], title: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`## ${title}`, "");
  for (const value of values) lines.push(`- ${value}`);
  lines.push("");
}

/** v2.11: Derive a stable 8-char hex ID from text using SHA-256.
 *  Same hash strategy as computeGoalTextHash in loop-compiler.ts. */

/** v2.11: Render a list with ID prefixes when constraint_id_enabled is true.
 *  Each item gets a [prefix-XXXXXXXX] tag derived from its text hash.
 *  Items that already look like IDs (e.g. "cr-a3f2b1c0") are rendered as-is. */
function addListWithIds(
  lines: string[],
  title: string,
  values: string[],
  prefix: string,
): void {
  if (values.length === 0) return;
  const idEnabled = getPolicy().evolution.constraint_id_enabled;
  lines.push(`## ${title}`, "");
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    // If the value is already an ID, render it as-is
    if (STABLE_ID_RE.test(trimmed)) {
      lines.push(`- [\`${trimmed}\`] ${trimmed}`);
    } else if (idEnabled) {
      const id = prefix + "-" + deriveItemId(trimmed);
      lines.push(`- [\`${id}\`] ${trimmed}`);
    } else {
      lines.push(`- ${trimmed}`);
    }
  }
  lines.push("");
}

/** v3.3.1: Identity-aware variant of addListWithIds for the merged active
 *  constraint set (hard/plan/criteria/discovered texts together). Each
 *  item's ID comes from constraint metadata — criteria texts keep their
 *  cr-XXXXXXXX identity, matching the Success Criteria section and the
 *  verification gate's ID-first criterion matching. Keeps the state file in
 *  the same identity namespace as the prompts (module contract: both
 *  renderers cannot drift apart). */
function addListWithIdentities(
  lines: string[],
  title: string,
  values: string[],
  metadata: ConstraintMeta[],
): void {
  if (values.length === 0) return;
  const idEnabled = getPolicy().evolution.constraint_id_enabled;
  const idByText = new Map(metadata.map((meta) => [meta.text, meta.id]));
  lines.push(`## ${title}`, "");
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (STABLE_ID_RE.test(trimmed)) {
      lines.push(`- [\`${trimmed}\`] ${trimmed}`);
    } else if (idEnabled) {
      const id = idByText.get(trimmed) ?? `c-${deriveItemId(trimmed)}`;
      lines.push(`- [\`${id}\`] ${trimmed}`);
    } else {
      lines.push(`- ${trimmed}`);
    }
  }
  lines.push("");
}

/** Human/Agent-readable materialized view. It is always reproducible from the
 * canonical state and is never consulted as transaction truth. */
/** v3.3: Forward-looking "roadmap" view derived from existing state — loop
 *  position, met/remaining criteria (with IDs), and sub-goal activity.
 *
 *  Deliberately label-free: milestone labels/ranges are collapsed content in
 *  L1 (the diff-collapse invariant) and are rendered in full by Phase
 *  History everywhere else — the roadmap only reports "N rounds since the
 *  last milestone boundary", never the boundary's identity. Next action is
 *  likewise excluded: every level renders its own Next Action section.
 *  Shared by the state-file and prompt renderers so they cannot silently
 *  drift apart (module contract above). Returns [] — renders nothing —
 *  when the state carries none of these. Presentation only; never feeds
 *  enforcement. */
export function buildRoadmap(state: CanonicalLoopState): string[] {
  const lastMilestone = state.milestones.length > 0
    ? state.milestones[state.milestones.length - 1]
    : null;
  const roundsSinceMilestone = lastMilestone !== null &&
    lastMilestone.round_range.end <= state.round
    ? state.round - lastMilestone.round_range.end
    : null;
  const met = state.criterionStatuses.filter((cs) => cs.status === "met").length;
  const total = state.criterionStatuses.length;
  const remaining = state.criterionStatuses.filter(
    (cs) => cs.status === "remaining" || cs.status === "unknown",
  );
  const inProgress = state.subGoals.filter((sg) => sg.status === "in_progress").length;
  const pending = state.subGoals.filter((sg) => sg.status === "pending").length;
  // Bare position alone is not forward information — no milestone distance,
  // criteria, remaining criteria, or sub-goal activity means nothing to
  // look ahead to. Returns [] so empty states render no section at all.
  if (roundsSinceMilestone === null && total === 0 &&
      state.remainingCriteria.length === 0 && inProgress === 0 && pending === 0) {
    return [];
  }

  const lines: string[] = [];
  let position = `Position: round ${state.round}/${state.maxRounds}`;
  if (roundsSinceMilestone !== null) {
    position += ` · ${roundsSinceMilestone} round${roundsSinceMilestone === 1 ? "" : "s"} since the last milestone boundary`;
  }
  lines.push(`- ${position}`);

  if (total > 0) {
    lines.push(`- Criteria: ${met}/${total} met · ${remaining.length} remaining`);
  } else if (state.remainingCriteria.length > 0) {
    lines.push(`- Criteria: ${state.remainingCriteria.length} remaining`);
  }
  if (remaining.length > 0) {
    const idEnabled = getPolicy().evolution.constraint_id_enabled;
    for (const cs of remaining.slice(0, 8)) {
      const idTag = idEnabled ? ` [\`${cs.id}\`]` : "";
      const icon = cs.status === "remaining" ? "⬜" : "❔";
      lines.push(`  - ${icon}${idTag} ${cs.text}`);
    }
    if (remaining.length > 8) {
      lines.push(`  - ... and ${remaining.length - 8} more`);
    }
  }

  if (inProgress > 0 || pending > 0) {
    lines.push(`- Sub-goals: ${inProgress} in progress · ${pending} pending`);
  }
  return lines;
}

/** v3.3/v3.4: Render the ACTIVE Round Contract as the Current Task section
 *  body — the single formatting source shared by prompts and the state
 *  file (module contract above). The original objective is NOT here: it
 *  lives in the Objective section. Empty arrays render no line. */
export function formatRoundContract(contract: RoundContract): string {
  const lines: string[] = [];
  const heading = contract.work_item?.trim();
  lines.push(`**${heading || "Round Contract"}**`);
  for (const item of contract.done_when) {
    lines.push(`- Done when: ${item}`);
  }
  for (const item of contract.verification_plan) {
    lines.push(`- Verify via: ${item}`);
  }
  for (const item of contract.scope) {
    lines.push(`- Scope: ${item}`);
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// v3.3.1: Shared presentation atoms
// ═══════════════════════════════════════════════════════════════════════════

/** The trust bar line ("██████░░░░ 60%"). The L2 Agent Trust section and the
 *  L1 expand renderer used to carry private copies of this formula — shared
 *  here so a formatting change is made once (module contract: renderers must
 *  not silently drift apart). */
export function trustBarLine(score: number): string {
  const barLen = 10;
  const filled = Math.round(score * barLen);
  const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
  return `${bar} ${(score * 100).toFixed(0)}%`;
}

/** Milestone heading line ("**🏁 Round 7** (Rounds 3–7, 60%)"). Shared by the
 *  L2 Phase History and the L1 expand renderer; the expand copy previously
 *  rendered the range as "R3–R7", a format only this heading used. */
export function milestoneHeading(milestone: MilestoneSummary): string {
  const kindIcon = milestone.kind === "agent_declared"
    ? "🏁"
    : milestone.kind === "criteria_milestone" ? "✅" : "📍";
  return `**${kindIcon} ${milestone.label}** (Rounds ${milestone.round_range.start}–${milestone.round_range.end}, ${(milestone.progress_at_boundary * 100).toFixed(0)}%)`;
}

export function renderCanonicalStateMarkdown(state: CanonicalLoopState): string {
  const lines = [
    `# LoopForge State — ${state.loopId}`,
    "",
    `**Schema**: ${state.schemaVersion}`,
    `**Round**: ${state.round}/${state.maxRounds}`,
    `**Goal ID**: ${state.goalId}`,
    "",
    "## Loop Objective",
    "",
    state.objective,
    "",
    "## Current Task",
    "",
    state.currentTask,
    // v3.3: boundary_reason is audit/agent discipline material — the state
    // file records it, prompts do not (prompt budget is for the task).
    ...(state.roundContract?.boundary_reason
      ? [`> Contract boundary: ${state.roundContract.boundary_reason}`, ""]
      : []),
  ];
  // v2.11: Success Criteria and Constraints render with stable IDs for exact agent matching
  addListWithIds(lines, "Success Criteria", state.successCriteria, "cr");
  addListWithIds(lines, "Hard Constraints", state.hardConstraints, "c");
  addListWithIdentities(lines, "Active Constraints", state.activeConstraints, state.constraintMetadata);
  addList(lines, "Changes Since Last Round", state.changesSinceLastRound);
  if (
    state.progress.estimate !== null ||
    state.progress.criteriaMet.length > 0 ||
    state.progress.criteriaRemaining.length > 0 ||
    state.progress.filesChanged.length > 0 ||
    state.progress.tests !== null ||
    state.machineStatus !== undefined
  ) {
    const total = state.progress.criteriaMet.length + state.progress.criteriaRemaining.length;
    lines.push("## Progress Dashboard", "");
    if (total > 0) {
      lines.push(`**Criteria**: ${state.progress.criteriaMet.length}/${total}`);
    }
    if (state.progress.estimate !== null) {
      lines.push(`**Estimated Completion**: ${(state.progress.estimate * 100).toFixed(0)}%`);
      // v3.3: honest labeling — the estimate is the agent's own number.
      lines.push("**Signal source**: self-reported estimate (unverified until machine-backed)");
    }
    // v3.3: machine side of the comparison — git motion over committed rounds
    // and committed-history criterion completions (from criterionStatuses).
    if (state.machineStatus) {
      const ms = state.machineStatus;
      const motion = ms.gitMotion === null
        ? "unavailable"
        : ms.gitMotion
          ? `changes observed in ${ms.motionRounds}/${ms.windowRounds} recent committed rounds`
          : `no git changes in the last ${ms.windowRounds} committed rounds`;
      lines.push(`**Machine (git)**: ${motion}`);
    }
    if (state.criterionStatuses.length > 0) {
      const metCount = state.criterionStatuses.filter((cs) => cs.status === "met").length;
      lines.push(`**Machine (criteria)**: ${metCount}/${state.criterionStatuses.length} met across committed rounds`);
    }
    if (state.progress.tests) {
      lines.push(
        `**Tests**: ${state.progress.tests.passed} passed, ` +
        `${state.progress.tests.failed} failed, ${state.progress.tests.skipped} skipped`,
      );
    }
    if (state.progress.filesChanged.length > 0) {
      lines.push("", "**Files Changed**:");
      for (const file of state.progress.filesChanged) lines.push(`- ${file}`);
    }
    lines.push("");
  }
  // v3.2: Goal → criteria → evidence vertical view. IDs follow
  // constraint_id_enabled like every other ID-rendering path.
  if (state.criterionStatuses.length > 0) {
    const idEnabled = getPolicy().evolution.constraint_id_enabled;
    lines.push("## Goal → Criteria", "");
    for (const cs of state.criterionStatuses) {
      const icon = cs.status === "met" ? "✅" : cs.status === "remaining" ? "⬜" : "❔";
      const idTag = idEnabled ? ` [\`${cs.id}\`]` : "";
      const met = cs.met_at_round !== undefined ? ` (met R${cs.met_at_round})` : "";
      const related = cs.related_subgoal_ids.length > 0
        ? ` (related: ${cs.related_subgoal_ids.join(", ")})`
        : "";
      lines.push(`- ${icon}${idTag} ${cs.text}${met}${related}`);
    }
    lines.push("");
  }
  addListWithIds(lines, "Remaining", state.remainingCriteria, "cr");
  addList(lines, "Blockers", state.blockers);
  addList(lines, "Discoveries", state.discoveries);
  addList(lines, "Cross-Round Outcomes", state.rollingOutcomes);
  addList(lines, "Recurring Issues", state.recurringIssues);
  addList(lines, "Failed Patterns", state.failedPatterns);
  // v3.2: Lessons learned — repeated violations / verification failures.
  if (state.lessons.length > 0) {
    lines.push("## Lessons Learned", "");
    for (const lesson of state.lessons.slice(0, 8)) {
      const icon = lesson.kind === "constraint_violation"
        ? "🚫"
        : lesson.kind === "verification_error" ? "⚠️" : "ℹ️";
      lines.push(
        `- ${icon} ${lesson.text} — ${lesson.count}× (R${lesson.rounds.join(", R")})`,
      );
    }
    if (state.lessons.length > 8) {
      lines.push(`- ... and ${state.lessons.length - 8} more`);
    }
    lines.push("");
  }
  addList(lines, "Retired Constraints", state.retiredConstraints);
  if (state.inactiveConstraints.length > 0) {
    lines.push("## Inactive Constraints", "");
    lines.push(
      "> Demoted after prolonged inactivity. Removed from prompts ",
      "but kept here. Auto-reactivated if violated again.",
      "",
    );
    const idEnabled = getPolicy().evolution.constraint_id_enabled;
    for (const c of state.inactiveConstraints) {
      const meta = state.constraintMetadata.find((m) => m.text === c);
      const age = meta
        ? state.round - (meta.last_violated_at_round || meta.discovered_at_round || 0)
        : "?";
      const lastV = meta?.last_violated_at_round
        ? `last violated R${meta.last_violated_at_round}`
        : "never violated";
      const idLabel = idEnabled && meta?.id
        ? `[\`${meta.id}\`] `
        : "";
      lines.push(`- ${idLabel}${c} (${lastV}, ${age} rounds inactive)`);
    }
    lines.push("");
  }
  if (state.nextAction) {
    lines.push("## Next Action", "", state.nextAction, "");
  }
  // v3.3: Forward-looking roadmap — same buildRoadmap the prompts render.
  const roadmap = buildRoadmap(state);
  if (roadmap.length > 0) {
    lines.push("## Roadmap", "");
    for (const line of roadmap) lines.push(line);
    lines.push("");
  }
  if (state.verificationFlags.length > 0) {
    lines.push("## Verification", "");
    for (const flag of state.verificationFlags) {
      lines.push(`- [${flag.severity}] [${flag.check}] ${flag.detail}`);
    }
    lines.push("");
  }
  if (state.milestones.length > 0) {
    lines.push("## Phase History", "");
    for (const m of state.milestones) {
      const kindIcon = m.kind === "agent_declared"
        ? "🏁"
        : m.kind === "criteria_milestone" ? "✅" : "📍";
      lines.push(
        `### ${kindIcon} ${m.label}`,
        `Rounds ${m.round_range.start}–${m.round_range.end} | ` +
        `Progress: ${(m.progress_at_boundary * 100).toFixed(0)}%`,
        "",
        `**Outcome**: ${m.outcome}`,
        "",
      );
      if (m.carried_constraints.length > 0) {
        lines.push("**Carried Constraints**:");
        for (const c of m.carried_constraints) lines.push(`- ${c}`);
        lines.push("");
      }
      if (m.resolved_constraints.length > 0) {
        lines.push("**Resolved During Phase**:");
        for (const c of m.resolved_constraints) lines.push(`- ${c}`);
        lines.push("");
      }
    }
  }
  if (state.subGoals.length > 0) {
    lines.push("## Sub-Goal Dashboard", "");
    for (const sg of state.subGoals) {
      const statusIcon =
        sg.status === "in_progress" ? "🔄" :
        sg.status === "done" ? "✅" :
        sg.status === "blocked" ? "🚫" :
        sg.status === "canceled" ? "❌" : "⏳";
      const stale = sg.status === "pending" &&
        state.round - sg.declared_at_round >= 10 ? " ⚠️ stale" : "";
      const detail = sg.status === "done" && sg.completed_at_round
        ? ` (done, R${sg.completed_at_round})`
        : sg.status === "in_progress"
        ? ` (since R${sg.status_changed_at_round})`
        : sg.status === "pending"
        ? ` (since R${sg.declared_at_round})`
        : sg.status === "blocked"
        ? ` (blocked R${sg.status_changed_at_round})`
        : ` (canceled R${sg.status_changed_at_round})`;
      lines.push(`- ${statusIcon} [\`${sg.id}\`] ${sg.description}${detail}${stale}`);
    }
    lines.push("");
  }
  if (state.agentTrustScore !== undefined) {
    const barLen = 10;
    const filled = Math.round(state.agentTrustScore * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    const avg = state.agentTrustTrend.length > 0
      ? (state.agentTrustTrend.reduce((a, b) => a + b, 0) / state.agentTrustTrend.length).toFixed(2)
      : "—";
    lines.push(
      "## Agent Trust", "",
      `${bar} ${(state.agentTrustScore * 100).toFixed(0)}%`,
      `Trend (last ${state.agentTrustTrend.length}): ${state.agentTrustTrend.join(" → ")}`,
      `Average: ${avg}`,
      "",
    );
  }
  if (state.loopSynthesis) {
    lines.push("## Loop Summary", "", state.loopSynthesis, "");
  }
  if (state.externalContext) {
    lines.push("## External Context", "", state.externalContext, "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function createCanonicalLoopState(
  request: LoopCompileRequest,
  response: LoopCompileResponse,
  stateFilePath: string,
  /** v3.3: Display-only derived data (round stats, machine git-motion).
   *  Optional 4th param — callers that predate v3.3 stay on 3-arg calls. */
  derived?: {
    roundStats?: RoundStat[];
    machineStatus?: MachineStatus;
    /** v3.4: ACTIVE Round Contract for this round (compile-derived from the
     *  committed evals of earlier rounds — see loop-compiler). Drives the
     *  Current Task. Never the submission's own round_contract field, which
     *  is a proposal for the NEXT round. */
    roundContract?: RoundContract | null;
  },
): CanonicalLoopState {
  const last = request.last_round_result;
  const objective = response.loop_objective;
  const verificationFlags = request.verification_flags ?? [];
  const rolling = response.rolling_summary;
  const executionEvidence = last?.execution_evidence;

  const changes = unique([
    request.new_since_last_round,
    last?.output_summary,
    ...(last?.wrong_assumptions ?? []).map((value) =>
      `Corrected assumption: ${value}`,
    ),
  ]);

  const discoveries = unique([
    ...(last?.discovered_constraints ?? []),
    ...(last?.emerged_subtasks ?? []),
  ]);

  const blockers = unique([
    ...(last?.constraint_violations ?? []),
    last?.manual_fixes_needed,
    request.rejection_notice,
    ...response.warnings,
  ]);

  // v3.4: The ACTIVE Round Contract (derived — loop-compiler computes it
  // from committed rounds) drives the Current Task — the contract IS "what
  // to do this round"; the original objective stays in the Objective
  // section above. No active contract → the original task text is used,
  // byte-identical to pre-v3.3 behavior.
  const roundContract = derived?.roundContract ?? null;

  return {
    schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
    loopId: response.loop_id || request.loop_id,
    round: response.round || request.round,
    maxRounds: request.max_rounds ?? 20,
    goalId: response.goal_id,
    objective: objective?.objective || request.task,
    objectiveVersion: objective?.version ?? 1,
    currentTask: roundContract ? formatRoundContract(roundContract) : request.task,
    successCriteria: unique(objective?.success_criteria ?? []),
    hardConstraints: unique(objective?.hard_constraints ?? []),
    activeConstraints: unique(response.constraints_active),
    retiredConstraints: unique(response.constraints_retired),
    inactiveConstraints: unique(response.constraints_inactive ?? []),
    constraintMetadata: response.constraint_metadata ?? [],
    changesSinceLastRound: changes,
    remainingCriteria: unique(
      last?.execution_evidence?.success_criteria_remaining ?? [],
    ),
    blockers,
    verificationFlags,
    discoveries,
    nextAction: last?.next_action?.trim() || response.suggested_next_task,
    rollingOutcomes: unique(rolling?.key_outcomes ?? []),
    recurringIssues: unique(rolling?.recurring_issues ?? []),
    failedPatterns: unique(rolling?.failed_patterns ?? []),
    milestones: rolling?.milestones ?? [],
    loopSynthesis: rolling?.loop_synthesis ?? "",
    subGoals: response.sub_goals ?? [],
    criterionStatuses: response.criterion_statuses ?? [],
    lessons: response.lessons ?? [],
    agentTrustScore: response.agent_trust_score,
    agentTrustTrend: response.agent_trust_trend ?? [],
    suggestedNextTask: response.suggested_next_task,
    externalContext: request.external_context?.trim() ?? "",
    stateFilePath,
    progress: {
      estimate: executionEvidence?.progress_estimate ?? null,
      criteriaMet: unique(executionEvidence?.success_criteria_met ?? []),
      criteriaRemaining: unique(
        executionEvidence?.success_criteria_remaining ?? [],
      ),
      filesChanged: unique(executionEvidence?.files_changed ?? []),
      tests: executionEvidence?.test_results ?? null,
    },
    // v3.3: Conditional presence — empty/absent derived data must not add
    // keys, or every state hash would change for rounds without it.
    ...(derived?.roundStats && derived.roundStats.length > 0
      ? { roundStats: derived.roundStats }
      : {}),
    ...(derived?.machineStatus ? { machineStatus: derived.machineStatus } : {}),
    // v3.3: Conditional presence — no contract, no key (hash stability).
    ...(roundContract ? { roundContract } : {}),
  };
}
