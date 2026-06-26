/** LoopForge — Autonomous loop tests (v1.1).
 *
 *  Tests: extractSelfEvaluation, heuristicSelfEvaluation, buildSelfEvalBlock,
 *  autoFeedback, runOneRound.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  extractSelfEvaluation,
  heuristicSelfEvaluation,
  LoopForgeEngine,
  createEngine,
} from "../engine.js";

import { buildSelfEvalBlock } from "../loop-compiler.js";
import { makeSelfEvaluation, type SelfEvaluation } from "../protocol.js";
import { runOneRound, type AutonomousConfig } from "../autonomous.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeAgentOutput(evalOverrides: Partial<SelfEvaluation> = {}): string {
  const se = makeSelfEvaluation({
    success: true,
    output_summary: "Found 3 vulnerabilities in the ERC20 contract.",
    constraint_violations: [],
    should_continue: true,
    ...evalOverrides,
  });
  return [
    "## Security Audit Results",
    "",
    "I audited the ERC20 contract and found 3 issues:",
    "- Reentrancy in withdraw()",
    "- Integer overflow in transfer()",
    "- Missing access control in mint()",
    "",
    "---loopforge-eval",
    JSON.stringify(se, null, 2),
    "---end-loopforge-eval",
    "",
    "All issues have been documented with PoC exploits.",
  ].join("\n");
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loopforge-test-"));
  return dir;
}

// ═══════════════════════════════════════════════════════════════════════════
// extractSelfEvaluation
// ═══════════════════════════════════════════════════════════════════════════

describe("extractSelfEvaluation", () => {
  it("extracts valid self-evaluation from agent output", () => {
    const output = makeAgentOutput({ success: true, should_continue: false });
    const result = extractSelfEvaluation(output);
    assert.ok(result !== null);
    assert.equal(result!.success, true);
    assert.equal(result!.should_continue, false);
    assert.equal(result!.constraint_violations.length, 0);
    assert.ok(result!.output_summary.includes("vulnerabilities"));
  });

  it("returns null when no eval block present", () => {
    const output = "Just some regular text without any eval block.";
    const result = extractSelfEvaluation(output);
    assert.equal(result, null);
  });

  it("returns null for invalid JSON in eval block", () => {
    const output = [
      "---loopforge-eval",
      "{invalid json here}",
      "---end-loopforge-eval",
    ].join("\n");
    const result = extractSelfEvaluation(output);
    assert.equal(result, null);
  });

  it("returns null when required fields are missing", () => {
    const output = [
      "---loopforge-eval",
      JSON.stringify({ success: true }),
      "---end-loopforge-eval",
    ].join("\n");
    const result = extractSelfEvaluation(output);
    assert.equal(result, null);
  });

  it("returns null when success is not boolean", () => {
    const output = [
      "---loopforge-eval",
      JSON.stringify({
        success: "yes",
        output_summary: "done",
        constraint_violations: [],
        should_continue: false,
      }),
      "---end-loopforge-eval",
    ].join("\n");
    const result = extractSelfEvaluation(output);
    assert.equal(result, null);
  });

  it("extracts eval with constraint violations", () => {
    const output = makeAgentOutput({
      success: false,
      constraint_violations: ["Modified file outside scope"],
      should_continue: true,
    });
    const result = extractSelfEvaluation(output);
    assert.ok(result !== null);
    assert.equal(result!.success, false);
    assert.equal(result!.constraint_violations.length, 1);
    assert.equal(result!.constraint_violations[0], "Modified file outside scope");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// heuristicSelfEvaluation
// ═══════════════════════════════════════════════════════════════════════════

describe("heuristicSelfEvaluation", () => {
  it("detects success from completion keywords", () => {
    const output =
      "Task completed successfully. All tests pass. The module is ready.";
    const result = heuristicSelfEvaluation(output);
    assert.ok(result !== null);
    assert.equal(result!.success, true);
  });

  it("detects failure from error keywords", () => {
    const output =
      "Failed to compile. Error: Cannot find module 'express'. Exception thrown.";
    const result = heuristicSelfEvaluation(output);
    assert.ok(result !== null);
    assert.equal(result!.success, false);
  });

  it("detects remaining work", () => {
    const output =
      "Partially completed. Still need to implement the authentication module. Continue with step 3.";
    const result = heuristicSelfEvaluation(output);
    assert.ok(result !== null);
    assert.equal(result!.should_continue, true);
  });

  it("returns null for empty text", () => {
    // heuristicSelfEvaluation never returns null — it always produces a best-effort result
    const result = heuristicSelfEvaluation("");
    assert.ok(result !== null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildSelfEvalBlock
// ═══════════════════════════════════════════════════════════════════════════

describe("buildSelfEvalBlock", () => {
  it("includes the round number", () => {
    const block = buildSelfEvalBlock(5);
    assert.ok(block.includes("5"));
  });

  it("includes required markers", () => {
    const block = buildSelfEvalBlock(1);
    assert.ok(block.includes("---loopforge-eval"));
    assert.ok(block.includes("---end-loopforge-eval"));
    assert.ok(block.includes("success"));
    assert.ok(block.includes("output_summary"));
    assert.ok(block.includes("constraint_violations"));
    assert.ok(block.includes("should_continue"));
  });

  it("includes field rules", () => {
    const block = buildSelfEvalBlock(1);
    assert.ok(block.includes("Field rules"));
    assert.ok(block.includes("true ONLY if"));
  });

  it("produces different output for different rounds", () => {
    const b1 = buildSelfEvalBlock(1);
    const b2 = buildSelfEvalBlock(2);
    assert.notEqual(b1, b2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// autoFeedback
// ═══════════════════════════════════════════════════════════════════════════

describe("Engine — autoFeedback", () => {
  it("records self-evaluation without errors", () => {
    const engine = createEngine();
    const se = makeSelfEvaluation({
      success: true,
      output_summary: "Task completed successfully.",
      constraint_violations: [],
      should_continue: false,
    });
    const quality = engine.autoFeedback(se, "test-loop", 1, "Test task");
    assert.equal(quality, 5);
  });

  it("scores quality=2 for failed round with violations", () => {
    const engine = createEngine();
    const se = makeSelfEvaluation({
      success: false,
      output_summary: "Failed to complete.",
      constraint_violations: ["broke constraint X"],
      should_continue: true,
    });
    const quality = engine.autoFeedback(se, "test-loop", 1, "Test task");
    assert.equal(quality, 2);
  });

  it("updates quality trend", () => {
    const engine = createEngine();
    const se = makeSelfEvaluation({
      success: true,
      output_summary: "done",
      constraint_violations: [],
      should_continue: true,
    });
    engine.autoFeedback(se, "test-loop", 1, "Test task");
    assert.ok(engine.state !== null);
    assert.equal(engine.state!.quality_trend.length, 1);
    assert.equal(engine.state!.quality_trend[0], 5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runOneRound
// ═══════════════════════════════════════════════════════════════════════════

describe("runOneRound — autonomous loop", () => {
  const baseConfig: AutonomousConfig = {
    task: "Audit ERC20 token for security vulnerabilities",
    loopId: "audit-erc20",
    goalId: "audit",
    maxRounds: 10,
  };

  it("round 1 produces L2 prompt without stopping", () => {
    const engine = createEngine();
    const result = runOneRound(engine, baseConfig, 1, null);

    assert.equal(result.stopNow, false);
    assert.ok(result.roundOutput !== null);
    assert.equal(result.roundOutput!.round, 1);
    assert.ok(result.roundOutput!.prompt.length > 100);
    // Round 1 prompt should include self-eval instructions
    assert.ok(result.roundOutput!.prompt.includes("---loopforge-eval"));
    assert.ok(result.roundOutput!.prompt.includes("Self-Evaluation"));
    // No self-eval for round 1 (no prior agent output)
    assert.equal(result.selfEval, null);
  });

  it("round 2 extracts self-eval from agent output and compiles", () => {
    const engine = createEngine();

    // First, establish round 1 lineage
    const se1 = makeSelfEvaluation({
      success: true,
      output_summary: "Round 1: found 3 vulns.",
      constraint_violations: [],
      should_continue: true,
    });
    engine.autoFeedback(se1, "audit-erc20", 1, baseConfig.task);

    // Now run round 2 with agent output
    const agentOutput = makeAgentOutput({
      success: true,
      output_summary: "Round 1: found 3 vulns in ERC20.",
      constraint_violations: [],
      should_continue: true,
    });

    const result = runOneRound(engine, baseConfig, 2, agentOutput);

    assert.equal(result.stopNow, false);
    assert.ok(result.roundOutput !== null);
    assert.equal(result.roundOutput!.round, 2);
    assert.ok(result.selfEval !== null);
    assert.equal(result.selfEval!.success, true);
    assert.ok(result.extractionSucceeded);
  });

  it("stops when agent reports should_continue=false", () => {
    const engine = createEngine();

    // Round 1 lineage
    engine.autoFeedback(
      makeSelfEvaluation({ success: true, output_summary: "r1", constraint_violations: [], should_continue: true }),
      "audit-erc20", 1, baseConfig.task,
    );

    // Round 2 agent output says task complete
    const agentOutput = makeAgentOutput({
      success: true,
      output_summary: "All done.",
      constraint_violations: [],
      should_continue: false,
    });

    const result = runOneRound(engine, baseConfig, 2, agentOutput);
    assert.equal(result.stopNow, true);
    assert.equal(result.stopReason, "task_complete");
    assert.equal(result.roundOutput, null);
  });

  it("stops when max rounds exceeded", () => {
    const engine = createEngine();
    const config: AutonomousConfig = { ...baseConfig, maxRounds: 3 };
    const result = runOneRound(engine, config, 4, null);
    assert.equal(result.stopNow, true);
    assert.equal(result.stopReason, "max_rounds");
  });

  it("stops on extraction failure (no eval block in output)", () => {
    const engine = createEngine();
    engine.autoFeedback(
      makeSelfEvaluation({ success: true, output_summary: "r1", constraint_violations: [], should_continue: true }),
      "audit-erc20", 1, baseConfig.task,
    );

    const badOutput = "Just some text without any eval block.";
    const result = runOneRound(engine, baseConfig, 2, badOutput);
    assert.equal(result.stopNow, true);
    assert.equal(result.stopReason, "extraction_failed");
  });

  it("prompt includes self-eval block on every round", () => {
    const engine = createEngine();

    // Round 1
    const r1 = runOneRound(engine, baseConfig, 1, null);
    assert.ok(r1.roundOutput!.prompt.includes("---loopforge-eval"));

    // Round 2
    engine.autoFeedback(
      makeSelfEvaluation({ success: true, output_summary: "r1 done", constraint_violations: [], should_continue: true }),
      "audit-erc20", 1, baseConfig.task,
    );
    const r2 = runOneRound(
      engine, baseConfig, 2,
      makeAgentOutput({ success: true, output_summary: "r1", constraint_violations: [], should_continue: true }),
    );
    assert.ok(r2.roundOutput!.prompt.includes("---loopforge-eval"));
  });
});
