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
}

export interface SummaryPolicy {
  window: number;
  health_check_interval: number;
}

export interface TechniquePolicy {
  /** @deprecated v1.15 — Escalation (N failures → Tier 2) removed.
   *  The Agent freely chooses techniques at L2; keyword routing stays
   *  in Tier 1 at L1. This field is retained for config compatibility
   *  but no longer consumed by the routing logic. */
  tier2_escalation_failures: number;
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
  // v2: federation — global vault for cross-project constraints (not yet implemented)
  global_vault_path: string;
}

export interface EvolutionPolicy {
  /** P0: Max new constraints the agent can discover per round. */
  max_discovered_constraints_per_round: number;
  /** P0: Hard upper bound on total active constraints. */
  max_active_constraints: number;
  /** P1: Max versions of the loop objective to retain in history. */
  max_objective_versions: number;
  /** P4: Minimum progress delta to not be considered stalled. */
  progress_stall_threshold: number;
  /** P4: Consecutive rounds below stall threshold before warning. */
  progress_stall_rounds: number;
  /** P4: Max allowed difference between objective and subjective progress. */
  progress_mismatch_threshold: number;
}

/** A tier in the round-based injection strategy.
 *  Each tier defines how many and which injection phases are allowed
 *  based on the loop's maxRounds. */
export interface MemoryInjectionTier {
  /** Upper bound of maxRounds for this tier (inclusive). */
  max_rounds: number;
  /** Which phases are allowed in this tier: [1], [1,3], or [1,2,3]. */
  allowed_phases: number[];
}

export interface MemoryInjectionPolicy {
  /** Master toggle for memory injection. */
  enabled: boolean;
  /** Minimum rounds between two consecutive injections. */
  min_rounds_between_injections: number;
  /** Phase trigger configuration. */
  phase_thresholds: {
    phase1: { trigger: "round_1" };
    phase2: { trigger: "progress"; threshold: number };
    phase3: { trigger: "progress"; threshold: number };
  };
  /** Round-based tiered injection strategy. Each tier defines which phases
   *  are allowed based on maxRounds. The first matching tier wins.
   *  Tiers should be ordered by max_rounds ascending. */
  round_tiers: MemoryInjectionTier[];
  /** Jaccard similarity threshold above which a new context is considered
   *  duplicate and skipped. */
  dedup_threshold: number;
  /** Maximum characters of memory context to inject (truncated if longer). */
  max_context_length: number;
  /** Section header for the injected context block in the L2 prompt. */
  section_title: string;
}

/** Resolve which injection phases are allowed for a given maxRounds.
 *  Uses the tiered strategy: finds the first tier where maxRounds ≤ tier.max_rounds,
 *  and returns its allowed_phases. If maxRounds exceeds all tiers, returns the
 *  last tier's phases. */
export function resolveAllowedPhases(
  maxRounds: number,
  tiers: MemoryInjectionTier[],
): number[] {
  if (tiers.length === 0) return [1]; // safety fallback
  for (const tier of tiers) {
    if (maxRounds <= tier.max_rounds) return tier.allowed_phases;
  }
  return tiers[tiers.length - 1].allowed_phases;
}

/** Resolve which memory injection phase (1/2/3) should fire this round.
 *  Shared between LoopRuntime (runtime.ts) and SessionManager (mcp/session.ts).
 *  Returns the phase number, or 0 if no injection should occur this round.
 *
 *  @param currentRound       Current round number (1-based).
 *  @param injectionCount     How many injections have already occurred.
 *  @param allowedPhases      Phases allowed by the round-tier policy.
 *  @param progress           Current progress estimate (-1 if unavailable).
 *  @param phase2Triggered    Whether phase 2 has already fired in this loop.
 *  @param phase3Triggered    Whether phase 3 has already fired in this loop.
 *  @param thresholds         Policy threshold config for phase2/phase3. */
export function resolveInjectionPhase(
  currentRound: number,
  injectionCount: number,
  allowedPhases: Set<number>,
  progress: number,
  phase2Triggered: boolean,
  phase3Triggered: boolean,
  thresholds: { phase2: number; phase3: number },
): 0 | 1 | 2 | 3 {
  const maxInjections = allowedPhases.size;
  if (injectionCount >= maxInjections) return 0;

  // Phase 1: round 1 only
  if (currentRound === 1 && injectionCount === 0 && allowedPhases.has(1)) {
    return 1;
  }

  const hasProgress = progress >= 0;

  // Phase 2: progress threshold (only if allowed by tier and not yet triggered)
  if (
    allowedPhases.has(2) &&
    !phase2Triggered &&
    hasProgress &&
    progress >= thresholds.phase2
  ) {
    return 2;
  }

  // Phase 3: progress threshold (only if allowed by tier and not yet triggered)
  if (
    allowedPhases.has(3) &&
    !phase3Triggered &&
    hasProgress &&
    progress >= thresholds.phase3
  ) {
    return 3;
  }

  return 0;
}

/** Build accumulated context for a targeted memory query from a SelfEvaluation.
 *  Extracts recurring issues, key lessons, and remaining criteria.
 *  Shared between LoopRuntime (runtime.ts) and SessionManager (mcp/session.ts). */
export function buildAccumulatedMemoryContext(
  selfEval: { constraint_violations: string[]; execution_evidence?: { success_criteria_remaining?: string[] } | null; emerged_subtasks?: string[]; wrong_assumptions?: string[] },
): { recurringIssues: string[]; failedPatterns: string[]; keyLessons: string[]; remainingCriteria: string[] } {
  const recurringIssues: string[] = [];
  const failedPatterns: string[] = [];
  const keyLessons: string[] = [];
  const remainingCriteria: string[] = [];

  if (selfEval.constraint_violations.length) {
    recurringIssues.push(...selfEval.constraint_violations);
  }
  if (selfEval.execution_evidence?.success_criteria_remaining?.length) {
    remainingCriteria.push(...selfEval.execution_evidence.success_criteria_remaining);
  }
  if (selfEval.emerged_subtasks?.length) {
    keyLessons.push(...selfEval.emerged_subtasks);
  }
  if (selfEval.wrong_assumptions?.length) {
    keyLessons.push(...selfEval.wrong_assumptions.map((a) => `Wrong: ${a}`));
  }

  return { recurringIssues, failedPatterns, keyLessons, remainingCriteria };
}

/** Build a base LoopMemoryWriteback payload from loop terminal state.
 *  Shared between LoopRuntime (runtime.ts) and SessionManager (mcp/session.ts).
 *  Callers may layer additional feedback entries on top of the returned payload. */
export function buildBaseMemoryWriteback(params: {
  loopId: string;
  task: string;
  stopReason: string;
  roundsCompleted: number;
  discoveries: string[];
}): {
  loopId: string;
  task: string;
  outcome: "completed" | "circuit_breaker" | "stalled" | "max_rounds" | "stopped";
  roundsCompleted: number;
  projectEntry: {
    title: string;
    objective: string;
    keyOutcome: string;
    keyDiscoveries: string[];
    date: string;
  };
  referenceEntry: {
    description: string;
    vaultLocation: string;
  };
} {
  const wp = getPolicy().memory_writeback;
  const outcome = (params.stopReason === "task_complete" ? "completed" :
    params.stopReason === "circuit_breaker" ? "circuit_breaker" :
    params.stopReason === "stalled" ? "stalled" :
    params.stopReason === "max_rounds" ? "max_rounds" :
    "stopped") as "completed" | "circuit_breaker" | "stalled" | "max_rounds" | "stopped";

  return {
    loopId: params.loopId,
    task: params.task,
    outcome,
    roundsCompleted: params.roundsCompleted,
    projectEntry: {
      title: `${params.task.slice(0, 80)} — ${outcome}`,
      objective: params.task.slice(0, 200),
      keyOutcome: params.stopReason === "task_complete"
        ? `Completed successfully in ${params.roundsCompleted} rounds.`
        : `Terminated with reason '${params.stopReason}' after ${params.roundsCompleted} rounds.`,
      keyDiscoveries: params.discoveries.slice(0, wp.max_discoveries_in_project),
      date: new Date().toISOString().split("T")[0],
    },
    referenceEntry: {
      description: `LoopForge vault data for "${params.task.slice(0, 80)}"`,
      vaultLocation: `.promptcraft/prompt_vault.json → loop:${params.loopId}:*`,
    },
  };
}

export interface MemoryWritebackPolicy {
  /** Master toggle for memory writeback on loop end. */
  enabled: boolean;
  /** Maximum number of feedback entries to write back. */
  max_feedback_entries: number;
  /** Maximum number of discoveries in the project entry. */
  max_discoveries_in_project: number;
  /** Only write back for these stop reasons. */
  write_on_outcomes: string[];
}

export interface CheckpointPolicy {
  /** Maximum number of constraints carried forward in a checkpoint. */
  max_carried_constraints: number;
  /** Maximum character length of the outcome field in a checkpoint. */
  outcome_max_chars: number;
}

export interface StateFilePolicy {
  /** Master toggle. false = fully disabled, state stays inlined in prompt. */
  enabled: boolean;
  /** Directory relative to project root where state files are written. */
  directory: string;
  /** Max checkpoints to carry in state file. */
  max_checkpoints: number;
  /** Max rounds in cross-round summary section. */
  max_summary_rounds: number;
}

export interface LoopPolicy {
  version: string;
  constraints: ConstraintsPolicy;
  summary: SummaryPolicy;
  technique: TechniquePolicy;
  engine: EnginePolicy;
  runtime: RuntimePolicy;
  backend: BackendPolicy;
  evolution: EvolutionPolicy;
  memory_injection: MemoryInjectionPolicy;
  memory_writeback: MemoryWritebackPolicy;
  checkpoint: CheckpointPolicy;
  state_file: StateFilePolicy;
}

// ═══════════════════════════════════════════════════════════════════════════
// Default policy
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_POLICY: LoopPolicy = {
  version: "1",
  constraints: {
    retire_window: 3,
  },
  summary: {
    window: 5,
    health_check_interval: 1,
  },
  technique: {
    /** @deprecated v1.15 — no longer consumed. Retained for config compatibility. */
    tier2_escalation_failures: 3,
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
  evolution: {
    max_discovered_constraints_per_round: 5,
    max_active_constraints: 15,
    max_objective_versions: 10,
    progress_stall_threshold: 0.05,
    progress_stall_rounds: 2,
    progress_mismatch_threshold: 0.3,
  },
  memory_injection: {
    enabled: true,
    min_rounds_between_injections: 1,
    phase_thresholds: {
      phase1: { trigger: "round_1" },
      phase2: { trigger: "progress", threshold: 0.40 },
      phase3: { trigger: "progress", threshold: 0.70 },
    },
    round_tiers: [
      { max_rounds: 10, allowed_phases: [1] },
      { max_rounds: 20, allowed_phases: [1, 3] },
      { max_rounds: 30, allowed_phases: [1, 2, 3] },
    ],
    dedup_threshold: 0.6,
    max_context_length: 2000,
    section_title: "### Background Context (Long-Term Memory)",
  },
  memory_writeback: {
    enabled: true,
    max_feedback_entries: 5,
    max_discoveries_in_project: 3,
    write_on_outcomes: ["task_complete", "circuit_breaker", "max_rounds"],
  },
  checkpoint: {
    max_carried_constraints: 10,
    outcome_max_chars: 200,
  },
  state_file: {
    enabled: true,
    directory: ".loopforge/state",
    max_checkpoints: 5,
    max_summary_rounds: 5,
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
