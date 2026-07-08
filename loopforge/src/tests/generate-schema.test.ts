/** Tests for auto-generated JSON Schema.
 *
 * Validates that the schema generated from protocol.ts is structurally correct,
 * has proper type mappings (boolean, number, array, $ref), and includes all
 * expected $defs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// In npm scripts, process.cwd() is the package root (loopforge/).
// The generated schema is written to the repo root (../loopforge-protocol.json).
const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), "..", "loopforge-protocol.json"), "utf-8"),
) as Record<string, unknown>;

const defs = (schema.$defs ?? {}) as Record<string, Record<string, unknown>>;

// Helper: typed access to defs + properties
function def(name: string): Record<string, unknown> {
  return defs[name] as Record<string, unknown>;
}
function props(name: string): Record<string, Record<string, unknown>> {
  return (def(name).properties ?? {}) as Record<string, Record<string, unknown>>;
}
function required(name: string): string[] {
  return (def(name).required ?? []) as string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Top-level structure
// ═══════════════════════════════════════════════════════════════════════════

describe("Generated JSON Schema — top-level", () => {
  it("is draft 2020-12", () => {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  });

  it("has $id and title", () => {
    assert.ok(String(schema.$id ?? "").includes("loopforge"));
    assert.ok(String(schema.title ?? "").includes("LoopForge"));
  });

  it("has 39 $defs (4 enums + 34 interfaces + 1 type alias)", () => {
    const names = Object.keys(defs);
    assert.equal(names.length, 39, `expected 39, got ${names.length}: ${names.join(", ")}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Enums
// ═══════════════════════════════════════════════════════════════════════════

describe("Enums", () => {
  it("Mode — 2 values", () => {
    assert.equal(def("Mode").type, "string");
    assert.deepEqual(def("Mode").enum, [
      "loop_compile", "feedback",
    ]);
  });

  it("AgentStatus — 3 values", () => {
    assert.equal(def("AgentStatus").type, "string");
    assert.deepEqual(def("AgentStatus").enum, ["ok", "error", "stalled"]);
  });

  it("Technique — 7 values", () => {
    assert.equal(def("Technique").type, "string");
    assert.deepEqual(def("Technique").enum, [
      "zero-shot", "few-shot", "zero-shot-cot", "few-shot-cot",
      "step-back", "least-to-most", "tree-of-thought",
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces — type correctness (fixes hand-written schema bugs)
// ═══════════════════════════════════════════════════════════════════════════

describe("Interface type correctness", () => {
  it("Analysis — booleans are boolean, not string", () => {
    assert.equal(def("Analysis").type, "object");
    assert.equal(props("Analysis").was_rotated.type, "boolean",
      "was_rotated should be boolean (hand-written schema had it as string)");
  });

  it("LoopHealth — numbers are number, booleans are boolean", () => {
    const p = props("LoopHealth");
    assert.equal(p.goal_alignment.type, "number");
    assert.equal(p.constraint_integrity.type, "number");
    assert.equal(p.task_continuity.type, "number");
    assert.equal(p.drift_detected.type, "boolean");
    assert.equal(p.strategy_stability.type, "boolean");
  });

  it("LoopCompileRequest — numbers are number", () => {
    const p = props("LoopCompileRequest");
    assert.equal(p.round.type, "number");
    assert.equal(p.health_check_interval.type, "number");
  });

  it("TaskAlignment — is_aligned is boolean, alignment_score is number", () => {
    const p = props("TaskAlignment");
    assert.equal(p.is_aligned.type, "boolean");
    assert.equal(p.alignment_score.type, "number");
  });

  it("LoopRoundResult — round is number, success is boolean (quality_score removed v1.12)", () => {
    const p = props("LoopRoundResult");
    assert.equal(p.round.type, "number");
    assert.equal(p.success.type, "boolean");
    // quality_score field has been removed — verify it's gone
    assert.equal(p.quality_score, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Array properties
// ═══════════════════════════════════════════════════════════════════════════

describe("Array properties", () => {
  it("LoopObjective — success_criteria and hard_constraints are string arrays", () => {
    const p = props("LoopObjective");
    assert.equal(p.success_criteria.type, "array");
    assert.equal((p.success_criteria.items as Record<string, unknown>).type, "string");
    assert.equal(p.hard_constraints.type, "array");
    assert.equal((p.hard_constraints.items as Record<string, unknown>).type, "string");
  });

  it("LoopCompileResponse — warnings and lineage are string arrays", () => {
    const p = props("LoopCompileResponse");
    assert.equal(p.warnings.type, "array");
    assert.equal((p.warnings.items as Record<string, unknown>).type, "string");
    assert.equal(p.lineage.type, "array");
  });

  it("RollingSummary — key_outcomes is string array", () => {
    const p = props("RollingSummary");
    assert.equal(p.key_outcomes.type, "array");
    assert.equal((p.key_outcomes.items as Record<string, unknown>).type, "string");
    // quality_trajectory and trajectory_direction removed in v1.12
    assert.equal(p.quality_trajectory, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// $ref links (interface/enum references)
// ═══════════════════════════════════════════════════════════════════════════

describe("$ref links", () => {
  it("LoopCompileRequest.loop_objective → LoopObjective | null (anyOf)", () => {
    const loProp = props("LoopCompileRequest").loop_objective;
    assert.ok(loProp.anyOf, "loop_objective should use anyOf for T | null");
    const refs = (loProp.anyOf as Record<string, unknown>[]).map((x) => x.$ref).filter(Boolean);
    const nulls = (loProp.anyOf as Record<string, unknown>[]).filter((x) => x.type === "null");
    assert.ok(refs.includes("#/$defs/LoopObjective"));
    assert.equal(nulls.length, 1);
  });

  it("LoopCompileRequest.vault_config → VaultConfig ($ref)", () => {
    assert.equal(props("LoopCompileRequest").vault_config.$ref, "#/$defs/VaultConfig");
  });

  it("LoopForgeResponse.status → AgentStatus ($ref)", () => {
    assert.equal(props("LoopForgeResponse").status.$ref, "#/$defs/AgentStatus");
  });

  it("LoopForgeResponse.analysis → Analysis | null (anyOf)", () => {
    const aProp = props("LoopForgeResponse").analysis;
    assert.ok(aProp.anyOf);
    const refs = (aProp.anyOf as Record<string, unknown>[]).map((x) => x.$ref).filter(Boolean);
    assert.ok(refs.includes("#/$defs/Analysis"));
  });

  it("AgentLoopResult.response → LoopForgeResponse | null (anyOf)", () => {
    const rProp = props("AgentLoopResult").response;
    assert.ok(rProp.anyOf);
    const refs = (rProp.anyOf as Record<string, unknown>[]).map((x) => x.$ref).filter(Boolean);
    assert.ok(refs.includes("#/$defs/LoopForgeResponse"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Index signature → additionalProperties
// ═══════════════════════════════════════════════════════════════════════════

describe("Index signature handling", () => {
  it("LoopForgeRequest has additionalProperties: true (index signature)", () => {
    assert.equal(
      def("LoopForgeRequest").additionalProperties,
      true,
      "LoopForgeRequest has [key: string]: unknown → additionalProperties",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// required arrays
// ═══════════════════════════════════════════════════════════════════════════

describe("required arrays", () => {
  it("LoopForgeRequest — task is required", () => {
    assert.ok(required("LoopForgeRequest").includes("task"));
  });

  it("LoopCompileRequest — all non-optional fields are required, nullable not", () => {
    const req = required("LoopCompileRequest");
    assert.ok(req.includes("mode"));
    assert.ok(req.includes("loop_id"));
    assert.ok(req.includes("round"));
    assert.ok(req.includes("task"));
    assert.ok(req.includes("vault_config"));
    // Optional (nullable) fields should NOT be in required
    assert.ok(!req.includes("loop_objective"));
    assert.ok(!req.includes("plan_source"));
    assert.ok(!req.includes("last_round_result"));
  });

  it("Analysis — 6 required fields", () => {
    const req = required("Analysis");
    assert.equal(req.length, 6);
    assert.ok(req.includes("was_rotated"));
    assert.ok(req.includes("reference_file"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Record<string, unknown> special case
// ═══════════════════════════════════════════════════════════════════════════

describe("Record<string, unknown> handling", () => {
  it("SessionState.feedback_buffer is array of objects with additionalProperties", () => {
    const fb = props("SessionState").feedback_buffer;
    assert.equal(fb.type, "array");
    const items = fb.items as Record<string, unknown>;
    assert.equal(items.type, "object");
    assert.equal(items.additionalProperties, true);
  });
});
