#!/usr/bin/env node
/** LoopForge MCP server — entry point.
 *
 * Usage:
 *   npx loopforge-mcp
 *   node dist/mcp-server.js
 *
 * Registers with Claude Code via:
 *   claude mcp add loopforge -- npx loopforge-mcp
 */
import { McpServer } from "./mcp/server.js";
const server = new McpServer();
server.start();
//# sourceMappingURL=mcp-server.js.map