/** LoopForge-loop_compile — Sub-agent adapter (unified entry point).
 *
 * This is the single entry point when LoopForge is invoked as a sub-agent.
 * It wraps the Engine, routes by mode, and always prepends a compact health line.
 *
 * Three modes (v1.0):
 *     loop_compile — Per-iteration prompt compiler (primary entry point)
 *     feedback     — Record execution results → quality scoring → vault persistence
 *     review       — Audit prompt quality (structural checks + constraint compliance)
 *
 * build is an internal path (loop_compile L2 delegation) — not an exposed mode.
 */
import { AgentStatus, makeVaultConfig, Mode, } from "./protocol.js";
import { createEngine, } from "./engine.js";
// ═══════════════════════════════════════════════════════════════════════════
// Mode mapping
// ═══════════════════════════════════════════════════════════════════════════
const MODE_MAP = {
    loop_compile: Mode.LOOP_COMPILE,
    feedback: Mode.FEEDBACK,
    review: Mode.REVIEW,
    build: Mode.BUILD,
};
// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════
export function handle(requestInput, engine) {
    // Parse request
    let rawMode;
    let rawData = null;
    let request;
    if (typeof requestInput === "string") {
        rawData = JSON.parse(requestInput);
        rawMode = rawData.mode ?? "build";
    }
    else if (isLoopForgeRequest(requestInput)) {
        rawMode =
            typeof requestInput.mode === "string"
                ? requestInput.mode
                : requestInput.mode;
        request = requestInput;
        rawData = null;
    }
    else {
        rawData = requestInput;
        rawMode = rawData.mode ?? "build";
    }
    if (rawData !== null) {
        request = parseRequest(rawData);
    }
    else {
        request = requestInput;
    }
    // Normalise mode for engine
    const engineMode = MODE_MAP[rawMode];
    if (!engineMode) {
        return JSON.stringify({
            health: "[PC: 0 records, normal]",
            status: "error",
            result: { mode: rawMode, error: `Unknown mode: ${rawMode}` },
        }, null, 2);
    }
    if (rawData !== null) {
        request.mode = engineMode;
    }
    // Inline input validation
    const task = request.task || "";
    if (!task.trim()) {
        return JSON.stringify({
            health: "[PC: 0 records, normal]",
            status: "error",
            result: { mode: rawMode, error: "Task is required." },
        }, null, 2);
    }
    // Initialise engine
    if (!engine) {
        const skillsDir = request.vault_config?.skills_dir ?? "skills";
        engine = createEngine(skillsDir);
    }
    // Execute via dedicated engine method
    const result = routeToEngine(engine, request);
    // Build compact health line
    const healthLine = compactHealth(engine);
    // Build and return response
    return buildAgentResponse(result, healthLine, rawMode);
}
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
function routeToEngine(engine, request) {
    const mode = request.mode;
    if (mode === Mode.LOOP_COMPILE) {
        return engine.invokeLoopCompile(request);
    }
    if (mode === Mode.FEEDBACK) {
        return engine.invokeFeedback(request);
    }
    if (mode === Mode.REVIEW) {
        return engine.handleReview(request);
    }
    if (mode === Mode.BUILD) {
        return engine.invokeBuild(request);
    }
    return {
        status: AgentStatus.ERROR,
        response: null,
    };
}
function isLoopForgeRequest(obj) {
    return (typeof obj === "object" &&
        obj !== null &&
        "mode" in obj &&
        typeof obj.mode === "string" &&
        [Mode.LOOP_COMPILE, Mode.FEEDBACK, Mode.REVIEW, Mode.BUILD].includes(obj.mode));
}
function parseRequest(raw) {
    // Normalise mode
    const modeStr = raw.mode ?? "build";
    const validModes = new Set(Object.values(Mode));
    const mode = validModes.has(modeStr)
        ? modeStr
        : Mode.BUILD;
    // Known LoopForgeRequest fields
    const knownFields = new Set([
        "task", "mode", "vault_config", "feedback", "skill_name", "task_id",
    ]);
    const base = {};
    const extras = {};
    for (const [key, value] of Object.entries(raw)) {
        if (knownFields.has(key)) {
            base[key] = value;
        }
        else {
            extras[key] = value;
        }
    }
    const req = {
        task: base.task ?? "",
        mode: mode,
        vault_config: makeVaultConfig(base.vault_config),
        feedback: base.feedback ?? null,
        skill_name: base.skill_name ?? null,
        task_id: base.task_id ?? null,
    };
    // Attach extras
    Object.assign(req, extras);
    return req;
}
function compactHealth(engine) {
    const recordCount = engine.state?.quality_trend.length ?? 0;
    const stalled = engine.state ? engine.shouldBreak() : false;
    const status = stalled ? "STALLED" : "normal";
    const parts = [`PC: ${recordCount} records`, status];
    const m = engine._metrics ??
        engine.metrics;
    if (m) {
        if (m.vaultWriteErrors)
            parts.push(`write_err=${m.vaultWriteErrors}`);
        if (m.vaultWriteTimeouts)
            parts.push(`write_timeout=${m.vaultWriteTimeouts}`);
        if (m.hydrateCacheMisses)
            parts.push(`cache_miss=${m.hydrateCacheMisses}`);
    }
    return "[" + parts.join(", ") + "]";
}
function buildAgentResponse(result, healthLine, mode) {
    let promptOrOverlay = null;
    let analysis = null;
    let techniqueUsed = null;
    if (result.response) {
        const r = result.response;
        promptOrOverlay = r.prompt;
        if (r.analysis) {
            analysis = r.analysis;
            techniqueUsed = r.analysis.technique;
        }
    }
    // Inline output size guard
    let promptText = promptOrOverlay || "";
    if (promptText.length > 32_000) {
        promptText = promptText.slice(0, 32_000) + "\n\n[truncated — exceeds 32KB]";
    }
    const payload = {
        mode: mode || "unknown",
        prompt_or_overlay: promptText,
        analysis,
        technique_used: techniqueUsed,
        confidence: 0.0,
        proactive_signals: [],
    };
    const output = {
        health: healthLine,
        status: result.status,
        result: payload,
    };
    return JSON.stringify(output, null, 2);
}
// ═══════════════════════════════════════════════════════════════════════════
// CLI entry point
// ═══════════════════════════════════════════════════════════════════════════
export function main() {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (!raw.trim()) {
            process.stdout.write(JSON.stringify({ status: "error", error: "No input provided." }) + "\n");
            process.exit(1);
        }
        try {
            const output = handle(raw);
            process.stdout.write(output + "\n");
        }
        catch (exc) {
            process.stdout.write(JSON.stringify({
                health: "[PC: 0 records, normal]",
                status: "error",
                result: { error: String(exc) },
            }, null, 2) + "\n");
            process.exit(1);
        }
    });
}
// Allow direct execution
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
    main();
}
//# sourceMappingURL=adapter.js.map