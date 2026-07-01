/** LoopForge — Memory Bridge (v1.8).
 *
 *  Zero-config auto-detection bridge between LoopForge and claude-mem.
 *  Detects claude-mem via the local filesystem, provides memoryProvider
 *  (file-based retrieval) and memoryWriter (Markdown file writeback).
 *
 *  Two integration paths:
 *    MCP:  autoConfigureMemory(sessionMgr) — sets provider/writer on SessionManager
 *    Lib:  tryAutoConfigure() → { memoryProvider?, memoryWriter? } — for resolveConfig()
 *
 *  If claude-mem is not installed or the project has no memory directory,
 *  both functions return without side effects — silent graceful degradation.
 */
import type { MemoryProviderContext, LoopMemoryWriteback } from "./protocol.js";
import type { SessionManager } from "./mcp/session.js";
/** Compute the project directory name the same way claude-mem does:
 *  replace every non-alphanumeric character with `-`.
 *  e.g. `C:\Users\Dell\Desktop\LoopForge` → `C--Users-Dell-Desktop-LoopForge` */
export declare function computeProjectHash(gitRoot: string): string;
/** Walk upward from cwd looking for a `.git` directory.
 *  Returns the git root path, or null if not found within 20 levels. */
export declare function findGitRoot(): string | null;
/** Check whether claude-mem has a memory directory for the current project.
 *  Returns the memory directory path and MEMORY.md path, or null. */
export declare function detectClaudeMem(): {
    memoryDir: string;
    indexPath: string;
} | null;
/** Create a memoryProvider callback bound to a specific memory directory.
 *  Reads .md files directly — no REST API dependency. */
export declare function createMemoryProvider(memoryDir: string): (ctx: MemoryProviderContext) => Promise<string>;
/** Create a memoryWriter callback bound to a specific memory directory.
 *  Writes .md files directly + appends to MEMORY.md index. */
export declare function createMemoryWriter(memoryDir: string, indexPath: string): (payload: LoopMemoryWriteback) => Promise<void>;
/** Auto-detect claude-mem and wire memoryProvider / memoryWriter onto a
 *  SessionManager instance. Called once at MCP server startup.
 *  If claude-mem is not available, this is a no-op. */
export declare function autoConfigureMemory(mgr: SessionManager): void;
/** Auto-detect claude-mem and return provider/writer callbacks.
 *  Used by the runtime library path (resolveConfig). Callers should
 *  only invoke this when the user has NOT provided explicit callbacks —
 *  explicit callbacks always take precedence. */
export declare function tryAutoConfigure(): {
    memoryProvider?: (ctx: MemoryProviderContext) => Promise<string>;
    memoryWriter?: (payload: LoopMemoryWriteback) => Promise<void>;
};
//# sourceMappingURL=memory-bridge.d.ts.map