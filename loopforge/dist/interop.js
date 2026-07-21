/** Dependency-free ecosystem checkpoint boundary.
 *
 * **@experimental** — This module is a lightweight stub (57 lines as of v2.0.0).
 * The checkpoint interface is stable but the integration surface (sinks, schema
 * versioning, external consumer contracts) has not been validated in production.
 * Use for prototyping; expect the envelope shape to evolve before v2.1.
 *
 * LangGraph checkpointers, workflow engines, databases, and agent SDKs can
 * consume this neutral envelope without LoopForge importing their packages.
 */
import { getPolicyMetrics } from "./policy-metrics.js";
export const COGNITIVE_CHECKPOINT_SCHEMA_VERSION = 1;
export function createCognitiveCheckpoint(session, updatedAt = new Date().toISOString()) {
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
//# sourceMappingURL=interop.js.map