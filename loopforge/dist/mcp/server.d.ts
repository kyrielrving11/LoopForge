/** Minimal MCP JSON-RPC server for LoopForge tools.
 *
 * LoopForge intentionally does not implement MCP Tasks: the external Agent
 * owns long-running execution while LoopForge persists round state.
 */
import type { LoopStore } from "../loop-store.js";
/** v3.8: The uniform tool result envelope. A handler returns the stable code in
 *  `error` and the human sentence in `errorMessage` (absent → the code is also
 *  the message, for the errors whose code IS self-explanatory); every other
 *  result is `ok: true` with its payload unchanged. */
export declare function applyToolEnvelope(output: Record<string, unknown>): Record<string, unknown>;
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