/** LoopForge cognitive-state compiler.
 *
 * The compiler evolves structured state and renders one prompt artifact.
 * L0/L1/L2 control state density only; the external Agent owns reasoning.
 */

import { createHash } from "node:crypto";
import { getPolicy } from "./policy.js";
import {
  AgentStatus,
  makeCheckpointSummary,
  makeLoopCompileResponse,
  makeLoopHealth,
  makeLoopObjective,
  makeRollingSummary,
  makeTaskAlignment,
  type CheckpointSummary,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type LoopHealth,
  type LoopObjective,
  type RollingSummary,
  type TaskAlignment,
} from "./protocol.js";
import {
  createCanonicalLoopState,
  renderCanonicalStateMarkdown,
} from "./canonical-state.js";
import { assemblePromptArtifact } from "./prompt-assembler.js";
import {
  decidePromptLevel,
  type PromptLevelDecision,
} from "./prompt-policy.js";

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

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

function contextEntries(context: Record<string, unknown> | null): Entry[] {
  if (!context || !Array.isArray(context.results)) return [];
  return context.results.filter(
    (value): value is Entry => value !== null && typeof value === "object" && !Array.isArray(value),
  );
}

function lineage(entry: Entry): Entry {
  const value = entry.loop_lineage ?? entry.lineage;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Entry
    : {};
}

function entryRound(entry: Entry): number {
  const value = lineage(entry).round;
  return typeof value === "number" ? value : 0;
}

function loopEntries(loopId: string, context: Record<string, unknown> | null): Entry[] {
  return contextEntries(context)
    .filter((entry) => entry.loop_id === loopId || lineage(entry).loop_id === loopId)
    .sort((a, b) => entryRound(a) - entryRound(b));
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
  const entry = [...loopEntries(loopId, context)].reverse()
    .find((candidate) => entryRound(candidate) === round);
  if (!entry) return null;
  const data = lineage(entry);
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
    history.push(refinement);
    objective = `${objective}\nRefinement: ${refinement}`;
    version++;
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
): { active: string[]; retired: string[] } {
  const retired = unique(request.last_round_result?.retracted_constraints ?? []);
  const retiredSet = new Set(retired);
  const discovered = unique(request.last_round_result?.discovered_constraints ?? [])
    .slice(0, getPolicy().evolution.max_discovered_constraints_per_round);
  const active = unique([
    ...(previous?.constraints_active ?? []),
    ...request.constraints_from_plan,
    ...objective.hard_constraints,
    ...objective.success_criteria,
    ...discovered,
  ]).filter((item) => !retiredSet.has(item))
    .slice(0, getPolicy().evolution.max_active_constraints);
  return { active, retired };
}

export function buildRollingSummary(
  loopId: string,
  currentRound: number,
  context: Record<string, unknown> | null,
  sinceRound = 0,
): RollingSummary | null {
  const window = getPolicy().summary.window;
  const entries = loopEntries(loopId, context)
    .filter((entry) => {
      const round = entryRound(entry);
      return round >= sinceRound && round < currentRound;
    })
    .slice(-window);
  if (entries.length === 0) return null;
  const outcomes: string[] = [];
  const issues: string[] = [];
  for (const entry of entries) {
    const data = lineage(entry);
    const round = entryRound(entry);
    const success = entry.success ?? data.success;
    const summary = typeof entry.output_summary === "string"
      ? entry.output_summary
      : typeof data.output_summary === "string" ? data.output_summary : "";
    if (summary) outcomes.push(`[R${round}] ${success === false ? "failed" : "accepted"}: ${summary}`);
    const violations = Array.isArray(entry.constraint_violations)
      ? entry.constraint_violations
      : Array.isArray(data.constraint_violations) ? data.constraint_violations : [];
    issues.push(...violations.filter((item): item is string => typeof item === "string"));
  }
  return makeRollingSummary({
    key_outcomes: unique(outcomes),
    recurring_issues: unique(issues),
    rounds_sampled: entries.length,
    generated_at_round: currentRound,
    failed_patterns: [],
  });
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) ?? []);
}

function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 1;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}

export function alignTask(
  proposedTask: string,
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): TaskAlignment {
  const objective = request.loop_objective ?? latestObjective(request.loop_id, context);
  if (!objective) return makeTaskAlignment();
  const score = similarity(
    proposedTask,
    [objective.objective, ...objective.success_criteria, ...objective.hard_constraints].join(" "),
  );
  return makeTaskAlignment({
    is_aligned: score >= 0.3,
    alignment_score: Number(score.toFixed(2)),
    warning: score < 0.3 ? "Current task may be drifting from the loop objective." : "",
    escalation: score < 0.3 ? "warn" : "none",
  });
}

export function checkLoopHealth(
  loopId: string,
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): LoopHealth {
  const previous = getPreviousRound(loopId, request.round - 1, context);
  const alignment = alignTask(request.task, request, context);
  const violations = request.last_round_result?.constraint_violations.length ?? 0;
  const integrity = Math.max(0, 1 - violations * 0.2);
  const continuity = previous ? similarity(previous.task, request.task) : 1;
  const drift = alignment.alignment_score < 0.3 || continuity < 0.2;
  return makeLoopHealth({
    goal_alignment: alignment.alignment_score,
    constraint_integrity: integrity,
    drift_detected: drift,
    strategy_stability: true,
    task_continuity: Number(continuity.toFixed(2)),
    escalation_recommended: drift || integrity < 0.6 ? "l2" : "none",
  });
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
  const lastFullRound = loopEntries(request.loop_id, context)
    .filter((entry) => lineage(entry).recompile_level === "l2")
    .map(entryRound)
    .filter((round) => round < request.round)
    .at(-1) ?? 1;
  return decidePromptLevel({
    round: request.round,
    attempt: request.attempt,
    forceLevel: request.force_level,
    hasPlanSource: Boolean(request.plan_source),
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
    fullRefreshInterval: getPolicy().prompt.full_refresh_interval,
    lastFullRound,
  });
}

export function decideLevel(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): "l0" | "l1" | "l2" {
  return levelDecision(request, context).level;
}

export function buildSelfEvalBlock(round: number): string {
  return [
    "### LoopForge Evaluation (Required)",
    "",
    `After completing Round ${round}, submit JSON between these markers:`,
    "---loopforge-eval",
    JSON.stringify({
      success: false,
      output_summary: `<verified result of round ${round}>`,
      constraint_violations: [],
      should_continue: true,
      discovered_constraints: [],
      emerged_subtasks: [],
      execution_evidence: {
        files_changed: [],
        test_results: { passed: 0, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: [],
        progress_estimate: 0,
      },
      wrong_assumptions: [],
      next_action: "<next concrete action, or empty when complete>",
    }, null, 2),
    "---end-loopforge-eval",
    "",
    "Set success=true only when the full goal and hard constraints are verified.",
  ].join("\n");
}

function checkpoint(
  request: LoopCompileRequest,
  active: string[],
  retired: string[],
): CheckpointSummary | null {
  const last = request.last_round_result;
  if (!last?.compression_checkpoint) return null;
  const policy = getPolicy().checkpoint;
  return makeCheckpointSummary({
    label: last.checkpoint_label?.trim() || `Round ${last.round}`,
    declared_at_round: last.round,
    outcome: last.output_summary.slice(0, policy.outcome_max_chars),
    carried_constraints: active.slice(0, policy.max_carried_constraints),
    resolved_constraints: retired,
  });
}

export function compileLoop(
  request: LoopCompileRequest,
  context: Record<string, unknown> | null,
): LoopCompileResponse {
  const decision = levelDecision(request, context);
  const previous = getPreviousRound(request.loop_id, request.round - 1, context);
  const objective = evolveObjective(request, context);
  const constraints = evolveConstraints(request, objective, previous);
  const rolling = buildRollingSummary(request.loop_id, request.round, context);
  const alignment = alignTask(request.task, request, context);
  const health = checkLoopHealth(request.loop_id, { ...request, loop_objective: objective }, context);
  const warnings = unique([
    alignment.warning,
    health.escalation_recommended !== "none"
      ? `Loop health recommends ${health.escalation_recommended}.`
      : "",
  ]);
  const response = makeLoopCompileResponse({
    status: AgentStatus.OK,
    recompile_level: decision.level,
    diff_from_previous: decision.reasons.join(","),
    lineage: [`${request.loop_id}:r${request.round}`],
    constraints_active: constraints.active,
    constraints_retired: constraints.retired,
    loop_id: request.loop_id,
    round: request.round,
    goal_id: deriveGoalId(request.loop_id, request.task, request.goal_id),
    goal_text_hash: computeGoalTextHash(request.task),
    loop_objective: objective,
    loop_health: health,
    task_alignment: alignment,
    rolling_summary: rolling,
    checkpoint_summary: checkpoint(request, constraints.active, constraints.retired),
    suggested_next_task: request.last_round_result?.next_action?.trim() ||
      request.last_round_result?.emerged_subtasks?.[0] || "",
    plan_source: request.plan_source,
    warnings,
  });
  const policy = getPolicy();
  const statePath = `${policy.state_file.directory}/${request.loop_id}-state.md`;
  const state = createCanonicalLoopState(request, response, statePath);
  const markdown = renderCanonicalStateMarkdown(state);
  const artifact = assemblePromptArtifact({
    state,
    level: decision.level,
    reasons: decision.reasons,
    mode: policy.prompt.injection_mode,
    budgets: {
      l0: policy.prompt.l0_max_chars,
      l1: policy.prompt.l1_max_chars,
      l2: policy.prompt.l2_max_chars,
    },
    attempt: request.attempt,
    selfEvaluationBlock: buildSelfEvalBlock(request.round),
    fullStateMarkdown: markdown,
  });
  response.prompt = artifact.renderedPrompt;
  response.prompt_artifact = artifact;
  response.state_file_content = policy.state_file.enabled ? markdown : undefined;
  return response;
}
