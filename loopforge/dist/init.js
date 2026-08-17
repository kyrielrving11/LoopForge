/** Client-specific skill onboarding. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillSource = join(packageRoot, "skills", "loopforge", "SKILL.md");
const cliPath = join(packageRoot, "dist", "cli.js");
const MANAGED_PERCEPTION_DIGESTS = new Set([
    "2c0602228562a09e54b3e7219d290d1bd322cf5530879fa79c2a2a2dd29f7d67",
]);
function destination(options) {
    if (options.target)
        return resolve(options.target, "loopforge", "SKILL.md");
    if (options.client === "claude") {
        return join(homedir(), ".claude", "skills", "loopforge", "SKILL.md");
    }
    if (options.client === "codex") {
        return join(homedir(), ".codex", "skills", "loopforge", "SKILL.md");
    }
    return resolve(".loopforge", "skills", "loopforge", "SKILL.md");
}
function registration(client, options = {}) {
    const command = process.execPath;
    const args = [cliPath, "mcp"];
    if (options.workspaceRoot)
        args.push("--workspace", resolve(options.workspaceRoot));
    if (options.storeDir)
        args.push("--store-dir", options.storeDir);
    const displayArgs = args.map((arg) => `"${arg}"`).join(" ");
    if (client === "claude") {
        return `claude mcp add loopforge -- "${command}" ${displayArgs}`;
    }
    if (client === "codex") {
        return `codex mcp add loopforge -- "${command}" ${displayArgs}`;
    }
    return {
        mcpServers: {
            loopforge: { command, args },
        },
    };
}
function legacySkillPath(options) {
    return join(dirname(destination(options)), "..", "perception", "SKILL.md");
}
export function removeManagedLegacySkillFile(pathInput, warnings, managedDigests = MANAGED_PERCEPTION_DIGESTS) {
    const path = resolve(pathInput);
    if (!existsSync(path))
        return;
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (!managedDigests.has(digest)) {
        warnings.push(`Preserved non-managed legacy perception skill: ${path}`);
        return;
    }
    unlinkSync(path);
    const legacyDirectory = dirname(path);
    if (readdirSync(legacyDirectory).length === 0)
        rmdirSync(legacyDirectory);
}
function removeManagedLegacySkill(options, warnings) {
    removeManagedLegacySkillFile(legacySkillPath(options), warnings);
}
function registerClient(options, warnings) {
    if (!options.register || options.client === "generic")
        return { registered: false, verified: false };
    const executable = options.client;
    const probe = spawnSync(executable, ["mcp", "get", "loopforge"], { encoding: "utf8", shell: false, windowsHide: true });
    if (probe.error && probe.error.code === "ENOENT") {
        warnings.push(`${options.client} CLI is unavailable; registration was not verified or changed.`);
        return { registered: false, verified: false };
    }
    if (probe.status === 0 && !options.force) {
        warnings.push(`Existing loopforge MCP registration preserved. Use --force --register to replace it.`);
        return { registered: false, verified: true };
    }
    if (probe.status === 0 && options.force) {
        const removed = spawnSync(executable, ["mcp", "remove", "loopforge"], { encoding: "utf8", shell: false, windowsHide: true });
        if (removed.status !== 0) {
            warnings.push(`Could not remove existing loopforge registration: ${(removed.stderr || removed.stdout).trim()}`);
            return { registered: false, verified: true };
        }
    }
    const serverArgs = ["mcp"];
    if (options.workspaceRoot)
        serverArgs.push("--workspace", resolve(options.workspaceRoot));
    if (options.storeDir)
        serverArgs.push("--store-dir", options.storeDir);
    const added = spawnSync(executable, ["mcp", "add", "loopforge", "--", process.execPath, cliPath, ...serverArgs], {
        encoding: "utf8", shell: false, windowsHide: true,
    });
    if (added.error || added.status !== 0) {
        warnings.push(`Registration was not verified: ${added.error?.message ?? (added.stderr || added.stdout).trim()}`);
        return { registered: false, verified: false };
    }
    return { registered: true, verified: true };
}
export function initializeClient(options) {
    if (!existsSync(skillSource)) {
        throw new Error(`Packaged LoopForge skill not found: ${skillSource}`);
    }
    const skillPath = destination(options);
    const installed = options.force === true || !existsSync(skillPath);
    if (installed) {
        mkdirSync(dirname(skillPath), { recursive: true });
        copyFileSync(skillSource, skillPath);
    }
    const warnings = [];
    removeManagedLegacySkill(options, warnings);
    const registered = registerClient(options, warnings);
    return {
        client: options.client,
        skillPath,
        installed,
        registration: registration(options.client, options),
        registered: registered.registered,
        registrationVerified: registered.verified,
        warnings,
    };
}
//# sourceMappingURL=init.js.map