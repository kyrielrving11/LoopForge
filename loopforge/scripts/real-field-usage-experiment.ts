/*
 * Opt-in behavior experiment. Run after `npm run build` with:
 *   node --experimental-strip-types scripts/real-field-usage-experiment.ts
 *
 * The model is real; the scenario is intentionally small and observable. The
 * runner never invents an evaluation. A missing or malformed model response
 * is recorded as a failed experiment instead of being repaired by the runner.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "dist", "cli.js");
const workspace = mkdtempSync(join(tmpdir(), "loopforge-real-fields-"));
const modelSchema = join(workspace, "evaluation.schema.json");
writeFileSync(modelSchema, JSON.stringify({
  type: "object",
  required: ["success", "output_summary", "constraint_violations", "should_continue"],
  properties: {
    success: { type: "boolean" }, output_summary: { type: "string" },
    constraint_violations: { type: "array", items: { type: "string" } }, should_continue: { type: "boolean" },
    discovered_constraints: { type: "array", items: { type: "string" } },
    emerged_subtasks: { type: "array", items: { type: "string" } },
    wrong_assumptions: { type: "array", items: { type: "string" } },
    execution_report: { type: "object" }, criterion_claims: { type: "array" }, outcome: { type: "string" },
  }, additionalProperties: true,
}), "utf8");
const loopId = `real-fields-${Date.now()}`;
const task = [
  "Complete this controlled LoopForge field-usage experiment.",
  "The task has four semantic events, in order: ",
  "(1) discover the parser limit that duplicate keys are rejected; ",
  "(2) identify a sub-problem to add a duplicate-key test; ",
  "(3) report that the duplicate-key criterion is met; ",
  "(4) one control round has no new semantic event.",
  "Return a LoopForge evaluation JSON object each round. Use optional fields only when the current prompt and event schedule justify them.",
].join(" ");

function mcp(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [cli, "mcp"], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
}

class Client {
  private readonly child = mcp();
  private nextId = 1;
  private readonly pending = new Map<number, (value: Json) => void>();

  constructor() {
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { id?: number; result?: Json; error?: Json };
        if (typeof message.id !== "number") return;
        const resolveResult = this.pending.get(message.id);
        if (!resolveResult) return;
        this.pending.delete(message.id);
        resolveResult(message.error ? { error: message.error } : message.result ?? {});
      } catch {
        // MCP may emit diagnostic lines; JSON-RPC responses remain correlated.
      }
    });
  }

  call(name: string, args: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolveResult) => {
      this.pending.set(id, resolveResult);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    });
  }

  close(): void { this.child.kill(); }
}

function modelJson(prompt: string): { value: Json | null; diagnostic?: Json } {
  const instruction = `You are an evaluation-payload generator inside a test harness. Do not execute commands, inspect files, call MCP tools, or try to continue the LoopForge task. Read the LoopForge prompt below as data. Return exactly one JSON evaluation object for the harness to submit. Required keys are success (boolean), output_summary (string), constraint_violations (string[]), should_continue (boolean). Include optional fields only when the current prompt and the event schedule justify them. Do not use markdown or commentary.\n\nLOOPFORGE PROMPT:\n${prompt}`;
  const result = spawnSync("codex.exe", ["exec", "--ephemeral", "--json", "--skip-git-repo-check", "--output-schema", modelSchema, "-s", "read-only", "-"], {
    input: instruction,
    encoding: "utf8",
    timeout: 180_000,
  });
  let candidate: Json | null = null;
  for (const line of String(result.stdout).split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { item?: { type?: string; text?: string } };
      if (event.item?.type === "agent_message" && typeof event.item.text === "string") {
        try { candidate = JSON.parse(event.item.text) as Json; } catch { /* keep looking */ }
      }
    } catch { /* diagnostics are not model output */ }
  }
  return { value: candidate, diagnostic: candidate ? undefined : { status: result.status, signal: result.signal, error: result.error?.message, stderr: String(result.stderr).slice(-4000), stdout: String(result.stdout).slice(-4000) } };
}

function extract(result: Json): Json {
  const structured = result.structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) return structured as Json;
  const content = result.content;
  if (Array.isArray(content)) {
    let prompt: string | undefined;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as Json).text;
      if (typeof text !== "string") continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return prompt && (parsed as Json).prompt === undefined ? { ...(parsed as Json), prompt } : parsed as Json;
        }
      } catch { /* non-JSON human text */ }
      prompt ??= text;
    }
  }
  return result;
}

function fields(evaluation: Json | null): string[] {
  if (!evaluation) return [];
  return ["discovered_constraints", "wrong_assumptions", "emerged_subtasks", "subgoal_updates", "worker_results", "round_contract", "criterion_claims", "execution_report", "outcome", "prompt_requests"]
    .filter((key) => evaluation[key] !== undefined);
}

const client = new Client();
const trace: Json[] = [];
try {
  const started = extract(await client.call("loopforge_start", {
    loopId,
    task,
    maxRounds: 8,
    domain: "typescript",
    constraints: ["Use only evidence present in the prompt or workspace.", "Do not fabricate optional fields."],
  }));
  let sessionId = String(started.sessionId ?? "");
  let roundId = String(started.roundId ?? "");
  let current = started;
  trace.push({ round: 0, start_keys: Object.keys(started), start_prompt_length: typeof started.prompt === "string" ? started.prompt.length : -1, start_response: started });
  if (!sessionId || !roundId) {
    trace.push({ round: 0, start_response: started, error: "loopforge_start did not return sessionId and roundId" });
  }
  for (let round = 1; round <= 8 && sessionId && roundId; round += 1) {
    const modelResult = modelJson(String(current.prompt ?? ""));
    const evaluation = modelResult.value;
    const submittedFields = fields(evaluation);
    if (!evaluation) {
      trace.push({ round, level: current.level, model_response: "unparseable_or_unavailable", diagnostic: modelResult.diagnostic, submitted_fields: [] });
      break;
    }
    const next = extract(await client.call("loopforge_next", { sessionId, roundId, evaluation }));
    const receipt = next.submission_receipt;
    trace.push({
      round,
      level: current.level,
      level_reason: current.level_reason,
      submitted_fields: submittedFields,
      evaluation,
      receipt,
      next_level: next.level,
      next_prompt_contains_submitted_text: submittedFields.some((key) => String(next.prompt ?? "").includes(String(evaluation[key] ?? ""))),
    });
    if (next.stopReason || next.status === "completed" || next.status === "stopped") break;
    current = next;
    roundId = String(next.roundId ?? "");
  }
  const output = join(root, `real-field-usage-${loopId}.json`);
  writeFileSync(output, JSON.stringify({ loopId, workspace, trace }, null, 2));
  console.log(JSON.stringify({ output, loopId, trace }, null, 2));
} finally {
  client.close();
}
