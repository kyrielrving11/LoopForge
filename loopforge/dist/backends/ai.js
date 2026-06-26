/** LoopForge — Anthropic API backend (v1.1).
 *
 *  Calls Claude API via Node.js built-in fetch. Zero additional dependencies.
 *  Uses ANTHROPIC_API_KEY from environment. Falls back gracefully on failure.
 */
// ═══════════════════════════════════════════════════════════════════════════
// API call
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
/** Call Claude with a single user message. Returns the text response. */
export async function callClaude(prompt, config = {}) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    const model = config.model ?? process.env.LOOPFORGE_MODEL ?? "claude-sonnet-4-6";
    const maxTokens = config.maxTokens ?? 8192;
    const baseUrl = config.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL;
    const timeoutMs = config.timeoutMs ?? 300_000;
    if (!apiKey) {
        return {
            text: null,
            ok: false,
            error: "ANTHROPIC_API_KEY not set. Export it or pass apiKey in config.",
            model,
        };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(`${baseUrl}/messages`, {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                messages: [{ role: "user", content: prompt }],
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            return {
                text: null,
                ok: false,
                error: `API returned ${resp.status}: ${body.slice(0, 300)}`,
                model,
            };
        }
        const data = (await resp.json());
        const content = data.content;
        if (!Array.isArray(content) || content.length === 0) {
            return {
                text: null, ok: false,
                error: `Unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`,
                model,
            };
        }
        const first = content[0];
        const text = String(first.text ?? "");
        if (!text) {
            return {
                text: null, ok: false,
                error: "Empty response text from model.",
                model,
            };
        }
        return { text, ok: true, error: null, model };
    }
    catch (err) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === "AbortError") {
            return { text: null, ok: false, error: `Request timed out after ${timeoutMs}ms`, model };
        }
        return {
            text: null, ok: false,
            error: `Fetch error: ${err instanceof Error ? err.message : String(err)}`,
            model,
        };
    }
}
/** Create an AgentExecutor backed by Claude API.
 *  Usage:
 *    const executor = createClaudeExecutor({ apiKey: "sk-ant-..." });
 *    const result = await runAutonomousLoop(engine, config, executor);
 */
export function createClaudeExecutor(aiConfig = {}) {
    return async (prompt, _round) => {
        const result = await callClaude(prompt, aiConfig);
        if (!result.ok || result.text === null) {
            throw new Error(`Claude API error (round ${_round}): ${result.error}`);
        }
        return result.text;
    };
}
//# sourceMappingURL=ai.js.map