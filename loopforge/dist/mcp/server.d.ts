/** Minimal MCP JSON-RPC server for LoopForge tools.
 *
 * LoopForge intentionally does not implement MCP Tasks: the external Agent
 * owns long-running execution while LoopForge persists round state.
 */
import type { VaultBackend } from "../backends/interface.js";
import type { LoopStore } from "../loop-store.js";
export declare class McpServer {
    private readonly mgr;
    private requestQueue;
    constructor(storeOrBackend?: LoopStore | VaultBackend);
    start(): void;
    private handleLine;
    private dispatch;
    private executeTool;
}
//# sourceMappingURL=server.d.ts.map