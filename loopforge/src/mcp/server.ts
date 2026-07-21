/** Minimal MCP JSON-RPC server for LoopForge tools.
 *
 * LoopForge intentionally does not implement MCP Tasks: the external Agent
 * owns long-running execution while LoopForge persists round state.
 */

import { createInterface } from "node:readline";
import type { VaultBackend } from "../backends/interface.js";
import type { LoopStore } from "../loop-store.js";
import { SessionManager } from "./session.js";
import {
  TOOL_HANDLERS,
  TOOL_SCHEMAS,
  ToolInputValidationError,
  validateToolInput,
} from "./tools.js";

const SERVER_INFO = { name: "loopforge-mcp", version: "2.0.1" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

class JsonRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "JsonRpcError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value)) return false;
  if (value.jsonrpc !== "2.0" || typeof value.method !== "string") return false;
  if (
    "id" in value && value.id !== undefined &&
    typeof value.id !== "string" && typeof value.id !== "number"
  ) return false;
  return !("params" in value && value.params !== undefined && !isRecord(value.params));
}

function errorResponse(
  id: number | string | undefined,
  code: number,
  message: string,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function okResponse(
  id: number | string | undefined,
  result: Record<string, unknown>,
): string {
  return id === undefined ? "" : JSON.stringify({ jsonrpc: "2.0", id, result });
}

export class McpServer {
  private readonly mgr: SessionManager;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(storeOrBackend?: LoopStore | VaultBackend) {
    this.mgr = new SessionManager(storeOrBackend);
  }

  start(): void {
    const resumed = this.mgr.autoResumeAll();
    if (resumed > 0) {
      process.stderr.write(`[loopforge-mcp] auto-resumed ${resumed} session(s)\n`);
    }
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line: string) => {
      this.requestQueue = this.requestQueue
        .then(() => this.handleLine(line))
        .catch((error) => {
          process.stderr.write(`[loopforge-mcp] request error: ${String(error)}\n`);
        });
    });
    rl.once("close", () => this.mgr.close());
    process.stderr.write(`[loopforge-mcp] v${SERVER_INFO.version} started\n`);
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stdout.write(errorResponse(undefined, -32700, "Parse error") + "\n");
      return;
    }
    if (!isJsonRpcRequest(parsed)) {
      process.stdout.write(errorResponse(undefined, -32600, "Invalid Request") + "\n");
      return;
    }
    if (parsed.id === undefined) return;
    try {
      const result = await this.dispatch(parsed);
      process.stdout.write(okResponse(parsed.id, result) + "\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof JsonRpcError ? error.code : -32603;
      process.stdout.write(errorResponse(parsed.id, code, message) + "\n");
    }
  }

  private async dispatch(req: JsonRpcRequest): Promise<Record<string, unknown>> {
    if (req.method === "initialize") {
      const requested = req.params?.protocolVersion;
      return {
        protocolVersion: requested === "2024-11-05" ? requested : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    if (req.method === "tools/list") return { tools: TOOL_SCHEMAS };
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
      throw new JsonRpcError(
        -32602,
        "LoopForge tools do not support MCP Tasks; let the Agent drive the loop",
      );
    }
    return this.executeTool(
      params.name,
      (params.arguments as Record<string, unknown> | undefined) ?? {},
    ) as unknown as Record<string, unknown>;
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const handler = TOOL_HANDLERS[name];
    if (!handler) throw new JsonRpcError(-32602, `Unknown tool: ${name}`);
    try {
      validateToolInput(name, args);
    } catch (error) {
      if (error instanceof ToolInputValidationError) {
        throw new JsonRpcError(-32602, error.message);
      }
      throw error;
    }
    const output = await handler(this.mgr, args);
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
      isError: typeof output.error === "string",
    };
  }
}
