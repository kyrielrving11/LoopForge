/** LoopForge-loop_compile — Engine (outer loop manager).
 *
 * 2-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeFeedback.
 * Circuit breaker prevents infinite stall loops.
 * EngineMetrics tracks silent-failure counters for observability.
 */
import type { VaultBackend } from "./backends/interface.js";
import type { LoopStore } from "./loop-store.js";
import { type AgentLoopResult, type LoopForgeRequest, type SelfEvaluation, type SessionState } from "./protocol.js";
export { parseExecutionEvidence, parseCriterionRevisions, parseWorkerResults, extractSelfEvaluation, buildSelfEvaluation, heuristicSelfEvaluation, } from "./self-eval.js";
/** A single sub-agent delegation record (v1.9 — AgentTool mode). */
export interface DelegationEntry {
    index: number;
    agentId: string;
    subAgentType: string;
    subTask: string;
    resultSummary: string;
    success: boolean;
    discoveredConstraints: string[];
}
export interface EngineMetrics {
    vaultWriteErrors: number;
    vaultWriteTimeouts: number;
    vaultWriteBytes: number;
    silentAnalysisErrors: number;
    hydrateCacheMisses: number;
    feedbackBufferFlushes: number;
    feedbackBufferMaxSize: number;
    sessionStart: number;
}
export declare class LoopForgeEngine {
    state: SessionState | null;
    private backend;
    private metrics;
    private feedbackWriteBuffer;
    lastTask: string | null;
    constructor(storeOrBackend?: LoopStore | VaultBackend);
    private resolveBackend;
    /** Public accessor for the vault backend — used by runtime/verification gate. */
    getBackend(): VaultBackend;
    /** Expose engine health counters for observability (MCP status, logging). */
    getMetrics(): EngineMetrics;
    private ensureInit;
    private persistFeedbackToVault;
    flushFeedbackBuffer(): number;
    private persistLoopLineage;
    /** Record sub-agent delegations for this round into the vault.
     *  Written as a lightweight journal entry so the main agent's rolling
     *  summary can reference delegation history in subsequent rounds. */
    recordDelegation(loopId: string, round: number, entries: DelegationEntry[]): void;
    hydrateLoopContext(loopId: string): Record<string, unknown> | null;
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
    shouldBreak(): boolean;
}
export declare function createEngine(store?: LoopStore): LoopForgeEngine;
//# sourceMappingURL=engine.d.ts.map