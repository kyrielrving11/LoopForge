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
    backend: BackendPolicy;
}
export declare const DEFAULT_POLICY: LoopPolicy;
export declare function loadPolicy(path?: string): LoopPolicy;
export declare function getPolicy(path?: string): LoopPolicy;
export declare function resetPolicy(): void;
//# sourceMappingURL=policy.d.ts.map