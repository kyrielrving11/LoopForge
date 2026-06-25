/** LoopForge-loop_compile — Engine (outer loop manager).
 *
 * v1.0: 3-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeBuild (internal), invokeFeedback.
 * Circuit breaker prevents infinite stall loops.
 * EngineMetrics tracks silent-failure counters for observability.
 */
import type { VaultBackend } from "./backends/interface.js";
import { type AgentLoopResult, type LoopForgeRequest, type SessionState } from "./protocol.js";
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
    invokeLoopCompile(request: LoopForgeRequest, hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    handleReview(request: LoopForgeRequest, hydrateResults?: Record<string, unknown> | null): AgentLoopResult;
    shouldBreak(): boolean;
}
export declare function createEngine(skillsDir?: string, backend?: VaultBackend): LoopForgeEngine;
//# sourceMappingURL=engine.d.ts.map