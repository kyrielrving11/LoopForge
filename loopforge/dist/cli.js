#!/usr/bin/env node
/** Unified LoopForge command line. */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { containInWorkspace } from "./workspace.js";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { initializeClient } from "./init.js";
import { FileLoopStore } from "./loop-store.js";
import { getPolicy, validateLoopId, writeDefaultPolicy } from "./policy.js";
import { McpServer } from "./mcp/server.js";
const VERSION = "3.6.0";
const HELP = `LoopForge ${VERSION}

Usage:
  loopforge mcp
  loopforge init --client claude|codex|generic [--target DIR] [--force]
  loopforge doctor [--json]
  loopforge inspect LOOP_ID [--round N] [--prompt] [--json]
  loopforge migrate [--from PATH] [--json]
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
        // v2.14: filter every key CONTAINING "prompt" (case-insensitive
        // substring). The old \bprompt\b word-boundary regex never matched
        // underscore or camelCase keys (full_prompt, current_prompt,
        // renderedPrompt, currentPrompt), so the filter was a silent no-op and
        // `inspect --round N` leaked full prompt text. Prompt artifacts are
        // kept as metadata only — renderedPrompt IS the prompt text itself.
        if (/prompt/i.test(key)) {
            // Prompt artifacts are kept as metadata only (level, hashes) — the
            // rendered text is the prompt itself.
            if ((key === "promptArtifact" || key === "prompt_artifact") &&
                child !== null && typeof child === "object" && !Array.isArray(child)) {
                const { renderedPrompt: _text, ...metadata } = child;
                if (Object.keys(metadata).length > 0)
                    result[key] = metadata;
            }
            continue;
        }
        result[key] = withoutPrompts(child);
    }
    return result;
}
function ensureInsideWorkspace(configured) {
    // v3.3.1: delegated to the single shared containment check (workspace.ts).
    return containInWorkspace(process.cwd(), configured);
}
function doctor(json) {
    const policy = getPolicy();
    const checks = [];
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({
        name: "node",
        ok: nodeMajor >= 18,
        required: true,
        detail: `Node ${process.versions.node} (requires >=18)`,
    });
    try {
        const root = resolve(policy.backend.root_dir);
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
function inspect(args) {
    // v3.3.1: option VALUES (e.g. "--round 2") are not positional arguments.
    // Previously `inspect --round 2 my-loop` took "2" as the LOOP_ID and
    // reported "round not found: 2#2" while never reading my-loop.
    const optionValues = new Set();
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--round" && i + 1 < args.length) {
            optionValues.add(args[i + 1]);
        }
    }
    const loopId = args.find((arg) => !arg.startsWith("-") && !optionValues.has(arg));
    if (!loopId)
        throw new Error("inspect requires LOOP_ID");
    validateLoopId(loopId);
    const roundText = option(args, "--round");
    const includePrompt = has(args, "--prompt");
    const json = has(args, "--json");
    const store = new FileLoopStore(getPolicy().backend.root_dir);
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
    const summary = { loopId, session: store.readSession(loopId), rounds };
    print(includePrompt ? summary : withoutPrompts(summary), json);
}
function init(args) {
    const client = option(args, "--client");
    if (!client || !["claude", "codex", "generic"].includes(client)) {
        throw new Error("init requires --client claude|codex|generic");
    }
    const force = has(args, "--force") || has(args, "-f");
    const target = option(args, "--target");
    const result = initializeClient({ client, force, target });
    process.stdout.write(`${result.installed ? "Installed" : "Already present"}: ${result.skillPath}\n`);
    process.stdout.write("Register MCP with:\n");
    print(result.registration, typeof result.registration !== "string");
    // Write default loop_policy.json alongside the skill so users can
    // discover and tune runtime behaviour without reading source code.
    const policyDir = target ?? process.cwd();
    const policyResult = writeDefaultPolicy(policyDir, force);
    process.stdout.write(`${policyResult.created ? "Created" : "Already present"}: ${policyResult.path}\n`);
}
function migrate(args) {
    const source = option(args, "--from") ?? ".promptcraft/prompt_vault.json";
    const result = new FileLoopStore(getPolicy().backend.root_dir).migrateLegacyVault(source);
    print(result, has(args, "--json"));
}
export function main(argv = process.argv.slice(2)) {
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
        new McpServer().start();
        return;
    }
    if (command === "init")
        return init(args);
    if (command === "doctor") {
        process.exitCode = doctor(has(args, "--json"));
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
    try {
        main();
    }
    catch (error) {
        process.stderr.write(`loopforge: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
//# sourceMappingURL=cli.js.map