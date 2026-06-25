/** PromptCraft-loop_compile — Sub-agent adapter (unified entry point).
 *
 * This is the single entry point when PromptCraft is invoked as a sub-agent.
 * It wraps the Engine, routes by mode, and always prepends a compact health line.
 *
 * Three modes (v1.0):
 *     loop_compile — Per-iteration prompt compiler (primary entry point)
 *     feedback     — Record execution results → quality scoring → vault persistence
 *     review       — Audit prompt quality (structural checks + constraint compliance)
 *
 * build is an internal path (loop_compile L2 delegation) — not an exposed mode.
 *
 * Python reference: subagent_adapter.py (~282 lines)
 */

import {
  AgentStatus,
  makeVaultConfig,
  Mode,
  type AgentLoopResult,
  type PromptCraftRequest,
} from "./protocol.js";
import {
  PromptCraftEngine,
  createEngine,
  type EngineMetrics,
} from "./engine.js";

// ═══════════════════════════════════════════════════════════════════════════
// Mode mapping
// ═══════════════════════════════════════════════════════════════════════════

const MODE_MAP: Record<string, Mode> = {
  loop_compile: Mode.LOOP_COMPILE,
  feedback: Mode.FEEDBACK,
  review: Mode.REVIEW,
  build: Mode.BUILD,
};

// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════

export function handle(
  requestInput: string | Record<string, unknown> | PromptCraftRequest,
  engine?: PromptCraftEngine,
): string {
  // Parse request
  let rawMode: string;
  let rawData: Record<string, unknown> | null = null;
  let request: PromptCraftRequest;

  if (typeof requestInput === "string") {
    rawData = JSON.parse(requestInput) as Record<string, unknown>;
    rawMode = (rawData.mode as string) ?? "build";
  } else if (isPromptCraftRequest(requestInput)) {
    rawMode =
      typeof requestInput.mode === "string"
        ? requestInput.mode
        : requestInput.mode;
    request = requestInput;
    rawData = null;
  } else {
    rawData = requestInput;
    rawMode = (rawData.mode as string) ?? "build";
  }

  if (rawData !== null) {
    request = parseRequest(rawData);
  } else {
    request = requestInput as unknown as PromptCraftRequest;
  }

  // Normalise mode for engine
  const engineMode = MODE_MAP[rawMode];
  if (!engineMode) {
    return JSON.stringify(
      {
        health: "[PC: 0 records, normal]",
        status: "error",
        result: { mode: rawMode, error: `Unknown mode: ${rawMode}` },
      },
      null,
      2,
    );
  }
  if (rawData !== null) {
    request.mode = engineMode;
  }

  // Inline input validation
  const task = request.task || "";
  if (!task.trim()) {
    return JSON.stringify(
      {
        health: "[PC: 0 records, normal]",
        status: "error",
        result: { mode: rawMode, error: "Task is required." },
      },
      null,
      2,
    );
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

function routeToEngine(
  engine: PromptCraftEngine,
  request: PromptCraftRequest,
): AgentLoopResult {
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

function isPromptCraftRequest(
  obj: unknown,
): obj is PromptCraftRequest {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "mode" in obj &&
    typeof (obj as Record<string, unknown>).mode === "string" &&
    [Mode.LOOP_COMPILE, Mode.FEEDBACK, Mode.REVIEW, Mode.BUILD].includes(
      (obj as Record<string, unknown>).mode as Mode,
    )
  );
}

function parseRequest(
  raw: Record<string, unknown>,
): PromptCraftRequest {
  // Normalise mode
  const modeStr = (raw.mode as string) ?? "build";
  const validModes = new Set(Object.values(Mode));
  const mode: Mode = validModes.has(modeStr as Mode)
    ? (modeStr as Mode)
    : Mode.BUILD;

  // Known PromptCraftRequest fields
  const knownFields = new Set([
    "task", "mode", "vault_config", "feedback", "skill_name", "task_id",
  ]);

  const base: Record<string, unknown> = {};
  const extras: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (knownFields.has(key)) {
      base[key] = value;
    } else {
      extras[key] = value;
    }
  }

  const req: PromptCraftRequest = {
    task: (base.task as string) ?? "",
    mode: mode,
    vault_config: makeVaultConfig(base.vault_config as Partial<import("./protocol.js").VaultConfig> | undefined),
    feedback: (base.feedback as PromptCraftRequest["feedback"]) ?? null,
    skill_name: (base.skill_name as string) ?? null,
    task_id: (base.task_id as string) ?? null,
  };

  // Attach extras
  Object.assign(req, extras);

  return req;
}

function compactHealth(engine: PromptCraftEngine): string {
  const recordCount = engine.state?.quality_trend.length ?? 0;
  const stalled = engine.state ? engine.shouldBreak() : false;
  const status = stalled ? "STALLED" : "normal";

  const parts = [`PC: ${recordCount} records`, status];

  const m = (engine as unknown as { _metrics?: EngineMetrics })._metrics ??
    (engine as unknown as { metrics?: EngineMetrics }).metrics;
  if (m) {
    if (m.vaultWriteErrors) parts.push(`write_err=${m.vaultWriteErrors}`);
    if (m.vaultWriteTimeouts) parts.push(`write_timeout=${m.vaultWriteTimeouts}`);
    if (m.hydrateCacheMisses) parts.push(`cache_miss=${m.hydrateCacheMisses}`);
  }

  return "[" + parts.join(", ") + "]";
}

function buildAgentResponse(
  result: AgentLoopResult,
  healthLine: string,
  mode: string,
): string {
  let promptOrOverlay: string | null = null;
  let analysis: Record<string, unknown> | null = null;
  let techniqueUsed: string | null = null;

  if (result.response) {
    const r = result.response;
    promptOrOverlay = r.prompt;
    if (r.analysis) {
      analysis = r.analysis as unknown as Record<string, unknown>;
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
    proactive_signals: [] as string[],
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

export function main(): void {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    if (!raw.trim()) {
      process.stdout.write(
        JSON.stringify({ status: "error", error: "No input provided." }) + "\n",
      );
      process.exit(1);
    }

    try {
      const output = handle(raw);
      process.stdout.write(output + "\n");
    } catch (exc) {
      process.stdout.write(
        JSON.stringify(
          {
            health: "[PC: 0 records, normal]",
            status: "error",
            result: { error: String(exc) },
          },
          null,
          2,
        ) + "\n",
      );
      process.exit(1);
    }
  });
}

// Allow direct execution
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
