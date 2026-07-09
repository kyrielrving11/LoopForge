/** Policy — externalised loop behaviour configuration.
 *
 * All tunable parameters live here instead of as module-level constants.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/** Resolve which injection phases are allowed for a given maxRounds.
 *  Uses the tiered strategy: finds the first tier where maxRounds ≤ tier.max_rounds,
 *  and returns its allowed_phases. If maxRounds exceeds all tiers, returns the
 *  last tier's phases. */
export function resolveAllowedPhases(maxRounds, tiers) {
    if (tiers.length === 0)
        return [1]; // safety fallback
    for (const tier of tiers) {
        if (maxRounds <= tier.max_rounds)
            return tier.allowed_phases;
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
export function resolveInjectionPhase(currentRound, injectionCount, allowedPhases, progress, phase2Triggered, phase3Triggered, thresholds) {
    const maxInjections = allowedPhases.size;
    if (injectionCount >= maxInjections)
        return 0;
    // Phase 1: round 1 only
    if (currentRound === 1 && injectionCount === 0 && allowedPhases.has(1)) {
        return 1;
    }
    const hasProgress = progress >= 0;
    // Phase 2: progress threshold (only if allowed by tier and not yet triggered)
    if (allowedPhases.has(2) &&
        !phase2Triggered &&
        hasProgress &&
        progress >= thresholds.phase2) {
        return 2;
    }
    // Phase 3: progress threshold (only if allowed by tier and not yet triggered)
    if (allowedPhases.has(3) &&
        !phase3Triggered &&
        hasProgress &&
        progress >= thresholds.phase3) {
        return 3;
    }
    return 0;
}
/** Build accumulated context for a targeted memory query from a SelfEvaluation.
 *  Extracts recurring issues, key lessons, and remaining criteria.
 *  Shared between LoopRuntime (runtime.ts) and SessionManager (mcp/session.ts). */
export function buildAccumulatedMemoryContext(selfEval) {
    const recurringIssues = [];
    const failedPatterns = [];
    const keyLessons = [];
    const remainingCriteria = [];
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
export function buildBaseMemoryWriteback(params) {
    const wp = getPolicy().memory_writeback;
    const outcome = (params.stopReason === "task_complete" ? "completed" :
        params.stopReason === "circuit_breaker" ? "circuit_breaker" :
            params.stopReason === "stalled" ? "stalled" :
                params.stopReason === "max_rounds" ? "max_rounds" :
                    "stopped");
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
// ═══════════════════════════════════════════════════════════════════════════
// Default policy
// ═══════════════════════════════════════════════════════════════════════════
export const DEFAULT_POLICY = {
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
function deepMerge(defaults, overrides) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
        if (key in result &&
            typeof result[key] === "object" &&
            !Array.isArray(result[key]) &&
            typeof overrides[key] === "object" &&
            !Array.isArray(overrides[key]) &&
            overrides[key] !== null) {
            result[key] = deepMerge(result[key], overrides[key]);
        }
        else {
            result[key] = overrides[key];
        }
    }
    return result;
}
// ═══════════════════════════════════════════════════════════════════════════
// Loader
// ═══════════════════════════════════════════════════════════════════════════
export function loadPolicy(path) {
    const candidates = [path, "loop_policy.json"].filter(Boolean);
    for (const candidate of candidates) {
        try {
            const resolved = resolve(candidate);
            const raw = JSON.parse(readFileSync(resolved, "utf-8"));
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                return deepMerge(DEFAULT_POLICY, raw);
            }
        }
        catch {
            // File not found or invalid — try next candidate
        }
    }
    return { ...DEFAULT_POLICY };
}
// ═══════════════════════════════════════════════════════════════════════════
// Module-level singleton — loaded once per session
// ═══════════════════════════════════════════════════════════════════════════
let _policy = null;
export function getPolicy(path) {
    if (_policy === null) {
        _policy = loadPolicy(path);
    }
    return _policy;
}
export function resetPolicy() {
    _policy = null;
}
//# sourceMappingURL=policy.js.map