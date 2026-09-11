/** End-to-end MCP integration test.
 *
 * Spawns a real loopforge mcp server subprocess and drives a complete
 * multi-round loop lifecycle through JSON-RPC over stdio:
 *
 *   start → next(accept) → next(reject) → next(accept after retry)
 *   → pause → resume → next(completed) → status → replay → health
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
import { writeMachineBackedPolicy, criterionClaims } from "./_helpers.js";
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
    if (result.content && Array.isArray(result.content)) {
      let prompt: string | undefined;
      for (const item of result.content) {
        const text = (item as Record<string, unknown>).text;
        if (typeof text === "string") {
          try {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            return prompt && parsed.prompt === undefined ? { ...parsed, prompt } : parsed;
          } catch {
            prompt ??= text;
          }
        }
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
    // v3.3: the CLI subprocess loads policy from its own cwd — write a
    // machine-backed policy (passing verification command) so success
    // claims with self-reported test results are not rejected by R8.
    writeMachineBackedPolicy(storeDir);
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
    // v3.7.1: seven tools are always exposed; the two gate tools are
    // opt-in (policy.gate.enabled) and hidden by default.
    assert.ok(tools.length >= 7, `expected >=7 tools, got ${tools.length}`);
    const names = tools.map((t) => t.name);
    for (const expected of [
      "loopforge_start",
      "loopforge_next",
      "loopforge_status",
      "loopforge_stop",
      "loopforge_pause",
      "loopforge_replay",
      "loopforge_resume",
    ]) {
      assert.ok(names.includes(expected), `tool ${expected} must be registered`);
    }
    assert.ok(!names.includes("loopforge_gate_check"), "gate_check hidden by default");
    assert.ok(!names.includes("loopforge_gate_resolve"), "gate_resolve hidden by default");
  });

  // ── Round 1: Start ──────────────────────────────────────────────────────────

  let sessionId: string;
  let loopId: string;
  /** v3.0.1: the roundId of the current round — threaded through every next call. */
  let roundId: string;

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
    roundId = String(result.roundId);
    // Extract loopId from the status query, which has a stable loopId field.
    const status = await client.tool("loopforge_status", { sessionId });
    loopId = String(status.loopId ?? "");
    assert.ok(loopId.length > 0, "loopId must be non-empty");
  });

  // ── Round 2: Successful work ────────────────────────────────────────────────

  it("round 2 — loopforge_next accepts honest work and advances", async () => {
    const result = await client.tool("loopforge_next", {
      sessionId,
      roundId,
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
        execution_report: {
          files_changed: ["src/verification-gate.ts"],
          tests_reported: { passed: 243, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims(["Audited verification-gate.ts"]),
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
    // Move the anchor to round 2 — the accepted submission advanced the loop.
    roundId = String(result.roundId);
  });

  // ── Round 2 (attempt 2): Constraint violation → rejected ────────────────────

  it("enforcement rejects a round that violates a constraint", async () => {
    // Agent claims success but admits violating a constraint AND leaves
    // success criteria unmet — this triggers rejection via the combined
    // verification checks.
    const result = await client.tool("loopforge_next", {
      sessionId,
      roundId,
      evaluation: {
        success: true,
        output_summary: "Changed internal function signature.",
        should_continue: true,
        constraint_violations: ["Do not change the public API"],
        execution_report: {
          files_changed: [],
          tests_reported: { passed: 0, failed: 5, skipped: 0 },
          criterion_claims: criterionClaims([], [
            "Fix any confirmed correctness bugs",
            "Preserve the public API",
          ]),
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
    // Rejection keeps the logical round — the roundId anchor stays put.
    assert.equal(result.roundId, roundId);
  });

  // ── Round 2 (attempt 3): Redo with honest evaluation → accepted ─────────────

  it("retry — redo rejected work honestly and get accepted", async () => {
    const result = await client.tool("loopforge_next", {
      sessionId,
      roundId,
      evaluation: {
        success: false,
        output_summary:
          "Reverted the accidental public API change. Restored original signatures. Tests pass.",
        should_continue: true,
        constraint_violations: [],
        discovered_constraints: [],
        execution_report: {
          files_changed: ["src/verification-gate.ts"],
          tests_reported: { passed: 243, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims(["Preserve the public API — verified restored"]),
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
    // The accepted retry advanced the loop — re-anchor.
    roundId = String(result.roundId);
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
    // Resume returns the anchor for the round it hands over.
    roundId = String(result.roundId);
  });

  // ── Final round: Task complete ──────────────────────────────────────────────

  it("final round — completed when should_continue=false", async () => {
    const result = await client.tool("loopforge_next", {
      sessionId,
      roundId,
      evaluation: {
        success: true,
        output_summary:
          "Completed audit of verification-gate.ts. All checks verified, no " +
          "correctness bugs found. All constraints preserved. All tests pass.",
        should_continue: false,
        constraint_violations: [],
        execution_report: {
          files_changed: ["src/verification-gate.ts"],
          tests_reported: { passed: 243, failed: 0, skipped: 0 },
          success_criteria_met: [
            "Audited verification-gate.ts",
            "Fix any confirmed correctness bugs — none found",
            "Preserve the public API",
          ],
          criterion_claims: criterionClaims([], []),
          progress_estimate: 1.0,
        },
      },
    });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    // A completed loop returns a stop reason and no prompt.
    assert.ok(
      result.stopReason === "completed",
      `expected completed stopReason, got ${String(result.stopReason)}`,
    );
    assert.equal(result.prompt, null);
  });

  // ── Post-completion inspection ──────────────────────────────────────────────

  it("status reflects completed state", async () => {
    const result = await client.tool("loopforge_status", { sessionId });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    // After completion, status should be "stopped".
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

  it("health returns machine counts for the loop", async () => {
    const result = await client.tool("loopforge_status", { loopId, view: "loop" });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    // v3.8.1: counted facts only — the alignment/continuity/drift scores are
    // gone with the rest of the text-similarity verdicts.
    assert.ok(typeof result.loopId === "string");
    assert.equal(typeof result.committed_rounds, "number");
    assert.equal(typeof result.rounds_with_unverified_items, "number");
  });

  it("loopforge_list includes the completed session", async () => {
    const result = await client.tool("loopforge_status", { view: "all" });

    assert.ok(!result.error, `unexpected error: ${String(result.error)}`);
    const sessions = result.sessions as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sessions), "sessions must be an array");
    const found = sessions.find((s) => s.loopId === loopId || s.sessionId === sessionId);
    assert.ok(found, "completed loop must appear in list");
  });
});
