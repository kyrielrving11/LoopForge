/** Tests for schema synchronization between the hand-written MCP tool
 *  schemas (src/mcp/tools.ts) and the generated protocol schema
 *  (loopforge-protocol.json).
 *
 *  The MCP evaluation input schema must expose exactly the SelfEvaluation
 *  fields of the wire protocol. The evaluation object is open
 *  (`additionalProperties: true`) so future optional report fields are not
 *  silently rejected, while the required core fields remain pinned. The
 *  generated protocol schema is the single source of truth; this test makes
 *  any future divergence fail the suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { START_INPUT_KEYS, TOOL_SCHEMAS } from "../mcp/tools.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "../protocol.js";
import { ROUND_TRANSACTION_SCHEMA_VERSION } from "../round-transaction.js";
import { CANONICAL_STATE_SCHEMA_VERSION } from "../canonical-state.js";
import { POLICY_SCHEMA_VERSION } from "../policy.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../workspace-checkpoint.js";

// In npm scripts, process.cwd() is the package root (loopforge/).
// The generated schema is written to the repo root (../loopforge-protocol.json).
const schema = JSON.parse(
  readFileSync(resolve(process.cwd(), "..", "loopforge-protocol.json"), "utf-8"),
) as Record<string, unknown>;

type SchemaNode = Record<string, unknown>;

function evaluationSchema(): SchemaNode {
  const tool = TOOL_SCHEMAS.find((t) => t.name === "loopforge_next");
  assert.ok(tool, "loopforge_next tool schema must exist");
  const input = tool.inputSchema as SchemaNode;
  return (input.properties as SchemaNode).evaluation as SchemaNode;
}

function evaluationProps(): SchemaNode {
  return evaluationSchema().properties as SchemaNode;
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

  it("submissionHandle schema matches the protocol SubmissionHandle", () => {
    const tool = TOOL_SCHEMAS.find((t) => t.name === "loopforge_next");
    assert.ok(tool, "loopforge_next tool schema must exist");
    const input = tool.inputSchema as SchemaNode;
    const handle = (input.properties as SchemaNode).submissionHandle as SchemaNode;
    const defs = schema.$defs as SchemaNode;
    const protocol = defs.SubmissionHandle as SchemaNode;
    assert.ok(handle, "the tool schema must expose submissionHandle");
    assert.ok(protocol, "the protocol schema must define SubmissionHandle");
    assert.deepEqual(
      Object.keys(handle.properties as SchemaNode).sort(),
      Object.keys(protocol.properties as SchemaNode).sort(),
    );
    assert.deepEqual(
      [...(handle.required as string[])].sort(),
      [...(protocol.required as string[])].sort(),
    );
  });

  it("start schema exposes exactly the accepted start arguments", () => {
    const tool = TOOL_SCHEMAS.find((t) => t.name === "loopforge_start");
    assert.ok(tool, "loopforge_start tool schema must exist");
    const input = tool.inputSchema as SchemaNode;
    const properties = input.properties as SchemaNode;
    assert.deepEqual(
      Object.keys(properties).sort(),
      [...START_INPUT_KEYS].sort(),
      "the advertised start arguments and the handler guard must be one list",
    );
  });

  it("exposes subgoal_updates (v3.7.1 regression guard)", () => {
    const evalProps = evaluationProps();
    assert.ok(
      "subgoal_updates" in evalProps,
      "subgoal_updates must be accepted by the MCP evaluation schema — " +
      "the sub-goal lifecycle depends on it",
    );
  });

  it("keeps the evaluation object open with the required core fields pinned", () => {
    const evaluation = evaluationSchema();
    assert.equal(
      evaluation.additionalProperties,
      true,
      "optional Agent report fields must not be rejected by strict clients",
    );
    assert.deepEqual(
      [...(evaluation.required as string[])].sort(),
      ["constraint_violations", "output_summary", "should_continue", "success"],
    );
  });

  it("publishes every evidence-posture status, including not_applicable", () => {
    const defs = schema.$defs as SchemaNode;
    const status = defs.EvidencePostureStatus as SchemaNode;
    assert.deepEqual(
      [...(status.enum as string[])].sort(),
      ["contradicted", "insufficient", "not_applicable", "unknown", "verified"],
    );
    const posture = defs.EvidencePosture as SchemaNode;
    assert.ok(
      (posture.required as string[]).includes("machineBackedSuccess"),
      "machineBackedSuccess is a required posture fact",
    );
  });

  it("pins the published schema versions to the runtime constants", () => {
    const defs = schema.$defs as SchemaNode;
    const artifactProps = (defs.PromptArtifact as SchemaNode).properties as SchemaNode;
    assert.equal(
      (artifactProps.schemaVersion as SchemaNode).const,
      PROMPT_ARTIFACT_SCHEMA_VERSION,
    );
    const manifestProps =
      (defs.WorkspaceCheckpointManifest as SchemaNode).properties as SchemaNode;
    assert.equal(
      (manifestProps.schemaVersion as SchemaNode).const,
      CHECKPOINT_SCHEMA_VERSION,
    );
    assert.equal(ROUND_TRANSACTION_SCHEMA_VERSION, 8);
    assert.equal(CANONICAL_STATE_SCHEMA_VERSION, 8);
    assert.equal(POLICY_SCHEMA_VERSION, "10");
    assert.equal(CHECKPOINT_SCHEMA_VERSION, 1);
  });

  it("requires the context boundary and keeps the Working Memory projection optional", () => {
    const defs = schema.$defs as SchemaNode;
    const artifact = defs.PromptArtifact as SchemaNode;
    const required = artifact.required as string[];
    assert.ok(required.includes("contextMode"));
    assert.ok(required.includes("contextReason"));
    assert.ok(!required.includes("workingMemory"));
  });

  it("v4.0.4: publishes the renamed context vocabulary and the Agent stop field", () => {
    const defs = schema.$defs as SchemaNode;
    const contextMode = defs.PromptContextMode as SchemaNode;
    assert.deepEqual([...(contextMode.enum as string[])].sort(), [
      "fresh_invocation",
      "same_round_retry",
    ]);
    const selfEvalProps = (defs.SelfEvaluation as SchemaNode).properties as SchemaNode;
    assert.ok("agent_stop_reason" in selfEvalProps,
      "SelfEvaluation.agent_stop_reason is the only Agent stop-reason field");
    assert.ok(!("stop_reason" in selfEvalProps),
      "the old ambiguous Agent field must not survive");
    const receiptProps =
      (defs.SubmissionReceipt as SchemaNode).properties as SchemaNode;
    assert.ok("loop_stop_reason" in receiptProps);
    assert.ok("agent_stop_reason" in receiptProps);
    assert.ok(!("machineBackedSuccess" in receiptProps),
      "the receipt never duplicates the posture's machine fact");
    assert.ok(!JSON.stringify(schema).includes("fresh_round"));
  });

  it("v4.0.4: read-view names never become persisted protocol fields", () => {
    const defs = JSON.stringify(schema.$defs);
    for (const readOnly of ["agentStopReason", "loopStopReason", "sessionStatus"]) {
      assert.ok(!defs.includes(`"${readOnly}"`),
        `${readOnly} is a response/read-view fact, not a protocol $def`);
    }
    const selfEvalProps = ((schema.$defs as SchemaNode).SelfEvaluation as SchemaNode)
      .properties as SchemaNode;
    assert.ok("agent_stop_reason" in selfEvalProps);
  });
});
