/** LoopForge MCP — JSON-RPC transport over stdio.
 *
 * Implements the MCP protocol: initialize → tools/list → tools/call.
 * Uses node:readline for stdin, writes JSON-RPC responses to stdout.
 * All logging goes to stderr to keep stdout clean.
 */
import { createInterface } from "node:readline";
import { SessionManager } from "./session.js";
import { TOOL_SCHEMAS, TOOL_HANDLERS } from "./tools.js";
const SERVER_INFO = {
    name: "loopforge-mcp",
    version: "1.3.0",
};
function errorResponse(id, code, message) {
    return JSON.stringify({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code, message },
    });
}
function okResponse(id, result) {
    if (id === undefined)
        return ""; // notification — no response
    return JSON.stringify({ jsonrpc: "2.0", id, result });
}
// ═══════════════════════════════════════════════════════════════════════════
// Server
// ═══════════════════════════════════════════════════════════════════════════
export class McpServer {
    mgr;
    constructor(backend) {
        this.mgr = new SessionManager(backend);
    }
    start() {
        const rl = createInterface({ input: process.stdin });
        rl.on("line", (line) => {
            let req;
            try {
                req = JSON.parse(line);
            }
            catch {
                process.stderr.write(`[loopforge-mcp] bad JSON: ${line.slice(0, 80)}\n`);
                process.stdout.write(errorResponse(undefined, -32700, "Parse error") + "\n");
                return;
            }
            // Notifications (no id) — ignore
            if (req.id === undefined) {
                process.stderr.write(`[loopforge-mcp] notification: ${req.method}\n`);
                return;
            }
            try {
                const result = this.dispatch(req);
                if (result !== null) {
                    process.stdout.write(okResponse(req.id, result) + "\n");
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[loopforge-mcp] dispatch error: ${msg}\n`);
                process.stdout.write(errorResponse(req.id, -32603, msg) + "\n");
            }
        });
        process.stderr.write(`[loopforge-mcp] v${SERVER_INFO.version} started\n`);
    }
    dispatch(req) {
        switch (req.method) {
            case "initialize":
                return {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {} },
                    serverInfo: SERVER_INFO,
                };
            case "tools/list":
                return { tools: TOOL_SCHEMAS };
            case "tools/call": {
                const params = req.params ?? {};
                const name = String(params.name ?? "");
                const args = params.arguments ?? {};
                const handler = TOOL_HANDLERS[name];
                if (!handler) {
                    throw new Error(`Unknown tool: ${name}`);
                }
                const output = handler(this.mgr, args);
                return {
                    content: [{ type: "text", text: JSON.stringify(output) }],
                };
            }
            default:
                throw new Error(`Unknown method: ${req.method}`);
        }
    }
}
//# sourceMappingURL=server.js.map