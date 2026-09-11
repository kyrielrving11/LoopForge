/** Minimal MCP JSON-RPC server for LoopForge tools.
 *
 * LoopForge intentionally does not implement MCP Tasks: the external Agent
 * owns long-running execution while LoopForge persists round state.
 */

import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import type { LoopStore } from "../loop-store.js";
import { SessionManager } from "./session.js";
import {
  TOOL_HANDLERS,
  TOOL_SCHEMAS,
  ToolInputValidationError,
  validateToolDispatchInput,
  validateToolOutput,
} from "./tools.js";
import { isRecord } from "../token-utils.js";
import { getPolicy } from "../policy.js";
import { VERSION } from "../version.js";
import type { ToolErrorCode } from "../protocol.js";

const SERVER_INFO = { name: "loopforge-mcp", version: VERSION };

/** v3.8: Error codes whose fix is a corrected payload the agent may resend.
 *  Everything else is a state/transport condition. */
const RETRYABLE_ERROR_CODES = new Set<ToolErrorCode>([
  "evaluation_invalid",
  "contract_invalid",
  "policy_invalid",
  "round_id_required",
  "round_id_mismatch",
  "invalid_argument",
]);

/** v3.8: The uniform tool result envelope. A handler returns the stable code in
 *  `error` and the human sentence in `errorMessage` (absent → the code is also
 *  the message, for the errors whose code IS self-explanatory); every other
 *  result is `ok: true` with its payload unchanged. */
function applyToolEnvelope(output: Record<string, unknown>): Record<string, unknown> {
  const code = typeof output.error === "string" ? output.error as ToolErrorCode : null;
  if (code === null) return { ok: true, ...output };
  const { error: _error, errorMessage, details, sessionId, roundId, ...rest } = output;
  return {
    ok: false,
    error: {
      code,
      message: typeof errorMessage === "string" && errorMessage.length > 0 ? errorMessage : code,
      retryable: RETRYABLE_ERROR_CODES.has(code),
      ...(typeof sessionId === "string" ? { sessionId } : {}),
      ...(typeof roundId === "string" ? { roundId } : {}),
      ...(details !== undefined ? { details } : {}),
    },
    ...rest,
  };
}
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

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface McpContentItem {
  type: "text";
  text: string;
  annotations?: {
    /** 0.0–1.0, higher = more important. Default 0.5. */
    priority: number;
    /** Intended recipient: "user", "assistant", or both. */
    audience: string[];
  };
}

interface McpToolResult {
  content: McpContentItem[];
  isError?: true;
}

class JsonRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "JsonRpcError";
  }
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

  constructor(store?: LoopStore) {
    this.mgr = new SessionManager(store);
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
    this.trace("request", line);
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
      const response = okResponse(parsed.id, result);
      this.trace("response", response);
      process.stdout.write(response + "\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof JsonRpcError ? error.code : -32603;
      const response = errorResponse(parsed.id, code, message);
      this.trace("response", response);
      process.stdout.write(response + "\n");
    }
  }

  private trace(direction: "request" | "response", payload: string): void {
    const path = process.env.LOOPFORGE_MCP_TRACE;
    if (!path || !payload) return;
    try {
      appendFileSync(path, `${JSON.stringify({ direction, payload })}\n`, "utf8");
    } catch {
      // Diagnostics must never change MCP behavior.
    }
  }

  private async dispatch(req: JsonRpcRequest): Promise<Record<string, unknown>> {
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
    // v3.7.1: the two gate tools are hidden when policy.gate.enabled=false
    // (the default) — they are opt-in governance, not a stable surface.
    if (req.method === "tools/list") {
      const tools = getPolicy().gate.enabled
        ? TOOL_SCHEMAS
        : TOOL_SCHEMAS.filter(
            (tool) => tool.name !== "loopforge_gate_check" &&
              tool.name !== "loopforge_gate_resolve",
          );
      return { tools };
    }
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
      validateToolDispatchInput(name, args);
    } catch (error) {
      if (error instanceof ToolInputValidationError) {
        throw new JsonRpcError(-32602, error.message);
      }
      throw error;
    }
    const output = await handler(this.mgr, args);
    // v3.8: the uniform tool result envelope — every tool answers with
    // { ok: true, ...payload } or { ok: false, error: ToolError }. Handlers
    // keep returning their in-band error string; this boundary is the single
    // place that turns it into the wire contract.
    const wrapped = applyToolEnvelope(output);
    // v2.14: enforce the declared output contracts — a handler output that
    // violates its outputSchema is a contract bug, surfaced as a clean
    // JSON-RPC error instead of silently shipping a schema-violating result.
    try {
      validateToolOutput(name, wrapped);
    } catch (error) {
      if (error instanceof ToolInputValidationError) {
        throw new JsonRpcError(-32603, `Tool "${name}" returned schema-violating output: ${error.message}`);
      }
      throw error;
    }
    const isError = wrapped.ok === false;

    // Extract the compiled prompt (present in start/next/resume responses).
    // MCP content annotations signal priority to the host so it can
    // preserve critical assistant-facing content during compaction.
    const prompt = typeof output.prompt === "string" && output.prompt.length > 0
      ? output.prompt
      : null;

    const content: McpContentItem[] = [];

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
      const { prompt: _prompt, ...meta } = wrapped;
      content.push({
        type: "text",
        text: JSON.stringify(meta),
        annotations: { priority: 0.3, audience: ["assistant"] },
      });
    } else if (isError) {
      content.push({
        type: "text",
        text: JSON.stringify(wrapped),
        annotations: { priority: 1.0, audience: ["user", "assistant"] },
      });
    } else {
      // Non-prompt tools (status, list, replay, health, pause)
      content.push({
        type: "text",
        text: JSON.stringify(wrapped),
        annotations: { priority: 0.5, audience: ["assistant"] },
      });
    }

    // Protocol 2024-11-05 defines CallToolResult as content plus optional
    // isError. Newer structuredContent fields make strict older clients reject
    // otherwise valid success responses as an unknown result variant.
    return isError ? { content, isError: true } : { content };
  }
}
