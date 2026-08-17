/** LoopForge MCP — Tool definitions and handlers.
 *
 * 12 tools: planning, execution, control, and audit surfaces.
 * Each handler receives SessionManager + parsed input, returns the output object.
 */
import type { SessionManager } from "./session.js";
type JsonSchema = Record<string, unknown>;
/** MCP tool contracts include strict input and structured output schemas. */
export declare const TOOL_SCHEMAS: ({
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
} | {
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        idempotentHint: boolean;
        openWorldHint: boolean;
    };
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
    name: string;
    description: string;
})[];
export declare class ToolInputValidationError extends Error {
    constructor(message: string);
}
export declare function validateToolInput(name: string, input: Record<string, unknown>): void;
export type ToolHandler = (mgr: SessionManager, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export declare const TOOL_HANDLERS: Record<string, ToolHandler>;
export {};
//# sourceMappingURL=tools.d.ts.map