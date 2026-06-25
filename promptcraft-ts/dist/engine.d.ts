/** PromptCraft-loop_compile — Engine (outer loop manager).
 *
 * v1.0: 3-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeBuild (internal), invokeFeedback.
 * Circuit breaker prevents infinite stall loops.
 * EngineMetrics tracks silent-failure counters for observability.
 *
 * Python reference: engine.py (~783 lines)
 */
import type { VaultBackend } from "./backends/interface.js";
import { type AgentLoopResult, type PromptCraftRequest, type SessionState } from "./protocol.js";
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
export declare class PromptCraftEngine {
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
    invokeBuild(request: PromptCraftRequest, _hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    invokeFeedback(request: PromptCraftRequest, _hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    invokeLoopCompile(request: PromptCraftRequest, hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    handleReview(request: PromptCraftRequest, hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    shouldBreak(): boolean;
}
export declare function createEngine(skillsDir?: string, backend?: VaultBackend): PromptCraftEngine;
//# sourceMappingURL=engine.d.ts.map