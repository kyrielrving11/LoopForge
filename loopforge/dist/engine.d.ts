/** LoopForge-loop_compile — Engine (outer loop manager).
 *
 * 2-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeFeedback.
 * Enforcement gates prevent infinite stall loops; EngineMetrics records
 * silent-failure counters for observability.
 */
import type { LoopStore } from "./loop-store.js";
import { type AgentLoopResult, type LoopForgeRequest, type SelfEvaluation, type SessionState } from "./protocol.js";
export { parseExecutionEvidence, parseCriterionRevisions, parseWorkerResults, buildSelfEvaluation, } from "./self-eval.js";
/** A single sub-agent delegation record (v1.9 — AgentTool mode).
 *  v3.7.1: outcome is the single fact; success is deleted. */
export interface DelegationEntry {
    index: number;
    agentId: string;
    subAgentType: string;
    subTask: string;
    resultSummary: string;
    outcome: "success" | "partial" | "failed";
    discoveredConstraints: string[];
}
export interface EngineMetrics {
    vaultWriteErrors: number;
    sessionStart: number;
}
export declare class LoopForgeEngine {
    state: SessionState | null;
    private store;
    private metrics;
    lastTask: string | null;
    constructor(store?: LoopStore);
    private resolveStore;
    /** Public accessor for the loop store — used by the round transaction
     *  coordinator and round driver. */
    getStore(): LoopStore;
    /** Expose engine health counters for observability (MCP status, logging). */
    getMetrics(): EngineMetrics;
    private ensureInit;
    private persistFeedbackToVault;
    private buildFeedbackEntry;
    private persistLoopLineage;
    /** Record sub-agent delegations for this round into the vault.
     *  Written as a lightweight journal entry so the main agent's rolling
     *  summary can reference delegation history in subsequent rounds. */
    recordDelegation(loopId: string, round: number, entries: DelegationEntry[]): void;
    /** Eval-owned fields merged from the committed round decision onto the
     *  lineage entry. These are the agent's report of what happened during the
     *  round; compile-time lineage fields (constraints_active, goal_text_hash,
     *  recompile_level, …) are left untouched. */
    private static readonly EVAL_MERGED_LINEAGE_FIELDS;
    /** Merge the committed round decision (feedback entry) into the compile-time
     *  lineage entry so the compiler and projections see the full per-round
     *  truth: verification flags, round success, and the agent's own evaluation. */
    private mergeCommittedRound;
    /** v3.0.1: Per-engine hydration cache. The vault is append-only per round —
     *  between two compiles of one loop only the newest round(s) changed. The
     *  cache holds the merged lineage entries (the exact shape the compiler
     *  consumes; feedback bodies are merged in, never returned), so a long-lived
     *  process compiles incrementally: one round document read per round
     *  boundary instead of the full history. Nothing is persisted; a fresh
     *  engine hydrates fully once. `coveredRound` is the highest CONTIGUOUS
     *  COMMITTED round (feedback merged) whose entries are in the cache — the
     *  compiler only reads rounds below the compile round, so
     *  `coveredRound >= round - 1` means the cache is complete for that compile.
     *  Lineage-only entries of not-yet-committed rounds may trail the cache but
     *  never advance coveredRound (a later read replaces them post-commit). */
    private hydrationCache;
    /** v3.7.1: Drop the hydration cache after a committed BACKTRACK decision.
     *  The rollback commits as the CURRENT round (cache.coveredRound + 1), so
     *  the normal incremental path never re-reads it before the restore
     *  compile — which targets the SAME round and must see the rollback
     *  immediately (recovery-boundary L2, Recovery Brief facts). One full
     *  rehydrate on the rare rollback path is the correct trade. */
    invalidateHydrationCache(loopId: string): void;
    /** v3.3.1: Drop the hydration cache when a feedback write targets a round
     *  the cache has already merged (coveredRound >= round). Cache entries are
     *  LINEAGE task_ids (loop:…:rN), so a task_id collision test could never
     *  fire for feedback writes (loop:…:rN:feedback) — the round number is the
     *  real collision signal. A backtrack redo reuses the roundId and REPLACES
     *  the round's committed feedback (v3.2.1 semantics); without this the
     *  fast path (coveredRound >= compileRound - 1) would serve the stale
     *  rolled-back entry for the rest of the process. A genuinely new round
     *  (round = coveredRound + 1) lands past the cache point and is merged by
     *  the next incremental read — no invalidation. Lineage writes never
     *  invalidate: they precede the commit by design. */
    private invalidateHydrationCacheForFeedback;
    /** The round a feedback entry belongs to, or null. */
    private static feedbackRound;
    /** Highest contiguous round (from 1) present in the given feedback entries. */
    private static contiguousCommittedRound;
    /** Merge committed feedback entries into lineage entries and apply the
     *  canonical output_summary / constraint_violations projection. Shared by the
     *  full and incremental hydration paths so both produce identical shapes.
     *
     *  The round commit entry (`loop:<id>:r<N>:feedback`) carries the full
     *  committed decision — verification flags, round success, and the agent's
     *  SelfEvaluation — which the compiler needs to derive milestones,
     *  constraint decay, sub-goal accumulation, and rolling summaries. Without
     *  this merge the cross-round features only see the 8 compile-time lineage
     *  fields. */
    private buildMergedEntries;
    hydrateLoopContext(loopId: string, round?: number): Record<string, unknown> | null;
    invokeFeedback(request: LoopForgeRequest, _hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    /** Record self-evaluation from agent output without human intervention.
     *  Converts SelfEvaluation → ExecutionFeedback → vault persistence.
     *  P0–P2: Also persists discovered_constraints, objective_refinement,
     *  and emerged_subtasks for the compiler to consume next round.
     *  Call this BEFORE invokeLoopCompile for the next round so that
     *  hydrateLoopContext picks up the latest success flags. */
    autoFeedback(selfEval: SelfEvaluation, loopId: string, round: number, task: string, roundTransaction?: Record<string, unknown>): boolean;
    invokeLoopCompile(request: LoopForgeRequest, hydrateResults?: Record<string, unknown> | null, options?: {
        persistLineage?: boolean;
    }): AgentLoopResult;
}
export declare function createEngine(store?: LoopStore): LoopForgeEngine;
//# sourceMappingURL=engine.d.ts.map