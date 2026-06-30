/** Policy — externalised loop behaviour configuration.
 *
 * All tunable parameters live here instead of as module-level constants.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// ═══════════════════════════════════════════════════════════════════════════
// Default policy
// ═══════════════════════════════════════════════════════════════════════════
export const DEFAULT_POLICY = {
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
    evolution: {
        max_discovered_constraints_per_round: 5,
        max_active_constraints: 15,
        max_objective_versions: 10,
        progress_stall_threshold: 0.05,
        progress_stall_rounds: 2,
        progress_mismatch_threshold: 0.3,
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