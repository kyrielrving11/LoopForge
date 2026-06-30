/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 */
import { LoopForgeEngine } from "../engine.js";
import type { VaultBackend } from "../backends/interface.js";
import type { SelfEvaluation } from "../protocol.js";
export interface McpSession {
    sessionId: string;
    loopId: string;
    task: string;
    engine: LoopForgeEngine;
    currentRound: number;
    maxRounds: number;
    qualityTrajectory: number[];
    status: "running" | "stopped" | "stalled";
    createdAt: number;
    /** Previous round's validated SelfEvaluation — used by verification gate. */
    lastSelfEval?: SelfEvaluation;
}
export interface McpSessionSummary {
    sessionId: string;
    loopId: string;
    round: number;
    status: "running" | "stopped" | "stalled";
}
export interface StartInput {
    task: string;
    loopId?: string;
    maxRounds?: number;
    domain?: string;
    planSource?: string;
    constraints?: string[];
}
export interface AdvanceResult {
    sessionId: string;
    round: number;
    prompt: string | null;
    stopReason?: string;
    technique?: string;
    level?: string;
    quality?: number;
    warnings?: string[];
}
export declare class SessionManager {
    private sessions;
    private backend;
    constructor(backend?: VaultBackend);
    create(input: StartInput): AdvanceResult;
    get(sessionId: string): McpSession | undefined;
    delete(sessionId: string): boolean;
    /** Persist session state to vault for cross-process recovery.
     *  Uses upsert: removes any previous session_state entry for this loop,
     *  then appends a new one with current state.
     *  Entire read→filter→write→append is wrapped in a file lock to prevent
     *  lost updates from concurrent processes. */
    save(session: McpSession): void;
    /** Resume a loop from vault state.
     *  Reconstructs the session and compiles the prompt for the next round.
     *  Returns null if no session_state entry exists for this loopId. */
    resume(loopId: string): AdvanceResult | null;
    list(): McpSessionSummary[];
    /** Get loop health for a loop (in-memory or vault).
     *  Computes goal alignment, constraint integrity, drift, strategy stability. */
    getHealth(loopId: string): Record<string, unknown> | null;
    /** Core cycle: extract self-eval → record feedback → check stop → compile next.
     *  @param preExtractedEval Optional pre-built SelfEvaluation from MCP tool parameter.
     *    When provided (MCP path with evaluation parameter), skips regex extraction.
     *    When undefined (runtime/CLI path), falls back to regex extraction from output. */
    advance(sessionId: string, output: string, preExtractedEval?: SelfEvaluation): AdvanceResult;
    /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
    replayTimeline(sessionId: string): Record<string, unknown>[] | null;
}
//# sourceMappingURL=session.d.ts.map