/** LoopForge MCP — JSON-RPC transport over stdio.
 *
 * Implements the MCP protocol: initialize → tools/list → tools/call.
 * Uses node:readline for stdin, writes JSON-RPC responses to stdout.
 * All logging goes to stderr to keep stdout clean.
 */
import type { VaultBackend } from "../backends/interface.js";
export declare class McpServer {
    private mgr;
    constructor(backend?: VaultBackend);
    start(): void;
    private dispatch;
}
//# sourceMappingURL=server.d.ts.map