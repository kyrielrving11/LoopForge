/** Tests for technique routing and quality scoring. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  routeTechnique,
  routeTechniqueAdaptive,
  TECHNIQUE_REFERENCE,
} from "../builder.js";
import { resetPolicy } from "../policy.js";

describe("Builder — Route Technique", () => {
  beforeEach(() => resetPolicy());

  it("routes audit tasks to tree-of-thought (independent, high load)", () => {
    // "audit" is HIGH_LOAD but not CONTINUOUS → independent + high → tree-of-thought
    const analysis = routeTechnique("Audit the ERC20 token for security vulnerabilities");
    assert.equal(analysis.technique, "tree-of-thought");
    assert.equal(analysis.independence, "independent");
    assert.equal(analysis.cognitive_load, "high");
  });

  it("routes rename tasks to zero-shot (independent, low load)", () => {
    const analysis = routeTechnique("Rename getCwd to getCurrentWorkingDirectory");
    assert.equal(analysis.technique, "zero-shot");
    assert.equal(analysis.independence, "independent");
    assert.equal(analysis.cognitive_load, "low");
  });

  it("routes fix tasks to zero-shot (continuous, low load, short task)", () => {
    const analysis = routeTechnique("Fix the bug");  // only 3 words → load low
    assert.equal(analysis.technique, "zero-shot");
    assert.equal(analysis.independence, "continuous");
  });

  it("routes crypto tasks to few-shot-cot (continuous, high)", () => {
    const analysis = routeTechnique("Fix the encryption protocol memory leak in the concurrent handler");
    assert.equal(analysis.technique, "few-shot-cot");
    assert.equal(analysis.independence, "continuous");
    assert.equal(analysis.cognitive_load, "high");
  });

  it("routes simple independent tasks to zero-shot", () => {
    const analysis = routeTechnique("Write a README for the project with basic setup instructions");
    assert.equal(analysis.technique, "zero-shot");
    assert.equal(analysis.independence, "independent");
    assert.equal(analysis.cognitive_load, "low");
  });

  it("includes reference_file in analysis", () => {
    const analysis = routeTechnique("Fix the encryption protocol");
    assert.ok(analysis.reference_file.includes("chain-of-thought"));
  });

  it("defaults to zero-shot on unrecognised combination", () => {
    const analysis = routeTechnique("");  // empty task
    assert.equal(analysis.technique, "zero-shot");
  });
});

describe("Builder — Tier-gated routing", () => {
  it("uses keyword heuristic when no vault context (Tier 1 default)", () => {
    const analysis = routeTechniqueAdaptive("Fix the encryption protocol security audit", null, "");
    assert.equal(analysis.technique, "few-shot-cot");
    assert.equal(analysis.was_rotated, false);
  });

  it("uses keyword heuristic when no loop_id (Tier 1 default)", () => {
    const analysis = routeTechniqueAdaptive("Fix the encryption protocol security audit", { results: [] }, "");
    assert.equal(analysis.technique, "few-shot-cot");
    assert.equal(analysis.was_rotated, false);
  });

  it("stays in Tier 1 by default", () => {
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test-loop",
            round: 1,
            success: true,
          },
          technique_used: "few-shot-cot",
          success: true,
        },
      ],
    };
    const analysis = routeTechniqueAdaptive("Fix the encryption protocol security audit", vaultContext, "test-loop");
    assert.equal(analysis.technique, "few-shot-cot");
    assert.equal(analysis.was_rotated, false);
  });

  it("allows Tier 2 on checkpoint boundary", () => {
    // Task triggers step-back keyword → Tier 2, normally downgraded
    // But with isCheckpoint=true, should be allowed
    const analysis = routeTechniqueAdaptive("重构 legacy 系统", null, "", true);
    assert.equal(analysis.technique, "step-back");
  });

  it("downgrades Tier 2 to Tier 1 in normal round", () => {
    // "重构 legacy 系统" triggers step-back (Tier 2), but without checkpoint it downgrades
    const analysis = routeTechniqueAdaptive("重构 legacy 系统");
    // step-back downgrades to few-shot-cot
    assert.ok(["zero-shot", "few-shot", "zero-shot-cot", "few-shot-cot"].includes(analysis.technique));
  });

  // v1.15: Tier escalation removed — Agent freely chooses at L2.
  // Consecutive failures no longer force Tier 2 techniques.
  it("stays in Tier 1 after consecutive failures (v1.15 — escalation removed)", () => {
    const vaultContext = {
      results: [
        {
          loop_lineage: { loop_id: "test-loop", round: 1 },
          success: false,
        },
        {
          loop_lineage: { loop_id: "test-loop", round: 2 },
          success: false,
        },
        {
          loop_lineage: { loop_id: "test-loop", round: 3 },
          success: false,
        },
      ],
    };
    const analysis = routeTechniqueAdaptive("Fix the encryption protocol security audit", vaultContext, "test-loop");
    // Tier 1 only in normal round (no escalation)
    assert.ok(["zero-shot", "few-shot", "zero-shot-cot", "few-shot-cot"].includes(analysis.technique));
  });
});

