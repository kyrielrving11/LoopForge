/** Policy — externalised loop behaviour configuration.
 *
 * All tunable parameters live here instead of as module-level constants.
 */
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
        phase1: {
            trigger: "round_1";
        };
        phase2: {
            trigger: "progress";
            threshold: number;
        };
        phase3: {
            trigger: "progress";
            threshold: number;
        };
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
export declare function resolveAllowedPhases(maxRounds: number, tiers: MemoryInjectionTier[]): number[];
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
export interface LoopPolicy {
    version: string;
    constraints: ConstraintsPolicy;
    summary: SummaryPolicy;
    recompile_triggers: RecompileTriggersPolicy;
    technique: TechniquePolicy;
    engine: EnginePolicy;
    runtime: RuntimePolicy;
    backend: BackendPolicy;
    evolution: EvolutionPolicy;
    memory_injection: MemoryInjectionPolicy;
    memory_writeback: MemoryWritebackPolicy;
}
export declare const DEFAULT_POLICY: LoopPolicy;
export declare function loadPolicy(path?: string): LoopPolicy;
export declare function getPolicy(path?: string): LoopPolicy;
export declare function resetPolicy(): void;
//# sourceMappingURL=policy.d.ts.map