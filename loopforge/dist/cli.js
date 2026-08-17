#!/usr/bin/env node
/** Unified LoopForge command line. */
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { initializeClient } from "./init.js";
import { FileLoopStore, LoopStoreBackend } from "./loop-store.js";
import { ReplayBackend } from "./replay.js";
import { summarizeGovernanceGraph } from "./governance-graph.js";
import { deriveRegressionObligations, regressionSummary } from "./regression-obligations.js";
import { getPolicy, validateLoopId, writeDefaultPolicy } from "./policy.js";
import { McpServer } from "./mcp/server.js";
import { SessionManager } from "./mcp/session.js";
import { TOOL_SCHEMAS } from "./mcp/tools.js";
import { LOOPFORGE_VERSION } from "./version.js";
import { WorkspaceRuntime, resolveStoreRoot, resolveWorkspace } from "./workspace-runtime.js";
const VERSION = LOOPFORGE_VERSION;
const HELP = `LoopForge ${VERSION}

Usage:
  loopforge mcp [--workspace DIR] [--store-dir DIR]
  loopforge init --client claude|codex|generic [--target DIR] [--register] [--force] [--workspace DIR] [--store-dir DIR]
  loopforge doctor [--workspace DIR] [--store-dir DIR] [--client claude|codex] [--workflow] [--json]
  loopforge inspect LOOP_ID [--workspace DIR] [--store-dir DIR] [--round N] [--prompt] [--json]
  loopforge migrate [--workspace DIR] [--store-dir DIR] [--from PATH] [--json]
`;
function option(args, name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}
function has(args, name) {
    return args.includes(name);
}
function print(value, json) {
    if (json)
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else if (typeof value === "string")
        process.stdout.write(`${value}\n`);
    else
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function withoutPrompts(value) {
    if (Array.isArray(value))
        return value.map(withoutPrompts);
    if (!value || typeof value !== "object")
        return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
        // Filter keys that contain "prompt" or "Prompt" (case-insensitive word
        // boundary). Safer than a manual allow-list that must be updated for
        // every new prompt-text field. prompt_artifact (meta only, no content)
        // is preserved for audit visibility.
        if (/\bprompt\b/i.test(key) && key !== "prompt_artifact" && key !== "promptArtifact") {
            continue;
        }
        result[key] = withoutPrompts(child);
    }
    return result;
}
function ensureInsideWorkspace(configured) {
    const workspace = realpathSync(process.cwd());
    const lexical = resolve(workspace, configured);
    const lexicalRelative = relative(workspace, lexical);
    if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) ||
        isAbsolute(lexicalRelative))
        throw new Error("path leaves the workspace");
    if (!existsSync(lexical))
        return lexical;
    const actual = realpathSync(lexical);
    const actualRelative = relative(workspace, actual);
    if (actualRelative === ".." || actualRelative.startsWith(`..${sep}`) ||
        isAbsolute(actualRelative))
        throw new Error("path resolves outside the workspace");
    return actual;
}
async function doctor(json, client, workflow = false, workspaceRoot, storeDir) {
    const policy = workspaceRoot
        ? getPolicy(resolve(resolveWorkspace(workspaceRoot).root, "loop_policy.json"))
        : getPolicy();
    const checks = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({
        name: "node",
        ok: nodeMajor >= 18,
        required: true,
        detail: `Node ${process.versions.node} (requires >=18)`,
    });
    if (workspaceRoot) {
        try {
            const runtime = new WorkspaceRuntime({ workspaceRoot, storeDir });
            checks.push({ name: "workspace-binding", ok: runtime.isBound, required: true, detail: JSON.stringify(runtime.summary()) });
        }
        catch (error) {
            checks.push({ name: "workspace-binding", ok: false, required: true, detail: String(error) });
        }
    }
    checks.push({
        name: "host-session-exposure",
        ok: false,
        required: false,
        detail: "registration cannot prove this host session loaded MCP; a successful loopforge_start/resume call is the exposure proof",
    });
    checks.push({
        name: "version",
        ok: policy.version === "3" && policy.prompt.base_prompt_version === VERSION,
        required: true,
        detail: `package=${VERSION}, policy=${policy.version}, prompt=${policy.prompt.base_prompt_version}`,
    });
    checks.push({
        name: "mcp-schema",
        ok: ["loopforge_start", "loopforge_plan_submit", "loopforge_plan_update", "loopforge_plan_approve", "loopforge_next"]
            .every((name) => TOOL_SCHEMAS.some((tool) => tool.name === name)),
        required: true,
        detail: `${TOOL_SCHEMAS.length} tools with strict input and structured output schemas`,
    });
    if (client) {
        const skillPath = client === "codex"
            ? resolve(process.env.USERPROFILE ?? "", ".codex", "skills", "loopforge", "SKILL.md")
            : resolve(process.env.USERPROFILE ?? "", ".claude", "skills", "loopforge", "SKILL.md");
        checks.push({
            name: `skill:${client}`,
            ok: existsSync(skillPath),
            required: false,
            detail: existsSync(skillPath) ? skillPath : `not installed: ${skillPath}`,
        });
        const probe = spawnSync(client, ["mcp", "get", "loopforge"], { encoding: "utf8", shell: false, windowsHide: true });
        checks.push({
            name: `registration:${client}`,
            ok: probe.status === 0,
            required: false,
            detail: probe.status === 0 ? "verified" : "registration unverified (client CLI unavailable or registration missing)",
        });
    }
    if (workflow) {
        const root = mkdtempSync(resolve(tmpdir(), "loopforge-doctor-"));
        try {
            const manager = new SessionManager(new FileLoopStore(resolve(root, ".loopforge")));
            const started = await manager.create({ task: "LoopForge doctor workflow probe", loopId: "doctor-workflow" });
            const paused = manager.pause(started.sessionId);
            const resumed = await manager.unpause("doctor-workflow");
            const stopped = manager.delete(started.sessionId);
            manager.close();
            checks.push({
                name: "workflow",
                ok: started.phase === "planning" && paused.status === "paused" && Boolean(resumed?.prompt) && stopped,
                required: true,
                detail: "start/planning, pause, resume, and stop lifecycle",
            });
        }
        catch (error) {
            checks.push({ name: "workflow", ok: false, required: true, detail: String(error) });
        }
        finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
    try {
        const root = workspaceRoot ? resolveStoreRoot(resolveWorkspaceArg(workspaceRoot), storeDir) : resolve(policy.backend.root_dir);
        let writable = root;
        while (!existsSync(writable))
            writable = dirname(writable);
        accessSync(writable, constants.W_OK);
        checks.push({ name: "store", ok: true, required: true, detail: root });
    }
    catch (error) {
        checks.push({ name: "store", ok: false, required: true, detail: String(error) });
    }
    const git = spawnSync("git", ["--version"], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
    });
    checks.push({
        name: "git",
        ok: git.status === 0,
        required: false,
        detail: git.status === 0 ? git.stdout.trim() : "unavailable (git evidence will be skipped)",
    });
    for (const command of policy.evidence.commands) {
        if (!command.enabled)
            continue;
        let ok = true;
        let detail = `${command.executable} ${command.args.join(" ")}`.trim();
        try {
            if (!command.name || !command.executable)
                throw new Error("name and executable are required");
            if (!Array.isArray(command.args))
                throw new Error("args must be an array");
            if (command.cwd) {
                const cwd = ensureInsideWorkspace(command.cwd);
                if (existsSync(cwd) && !statSync(cwd).isDirectory())
                    throw new Error("cwd is not a directory");
            }
        }
        catch (error) {
            ok = false;
            detail = String(error);
        }
        checks.push({
            name: `command:${command.name || "unnamed"}`,
            ok,
            required: command.required,
            detail,
        });
    }
    const report = {
        version: VERSION,
        ok: checks.every((check) => check.ok || !check.required),
        checks,
    };
    if (json)
        print(report, true);
    else {
        process.stdout.write(`LoopForge doctor ${VERSION}\n`);
        for (const check of checks) {
            const status = check.ok ? "OK" : check.required ? "FAIL" : "WARN";
            process.stdout.write(`${status}  ${check.name}: ${check.detail}\n`);
        }
    }
    return report.ok ? 0 : 1;
}
function resolveWorkspaceArg(value) {
    return resolveWorkspace(value).root;
}
function inspect(args) {
    const loopId = args.find((arg) => !arg.startsWith("-"));
    if (!loopId)
        throw new Error("inspect requires LOOP_ID");
    validateLoopId(loopId);
    const roundText = option(args, "--round");
    const includePrompt = has(args, "--prompt");
    const json = has(args, "--json");
    const workspaceRoot = option(args, "--workspace");
    const storeDir = option(args, "--store-dir");
    const store = new FileLoopStore(workspaceRoot ? resolveStoreRoot(resolveWorkspaceArg(workspaceRoot), storeDir) : getPolicy().backend.root_dir);
    if (roundText !== undefined) {
        const round = Number(roundText);
        if (!Number.isInteger(round) || round < 1)
            throw new Error("--round must be a positive integer");
        const document = store.readRound(loopId, round);
        if (!document)
            throw new Error(`round not found: ${loopId}#${round}`);
        const result = includePrompt ? document : withoutPrompts(document);
        print(result, json);
        return;
    }
    const rounds = [...new Set(store.listEntries(loopId).map((entry) => {
            const value = entry.loop_lineage?.round;
            return typeof value === "number" ? value : null;
        }).filter((value) => value !== null))].sort((a, b) => a - b);
    const graph = new ReplayBackend(new LoopStoreBackend(store)).graph(loopId);
    const summary = {
        loopId,
        session: store.readSession(loopId),
        rounds,
        graphSummary: summarizeGovernanceGraph(graph),
        regressionSummary: regressionSummary(deriveRegressionObligations(store.listEntries(loopId))),
        graph,
    };
    print(includePrompt ? summary : withoutPrompts(summary), json);
}
function init(args) {
    const client = option(args, "--client");
    if (!client || !["claude", "codex", "generic"].includes(client)) {
        throw new Error("init requires --client claude|codex|generic");
    }
    const force = has(args, "--force") || has(args, "-f");
    const target = option(args, "--target");
    const register = has(args, "--register");
    const workspaceRoot = option(args, "--workspace");
    const storeDir = option(args, "--store-dir");
    const result = initializeClient({ client, force, target, register, workspaceRoot, storeDir });
    process.stdout.write(`${result.installed ? "Installed" : "Already present"}: ${result.skillPath}\n`);
    process.stdout.write(result.registered ? "MCP registration updated.\n" : "Register MCP with:\n");
    if (!result.registered)
        print(result.registration, typeof result.registration !== "string");
    for (const warning of result.warnings)
        process.stderr.write(`WARN  ${warning}\n`);
    // Write default loop_policy.json alongside the skill so users can
    // discover and tune runtime behaviour without reading source code.
    const policyDir = target ?? process.cwd();
    const policyResult = writeDefaultPolicy(policyDir, force);
    process.stdout.write(`${policyResult.created ? "Created" : "Already present"}: ${policyResult.path}\n`);
}
function migrate(args) {
    const source = option(args, "--from") ?? ".promptcraft/prompt_vault.json";
    const workspaceRoot = option(args, "--workspace");
    const storeDir = option(args, "--store-dir");
    const result = new FileLoopStore(workspaceRoot ? resolveStoreRoot(resolveWorkspaceArg(workspaceRoot), storeDir) : getPolicy().backend.root_dir).migrateLegacyVault(source);
    print(result, has(args, "--json"));
}
export async function main(argv = process.argv.slice(2)) {
    const [command, ...args] = argv;
    if (!command || command === "help" || command === "--help" || command === "-h") {
        process.stdout.write(HELP);
        return;
    }
    if (command === "--version" || command === "-v") {
        process.stdout.write(`${VERSION}\n`);
        return;
    }
    if (command === "mcp") {
        const workspaceRoot = option(args, "--workspace");
        const storeDir = option(args, "--store-dir");
        const runtime = new WorkspaceRuntime(workspaceRoot ? { workspaceRoot, storeDir } : undefined);
        new McpServer(undefined, runtime).start();
        return;
    }
    if (command === "init")
        return init(args);
    if (command === "doctor") {
        const client = option(args, "--client");
        if (client && !["claude", "codex"].includes(client))
            throw new Error("doctor --client must be claude or codex");
        process.exitCode = await doctor(has(args, "--json"), client, has(args, "--workflow"), option(args, "--workspace"), option(args, "--store-dir"));
        return;
    }
    if (command === "inspect")
        return inspect(args);
    if (command === "migrate")
        return migrate(args);
    throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
    main().catch((error) => {
        process.stderr.write(`loopforge: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli.js.map