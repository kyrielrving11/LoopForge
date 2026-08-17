import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const schema = JSON.parse(readFileSync(new URL("../../../loopforge-protocol.json", import.meta.url), "utf8")) as {
  $defs: Record<string, unknown>;
};

describe("public v3 protocol schema", () => {
  it("contains only supported workflow and report contracts", () => {
    for (const name of ["StructuredPlan", "PlanStep", "RoundReportV1", "WorkflowState", "WorkspaceBinding", "StoreResolutionDiagnostic"]) {
      assert.ok(schema.$defs[name], `missing ${name}`);
    }
    for (const name of [
      "LoopCompileRequest",
      "LoopCompileResponse",
      "SessionState",
      "SubGoal",
      "NormalizedRoundEvaluation",
      "RoundEvidenceEnvelope",
      "NormalizedEvidenceItem",
      "RoundPromptMode",
      "ReportClaimTarget",
    ]) {
      assert.equal(schema.$defs[name], undefined, `${name} must remain internal or removed`);
    }
  });

  it("does not publish removed evaluation fields", () => {
    const text = JSON.stringify(schema);
    for (const symbol of ["progress_estimate", "next_action", "drift_clarification", "completed_subtasks", "last_round_result"]) {
      assert.doesNotMatch(text, new RegExp(symbol));
    }
  });
});
