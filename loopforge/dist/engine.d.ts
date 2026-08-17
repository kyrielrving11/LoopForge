import type { VaultBackend } from "./backends/interface.js";
import type { LoopStore } from "./loop-store.js";
import { type AgentLoopResult, type LoopForgeRequest, type NormalizedRoundEvaluation } from "./protocol.js";
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
    sessionStart: number;
}
export declare class LoopForgeEngine {
    private readonly backend;
    private readonly metrics;
    constructor(storeOrBackend?: LoopStore | VaultBackend);
    getBackend(): VaultBackend;
    getMetrics(): EngineMetrics;
    hydrateLoopContext(loopId: string): Record<string, unknown> | null;
    private append;
    private persistLineage;
    recordDelegation(loopId: string, round: number, entries: DelegationEntry[]): void;
    autoFeedback(evaluation: NormalizedRoundEvaluation, loopId: string, round: number, task: string, roundTransaction?: Record<string, unknown>): boolean;
    invokeLoopCompile(request: LoopForgeRequest, hydrateResults?: Record<string, unknown> | null, options?: {
        persistLineage?: boolean;
    }): AgentLoopResult;
}
export declare function createEngine(store?: LoopStore | VaultBackend): LoopForgeEngine;
//# sourceMappingURL=engine.d.ts.map