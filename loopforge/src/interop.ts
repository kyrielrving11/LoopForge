/** Dependency-free ecosystem checkpoint boundary.
 *
 * LangGraph checkpointers, workflow engines, databases, and agent SDKs can
 * consume this neutral envelope without LoopForge importing their packages.
 */

import type { McpSession } from "./mcp/session.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
import { getPolicyMetrics } from "./policy-metrics.js";

export const COGNITIVE_CHECKPOINT_SCHEMA_VERSION = 1 as const;

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

export function createCognitiveCheckpoint(
  session: McpSession,
  updatedAt = new Date().toISOString(),
): CognitiveStateCheckpoint {
  const roundId = session.roundSnapshot?.roundId;
  return {
    schemaVersion: COGNITIVE_CHECKPOINT_SCHEMA_VERSION,
    checkpointId: roundId
      ? `${roundId}:session`
      : `loop:${session.loopId}:round:${session.currentRound}:session`,
    loopId: session.loopId,
    sessionId: session.sessionId,
    task: session.task,
    status: session.status,
    round: session.currentRound,
    maxRounds: session.maxRounds,
    roundId,
    prompt: session.currentPrompt,
    successTrajectory: [...session.successTrajectory],
    roundSnapshot: session.roundSnapshot,
    policyMetrics: getPolicyMetrics(session.loopId),
    updatedAt,
  };
}
