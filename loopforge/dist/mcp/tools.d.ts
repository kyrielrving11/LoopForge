/** LoopForge MCP — Tool definitions and handlers.
 *
 * 9 tools: start, next, status, stop, pause, resume, replay,
 *          gate_check, gate_resolve.
 * status is the unified inspection tool (view=session|loop|all|audit).
 * Each handler receives SessionManager + parsed input, returns the output object.
 */
import type { SessionManager } from "./session.js";
type JsonSchema = Record<string, unknown>;
/** Declared structured-output contracts for every tool. The MCP server
 *  validates each handler's output against these before returning it —
 *  a mismatch is a contract bug, surfaced as a JSON-RPC error instead of
 *  silently shipping an output that violates the declared schema. */
export declare const TOOL_OUTPUT_SCHEMAS: Record<string, JsonSchema>;
/** MCP tool contracts include strict input and structured output schemas. */
export declare const TOOL_SCHEMAS: ({
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
})[];
export declare class ToolInputValidationError extends Error {
    constructor(message: string);
}
export declare function validateToolInput(name: string, input: Record<string, unknown>): void;
/** Validate a server dispatch without turning a malformed evaluation into a
 * JSON-RPC transport error. The advertised schema stays strict so clients can
 * construct valid calls; the runtime envelope validates every outer argument,
 * then lets loopforge_next return its retryable evaluation_invalid payload for
 * core evaluation mistakes. Once the core is valid, the full schema still
 * rejects unknown fields and other contract violations. */
export declare function validateToolDispatchInput(name: string, input: Record<string, unknown>): void;
/** Validate a handler's output against the tool's declared output schema.
 *  v2.14: the schemas were advertised in tools/list but never enforced —
 *  a mismatched output silently violated the declared contract. Throws
 *  ToolInputValidationError on mismatch. */
export declare function validateToolOutput(name: string, output: Record<string, unknown>): void;
export type ToolHandler = (mgr: SessionManager, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export declare const TOOL_HANDLERS: Record<string, ToolHandler>;
export {};
//# sourceMappingURL=tools.d.ts.map