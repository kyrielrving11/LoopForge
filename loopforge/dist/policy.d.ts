/** Externalized LoopForge runtime policy. */
import type { ConfiguredCapability } from "./protocol.js";
export interface ConstraintsPolicy {
    retire_window: number;
}
export interface SummaryPolicy {
    window: number;
    /** v2.1: Rounds between automatic safety-net milestones.
     *  Default 20. Only fires when no agent_declared or criteria_milestone
     *  has been created for this many rounds. */
    milestone_interval: number;
}
export interface EnginePolicy {
    /** v3.8.1: the window of the progress BREAKER tier — the second tier of the
     *  single progress evaluator, which fires when the stall tier (a fixed 3
     *  committed rounds) saw no stall. Default: 3. */
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
    l0_max_chars: number;
    l1_max_chars: number;
    l2_max_chars: number;
    /** v2.8: When true, L2 prompts skip inline fullStateMarkdown and
     *  instruct the agent to read the state file instead. Structured
     *  sections (milestones, sub-goals, trust, progress) are still
     *  rendered. Default: true. Set to false to restore pre-v2.8 L2
     *  behavior. */
    l2_pointer_enabled: boolean;
    /** v2.9: Max emphasize items when level is L2. Default: 5. */
    max_emphasize_l2: number;
    /** v2.9: Max emphasize items when level is L1. Default: 3. */
    max_emphasize_l1: number;
    /** v2.9: Max confusion points rendered at L2. Default: 3.
     *  L1 renders the FIRST alert plus a pointer to the state file — that is a
     *  density decision of the lean level (like the split max_emphasize_l1/l2
     *  caps), not this knob. */
    max_confusion_points: number;
}
export interface BackendPolicy {
    /** Root for typed per-loop documents. */
    root_dir: string;
}
export interface EvolutionPolicy {
    max_discovered_constraints_per_round: number;
    max_active_constraints: number;
    max_objective_versions: number;
    /** Numeric progress tolerance for the stall evaluator — not a text score. */
    progress_stall_threshold: number;
    /** v3.7.1: Max ACTIVE sub-goals (pending/in_progress/blocked) shown in
     *  prompts and the state file. done/canceled never render as items —
     *  they survive in the vault, replay, and counts. */
    max_active_subgoals: number;
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
/** v3.8.1: the policy schema version. A policy file that does not declare
 *  exactly this version is REJECTED — see loadPolicy. */
export declare const POLICY_SCHEMA_VERSION = "4";
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
/** Load the runtime policy, or fall back to the defaults when no file
 *  declares one.
 *
 *  v3.8.1: the `version` field is load-bearing. Previously it was a
 *  declarative string that NOTHING read, so a policy written for an older
 *  schema was silently merged over the current defaults — options that no
 *  longer exist evaporated and options that changed meaning were applied
 *  under their old name. Now a file either declares the current schema
 *  version or the load fails, and the failure surfaces as `policy_invalid`
 *  rather than the loop running on a configuration nobody chose.
 *
 *  A MISSING or unparseable file still falls through to the defaults (running
 *  with no policy file is normal). A file that exists and parses is a
 *  declaration, so its defects propagate instead of being swallowed. */
export declare function loadPolicy(path?: string): LoopPolicy;
export declare function getPolicy(path?: string): LoopPolicy;
export declare function resetPolicy(): void;
/** v3.2: Test-only injection — mirrors resetPolicy so tests can exercise a
 *  specific policy configuration (e.g. state_file.enabled=false). */
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