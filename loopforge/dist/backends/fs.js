/** FSBackend — filesystem implementation of VaultBackend.
 *
 * Wraps Node.js fs for JSON vault read/write and Markdown lineage I/O.
 * All file I/O is contained in this single module — engine.ts never
 * touches the filesystem directly.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
// ═══════════════════════════════════════════════════════════════════════════
// YAML frontmatter helpers (lightweight, no dependency)
// ═══════════════════════════════════════════════════════════════════════════
const FRONTMATTER_DELIM = "---";
function escapeYamlString(value) {
    if (/[":{}[\],&\*\#\?\-<>=!%@`]/.test(value) || value.includes("\n")) {
        return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
}
function buildYamlFrontmatter(metadata) {
    const lines = [FRONTMATTER_DELIM];
    for (const [key, value] of Object.entries(metadata)) {
        if (value === null || value === undefined)
            continue;
        if (Array.isArray(value)) {
            if (value.length === 0) {
                lines.push(`${key}: []`);
            }
            else {
                lines.push(`${key}:`);
                for (const item of value) {
                    lines.push(`  - ${escapeYamlString(String(item))}`);
                }
            }
        }
        else if (typeof value === "object") {
            lines.push(`${key}:`);
            for (const [subKey, subValue] of Object.entries(value)) {
                if (subValue !== null && subValue !== undefined) {
                    if (Array.isArray(subValue)) {
                        lines.push(`  ${subKey}:`);
                        for (const item of subValue) {
                            lines.push(`    - ${escapeYamlString(String(item))}`);
                        }
                    }
                    else {
                        lines.push(`  ${subKey}: ${escapeYamlString(String(subValue))}`);
                    }
                }
            }
        }
        else if (typeof value === "boolean") {
            lines.push(`${key}: ${value}`);
        }
        else if (typeof value === "number") {
            lines.push(`${key}: ${value}`);
        }
        else {
            lines.push(`${key}: ${escapeYamlString(String(value))}`);
        }
    }
    lines.push(FRONTMATTER_DELIM);
    return lines.join("\n") + "\n";
}
function parseYamlFrontmatter(text) {
    const metadata = {};
    let body = text;
    if (!text.startsWith(FRONTMATTER_DELIM)) {
        return { metadata, body };
    }
    const endIdx = text.indexOf(FRONTMATTER_DELIM, 3);
    if (endIdx === -1) {
        return { metadata, body };
    }
    const fmBlock = text.slice(3, endIdx).trim();
    body = text.slice(endIdx + 3).trim();
    // Simple YAML key: value parser (covers our subset)
    let currentKey = "";
    for (const line of fmBlock.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        // List item
        if (trimmed.startsWith("- ")) {
            const item = trimmed.slice(2).trim().replace(/^"(.*)"$/, "$1");
            if (currentKey && metadata[currentKey]) {
                metadata[currentKey].push(item);
            }
            else if (currentKey) {
                metadata[currentKey] = [item];
            }
            continue;
        }
        // Nested key (indented)
        if (line.startsWith("  ") && !line.startsWith("    ")) {
            const nestedMatch = trimmed.match(/^([a-z_]+):\s*(.*)/i);
            if (nestedMatch && currentKey) {
                const nKey = nestedMatch[1];
                const nVal = nestedMatch[2].trim().replace(/^"(.*)"$/, "$1");
                if (!metadata[currentKey]) {
                    metadata[currentKey] = {};
                }
                metadata[currentKey][nKey] =
                    coerceYamlScalar(nVal);
            }
            continue;
        }
        // Top-level key: value
        const match = trimmed.match(/^([a-z_]+):\s*(.*)/i);
        if (match) {
            currentKey = match[1];
            const val = match[2].trim();
            if (val) {
                metadata[currentKey] = coerceYamlScalar(val.replace(/^"(.*)"$/, "$1"));
            }
            else {
                metadata[currentKey] = "";
            }
        }
    }
    return { metadata, body };
}
function coerceYamlScalar(value) {
    if (value === "true" || value === "True")
        return true;
    if (value === "false" || value === "False")
        return false;
    const num = Number(value);
    if (!Number.isNaN(num) && value.trim() !== "")
        return num;
    return value;
}
// ═══════════════════════════════════════════════════════════════════════════
// Path helpers
// ═══════════════════════════════════════════════════════════════════════════
function lineageDirName(loopId) {
    return `loop-${loopId.replace(/:/g, "-")}`;
}
function resolveVaultPath(rawPath) {
    if (rawPath.startsWith("~")) {
        return resolve(homedir(), rawPath.slice(2));
    }
    return resolve(rawPath);
}
// ═══════════════════════════════════════════════════════════════════════════
// Markdown lineage I/O (module-level functions)
// ═══════════════════════════════════════════════════════════════════════════
export function readLineageMd(loopId, roundNum, vaultPath) {
    const baseDir = vaultPath
        ? dirname(resolveVaultPath(vaultPath))
        : resolve(".promptcraft");
    const mdPath = resolve(baseDir, "prompts", lineageDirName(loopId), `r${roundNum}.md`);
    try {
        const raw = readFileSync(mdPath, "utf-8");
        const { metadata, body } = parseYamlFrontmatter(raw);
        return { full_prompt: body, metadata };
    }
    catch {
        return null;
    }
}
export function writeLineageMd(loopId, roundNum, content, metadata, vaultPath) {
    const baseDir = vaultPath
        ? dirname(resolveVaultPath(vaultPath))
        : resolve(".promptcraft");
    const dir = resolve(baseDir, "prompts", lineageDirName(loopId));
    const mdPath = resolve(dir, `r${roundNum}.md`);
    try {
        mkdirSync(dir, { recursive: true });
        const fm = buildYamlFrontmatter(metadata);
        writeFileSync(mdPath, fm + "\n" + content, "utf-8");
        return mdPath;
    }
    catch {
        return null;
    }
}
export function scanLineageMd(loopId, vaultPath) {
    const baseDir = vaultPath
        ? dirname(resolveVaultPath(vaultPath))
        : resolve(".promptcraft");
    const dir = resolve(baseDir, "prompts", lineageDirName(loopId));
    const entries = [];
    try {
        if (!existsSync(dir))
            return entries;
        const files = readdirSync(dir).filter((f) => f.startsWith("r") && f.endsWith(".md"));
        for (const file of files) {
            const roundMatch = file.match(/^r(\d+)\.md$/);
            if (!roundMatch)
                continue;
            const roundNum = parseInt(roundMatch[1], 10);
            const fullPath = resolve(dir, file);
            const raw = readFileSync(fullPath, "utf-8");
            const { metadata, body } = parseYamlFrontmatter(raw);
            entries.push({
                task_id: `loop:${loopId}:r${roundNum}`,
                full_prompt: body,
                technique_used: metadata.technique_used,
                success: metadata.success ?? true,
                loop_lineage: {
                    loop_id: loopId,
                    round: roundNum,
                    goal_id: metadata.goal_id,
                    goal_text_hash: metadata.goal_text_hash,
                    recompile_level: metadata.recompile_level,
                    constraints_active: metadata.constraints_active,
                    task: metadata.task,
                    technique_used: metadata.technique_used,
                    success: metadata.success,
                    output_summary: metadata.output_summary,
                    constraint_violations: metadata.constraint_violations,
                },
                loop_id: loopId,
                task: metadata.task,
                output_summary: metadata.output_summary,
                constraint_violations: metadata
                    .constraint_violations,
            });
        }
    }
    catch {
        // Directory doesn't exist or can't be read
    }
    return entries;
}
// ═══════════════════════════════════════════════════════════════════════════
// FSBackend
// ═══════════════════════════════════════════════════════════════════════════
export class FSBackend {
    vaultPath;
    // v2: federation — global vault for cross-project constraints (not yet implemented)
    globalVaultPath;
    /** Re-entrant lock depth — >0 means this process holds the lock. */
    lockDepth = 0;
    constructor(vaultPath = ".promptcraft/prompt_vault.json", globalVaultPath = "~/.promptcraft/global_vault.json") {
        this.vaultPath = vaultPath;
        this.globalVaultPath = globalVaultPath;
    }
    /** File-system mutex via mkdir (atomic on POSIX and Windows).
     *  Re-entrant: nested calls from the same process bypass the lock. */
    withLock(fn) {
        if (this.lockDepth > 0) {
            this.lockDepth++;
            try {
                return fn();
            }
            finally {
                this.lockDepth--;
            }
        }
        const lockPath = resolveVaultPath(this.vaultPath).replace(/\.json$/, ".lock");
        // Cross-process mutex via mkdir (atomic on POSIX and Windows).
        // Lock is held only for the duration of vault I/O (microseconds),
        // so contention is rare and brief. Spin-wait with short pauses
        // because Node.js has no synchronous sleep primitive.
        const lockTimeout = Date.now() + 500;
        for (;;) {
            try {
                mkdirSync(lockPath);
                break;
            }
            catch {
                if (Date.now() >= lockTimeout) {
                    throw new Error("Vault lock timeout (500ms)");
                }
            }
            // Brief yield — 2ms per iteration, ~250 retries max
            const spinEnd = Date.now() + 2;
            while (Date.now() < spinEnd) { /* spin */ }
        }
        this.lockDepth = 1;
        try {
            return fn();
        }
        finally {
            this.lockDepth = 0;
            try {
                rmSync(lockPath, { recursive: true });
            }
            catch {
                /* orphaned lock — next process cleans up via timeout */
            }
        }
    }
    // ── JSON vault ────────────────────────────────────────────────────────
    readVault() {
        const resolved = resolveVaultPath(this.vaultPath);
        try {
            const raw = readFileSync(resolved, "utf-8");
            return JSON.parse(raw);
        }
        catch {
            return { entries: [] };
        }
    }
    writeVault(data) {
        this.withLock(() => {
            const resolved = resolveVaultPath(this.vaultPath);
            mkdirSync(dirname(resolved), { recursive: true });
            writeFileSync(resolved, JSON.stringify(data, null, 2), "utf-8");
        });
    }
    // ── Entry queries ─────────────────────────────────────────────────────
    queryEntries(opts) {
        const vault = this.readVault();
        const entries = vault.entries || [];
        return entries.filter((entry) => {
            const taskId = String(entry.task_id ?? "");
            // Feedback-only filter
            if (opts?.feedbackOnly && !taskId.endsWith(":feedback")) {
                return false;
            }
            // Exclude feedback entries when not feedbackOnly
            if (!opts?.feedbackOnly && taskId.endsWith(":feedback")) {
                return false;
            }
            // Prefix filter
            if (opts?.prefix && !taskId.startsWith(opts.prefix)) {
                return false;
            }
            // Pattern filter (simple substring match)
            if (opts?.taskIdPattern &&
                !taskId.includes(opts.taskIdPattern)) {
                return false;
            }
            return true;
        });
    }
    appendEntry(entry) {
        this.withLock(() => {
            const vault = this.readVault();
            const entries = vault.entries || [];
            entries.push(entry);
            vault.entries = entries;
            this.writeVault(vault);
        });
    }
    appendEntries(entries) {
        return this.withLock(() => {
            if (entries.length === 0)
                return 0;
            const vault = this.readVault();
            const existing = vault.entries || [];
            vault.entries = [...existing, ...entries];
            this.writeVault(vault);
            return entries.length;
        });
    }
    // ── Markdown lineage ──────────────────────────────────────────────────
    writeLineageMd(loopId, roundNum, content, metadata) {
        return writeLineageMd(loopId, roundNum, content, metadata, this.vaultPath);
    }
    readLineageMd(loopId, roundNum) {
        const result = readLineageMd(loopId, roundNum, this.vaultPath);
        return result?.full_prompt ?? null;
    }
    scanLineageMd(loopId) {
        return scanLineageMd(loopId, this.vaultPath);
    }
}
//# sourceMappingURL=fs.js.map