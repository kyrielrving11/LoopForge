/** LoopForge MCP — Tool definitions and handlers.
 *
 * 10 tools: start, next, status, stop, pause, resume, replay,
 *           checkpoint, gate_check, gate_resolve.
 * status is the unified inspection tool (view=session|loop|all|audit|explain).
 * Each handler receives SessionManager + parsed input, returns the output object.
 */
import type { SessionManager } from "./session.js";
/** The closed argument set for `loopforge_start`.
 *
 *  The handler's unknown-argument guard reads this list; `schema-sync.test`
 *  asserts that the advertised tool schema exposes exactly the same keys. A
 *  field removed from the protocol (for example `domain` in 4.0.1) must not
 *  survive in only one of them: the schema says what clients may send, and
 *  the guard makes a stale caller fail loudly instead of silently dropping
 *  the field. */
export declare const START_INPUT_KEYS: readonly ["task", "loopId", "maxRounds", "planSource", "constraints", "criteria"];
type JsonSchema = Record<string, unknown>;
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