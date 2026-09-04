/** Minimal MCP JSON-RPC server for LoopForge tools.
 *
 * LoopForge intentionally does not implement MCP Tasks: the external Agent
 * owns long-running execution while LoopForge persists round state.
 */
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { SessionManager } from "./session.js";
import { TOOL_HANDLERS, TOOL_SCHEMAS, ToolInputValidationError, validateToolDispatchInput, validateToolOutput, } from "./tools.js";
import { isRecord } from "../token-utils.js";
const SERVER_INFO = { name: "loopforge-mcp", version: "3.6.0" };
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INSTRUCTIONS = [
    "Use LoopForge directly for long-running work. Start by calling loopforge_status ",
    "with view=all to list loops, then loopforge_status for a matching session or ",
    "loopforge_start for a new one. ",
    "Before each agent-process boundary, call loopforge_next with the roundId from ",
    "the most recent response, honest evidence, remaining criteria, and a concrete ",
    "next action. Follow reject or backtrack prompts and retry loopforge_next. ",
    "Keep one LoopForge session across outer agent rounds. ",
    "Do not replace these MCP calls with shell or CLI wrappers.",
].join("");
class JsonRpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "JsonRpcError";
    }
}
function isJsonRpcRequest(value) {
    if (!isRecord(value))
        return false;
    if (value.jsonrpc !== "2.0" || typeof value.method !== "string")
        return false;
    if ("id" in value && value.id !== undefined &&
        typeof value.id !== "string" && typeof value.id !== "number")
        return false;
    return !("params" in value && value.params !== undefined && !isRecord(value.params));
}
function errorResponse(id, code, message) {
    return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}
function okResponse(id, result) {
    return id === undefined ? "" : JSON.stringify({ jsonrpc: "2.0", id, result });
}
export class McpServer {
    mgr;
    requestQueue = Promise.resolve();
    constructor(store) {
        this.mgr = new SessionManager(store);
    }
    start() {
        const resumed = this.mgr.autoResumeAll();
        if (resumed > 0) {
            process.stderr.write(`[loopforge-mcp] auto-resumed ${resumed} session(s)\n`);
        }
        const rl = createInterface({ input: process.stdin });
        rl.on("line", (line) => {
            this.requestQueue = this.requestQueue
                .then(() => this.handleLine(line))
                .catch((error) => {
                process.stderr.write(`[loopforge-mcp] request error: ${String(error)}\n`);
            });
        });
        rl.once("close", () => this.mgr.close());
        process.stderr.write(`[loopforge-mcp] v${SERVER_INFO.version} started\n`);
    }
    async handleLine(line) {
        this.trace("request", line);
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            process.stdout.write(errorResponse(undefined, -32700, "Parse error") + "\n");
            return;
        }
        if (!isJsonRpcRequest(parsed)) {
            process.stdout.write(errorResponse(undefined, -32600, "Invalid Request") + "\n");
            return;
        }
        if (parsed.id === undefined)
            return;
        try {
            const result = await this.dispatch(parsed);
            const response = okResponse(parsed.id, result);
            this.trace("response", response);
            process.stdout.write(response + "\n");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = error instanceof JsonRpcError ? error.code : -32603;
            const response = errorResponse(parsed.id, code, message);
            this.trace("response", response);
            process.stdout.write(response + "\n");
        }
    }
    trace(direction, payload) {
        const path = process.env.LOOPFORGE_MCP_TRACE;
        if (!path || !payload)
            return;
        try {
            appendFileSync(path, `${JSON.stringify({ direction, payload })}\n`, "utf8");
        }
        catch {
            // Diagnostics must never change MCP behavior.
        }
    }
    async dispatch(req) {
        if (req.method === "initialize") {
            const requestedVersion = typeof req.params?.protocolVersion === "string"
                ? req.params.protocolVersion
                : "";
            const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
                ? requestedVersion
                : LATEST_PROTOCOL_VERSION;
            return {
                // Negotiate the client's synchronous MCP revision. LoopForge does not
                // advertise Tasks, so newer task-capable revisions remain unsupported.
                protocolVersion,
                capabilities: { tools: {} },
                serverInfo: SERVER_INFO,
                instructions: SERVER_INSTRUCTIONS,
            };
        }
        if (req.method === "tools/list")
            return { tools: TOOL_SCHEMAS };
        if (req.method !== "tools/call") {
            throw new JsonRpcError(-32601, `Unknown method: ${req.method}`);
        }
        const params = req.params ?? {};
        if (typeof params.name !== "string" || !params.name) {
            throw new JsonRpcError(-32602, "tools/call requires a tool name");
        }
        if (params.arguments !== undefined && !isRecord(params.arguments)) {
            throw new JsonRpcError(-32602, "tools/call arguments must be an object");
        }
        if ("task" in params) {
            throw new JsonRpcError(-32602, "LoopForge tools do not support MCP Tasks; let the Agent drive the loop");
        }
        return this.executeTool(params.name, params.arguments ?? {});
    }
    async executeTool(name, args) {
        const handler = TOOL_HANDLERS[name];
        if (!handler)
            throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
        try {
            validateToolDispatchInput(name, args);
        }
        catch (error) {
            if (error instanceof ToolInputValidationError) {
                throw new JsonRpcError(-32602, error.message);
            }
            throw error;
        }
        const output = await handler(this.mgr, args);
        // v2.14: enforce the declared output contracts — a handler output that
        // violates its outputSchema is a contract bug, surfaced as a clean
        // JSON-RPC error instead of silently shipping a schema-violating result.
        try {
            validateToolOutput(name, output);
        }
        catch (error) {
            if (error instanceof ToolInputValidationError) {
                throw new JsonRpcError(-32603, `Tool "${name}" returned schema-violating output: ${error.message}`);
            }
            throw error;
        }
        const isError = typeof output.error === "string";
        // Extract the compiled prompt (present in start/next/resume responses).
        // MCP content annotations signal priority to the host so it can
        // preserve critical assistant-facing content during compaction.
        const prompt = typeof output.prompt === "string" && output.prompt.length > 0
            ? output.prompt
            : null;
        const content = [];
        if (prompt) {
            // Primary: the actionable prompt as raw text — no JSON wrapper so
            // the model reads the instructions immediately.
            content.push({
                type: "text",
                text: prompt,
                annotations: { priority: 1.0, audience: ["assistant"] },
            });
            // Secondary: structured metadata (sessionId, round, level, warnings,
            // enforcementAction, etc.) without the prompt.
            const { prompt: _prompt, ...meta } = output;
            content.push({
                type: "text",
                text: JSON.stringify(meta),
                annotations: { priority: 0.3, audience: ["assistant"] },
            });
        }
        else if (isError) {
            content.push({
                type: "text",
                text: JSON.stringify(output),
                annotations: { priority: 1.0, audience: ["user", "assistant"] },
            });
        }
        else {
            // Non-prompt tools (status, list, replay, health, pause)
            content.push({
                type: "text",
                text: JSON.stringify(output),
                annotations: { priority: 0.5, audience: ["assistant"] },
            });
        }
        // Protocol 2024-11-05 defines CallToolResult as content plus optional
        // isError. Newer structuredContent fields make strict older clients reject
        // otherwise valid success responses as an unknown result variant.
        return isError ? { content, isError: true } : { content };
    }
}
//# sourceMappingURL=server.js.map