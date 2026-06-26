/** LoopForge-loop_compile — Engine (outer loop manager).
 *
 * v1.0: 3-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeBuild (internal), invokeFeedback.
 * Circuit breaker prevents infinite stall loops.
 * EngineMetrics tracks silent-failure counters for observability.
 */
import type { VaultBackend } from "./backends/interface.js";
import { type AgentLoopResult, type LoopForgeRequest, type SelfEvaluation, type SessionState } from "./protocol.js";
/** Extract a structured SelfEvaluation from agent output text.
 *  Returns null if no valid self-evaluation block is found.
 *  The agent is instructed to output JSON between the delimiters. */
export declare function extractSelfEvaluation(text: string): SelfEvaluation | null;
/** Fallback heuristic when structured self-eval extraction fails.
 *  Scans agent output for completion and error signals.
 *  Returns a low-confidence SelfEvaluation — the autonomous runner
 *  may choose to warn the user or continue cautiously. */
export declare function heuristicSelfEvaluation(text: string): SelfEvaluation | null;
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
    skillsDir: string;
    state: SessionState | null;
    private backend;
    private metrics;
    private feedbackWriteBuffer;
    lastTask: string | null;
    private seenConstraints;
    constructor(skillsDir?: string, backend?: VaultBackend);
    private resolveBackend;
    private ensureInit;
    private persistFeedbackToVault;
    flushFeedbackBuffer(): number;
    private persistLoopLineage;
    hydrateLoopContext(loopId: string): Record<string, unknown> | null;
    invokeBuild(request: LoopForgeRequest, _hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    invokeFeedback(request: LoopForgeRequest, _hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    /** Record self-evaluation from agent output without human intervention.
     *  Converts SelfEvaluation → ExecutionFeedback → vault persistence.
     *  Call this BEFORE invokeLoopCompile for the next round so that
     *  hydrateLoopContext picks up the latest quality scores. */
    autoFeedback(selfEval: SelfEvaluation, loopId: string, round: number, task: string): number;
    invokeLoopCompile(request: LoopForgeRequest, hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    handleReview(request: LoopForgeRequest, hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    shouldBreak(): boolean;
}
export declare function createEngine(skillsDir?: string, backend?: VaultBackend): LoopForgeEngine;
//# sourceMappingURL=engine.d.ts.map