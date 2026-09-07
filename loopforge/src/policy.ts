/** Externalized LoopForge runtime policy. */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { containInWorkspace } from "./workspace.js";

export interface ConstraintsPolicy {
  retire_window: number;
}

export interface SummaryPolicy {
  window: number;
  health_check_interval: number;
  /** v2.1: Rounds between automatic safety-net milestones.
   *  Default 20. Only fires when no agent_declared or criteria_milestone
   *  has been created for this many rounds. */
  milestone_interval: number;
  /** v2.1: Maximum number of milestone summaries to accumulate.
   *  Oldest milestones are evicted when the cap is exceeded. */
  max_milestones: number;
  /** v3.0.1: L1 milestone sampling — when milestones exceed max_milestones,
   *  keep this many of the OLDEST milestones as history anchors. The same
   *  count of the NEWEST is always kept; the middle is sampled evenly. */
  milestone_head_count: number;
  /** v3.0.1: L1 milestone sampling — this many of the NEWEST milestones are
   *  always kept when the cap is exceeded. */
  milestone_tail_count: number;
}

export interface EnginePolicy {
  /** Number of committed rounds inspected for progress stalls. */
  stall_lookback_rounds: number;
  max_rounds: number;
  /** v2.7: When true, enforcement rules that would terminate (R4 2nd strike,
   *  R5 flatline, R6 max rejections) instead issue one final escalated
   *  rejection with a "Seek Human Guidance" notice before terminating.
   *  This gives the agent one extra chance to course-correct with human
   *  input rather than being terminated immediately. Default: true. */
  enforcement_escalation_enabled: boolean;
  /** v2.10: When true, R4 (progress stall) and R5 (flat terminal) escalate
   *  to backtrack instead of reject. The agent is rolled back to the last
   *  clean round with lessons injected. Set to false to restore pre-v2.10
   *  behavior (escalated reject without backtrack). Default: true. */
  backtrack_enabled: boolean;
  /** v2.10: Max rounds to search backwards for a safe restore point.
   *  If no clean round is found within this depth, backtrack falls through
   *  to terminate. Default: 3. */
  backtrack_max_depth: number;
  /** v2.10: When true, discovered_constraints from skipped rounds are
   *  preserved and merged into the restored state's active constraints.
   *  Default: true. */
  backtrack_preserve_discoveries: boolean;
  /** v2.12: Max consecutive rounds where drift_clarification waives R7
   *  before the loop is terminated. When the agent submits weak clarifications
   *  (≥ 20 chars but no semantic anchors like constraint IDs or file paths)
   *  for this many consecutive rounds, the loop terminates. Set to 0 to
   *  disable the streak limit (pre-v2.12 behavior — any ≥ 20 char
   *  clarification always waives). Default: 3. */
  drift_clarification_max_streak: number;
  /** v2.13: When true, LoopForge automatically executes git stash + reset
   *  on backtrack to restore the workspace to the clean round's commit.
   *  DANGEROUS: mutates the working tree directly. Default: false.
   *  When false (default), the backtrack prompt instructs the agent to
   *  restore manually, and the verification gate enforces the check. */
  backtrack_auto_restore: boolean;
}

/** Levels control state density only; reasoning strategy belongs to the Agent. */
export interface PromptPolicy {
  full_refresh_interval: number;
  l0_max_chars: number;
  l1_max_chars: number;
  l2_max_chars: number;
  /** v2.4: Enable adaptive L2 budget scaling with loop complexity.
   *  Grows with round count + milestone count up to l2_adaptive_max_chars. */
  l2_adaptive_enabled: boolean;
  /** v2.4: Additional L2 chars per completed round. Default: 200. */
  l2_adaptive_round_factor: number;
  /** v2.4: Additional L2 chars per milestone. Default: 1000. */
  l2_adaptive_milestone_factor: number;
  /** v2.4: Absolute ceiling for adaptive L2 budget. Default: 40000. */
  l2_adaptive_max_chars: number;
  /** v2.5: Additional L2 chars per tracked sub-goal. Default: 100. */
  l2_adaptive_subgoal_factor: number;
  /** v2.8: When true, L2 prompts skip inline fullStateMarkdown and
   *  instruct the agent to read the state file instead. Structured
   *  sections (milestones, sub-goals, trust, progress) are still
   *  rendered. Default: true. Set to false to restore pre-v2.8 L2
   *  behavior. */
  l2_pointer_enabled: boolean;
  /** v3.2: Collapse unchanged L1 content (vs the previous round's persisted
   *  presentation) into one-line state-file pointers. Default: true.
   *  Set to false to restore pre-v3.2 full L1 rendering. */
  l1_collapse_enabled: boolean;
  /** v3.5: When true, L2 prompts whose Current Task is NOT a Round Contract
   *  append a short suggestion to declare one when the remaining work spans
   *  several rounds. L2-only prose in the eval template tail — never the
   *  JSON key name; L0/L1 prompts are unaffected (byte-identical to v3.4).
   *  Default: true. Set to false to restore pre-v3.5 L2 rendering. */
  contract_nudge_on_l2: boolean;
  /** v2.9: Max emphasize items when level is L2. Default: 5. */
  max_emphasize_l2: number;
  /** v2.9: Max emphasize items when level is L1. Default: 3. */
  max_emphasize_l1: number;
  /** v2.9: Max confusion points rendered. Default: 3. */
  max_confusion_points: number;
  /** v2.14: Jaccard threshold for pointing a confusion point at its
   *  best-matching state section. Default: 0.15 (15%). */
  confusion_section_threshold: number;
}

export interface BackendPolicy {
  /** Root for typed per-loop documents. */
  root_dir: string;
}

export interface EvolutionPolicy {
  max_discovered_constraints_per_round: number;
  max_active_constraints: number;
  max_objective_versions: number;
  progress_stall_threshold: number;
  progress_mismatch_threshold: number;
  /** v2.14: Jaccard threshold for task continuity in checkLoopHealth —
   *  below this, the loop is considered drifting. Default: 0.2. */
  task_continuity_threshold: number;
  /** v2.1: Jaccard token similarity threshold for intent-action drift
   *  detection. When the previous round's next_action and the current
   *  round's output_summary have similarity below this threshold, a
   *  verification flag is raised. Default: 0.15 (15%). */
  intent_drift_threshold: number;
  /** v2.5: Jaccard threshold for detecting genuinely new success criteria
   *  between rounds. Used by detectNewCriteria(). Default: 0.45. */
  criteria_dedup_threshold: number;
  /** v2.5: Jaccard threshold for deduplicating new sub-goals against
   *  existing ones. Used when accumulating emerged_subtasks. Default: 0.6. */
  subgoal_dedup_threshold: number;
  /** v2.5: Jaccard threshold for matching agent-declared status changes
   *  (completed/blocked/canceled) to existing sub-goals. Default: 0.5. */
  subgoal_match_threshold: number;
  /** v3.7.1: Max ACTIVE sub-goals (pending/in_progress/blocked) shown in
   *  prompts and the state file. done/canceled never render as items —
   *  they survive in the vault, replay, and counts. */
  max_active_subgoals: number;
  /** v2.5: Jaccard threshold for matching constraints during discovery
   *  and violation tracking. Default: 0.5. */
  constraint_match_threshold: number;
  /** v2.5: Jaccard threshold for checkSubGoalDrift — next_action must
   *  exceed this to be considered "aligned" with a pending sub-goal.
   *  Default: 0.3. */
  subgoal_drift_alignment_threshold: number;
  /** v2.11: When true, constraints and criteria are assigned stable IDs
   *  (c-XXXXXXXX, cr-XXXXXXXX) rendered in prompts. The agent is encouraged
   *  to reference IDs for exact matching; natural-language references use
   *  Jaccard similarity. Default: true. */
  constraint_id_enabled: boolean;
}

export interface CheckpointPolicy {
  outcome_max_chars: number;
}

/** Human-readable derived state view. JSON LoopStore documents remain truth. */
export interface StateFilePolicy {
  enabled: boolean;
  directory: string;
}

export interface EvidencePolicy {
  providers: string[];
  timeout_ms: number;
  commands: CommandEvidencePolicy[];
  /** v3.3: How a success claim with zero machine-backed evidence is treated.
   *  "required" (default): the runtime rejects/terminates via R8 — a success
   *  claim must be backed by a passed after-phase command (or a declared
   *  no_change_reason). "warn": the flag downgrades to warn — the round
   *  commits, but its success never enters the trajectory and trust drops.
   *  The machine-evidence tightening itself is unconditional; this switch
   *  only controls the rejection/tolerance policy. */
  machine_backed_success: "required" | "warn";
}

export interface CommandEvidencePolicy {
  name: string;
  enabled: boolean;
  executable: string;
  args: string[];
  cwd?: string;
  phase: "after" | "both";
  required: boolean;
  timeout_ms: number;
  max_output_chars: number;
  success_exit_codes: number[];
}

export interface McpPolicy {
  session_lease_ms: number;
  session_lease_renew_interval_ms: number;
}

/** v2.12/v3.7.1: User/Agent gate governance. The gate is an OPT-IN
 *  blocking layer. When disabled (the default): the two gate tools are
 *  hidden from tools/list, direct calls return gate_disabled, and rounds
 *  citing gate_ids are not checked. When enabled: loopforge_gate_check is
 *  a structured preflight; high-risk actions persist a gate_opened record
 *  and a round that cites an unapproved gate is rejected. */
export interface GatePolicy {
  enabled: boolean;
}

export interface LoopPolicy {
  version: string;
  constraints: ConstraintsPolicy;
  summary: SummaryPolicy;
  engine: EnginePolicy;
  prompt: PromptPolicy;
  backend: BackendPolicy;
  evolution: EvolutionPolicy;
  checkpoint: CheckpointPolicy;
  state_file: StateFilePolicy;
  evidence: EvidencePolicy;
  mcp: McpPolicy;
  gate: GatePolicy;
}

export const DEFAULT_POLICY: LoopPolicy = {
  version: "2",
  constraints: { retire_window: 3 },
  summary: { window: 5, health_check_interval: 1, milestone_interval: 20, max_milestones: 10, milestone_head_count: 3, milestone_tail_count: 3 },
  engine: { stall_lookback_rounds: 3, max_rounds: 200, enforcement_escalation_enabled: true, backtrack_enabled: true, backtrack_max_depth: 3, backtrack_preserve_discoveries: true, drift_clarification_max_streak: 3, backtrack_auto_restore: false },
  prompt: {
    full_refresh_interval: 0,
    l0_max_chars: 3000,
    l1_max_chars: 7000,
    l2_max_chars: 18000,
    l2_adaptive_enabled: true,
    l2_adaptive_round_factor: 200,
    l2_adaptive_milestone_factor: 1000,
    l2_adaptive_max_chars: 40000,
    l2_adaptive_subgoal_factor: 100,
    l2_pointer_enabled: true,
    l1_collapse_enabled: true,
    contract_nudge_on_l2: true,
    max_emphasize_l2: 5,
    max_emphasize_l1: 3,
    max_confusion_points: 3,
    confusion_section_threshold: 0.15,
  },
  backend: { root_dir: ".loopforge" },
  evolution: {
    max_discovered_constraints_per_round: 5,
    max_active_constraints: 15,
    max_objective_versions: 10,
    progress_stall_threshold: 0.05,
    progress_mismatch_threshold: 0.3,
    task_continuity_threshold: 0.2,
    intent_drift_threshold: 0.15,
    criteria_dedup_threshold: 0.45,
    subgoal_dedup_threshold: 0.6,
    subgoal_match_threshold: 0.5,
    max_active_subgoals: 12,
    constraint_match_threshold: 0.5,
    subgoal_drift_alignment_threshold: 0.3,
    constraint_id_enabled: true,
  },
  checkpoint: { outcome_max_chars: 200 },
  state_file: {
    enabled: true,
    directory: ".loopforge/state",
  },
  evidence: { providers: ["git"], timeout_ms: 120_000, commands: [], machine_backed_success: "required" },
  mcp: {
    session_lease_ms: 30_000,
    session_lease_renew_interval_ms: 10_000,
  },
  gate: {
    enabled: false,
  },
};

/** Write a full default `loop_policy.json` to the target directory.
 *
 *  The written file contains every configurable key and its default value
 *  so users can discover and tune the system without reading source code.
 *  Skip creation when the file already exists unless `force` is true.
 *
 * @returns The resolved file path and whether it was freshly created.
 */
export function writeDefaultPolicy(
  targetDir: string,
  force = false,
): { path: string; created: boolean } {
  const target = resolve(targetDir, "loop_policy.json");
  if (existsSync(target) && !force) {
    return { path: target, created: false };
  }
  writeFileSync(target, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n", "utf8");
  return { path: target, created: true };
}

function deepMerge<T>(defaults: T, overrides: Record<string, unknown>): T {
  const result = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(overrides)) {
    const current = result[key];
    const incoming = overrides[key];
    if (
      key in result && current !== null && incoming !== null &&
      typeof current === "object" && !Array.isArray(current) &&
      typeof incoming === "object" && !Array.isArray(incoming)
    ) {
      result[key] = deepMerge(
        current as Record<string, unknown>,
        incoming as Record<string, unknown>,
      );
    } else if (key in result) {
      result[key] = incoming;
    } else {
      // Warn on unknown keys — a typo like "max_round" instead of
      // "max_rounds" would otherwise be silently ignored.
      console.warn(`loopforge: ignoring unknown policy key "${key}". Check loop_policy.json for typos.`);
    }
  }
  return result as T;
}

export function loadPolicy(path?: string): LoopPolicy {
  const candidates = [path, "loop_policy.json"].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(resolve(candidate), "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return deepMerge(DEFAULT_POLICY, raw as Record<string, unknown>);
      }
    } catch {
      // Try the next candidate.
    }
  }
  return structuredClone(DEFAULT_POLICY);
}

let policy: LoopPolicy | null = null;

export function getPolicy(path?: string): LoopPolicy {
  // Explicit path: always (re)load from that file.
  // No path: cache the default lookup so loadPolicy only runs once.
  if (path) return loadPolicy(path);
  policy ??= loadPolicy();
  return policy;
}

export function resetPolicy(): void {
  policy = null;
}

/** v3.2: Test-only injection — mirrors resetPolicy so tests can exercise a
 *  specific policy configuration (e.g. l1_collapse_enabled=false). */
export function setPolicyForTest(next: LoopPolicy): void {
  policy = next;
}

/** v3.3: Whether a command name is configured AND enabled in the current
 *  policy's evidence.commands. The machine-checkable predicate behind the
 *  round_contract verification_plan (round_unverifiable otherwise). */
export function isConfiguredCommand(name: string): boolean {
  const commands = getPolicy().evidence?.commands ?? [];
  return commands.some((c) => c.enabled && c.name === name);
}

const LOOP_ID_RE = /^[a-zA-Z0-9][-a-zA-Z0-9_:.]{0,127}$/;

export function validateLoopId(loopId: string): void {
  if (typeof loopId !== "string" || !loopId) {
    throw new Error("Invalid loopId: must be a non-empty string");
  }
  if (loopId.includes("..")) throw new Error('Invalid loopId: ".." is not allowed');
  if (loopId.includes("/") || loopId.includes("\\")) {
    throw new Error("Invalid loopId: path separators are not allowed");
  }
  if (!LOOP_ID_RE.test(loopId)) {
    throw new Error(
      "Invalid loopId: use at most 128 alphanumeric, hyphen, underscore, colon, or dot characters",
    );
  }
}

export function resolveStateDirectory(
  workspaceRoot: string,
  configuredDirectory: string,
): string {
  // v3.3.1: delegated to the single shared containment check (workspace.ts).
  // Behavior note: an EXISTING configured directory now resolves through
  // symlinks to its real location (the old implementation returned the
  // lexical path) — writes can never land behind the workspace's back via a
  // symlinked alias. Absent first-run directories keep the lexical path.
  return containInWorkspace(workspaceRoot, configuredDirectory);
}

export function writeStateFile(loopId: string, content: string | undefined): void {
  if (!content) return;
  validateLoopId(loopId);
  const config = getPolicy().state_file;
  if (!config.enabled) return;
  const directory = resolveStateDirectory(process.cwd(), config.directory);
  mkdirSync(directory, { recursive: true });
  // v3.3.1: the double resolveStateDirectory call was redundant — the
  // containment check is pure; one resolution serves mkdir, target, tmp.
  const target = resolve(directory, `${loopId}-state.md`);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error("State file target must not be a symbolic link");
  }
  const temporary = resolve(
    directory,
    `.${loopId}-state.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, target);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}
