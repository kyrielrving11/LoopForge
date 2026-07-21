/** Externalized LoopForge runtime policy. */
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
    max_rounds: number;
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
    prompt: PromptPolicy;
    backend: BackendPolicy;
    evolution: EvolutionPolicy;
    checkpoint: CheckpointPolicy;
    state_file: StateFilePolicy;
    evidence: EvidencePolicy;
    mcp: McpPolicy;
}
export declare const DEFAULT_POLICY: LoopPolicy;
/** Write a full default `loop_policy.json` to the target directory.
 *
 *  The written file contains every configurable key and its default value
 *  so users can discover and tune the system without reading source code.
 *  Skip creation when the file already exists unless `force` is true.
 *
 * @returns The resolved file path and whether it was freshly created.
 */
export declare function writeDefaultPolicy(targetDir: string, force?: boolean): {
    path: string;
    created: boolean;
};
export declare function loadPolicy(path?: string): LoopPolicy;
export declare function getPolicy(path?: string): LoopPolicy;
export declare function resetPolicy(): void;
export declare function validateLoopId(loopId: string): void;
export declare function resolveStateDirectory(workspaceRoot: string, configuredDirectory: string): string;
export declare function writeStateFile(loopId: string, content: string | undefined): void;
//# sourceMappingURL=policy.d.ts.map