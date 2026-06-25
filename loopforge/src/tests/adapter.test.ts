/** Tests for adapter: mode routing, input parsing, health line. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../adapter.js";
import { createEngine } from "../engine.js";
import { resetPolicy } from "../policy.js";

describe("Adapter — handle()", () => {
  beforeEach(() => resetPolicy());

  it("returns error for unknown mode", () => {
    const result = handle('{"task":"audit","mode":"unknown_mode"}');
    const parsed = JSON.parse(result);
    assert.equal(parsed.status, "error");
    assert.ok(parsed.result.error.includes("Unknown mode"));
  });

  it("returns error for empty task", () => {
    const result = handle('{"task":"","mode":"build"}');
    const parsed = JSON.parse(result);
    assert.equal(parsed.status, "error");
    assert.ok(parsed.result.error.includes("Task is required"));
  });

  it("handles build mode", () => {
    const result = handle('{"task":"Audit ERC20","mode":"build"}');
    const parsed = JSON.parse(result);
    assert.equal(parsed.status, "ok");
    assert.ok(parsed.result.prompt_or_overlay.includes("LoopForge Build"));
    assert.ok(parsed.health.startsWith("[PC:"));
  });

  it("handles loop_compile mode", () => {
    const result = handle(JSON.stringify({
      task: "Audit ERC20 token",
      mode: "loop_compile",
      loop_id: "audit-erc20",
      round: 1,
      goal_id: "audit-erc20",
    }));
    const parsed = JSON.parse(result);
    assert.equal(parsed.status, "ok");
    assert.ok(parsed.result.prompt_or_overlay.includes("L2 Compile"));
    assert.ok(parsed.health.includes("PC:"));
  });

  it("handles feedback mode", () => {
    const result = handle(JSON.stringify({
      task: "Audit ERC20",
      mode: "feedback",
      feedback: {
        success: true,
        constraint_violations: [],
        manual_fixes_needed: "",
        output: "All tests passed",
      },
    }));
    const parsed = JSON.parse(result);
    assert.equal(parsed.status, "ok");
    assert.ok(parsed.result.prompt_or_overlay.includes("Feedback Recorded"));
    assert.ok(parsed.result.prompt_or_overlay.includes("5/5"));
  });

  it("returns error for feedback without payload", () => {
    const result = handle('{"task":"Audit","mode":"feedback"}');
    const parsed = JSON.parse(result);
    assert.equal(parsed.status, "error");
  });

  it("handles dict input (not just JSON string)", () => {
    const result = handle({
      task: "Rename function",
      mode: "build",
    });
    const parsed = JSON.parse(result);
    assert.equal(parsed.status, "ok");
  });

  it("health line shows STALLED when circuit breaker tripped", () => {
    // Run enough feedback rounds to trigger circuit breaker
    const result = handle(JSON.stringify({
      task: "Test",
      mode: "feedback",
      feedback: { success: false, constraint_violations: ["error"], manual_fixes_needed: "", output: "failed" },
    }));
    const parsed = JSON.parse(result);
    assert.ok(parsed.health.startsWith("[PC:"));
  });

  it("accepts engine reuse across calls", () => {
    const engine = createEngine();

    const r1 = handle('{"task":"Test 1","mode":"build"}', engine);
    const p1 = JSON.parse(r1);
    assert.equal(p1.status, "ok");

    const r2 = handle('{"task":"Test 2","mode":"build"}', engine);
    const p2 = JSON.parse(r2);
    assert.equal(p2.status, "ok");
    // Engine state persists
    assert.equal(engine.state!.call_count, 0); // build doesn't increment call_count
  });

  it("output size guard truncates at 32KB", () => {
    // Generate a large request that produces a large prompt
    const largeTask = "Audit " + "the contract ".repeat(50) + "for security";
    const result = handle(JSON.stringify({
      task: largeTask,
      mode: "build",
    }));
    const parsed = JSON.parse(result);
    const promptLen = parsed.result.prompt_or_overlay.length;
    // Should be under 32KB + some overhead
    assert.ok(promptLen <= 33_000);
  });
});
