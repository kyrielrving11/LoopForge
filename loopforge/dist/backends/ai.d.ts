/** LoopForge — Anthropic API backend (v1.1).
 *
 *  Calls Claude API via Node.js built-in fetch. Zero additional dependencies.
 *  Uses ANTHROPIC_API_KEY from environment. Falls back gracefully on failure.
 */
export interface AiConfig {
    /** Anthropic API key. Default: process.env.ANTHROPIC_API_KEY */
    apiKey?: string;
    /** Model ID. Default: claude-sonnet-4-6 */
    model?: string;
    /** Max output tokens. Default: 8192 */
    maxTokens?: number;
    /** Base URL override (for proxies / alternative endpoints). */
    baseUrl?: string;
    /** Timeout in ms. Default: 300_000 (5 min). */
    timeoutMs?: number;
}
export interface AiResult {
    /** The model's text response, or null on failure. */
    text: string | null;
    /** True if the API call succeeded. */
    ok: boolean;
    /** Error message if !ok. */
    error: string | null;
    /** Model used. */
    model: string;
}
/** Call Claude with a single user message. Returns the text response. */
export declare function callClaude(prompt: string, config?: AiConfig): Promise<AiResult>;
import type { AgentExecutor } from "../autonomous.js";
/** Create an AgentExecutor backed by Claude API.
 *  Usage:
 *    const executor = createClaudeExecutor({ apiKey: "sk-ant-..." });
 *    const result = await runAutonomousLoop(engine, config, executor);
 */
export declare function createClaudeExecutor(aiConfig?: AiConfig): AgentExecutor;
//# sourceMappingURL=ai.d.ts.map