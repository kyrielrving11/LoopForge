/** Client-specific skill onboarding. */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = join(packageRoot, "skills", "forge", "SKILL.md");
function destination(options) {
    if (options.target)
        return resolve(options.target, "forge", "SKILL.md");
    if (options.client === "claude") {
        return join(homedir(), ".claude", "skills", "forge", "SKILL.md");
    }
    if (options.client === "codex") {
        return join(homedir(), ".codex", "skills", "forge", "SKILL.md");
    }
    return resolve(".loopforge", "skills", "forge", "SKILL.md");
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
export function initializeClient(options) {
    if (!existsSync(skillSource)) {
        throw new Error(`Packaged Forge skill not found: ${skillSource}`);
    }
    const skillPath = destination(options);
    const installed = options.force === true || !existsSync(skillPath);
    if (installed) {
        mkdirSync(dirname(skillPath), { recursive: true });
        copyFileSync(skillSource, skillPath);
    }
    return {
        client: options.client,
        skillPath,
        installed,
        registration: registration(options.client),
    };
}
//# sourceMappingURL=init.js.map