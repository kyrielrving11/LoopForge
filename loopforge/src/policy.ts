/** Externalized LoopForge runtime policy. */

import { randomUUID } from "node:crypto";
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

export interface ConstraintsPolicy {
  retire_window: number;
}

export interface SummaryPolicy {
  window: number;
  health_check_interval: number;
}

export interface EnginePolicy {
  feedback_flush_interval: number;
  max_circuit_breaker: number;
}

export interface RuntimePolicy {
  max_rounds: number;
  round_timeout_ms: number;
  heartbeat_interval_ms: number;
  stall_grace_ms: number;
  max_consecutive_errors: number;
  pause_double_tap_ms: number;
}

/** Levels control state density only; reasoning strategy belongs to the Agent. */
export interface PromptPolicy {
  injection_mode: "adaptive" | "full" | "pointer";
  full_refresh_interval: number;
  l0_max_chars: number;
  l1_max_chars: number;
  l2_max_chars: number;
  base_prompt_version: string;
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
  progress_stall_rounds: number;
  progress_mismatch_threshold: number;
}

export interface CheckpointPolicy {
  max_carried_constraints: number;
  outcome_max_chars: number;
}

/** Human-readable derived state view. JSON LoopStore documents remain truth. */
export interface StateFilePolicy {
  enabled: boolean;
  directory: string;
  max_checkpoints: number;
  max_summary_rounds: number;
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

export interface LoopPolicy {
  version: string;
  constraints: ConstraintsPolicy;
  summary: SummaryPolicy;
  engine: EnginePolicy;
  runtime: RuntimePolicy;
  prompt: PromptPolicy;
  backend: BackendPolicy;
  evolution: EvolutionPolicy;
  checkpoint: CheckpointPolicy;
  state_file: StateFilePolicy;
  evidence: EvidencePolicy;
  mcp: McpPolicy;
}

export const DEFAULT_POLICY: LoopPolicy = {
  version: "2",
  constraints: { retire_window: 3 },
  summary: { window: 5, health_check_interval: 1 },
  engine: { feedback_flush_interval: 5, max_circuit_breaker: 3 },
  runtime: {
    max_rounds: 20,
    round_timeout_ms: 600_000,
    heartbeat_interval_ms: 30_000,
    stall_grace_ms: 300_000,
    max_consecutive_errors: 3,
    pause_double_tap_ms: 3000,
  },
  prompt: {
    injection_mode: "adaptive",
    full_refresh_interval: 5,
    l0_max_chars: 3000,
    l1_max_chars: 7000,
    l2_max_chars: 18000,
    base_prompt_version: "2.0.0",
  },
  backend: { root_dir: ".loopforge" },
  evolution: {
    max_discovered_constraints_per_round: 5,
    max_active_constraints: 15,
    max_objective_versions: 10,
    progress_stall_threshold: 0.05,
    progress_stall_rounds: 2,
    progress_mismatch_threshold: 0.3,
  },
  checkpoint: { max_carried_constraints: 10, outcome_max_chars: 200 },
  state_file: {
    enabled: true,
    directory: ".loopforge/state",
    max_checkpoints: 5,
    max_summary_rounds: 5,
  },
  evidence: { providers: ["git"], timeout_ms: 120_000, commands: [] },
  mcp: {
    session_lease_ms: 30_000,
    session_lease_renew_interval_ms: 10_000,
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
      // Unknown legacy keys are deliberately ignored at the 2.0 boundary.
      result[key] = incoming;
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
  policy ??= loadPolicy(path);
  return policy;
}

export function resetPolicy(): void {
  policy = null;
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

export function writeStateFile(loopId: string, content: string | undefined): void {
  if (!content) return;
  validateLoopId(loopId);
  const config = getPolicy().state_file;
  if (!config.enabled) return;
  const directory = resolveStateDirectory(process.cwd(), config.directory);
  mkdirSync(directory, { recursive: true });
  const verifiedDirectory = resolveStateDirectory(process.cwd(), config.directory);
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
    renameSync(temporary, target);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}
