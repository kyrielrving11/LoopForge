/** LoopForge MCP — Tool definitions and handlers.
 *
 * 6 tools: start, next, status, stop, list, replay.
 * Each handler receives SessionManager + parsed input, returns the output object.
 */
import type { SessionManager } from "./session.js";
export declare const TOOL_SCHEMAS: ({
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task: {
                type: "string";
                description: string;
            };
            loopId: {
                type: "string";
                description: string;
            };
            maxRounds: {
                type: "number";
                description: string;
            };
            domain: {
                type: "string";
                description: string;
            };
            planSource: {
                type: "string";
                description: string;
            };
            constraints: {
                type: "array";
                items: {
                    type: "string";
                };
                description: string;
            };
            sessionId?: undefined;
            output?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            sessionId: {
                type: "string";
                description: string;
            };
            output: {
                type: "string";
                description: string;
            };
            task?: undefined;
            loopId?: undefined;
            maxRounds?: undefined;
            domain?: undefined;
            planSource?: undefined;
            constraints?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            sessionId: {
                type: "string";
                description: string;
            };
            task?: undefined;
            loopId?: undefined;
            maxRounds?: undefined;
            domain?: undefined;
            planSource?: undefined;
            constraints?: undefined;
            output?: undefined;
        };
        required: string[];
    };
} | {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task?: undefined;
            loopId?: undefined;
            maxRounds?: undefined;
            domain?: undefined;
            planSource?: undefined;
            constraints?: undefined;
            sessionId?: undefined;
            output?: undefined;
        };
        required: never[];
    };
})[];
export type ToolHandler = (mgr: SessionManager, input: Record<string, unknown>) => Record<string, unknown>;
export declare const TOOL_HANDLERS: Record<string, ToolHandler>;
//# sourceMappingURL=tools.d.ts.map