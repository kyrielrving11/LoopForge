/** Client-specific skill onboarding. */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillSourceDir = join(packageRoot, "skills", "forge");
function destination(options) {
    if (options.target)
        return resolve(options.target, "forge");
    if (options.client === "claude") {
        return join(homedir(), ".claude", "skills", "forge");
    }
    if (options.client === "codex") {
        return join(homedir(), ".codex", "skills", "forge");
    }
    return resolve(".loopforge", "skills", "forge");
}
function registration(client) {
    if (client === "claude") {
        return "claude mcp add loopforge -- npx loopforge mcp";
    }
    if (client === "codex") {
        return "codex mcp add loopforge -- npx loopforge mcp";
    }
    return {
        mcpServers: {
            loopforge: { command: "npx", args: ["loopforge", "mcp"] },
        },
    };
}
/** Copy each entry into an already-created destination. Per-entry copying
 *  avoids `cpSync(srcDir, destDir)` nesting the source under an existing
 *  destination, and keeps the operation explicit about what it owns. */
function copySkillTree(sourceDir, destDir) {
    mkdirSync(destDir, { recursive: true });
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
        cpSync(join(sourceDir, entry.name), join(destDir, entry.name), {
            recursive: true,
        });
    }
}
function listFiles(root, current = root) {
    const out = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
            out.push(...listFiles(root, full));
        }
        else {
            out.push(relative(root, full).split("\\").join("/"));
        }
    }
    return out.sort();
}
export function initializeClient(options) {
    const skillPath = join(skillSourceDir, "SKILL.md");
    if (!existsSync(skillPath)) {
        throw new Error(`Packaged Forge skill not found: ${skillPath}`);
    }
    const skillDir = destination(options);
    // Default install is a no-op when the skill directory exists. It never
    // repairs a partial install or overwrites user edits; `--force` replaces
    // the package-owned directory wholesale so stale references disappear.
    const installed = options.force === true || !existsSync(skillDir);
    if (installed) {
        if (options.force === true && existsSync(skillDir)) {
            rmSync(skillDir, { recursive: true, force: true });
        }
        copySkillTree(skillSourceDir, skillDir);
    }
    return {
        client: options.client,
        skillDir,
        skillPath: join(skillDir, "SKILL.md"),
        installed,
        files: installed ? listFiles(skillDir) : [],
        registration: registration(options.client),
    };
}
//# sourceMappingURL=init.js.map