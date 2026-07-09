/** Policy — externalised loop behaviour configuration.
 *
 * All tunable parameters live here instead of as module-level constants.
 */
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
export declare function resolveInjectionPhase(currentRound: number, injectionCount: number, allowedPhases: Set<number>, progress: number, phase2Triggered: boolean, phase3Triggered: boolean, thresholds: {
    phase2: number;
    phase3: number;
}): 0 | 1 | 2 | 3;
/** Build accumulated context for a targeted memory query from a SelfEvaluation.
 *  Extracts recurring issues, key lessons, and remaining criteria.
 *  Shared between LoopRuntime (runtime.ts) and SessionManager (mcp/session.ts). */
export declare function buildAccumulatedMemoryContext(selfEval: {
    constraint_violations: string[];
    execution_evidence?: {
        success_criteria_remaining?: string[];
    } | null;
    emerged_subtasks?: string[];
    wrong_assumptions?: string[];
}): {
    recurringIssues: string[];
    failedPatterns: string[];
    keyLessons: string[];
    remainingCriteria: string[];
};
/** Build a base LoopMemoryWriteback payload from loop terminal state.
 *  Shared between LoopRuntime (runtime.ts) and SessionManager (mcp/session.ts).
 *  Callers may layer additional feedback entries on top of the returned payload. */
export declare function buildBaseMemoryWriteback(params: {
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
};
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
export declare const DEFAULT_POLICY: LoopPolicy;
export declare function loadPolicy(path?: string): LoopPolicy;
export declare function getPolicy(path?: string): LoopPolicy;
export declare function resetPolicy(): void;
//# sourceMappingURL=policy.d.ts.map