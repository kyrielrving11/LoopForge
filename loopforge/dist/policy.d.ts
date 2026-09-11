/** Externalized LoopForge runtime policy. */
import type { ConfiguredCapability } from "./protocol.js";
export interface ConstraintsPolicy {
    retire_window: number;
}
export interface SummaryPolicy {
    window: number;
    health_check_interval: number;
    /** v2.1: Rounds between automatic safety-net milestones.
     *  Default 20. Only fires when no agent_declared or criteria_milestone
     *  has been created for this many rounds. */
    milestone_interval: number;
    /** v2.1: Maximum number of milestone summaries to accumulate.
     *  Oldest milestones are evicted when the cap is exceeded. */
    max_milestones: number;
    /** v3.0.1: L1 milestone sampling — when milestones exceed max_milestones,
     *  keep this many of the OLDEST milestones as history anchors. The same
     *  count of the NEWEST is always kept; the middle is sampled evenly. */
    milestone_head_count: number;
    /** v3.0.1: L1 milestone sampling — this many of the NEWEST milestones are
     *  always kept when the cap is exceeded. */
    milestone_tail_count: number;
}
export interface EnginePolicy {
    /** Number of committed rounds inspected for progress stalls. */
    stall_lookback_rounds: number;
    max_rounds: number;
    /** v2.7: When true, enforcement rules that would terminate (R4 2nd strike,
     *  R5 flatline, R6 max rejections) instead issue one final escalated
     *  rejection with a "Seek Human Guidance" notice before terminating.
     *  This gives the agent one extra chance to course-correct with human
     *  input rather than being terminated immediately. Default: true. */
    enforcement_escalation_enabled: boolean;
    /** v2.10: When true, R4 (progress stall) and R5 (flat terminal) escalate
     *  to backtrack instead of reject. The agent is rolled back to the last
     *  clean round with lessons injected. Set to false to restore pre-v2.10
     *  behavior (escalated reject without backtrack). Default: true. */
    backtrack_enabled: boolean;
    /** v2.10: Max rounds to search backwards for a safe restore point.
     *  If no clean round is found within this depth, backtrack falls through
     *  to terminate. Default: 3. */
    backtrack_max_depth: number;
    /** v2.10: When true, discovered_constraints from skipped rounds are
     *  preserved and merged into the restored state's active constraints.
     *  Default: true. */
    backtrack_preserve_discoveries: boolean;
    /** v3.8: How many consecutive committed rounds may claim contract items
     *  met without any machine verification progress before the enforcement
     *  gate rejects, then terminates as `incomplete`. The counter is derived
     *  from committed rounds plus the in-flight round — agent self-reports and
     *  git motion never reset it; only a newly verified item (or a passing
     *  bound command) does. Default: 3. Set to 0 to disable. */
    unverified_claim_streak_limit: number;
}
/** Levels control state density only; reasoning strategy belongs to the Agent. */
export interface PromptPolicy {
    full_refresh_interval: number;
    l0_max_chars: number;
    l1_max_chars: number;
    l2_max_chars: number;
    /** v2.4: Enable adaptive L2 budget scaling with loop complexity.
     *  Grows with round count + milestone count up to l2_adaptive_max_chars. */
    l2_adaptive_enabled: boolean;
    /** v2.4: Additional L2 chars per completed round. Default: 200. */
    l2_adaptive_round_factor: number;
    /** v2.4: Additional L2 chars per milestone. Default: 1000. */
    l2_adaptive_milestone_factor: number;
    /** v2.4: Absolute ceiling for adaptive L2 budget. Default: 40000. */
    l2_adaptive_max_chars: number;
    /** v2.5: Additional L2 chars per tracked sub-goal. Default: 100. */
    l2_adaptive_subgoal_factor: number;
    /** v2.8: When true, L2 prompts skip inline fullStateMarkdown and
     *  instruct the agent to read the state file instead. Structured
     *  sections (milestones, sub-goals, trust, progress) are still
     *  rendered. Default: true. Set to false to restore pre-v2.8 L2
     *  behavior. */
    l2_pointer_enabled: boolean;
    /** v3.2: Collapse unchanged L1 content (vs the previous round's persisted
     *  presentation) into one-line state-file pointers. Default: true.
     *  Set to false to restore pre-v3.2 full L1 rendering. */
    l1_collapse_enabled: boolean;
    /** v3.5: When true, L2 prompts whose Current Task is NOT a Round Contract
     *  append a short suggestion to declare one when the remaining work spans
     *  several rounds. L2-only prose in the eval template tail — never the
     *  JSON key name; L0/L1 prompts are unaffected (byte-identical to v3.4).
     *  Default: true. Set to false to restore pre-v3.5 L2 rendering. */
    contract_nudge_on_l2: boolean;
    /** v2.9: Max emphasize items when level is L2. Default: 5. */
    max_emphasize_l2: number;
    /** v2.9: Max emphasize items when level is L1. Default: 3. */
    max_emphasize_l1: number;
    /** v2.9: Max confusion points rendered. Default: 3. */
    max_confusion_points: number;
    /** v2.14: Jaccard threshold for pointing a confusion point at its
     *  best-matching state section. Default: 0.15 (15%). */
    confusion_section_threshold: number;
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
    progress_mismatch_threshold: number;
    /** v2.14: Jaccard threshold for task continuity in checkLoopHealth —
     *  below this, the loop is considered drifting. Default: 0.2. */
    task_continuity_threshold: number;
    /** v2.5: Jaccard threshold for detecting genuinely new success criteria
     *  between rounds. Used by detectNewCriteria(). Default: 0.45. */
    criteria_dedup_threshold: number;
    /** v2.5: Jaccard threshold for deduplicating new sub-goals against
     *  existing ones. Used when accumulating emerged_subtasks. Default: 0.6. */
    subgoal_dedup_threshold: number;
    /** v2.5: Jaccard threshold for matching agent-declared status changes
     *  (completed/blocked/canceled) to existing sub-goals. Default: 0.5. */
    subgoal_match_threshold: number;
    /** v3.7.1: Max ACTIVE sub-goals (pending/in_progress/blocked) shown in
     *  prompts and the state file. done/canceled never render as items —
     *  they survive in the vault, replay, and counts. */
    max_active_subgoals: number;
    /** v2.5: Jaccard threshold for matching constraints during discovery
     *  and violation tracking. Default: 0.5. */
    constraint_match_threshold: number;
    /** v2.11: When true, constraints and criteria are assigned stable IDs
     *  (c-XXXXXXXX, cr-XXXXXXXX) rendered in prompts. The agent is encouraged
     *  to reference IDs for exact matching; natural-language references use
     *  Jaccard similarity. Default: true. */
    constraint_id_enabled: boolean;
}
export interface CheckpointPolicy {
    outcome_max_chars: number;
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
/** v2.12/v3.7.1: User/Agent gate governance. The gate is an OPT-IN
 *  blocking layer. When disabled (the default): the two gate tools are
 *  hidden from tools/list, direct calls return gate_disabled, and rounds
 *  citing gate_ids are not checked. When enabled: loopforge_gate_check is
 *  a structured preflight; high-risk actions persist a gate_opened record
 *  and a round that cites an unapproved gate is rejected. */
export interface GatePolicy {
    enabled: boolean;
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
    gate: GatePolicy;
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
/** v3.2: Test-only injection — mirrors resetPolicy so tests can exercise a
 *  specific policy configuration (e.g. l1_collapse_enabled=false). */
export declare function setPolicyForTest(next: LoopPolicy): void;
/** v3.8: Deterministic hash of a command's verification configuration. Used
 *  to prove that a contract's bound command did not change under the agent
 *  between declaration and closure. `args` order is preserved (semantically
 *  meaningful); `success_exit_codes` is sorted (an equivalent set must hash
 *  equal). Pure — no I/O, no probing. */
export declare function commandConfigHash(config: CommandEvidencePolicy): string;
/** v3.8: Static verification capability — a pure function of policy, so it is
 *  byte-identical across retries of the same round and reproducible by
 *  replay/audit from committed facts. It contains NO probing, no filesystem
 *  access, and no provider-registry state; readiness of the runtime
 *  environment is a `doctor` concern, not a hashed fact. */
export declare function deriveConfiguredCapability(policy: LoopPolicy): ConfiguredCapability;
/** v3.3/v3.8: Whether a command name may back a Round Contract item. A
 *  contract item is verified by an AFTER-phase observation, so the predicate
 *  requires configured AND enabled AND after-capable — `verify_with` may only
 *  reference a command the runtime can actually observe at closure time.
 *
 *  `CommandEvidencePolicy.phase` is `"after" | "both"` today, so the phase arm
 *  is currently self-satisfying; it is stated explicitly because it is the
 *  boundary the contract declaration is judged against, not an accident of
 *  the current phase enum. */
export declare function isConfiguredCommand(name: string): boolean;
export declare function validateLoopId(loopId: string): void;
export declare function resolveStateDirectory(workspaceRoot: string, configuredDirectory: string): string;
export declare function writeStateFile(loopId: string, content: string | undefined): void;
//# sourceMappingURL=policy.d.ts.map