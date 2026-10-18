/** v3.9.1: the field guide and submission_guidance projection. */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allFieldGuidePaths,
  deriveSubmissionGuidance,
  fieldGuideDescription,
  submittedFieldPaths,
  unknownExecutionReportFields,
  unknownTopLevelFields,
} from "../submission-guidance.js";
import { TOOL_SCHEMAS } from "../mcp/tools.js";
import { buildLoopRequest } from "../mcp/round-lifecycle.js";
import type { McpSession } from "../mcp/round-lifecycle.js";
import type { LoopForgeResponse, LoopRoundResult, SelfEvaluation } from "../protocol.js";
import { makeSelfEvaluation } from "../protocol.js";
import { deriveContractItemIds } from "../token-utils.js";
import { committedFeedbackRound } from "./_helpers.js";
import { decodeCommittedRound } from "../committed-round.js";
import { DEFAULT_POLICY, resetPolicy, setPolicyForTest } from "../policy.js";

const CONTRACT = {
  work_item: "Slice A",
  scope: ["src/a"],
  items: [{
    description: "the verification command passes",
    criterion_refs: [],
    subgoal_refs: [],
    verify_with: ["verify"],
  }],
};

function withVerifyCommand(): void {
  setPolicyForTest({
    ...DEFAULT_POLICY,
    evidence: {
      ...DEFAULT_POLICY.evidence,
      commands: [{
        name: "verify",
        enabled: true,
        executable: "node",
        args: ["--version"],
        phase: "after",
        required: true,
        timeout_ms: 1000,
        max_output_chars: 2000,
        success_exit_codes: [0],
      }],
    },
  });
}

function sessionView(overrides: Partial<McpSession> = {}): McpSession {
  return {
    sessionId: "s1",
    loopId: "guidance-loop",
    task: "Build the thing",
    engine: {} as McpSession["engine"],
    currentRound: 2,
    maxRounds: 20,
    successTrajectory: [],
    status: "running",
    createdAt: 0,
    consecutiveRejections: 0,
    lastRejectionCheck: "",
    backtrackSkippedFiles: [],
    backtrackSkippedFingerprints: {},
    evidenceBaseline: [],
    roundSnapshot: {
      schemaVersion: 2,
      roundId: "loop:guidance-loop:round:2",
      loopId: "guidance-loop",
      round: 2,
      attempt: 1,
      phase: "prompted",
      beforeEvidence: [],
      createdAt: 0,
      updatedAt: 0,
    },
    currentPrompt: "prompt",
    currentLevel: "l1",
    currentWarnings: [],
    ...overrides,
  } as McpSession;
}

afterEach(() => resetPolicy());

describe("v3.9.1 — FIELD_GUIDES and tool schema", () => {
  it("every top-level guide path is present with the guide's own description", () => {
    const next = TOOL_SCHEMAS.find((schema) => schema.name === "loopforge_next");
    assert.ok(next, "next schema exists");
    const evaluation = (next.inputSchema.properties as Record<string, unknown>)
      .evaluation as Record<string, unknown>;
    const properties = evaluation.properties as Record<string, { description?: string }>;
    for (const path of allFieldGuidePaths()) {
      if (path.startsWith("execution_report.")) continue;
      assert.ok(path in properties, `tool schema must advertise ${path}`);
      assert.equal(properties[path].description, fieldGuideDescription(path),
        `${path} description must come from FIELD_GUIDES`);
    }
  });

  it("does not advertise retired fields as evaluation properties", () => {
    const next = TOOL_SCHEMAS.find((schema) => schema.name === "loopforge_next");
    const evaluation = (next!.inputSchema.properties as Record<string, unknown>)
      .evaluation as Record<string, unknown>;
    const properties = evaluation.properties as Record<string, unknown>;
    assert.ok(!("progress_estimate" in properties));
    assert.ok(!("next_action" in properties));
  });

  it("unknown evaluation keys are allowed to reach the runtime normalizer", () => {
    const next = TOOL_SCHEMAS.find((schema) => schema.name === "loopforge_next");
    const evaluation = (next!.inputSchema.properties as Record<string, unknown>)
      .evaluation as Record<string, unknown>;
    assert.equal(evaluation.additionalProperties, true,
      "the runtime, not the transport, diagnoses unknown optional fields");
  });
});

describe("v3.9.1 — submitted-field manifest", () => {
  it("lists known present paths and excludes unknown fields", () => {
    const paths = submittedFieldPaths({
      success: true,
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
      execution_report: { files_changed: ["src/a.ts"], bogus: 1 },
      progress_estimate: 0.5,
    });
    assert.ok(paths.includes("execution_report.files_changed"));
    assert.ok(paths.includes("success"));
    assert.ok(!paths.includes("progress_estimate"));
  });

  it("separates unknown top-level and execution_report keys", () => {
    assert.deepEqual(
      unknownTopLevelFields({ success: true, progress_estimate: 1, next_action: "x" }),
      ["next_action", "progress_estimate"],
    );
    assert.deepEqual(
      unknownExecutionReportFields({ execution_report: { files_changed: [], foo: 1 } }),
      ["foo"],
    );
  });
});

describe("v3.9.1 — submission_guidance", () => {
  it("renders no submittable sg-/rci- reference when no contract or sub-goal exists", () => {
    withVerifyCommand();
    const guidance = deriveSubmissionGuidance(sessionView(), { rounds: [] });
    assert.equal(guidance.active_contract, null);
    assert.deepEqual(guidance.subgoals, []);
    for (const field of guidance.fields) {
      const serialized = JSON.stringify(field.example);
      assert.ok(!/rci-[a-f0-9]{8}/.test(serialized),
        `no fabricated rci id in ${field.path}`);
      assert.ok(!/sg-[a-f0-9]{8}/.test(serialized),
        `no fabricated sg id in ${field.path}`);
    }
    assert.ok(guidance.fields.some((field) => field.path === "round_contract"),
      "a first contract declaration is offered when a command exists");
  });

  it("renders real active-contract item ids and real sub-goal ids", () => {
    withVerifyCommand();
    const entry = committedFeedbackRound(1, {
      loopId: "guidance-loop",
      contract: CONTRACT,
      files: ["src/a.ts"],
    });
    const view = decodeCommittedRound(entry);
    assert.ok(view, "committed round decodes");
    const itemIds = deriveContractItemIds(CONTRACT.items);
    const subGoal = {
      id: "sg-12345678",
      description: "a real sub-goal",
      status: "pending" as const,
      declared_at_round: 1,
      status_changed_at_round: 1,
      priority: 0,
    };
    const guidance = deriveSubmissionGuidance(
      sessionView({
        lastCompileResponse: {
          sub_goals: [subGoal],
        } as unknown as LoopForgeResponse,
      }),
      { rounds: [view!] },
    );
    assert.equal(guidance.active_contract?.id.startsWith("rc-"), true);
    assert.deepEqual(guidance.active_contract?.items.map((item) => item.id), itemIds);
    assert.deepEqual(guidance.subgoals.map((item) => item.id), ["sg-12345678"]);
    const claim = guidance.fields.find(
      (field) => field.path === "execution_report.contract_item_claims",
    );
    assert.ok(claim?.example, "claim example exists");
    assert.ok(JSON.stringify(claim!.example).includes(itemIds[0]),
      "claim example cites the real item id");
    const update = guidance.fields.find((field) => field.path === "subgoal_updates");
    assert.ok(JSON.stringify(update?.example).includes("sg-12345678"));
  });

  it("is deterministic for the same facts", () => {
    withVerifyCommand();
    const a = deriveSubmissionGuidance(sessionView(), { rounds: [] });
    const b = deriveSubmissionGuidance(sessionView(), { rounds: [] });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

describe("v3.9.1 — worker discoveries are reports, not constraints", () => {
  it("buildLoopRequest forwards only top-level discovered_constraints", () => {
    const evaluation = makeSelfEvaluation({
      success: false,
      output_summary: "delegated",
      constraint_violations: [],
      should_continue: true,
      discovered_constraints: [],
      worker_results: [{
        agentId: "w1",
        subTask: "scan",
        resultSummary: "found a limit",
        outcome: "success",
        discoveredConstraints: ["never touch prod data"],
      }],
    });
    const request = buildLoopRequest(sessionView() as McpSession, evaluation);
    const result = request.last_round_result as LoopRoundResult | null | undefined;
    assert.ok(result, "last_round_result is forwarded");
    assert.deepEqual(result.discovered_constraints, [],
      "a worker discovery does not enter the global constraint stream");
    assert.equal(
      result.worker_results?.[0]?.discoveredConstraints?.[0],
      "never touch prod data",
      "the worker report itself is preserved",
    );
  });

  it("a top-level discovery is still forwarded", () => {
    const evaluation: SelfEvaluation = makeSelfEvaluation({
      success: false,
      output_summary: "accepted a worker finding",
      constraint_violations: [],
      should_continue: true,
      discovered_constraints: ["never touch prod data"],
      worker_results: [{
        agentId: "w1",
        subTask: "scan",
        resultSummary: "found a limit",
        outcome: "success",
        discoveredConstraints: ["never touch prod data"],
      }],
    });
    const request = buildLoopRequest(sessionView() as McpSession, evaluation);
    const result = request.last_round_result as Record<string, unknown> | undefined;
    assert.deepEqual(result?.discovered_constraints, ["never touch prod data"]);
  });
});
