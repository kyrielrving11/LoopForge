/** Tests for schema synchronization between the hand-written MCP tool
 *  schemas (src/mcp/tools.ts) and the generated protocol schema
 *  (loopforge-protocol.json).
 *
 *  The MCP evaluation input schema must expose exactly the SelfEvaluation
 *  fields of the wire protocol — the schema is closed (additionalProperties:
 *  false), so a field missing here is silently rejected for strict MCP
 *  clients while the runtime already supports it (the v2.8
 *  drift_clarification gap). The generated protocol schema is the single
 *  source of truth; this test makes any future divergence fail the suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TOOL_SCHEMAS } from "../mcp/tools.js";

// In npm scripts, process.cwd() is the package root (loopforge/).
// The generated schema is written to the repo root (../loopforge-protocol.json).
const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), "..", "loopforge-protocol.json"), "utf-8"),
) as Record<string, unknown>;

type SchemaNode = Record<string, unknown>;

function evaluationProps(): SchemaNode {
  const tool = TOOL_SCHEMAS.find((t) => t.name === "loopforge_next");
  assert.ok(tool, "loopforge_next tool schema must exist");
  const input = tool.inputSchema as SchemaNode;
  const evaluation = (input.properties as SchemaNode).evaluation as SchemaNode;
  return evaluation.properties as SchemaNode;
}

function protocolSelfEvalProps(): SchemaNode {
  const defs = schema.$defs as SchemaNode;
  const selfEval = defs.SelfEvaluation as SchemaNode;
  assert.ok(selfEval, "protocol schema must define SelfEvaluation");
  return selfEval.properties as SchemaNode;
}

describe("MCP schema ↔ protocol schema sync", () => {
  it("evaluation schema exposes every SelfEvaluation protocol field", () => {
    const evalProps = evaluationProps();
    const protocolProps = protocolSelfEvalProps();
    const missing = Object.keys(protocolProps).filter((k) => !(k in evalProps));
    assert.deepEqual(
      missing, [],
      "fields in protocol SelfEvaluation missing from the MCP evaluation " +
      "schema (strict clients reject them): " + missing.join(", "),
    );
  });

  it("evaluation schema has no fields absent from SelfEvaluation", () => {
    const evalProps = evaluationProps();
    const protocolProps = protocolSelfEvalProps();
    const extra = Object.keys(evalProps).filter((k) => !(k in protocolProps));
    assert.deepEqual(
      extra, [],
      "fields in the MCP evaluation schema that do not exist in protocol " +
      "SelfEvaluation: " + extra.join(", "),
    );
  });

  it("exposes drift_clarification (v2.8 regression guard)", () => {
    const evalProps = evaluationProps();
    assert.ok(
      "drift_clarification" in evalProps,
      "drift_clarification must be accepted by the closed MCP evaluation " +
      "schema — the enforcement gate R7 depends on it",
    );
  });
});
