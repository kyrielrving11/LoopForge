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
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, appendFileSync, rmSync, } from "node:fs";
// ═══════════════════════════════════════════════════════════════════════════
// Detection
// ═══════════════════════════════════════════════════════════════════════════
/** Compute the project directory name the same way claude-mem does:
 *  replace every non-alphanumeric character with `-`.
 *  e.g. `C:\Users\Dell\Desktop\LoopForge` → `C--Users-Dell-Desktop-LoopForge` */
export function computeProjectHash(gitRoot) {
    return gitRoot.replace(/[^a-zA-Z0-9]/g, "-");
}
/** Walk upward from cwd looking for a `.git` directory.
 *  Returns the git root path, or null if not found within 20 levels. */
export function findGitRoot() {
    let dir = process.cwd();
    for (let i = 0; i < 20; i++) {
        if (existsSync(join(dir, ".git")))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return null;
}
/** Check whether claude-mem has a memory directory for the current project.
 *  Returns the memory directory path and MEMORY.md path, or null. */
export function detectClaudeMem() {
    const gitRoot = findGitRoot();
    if (!gitRoot)
        return null;
    const hash = computeProjectHash(gitRoot);
    const memoryDir = join(homedir(), ".claude", "projects", hash, "memory");
    const indexPath = join(memoryDir, "MEMORY.md");
    if (!existsSync(memoryDir) || !existsSync(indexPath))
        return null;
    return { memoryDir, indexPath };
}
// ═══════════════════════════════════════════════════════════════════════════
// Retrieval
// ═══════════════════════════════════════════════════════════════════════════
/** Split text into lowercase words ≥4 chars for keyword matching. */
function keywords(text) {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4);
}
/** Build a phase-aware set of query terms from the provider context.
 *  Phase 1: task terms only (initial anchoring).
 *  Phase 2: task + recurring issues + failed patterns (mid-loop breakout).
 *  Phase 3: task + remaining criteria + key lessons (late-stage edge cases). */
function buildQueryTerms(ctx) {
    const terms = new Set();
    for (const w of keywords(ctx.task))
        terms.add(w);
    if (ctx.domain)
        for (const w of keywords(ctx.domain))
            terms.add(w);
    if (ctx.phase === 2) {
        for (const issue of ctx.accumulatedContext.recurringIssues) {
            for (const w of keywords(issue))
                terms.add(w);
        }
        for (const pat of ctx.accumulatedContext.failedPatterns) {
            for (const w of keywords(pat))
                terms.add(w);
        }
    }
    else if (ctx.phase === 3) {
        for (const crit of ctx.accumulatedContext.remainingCriteria) {
            for (const w of keywords(crit))
                terms.add(w);
        }
        for (const lesson of ctx.accumulatedContext.keyLessons) {
            for (const w of keywords(lesson))
                terms.add(w);
        }
    }
    return [...terms];
}
/** Strip YAML frontmatter (--- ... ---) from a markdown file and return the body. */
function stripFrontmatter(md) {
    const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    if (!match)
        return md;
    return md.slice(match[0].length).trim();
}
/** Scan all .md memory files (excluding MEMORY.md) and return the top-N
 *  most relevant memories concatenated, scored by keyword overlap. */
function retrieveFromFiles(memoryDir, queryTerms, maxFiles, maxCharsPerFile) {
    let files;
    try {
        files = readdirSync(memoryDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    }
    catch {
        return "";
    }
    if (files.length === 0 || queryTerms.length === 0)
        return "";
    const scored = [];
    for (const file of files) {
        let content;
        try {
            content = readFileSync(join(memoryDir, file), "utf-8");
        }
        catch {
            continue;
        }
        const lower = content.toLowerCase();
        let score = 0;
        for (const term of queryTerms) {
            if (lower.includes(term))
                score++;
        }
        if (score > 0) {
            scored.push({ body: stripFrontmatter(content), score });
        }
    }
    if (scored.length === 0)
        return "";
    scored.sort((a, b) => b.score - a.score);
    return scored
        .slice(0, maxFiles)
        .map((s) => s.body.slice(0, maxCharsPerFile))
        .join("\n\n---\n\n");
}
/** Create a memoryProvider callback bound to a specific memory directory.
 *  Reads .md files directly — no REST API dependency. */
export function createMemoryProvider(memoryDir) {
    return async (ctx) => {
        const queryTerms = buildQueryTerms(ctx);
        return retrieveFromFiles(memoryDir, queryTerms, 3, 600);
    };
}
// ═══════════════════════════════════════════════════════════════════════════
// Writeback
// ═══════════════════════════════════════════════════════════════════════════
const LOCK_RETRY_MS = 50;
/** Minimal mkdir-based mutex for safguarding MEMORY.md writes.
 *  Non-blocking: returns true if lock was acquired, false if held by another process. */
function acquireLock(lockDir) {
    try {
        mkdirSync(lockDir);
        return true;
    }
    catch {
        return false;
    }
}
function releaseLock(lockDir) {
    try {
        rmSync(lockDir, { recursive: true });
    }
    catch {
        // lock dir already removed — ignore
    }
}
/** Write a single .md memory file with claude-mem-compatible YAML frontmatter. */
function writeMemoryFile(memoryDir, name, description, memType, body) {
    const filename = `${name}.md`;
    const frontmatter = [
        "---",
        `name: ${name}`,
        `description: ${description.slice(0, 100)}`,
        "metadata:",
        `  type: ${memType}`,
        "---",
        "",
    ].join("\n");
    writeFileSync(join(memoryDir, filename), frontmatter + body, "utf-8");
    return filename;
}
/** Create a memoryWriter callback bound to a specific memory directory.
 *  Writes .md files directly + appends to MEMORY.md index. */
export function createMemoryWriter(memoryDir, indexPath) {
    return async (payload) => {
        const lockDir = join(memoryDir, ".loopforge-wb.lock");
        // Non-blocking lock acquire — skip if claude-mem is writing concurrently
        for (let attempt = 0; attempt < 3; attempt++) {
            if (acquireLock(lockDir))
                break;
            if (attempt === 2)
                return; // could not acquire after 3 attempts — skip
            await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
        }
        try {
            const date = new Date().toISOString().split("T")[0];
            const indexLines = [];
            // 1. Project entry
            const projectName = `loopforge-${payload.loopId}-outcome`;
            const projectBody = [
                `# ${payload.projectEntry.title}`,
                "",
                `**Outcome**: ${payload.projectEntry.keyOutcome}`,
                `**Date**: ${date}`,
                `**Rounds**: ${payload.roundsCompleted}`,
                `**Rounds Completed**: ${payload.roundsCompleted}`,
                "",
                payload.projectEntry.objective
                    ? `**Objective**: ${payload.projectEntry.objective}\n`
                    : "",
                payload.projectEntry.keyDiscoveries.length > 0
                    ? [
                        "**Key Discoveries**:",
                        ...payload.projectEntry.keyDiscoveries.map((d) => `- ${d}`),
                        "",
                    ].join("\n")
                    : "",
            ]
                .filter(Boolean)
                .join("\n");
            const projectFile = writeMemoryFile(memoryDir, projectName, payload.projectEntry.title.slice(0, 100), "project", projectBody);
            indexLines.push(`- [LoopForge: ${payload.task.slice(0, 60)}](${projectFile}) — ${payload.outcome} (${date})`);
            // 2. Feedback entries
            for (let i = 0; i < payload.feedbackEntries.length; i++) {
                const fb = payload.feedbackEntries[i];
                const fbName = `loopforge-${payload.loopId}-fb-${i + 1}`;
                const fbBody = [
                    `# ${fb.rule}`,
                    "",
                    `**Why:** ${fb.why}`,
                    "",
                    `**How to apply:** ${fb.howToApply}`,
                    "",
                ].join("\n");
                const fbFile = writeMemoryFile(memoryDir, fbName, fb.rule.slice(0, 100), "feedback", fbBody);
                indexLines.push(`- [LoopForge Feedback](${fbFile}) — ${payload.outcome} (${date})`);
            }
            // 3. Reference entry
            if (payload.referenceEntry) {
                const refName = `loopforge-${payload.loopId}-ref`;
                const refBody = [
                    `# ${payload.referenceEntry.description}`,
                    "",
                    `**Vault Location**: ${payload.referenceEntry.vaultLocation}`,
                    "",
                ].join("\n");
                const refFile = writeMemoryFile(memoryDir, refName, payload.referenceEntry.description.slice(0, 100), "reference", refBody);
                indexLines.push(`- [LoopForge Reference](${refFile}) — ${payload.outcome} (${date})`);
            }
            // 4. Append to MEMORY.md index
            appendFileSync(indexPath, indexLines.join("\n") + "\n", "utf-8");
        }
        finally {
            releaseLock(lockDir);
        }
    };
}
// ═══════════════════════════════════════════════════════════════════════════
// Integration entry points
// ═══════════════════════════════════════════════════════════════════════════
/** Auto-detect claude-mem and wire memoryProvider / memoryWriter onto a
 *  SessionManager instance. Called once at MCP server startup.
 *  If claude-mem is not available, this is a no-op. */
export function autoConfigureMemory(mgr) {
    const detected = detectClaudeMem();
    if (!detected)
        return;
    mgr.memoryProvider = createMemoryProvider(detected.memoryDir);
    mgr.memoryWriter = createMemoryWriter(detected.memoryDir, detected.indexPath);
}
/** Auto-detect claude-mem and return provider/writer callbacks.
 *  Used by the runtime library path (resolveConfig). Callers should
 *  only invoke this when the user has NOT provided explicit callbacks —
 *  explicit callbacks always take precedence. */
export function tryAutoConfigure() {
    const detected = detectClaudeMem();
    if (!detected)
        return {};
    return {
        memoryProvider: createMemoryProvider(detected.memoryDir),
        memoryWriter: createMemoryWriter(detected.memoryDir, detected.indexPath),
    };
}
//# sourceMappingURL=memory-bridge.js.map