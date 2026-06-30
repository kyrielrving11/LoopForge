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
}
export declare const DEFAULT_POLICY: LoopPolicy;
export declare function loadPolicy(path?: string): LoopPolicy;
export declare function getPolicy(path?: string): LoopPolicy;
export declare function resetPolicy(): void;
//# sourceMappingURL=policy.d.ts.map