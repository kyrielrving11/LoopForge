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
// v3.8.1: fidelity invariants — the schema must not lose type information
// ═══════════════════════════════════════════════════════════════════════════

/** Every property name a def declares, following `allOf` `$ref` branches —
 *  how a concrete type states what it inherits. */
function resolvedPropertyNames(name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const node = def(name);
  const out = Object.keys((node.properties ?? {}) as Record<string, unknown>);
  for (const branch of (node.allOf ?? []) as Array<Record<string, unknown>>) {
    const ref = typeof branch.$ref === "string" ? branch.$ref : "";
    if (ref.startsWith("#/$defs/")) {
      out.push(...resolvedPropertyNames(ref.slice("#/$defs/".length), seen));
    }
    if (branch.properties) out.push(...Object.keys(branch.properties as Record<string, unknown>));
  }
  return out;
}

describe("v3.8.1 — schema fidelity", () => {
  it("an extended interface publishes every inherited field", () => {
    // `extends` used to be ignored entirely: GitObservation lost
    // schemaVersion/providerId/phase/startedAt/finishedAt/status/files — the
    // fields EVERY observation must carry — and MachineObservationBase was
    // referenced by nothing.
    const inherited = Object.keys(props("MachineObservationBase"));
    assert.ok(inherited.length >= 7, `base declares the shared fields: ${inherited.join(", ")}`);
    for (const concrete of ["GitObservation", "CommandObservation", "CustomObservation"]) {
      const names = resolvedPropertyNames(concrete);
      for (const field of inherited) {
        assert.ok(names.includes(field),
          `${concrete} must publish the inherited field "${field}"`);
      }
      const refs = ((def(concrete).allOf ?? []) as Array<Record<string, unknown>>)
        .map((branch) => branch.$ref).filter(Boolean);
      assert.ok(refs.includes("#/$defs/MachineObservationBase"),
        `${concrete} must compose the base definition, not copy it`);
    }
  });

  it("an inline object type publishes an object, not a string", () => {
    // These used to fall through to the `{ type: "string" }` catch-all — the
    // projection and the reported test counts were published as strings while
    // the runtime sends objects.
    const focus = props("LoopProjection").focus as Record<string, unknown>;
    const focusObject = ((focus.anyOf ?? []) as Array<Record<string, unknown>>)
      .find((branch) => branch.type === "object");
    assert.ok(focusObject, "focus is an object (or null)");
    assert.deepEqual(
      Object.keys(focusObject!.properties as Record<string, unknown>).sort(),
      ["since_round", "what"],
    );

    const todoItem = (props("LoopProjection").todo as Record<string, unknown>).items as Record<string, unknown>;
    assert.equal(todoItem.type, "object", "todo items are objects");
    assert.ok(Object.keys(todoItem.properties as Record<string, unknown>).includes("priority"));

    const reported = props("ExecutionReport").tests_reported as Record<string, unknown>;
    const reportedObject = ((reported.anyOf ?? []) as Array<Record<string, unknown>>)
      .find((branch) => branch.type === "object");
    assert.ok(reportedObject, "tests_reported is an object (or null)");
    assert.deepEqual(
      Object.keys(reportedObject!.properties as Record<string, unknown>).sort(),
      ["failed", "passed", "skipped"],
    );
  });

  it("a `typeof CONST` is published as the constant it is", () => {
    // The envelope version is a HARD break at the runtime: a client generated
    // from a schema that called it a string would serialize a String and have
    // every round rejected. The source keeps ONE version source; the schema
    // must read it rather than guess.
    const version = props("PromptArtifact").schemaVersion;
    assert.equal(version.type, "number", "the artifact schema version is a number");
    assert.equal(version.const, 2);
  });
});

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

  it("includes the PromptArtifact wire contract", () => {
    const names = Object.keys(defs);
    // v3.3: RoundContract joined the $defs (37 → 38).
    // v3.7.1: SubGoalUpdate joined the $defs (38 → 39).
    // L5: PresentedStateSnapshot joined the $defs (39 → 40) — a cross-file
    // type that used to be referenced but never defined.
    // v3.8: the agent-report / contract-item / machine-observation /
    // capability surface replaced the legacy contract and evidence
    // definitions (40 → 59).
    // v3.8.0 fix batch: EvidenceCapability (the prepared round's capability
    // fact) and the ToolError/ToolErrorCode pair joined (59 → 62).
    // v3.8.1: LoopHealth and TaskAlignment were deleted — both were
    // text-similarity verdicts exposed as protocol types (62 → 60).
    // Then ActiveRoundContract/ActiveContractItem, duplicate declarations of
    // the runtime’s ActiveContractView that only the schema ever saw, were
    // deleted too (60 → 58... 57 with the second boundary deletion).
    assert.equal(names.length, 57, `expected 57, got ${names.length}: ${names.join(", ")}`);
    assert.ok(names.includes("PromptArtifact"));
    assert.ok(names.includes("RoundOutcome"));
    assert.ok(names.includes("RoundContractProposal"));
    assert.ok(names.includes("ExecutionReport"));
    assert.ok(names.includes("MachineObservationBase"));
    assert.ok(names.includes("ConfiguredCapability"));
    assert.ok(names.includes("EvidenceCapability"));
    assert.ok(names.includes("ToolError"));
    assert.ok(names.includes("ToolErrorCode"));
  });

  it("L5: every $ref resolves to a defined $defs entry", () => {
    // Draft 2020-12 validators reject unresolved references at compile
    // time — a dangling $ref (a type imported from outside protocol.ts,
    // referenced but never collected) silently breaks the wire contract.
    // v3.8.1: PresentedStateSnapshot was the historical instance (referenced
    // but never collected) and is now deleted outright, so the sweep must
    // simply keep finding nothing.
    const dangling: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record.$ref === "string") {
        const match = /^#\/\$defs\/(.+)$/.exec(record.$ref);
        if (match && !(match[1] in defs)) dangling.push(record.$ref);
      }
      if (record.properties) {
        for (const child of Object.values(record.properties)) walk(child);
      }
      if (record.items) walk(record.items);
      if (Array.isArray(record.anyOf)) {
        for (const child of record.anyOf) walk(child);
      }
    };
    walk(schema);
    assert.deepEqual(dangling, [],
      `every $ref must resolve: ${dangling.join(", ")}`);
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

});

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces — type correctness (fixes hand-written schema bugs)
// ═══════════════════════════════════════════════════════════════════════════

describe("Interface type correctness", () => {
  it("LoopCompileRequest — numbers are number", () => {
    const p = props("LoopCompileRequest");
    assert.equal(p.round.type, "number");
  });

  it("LoopRoundResult — round is number and success is boolean", () => {
    const p = props("LoopRoundResult");
    assert.equal(p.round.type, "number");
    assert.equal(p.success.type, "boolean");
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

  it("LoopForgeResponse.status → AgentStatus ($ref)", () => {
    assert.equal(props("LoopForgeResponse").status.$ref, "#/$defs/AgentStatus");
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
    // Optional (nullable) fields should NOT be in required
    assert.ok(!req.includes("loop_objective"));
    assert.ok(!req.includes("plan_source"));
    assert.ok(!req.includes("last_round_result"));
  });

});
