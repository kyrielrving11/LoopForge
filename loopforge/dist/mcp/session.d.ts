/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 */
import { LoopForgeEngine } from "../engine.js";
import type { VaultBackend } from "../backends/interface.js";
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
    list(): McpSessionSummary[];
    /** Core cycle: extract self-eval → record feedback → check stop → compile next. */
    advance(sessionId: string, output: string): AdvanceResult;
    /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
    replayTimeline(sessionId: string): Record<string, unknown>[] | null;
}
//# sourceMappingURL=session.d.ts.map