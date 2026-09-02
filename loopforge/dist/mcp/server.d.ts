/** Minimal MCP JSON-RPC server for LoopForge tools.
 *
 * LoopForge intentionally does not implement MCP Tasks: the external Agent
 * owns long-running execution while LoopForge persists round state.
 */
import type { LoopStore } from "../loop-store.js";
export declare const SERVER_INSTRUCTIONS: string;
export declare class McpServer {
    private readonly mgr;
    private requestQueue;
    constructor(store?: LoopStore);
    start(): void;
    private handleLine;
    private trace;
    private dispatch;
    private executeTool;
}
//# sourceMappingURL=server.d.ts.map