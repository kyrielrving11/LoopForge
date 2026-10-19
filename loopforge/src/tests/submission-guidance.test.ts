/** v3.9.1: the field guide and submission_guidance projection. */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allFieldGuidePaths,
  deriveSubmissionGuidance,
  fieldExample,
  fieldGuideDescription,
  isFieldApplicable,
  isFieldPrompted,
  promptedFieldPaths,
  renderSelfEvalBlock,
  submittedFieldPaths,
  unknownExecutionReportFields,
  unknownTopLevelFields,
} from "../submission-guidance.js";
import type {
  GuidanceFacts,
  SelfEvalPromptContext,
} from "../submission-guidance.js";
import { TOOL_SCHEMAS } from "../mcp/tools.js";
import { buildLoopRequest } from "../mcp/round-lifecycle.js";
import type { McpSession } from "../mcp/round-lifecycle.js";
import type {
  CriterionStatus,
  LoopForgeResponse,
  SubGoal,
} from "../protocol.js";
import type { ActiveContractView } from "../round-contract.js";
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

describe("3.9.3 — MCP requests carry current-round context only", () => {
  it("buildLoopRequest no longer forwards last_round_result", () => {
    const request = buildLoopRequest(sessionView());
    assert.equal(request.last_round_result, undefined,
      "previous-round facts come from the committed Vault read model");
    assert.equal(request.attempt, 1);
    assert.equal(request.consecutive_rejections, 0);
  });

  it("restores the held attempt only while the snapshot belongs to the current round", () => {
    const session = sessionView({
      currentRound: 3,
      roundSnapshot: {
        ...(sessionView().roundSnapshot as object),
        round: 2,
        attempt: 2,
      } as McpSession["roundSnapshot"],
    });
    assert.equal(buildLoopRequest(session).attempt, 1,
      "a next-round compile must not inherit the previous round's retry");
    session.currentRound = 2;
    assert.equal(buildLoopRequest(session).attempt, 2,
      "an in-flight retry keeps its attempt");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.2 — compact trigger guidance and real criteria
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.2 — compact trigger guidance", () => {
  const criterion: CriterionStatus = {
    id: "cr-12345678",
    text: "All tests pass",
    status: "remaining",
    related_subgoal_ids: [],
  };
  const activeContract: ActiveContractView = {
    id: "rc-12345678",
    work_item: "Slice A",
    declared_at_round: 1,
    scope: ["src"],
    config_hash_by_command: {},
    items: [{
      id: "rci-12345678",
      description: "works",
      criterion_refs: [],
      subgoal_refs: [],
      verify_with: ["verify"],
    }],
  };
  const activeSubGoal: SubGoal = {
    id: "sg-12345678",
    description: "login works",
    status: "in_progress",
    declared_at_round: 1,
    status_changed_at_round: 1,
    priority: 0,
  };
  const doneSubGoal: SubGoal = { ...activeSubGoal, status: "done" };

  const facts = (overrides: Partial<GuidanceFacts> = {}): GuidanceFacts => ({
    activeContract: null,
    itemStatuses: null,
    subGoals: [],
    commands: ["verify"],
    contractVerificationAvailable: true,
    gateEnabled: false,
    criteria: [],
    ...overrides,
  });

  it("applies the semantic applicability rules", () => {
    assert.equal(isFieldApplicable("execution_report.criterion_claims", facts()), false);
    assert.equal(
      isFieldApplicable("execution_report.criterion_claims", facts({ criteria: [criterion] })),
      true,
    );
    assert.equal(isFieldApplicable("round_contract", facts()), true);
    assert.equal(
      isFieldApplicable("round_contract", facts({ activeContract })),
      false,
    );
    assert.equal(isFieldApplicable("round_contract", facts({ commands: [] })), false);
    assert.equal(isFieldApplicable("no_change_reason", facts()), false);
    assert.equal(isFieldApplicable("no_change_reason", facts({ commands: [] })), true);
    assert.equal(
      isFieldApplicable("execution_report.contract_item_claims", facts({ activeContract })),
      true,
    );
    assert.equal(isFieldApplicable("subgoal_updates", facts({ subGoals: [doneSubGoal] })), false);
    assert.equal(isFieldApplicable("subgoal_updates", facts({ subGoals: [activeSubGoal] })), true);
    assert.equal(isFieldApplicable("gate_ids", facts({ gateEnabled: true })), true);
    assert.equal(isFieldApplicable("gate_ids", facts()), false);
  });

  it("keeps one level-independent compact subset", () => {
    const compact = promptedFieldPaths(facts({ criteria: [criterion] }));
    assert.deepEqual(compact, [
      "execution_report.criterion_claims",
      "discovered_constraints",
      "wrong_assumptions",
      "emerged_subtasks",
      "worker_results",
      "compression_checkpoint",
      "prompt_requests",
    ]);
    assert.ok(compact.length <= 7, "the compact checklist is structurally max seven");
    assert.equal(isFieldPrompted("round_contract", facts()), false,
      "the dedicated contract renderer owns this field");
    assert.equal(isFieldPrompted("subgoal_updates", facts({ subGoals: [activeSubGoal] })), false,
      "the dedicated sub-goal renderer owns this field");
    assert.equal(isFieldPrompted("execution_report.contract_item_claims", facts({ activeContract })), false,
      "the dedicated contract-item renderer owns this field");
    assert.equal(isFieldPrompted("prompt_requests", facts()), true,
      "L0 can still submit next-prompt needs; only the receiving L0 ignores them");
  });

  it("uses a real criterion id and text, never the old placeholder", () => {
    const ctx = {
      activeContract: null,
      activeSubGoals: [],
      commands: [],
      contractVerificationAvailable: false,
      criteria: [criterion],
    };
    assert.deepEqual(
      fieldExample("execution_report.criterion_claims", ctx),
      [{ criterion_id: "cr-12345678", outcome: "met" }],
    );
    assert.equal(
      fieldExample("execution_report.criterion_claims", { ...ctx, criteria: [] }),
      null,
    );
  });

  it("renders the compact block with real criteria at L1", () => {
    const ctx: SelfEvalPromptContext = {
      round: 2,
      level: "l1",
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      verificationFlags: [],
      recovery: false,
      gateEnabled: false,
      criteria: [criterion],
    };
    const block = renderSelfEvalBlock(ctx);
    assert.match(block, /Optional fields — trigger → field → effect/);
    assert.match(block, /cr-12345678/);
    assert.match(block, /All tests pass/);
    assert.doesNotMatch(block, /<criterion text or cr id from the prompt>/);
    assert.doesNotMatch(block, /`objective_refinement`/);
  });

  it("keeps L0's field interface complete while its state body stays lean", () => {
    const ctx: SelfEvalPromptContext = {
      round: 2,
      level: "l0",
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      verificationFlags: [],
      recovery: true,
      gateEnabled: false,
      criteria: [criterion],
      currentRequirement: "Build the thing",
    };
    const block = renderSelfEvalBlock(ctx);
    for (const path of [
      "execution_report.criterion_claims",
      "discovered_constraints",
      "wrong_assumptions",
      "emerged_subtasks",
      "worker_results",
      "compression_checkpoint",
      "prompt_requests",
    ]) {
      assert.match(block, new RegExp(`\`${path.replace(/\./g, "\\.")}\``),
        `L0 must offer the applicable field ${path}`);
    }
    assert.match(block, /cr-12345678/);
    assert.match(block, /The current requirement is the natural work item/);
    assert.match(block, /No active contract/);
  });

  it("renders the current requirement as the natural contract work item", () => {
    const ctx: SelfEvalPromptContext = {
      round: 2,
      level: "l2",
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      verificationFlags: [],
      recovery: false,
      gateEnabled: false,
      criteria: [criterion],
      currentRequirement: "Build the thing",
    };
    const block = renderSelfEvalBlock(ctx);
    assert.match(block, /"work_item": "Build the thing"/);
    assert.match(block, /cr-12345678/);
    assert.match(block, /"verify_with": \[/);
    assert.match(block, /"verify"/);
    assert.doesNotMatch(block, /<the next slice, one line>/);
    assert.doesNotMatch(block, /\bsg-[a-f0-9]{8}\b/);
    assert.doesNotMatch(block, /\brci-[a-f0-9]{8}\b/);
  });

  it("makes an L0 committed files mismatch actionable without touching the gate", () => {
    const ctx: SelfEvalPromptContext = {
      round: 2,
      level: "l0",
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      verificationFlags: [{
        severity: "warn",
        field: "files_changed",
        check: "evidence_integrity",
        detail: "Agent files_changed doesn't match evidence: unreported: [a.ts]; unconfirmed: [b.ts]",
      }],
      recovery: false,
      gateEnabled: false,
      criteria: [criterion],
    };
    const block = renderSelfEvalBlock(ctx);
    assert.match(block, /Previous machine findings name these fields/);
    assert.match(block, /execution_report\.files_changed/);
    assert.match(block, /→ Action: Report only the net boundary change/);
    assert.match(block, /add every machine-observed path you omitted/);

    const l1Block = renderSelfEvalBlock({ ...ctx, level: "l1" });
    assert.doesNotMatch(l1Block, /→ Action: Report only the net boundary change/,
      "L1/L2 gate actions are not duplicated in the evaluation block");
  });

  it("caps criterion display without narrowing validation", () => {
    const criteria = Array.from({ length: 5 }, (_, index) => ({
      ...criterion,
      id: `cr-0000000${index}`,
      text: `Criterion ${index}`,
    }));
    const ctx: SelfEvalPromptContext = {
      round: 2,
      level: "l1",
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      verificationFlags: [],
      recovery: false,
      gateEnabled: false,
      criteria,
    };
    const block = renderSelfEvalBlock(ctx);
    assert.match(block, /\+2 more/);
    assert.doesNotMatch(block, /cr-00000003/);
  });

  it("exposes criteria in submission_guidance", () => {
    const session = {
      loopId: "guidance-criteria",
      currentRound: 1,
      lastCompileResponse: {
        criterion_statuses: [criterion],
        prompt_artifact: { level: "l1" },
      } as unknown as LoopForgeResponse,
    };
    const guidance = deriveSubmissionGuidance(session, { rounds: [] });
    assert.deepEqual(guidance.criteria, [{
      id: "cr-12345678",
      text: "All tests pass",
      status: "remaining",
    }]);
    const field = guidance.fields.find(
      (entry) => entry.path === "execution_report.criterion_claims");
    assert.ok(field);
    assert.deepEqual(field?.example, [{ criterion_id: "cr-12345678", outcome: "met" }]);
  });
});
