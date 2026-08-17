/** Minimal MCP JSON-RPC server for LoopForge tools.
 *
 * LoopForge intentionally does not implement MCP Tasks: the external Agent
 * owns long-running execution while LoopForge persists round state.
 */
import { createInterface } from "node:readline";
import { SessionManager } from "./session.js";
import { TOOL_HANDLERS, TOOL_SCHEMAS, ToolInputValidationError, validateToolInput, } from "./tools.js";
import { isRecord } from "../token-utils.js";
import { LOOPFORGE_VERSION } from "../version.js";
import { WorkspaceRuntime } from "../workspace-runtime.js";
const SERVER_INFO = { name: "loopforge-mcp", version: LOOPFORGE_VERSION };
const SERVER_INSTRUCTIONS = "Start with loopforge_start(workspaceRoot) or recover with loopforge_resume(loopId, workspaceRoot), then verify capabilityPreflight. Follow requiredAction through plan, approval, one active step, and final audit. Submit execution with the exact roundId plus compact report; only terminal=true ends the task. LoopForge governs state and evidence while the external Agent performs repository work.";
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
    constructor(storeOrBackend, runtime) {
        this.mgr = new SessionManager(storeOrBackend, undefined, runtime ?? (storeOrBackend ? undefined : new WorkspaceRuntime()));
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
            process.stdout.write(okResponse(parsed.id, result) + "\n");
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const code = error instanceof JsonRpcError ? error.code : -32603;
            process.stdout.write(errorResponse(parsed.id, code, message) + "\n");
        }
    }
    async dispatch(req) {
        if (req.method === "initialize") {
            const requested = req.params?.protocolVersion;
            return {
                protocolVersion: requested === "2024-11-05" ? requested : "2025-11-25",
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
            validateToolInput(name, args);
        }
        catch (error) {
            if (error instanceof ToolInputValidationError) {
                throw new JsonRpcError(-32602, error.message);
            }
            throw error;
        }
        if (this.mgr.runtime && !this.mgr.runtime.isBound && !["loopforge_start", "loopforge_resume", "loopforge_list"].includes(name)) {
            const output = { error: "workspace_not_bound", runtime: this.mgr.getRuntimeSummary() };
            return { content: [{ type: "text", text: JSON.stringify(output), annotations: { priority: 1.0, audience: ["user", "assistant"] } }], structuredContent: output, isError: true };
        }
        let output;
        try {
            output = await handler(this.mgr, args);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            let detail = { error: message };
            try {
                const parsed = JSON.parse(message);
                if (isRecord(parsed))
                    detail = { ...parsed, error: parsed.error ?? parsed.code ?? "runtime_error" };
            }
            catch { /* ordinary Error */ }
            detail.runtime ??= this.mgr.getRuntimeSummary();
            return { content: [{ type: "text", text: JSON.stringify(detail), annotations: { priority: 1.0, audience: ["user", "assistant"] } }], structuredContent: detail, isError: true };
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
        return { content, structuredContent: output, isError };
    }
}
//# sourceMappingURL=server.js.map