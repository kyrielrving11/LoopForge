/** LoopForge-loop_compile — Engine (outer loop manager).
 *
 * 2-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeFeedback.
 * Circuit breaker prevents infinite stall loops.
 * EngineMetrics tracks silent-failure counters for observability.
 */
import type { VaultBackend } from "./backends/interface.js";
import type { LoopStore } from "./loop-store.js";
import { type AgentLoopResult, type CriterionRevision, type ExecutionEvidence, type LoopForgeRequest, type SelfEvaluation, type SessionState } from "./protocol.js";
/** Parse ExecutionEvidence from a raw JSON object. Shared by buildSelfEvaluation
 *  and invokeLoopCompile — both parse the same execution_evidence shape. */
export declare function parseExecutionEvidence(raw: Record<string, unknown> | undefined | null): ExecutionEvidence | undefined;
/** Parse CriterionRevision[] from a raw JSON array. Shared by buildSelfEvaluation
 *  and invokeLoopCompile — both parse the same revised_success_criteria shape. */
export declare function parseCriterionRevisions(raw: unknown): CriterionRevision[];
/** Parse WorkerResult[] from a raw JSON array. Shared by buildSelfEvaluation
 *  and invokeLoopCompile — both parse the same worker_results shape. */
export declare function parseWorkerResults(raw: unknown): import("./protocol.js").WorkerResult[];
/** Extract a structured SelfEvaluation from agent output text.
 *  Returns null if no valid self-eval block is found.
 *  The agent is instructed to output JSON between the delimiters. */
export declare function extractSelfEvaluation(text: string): SelfEvaluation | null;
/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults.
 *  Used by extractSelfEvaluation() (regex path) and MCP tool handler
 *  (structured evaluation parameter path). */
export declare function buildSelfEvaluation(raw: Record<string, unknown>): SelfEvaluation;
/** Fallback heuristic when structured self-eval extraction fails.
 *  Scans agent output for completion and error signals.
 *  Returns a low-confidence SelfEvaluation — the autonomous runner
 *  may choose to warn the user or continue cautiously. */
export declare function heuristicSelfEvaluation(text: string): SelfEvaluation | null;
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