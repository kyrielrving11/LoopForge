/** Externalized LoopForge runtime policy. */

import { randomUUID } from "node:crypto";
import { isApprovalPolicy } from "./protocol.js";
import type { WorkflowState } from "./protocol.js";
import { computeWorkflowProgress } from "./plan.js";
import type { GovernanceGraphSummary } from "./governance-graph.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function replaceFileWithRetry(temporary: string, target: string): void {
  const retryable = new Set(["EPERM", "EACCES", "EBUSY"]);
  const attempts = process.platform === "win32" ? 8 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(temporary, target);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (!retryable.has(code) || attempt === attempts - 1) throw error;
      // Windows scanners and readers can briefly retain the previous
      // projection while the next round is being prepared. A bounded
      // synchronous wait keeps the projection atomic without an unbounded
      // retry loop or a runtime dependency.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}

export interface SummaryPolicy {
  window: number;
  max_milestones: number;
}

export interface EnginePolicy {
  max_rounds: number;
  backtrack_enabled: boolean;
  backtrack_max_depth: number;
  backtrack_preserve_discoveries: boolean;
}

/** Levels control state density only; reasoning strategy belongs to the Agent. */
export interface PromptPolicy {
  injection_mode: "adaptive" | "full" | "pointer";
  full_refresh_interval: number;
  l0_max_chars: number;
  l1_max_chars: number;
  l2_max_chars: number;
  l2_adaptive_enabled: boolean;
  l2_adaptive_round_factor: number;
  l2_adaptive_milestone_factor: number;
  l2_adaptive_max_chars: number;
  l2_pointer_enabled: boolean;
  graph_slice_enabled: boolean;
  graph_slice_max_chars: number;
  base_prompt_version: string;
}

export interface BackendPolicy {
  /** Root for typed per-loop documents. */
  root_dir: string;
}

export interface EvolutionPolicy {
  max_active_constraints: number;
  progress_stall_rounds: number;
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

export interface WorkflowPolicy {
  executable_horizon: number;
  max_plan_steps: number;
  /** risk_only is the safe default; every_revision adds human review for all plan versions. */
  approval_policy: "risk_only" | "every_revision";
}

export interface LoopPolicy {
  version: string;
  summary: SummaryPolicy;
  engine: EnginePolicy;
  prompt: PromptPolicy;
  backend: BackendPolicy;
  evolution: EvolutionPolicy;
  state_file: StateFilePolicy;
  evidence: EvidencePolicy;
  mcp: McpPolicy;
  workflow: WorkflowPolicy;
}

export const DEFAULT_POLICY: LoopPolicy = {
  version: "3",
  summary: { window: 5, max_milestones: 10 },
  engine: { max_rounds: 20, backtrack_enabled: true, backtrack_max_depth: 3, backtrack_preserve_discoveries: true },
  prompt: {
    injection_mode: "adaptive",
    full_refresh_interval: 0,
    l0_max_chars: 3000,
    l1_max_chars: 7000,
    l2_max_chars: 18000,
    l2_adaptive_enabled: true,
    l2_adaptive_round_factor: 200,
    l2_adaptive_milestone_factor: 1000,
    l2_adaptive_max_chars: 40000,
    l2_pointer_enabled: true,
    graph_slice_enabled: true,
    graph_slice_max_chars: 3000,
    base_prompt_version: "3.0.0",
  },
  backend: { root_dir: ".loopforge" },
  evolution: {
    max_active_constraints: 15,
    progress_stall_rounds: 3,
  },
  state_file: {
    enabled: true,
    directory: ".loopforge/state",
  },
  evidence: { providers: ["git"], timeout_ms: 120_000, commands: [] },
  mcp: {
    session_lease_ms: 30_000,
    session_lease_renew_interval_ms: 10_000,
  },
  workflow: {
    executable_horizon: 3,
    max_plan_steps: 50,
    approval_policy: "risk_only",
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
  const candidates = path ? [path] : ["loop_policy.json"];
  for (const candidate of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(candidate), "utf8"));
    } catch {
      // Try the next candidate.
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const merged = deepMerge(DEFAULT_POLICY, raw as Record<string, unknown>);
      if (!isApprovalPolicy(merged.workflow.approval_policy)) {
        throw new Error(
          `Invalid workflow.approval_policy: expected "risk_only" or "every_revision"`,
        );
      }
      return merged;
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

/** Bind the process policy lookup to a workspace after workspace validation. */
export function bindPolicyWorkspace(workspaceRoot: string): LoopPolicy {
  policy = loadPolicy(resolve(workspaceRoot, "loop_policy.json"));
  return policy;
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
  const lexicalRoot = resolve(workspaceRoot);
  const lexicalTarget = resolve(lexicalRoot, configuredDirectory);
  const lexicalRelative = relative(lexicalRoot, lexicalTarget);
  if (
    lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRelative)
  ) {
    throw new Error("State file directory must stay within the workspace");
  }

  const realRoot = realpathSync(lexicalRoot);
  let ancestor = lexicalTarget;
  while (!existsSync(ancestor)) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const projected = resolve(realpathSync(ancestor), relative(ancestor, lexicalTarget));
  const realRelative = relative(realRoot, projected);
  if (
    realRelative === ".." || realRelative.startsWith(`..${sep}`) ||
    isAbsolute(realRelative)
  ) {
    throw new Error("State file directory resolves outside the workspace");
  }
  return lexicalTarget;
}

export function writeStateFile(loopId: string, content: string | undefined, workspaceRoot = process.cwd()): void {
  if (!content) return;
  validateLoopId(loopId);
  const config = getPolicy().state_file;
  if (!config.enabled) return;
  const directory = resolveStateDirectory(workspaceRoot, config.directory);
  mkdirSync(directory, { recursive: true });
  const verifiedDirectory = resolveStateDirectory(workspaceRoot, config.directory);
  const target = resolve(verifiedDirectory, `${loopId}-state.md`);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error("State file target must not be a symbolic link");
  }
  const temporary = resolve(
    verifiedDirectory,
    `.${loopId}-state.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, content, "utf8");
    replaceFileWithRetry(temporary, target);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

/** Update the optional Markdown projection with v3 workflow state. The typed
 * session/round JSON remains the durable truth. */
export function writeWorkflowStateFile(
  loopId: string,
  workflow: WorkflowState,
  workspaceRoot = process.cwd(),
  graphSummary?: GovernanceGraphSummary,
  regressionSummary?: { total: number; verified: number; gaps: number },
): void {
  validateLoopId(loopId);
  const config = getPolicy().state_file;
  if (!config.enabled) return;
  const directory = resolveStateDirectory(workspaceRoot, config.directory);
  const target = resolve(directory, `${loopId}-state.md`);
  if (!existsSync(target)) return;
  const current = readFileSync(target, "utf8");
  const marker = "<!-- loopforge-workflow-v3 -->";
  const base = current.includes(marker) ? current.slice(0, current.indexOf(marker)).trimEnd() : current.trimEnd();
  const plan = workflow.plan;
  const progress = computeWorkflowProgress(workflow);
  const counts = plan ? {
    ready: plan.steps.filter((step) => step.status === "ready" || step.status === "active").length,
    blocked: plan.steps.filter((step) => step.status === "blocked").length,
    done: plan.steps.filter((step) => step.status === "done" || step.status === "canceled").length,
  } : { ready: 0, blocked: 0, done: 0 };
  const approvalRows = workflow.approvalHistory.length
    ? workflow.approvalHistory.map((item) => `- v${item.planVersion} ${item.decision} (${item.approvalId}): ${item.reason}`).join("\n")
    : "- None";
  const section = [
    marker,
    "## Workflow",
    "",
    `- Phase: ${workflow.phase}`,
    `- Plan version: ${workflow.planVersion ?? "none"}`,
    `- Active step: ${workflow.activeStepId ?? "none"}`,
    `- Steps: ${counts.ready} ready / ${counts.blocked} blocked / ${counts.done} done`,
    `- Readiness: ${progress.readiness}`,
    `- Executable steps: ${progress.planSteps.done}/${progress.planSteps.total} done, ${progress.planSteps.blocked} blocked, ${progress.planSteps.canceled} canceled`,
    `- Success criteria: ${progress.successCriteria.provisionallyMet}/${progress.successCriteria.total} provisional, ${progress.successCriteria.auditVerified} audit verified`,
    `- External gates: ${progress.externalGates.satisfied}/${progress.externalGates.total} satisfied, ${progress.externalGates.blocked} blocked`,
    `- Session hard constraints: ${workflow.baselineConstraints.length}`,
    ...workflow.baselineConstraints.map((constraint) => `  - ${constraint}`),
    ...(graphSummary ? [
      `- Governance graph: ${graphSummary.nodeCount} nodes / ${graphSummary.edgeCount} edges`,
      `- Graph diagnostics: ${graphSummary.errorCount} errors / ${graphSummary.warningCount} warnings`,
      `- Blocked descendants: ${graphSummary.blockedDescendants}`,
    ] : []),
    ...(regressionSummary ? [`- Regression obligations: ${regressionSummary.verified}/${regressionSummary.total} verified, ${regressionSummary.gaps} gaps`] : []),
    "",
    "### Approval History",
    "",
    approvalRows,
    "",
  ].join("\n");
  writeStateFile(loopId, `${base}\n\n${section}`, workspaceRoot);
}
