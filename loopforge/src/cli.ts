#!/usr/bin/env node
/** Unified LoopForge command line. */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { containInWorkspace } from "./workspace.js";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { initializeClient, type InitClient } from "./init.js";
import { FileLoopStore, queryLoopEntries } from "./loop-store.js";
import { getPolicy, validateLoopId, writeDefaultPolicy, DEFAULT_POLICY, POLICY_INVALID_CODE } from "./policy.js";
import type { LoopPolicy } from "./policy.js";
import { deriveEvidenceCapability, isProviderRegistered } from "./evidence-provider.js";
import { buildExplain, renderExplain } from "./explain.js";
import { McpServer } from "./mcp/server.js";
import { VERSION } from "./version.js";

const HELP = `LoopForge ${VERSION}

Usage:
  loopforge mcp [--workspace DIR]
  loopforge init --client claude|codex|generic [--target DIR] [--workspace DIR] [--force]
  loopforge doctor [--json]
  loopforge inspect LOOP_ID [--round N] [--prompt] [--json]
  loopforge explain LOOP_ID [--round N] [--json]

  --target    where the client skill is installed
  --workspace the runtime workspace: loop_policy.json, .loopforge/, and every
              evidence command resolve against it (default: the current directory)
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  // v3.8.3: a flag with no value used to be indistinguishable from an absent
  // flag, so `init --client generic --target` silently wrote the policy to the
  // current directory instead of the one the user named.
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Reject options a subcommand does not accept. Silently ignoring them made a
 *  typo behave exactly like the flag was never passed. */
function rejectUnknownFlags(args: string[], allowed: readonly string[]): void {
  for (const arg of args) {
    if (!arg.startsWith("-")) continue;
    if (!allowed.includes(arg)) {
      throw new Error(`unknown option: ${arg}`);
    }
  }
}

/** v3.8.3: set the runtime workspace boundary before anything captures it.
 *
 *  `process.cwd()` remains the single workspace boundary — this only chooses
 *  it, and it has to run before the first `getPolicy()`, which caches the
 *  policy for the process lifetime, and before the store root is resolved.
 *  Callers therefore invoke it before constructing any runtime object. */
function enterWorkspace(dir: string): void {
  const target = resolve(dir);
  if (!existsSync(target)) {
    throw new Error(`--workspace ${dir} does not exist (resolved to ${target})`);
  }
  if (!statSync(target).isDirectory()) {
    throw new Error(`--workspace ${dir} is not a directory (resolved to ${target})`);
  }
  process.chdir(target);
}

function print(value: unknown, json: boolean): void {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function withoutPrompts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPrompts);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
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
        const { renderedPrompt: _text, ...metadata } = child as Record<string, unknown>;
        if (Object.keys(metadata).length > 0) result[key] = metadata;
      }
      continue;
    }
    result[key] = withoutPrompts(child);
  }
  return result;
}

function ensureInsideWorkspace(configured: string): string {
  // v3.3.1: delegated to the single shared containment check (workspace.ts).
  return containInWorkspace(process.cwd(), configured);
}

function doctor(json: boolean): number {
  const checks: Array<{ name: string; ok: boolean; required: boolean; detail: string }> = [];
  // v3.8.1: loading the policy is itself a CHECK. It used to run first and
  // throw, so `doctor --json` died on exactly the defect it exists to
  // diagnose (a file that does not declare this schema version, or carries an
  // unknown key) — README promised a policy-structure check and the one
  // situation that needs it produced no report at all. The remaining checks
  // run against the defaults so a broken policy file still yields a report.
  let policy: LoopPolicy;
  try {
    policy = getPolicy();
    checks.push({
      name: "policy",
      ok: true,
      required: true,
      detail: `schema version ${policy.version}, ${policy.evidence.commands.length} command(s)`,
    });
  } catch (error) {
    checks.push({
      name: "policy",
      ok: false,
      required: true,
      // An actionable next step, not just the defect: the runtime only falls
      // back to defaults when no file exists at all, so a broken file has to
      // be fixed or removed before anything runs.
      detail: `${String(error)} — fix it or delete it, then run doctor again.`,
    });
    policy = structuredClone(DEFAULT_POLICY);
  }
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
    while (!existsSync(writable)) writable = dirname(writable);
    accessSync(writable, constants.W_OK);
    checks.push({ name: "store", ok: true, required: true, detail: root });
  } catch (error) {
    checks.push({
      name: "store",
      ok: false,
      required: true,
      detail: `${String(error)} — create the directory, or point backend.root_dir at one that is writable.`,
    });
  }
  // v3.8.3: state the evidence posture in the same words the round prompts and
  // the MCP responses use — one derivation (`deriveEvidenceCapability`), so
  // doctor cannot describe a capability the runtime does not have. With no
  // command configured this is the row that says what is still possible.
  const capability = deriveEvidenceCapability(policy);
  checks.push({
    name: "evidence",
    ok: capability.contractVerificationAvailable,
    required: false,
    detail: capability.contractVerificationAvailable
      ? `${capability.commands.filter((command) => command.ready).length} enabled after-capable command(s) can back a contract item`
      : capability.warnings[0] ??
        "no enabled verification command is configured — add one to evidence.commands",
  });
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
  // v3.8: provider names must be registered (registration is code state, so
  // it is a doctor concern, never a hashed capability fact).
  for (const provider of policy.evidence.providers ?? []) {
    checks.push({
      name: `provider:${provider}`,
      ok: isProviderRegistered(provider),
      required: true,
      detail: isProviderRegistered(provider)
        ? "registered"
        : "no provider factory is registered for this name — remove it from evidence.providers",
    });
  }
  // v3.8: command ids must be unique — a duplicate name makes item
  // verification ambiguous.
  const seenCommandIds = new Map<string, number>();
  for (const command of policy.evidence.commands) {
    seenCommandIds.set(command.name, (seenCommandIds.get(command.name) ?? 0) + 1);
  }
  for (const [name, count] of seenCommandIds) {
    if (count > 1) {
      checks.push({
        name: `command-id:${name}`,
        ok: false,
        required: true,
        detail: `duplicate command id declared ${count} times — item verification would be ambiguous; give each command a unique name`,
      });
    }
  }
  for (const command of policy.evidence.commands) {
    if (!command.enabled) continue;
    let ok = true;
    let detail = `${command.executable} ${command.args.join(" ")}`.trim();
    try {
      if (!command.name || !command.executable) throw new Error("name and executable are required");
      if (!Array.isArray(command.args)) throw new Error("args must be an array");
      if (!(Number.isFinite(command.timeout_ms) && command.timeout_ms > 0)) {
        throw new Error("timeout_ms must be a positive number");
      }
      if (!(Number.isFinite(command.max_output_chars) && command.max_output_chars > 0)) {
        throw new Error("max_output_chars must be a positive number");
      }
      // Static executable resolution: consult PATH/PATHEXT without executing
      // anything. A bare name that resolves nowhere is a configuration bug the
      // agent would otherwise discover only when the command runs.
      if (!command.executable.includes("/") && !command.executable.includes("\\")) {
        const pathEntries = (process.env.PATH ?? "").split(delimiter);
        const extensions = process.platform === "win32"
          ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
          : [""];
        const resolved = pathEntries.some((dir) =>
          extensions.some((ext) => existsSync(join(dir, `${command.executable}${ext}`))));
        if (!resolved) throw new Error(`executable "${command.executable}" is not on PATH`);
      }
      if (command.cwd) {
        const cwd = ensureInsideWorkspace(command.cwd);
        if (existsSync(cwd) && !statSync(cwd).isDirectory()) throw new Error("cwd is not a directory");
      }
    } catch (error) {
      ok = false;
      // Every failure here is a policy defect the operator can fix in place.
      detail = `${String(error)} — fix this entry in evidence.commands.`;
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
  if (json) print(report, true);
  else {
    process.stdout.write(`LoopForge doctor ${VERSION}\n`);
    for (const check of checks) {
      const status = check.ok ? "OK" : check.required ? "FAIL" : "WARN";
      process.stdout.write(`${status}  ${check.name}: ${check.detail}\n`);
    }
  }
  return report.ok ? 0 : 1;
}

/** v3.8: `loopforge explain` — the read-only "why" view over committed rounds. */
function explain(args: string[]): number {
  const loopId = args.find((arg) => !arg.startsWith("-"));
  if (!loopId) {
    process.stderr.write("loopforge explain: LOOP_ID is required\n");
    return 1;
  }
  try {
    validateLoopId(loopId);
  } catch (error) {
    process.stderr.write(`loopforge explain: ${String(error)}\n`);
    return 1;
  }
  const roundValue = option(args, "--round");
  const round = roundValue === undefined ? undefined : Number(roundValue);
  if (round !== undefined && (!Number.isInteger(round) || round < 1)) {
    process.stderr.write("loopforge explain: --round must be a positive integer\n");
    return 1;
  }
  const store = new FileLoopStore(getPolicy().backend.root_dir);
  const entries = queryLoopEntries(store, loopId, { prefix: `loop:${loopId}:` })
    .concat(queryLoopEntries(store, loopId, { prefix: `loop:${loopId}:`, feedbackOnly: true }));
  const result = buildExplain(loopId, entries, round);
  print(has(args, "--json") ? result : renderExplain(result), has(args, "--json"));
  return 0;
}

function inspect(args: string[]): void {
  // v3.3.1: option VALUES (e.g. "--round 2") are not positional arguments.
  // Previously `inspect --round 2 my-loop` took "2" as the LOOP_ID and
  // reported "round not found: 2#2" while never reading my-loop.
  const optionValues = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--round" && i + 1 < args.length) {
      optionValues.add(args[i + 1]);
    }
  }
  const loopId = args.find(
    (arg) => !arg.startsWith("-") && !optionValues.has(arg),
  );
  if (!loopId) throw new Error("inspect requires LOOP_ID");
  validateLoopId(loopId);
  const roundText = option(args, "--round");
  const includePrompt = has(args, "--prompt");
  const json = has(args, "--json");
  const store = new FileLoopStore(getPolicy().backend.root_dir);
  if (roundText !== undefined) {
    const round = Number(roundText);
    if (!Number.isInteger(round) || round < 1) throw new Error("--round must be a positive integer");
    const document = store.readRound(loopId, round);
    if (!document) throw new Error(`round not found: ${loopId}#${round}`);
    const result = includePrompt ? document : withoutPrompts(document);
    print(result, json);
    return;
  }
  const rounds = [...new Set(store.listEntries(loopId).map((entry) => {
    const value = entry.loop_lineage?.round;
    return typeof value === "number" ? value : null;
  }).filter((value): value is number => value !== null))].sort((a, b) => a - b);
  const summary = { loopId, session: store.readSession(loopId), rounds };
  print(includePrompt ? summary : withoutPrompts(summary), json);
}

function init(args: string[]): void {
  rejectUnknownFlags(args, ["--client", "--target", "--workspace", "--force", "-f"]);
  const client = option(args, "--client") as InitClient | undefined;
  if (!client || !["claude", "codex", "generic"].includes(client)) {
    throw new Error("init requires --client claude|codex|generic");
  }
  const force = has(args, "--force") || has(args, "-f");
  // v3.8.3: two different roots, named separately. `--target` is the skills
  // root (the skill lands in <target>/perception/SKILL.md); `--workspace` is
  // the runtime boundary (loop_policy.json lands directly in it). One flag
  // meaning both is what made `--target` ambiguous: it wrote a policy the
  // runtime would never read, because the runtime only ever reads the
  // workspace it was started in.
  const target = option(args, "--target");
  const workspace = option(args, "--workspace") ?? process.cwd();

  const result = initializeClient({ client, force, target });
  process.stdout.write(`${result.installed ? "Installed" : "Already present"}: ${result.skillPath}\n`);
  process.stdout.write("Register MCP with:\n");
  print(result.registration, typeof result.registration !== "string");

  const policyResult = writeDefaultPolicy(workspace, force);
  process.stdout.write(
    `${policyResult.created ? "Created" : "Already present"}: ${policyResult.path}\n`,
  );
  // State the three locations plainly: which skill file was installed, where
  // the policy the runtime will actually read lives, and the command that
  // starts the server against that workspace.
  process.stdout.write(`Workspace: ${resolve(workspace)}\n`);
  process.stdout.write(
    "Start the server with:\n" +
    `  loopforge mcp${workspace === process.cwd() ? "" : ` --workspace ${resolve(workspace)}`}\n`,
  );
}

export function main(argv = process.argv.slice(2)): void {
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
    rejectUnknownFlags(args, ["--workspace"]);
    const workspace = option(args, "--workspace");
    // Must happen before the server is constructed: the policy is read and
    // cached, and the store root resolved, in the SessionManager constructor.
    if (workspace) enterWorkspace(workspace);
    try {
      new McpServer().start();
    } catch (error) {
      // v3.8.3: a policy file that exists but is broken kills the server
      // before it can answer anything. Report the stable code the MCP tool
      // envelope already uses, with the path in the message, instead of the
      // bare `loopforge: <message>` the top-level handler would print.
      if ((error as { code?: string }).code === POLICY_INVALID_CODE) {
        process.stderr.write(
          `${POLICY_INVALID_CODE}: ${(error as Error).message}\n` +
          "Run `loopforge doctor` for the full local readiness report.\n",
        );
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }
  if (command === "init") return init(args);
  if (command === "explain") {
    process.exitCode = explain(args);
    return;
  }
  if (command === "doctor") {
    process.exitCode = doctor(has(args, "--json"));
    return;
  }
  if (command === "inspect") return inspect(args);
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`loopforge: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
