/** Tests for technique routing and quality scoring. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  routeTechnique,
  routeTechniqueAdaptive,
  scoreQuality,
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

describe("Builder — Score Quality", () => {
  it("returns 5 for success with no violations or fixes", () => {
    assert.equal(scoreQuality({ success: true, constraint_violations: [], manual_fixes_needed: "" }), 5);
  });

  it("returns 4 for success with manual fixes needed but no violations", () => {
    assert.equal(scoreQuality({ success: true, constraint_violations: [], manual_fixes_needed: "fix formatting" }), 4);
  });

  it("returns 3 for success with constraint violations", () => {
    assert.equal(scoreQuality({ success: true, constraint_violations: ["missing check"] }), 3);
  });

  it("returns 2 for failure with constraint violations", () => {
    assert.equal(scoreQuality({ success: false, constraint_violations: ["XSS vulnerability"] }), 2);
  });

  it("returns 1 for failure with no constraint violations", () => {
    assert.equal(scoreQuality({ success: false, constraint_violations: [] }), 1);
  });

  it("returns 0 for null feedback", () => {
    assert.equal(scoreQuality(null), 0);
  });
});

describe("Builder — Adaptive routing", () => {
  it("falls back to keyword heuristic when no vault context", () => {
    // "Audit" + "fix" → continuous + high → few-shot-cot
    const analysis = routeTechniqueAdaptive("Fix the encryption protocol security audit", null, "");
    assert.equal(analysis.technique, "few-shot-cot");
    assert.equal(analysis.was_rotated, false);
  });

  it("falls back to keyword heuristic when no loop_id", () => {
    const analysis = routeTechniqueAdaptive("Fix the encryption protocol security audit", { results: [] }, "");
    assert.equal(analysis.technique, "few-shot-cot");
    assert.equal(analysis.was_rotated, false);
  });

  it("does not rotate when quality scores are high", () => {
    const vaultContext = {
      results: [
        {
          loop_lineage: {
            loop_id: "test-loop",
            round: 1,
            quality_score: 5,
          },
          technique_used: "few-shot-cot",
          quality_score: 5,
        },
      ],
    };
    const analysis = routeTechniqueAdaptive("Fix the encryption protocol security audit", vaultContext, "test-loop");
    assert.equal(analysis.technique, "few-shot-cot");
    assert.equal(analysis.was_rotated, false);
  });
});

