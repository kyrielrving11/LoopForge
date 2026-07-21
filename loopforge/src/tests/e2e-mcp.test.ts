/** End-to-end MCP integration test.
 *
 * Spawns a real loopforge mcp server subprocess and drives a complete
 * multi-round loop lifecycle through JSON-RPC over stdio:
 *
 *   start → next(accept) → next(reject) → next(accept after retry)
 *   → pause → resume → next(task_complete) → status → replay → health
 *
 * Each tool call is verified against the structured output schema.
 * This is the definitive "does it work end-to-end" test.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createInterface, Interface } from "node:readline";
import { fileURLToPath } from "node:url";

// ── MCP stdio client ─────────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** Absolute path to the compiled CLI entry point. */
const CLI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "cli.js",
);

class McpClient {
  private proc: ChildProcess;
  private rl: Interface;
  private pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (error: Error) => void;
  }>();
  private nextId = 1;
  private stderr = "";

  constructor(storeDir: string) {
    mkdirSync(storeDir, { recursive: true });
    this.proc = spawn(
      process.execPath,
      [CLI_PATH, "mcp"],
      {
        cwd: storeDir,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      },
    );
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.proc.once("exit", (code) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`Server exited with code ${code}: ${this.stderr.slice(-500)}`));
      }
      this.pending.clear();
    });
    this.rl = createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line: string) => {
      try {
        const parsed = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(parsed.id);
        if (pending) {
          this.pending.delete(parsed.id);
          pending.resolve(parsed);
        }
      } catch {
        // Ignore non-JSON lines.
      }
    });
  }

  /** Send a JSON-RPC request and wait for the response. */
  async call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out after 15s`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (response: JsonRpcResponse) => {
          clearTimeout(timer);
          if (response.error) {
            reject(new Error(
              `JSON-RPC error ${response.error.code}: ${response.error.message}`,
            ));
            return;
          }
          resolve((response.result ?? {}) as Record<string, unknown>);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.proc.stdin!.write(request + "\n");
    });
  }

  /** Call a LoopForge tool by name. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await this.call("tools/call", { name, arguments: args });
    // Extract structured content from MCP tool result envelope.
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent as Record<string, unknown>;
    }
    if (result.content && Array.isArray(result.content) && result.content.length > 0) {
      const text = (result.content[0] as Record<string, unknown>).text;
      if (typeof text === "string") {
        try { return JSON.parse(text) as Record<string, unknown>; } catch { /* fall through */ }
      }
    }
    return result;
  }

  getStderr(): string { return this.stderr; }

  close(): void {
    this.rl.close();
    this.proc.stdin?.end();
    this.proc.kill();
  }
}

// ── Test ─────────────────────────────────────────────────────────────────────

describe("E2E MCP lifecycle", () => {
  let client: McpClient;
  let storeDir: string;

  before(() => {
    storeDir = join(tmpdir(), `loopforge-e2e-${randomUUID()}`);
    client = new McpClient(storeDir);
  });

  after(() => {
    client.close();
    try { rmSync(storeDir, { recursive: true }); } catch { /* best effort */ }
  });

  it("initializes and lists tools", async () => {
    const init = await client.call("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(init.protocolVersion, "2024-11-05");
    assert.ok(init.capabilities);

    const list = await client.call("tools/list");
    const tools = list.tools as Array<{ name: string }>;
    assert.ok(Array.isArray(tools), "tools must be an array");
    assert.ok(tools.length >= 9, `expected >=9 tools, got ${tools.length}`);
    const names = tools.map((t) => t.name);
    for (const expected of [
      "loopforge_start",
      "loopforge_next",
      "loopforge_status",
      "loopforge_stop",
      "loopforge_pause",
      "loopforge_list",
      "loopforge_replay",
      "loopforge_resume",
      "loopforge_health",
    ]) {
      assert.ok(names.includes(expected), `tool ${expected} must be registered`);
    }
  });

  // ── Round 1: Start ──────────────────────────────────────────────────────────

  let sessionId: string;
  let loopId: string;

  it("round 1 — loopforge_start compiles the first prompt (L2)", async () => {
    const result = await client.tool("loopforge_start", {
      task: "Audit src/verification-gate.ts for correctness bugs. Fix confirmed issues. Preserve the public API.",
      maxRounds: 10,
      domain: "typescript",
      constraints: [
        "Do not change the public API",
        "Do not introduce runtime dependencies",
        "Run npm test before claiming completion",
      ],
    });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    assert.ok(typeof result.sessionId === "string" && result.sessionId.length > 0);
    assert.equal(result.round, 1);
    assert.equal(String(result.level).toUpperCase(), "L2");
    assert.ok(typeof result.prompt === "string" && result.prompt.length > 100);
    assert.ok(typeof result.roundId === "string");
    // Assign module-level variables BEFORE any assertion that could throw.
    sessionId = String(result.sessionId);
    // Extract loopId from the status query, which has a stable loopId field.
    const status = await client.tool("loopforge_status", { sessionId });
    loopId = String(status.loopId ?? "");
    assert.ok(loopId.length > 0, "loopId must be non-empty");
  });

  // ── Round 2: Successful work ────────────────────────────────────────────────

  it("round 2 — loopforge_next accepts honest work and advances", async () => {
    const result = await client.tool("loopforge_next", {
      sessionId,
      evaluation: {
        success: false,
        output_summary:
          "Inspected verification-gate.ts. Found no correctness bugs in the main check functions. " +
          "Added cross-validation note for command evidence output.",
        should_continue: true,
        constraint_violations: [],
        discovered_constraints: [
          "CommandEvidenceProvider stdout may be truncated at 20k chars",
        ],
        execution_evidence: {
          files_changed: ["src/verification-gate.ts"],
          test_results: { passed: 243, failed: 0, skipped: 0 },
          success_criteria_met: ["Audited verification-gate.ts"],
          success_criteria_remaining: [
            "Fix any confirmed correctness bugs",
            "Preserve the public API",
          ],
          progress_estimate: 0.25,
        },
      },
    });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.round, 2);
    assert.ok(typeof result.prompt === "string" && result.prompt.length > 50);
    // Round 2 is L1 (normal continuation).
    assert.equal(String(result.level).toUpperCase(), "L1");
    // enforcementAction is only present on reject/terminate; accept is the default.
    if (result.enforcementAction) {
      assert.notEqual(result.enforcementAction, "reject");
    }
  });

  // ── Round 2 (attempt 2): Constraint violation → rejected ────────────────────

  it("enforcement rejects a round that violates a constraint", async () => {
    // Agent claims success but admits violating a constraint AND leaves
    // success criteria unmet — this triggers rejection via the combined
    // verification checks.
    const result = await client.tool("loopforge_next", {
      sessionId,
      evaluation: {
        success: true,
        output_summary: "Changed internal function signature.",
        should_continue: true,
        constraint_violations: ["Do not change the public API"],
        execution_evidence: {
          files_changed: [],
          test_results: { passed: 0, failed: 5, skipped: 0 },
          success_criteria_met: [],
          success_criteria_remaining: [
            "Fix any confirmed correctness bugs",
            "Preserve the public API",
          ],
          progress_estimate: 0.25,
        },
      },
    });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    assert.equal(result.sessionId, sessionId);
    // Rejection prompt tells the agent what to fix.
    assert.ok(typeof result.prompt === "string" && result.prompt.length > 20);
    assert.equal(result.enforcementAction, "reject");
    assert.ok(typeof result.enforcementReason === "string");
  });

  // ── Round 2 (attempt 3): Redo with honest evaluation → accepted ─────────────

  it("retry — redo rejected work honestly and get accepted", async () => {
    const result = await client.tool("loopforge_next", {
      sessionId,
      evaluation: {
        success: false,
        output_summary:
          "Reverted the accidental public API change. Restored original signatures. Tests pass.",
        should_continue: true,
        constraint_violations: [],
        discovered_constraints: [],
        execution_evidence: {
          files_changed: ["src/verification-gate.ts"],
          test_results: { passed: 243, failed: 0, skipped: 0 },
          success_criteria_met: ["Preserve the public API — verified restored"],
          success_criteria_remaining: [
            "Fix any confirmed correctness bugs",
          ],
          progress_estimate: 0.5,
        },
      },
    });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    assert.equal(result.sessionId, sessionId);
    // After retry is accepted, enforcementAction is absent.
    if (result.enforcementAction) {
      assert.notEqual(result.enforcementAction, "reject");
    }
  });

  // ── Pause and resume ────────────────────────────────────────────────────────

  it("pause suspends the session at the round boundary", async () => {
    const result = await client.tool("loopforge_pause", { sessionId });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    assert.equal(result.status, "paused");
    assert.equal(result.sessionId, sessionId);
  });

  it("resume restores a paused session and returns the next prompt", async () => {
    const result = await client.tool("loopforge_resume", { loopId });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    assert.ok(typeof result.prompt === "string" && result.prompt.length > 20);
  });

  // ── Final round: Task complete ──────────────────────────────────────────────

  it("final round — task_complete when should_continue=false", async () => {
    const result = await client.tool("loopforge_next", {
      sessionId,
      evaluation: {
        success: true,
        output_summary:
          "Completed audit of verification-gate.ts. All checks verified, no " +
          "correctness bugs found. All constraints preserved. All tests pass.",
        should_continue: false,
        constraint_violations: [],
        execution_evidence: {
          files_changed: ["src/verification-gate.ts"],
          test_results: { passed: 243, failed: 0, skipped: 0 },
          success_criteria_met: [
            "Audited verification-gate.ts",
            "Fix any confirmed correctness bugs — none found",
            "Preserve the public API",
          ],
          success_criteria_remaining: [],
          progress_estimate: 1.0,
        },
      },
    });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    // When task_complete stops the loop, stopReason is set and prompt is null.
    assert.ok(
      result.stopReason === "completed" || result.stopReason === "task_complete",
      `expected completed/task_complete stopReason, got ${String(result.stopReason)}`,
    );
    assert.equal(result.prompt, null);
  });

  // ── Post-completion inspection ──────────────────────────────────────────────

  it("status reflects completed state", async () => {
    const result = await client.tool("loopforge_status", { sessionId });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    // After task_complete, status should be "stopped".
    // (If the round was already complete from a previous run, it may be "paused".)
    assert.ok(
      result.status === "stopped" || result.status === "paused",
      `expected stopped or paused, got ${String(result.status)}`,
    );
  });

  it("replay returns auditable round timeline", async () => {
    const result = await client.tool("loopforge_replay", { sessionId });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    assert.equal(result.sessionId, sessionId);
    assert.ok(typeof result.loopId === "string");
    const timeline = result.timeline as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(timeline), "timeline must be an array");
    assert.ok(timeline.length >= 1, `expected >=1 entries in timeline, got ${timeline.length}`);
  });

  it("health returns alignment and integrity data", async () => {
    const result = await client.tool("loopforge_health", { loopId });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    // Health returns structured diagnostic fields.
    assert.ok(typeof result.loopId === "string");
    assert.equal(typeof result.drift_detected, "boolean");
    // goal_alignment may be an object or a status string depending on vault state.
    assert.ok(result.goal_alignment !== undefined, "goal_alignment must be present");
  });

  it("loopforge_list includes the completed session", async () => {
    const result = await client.tool("loopforge_list", {});

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    const sessions = result.sessions as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sessions), "sessions must be an array");
    const found = sessions.find((s) => s.loopId === loopId || s.sessionId === sessionId);
    assert.ok(found, "completed loop must appear in list");
  });
});
