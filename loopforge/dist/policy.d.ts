/** Externalized LoopForge runtime policy. */
import type { WorkflowState } from "./protocol.js";
import type { GovernanceGraphSummary } from "./governance-graph.js";
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
/** Bind the process policy lookup to a workspace after workspace validation. */
export declare function bindPolicyWorkspace(workspaceRoot: string): LoopPolicy;
export declare function validateLoopId(loopId: string): void;
export declare function resolveStateDirectory(workspaceRoot: string, configuredDirectory: string): string;
export declare function writeStateFile(loopId: string, content: string | undefined, workspaceRoot?: string): void;
/** Update the optional Markdown projection with v3 workflow state. The typed
 * session/round JSON remains the durable truth. */
export declare function writeWorkflowStateFile(loopId: string, workflow: WorkflowState, workspaceRoot?: string, graphSummary?: GovernanceGraphSummary, regressionSummary?: {
    total: number;
    verified: number;
    gaps: number;
}): void;
//# sourceMappingURL=policy.d.ts.map