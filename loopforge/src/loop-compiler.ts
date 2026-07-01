/** LoopForge-loop_compile — Loop Compiler (v3.5 core).
 *
 * Pure-function module for per-loop-iteration prompt compilation.
 *
 * Two layers:
 *   Layer 1 (Hard Gates): decideLevel() — 4-gate routing that CAN change compile level.
 *   Layer 2 (Soft Advisories): computeAdvisories() — warnings/alignment/health, NEVER
 *     change compile level directly.
 *
 * Compilation: compileL0() / compileL1() / compileL2() produce the actual prompt.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getPolicy } from "./policy.js";
import {
  AgentStatus,
  makeLoopCompileResponse,
  makeLoopHealth,
  makeLoopObjective,
  makeRollingSummary,
  makeTaskAlignment,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type LoopHealth,
  type LoopObjective,
  type RollingSummary,
  type TaskAlignment,
} from "./protocol.js";
import { routeTechniqueAdaptive } from "./builder.js";

// ═══════════════════════════════════════════════════════════════════════════
// Repair cue detection
// ═══════════════════════════════════════════════════════════════════════════

const REPAIR_CUES = [
  "fix", "repair", "revise", "correct", "polish", "bug", "error",
  "修复", "修改", "修正", "纠错", "补充", "改一下",
];

function detectsRepairSignal(request: LoopCompileRequest): boolean {
  let text = (request.new_since_last_round || "").toLowerCase();
  if (request.last_round_result) {
    text += " " + (request.last_round_result.output_summary || "").toLowerCase();
    if (request.last_round_result.manual_fixes_needed) {
      text += " " + request.last_round_result.manual_fixes_needed.toLowerCase();
    }
  }
  return REPAIR_CUES.some((cue) => text.includes(cue));
}

// ═══════════════════════════════════════════════════════════════════════════
// Tokenization helpers
// ═══════════════════════════════════════════════════════════════════════════

export function tokenize(text: string): Set<string> {
  const tokens = text.split(/\s+/);
  const result = new Set<string>();
  for (let token of tokens) {
    token = token.trim().replace(/^[.,;:!?()[\]{}'"]+|[.,;:!?()[\]{}'"]+$/g, "");
    if (token.length >= 2) {
      result.add(/^[\x00-\x7F]*$/.test(token) ? token.toLowerCase() : token);
    }
    // Add individual CJK chars as standalone tokens
    for (const ch of token) {
      if (
        (ch >= "一" && ch <= "鿿") ||
        (ch >= "぀" && ch <= "ヿ")
      ) {
        result.add(ch);
      }
    }
  }
  return result;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0.0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Delegation helpers (v1.9 — AgentTool mode lightweight utilities)
// ═══════════════════════════════════════════════════════════════════════════

/** Filter relevant constraints for a sub-agent task using Jaccard token similarity.
 *  Returns constraints whose token overlap with the subTask exceeds the threshold.
 *  Default threshold 0.15 is intentionally lower than the 0.3/0.5 alignment thresholds
 *  — constraint filtering should err on the side of inclusion. */
export function filterConstraintsForSubTask(
  allConstraints: string[],
  subTask: string,
  threshold = 0.15,
): string[] {
  if (!allConstraints.length || !subTask.trim()) return [];
  const taskTokens = tokenize(subTask);
  if (taskTokens.size === 0) return [];
  return allConstraints.filter((c) => {
    const cTokens = tokenize(c);
    return jaccard(taskTokens, cTokens) >= threshold;
  });
}

/** Format a self-contained delegation prompt for a sub-agent.
 *  Produces a prompt that stands alone — no references to parent conversation,
 *  no "based on above", no "continue from previous". This matches the AgentTool
 *  contract: "Workers can't see your conversation." */
export function formatDelegationPrompt(
  subTask: string,
  subAgentType: string,
  relevantConstraints: string[],
  options?: { context?: string; outputFormat?: string },
): string {
  const lines: string[] = [];

  // Header
  lines.push("### Delegated Task");
  lines.push("");
  lines.push(subTask);
  lines.push("");

  // Context (optional — e.g. file paths, module names)
  if (options?.context) {
    lines.push("### Context");
    lines.push("");
    lines.push(options.context);
    lines.push("");
  }

  // Constraints (only for types that need them — Explore is read-only)
  if (relevantConstraints.length && subAgentType !== "explore") {
    lines.push("### Relevant Constraints");
    for (const c of relevantConstraints) lines.push(`- ${c}`);
    lines.push("");
  }

  // Output format (for Explore and Plan agents)
  if (subAgentType === "explore") {
    if (options?.outputFormat) {
      lines.push("### Output Format");
      lines.push("");
      lines.push(options.outputFormat);
      lines.push("");
    } else {
      lines.push("### Output Format");
      lines.push("");
      lines.push("Report findings as a structured list with file paths and line numbers.");
      lines.push("");
    }
  }

  if (subAgentType === "plan") {
    lines.push("### Instructions");
    lines.push("");
    lines.push("Design a concrete implementation plan. Output must include:");
    lines.push("- Step-by-step approach");
    lines.push("- Critical files for implementation (3-5 files with paths)");
    lines.push("- Key design decisions and tradeoffs");
    lines.push("");
  }

  if (subAgentType === "general-purpose") {
    lines.push("### Instructions");
    lines.push("");
    lines.push("Complete the task fully — don't gold-plate, but don't leave it half-done.");
    lines.push("Report what was done, what files were changed, and any issues encountered.");
    lines.push("");
  }

  if (!["explore", "general-purpose", "plan"].includes(subAgentType)) {
    // Custom sub-agent type — generic template
    lines.push("### Instructions");
    lines.push("");
    lines.push("Complete the task above and report results concisely.");
    lines.push("");
  }

  return lines.join("\n");
}

/** Build a delegation history summary from vault context (v1.9 — multi-agent).
 *  Scans vault for delegation_journal entries and formats them as a table.
 *  Returns empty string if no delegation history exists. */
export function buildDelegationSummary(
  vaultContext: Record<string, unknown> | null,
): string {
  if (!vaultContext) return "";
  const results = vaultContext.results as Record<string, unknown>[] | undefined;
  if (!results?.length) return "";

  const delegations = results.filter(
    (r) => r?.task_type === "delegation_journal",
  );
  if (!delegations.length) return "";

  // Helper: escape pipe characters so they don't break the markdown table
  const esc = (s: string): string => s.replace(/\|/g, "\\|");

  // Collect all delegation entries across rounds
  const entries: { round: number; agentId: string; type: string; task: string; result: string; success: boolean }[] = [];
  for (const d of delegations) {
    const lineage = d.loop_lineage as Record<string, unknown> | undefined;
    const round = typeof lineage?.round === "number" ? lineage.round : 0;
    const dels = lineage?.delegations as Array<Record<string, unknown>> | undefined;
    if (!dels?.length) continue;
    for (const e of dels) {
      entries.push({
        round,
        agentId: typeof e.agentId === "string" ? e.agentId : (typeof e.index === "number" ? `worker-${e.index}` : "?"),
        type: typeof e.subAgentType === "string" ? e.subAgentType : "?",
        task: typeof e.subTask === "string" ? e.subTask : "?",
        result: typeof e.resultSummary === "string" ? e.resultSummary : "?",
        success: typeof e.success === "boolean" ? e.success : true,
      });
    }
  }

  if (!entries.length) return "";

  const lines: string[] = [
    "",
    "### Delegation History (Multi-Agent)",
    "",
    "| Round | Agent | Type | Task | Result | ✓/✗ |",
    "|-------|-------|------|------|--------|-----|",
  ];
  for (const e of entries) {
    const status = e.success ? "✓" : "✗";
    const shortAgent = e.agentId.length > 24 ? e.agentId.slice(0, 21) + "..." : e.agentId;
    const shortTask = e.task.length > 50 ? e.task.slice(0, 47) + "..." : e.task;
    const shortResult = e.result.length > 40 ? e.result.slice(0, 37) + "..." : e.result;
    lines.push(`| R${e.round} | ${esc(shortAgent)} | ${e.type} | ${esc(shortTask)} | ${esc(shortResult)} | ${status} |`);
  }
  lines.push("");

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Goal identity
// ═══════════════════════════════════════════════════════════════════════════

export function computeGoalTextHash(task: string): string {
  const normalized = (task || "").trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized, "utf-8").digest("hex").slice(0, 12);
}

export function deriveGoalId(
  loopId: string,
  task: string,
  explicitGoalId = "",
): string {
  if (explicitGoalId) return explicitGoalId;
  let taskPrefix = (task || "unnamed").slice(0, 60).trim().toLowerCase();
  taskPrefix = taskPrefix.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return loopId ? `${loopId}:${taskPrefix}` : taskPrefix;
}

// ═══════════════════════════════════════════════════════════════════════════
// Previous round lookup
// ═══════════════════════════════════════════════════════════════════════════

interface PreviousRound {
  goal_id: string;
  goal_text_hash: string;
  quality_score: number;
  success: boolean;
  task: string;
  constraints_active: string[];
  prompt_text: string;
}

export function getPreviousRound(
  loopId: string,
  roundNum: number,
  vaultContext: Record<string, unknown> | null,
): PreviousRound | null {
  if (vaultContext === null) return null;
  const results = (vaultContext.results as Record<string, unknown>[]) || [];
  if (!results.length) return null;

  for (const r of results) {
    const lineage = (r.loop_lineage || r.lineage || {}) as Record<string, unknown>;
    if (lineage.loop_id === loopId && lineage.round === roundNum) {
      return {
        goal_id: (lineage.goal_id as string) ?? "",
        goal_text_hash: (lineage.goal_text_hash as string) ?? "",
        quality_score: (lineage.quality_score as number) ?? 0,
        success: (r.success as boolean) ?? true,
        task: (r.task as string) ?? (r.user_intent as string) ?? "",
        constraints_active: (lineage.constraints_active as string[]) ?? [],
        prompt_text: (r.full_prompt as string) ?? "",
      };
    }
  }
  return null;
}

function getRecentRounds(
  loopId: string,
  n: number,
  vaultContext: Record<string, unknown> | null,
): Record<string, unknown>[] {
  if (vaultContext === null) return [];
  const results = (vaultContext.results as Record<string, unknown>[]) || [];
  const rounds: Record<string, unknown>[] = [];

  for (const r of results) {
    const lineage = (r.loop_lineage || r.lineage || {}) as Record<string, unknown>;
    if (lineage.loop_id === loopId) {
      rounds.push({
        quality_score: lineage.quality_score ?? 0,
        round: lineage.round ?? 0,
        goal_text_hash: lineage.goal_text_hash ?? "",
      });
    }
  }
  rounds.sort((a, b) => (b.round as number) - (a.round as number));
  return rounds.slice(0, n);
}

function getPreviousRoundTask(
  loopId: string,
  roundNum: number,
  vaultContext: Record<string, unknown> | null,
): string {
  const prev = getPreviousRound(loopId, roundNum, vaultContext);
  return prev?.task ?? "";
}

function vaultGetLoopObjective(
  loopId: string,
  vaultContext: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (vaultContext === null) return null;

  // Check global entries first
  const globalEntries =
    (vaultContext.global_entries as Record<string, unknown>[]) || [];
  for (const entry of globalEntries) {
    const lo = entry.loop_objective;
    if (lo && entry.loop_id === loopId) {
      return { loop_objective: lo, loop_id: loopId };
    }
  }

  // Check results
  const results = (vaultContext.results as Record<string, unknown>[]) || [];
  for (const r of results) {
    const lo = r.loop_objective;
    if (lo && r.loop_id === loopId) {
      return { loop_objective: lo, loop_id: loopId };
    }
  }
  return null;
}

function countConsecutiveHashMismatches(
  loopId: string,
  vaultContext: Record<string, unknown> | null,
): number {
  if (vaultContext === null) return 0;
  const rounds = getRecentRounds(loopId, 20, vaultContext);
  if (rounds.length < 2) return 0;

  let count = 0;
  for (let i = 0; i < rounds.length - 1; i++) {
    const currHash = rounds[i].goal_text_hash as string;
    const prevHash = rounds[i + 1].goal_text_hash as string;
    if (currHash && prevHash && currHash !== prevHash) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// Strategy collapse detection
// ═══════════════════════════════════════════════════════════════════════════

function strategyCollapse(
  loopId: string,
  vaultContext: Record<string, unknown> | null,
): boolean {
  const recent = getRecentRounds(loopId, 3, vaultContext);
  if (recent.length < 3) return false;
  return recent.every((r) => (r.quality_score as number) < 3);
}

// ═══════════════════════════════════════════════════════════════════════════
// Constraint Retirement (v3.5)
// ═══════════════════════════════════════════════════════════════════════════

function computeConstraintRetirement(
  activeConstraints: string[],
  loopId: string,
  currentRound: number,
  vaultContext: Record<string, unknown> | null,
): { active: string[]; retired: string[] } {
  if (!activeConstraints.length || vaultContext === null) {
    return { active: [...activeConstraints], retired: [] };
  }

  const results = (vaultContext.results as Record<string, unknown>[]) || [];
  if (!results.length) {
    return { active: [...activeConstraints], retired: [] };
  }

  const policy = getPolicy();
  const window = policy.constraints.retire_window;
  const targetRounds = new Set<number>();
  for (let r = currentRound - window; r < currentRound; r++) {
    targetRounds.add(r);
  }

  // Collect all text per target round for activity detection
  const roundTexts = new Map<number, string>();
  for (const r of results) {
    const lineage = (r.loop_lineage || r.lineage || {}) as Record<string, unknown>;
    if (lineage.loop_id !== loopId) continue;
    const rnd = lineage.round as number;
    if (!targetRounds.has(rnd)) continue;

    let text = (
      ((r.task as string) ?? (r.user_intent as string) ?? "") + " " +
      ((lineage.task as string) ?? "") + " " +
      ((r.output_summary as string) ?? "")
    ).toLowerCase();

    for (const v of (r.constraint_violations as string[]) || []) {
      text += " " + String(v).toLowerCase();
    }
    roundTexts.set(rnd, text);
  }

  const retired: string[] = [];
  const pruned: string[] = [];

  for (const constraint of activeConstraints) {
    const cLower = constraint.toLowerCase();
    const cNormalized = cLower.replace(/-/g, " ");
    let isActive = false;

    for (const text of roundTexts.values()) {
      if (text.includes(cLower) || text.includes(cNormalized)) {
        isActive = true;
        break;
      }
    }

    if (isActive || roundTexts.size < window) {
      pruned.push(constraint);
    } else {
      retired.push(constraint);
    }
  }

  return { active: pruned, retired };
}

// ═══════════════════════════════════════════════════════════════════════════
// P4: Progress evidence helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Extract execution evidence from a previous round in the vault.
 *  Used for progress gradient calculation and trend detection. */
function getPreviousRoundEvidence(
  loopId: string,
  roundNum: number,
  vaultContext: Record<string, unknown> | null,
): { progress_estimate: number; success_criteria_met: string[] } | null {
  if (vaultContext === null) return null;
  const results = (vaultContext.results as Record<string, unknown>[]) || [];
  for (const r of results) {
    const lineage = (r.loop_lineage || r.lineage || {}) as Record<string, unknown>;
    if (lineage.loop_id !== loopId) continue;
    if ((lineage.round as number) !== roundNum) continue;

    const evidence = (r.execution_evidence ?? lineage.execution_evidence) as Record<string, unknown> | undefined;
    if (evidence) {
      return {
        progress_estimate: (evidence.progress_estimate as number) ?? 0,
        success_criteria_met: (evidence.success_criteria_met as string[]) ?? [],
      };
    }
    return null;
  }
  return null;
}

/** Count consecutive rounds (including current) where progress delta
 *  has been below the stall threshold. */
function countProgressStallRounds(
  loopId: string,
  currentRound: number,
  vaultContext: Record<string, unknown> | null,
  threshold: number,
): number {
  if (vaultContext === null || currentRound < 2) return 0;
  let count = 0;
  for (let r = currentRound; r >= 2; r--) {
    const curr = getPreviousRoundEvidence(loopId, r, vaultContext);
    const prev = getPreviousRoundEvidence(loopId, r - 1, vaultContext);
    if (curr && prev) {
      const delta = curr.progress_estimate - prev.progress_estimate;
      if (delta < threshold && curr.progress_estimate < 0.95) {
        count++;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════
// Failure Lineage Weighting (v1.7)
// ═══════════════════════════════════════════════════════════════════════════

interface SampledRound {
  round: number;
  quality_score: number;
  task: string;
  output_summary: string;
  constraint_violations: string[];
  technique_used: string;
}

/** Detect repeated failure patterns in sampled rounds.
 *  A failure pattern = 2+ consecutive rounds where:
 *    1. quality_score < 3 (failed or weak)
 *    2. same technique was used
 *    3. task text is similar (Jaccard > 0.4)
 *
 *  Returns human-readable descriptions for injection into the prompt. */
function detectFailurePatterns(sampled: SampledRound[]): string[] {
  if (sampled.length < 2) return [];

  const patterns: string[] = [];

  let runStart = -1;
  for (let i = 0; i < sampled.length; i++) {
    const r = sampled[i];
    const isFailed = r.quality_score < 3;

    if (isFailed && runStart === -1) {
      runStart = i;
    } else if (!isFailed && runStart !== -1) {
      if (i - runStart >= 2) {
        const pattern = classifyRun(sampled.slice(runStart, i));
        if (pattern) patterns.push(pattern);
      }
      runStart = -1;
    }
  }
  // Handle run at end of array
  if (runStart !== -1 && sampled.length - runStart >= 2) {
    const pattern = classifyRun(sampled.slice(runStart));
    if (pattern) patterns.push(pattern);
  }

  return patterns;
}

/** Classify a run of consecutive low-quality rounds as a failure pattern.
 *  Returns null if the rounds are too dissimilar to be the same pattern. */
function classifyRun(run: SampledRound[]): string | null {
  if (run.length < 2) return null;

  // Must all use the same technique
  const technique = run[0].technique_used || "unknown";
  if (!run.every((r) => (r.technique_used || "unknown") === technique)) {
    return null;
  }

  // Task text must be similar across the run (pairwise Jaccard)
  const tokensList = run.map((r) => tokenize(r.task.toLowerCase()));
  for (let i = 0; i < tokensList.length - 1; i++) {
    for (let j = i + 1; j < tokensList.length; j++) {
      if (jaccard(tokensList[i], tokensList[j]) < 0.4) return null;
    }
  }

  const rounds = `R${run[0].round}-R${run[run.length - 1].round}`;
  const taskPreview = run[0].task.slice(0, 80);
  const avgScore = (run.reduce((s, r) => s + r.quality_score, 0) / run.length).toFixed(1);

  return (
    `technique '${technique}' on task '${taskPreview}' ` +
    `failed ${run.length} consecutive rounds (${rounds}, avg score ${avgScore}) — ` +
    `consider strategy change`
  );
}

/** Extract round numbers referenced in failure pattern descriptions.
 *  Used by buildRollingSummary to identify which rounds to demote. */
function extractFailureRoundNums(patterns: string[]): Set<number> {
  const nums = new Set<number>();
  for (const p of patterns) {
    // Match "R2-R4" or "R5"
    const rangeMatch = p.match(/R(\d+)-R(\d+)/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let r = start; r <= end; r++) nums.add(r);
    } else {
      const singleMatch = p.match(/R(\d+)/);
      if (singleMatch) nums.add(parseInt(singleMatch[1], 10));
    }
  }
  return nums;
}

// ═══════════════════════════════════════════════════════════════════════════
// Rolling Summary (v3.5)
// ═══════════════════════════════════════════════════════════════════════════

export function buildRollingSummary(
  loopId: string,
  currentRound: number,
  vaultContext: Record<string, unknown> | null,
): RollingSummary | null {
  if (vaultContext === null) return null;

  const results = (vaultContext.results as Record<string, unknown>[]) || [];
  if (!results.length) return null;

  const policy = getPolicy();
  const window = policy.summary.window;

  // Collect rounds matching this loop_id, excluding current
  const rounds: Record<string, unknown>[] = [];
  for (const r of results) {
    const lineage = (r.loop_lineage || r.lineage || {}) as Record<string, unknown>;
    if (lineage.loop_id !== loopId) continue;
    const rnd = lineage.round as number;
    if (rnd >= currentRound) continue;

    rounds.push({
      round: rnd,
      quality_score: (lineage.quality_score as number) ?? 0,
      task: (r.task as string) ?? (r.user_intent as string) ?? "",
      output_summary: (r.output_summary as string) ?? "",
      constraint_violations: (r.constraint_violations as string[]) || [],
      technique_used: (r.technique_used as string) ?? "",
    });
  }

  if (!rounds.length) return null;

  // Sort by round descending, take last N
  rounds.sort((a, b) => (b.round as number) - (a.round as number));
  const sampled = rounds.slice(0, window).reverse(); // chronological order

  // Quality trajectory
  const trajectory = sampled.map((r) => r.quality_score as number);

  // Trajectory direction
  let direction = "stable";
  if (trajectory.length >= 2) {
    const diffs = trajectory.slice(1).map((v, i) => v - trajectory[i]);
    if (diffs.every((d) => d >= 0) && diffs.some((d) => d > 0)) {
      direction = "improving";
    } else if (diffs.every((d) => d <= 0) && diffs.some((d) => d < 0)) {
      direction = "declining";
    } else if (diffs.every((d) => d === 0)) {
      direction = "stable";
    } else {
      direction = "volatile";
    }
  }

  // What worked
  const whatWorked: string[] = [];
  for (const r of sampled) {
    if (
      (r.quality_score as number) >= 4 &&
      r.output_summary
    ) {
      whatWorked.push(
        `R${r.round} (score=${r.quality_score}, ` +
        `${r.technique_used || "n/a"}): ${String(r.output_summary).slice(0, 150)}`,
      );
    }
  }

  // Recurring issues
  const violationCounts = new Map<string, number>();
  for (const r of sampled) {
    const seen = new Set<string>();
    for (const v of (r.constraint_violations as string[]) || []) {
      const vNorm = String(v).trim().toLowerCase();
      if (vNorm && !seen.has(vNorm)) {
        violationCounts.set(vNorm, (violationCounts.get(vNorm) || 0) + 1);
        seen.add(vNorm);
      }
    }
  }

  let recurringIssues: string[] = [...violationCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([v, count]) => `${v} (appeared in ${count} rounds)`);

  // Key lessons
  const keyLessons: string[] = [];
  for (const r of sampled) {
    if ((r.quality_score as number) >= 4 && r.output_summary) {
      keyLessons.push(
        `[R${r.round}] ${String(r.output_summary).slice(0, 200)}`,
      );
    }
  }

  // v1.7: Failure lineage weighting — detect and demote failure patterns
  const sampledRounds: SampledRound[] = sampled.map((r) => ({
    round: r.round as number,
    quality_score: r.quality_score as number,
    task: r.task as string,
    output_summary: r.output_summary as string,
    constraint_violations: r.constraint_violations as string[],
    technique_used: r.technique_used as string,
  }));
  const failurePatterns = detectFailurePatterns(sampledRounds);
  const failedRoundNums = extractFailureRoundNums(failurePatterns);

  // Re-weight key_lessons: lessons from failure-pattern rounds go to end
  if (failedRoundNums.size > 0 && keyLessons.length > 0) {
    const promoted: string[] = [];
    const demoted: string[] = [];
    for (const kl of keyLessons) {
      const rndMatch = kl.match(/^\[R(\d+)\]/);
      if (rndMatch && failedRoundNums.has(parseInt(rndMatch[1], 10))) {
        demoted.push(kl.replace(/^\[R\d+\]/, "$& [Consider alternatives]"));
      } else {
        promoted.push(kl);
      }
    }
    keyLessons.length = 0;
    keyLessons.push(...promoted, ...demoted);
  }

  // Re-weight recurring_issues: mark issues that ONLY appear in failure-pattern rounds
  if (failedRoundNums.size > 0 && recurringIssues.length > 0) {
    // Build per-round violation sets
    const failureViolations = new Set<string>();
    const successViolations = new Set<string>();
    for (const r of sampledRounds) {
      const target = failedRoundNums.has(r.round) ? failureViolations : successViolations;
      for (const v of r.constraint_violations) {
        target.add(String(v).trim().toLowerCase());
      }
    }
    recurringIssues.length = 0;
    recurringIssues.push(
      ...[...violationCounts.entries()]
        .filter(([, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .map(([v, count]) => {
          const vNorm = v.trim().toLowerCase();
          // Mark if this issue only appears in failure rounds (possible dead end)
          if (failureViolations.has(vNorm) && !successViolations.has(vNorm)) {
            return `${v} (appeared in ${count} rounds) ⚠️ [Possible dead end — only in failed rounds]`;
          }
          return `${v} (appeared in ${count} rounds)`;
        }),
    );
  }

  return makeRollingSummary({
    quality_trajectory: trajectory,
    trajectory_direction: direction,
    what_worked: whatWorked,
    recurring_issues: recurringIssues,
    key_lessons: keyLessons,
    rounds_sampled: sampled.length,
    generated_at_round: currentRound,
    failed_patterns: failurePatterns.length ? failurePatterns : [],
  });
}

export function formatRollingSummaryForPrompt(rs: RollingSummary | null): string {
  if (rs === null || rs.rounds_sampled === 0) return "";

  const lines: string[] = [
    "### Cross-Round Summary (Accumulated)",
    "",
    `**Sampled**: ${rs.rounds_sampled} prior rounds | **Direction**: ${rs.trajectory_direction}`,
    `**Quality Trajectory**: [${rs.quality_trajectory.join(", ")}]`,
    "",
  ];

  if (rs.what_worked.length) {
    lines.push("**What Worked (score >= 4)**:");
    for (const w of rs.what_worked) lines.push(`- ${w}`);
    lines.push("");
  }

  if (rs.recurring_issues.length) {
    lines.push("**Recurring Issues (appeared 2+ times)**:");
    for (const ri of rs.recurring_issues) lines.push(`- ⚠️ ${ri}`);
    lines.push("");
  }

  // v1.7: Failure patterns — explicit warnings about repeated failure paths
  if (rs.failed_patterns && rs.failed_patterns.length) {
    lines.push("### ⚠️ Failure Patterns — Consider Strategy Change");
    lines.push("");
    lines.push(
      "The following approaches failed repeatedly. The compiler has demoted " +
      "their influence on key lessons. Consider a different technique or " +
      "narrower scope.",
    );
    for (const fp of rs.failed_patterns) {
      lines.push(`- 🚫 ${fp}`);
    }
    lines.push("");
  }

  if (rs.key_lessons.length) {
    lines.push("**Key Lessons From High-Score Rounds**:");
    for (const kl of rs.key_lessons) lines.push(`- ${kl}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// External Context formatting (v1.7 — memory system integration)
// ═══════════════════════════════════════════════════════════════════════════

/** Format an external context string for injection into an L2 prompt.
 *  Wraps the raw context in a marked section with a priority disclaimer.
 *  Returns empty string if context is empty or injection is disabled by policy. */
export function formatExternalContext(
  externalContext: string | undefined,
  sectionTitle: string,
  maxLength: number,
): string {
  if (!externalContext || externalContext.trim().length === 0) return "";

  const trimmed = externalContext.trim().slice(0, maxLength);
  const truncationNote = trimmed.length < externalContext.trim().length
    ? `\n> ⚠️ Context was truncated to ${maxLength} characters.`
    : "";

  return [
    "",
    sectionTitle,
    "",
    "> ⚠️ **Role**: Situational awareness only. These are point-in-time",
    "> observations from past sessions — claims about code locations or",
    "> behaviour may be outdated. If any insight contradicts the Loop",
    "> Objective or Active Constraints above, the LoopForge specification",
    "> takes absolute precedence.",
    "",
    trimmed,
    truncationNote,
    "",
    "---",
    "",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — Hard Gates (can change compile level)
// ═══════════════════════════════════════════════════════════════════════════

export function decideLevel(
  request: LoopCompileRequest,
  vaultContext: Record<string, unknown> | null,
): string {
  // Gate 1: Explicit override (never overrides round 1 or plan_source)
  if (
    request.force_level !== "auto" &&
    ["l0", "l1", "l2"].includes(request.force_level)
  ) {
    if (request.round !== 1 && !request.plan_source) {
      return request.force_level;
    }
  }

  // Gate 2: First call or explicit plan input → full rebuild
  if (request.round === 1 || request.plan_source) {
    return "l2";
  }

  // Derive goal_id
  const goalId = deriveGoalId(request.loop_id, request.task, request.goal_id);

  const prev = getPreviousRound(
    request.loop_id,
    request.round - 1,
    vaultContext,
  );
  if (prev === null) return "l2";

  // Gate 3: goal_id stability
  if (goalId !== prev.goal_id) return "l2";

  // Gate 4: P0–P5 cognitive evolution signals → full recompile (v1.7)
  // Check BEFORE the simple repair/new-constraint gates because evolution signals
  // (constraint discovery, objective refinement, self-correction) need full L2
  // processing. Only structural evolution signals trigger L2 — execution_evidence
  // alone does not (it is processed via the rolling summary at L1).
  if (request.last_round_result) {
    const lr = request.last_round_result;
    if (
      (lr.discovered_constraints?.length ?? 0) > 0 ||
      (lr.objective_refinement?.trim().length ?? 0) > 0 ||
      (lr.emerged_subtasks?.length ?? 0) > 0 ||
      (lr.retracted_constraints?.length ?? 0) > 0 ||
      (lr.revised_success_criteria?.length ?? 0) > 0 ||
      (lr.wrong_assumptions?.length ?? 0) > 0
    ) {
      return "l2";
    }
  }

  // Gate 5: Explicit failures or new constraints → patch
  const hasNewConstraints = request.constraints_from_plan.length > 0;
  const hasNewFailures =
    request.last_round_result !== null &&
    !request.last_round_result.success;
  const hasRepair = detectsRepairSignal(request);

  if (hasNewConstraints || hasNewFailures || hasRepair) return "l1";

  // Nothing triggered → fast path
  return "l0";
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2 — Soft Advisories (NEVER change compile level)
// ═══════════════════════════════════════════════════════════════════════════

export function alignTask(
  proposedTask: string,
  request: LoopCompileRequest,
  vaultContext: Record<string, unknown> | null,
): TaskAlignment {
  const objectiveEntry = vaultGetLoopObjective(request.loop_id, vaultContext);

  let objData: Record<string, unknown> | null = null;
  if (request.loop_objective) {
    objData = request.loop_objective as unknown as Record<string, unknown>;
  } else if (objectiveEntry) {
    const lo = objectiveEntry.loop_objective;
    if (lo && typeof lo === "object") {
      objData = lo as Record<string, unknown>;
    }
  }

  if (objData === null) return makeTaskAlignment();

  const objective = (objData.objective as string) ?? "";
  const successCriteria = (objData.success_criteria as string[]) ?? [];
  const hardConstraints = (objData.hard_constraints as string[]) ?? [];

  const proposedTokens = tokenize(proposedTask.toLowerCase());
  const objText =
    `${objective} ${successCriteria.join(" ")} ${hardConstraints.join(" ")}`.toLowerCase();
  const objTokens = tokenize(objText);
  const score =
    proposedTokens.size && objTokens.size
      ? jaccard(proposedTokens, objTokens)
      : 1.0;

  if (score >= 0.5) {
    return makeTaskAlignment({
      is_aligned: true,
      alignment_score: Math.round(score * 100) / 100,
    });
  } else if (score >= 0.3) {
    return makeTaskAlignment({
      is_aligned: true,
      alignment_score: Math.round(score * 100) / 100,
      warning:
        `Proposed task '${proposedTask.slice(0, 80)}' may be drifting from ` +
        `loop objective '${objective}'. Consider narrowing scope.`,
      escalation: "warn",
    });
  } else {
    return makeTaskAlignment({
      is_aligned: false,
      alignment_score: Math.round(score * 100) / 100,
      warning:
        `Proposed task '${proposedTask.slice(0, 80)}' is OFF-OBJECTIVE. ` +
        `Loop objective: '${objective}'. Full realignment recommended.`,
      escalation: "block",
    });
  }
}

export function checkLoopHealth(
  loopId: string,
  request: LoopCompileRequest,
  vaultContext: Record<string, unknown> | null,
): LoopHealth {
  const objectiveEntry = vaultGetLoopObjective(loopId, vaultContext);

  let obj: Record<string, unknown> | null = null;
  if (request.loop_objective) {
    obj = request.loop_objective as unknown as Record<string, unknown>;
  } else if (objectiveEntry) {
    const lo = objectiveEntry.loop_objective;
    if (lo && typeof lo === "object") {
      obj = lo as Record<string, unknown>;
    }
  }

  if (obj === null) return makeLoopHealth();

  const objective = (obj.objective as string) ?? "";
  const successCriteria = (obj.success_criteria as string[]) ?? [];
  const hardConstraints = (obj.hard_constraints as string[]) ?? [];

  // 1. goal_alignment
  let goalAlignment = 1.0;
  if (request.task) {
    const taskTokens = tokenize(request.task.toLowerCase());
    const objText =
      `${objective} ${successCriteria.join(" ")} ${hardConstraints.join(" ")}`.toLowerCase();
    const objTokens = tokenize(objText);
    goalAlignment =
      taskTokens.size && objTokens.size
        ? jaccard(taskTokens, objTokens)
        : 1.0;
  }

  // 2. constraint_integrity
  let constraintIntegrity = 1.0;
  if (request.last_round_result && hardConstraints.length) {
    const outputText = request.last_round_result.output_summary.toLowerCase();
    const present = hardConstraints.filter((c) =>
      c
        .toLowerCase()
        .split(/\s+/)
        .some((word) => outputText.includes(word)),
    ).length;
    constraintIntegrity = present / hardConstraints.length;
  }

  // 3. drift_detected
  const driftDetected =
    countConsecutiveHashMismatches(loopId, vaultContext) >= 3;

  // 4. strategy_stability
  const recent = getRecentRounds(loopId, 3, vaultContext);
  const strategyStability =
    recent.length > 0
      ? recent.every((r) => (r.quality_score as number) >= 4)
      : true;

  // 5. task_continuity
  let taskContinuity = 1.0;
  const prevTask = getPreviousRoundTask(
    loopId,
    request.round - 1,
    vaultContext,
  );
  if (prevTask && request.task) {
    const currTokens = tokenize(request.task.toLowerCase());
    const prevTokens = tokenize(prevTask.toLowerCase());
    taskContinuity =
      currTokens.size && prevTokens.size
        ? jaccard(currTokens, prevTokens)
        : 1.0;
  }

  // Escalation recommendation
  let escalation = "none";
  if (goalAlignment < 0.5) {
    escalation = "l2";
  } else if (constraintIntegrity < 0.7) {
    escalation = "l1";
  } else if (driftDetected) {
    escalation = "l2";
  }

  return makeLoopHealth({
    goal_alignment: Math.round(goalAlignment * 100) / 100,
    constraint_integrity: Math.round(constraintIntegrity * 100) / 100,
    drift_detected: driftDetected,
    strategy_stability: strategyStability,
    task_continuity: Math.round(taskContinuity * 100) / 100,
    escalation_recommended: escalation,
  });
}

function computeSuggestedNextTask(
  loopId: string,
  vaultContext: Record<string, unknown> | null,
): string {
  if (vaultContext === null) return "";
  const results = (vaultContext.results as Record<string, unknown>[]) || [];
  for (const r of results) {
    const lineage = (r.loop_lineage || r.lineage || {}) as Record<string, unknown>;
    if (lineage.loop_id === loopId) {
      const task = (r.task as string) ?? (r.user_intent as string) ?? "";
      if (task) return `Previous round focused on: ${task.slice(0, 120)}`;
    }
  }
  return "";
}

export function computeAdvisories(
  request: LoopCompileRequest,
  vaultContext: Record<string, unknown> | null,
): {
  warnings: string[];
  suggestedNextTask: string;
  alignment: TaskAlignment | null;
  health: LoopHealth | null;
} {
  const warnings: string[] = [];
  let alignment: TaskAlignment | null = null;
  let health: LoopHealth | null = null;
  let suggested = "";

  // goal_text_hash drift detection
  const currentHash = computeGoalTextHash(request.task);
  const prev = getPreviousRound(
    request.loop_id,
    request.round - 1,
    vaultContext,
  );
  if (prev && currentHash !== prev.goal_text_hash && prev.goal_text_hash) {
    warnings.push(
      `goal_text_hash changed (${prev.goal_text_hash} → ${currentHash}) ` +
      "but goal_id matched — wording drift detected",
    );
  }

  // Strategy collapse check
  if (strategyCollapse(request.loop_id, vaultContext)) {
    warnings.push(
      "strategy_collapse: 3 consecutive low-quality rounds — " +
      "consider force_level=L2 rebuild",
    );
  }

  // Repair cue detection
  if (detectsRepairSignal(request)) {
    warnings.push("repair signal detected — L1 patch applied");
  }

  // Task alignment
  if (request.next_task_proposal) {
    alignment = alignTask(
      request.next_task_proposal,
      request,
      vaultContext,
    );
    if (alignment.escalation !== "none") {
      warnings.push(`task_alignment: ${alignment.warning}`);
    }
  }

  // Loop health
  const interval = Math.max(request.health_check_interval, 1);
  if (request.round % interval === 0) {
    health = checkLoopHealth(request.loop_id, request, vaultContext);
    if (health.escalation_recommended !== "none") {
      warnings.push(
        `loop_health recommends ${health.escalation_recommended}: ` +
        `goal_alignment=${health.goal_alignment.toFixed(2)}, ` +
        `constraint_integrity=${health.constraint_integrity.toFixed(2)}, ` +
        `task_continuity=${health.task_continuity.toFixed(2)}`,
      );
    }
    if (health.drift_detected) {
      warnings.push(
        "drift_detected: goal_text_hash diverged 3+ consecutive rounds",
      );
    }
  }

  // Forward hint
  suggested = computeSuggestedNextTask(request.loop_id, vaultContext);

  return { warnings, suggestedNextTask: suggested, alignment, health };
}

// ═══════════════════════════════════════════════════════════════════════════
// Plan extraction
// ═══════════════════════════════════════════════════════════════════════════

function extractObjectiveFromPlan(
  planPath: string,
): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(planPath, "utf-8");
  } catch {
    return null;
  }

  const sections: Record<string, string[]> = {
    goal: [],
    success: [],
    constraints: [],
  };
  let currentSection: string | null = null;

  const goalPatterns = ["goal", "objective", "目标", "目的", "意图"];
  const successPatterns = [
    "success criteria", "acceptance criteria", "验收标准", "成功标准",
    "done when", "完成标准", "交付标准", "outcome", "deliverable",
    "结果", "产出", "交付物",
  ];
  const constraintPatterns = [
    "hard constraint", "constraint", "non-goal", "out of scope",
    "硬约束", "约束", "非目标", "不做什么", "限制",
  ];

  for (const line of text.split("\n")) {
    const stripped = line.trim();
    const low = stripped
      .toLowerCase()
      .replace(/^#+\s*/, "");

    if (stripped.startsWith("#")) {
      if (goalPatterns.some((p) => low.includes(p))) {
        currentSection = "goal";
        continue;
      }
      if (successPatterns.some((p) => low.includes(p))) {
        currentSection = "success";
        continue;
      }
      if (constraintPatterns.some((p) => low.includes(p))) {
        currentSection = "constraints";
        continue;
      }
      currentSection = null;
      continue;
    }

    if (!currentSection) continue;

    if (/^[-*•]/.test(stripped)) {
      const item = stripped.replace(/^[-*•]\s*/, "").trim();
      if (item && item.length > 3) {
        sections[currentSection].push(item);
      }
    } else if (stripped && currentSection === "goal") {
      if (!sections.goal.length && stripped.length > 10) {
        sections.goal.push(stripped);
      }
    } else if (stripped && currentSection === "success" && stripped.length > 10) {
      // P3: Also capture free-text paragraphs under success criteria headers
      if (!/^#/.test(stripped)) {
        sections.success.push(stripped);
      }
    }
  }

  if (!Object.values(sections).some((v) => v.length)) return null;

  return {
    objective: sections.goal[0] ?? "",
    success_criteria: sections.success,
    hard_constraints: sections.constraints,
  };
}

function computeLoopObjectiveFromTask(
  request: LoopCompileRequest,
  _vaultContext: Record<string, unknown> | null,
): LoopObjective {
  const task = request.task || "";
  const constraints = [...request.constraints_from_plan];
  let objective = task.trim().slice(0, 200);
  const successCriteria: string[] = [];
  const hardConstraints = [...constraints];

  // P3: Outcome-oriented default success criteria — describe the RESULT,
  //      not the process. The process emerges from the loop.
  if (/test|测试/i.test(task)) {
    successCriteria.push("All tests pass with no regressions");
  }
  if (/compat|兼容/i.test(task)) {
    successCriteria.push("Existing API contracts and integrations unchanged");
  }
  if (/security|安全|audit/i.test(task)) {
    successCriteria.push("All identified vulnerabilities resolved or documented");
  }
  if (/fix|修复|bug/i.test(task)) {
    successCriteria.push("Root cause addressed and verified, not just symptoms");
  }
  if (/build|create|implement|开发|实现|构建/i.test(task)) {
    successCriteria.push("Deliverable matches specification and passes review");
  }
  if (/refactor|重构/i.test(task)) {
    successCriteria.push("Behavior preserved, structure improved, no new failures");
  }
  if (/migrate|迁移|upgrade|升级/i.test(task)) {
    successCriteria.push("Migration completes without data loss or downtime");
  }
  if (/perf|performance|optimize|性能|优化/i.test(task)) {
    successCriteria.push("Measurable improvement verified by benchmarks");
  }

  // P3: Try to extract richer objective from plan_source
  if (request.plan_source) {
    const planExtracted = extractObjectiveFromPlan(request.plan_source);
    if (planExtracted) {
      if (planExtracted.objective) {
        objective = planExtracted.objective as string;
      }
      if (planExtracted.success_criteria) {
        successCriteria.push(
          ...(planExtracted.success_criteria as string[]),
        );
      }
      if (planExtracted.hard_constraints) {
        hardConstraints.push(
          ...(planExtracted.hard_constraints as string[]),
        );
      }
    } else {
      hardConstraints.push(`Follow plan: ${request.plan_source}`);
    }
  }

  // P3: Derive domain from task content for context-aware defaults
  if (!successCriteria.length) {
    if (/\.sol|solidity|contract|智能合约/i.test(task)) {
      successCriteria.push("All functions respect check-effects-interactions pattern");
      successCriteria.push("No unchecked external calls or reentrancy vectors");
    } else if (/\.tsx?|\.jsx?|react|component|组件/i.test(task)) {
      successCriteria.push("Component renders correctly across all states (loading, empty, error)");
      successCriteria.push("No prop-type or accessibility regressions");
    } else if (/api|endpoint|接口|route/i.test(task)) {
      successCriteria.push("Endpoint responds correctly for all defined status codes");
      successCriteria.push("Error responses follow the project's error schema");
    } else {
      successCriteria.push("Task goal achieved with verifiable evidence");
    }
  }
  if (!hardConstraints.length) {
    hardConstraints.push("Do not modify files outside the stated scope");
    hardConstraints.push("Preserve existing test coverage — no test deletions without replacement");
  }

  return makeLoopObjective({
    objective,
    success_criteria: successCriteria,
    hard_constraints: hardConstraints,
    created_at_round: 1,
    loop_id: request.loop_id,
    version: 1,
    refinement_history: [],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Compilation — L0 / L1 / L2
// ═══════════════════════════════════════════════════════════════════════════

function compileL0(
  request: LoopCompileRequest,
  vaultContext: Record<string, unknown> | null,
  prevRound?: PreviousRound | null,
): LoopCompileResponse {
  const prev =
    prevRound ??
    getPreviousRound(request.loop_id, request.round - 1, vaultContext);
  const cachedPrompt = prev?.prompt_text ?? "";

  if (cachedPrompt) {
    return makeLoopCompileResponse({
      status: AgentStatus.OK,
      prompt: cachedPrompt,
      recompile_level: "l0",
      diff_from_previous: `L0 cache hit — reusing prompt from round ${request.round - 1}`,
      lineage: [`${request.loop_id}:r${request.round}`],
      constraints_active: prev?.constraints_active ?? [],
      constraints_retired: [],
      technique_used: "cached",
      loop_id: request.loop_id,
      round: request.round,
      goal_id: deriveGoalId(request.loop_id, request.task, request.goal_id),
      goal_text_hash: computeGoalTextHash(request.task),
      plan_source: request.plan_source,
      warnings: [],
    });
  }

  // Auto-escalate: no cached prompt → delegate to L2
  const l2Response = compileL2(request, vaultContext);
  l2Response.recompile_level = "l0";
  l2Response.diff_from_previous =
    `L0 auto-escalated to L2 — no cached prompt available from round ${request.round - 1}`;
  return l2Response;
}

function compileL1(
  request: LoopCompileRequest,
  vaultContext: Record<string, unknown> | null,
  prevRound?: PreviousRound | null,
): LoopCompileResponse {
  const prev =
    prevRound ??
    getPreviousRound(request.loop_id, request.round - 1, vaultContext);
  const goalId = deriveGoalId(request.loop_id, request.task, request.goal_id);

  const newConstraints = [...request.constraints_from_plan];
  let activeRaw = [...(prev?.constraints_active ?? []), ...newConstraints];
  // Deduplicate preserving order
  activeRaw = [...new Set(activeRaw)];

  // v3.5: Constraint retirement
  const { active, retired } = computeConstraintRetirement(
    activeRaw,
    request.loop_id,
    request.round,
    vaultContext,
  );

  // v3.5: Rolling summary
  const rollingSummary = buildRollingSummary(
    request.loop_id,
    request.round,
    vaultContext,
  );
  const rollingText = formatRollingSummaryForPrompt(rollingSummary);

  const violations =
    request.last_round_result?.constraint_violations ?? [];

  const diffParts: string[] = [];
  if (newConstraints.length) {
    diffParts.push(`new constraints: [${newConstraints.join(", ")}]`);
  }
  if (retired.length) {
    diffParts.push(`retired constraints: [${retired.join(", ")}]`);
  }
  if (violations.length) {
    diffParts.push(`violations from last round: [${violations.join(", ")}]`);
  }
  if (request.new_since_last_round) {
    diffParts.push(`delta: ${request.new_since_last_round.slice(0, 200)}`);
  }

  // Build patched prompt
  const lines: string[] = [
    `## Loop Round ${request.round} — L1 Patch`,
    "",
    `**Goal**: ${request.task}`,
    `**Loop ID**: ${request.loop_id}`,
    `**Goal ID**: ${goalId}`,
    "",
  ];

  if (rollingText) {
    lines.push(rollingText);
    lines.push("");
  }

  if (active.length) {
    lines.push("### Active Constraints (inherited + new, pruned)");
    for (const c of active) lines.push(`- ${c}`);
    lines.push("");
  }

  if (retired.length) {
    lines.push("### Retired Constraints (no recent activity)");
    for (const c of retired) lines.push(`- ~${c}~`);
    lines.push("");
  }

  if (violations.length) {
    lines.push("### Violations From Last Round (must fix)");
    for (const v of violations) lines.push(`- ${v}`);
    lines.push("");
  }

  if (request.new_since_last_round) {
    lines.push("### What Changed Since Last Round");
    lines.push(request.new_since_last_round);
    lines.push("");
  }

  if (request.last_round_result?.output_summary) {
    lines.push("### Last Round Summary");
    lines.push(request.last_round_result.output_summary);
    lines.push("");
  }

  lines.push("### Task");
  lines.push(request.task);

  return makeLoopCompileResponse({
    status: AgentStatus.OK,
    prompt: lines.join("\n"),
    recompile_level: "l1",
    diff_from_previous:
      diffParts.length ? diffParts.join("; ") : "Patch applied.",
    lineage: [`${request.loop_id}:r${request.round}`],
    constraints_active: active,
    constraints_retired: retired,
    technique_used: "patch",
    rolling_summary: rollingSummary,
    loop_id: request.loop_id,
    round: request.round,
    goal_id: goalId,
    goal_text_hash: computeGoalTextHash(request.task),
    plan_source: request.plan_source,
    warnings: [],
  });
}

export function compileL2(
  request: LoopCompileRequest,
  vaultContext: Record<string, unknown> | null,
): LoopCompileResponse {
  const goalId = deriveGoalId(request.loop_id, request.task, request.goal_id);

  // v3.5: Adaptive technique routing
  const analysis = routeTechniqueAdaptive(
    request.task,
    vaultContext,
    request.loop_id,
  );
  const technique = analysis.technique;
  const referenceFile = analysis.reference_file;

  // v3.5: Rolling summary
  const rollingSummary = buildRollingSummary(
    request.loop_id,
    request.round,
    vaultContext,
  );

  // P5c: Wrong assumptions — must be applied BEFORE formatting so they appear
  // in the rendered cross-round summary text injected into the prompt.
  const lr = request.last_round_result;
  if (lr?.wrong_assumptions?.length) {
    if (rollingSummary) {
      rollingSummary.key_lessons = [
        ...rollingSummary.key_lessons,
        ...lr.wrong_assumptions.map((a) => `Wrong assumption corrected: ${a}`),
      ];
    }
  }

  const rollingText = formatRollingSummaryForPrompt(rollingSummary);

  // ── Loop Objective: create at round 1, load from vault at later rounds ──
  let loopObjective: LoopObjective | null = null;
  if (request.round === 1) {
    if (request.loop_objective) {
      loopObjective = request.loop_objective;
    } else {
      loopObjective = computeLoopObjectiveFromTask(request, vaultContext);
    }
  } else {
    // P1 fix: Load loop objective from vault for round > 1
    const vaultLo = vaultGetLoopObjective(request.loop_id, vaultContext);
    if (vaultLo) {
      const loData = vaultLo.loop_objective as Record<string, unknown> | undefined;
      if (loData) {
        loopObjective = makeLoopObjective({
          objective: (loData.objective as string) ?? "",
          success_criteria: (loData.success_criteria as string[]) ?? [],
          hard_constraints: (loData.hard_constraints as string[]) ?? [],
          created_at_round: (loData.created_at_round as number) ?? 1,
          loop_id: (loData.loop_id as string) ?? request.loop_id,
          version: (loData.version as number) ?? 1,
          refinement_history: (loData.refinement_history as string[]) ?? [],
        });
      }
    }
    if (!loopObjective && request.loop_objective) {
      loopObjective = request.loop_objective;
    }
  }

  // ── P1: Apply objective_refinement from last round ──
  if (loopObjective && request.last_round_result?.objective_refinement) {
    const refinement = request.last_round_result.objective_refinement.trim();
    if (refinement) {
      const version = (loopObjective.version ?? 1) + 1;
      const history = [...(loopObjective.refinement_history ?? []), refinement];
      // Enforce max versions from policy
      const policy = getPolicy();
      const maxVersions = policy.evolution?.max_objective_versions ?? 10;
      const prunedHistory = history.slice(-maxVersions);
      const refinedObjective =
        `${loopObjective.objective} [R${request.round}: ${refinement}]`;
      loopObjective = makeLoopObjective({
        ...loopObjective,
        objective: refinedObjective,
        version,
        refinement_history: prunedHistory,
      });
    }
  }

  // ── Build active constraints (base + LO + P0 discovered) ──
  let constraints = [...request.constraints_from_plan];
  if (loopObjective) {
    constraints = [
      ...new Set([
        ...constraints,
        ...loopObjective.hard_constraints,
        ...loopObjective.success_criteria,
      ]),
    ];
  }
  // P0: Merge discovered constraints from last round
  if (request.last_round_result?.discovered_constraints?.length) {
    const policy = getPolicy();
    const maxPerRound = policy.evolution?.max_discovered_constraints_per_round ?? 5;
    const maxActive = policy.evolution?.max_active_constraints ?? 15;
    const newConstraints = request.last_round_result.discovered_constraints
      .slice(0, maxPerRound)
      .filter((c) => !constraints.includes(c));
    constraints = [...constraints, ...newConstraints].slice(0, maxActive);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // P5: Self-correction — MUST process retractions/revisions BEFORE prompt build
  // so the technician compiler sees the corrected constraints and loop objective.
  // ═══════════════════════════════════════════════════════════════════════════
  const warnings: string[] = [];
  const retired: string[] = [];

  // P5a: Retracted constraints — remove from active set
  if (lr?.retracted_constraints?.length) {
    for (const rc of lr.retracted_constraints) {
      const idx = constraints.indexOf(rc);
      if (idx >= 0) {
        constraints.splice(idx, 1);
        retired.push(`[agent-retracted] ${rc}`);
      }
    }
  }

  // P5b: Revised success criteria — update Loop Objective
  if (lr?.revised_success_criteria?.length && loopObjective) {
    const sc = [...loopObjective.success_criteria];
    for (const rev of lr.revised_success_criteria) {
      const idx = sc.indexOf(rev.old);
      if (idx >= 0) {
        sc[idx] = rev.new;
      } else {
        sc.push(rev.new);
      }
    }
    const version = (loopObjective.version ?? 1) + 1;
    const history = [
      ...(loopObjective.refinement_history ?? []),
      `R${request.round}: revised ${lr.revised_success_criteria.length} success criteria`,
    ];
    const updatedLo = makeLoopObjective({
      ...loopObjective,
      success_criteria: sc,
      version,
      refinement_history: history,
    });
    // Rebuild constraints to include revised criteria
    constraints = [...new Set([
      ...constraints.filter((c) => !updatedLo.hard_constraints.includes(c) && !updatedLo.success_criteria.includes(c)),
      ...updatedLo.hard_constraints,
      ...updatedLo.success_criteria,
    ])];
    loopObjective = updatedLo;
  }

  // ── Route to technique-specific specialist (v1.1 deep integration) ──
  let prompt: string;
  if (technique === "step-back") {
    prompt = compileStepBack(
      request, goalId, constraints, loopObjective,
      rollingText, analysis,
    );
  } else if (technique === "least-to-most") {
    prompt = compileLeastToMost(
      request, goalId, constraints, loopObjective,
      rollingText, analysis,
    );
  } else if (technique === "tree-of-thought") {
    prompt = compileToT(
      request, goalId, constraints, loopObjective,
      rollingText, analysis,
    );
  } else {
    prompt = compileGeneric(
      request, goalId, constraints, loopObjective,
      rollingText, analysis, referenceFile, technique,
    );
  }

  // ── v1.7: Inject external memory context (L2 only) ──
  const policy = getPolicy();
  if (policy.memory_injection.enabled && request.external_context) {
    prompt += formatExternalContext(
      request.external_context,
      policy.memory_injection.section_title,
      policy.memory_injection.max_context_length,
    );
  }

  // ── P2: Emerged subtasks → suggested next task ──
  let suggestedNextTask = "";
  if (request.last_round_result?.emerged_subtasks?.length) {
    suggestedNextTask = request.last_round_result.emerged_subtasks
      .slice(0, 3)
      .join("; ");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // P4: Consistency validation — cross-check agent claims
  // ═══════════════════════════════════════════════════════════════════════════
  const evidence = lr?.execution_evidence;
  if (evidence) {
    // Check 1: Agent claims action but reports no files changed
    if (evidence.files_changed.length === 0 && lr.output_summary) {
      const actionWords = /\b(fix|modif|chang|updat|refactor|implement|add|remov|delet|rewrit|修补|修改|更改|更新|重构|实现|添加|删除|重写)\b/i;
      if (actionWords.test(lr.output_summary)) {
        warnings.push(
          "P4: Agent output claims changes but execution_evidence.files_changed is empty — possible oversight",
        );
      }
    }

    // Check 2: Agent reports success but tests failed
    if (evidence.test_results && evidence.test_results.failed > 0 && lr.success) {
      warnings.push(
        `P4: Agent reports success=true but ${evidence.test_results.failed} tests failed — claims may not match reality`,
      );
    }

    // Check 3: Progress estimate mismatch with criteria tracking
    if (loopObjective && loopObjective.success_criteria.length > 0) {
      const metCount = evidence.success_criteria_met.length;
      const totalCount = loopObjective.success_criteria.length;
      const objectiveProgress = totalCount > 0 ? metCount / totalCount : 0;
      const subjectiveProgress = evidence.progress_estimate;
      const policy = getPolicy();
      const mismatchThreshold = policy.evolution?.progress_mismatch_threshold ?? 0.3;
      if (Math.abs(objectiveProgress - subjectiveProgress) > mismatchThreshold) {
        warnings.push(
          `P4: Progress estimate mismatch — agent estimates ${(subjectiveProgress * 100).toFixed(0)}% but ${metCount}/${totalCount} criteria met (${(objectiveProgress * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // P4: Progress gradient — early stall detection
  // ═══════════════════════════════════════════════════════════════════════════
  if (evidence && vaultContext) {
    const prevEvidence = getPreviousRoundEvidence(
      request.loop_id, request.round - 1, vaultContext,
    );
    if (prevEvidence) {
      const delta = evidence.progress_estimate - prevEvidence.progress_estimate;
      const policy = getPolicy();
      const stallThreshold = policy.evolution?.progress_stall_threshold ?? 0.05;
      const stallRounds = policy.evolution?.progress_stall_rounds ?? 2;
      if (delta < stallThreshold && evidence.progress_estimate < 0.95) {
        // Check how many consecutive rounds have been below threshold
        const stallCount = countProgressStallRounds(
          request.loop_id, request.round, vaultContext, stallThreshold,
        );
        if (stallCount >= stallRounds) {
          warnings.push(
            `P4: Progress has stalled — <${(stallThreshold * 100).toFixed(0)}% improvement for ${stallCount} consecutive rounds. Current: ${(evidence.progress_estimate * 100).toFixed(0)}%`,
          );
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // P4: Build Progress Dashboard for prompt injection
  // ═══════════════════════════════════════════════════════════════════════════
  let progressDashboard = "";
  if (evidence && loopObjective) {
    const totalCriteria = loopObjective.success_criteria.length;
    const metCriteria = evidence.success_criteria_met.length;
    const remainingCriteria = evidence.success_criteria_remaining;
    const objProgress = totalCriteria > 0 ? metCriteria / totalCriteria : evidence.progress_estimate;
    const subjProgress = evidence.progress_estimate;

    const lines: string[] = [
      "",
      "### Progress Dashboard",
      "",
      `**Overall**: ${metCriteria}/${totalCriteria} criteria met (${(objProgress * 100).toFixed(0)}%)`,
    ];
    if (Math.abs(objProgress - subjProgress) > 0.05) {
      lines.push(`**Agent estimate**: ${(subjProgress * 100).toFixed(0)}%`);
    }
    if (evidence.files_changed.length) {
      lines.push(`**Files changed**: ${evidence.files_changed.join(", ")}`);
    }
    if (evidence.test_results) {
      const tr = evidence.test_results;
      lines.push(`**Tests**: ${tr.passed} passed, ${tr.failed} failed, ${tr.skipped} skipped`);
    }
    if (remainingCriteria.length) {
      lines.push("**Remaining criteria**:");
      for (const rc of remainingCriteria.slice(0, 5)) {
        lines.push(`- ${rc}`);
      }
      if (remainingCriteria.length > 5) {
        lines.push(`- ... and ${remainingCriteria.length - 5} more`);
      }
    }
    lines.push("");

    // Compute trend from previous round
    if (vaultContext) {
      const prevEvidence = getPreviousRoundEvidence(
        request.loop_id, request.round - 1, vaultContext,
      );
      if (prevEvidence) {
        const trend = objProgress - (prevEvidence.success_criteria_met.length / Math.max(totalCriteria, 1));
        if (trend > 0.03) {
          lines.push(`**Trend**: ↑ advancing (+${(trend * 100).toFixed(0)}% this round)`);
        } else if (trend > -0.03) {
          lines.push("**Trend**: → stable");
        } else {
          lines.push(`**Trend**: ↓ regressing (${(trend * 100).toFixed(0)}% this round)`);
        }
        lines.push("");
      }
    }

    progressDashboard = lines.join("\n");
  }

  return makeLoopCompileResponse({
    status: AgentStatus.OK,
    prompt: prompt + progressDashboard,
    recompile_level: "l2",
    diff_from_previous:
      request.round === 1 || request.plan_source
        ? "Full recompile — new goal or first call."
        : "Full recompile — goal_id changed or strategy collapse.",
    lineage: [`${request.loop_id}:r${request.round}`],
    constraints_active: constraints,
    constraints_retired: retired,
    technique_used: technique,
    reference_file: referenceFile,
    rolling_summary: rollingSummary,
    loop_id: request.loop_id,
    round: request.round,
    goal_id: goalId,
    goal_text_hash: computeGoalTextHash(request.task),
    loop_objective: loopObjective,
    plan_source: request.plan_source,
    suggested_next_task: suggestedNextTask,
    warnings,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Technique-specialist compilers (v1.1 — deep integration)
// ═══════════════════════════════════════════════════════════════════════════

interface SpecialistContext {
  request: LoopCompileRequest;
  goalId: string;
  constraints: string[];
  loopObjective: LoopObjective | null;
  rollingText: string;
}

function buildHeader(
  ctx: SpecialistContext,
  technique: string,
): string[] {
  const lines: string[] = [
    `## LoopForge L2 Compile — Round ${ctx.request.round}`,
    `**Technique**: ${technique} (embedded)`,
    "",
  ];
  if (ctx.rollingText) {
    lines.push(ctx.rollingText);
    lines.push("");
  }
  return lines;
}

function buildLoopObjectiveBlock(lo: LoopObjective | null): string[] {
  if (!lo) return [];
  const lines: string[] = [
    "### Loop Objective (Anchor)",
    `**Objective**: ${lo.objective}`,
  ];
  if (lo.success_criteria.length) {
    lines.push("**Success Criteria**:");
    for (const sc of lo.success_criteria) lines.push(`- ${sc}`);
  }
  if (lo.hard_constraints.length) {
    lines.push("**Hard Constraints**:");
    for (const hc of lo.hard_constraints) lines.push(`- ${hc}`);
  }
  lines.push("");
  return lines;
}

function buildConstraintsBlock(constraints: string[]): string[] {
  if (!constraints.length) return [];
  const lines = ["### Active Constraints"];
  for (const c of constraints) lines.push(`- ${c}`);
  lines.push("");
  return lines;
}

function buildTaskBlock(ctx: SpecialistContext): string[] {
  const lines: string[] = [
    "### Task",
    ctx.request.task,
    "",
  ];
  if (ctx.request.domain) {
    lines.push(`**Domain**: ${ctx.request.domain}`);
    lines.push("");
  }
  return lines;
}

function buildIdentityBlock(ctx: SpecialistContext): string[] {
  return [
    "### Loop Identity",
    `- Loop ID: \`${ctx.request.loop_id}\``,
    `- Goal ID: \`${ctx.goalId}\``,
    `- Round: ${ctx.request.round}`,
    "",
  ];
}

/** Generic compiler — reads technique reference file (fallback for zero-shot/few-shot/cot). */
function compileGeneric(
  request: LoopCompileRequest,
  goalId: string,
  constraints: string[],
  loopObjective: LoopObjective | null,
  rollingText: string,
  analysis: import("./protocol.js").Analysis,
  referenceFile: string,
  technique: string,
): string {
  const ctx: SpecialistContext = { request, goalId, constraints, loopObjective, rollingText };
  const lines: string[] = [
    ...buildHeader(ctx, technique),
    `Read the technique reference BEFORE generating the prompt:`,
    `  Technique:  ${technique}`,
    `  Reference:  ${referenceFile}`,
    `  Rationale:  ${analysis.rationale}`,
    "",
    ...buildLoopObjectiveBlock(loopObjective),
    ...buildConstraintsBlock(constraints),
    ...(request.plan_source ? [`**Plan Source**: ${request.plan_source}`, ""] : []),
    ...buildTaskBlock(ctx),
    ...buildIdentityBlock(ctx),
    "### Generation Instructions",
    `1. Read \`${referenceFile}\` — study its structure rules, section count, and format requirements`,
    "2. Generate a complete prompt following that technique's structure",
    "3. Inject all hard constraints and the loop objective into the prompt",
    "4. If Cross-Round Summary is present above, incorporate its recurring issues and key lessons",
    "5. The prompt must be self-contained — ready for a coding agent to execute",
    "6. Output only the generated prompt — no preamble, no meta-commentary",
  ];
  return lines.join("\n");
}

// ── Step-Back specialist ───────────────────────────────────────────────────────

function compileStepBack(
  request: LoopCompileRequest,
  goalId: string,
  constraints: string[],
  loopObjective: LoopObjective | null,
  rollingText: string,
  analysis: import("./protocol.js").Analysis,
): string {
  const ctx: SpecialistContext = { request, goalId, constraints, loopObjective, rollingText };
  const lines: string[] = [
    ...buildHeader(ctx, "step-back"),
    `**Rationale**: ${analysis.rationale}`,
    "",
    "Generate a complete prompt using the **Step-Back** technique. Follow the 8-section skeleton below.",
    "Embed all structural constraints — do NOT reference an external file.",
    "",
    ...buildLoopObjectiveBlock(loopObjective),
    ...buildConstraintsBlock(constraints),
    ...(request.plan_source ? [`**Plan Source**: ${request.plan_source}`, ""] : []),
    ...buildTaskBlock(ctx),
    ...buildIdentityBlock(ctx),
    "",
    "### 8-Section Skeleton (REQUIRED)",
    "",
    "| # | Section | Required | Notes |",
    "|---|---------|----------|-------|",
    "| 1 | 角色 | ✓ | Domain expert role appropriate to the task |",
    "| 2 | 任务 | ✓ | One-sentence task summary |",
    "| 3 | 输入 | ✓ | Target module/problem to analyse |",
    "| 4 | 输出格式 | ✓ | Numbered list of expected outputs |",
    "| 5 | **Step-Back 抽象框架** | ✓ | See format rules below |",
    "| 6 | 具体实现要求 | ✓ | MUST start with: **\"基于上述抽象框架，实现以下所有功能\"** |",
    "| 7 | 硬约束 | ✓ | Numbered list of hard constraints |",
    "| 8 | 生成要求 | ✓ | Acceptance criteria |",
    "",
    "### Section 5 — Step-Back 抽象框架 (CRITICAL)",
    "",
    "Must contain **2-3 abstract frameworks**. Each framework is an independent ASCII diagram.",
    "Frameworks are PARALLEL (peer-level), not sequential.",
    "",
    "Each framework format:",
    "```",
    "### 框架N：[Framework Name]",
    "",
    "[ASCII diagram with principles/formulas/classification tables/rule tables]",
    "",
    "Diagram content requirements:",
    "- Core principle/formula (e.g. \"Total = Σ(dimension × weight)\")",
    "- Component table (e.g. weight allocation table, type mapping table)",
    "- Rule description (e.g. \"Missing data dimensions use neutral value\")",
    "```",
    "",
    "**Tightening rules**:",
    "- The step-back question must be MORE ABSTRACT than the original problem, but cover all required information",
    "- Abstract ≠ vague. Use precise formulas, principles, standards, definitions, or causal mechanisms",
    "- Tighten to the MINIMUM generalisation layer that still covers the original problem",
    "- Reasoning must RETURN to the original problem — do not stay at the principle level",
    "",
    "**Section 6 transition sentence (MANDATORY)**:",
    "\"基于上述抽象框架，实现以下所有功能。\"",
    "",
    "### Quality Checklist",
    "- [ ] Frameworks are abstract concepts/formulas/principles, NOT concrete code",
    "- [ ] Section 6 starts with the mandatory transition sentence",
    "- [ ] Abstraction level is consistent across frameworks",
    "- [ ] Step-back question is tightened to minimum necessary generalisation",
    "",
    "### Generation Instructions",
    "1. Extract 2-3 abstract principles/frameworks from the task domain",
    "2. Build ASCII diagrams for each framework (formulas, tables, rules)",
    "3. Apply the abstraction back to the concrete task",
    "4. Inject all hard constraints and the loop objective into the prompt",
    "5. If Cross-Round Summary is present above, incorporate its recurring issues and key lessons",
    "6. Output only the generated prompt — no preamble, no meta-commentary",
  ];
  return lines.join("\n");
}

// ── Least-to-Most specialist ───────────────────────────────────────────────────

function compileLeastToMost(
  request: LoopCompileRequest,
  goalId: string,
  constraints: string[],
  loopObjective: LoopObjective | null,
  rollingText: string,
  analysis: import("./protocol.js").Analysis,
): string {
  const ctx: SpecialistContext = { request, goalId, constraints, loopObjective, rollingText };
  const lines: string[] = [
    ...buildHeader(ctx, "least-to-most"),
    `**Rationale**: ${analysis.rationale}`,
    "",
    "Generate a complete prompt using the **Least-to-Most** technique. Follow the 8-section skeleton below.",
    "Embed all structural constraints — do NOT reference an external file.",
    "",
    ...buildLoopObjectiveBlock(loopObjective),
    ...buildConstraintsBlock(constraints),
    ...(request.plan_source ? [`**Plan Source**: ${request.plan_source}`, ""] : []),
    ...buildTaskBlock(ctx),
    ...buildIdentityBlock(ctx),
    "",
    "### 8-Section Skeleton (REQUIRED)",
    "",
    "| # | Section | Required | Notes |",
    "|---|---------|----------|-------|",
    "| 1 | 角色 | ✓ | Domain expert role appropriate to the task |",
    "| 2 | 任务 | ✓ | One-sentence task summary |",
    "| 3 | 输入 | ✓ | Target module |",
    "| 4 | 输出格式 | ✓ | Numbered list (e.g. \"1. DDL, 2. API, 3. Enum...\") |",
    "| 5 | **Least-to-Most 逐步推理框架** | ✓ | See format rules below |",
    "| 6 | 具体实现要求 | ✓ | Expand per output format list (NOT per sub-problem — sub-problems fully expanded in §5) |",
    "| 7 | 硬约束 | ✓ | Numbered list |",
    "| 8 | 生成要求 | ✓ | Acceptance criteria, must include: \"严格按照子问题顺序逐步实现\" |",
    "",
    "### Section 5 — Least-to-Most 逐步推理框架 (CRITICAL)",
    "",
    "Must contain **4-6 ordered sub-problems**. Each sub-problem format:",
    "",
    "```",
    "### 子问题 N：[Sub-problem Name]",
    "",
    "**目标：** [What this sub-problem solves, which prior sub-problem(s) it depends on]",
    "",
    "**要求：**",
    "- Specific requirement list",
    "- [If sub-problem involves enums/mapping tables, list them]",
    "",
    "---",
    "```",
    "",
    "**Critical rules**:",
    "- Sub-problem 1 is the SIMPLEST (e.g. \"Define enums and base data structures\")",
    "- Each sub-problem declares: \"基于子问题 N-1 的结论\"",
    "- The LAST sub-problem MUST be: **\"综合实现完整模块\"** — list all components to integrate",
    "- Sub-problems separated by `---`",
    "- Order goes from LEAST complex → MOST complex, dependency chain must be explicit",
    "- Each sub-problem must serve the original task — no unrelated steps",
    "- The final sub-problem must be equivalent to or directly address the original task",
    "",
    "### Quality Checklist",
    "- [ ] Sub-problems ordered simplest → most complex, dependency chain explicit",
    "- [ ] Each sub-problem declares its prerequisite sub-problems",
    "- [ ] Last sub-problem is \"综合实现完整模块\" with integration list",
    "- [ ] Section 6 expands per output format list (NOT per sub-problem)",
    "- [ ] Sub-problem count: 4-6, no more, no less",
    "",
    "### Generation Instructions",
    "1. Decompose the task into 4-6 ordered sub-problems with explicit dependencies",
    "2. Sub-problem 1 starts with the simplest building block (data structures, enums, base config)",
    "3. Each subsequent sub-problem builds on prior results",
    "4. Final sub-problem integrates all components into the complete module",
    "5. Inject all hard constraints and the loop objective into the prompt",
    "6. If Cross-Round Summary is present above, incorporate its recurring issues and key lessons",
    "7. Output only the generated prompt — no preamble, no meta-commentary",
  ];
  return lines.join("\n");
}

// ── Tree-of-Thought specialist ──────────────────────────────────────────────────

function compileToT(
  request: LoopCompileRequest,
  goalId: string,
  constraints: string[],
  loopObjective: LoopObjective | null,
  rollingText: string,
  analysis: import("./protocol.js").Analysis,
): string {
  const ctx: SpecialistContext = { request, goalId, constraints, loopObjective, rollingText };
  const lines: string[] = [
    ...buildHeader(ctx, "tree-of-thought"),
    `**Rationale**: ${analysis.rationale}`,
    "",
    "Generate a complete prompt using the **Tree-of-Thought** technique. Follow the 8-section skeleton below.",
    "Embed all structural constraints — do NOT reference an external file.",
    "",
    ...buildLoopObjectiveBlock(loopObjective),
    ...buildConstraintsBlock(constraints),
    ...(request.plan_source ? [`**Plan Source**: ${request.plan_source}`, ""] : []),
    ...buildTaskBlock(ctx),
    ...buildIdentityBlock(ctx),
    "",
    "### 8-Section Skeleton (REQUIRED)",
    "",
    "| # | Section | Required | Notes |",
    "|---|---------|----------|-------|",
    "| 1 | 角色 | ✓ | Multi-path problem-solving expert; may introduce 3 expert personas |",
    "| 2 | 任务 | ✓ | One-sentence task summary |",
    "| 3 | 输入 | ✓ | High-risk complex problem |",
    "| 4 | 输出格式 | ✓ | \"先输出思维树过程，再输出最终答案/方案\" |",
    "| 5 | **思维树探索框架** | ✓ | See 3 sub-blocks below (REQUIRED) |",
    "| 6 | 具体实现要求 | ✓ | Expand per output format |",
    "| 7 | 硬约束 | ✓ | Include branch_count, max_depth, pruning rules, safety/performance constraints |",
    "| 8 | 生成要求 | ✓ | \"先探索多路径，再选择最优方案\" |",
    "",
    "### Section 5 — 思维树探索框架 (CRITICAL — 3 sub-blocks REQUIRED)",
    "",
    "**Sub-block A: Search Strategy Declaration**",
    "```",
    "搜索策略: [beam / dfs / expert-panel]",
    "分支数(branch_count): 2-4",
    "最大深度(max_depth): ≤3",
    "每轮保留数(keep_count): 1-2",
    "```",
    "Strategy selection guide:",
    "- **beam** (default): planning, creative, math search — generate multiple candidates per turn, keep top b",
    "- **dfs**: puzzles, constraint satisfaction, debugging — go deep on highest-score branch, backtrack on failure",
    "- **expert-panel**: 3+ experts each generate candidates, then cross-evaluate and revise",
    "",
    "**Sub-block B: Evaluation Criteria Table**",
    "| 标准 | 权重 | 说明 |",
    "|------|------|------|",
    "| 正确性 | 最高 | Logic/math correctness |",
    "| 可行性 | 高 | Can be actually implemented |",
    "| 约束匹配 | 高 | Satisfies hard constraints |",
    "| 性能 | 中 | Time/space efficiency |",
    "| 安全性 | 最高 | No vulnerabilities/privilege escalation |",
    "",
    "**Sub-block C: Thought Tree State Table Format**",
    "Require the model to output in this table format:",
    "```",
    "| 轮次 | 分支 | 候选方案 | 评估 | 决策 |",
    "|------|------|---------|------|------|",
    "| 1    | A    | [方案描述] | 评分/判断 | 保留/剪枝 |",
    "| 1    | B    | [方案描述] | 评分/判断 | 保留/剪枝 |",
    "| 1    | C    | [方案描述] | 评分/判断 | 保留/剪枝 |",
    "| 2    | A1   | [深入展开] | ... | ... |",
    "| ...  | ...  | ...       | ... | ... |",
    "",
    "最终选择: [最优方案 + 选择理由]",
    "```",
    "",
    "### Critical Rules",
    "- Hard constraints MUST be ranked FIRST in evaluation criteria",
    "- Branch count: 2-4, depth: ≤3 (prevents token explosion)",
    "- Every turn: generate multiple candidates → evaluate → keep/prune — never single-path",
    "- If all branches are low quality: backtrack to previous turn and regenerate",
    "- The core of ToT is NOT \"3 experts chatting\" — it's: candidate generation → state evaluation → search/prune → final selection",
    "- thought is a PUBLIC intermediate semantic unit, not hidden chain-of-thought",
    "- State table MUST have: round, branch ID, candidate description, evaluation score/judgment, keep/prune decision",
    "",
    "### Quality Checklist",
    "- [ ] Branch count 2-4, depth ≤3 (prevents token explosion)",
    "- [ ] Evaluation criteria table has ≥3 dimensions including correctness, feasibility, constraint matching",
    "- [ ] State table format explicit (round/branch/candidate/evaluation/decision)",
    "- [ ] Search strategy matches task type (beam/dfs/expert-panel)",
    "- [ ] Hard constraints listed FIRST in evaluation criteria",
    "- [ ] Not \"3 experts casually discussing\" — has explicit branch count, depth, scoring, and pruning rules",
    "- [ ] Ends with model outputting final selection and rationale",
    "",
    "### Generation Instructions",
    "1. Select the appropriate search strategy (beam/dfs/expert-panel) based on task type",
    "2. Define 2-4 candidate approaches as initial branches",
    "3. Build evaluation criteria table with hard constraints ranked first",
    "4. Define the state table format for tracking exploration",
    "5. Set branch count and max depth to prevent token explosion",
    "6. Inject all hard constraints and the loop objective into the prompt",
    "7. If Cross-Round Summary is present above, incorporate its recurring issues and key lessons",
    "8. Output only the generated prompt — no preamble, no meta-commentary",
  ];
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Self-Evaluation block (v1.1 — autonomous loop feedback)
// ═══════════════════════════════════════════════════════════════════════════

/** Build the standardized self-evaluation block appended to every compiled prompt.
 *  The agent MUST output a JSON self-evaluation between the delimiters.
 *  4 required fields + 3 optional evolution fields (P0–P2) —
 *  each consumed by at least one downstream function. */
export function buildSelfEvalBlock(round: number): string {
  return [
    "",
    "### LoopForge Self-Evaluation (REQUIRED)",
    "",
    `You are completing Round ${round}. After finishing the task above, ` +
      "you MUST output a self-evaluation in this exact format:",
    "",
    "```",
    "---loopforge-eval",
    "{",
    '  "success": true,',
    `  "output_summary": "<one paragraph — what was DONE in round ${round}, be specific>",`,
    '  "constraint_violations": [],',
    '  "should_continue": true,',
    '  "discovered_constraints": [],',
    '  "objective_refinement": "",',
    '  "emerged_subtasks": [],',
    '  "execution_evidence": {',
    '    "files_changed": [],',
    '    "test_results": {"passed": 0, "failed": 0, "skipped": 0},',
    '    "success_criteria_met": [],',
    '    "success_criteria_remaining": [],',
    '    "progress_estimate": 0.0',
    '  },',
    '  "retracted_constraints": [],',
    '  "revised_success_criteria": [],',
    '  "wrong_assumptions": []',
    "}",
    "---end-loopforge-eval",
    "```",
    "",
    "Field rules:",
    `- success: true ONLY if all hard constraints were met and the task goal was achieved`,
    `- output_summary: Be specific about what was PRODUCED, not what you "tried". ` +
      `Bad: "worked on audit". Good: "Found 3 vulns: reentrancy in withdraw(), ` +
      `integer overflow in transfer(), missing access control in mint()". ` +
      `This feeds cross-round knowledge distillation.`,
    `- constraint_violations: List ONLY constraints you actually broke. Empty array [] if none. ` +
      `This directly affects constraint-integrity scoring and retirement decisions.`,
    `- should_continue: false ONLY when the ENTIRE task is complete. ` +
      `If there is more to audit/implement/test, say true. ` +
      `This tells the autonomous runner when to stop.`,
    `- discovered_constraints (P0 — optional): New constraints you discovered this round. ` +
      `Omit or [] if none.`,
    `- objective_refinement (P1 — optional): Deepened understanding of the task goal. ` +
      `APPENDED to the original objective. Omit or "" if unchanged.`,
    `- emerged_subtasks (P2 — optional): Sub-problems that surfaced during execution. ` +
      `Omit or [] if none.`,
    `- execution_evidence (P4 — recommended): Structured record of what you actually did. ` +
      `files_changed: paths relative to project root. test_results: null if no tests run. ` +
      `success_criteria_met/remaining: track against the Loop Objective. ` +
      `progress_estimate: your honest estimate of overall completion (0.0 to 1.0). ` +
      `This enables real progress tracking and early stall detection.`,
    `- retracted_constraints (P5 — optional): Constraints you now believe are WRONG. ` +
      `Removed from active guardrails. Only retract if you have evidence. Omit or [] if none.`,
    `- revised_success_criteria (P5 — optional): Success criteria that need reformulation. ` +
      `Array of {old, new} objects. Applied to the Loop Objective. Omit or [] if none.`,
    `- wrong_assumptions (P5 — optional): Assumptions from earlier rounds that turned ` +
      `out to be incorrect. Recorded as key lessons. Omit or [] if none.`,
    `- The JSON MUST appear between the ---loopforge-eval and ---end-loopforge-eval markers`,
    `- Do NOT wrap the markers in code fences — output them as raw text`,
    "",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Top-level compile — ties layers together
// ═══════════════════════════════════════════════════════════════════════════

export function compileLoop(
  request: LoopCompileRequest,
  vaultContext: Record<string, unknown> | null = null,
): LoopCompileResponse {
  // Layer 1: Decide compile level
  const level = decideLevel(request, vaultContext);

  // Compile at the decided level
  let response: LoopCompileResponse;
  if (level === "l0") {
    response = compileL0(request, vaultContext);
  } else if (level === "l1") {
    response = compileL1(request, vaultContext);
  } else {
    response = compileL2(request, vaultContext);
  }

  // Layer 2: Compute advisories
  const { warnings, suggestedNextTask, alignment, health } =
    computeAdvisories(request, vaultContext);

  // Merge advisories into response (preserve P4 consistency warnings from L2)
  response.warnings = [...(response.warnings || []), ...warnings];
  // Only overwrite suggested_next_task from advisories if the compile function
  // didn't already set one (e.g. L2 sets it from emerged_subtasks)
  if (!response.suggested_next_task) {
    response.suggested_next_task = suggestedNextTask;
  }
  response.task_alignment = alignment;
  response.loop_health = health;
  response.recompile_level = level;

  // v1.1: Append self-evaluation block for autonomous loop feedback
  response.prompt += buildSelfEvalBlock(request.round);

  // Multi-agent: Inject delegation history if available
  if (vaultContext) {
    const delegationText = buildDelegationSummary(vaultContext);
    if (delegationText) {
      response.prompt += delegationText;
    }
  }

  return response;
}
