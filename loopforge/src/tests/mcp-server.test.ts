/** Process-level tests for the JSON-RPC stdio boundary. */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface RpcResponse {
  id?: string | number | null;
  result?: {
    serverInfo?: { name?: string };
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    instructions?: string;
  };
  error?: { code?: number };
}

function spawnRpcServer() {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), "mcp"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (response: Record<string, unknown>) => void>();
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const response = JSON.parse(line) as Record<string, unknown>;
      const id = response.id;
      if (typeof id === "number") {
        pending.get(id)?.(response);
        pending.delete(id);
      }
    }
  });
  return {
    child,
    request(method: string, params: Record<string, unknown> = {}) {
      const id = nextId++;
      return new Promise<Record<string, unknown>>((resolveResponse, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }, 5000);
        pending.set(id, (response) => {
          clearTimeout(timeout);
          resolveResponse(response);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async close() {
      child.stdin.end();
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    },
  };
}

describe("MCP stdio input boundary", () => {
  it("rejects primitive JSON without crashing the server", async () => {
    const child = spawn(process.execPath, [resolve("dist/cli.js"), "mcp"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", resolveExit);
    });

    child.stdin.write("null\n");
    child.stdin.write("[]\n");
    child.stdin.write("1\n");
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    })}\n`);
    child.stdin.end();

    const timeout = setTimeout(() => child.kill(), 5_000);
    const code = await exited;
    clearTimeout(timeout);

    assert.equal(code, 0, stderr);
    const responses = stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RpcResponse);

    assert.equal(responses.length, 4, stdout);
    assert.deepEqual(
      responses.slice(0, 3).map((response) => response.error?.code),
      [-32600, -32600, -32600],
    );
    assert.equal(responses[3]?.id, 7);
    assert.equal(responses[3]?.result?.serverInfo?.name, "loopforge-mcp");
    assert.equal(responses[3]?.result?.protocolVersion, "2024-11-05");
    assert.equal(responses[3]?.result?.capabilities?.tasks, undefined);
    assert.match(responses[3]?.result?.instructions ?? "", /loopforge_start/);
    assert.match(responses[3]?.result?.instructions ?? "", /loopforge_next/);
  });

  it("returns retryable evaluation errors while rejecting other invalid arguments", async () => {
    const rpc = spawnRpcServer();
    try {
      const initialized = await rpc.request("initialize", {
        protocolVersion: "2025-06-18",
      });
      assert.equal(
        (initialized.result as Record<string, unknown>).protocolVersion,
        "2025-06-18",
      );
      const wrongType = await rpc.request("tools/call", {
        name: "loopforge_next",
        arguments: {
          sessionId: "session",
          roundId: "loop:test:round:1",
          evaluation: {
            success: "yes",
            output_summary: "done",
            should_continue: false,
            constraint_violations: [],
          },
        },
      });
      assert.equal(wrongType.error, undefined);
      const wrongTypeResult = wrongType.result as Record<string, unknown>;
      assert.equal(wrongTypeResult.isError, true);
      const wrongTypeContent = wrongTypeResult.content as Array<{ text: string }>;
      const evaluationError = JSON.parse(wrongTypeContent[0]!.text) as Record<string, unknown>;
      assert.equal(evaluationError.error, "evaluation_invalid");
      assert.deepEqual(
        ((evaluationError.details as Record<string, unknown>).invalid as Array<Record<string, unknown>>)
          .map((item) => item.field),
        ["success"],
      );

      const unknownField = await rpc.request("tools/call", {
        name: "loopforge_status",
        arguments: { view: "bogus" },
      });
      assert.equal(
        (unknownField.error as Record<string, unknown>).code,
        -32602,
      );

      // v3.0.1: every submission must be anchored to a roundId.
      const missingRoundId = await rpc.request("tools/call", {
        name: "loopforge_next",
        arguments: {
          sessionId: "session",
          evaluation: {
            success: true,
            output_summary: "done",
            should_continue: false,
            constraint_violations: [],
          },
        },
      });
      assert.equal(
        (missingRoundId.error as Record<string, unknown>).code,
        -32602,
      );
    } finally {
      await rpc.close();
    }
  });

  it("returns protocol-compatible tool output and rejects MCP task execution", async () => {
    const rpc = spawnRpcServer();
    try {
      const initialized = await rpc.request("initialize");
      const initResult = initialized.result as Record<string, unknown>;
      assert.equal(initResult.protocolVersion, "2025-06-18");
      assert.equal((initResult.capabilities as Record<string, unknown>).tasks, undefined);

      const listed = await rpc.request("tools/list");
      const tools = ((listed.result as Record<string, unknown>).tools as Array<Record<string, unknown>>);
      const gate = tools.find((tool) => tool.name === "loopforge_gate_check");
      assert.ok(gate?.outputSchema);
      assert.equal(gate?.execution, undefined);

      const direct = await rpc.request("tools/call", {
        name: "loopforge_status",
        arguments: { view: "all" },
      });
      const directResult = direct.result as Record<string, unknown>;
      assert.equal(directResult.isError, undefined);
      assert.equal(directResult.structuredContent, undefined);
      const content = directResult.content as Array<{ text: string }>;
      const structured = JSON.parse(content[0].text) as Record<string, unknown>;
      assert.ok(Array.isArray(structured.sessions));

      const rejectedTask = await rpc.request("tools/call", {
        name: "loopforge_status",
        arguments: { loopId: "missing-task-loop", view: "loop" },
        task: { ttl: 60_000 },
      });
      assert.equal((rejectedTask.error as Record<string, unknown>).code, -32602);
      const taskMethod = await rpc.request("tasks/get", { taskId: "missing" });
      assert.equal((taskMethod.error as Record<string, unknown>).code, -32601);
    } finally {
      await rpc.close();
    }
  });

  it("falls back to the latest synchronous revision for unsupported versions", async () => {
    const rpc = spawnRpcServer();
    try {
      const initialized = await rpc.request("initialize", {
        protocolVersion: "2025-11-25",
      });
      assert.equal(
        (initialized.result as Record<string, unknown>).protocolVersion,
        "2025-06-18",
      );
    } finally {
      await rpc.close();
    }
  });
});
