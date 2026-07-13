/** Dependency-free ecosystem checkpoint boundary.
 *
 * LangGraph checkpointers, workflow engines, databases, and agent SDKs can
 * consume this neutral envelope without LoopForge importing their packages.
 */
import type { McpSession } from "./mcp/session.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
import { getPolicyMetrics } from "./policy-metrics.js";
export declare const COGNITIVE_CHECKPOINT_SCHEMA_VERSION: 1;
export interface CognitiveStateCheckpoint {
    schemaVersion: typeof COGNITIVE_CHECKPOINT_SCHEMA_VERSION;
    checkpointId: string;
    loopId: string;
    sessionId: string;
    task: string;
    status: "running" | "stopped" | "stalled" | "paused";
    round: number;
    maxRounds: number;
    roundId?: string;
    prompt?: string | null;
    successTrajectory: boolean[];
    roundSnapshot?: RoundTransactionSnapshot;
    policyMetrics: ReturnType<typeof getPolicyMetrics>;
    updatedAt: string;
}
export interface CognitiveCheckpointSink {
    save(checkpoint: CognitiveStateCheckpoint): void | Promise<void>;
}
export declare function createCognitiveCheckpoint(session: McpSession, updatedAt?: string): CognitiveStateCheckpoint;
//# sourceMappingURL=interop.d.ts.map