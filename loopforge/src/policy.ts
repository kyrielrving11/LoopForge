/** Policy — externalised loop behaviour configuration.
 *
 * All tunable parameters live here instead of as module-level constants.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ═══════════════════════════════════════════════════════════════════════════
// Policy types
// ═══════════════════════════════════════════════════════════════════════════

export interface ConstraintsPolicy {
  retire_window: number;
  max_active: number;
}

export interface SummaryPolicy {
  window: number;
  health_check_interval: number;
}

export interface RecompileTriggersPolicy {
  l1: string[];
  l2: string[];
}

export interface TechniquePolicy {
  fallback_chain: Record<string, string>;
  adaptive_quality_threshold: number;
  adaptive_consecutive_rounds: number;
  routing_table: Record<string, string>;
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
}

export interface BackendPolicy {
  vault_path: string;
  global_vault_path: string;
}

export interface LoopPolicy {
  version: string;
  constraints: ConstraintsPolicy;
  summary: SummaryPolicy;
  recompile_triggers: RecompileTriggersPolicy;
  technique: TechniquePolicy;
  engine: EnginePolicy;
  runtime: RuntimePolicy;
  backend: BackendPolicy;
}

// ═══════════════════════════════════════════════════════════════════════════
// Default policy
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_POLICY: LoopPolicy = {
  version: "1",
  constraints: {
    retire_window: 3,
    max_active: 12,
  },
  summary: {
    window: 5,
    health_check_interval: 1,
  },
  recompile_triggers: {
    l1: ["new_constraints", "repeated_failure", "repair_signal"],
    l2: [
      "goal_id_changed",
      "plan_source_provided",
      "strategy_collapse",
      "severe_alignment_drop",
    ],
  },
  technique: {
    fallback_chain: {
      "zero-shot": "few-shot",
      "few-shot": "zero-shot-cot",
      "zero-shot-cot": "few-shot-cot",
      "few-shot-cot": "tree-of-thought",
      "step-back": "least-to-most",
      "least-to-most": "tree-of-thought",
      "tree-of-thought": "tree-of-thought",
    },
    adaptive_quality_threshold: 3,
    adaptive_consecutive_rounds: 2,
    routing_table: {
      continuous_low: "zero-shot",
      independent_low: "zero-shot",
      continuous_medium: "few-shot",
      independent_medium: "zero-shot-cot",
      continuous_high: "few-shot-cot",
      independent_high: "tree-of-thought",
    },
  },
  engine: {
    feedback_flush_interval: 5,
    max_circuit_breaker: 3,
  },
  runtime: {
    max_rounds: 20,
    round_timeout_ms: 600_000,
    heartbeat_interval_ms: 30_000,
    stall_grace_ms: 300_000,
    max_consecutive_errors: 3,
  },
  backend: {
    vault_path: ".promptcraft/prompt_vault.json",
    global_vault_path: "~/.promptcraft/global_vault.json",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Deep merge — custom values override defaults, unset fields retain defaults
// ═══════════════════════════════════════════════════════════════════════════

function deepMerge<T>(
  defaults: T,
  overrides: Record<string, unknown>,
): T {
  const result = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(overrides)) {
    if (
      key in result &&
      typeof (result as Record<string, unknown>)[key] === "object" &&
      !Array.isArray((result as Record<string, unknown>)[key]) &&
      typeof overrides[key] === "object" &&
      !Array.isArray(overrides[key]) &&
      overrides[key] !== null
    ) {
      result[key] = deepMerge(
        (result as Record<string, unknown>)[key] as Record<string, unknown>,
        overrides[key] as Record<string, unknown>,
      );
    } else {
      result[key] = overrides[key];
    }
  }
  return result as unknown as T;
}

// ═══════════════════════════════════════════════════════════════════════════
// Loader
// ═══════════════════════════════════════════════════════════════════════════

export function loadPolicy(path?: string): LoopPolicy {
  const candidates = [path, "loop_policy.json"].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const resolved = resolve(candidate);
      const raw = JSON.parse(readFileSync(resolved, "utf-8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return deepMerge(
          DEFAULT_POLICY as unknown as Record<string, unknown>,
          raw as Record<string, unknown>,
        ) as unknown as LoopPolicy;
      }
    } catch {
      // File not found or invalid — try next candidate
    }
  }

  return { ...DEFAULT_POLICY };
}

// ═══════════════════════════════════════════════════════════════════════════
// Module-level singleton — loaded once per session
// ═══════════════════════════════════════════════════════════════════════════

let _policy: LoopPolicy | null = null;

export function getPolicy(path?: string): LoopPolicy {
  if (_policy === null) {
    _policy = loadPolicy(path);
  }
  return _policy;
}

export function resetPolicy(): void {
  _policy = null;
}
