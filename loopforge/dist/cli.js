#!/usr/bin/env node
/** LoopForge CLI — command-line interface for the loop compiler.
 *
 * v1.0 — npm install loopforge
 */
import { createEngine } from "./engine.js";
import { FSBackend } from "./backends/fs.js";
import { ReplayBackend } from "./replay.js";
import { makeExecutionFeedback, } from "./protocol.js";
// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════
const VERSION = "1.0.0";
const VAULT_CONFIG = {
    project_vault: ".promptcraft/prompt_vault.json",
    global_vault: "~/.promptcraft/global_vault.json",
    skills_dir: "skills",
    no_global: false,
};
const USAGE = `LoopForge v${VERSION} — Loop-Time Intelligence Layer

Usage:
  loopforge init                  Initialise .promptcraft vault
  loopforge compile [json]        Compile a loop prompt
  loopforge feedback [json]       Record execution feedback
  loopforge replay <loop-id>      Show loop timeline
  loopforge diff <loop-id> <a> <b> Diff two rounds
  loopforge review <loop-id> <rN> Audit stored prompt
  loopforge status                Vault health summary

Flags:
  --help, -h     Show this help
  --version, -V  Show version

Pipe JSON via stdin:  echo '{"task":"..."}' | loopforge compile
`;
const CMD_HELP = {
    init: "loopforge init — create .promptcraft/prompt_vault.json if it doesn't exist.",
    compile: "loopforge compile '<json>' — run loop_compile (L0/L1/L2).\n  Required: task, loop_id, goal_id. Optional: round, domain, constraints_from_plan, new_since_last_round, force_level.",
    feedback: "loopforge feedback '<json>' — record execution result.\n  Flat: {loop_id, round, success, score, output}\n  Nested: {loop_id, round, feedback: {success, score, output}}",
    replay: "loopforge replay <loop-id> — show timeline: round, recompile level, quality, technique, task.",
    diff: "loopforge diff <loop-id> <round-a> <round-b> — field-level comparison between two rounds.",
    review: "loopforge review <loop-id> <round-num> — structural audit of a stored prompt.",
    status: "loopforge status — vault health: entry counts, active loops.",
};
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
function die(msg) {
    process.stderr.write(`loopforge: ${msg}\n`);
    process.exit(1);
}
function showHelp(cmd) {
    if (cmd && CMD_HELP[cmd]) {
        console.log(CMD_HELP[cmd]);
    }
    else {
        console.log(USAGE);
    }
}
async function readStdin() {
    return new Promise((resolve) => {
        const chunks = [];
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        if (process.stdin.isTTY)
            resolve("");
    });
}
function parseJson(raw) {
    try {
        const data = JSON.parse(raw);
        if (typeof data !== "object" || Array.isArray(data) || data === null) {
            die("input must be a JSON object");
        }
        return data;
    }
    catch (e) {
        die(`invalid JSON: ${e instanceof Error ? e.message : e}`);
    }
}
/** Normalise flat fields into feedback payload — accepts both formats. */
function normaliseFeedbackPayload(data) {
    // Already nested: { feedback: { success, score, ... } }
    if (data.feedback && typeof data.feedback === "object") {
        return data.feedback;
    }
    // Flat format: { success, score, output, ... } — auto-nest
    if (data.success !== undefined || data.score !== undefined) {
        return {
            output: data.output ?? "",
            success: data.success ?? false,
            constraint_violations: data.constraint_violations ?? [],
            manual_fixes_needed: data.manual_fixes_needed ?? "",
        };
    }
    return null;
}
// ═══════════════════════════════════════════════════════════════════════════
// Commands
// ═══════════════════════════════════════════════════════════════════════════
async function cmdInit() {
    const backend = new FSBackend();
    const vault = backend.readVault();
    if (!vault.entries || !Array.isArray(vault.entries)) {
        backend.writeVault({ entries: [] });
        console.log("Initialised .promptcraft/prompt_vault.json");
    }
    else {
        const count = vault.entries.length;
        console.log(`Vault already exists (${count} entries). Nothing to do.`);
    }
}
async function cmdCompile(engine, jsonArg) {
    let raw;
    if (jsonArg === "--help" || jsonArg === "-h") {
        showHelp("compile");
        return;
    }
    if (jsonArg) {
        raw = jsonArg;
    }
    else {
        raw = await readStdin();
    }
    if (!raw.trim())
        die("compile requires JSON input (argument or stdin)");
    const data = parseJson(raw);
    const result = engine.invokeLoopCompile({
        task: data.task ?? "",
        mode: "loop_compile",
        vault_config: { ...VAULT_CONFIG },
        feedback: null,
        skill_name: null,
        task_id: null,
        ...data,
    });
    const prompt = result.response?.prompt ?? "Error: no prompt generated";
    console.log(prompt);
}
async function cmdFeedback(engine, jsonArg) {
    if (jsonArg === "--help" || jsonArg === "-h") {
        showHelp("feedback");
        return;
    }
    let raw;
    if (jsonArg) {
        raw = jsonArg;
    }
    else {
        raw = await readStdin();
    }
    if (!raw.trim())
        die("feedback requires JSON input (argument or stdin)");
    const data = parseJson(raw);
    const fbPayload = normaliseFeedbackPayload(data);
    if (!fbPayload) {
        die("feedback requires one of: {feedback:{success,score}} or {success,score} at top level");
    }
    const result = engine.invokeFeedback({
        task: data.task ?? "",
        mode: "feedback",
        vault_config: { ...VAULT_CONFIG },
        feedback: makeExecutionFeedback({
            output: fbPayload.output ?? "",
            success: fbPayload.success ?? false,
            constraint_violations: fbPayload.constraint_violations ?? [],
            manual_fixes_needed: fbPayload.manual_fixes_needed ?? "",
        }),
        skill_name: null,
        task_id: null,
        ...data,
    });
    console.log(result.response?.prompt ?? result.response?.error ?? "Error");
}
function cmdReplay(loopId) {
    if (loopId === "--help" || loopId === "-h") {
        showHelp("replay");
        return;
    }
    if (!loopId)
        die("replay requires a loop-id");
    const backend = new FSBackend();
    const replay = new ReplayBackend(backend);
    const tl = replay.timeline(loopId);
    if (!tl.length) {
        console.log(`No rounds found for loop "${loopId}".`);
        return;
    }
    console.log(`Loop: ${loopId}  (${tl.length} rounds)\n`);
    console.log("Round  Level  Quality  Technique       Task");
    console.log("-----  -----  -------  --------------  ----");
    for (const entry of tl) {
        const rnd = String(entry.round).padStart(5);
        const level = String(entry.recompile_level).padEnd(6);
        const q = String(entry.quality_score ?? "-").padEnd(8);
        const tech = String(entry.technique_used || "-").padEnd(15);
        const task = String(entry.task || "").slice(0, 50);
        console.log(`${rnd}  ${level} ${q} ${tech} ${task}`);
    }
}
function cmdDiff(loopId, roundA, roundB) {
    if (loopId === "--help" || loopId === "-h") {
        showHelp("diff");
        return;
    }
    if (!loopId || !roundA || !roundB) {
        die("diff requires <loop-id> <round-a> <round-b>");
    }
    const backend = new FSBackend();
    const replay = new ReplayBackend(backend);
    const diff = replay.diff(loopId, parseInt(roundA, 10), parseInt(roundB, 10));
    if (diff.missing) {
        console.log(`Cannot diff: ${diff.missing} not found.`);
        return;
    }
    console.log(`Diff: ${loopId}  round ${diff.round_a} → round ${diff.round_b}\n`);
    const changes = diff.changes;
    if (!changes.length) {
        console.log("No changes detected.");
    }
    else {
        for (const c of changes) {
            console.log(`  ${c.label}:`);
            if (c.field === "constraints_active") {
                const added = c.added;
                const removed = c.removed;
                if (added?.length)
                    console.log(`    + added: [${added.join(", ")}]`);
                if (removed?.length)
                    console.log(`    - removed: [${removed.join(", ")}]`);
            }
            else {
                console.log(`    before: ${c.before}`);
                console.log(`    after:  ${c.after}`);
            }
        }
    }
    const unchanged = diff.unchanged;
    if (unchanged?.length) {
        console.log(`\nUnchanged: ${unchanged.join(", ")}`);
    }
}
function cmdReview(loopId, roundStr) {
    if (loopId === "--help" || loopId === "-h") {
        showHelp("review");
        return;
    }
    if (!loopId || !roundStr)
        die("review requires <loop-id> <round-num>");
    const roundNum = parseInt(roundStr, 10);
    if (Number.isNaN(roundNum))
        die(`invalid round number: ${roundStr}`);
    const backend = new FSBackend();
    const engine = createEngine("skills", backend);
    const context = engine.hydrateLoopContext(loopId);
    if (!context) {
        console.log(`No entries found for loop "${loopId}".`);
        return;
    }
    const results = context.results ?? [];
    const target = results.find((r) => {
        const lineage = (r.loop_lineage ?? {});
        return lineage.round === roundNum;
    });
    if (!target) {
        console.log(`Round ${roundNum} not found in loop "${loopId}".`);
        return;
    }
    const result = engine.handleReview({
        task: target.task ?? "review",
        mode: "review",
        vault_config: { ...VAULT_CONFIG },
        feedback: null,
        skill_name: null,
        task_id: null,
    }, { results: [target], global_entries: [] });
    console.log(result.response?.prompt ?? "Review produced no output.");
}
function cmdStatus() {
    const backend = new FSBackend();
    const vault = backend.readVault();
    const entries = vault.entries ?? [];
    const loops = new Set();
    let lineageCount = 0;
    let feedbackCount = 0;
    for (const e of entries) {
        const taskId = String(e.task_id ?? "");
        if (taskId.endsWith(":feedback")) {
            feedbackCount++;
        }
        else if (taskId.startsWith("loop:")) {
            lineageCount++;
        }
        const lid = e.loop_id ?? e.loop_lineage?.loop_id;
        if (lid)
            loops.add(String(lid));
    }
    console.log("LoopForge Vault Status");
    console.log("=======================");
    console.log(`Total entries:   ${entries.length}`);
    console.log(`Lineage entries: ${lineageCount}`);
    console.log(`Feedback entries: ${feedbackCount}`);
    console.log(`Active loops:    ${loops.size}`);
    if (loops.size > 0) {
        console.log(`\nLoops: ${[...loops].sort().join(", ")}`);
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
    const args = process.argv.slice(2);
    const cmd = args[0];
    if (!cmd || cmd === "--help" || cmd === "-h") {
        showHelp(args[1]); // "loopforge --help compile" shows compile help
        process.exit(0);
    }
    if (cmd === "--version" || cmd === "-V") {
        console.log(`loopforge v${VERSION}`);
        process.exit(0);
    }
    const engine = createEngine("skills");
    switch (cmd) {
        case "init":
            if (args[1] === "--help" || args[1] === "-h")
                showHelp("init");
            else
                await cmdInit();
            break;
        case "compile":
            await cmdCompile(engine, args[1]);
            break;
        case "feedback":
            await cmdFeedback(engine, args[1]);
            break;
        case "replay":
            cmdReplay(args[1]);
            break;
        case "diff":
            cmdDiff(args[1], args[2], args[3]);
            break;
        case "review":
            cmdReview(args[1], args[2]);
            break;
        case "status":
            if (args[1] === "--help" || args[1] === "-h")
                showHelp("status");
            else
                cmdStatus();
            break;
        default:
            die(`unknown command: ${cmd}\nUse --help for usage.`);
    }
}
main().catch((err) => {
    process.stderr.write(`loopforge: fatal: ${err.message ?? err}\n`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map