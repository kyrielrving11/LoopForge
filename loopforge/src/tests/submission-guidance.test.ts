/** v3.9.1: the field guide and submission_guidance projection. */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allFieldGuidePaths,
  deriveSubmissionGuidance,
  fieldExample,
  fieldGuide,
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
  SubGoal,
} from "../protocol.js";
import type { ActiveContractView } from "../round-contract.js";
import { canonicalContractItemText, deriveContractItemIds, deriveCriterionId } from "../token-utils.js";
import { deriveEmergedItems } from "../subgoal-state.js";
import { committedFeedbackRound } from "./_helpers.js";
import { decodeCommittedRound } from "../committed-round.js";
import { DEFAULT_POLICY, resetPolicy, setPolicyForTest } from "../policy.js";
import { validateContractShape } from "../self-eval.js";

const CONTRACT = {
  work_item: "Slice A",
  scope: ["src/a"],
  items: [{
    description: "the verification command passes",
    criterion_refs: [],
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
    status: "running",
    createdAt: 0,
    consecutiveRejections: 0,
    lastRejectionCheck: "",
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

  it("v3.9.5: the round_contract guide names the required deliverable", () => {
    const next = TOOL_SCHEMAS.find((schema) => schema.name === "loopforge_next");
    const evaluation = (next!.inputSchema.properties as Record<string, unknown>)
      .evaluation as Record<string, unknown>;
    const contract = (evaluation.properties as Record<string, unknown>)
      .round_contract as Record<string, unknown>;
    // The transport keeps optional evaluation fields advisory so the runtime
    // can return contract_invalid instead of a JSON-RPC argument error.
    // The guide description still carries the strict declaration rule.
    assert.match(String(contract.description), /work_item/);
    assert.match(String(contract.description), /required/);
    assert.match(String(contract.description), /contract_invalid/);
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
      outcome: "success",
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
      execution_report: { files_changed: ["src/a.ts"], bogus: 1 },
      progress_estimate: 0.5,
    });
    assert.ok(paths.includes("execution_report.files_changed"));
    assert.ok(paths.includes("outcome"));
    assert.ok(!paths.includes("progress_estimate"));
  });

  it("separates unknown top-level and execution_report keys", () => {
    assert.deepEqual(
      unknownTopLevelFields({ outcome: "success", progress_estimate: 1, next_action: "x" }),
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

  it("v4.0.6: projects the contract requirement from the shared rule", () => {
    withVerifyCommand();
    const first = deriveSubmissionGuidance(sessionView(), { rounds: [] });
    assert.deepEqual(first.contract_requirement, {
      required_on_continue: true,
      successor_required_if_closed: false,
      reason: "no_active_contract",
      active_contract_id: null,
    });

    const view = decodeCommittedRound(committedFeedbackRound(1, {
      loopId: "guidance-loop",
      contract: CONTRACT,
    }));
    assert.ok(view, "committed round decodes");
    const active = deriveSubmissionGuidance(sessionView(), { rounds: [view!] });
    assert.equal(active.contract_requirement.required_on_continue, false);
    assert.equal(active.contract_requirement.successor_required_if_closed, true);
    assert.equal(active.contract_requirement.reason, "active_contract_continues");
    assert.equal(
      active.contract_requirement.active_contract_id,
      active.active_contract?.id,
    );

    const blockedRound = decodeCommittedRound(committedFeedbackRound(2, {
      loopId: "guidance-loop",
      outcome: "blocked",
      blocker: "waiting for operator input",
      shouldContinue: false,
      action: "stop",
    }));
    assert.ok(blockedRound, "blocked round decodes");
    // A committed blocked round closes the old contract. The next-round
    // projection therefore has no active contract; the same shared rule still
    // requires a proposal when the next round can exist.
    const afterClosed = deriveSubmissionGuidance(
      sessionView({ currentRound: 3 }),
      { rounds: [view!, blockedRound!] },
    );
    assert.equal(afterClosed.contract_requirement.required_on_continue, true);
    assert.equal(afterClosed.contract_requirement.reason, "no_active_contract");
    assert.equal(afterClosed.contract_requirement.active_contract_id, null);
    assert.equal(afterClosed.active_contract, null);

    const final = deriveSubmissionGuidance(
      sessionView({ currentRound: 20, maxRounds: 20 }),
      { rounds: [] },
    );
    assert.deepEqual(final.contract_requirement, {
      required_on_continue: false,
      successor_required_if_closed: false,
      reason: "no_successor_round",
      active_contract_id: null,
    });

    resetPolicy();
    const noCapability = deriveSubmissionGuidance(sessionView(), { rounds: [] });
    assert.deepEqual(noCapability.contract_requirement, {
      required_on_continue: false,
      successor_required_if_closed: false,
      reason: "no_contract_capability",
      active_contract_id: null,
    });
  });

  it("renders real active-contract item ids and real sub-goal ids", () => {
    withVerifyCommand();
    const subGoalText = "a real sub-goal";
    const entry = committedFeedbackRound(1, {
      loopId: "guidance-loop",
      contract: CONTRACT,
      files: ["src/a.ts"],
      emergedSubtasks: [subGoalText],
    });
    const view = decodeCommittedRound(entry);
    assert.ok(view, "committed round decodes");
    const itemIds = deriveContractItemIds(CONTRACT.items);
    const subGoalId = deriveEmergedItems("guidance-loop", 1, [subGoalText])[0]!.id;
    const guidance = deriveSubmissionGuidance(sessionView(), {
      rounds: [view!],
    });
    assert.equal(guidance.active_contract?.id.startsWith("rc-"), true);
    assert.deepEqual(guidance.active_contract?.items.map((item) => item.id), itemIds);
    assert.deepEqual(guidance.subgoals.map((item) => item.id), [subGoalId]);
    const claim = guidance.fields.find(
      (field) => field.path === "execution_report.claims",
    );
    assert.ok(claim?.example, "claim example exists");
    assert.ok(JSON.stringify(claim!.example).includes(itemIds[0]),
      "claim example cites the real item id");
    const update = guidance.fields.find((field) => field.path === "subgoal_updates");
    assert.ok(JSON.stringify(update?.example).includes(subGoalId));
  });

  it("is deterministic for the same facts", () => {
    withVerifyCommand();
    const a = deriveSubmissionGuidance(sessionView(), { rounds: [] });
    const b = deriveSubmissionGuidance(sessionView(), { rounds: [] });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});

describe("3.9.3 — MCP requests carry current-round context only", () => {
  it("buildLoopRequest carries current-round context only", () => {
    const request = buildLoopRequest(sessionView());
    assert.equal(request.attempt, 1);
    assert.equal(request.consecutive_rejections, 0);
    assert.equal(request.loop_id, "guidance-loop");
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
    assert.equal(isFieldApplicable("execution_report.claims", facts()), false);
    assert.equal(
      isFieldApplicable("execution_report.claims", facts({ criteria: [criterion] })),
      true,
    );
    assert.equal(
      isFieldApplicable("execution_report.claims", facts({ activeContract })),
      true,
    );
    assert.equal(isFieldApplicable("round_contract", facts()), true);
    assert.equal(
      isFieldApplicable("round_contract", facts({ activeContract })),
      true,
      "the contract channel stays usable while a contract is active",
    );
    assert.equal(isFieldApplicable("round_contract", facts({ commands: [] })), false);
    assert.equal(isFieldApplicable("no_change_reason", facts()), false);
    assert.equal(isFieldApplicable("no_change_reason", facts({ commands: [] })), true);

    assert.equal(isFieldApplicable("subgoal_updates", facts({ subGoals: [doneSubGoal] })), false);
    assert.equal(isFieldApplicable("subgoal_updates", facts({ subGoals: [activeSubGoal] })), true);
    assert.equal(isFieldApplicable("gate_ids", facts({ gateEnabled: true })), true);
    assert.equal(isFieldApplicable("gate_ids", facts()), false);
  });

  it("keeps one level-independent compact subset", () => {
    const compact = promptedFieldPaths(facts({ criteria: [criterion] }));
    assert.deepEqual(compact, [
      "execution_report.claims",
      "objective_refinement",
      "discovered_constraints",
      "wrong_assumptions",
      "open_questions",
      "resolved_open_question_ids",
      "emerged_subtasks",
      "worker_results",
      "subtask_boundary",
    ]);
    assert.ok(compact.length <= 9, "the compact checklist is structurally max nine");
    assert.equal(isFieldPrompted("round_contract", facts()), false,
      "the dedicated contract renderer owns this field");
    assert.equal(isFieldPrompted("subgoal_updates", facts({ subGoals: [activeSubGoal] })), false,
      "the dedicated sub-goal renderer owns this field");
    assert.equal(isFieldPrompted("execution_report.claims", facts({ activeContract })), true,
      "claims stay a compact opportunity while a contract is active");
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
      fieldExample("execution_report.claims", ctx),
      [{ id: "cr-12345678", outcome: "met" }],
    );
    assert.equal(
      fieldExample("execution_report.claims", { ...ctx, criteria: [] }),
      null,
    );
  });

  it("renders the minimal block with real claim ids and a guidance pointer", () => {
    const ctx: SelfEvalPromptContext = {
      round: 2,
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      gateEnabled: false,
      criteria: [criterion],
    };
    const block = renderSelfEvalBlock(ctx);
    assert.match(block, /Optional event fields/);
    assert.match(block, /cr-12345678/);
    assert.doesNotMatch(block, /All tests pass/,
      "the prompt does not repeat the criterion list");
    assert.match(block, /objective_refinement/);
    assert.match(block, /submission_guidance/);
  });

  it("keeps the optional field interface discoverable at every density", () => {
    const ctx: SelfEvalPromptContext = {
      round: 2,
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      gateEnabled: false,
      criteria: [criterion],
    };
    const block = renderSelfEvalBlock(ctx);
    for (const path of [
      "discovered_constraints",
      "wrong_assumptions",
      "open_questions",
      "emerged_subtasks",
      "worker_results",
      "subtask_boundary",
    ]) {
      assert.match(block, new RegExp(path.replace(/\./g, "\\.")),
        `the prompt must name the applicable field ${path}`);
    }
    assert.match(block, /cr-12345678/);
    assert.match(block, /No active Round Contract/);
  });

  it("pairs every optional event with its shared trigger and omits downstream prose", () => {
    const ctx: SelfEvalPromptContext = {
      round: 2,
      activeContract: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      criteria: [criterion],
    };
    const block = renderSelfEvalBlock(ctx);
    const lines = block.split("\n");
    const events: ReadonlyArray<[string, RegExp]> = [
      ["objective_refinement", /overall objective.*evolved/i],
      ["discovered_constraints", /limit.*not known before/i],
      ["wrong_assumptions", /evidence.*falsified.*earlier assumption/i],
      ["open_questions", /question.*affects later work/i],
      ["resolved_open_question_ids", /rendered open question.*resolved/i],
      ["emerged_subtasks", /new work.*work item.*split/i],
      ["worker_results", /work.*actually delegated/i],
      ["subtask_boundary", /subtask boundary.*L2/i],
    ];
    for (const [path, trigger] of events) {
      const line = lines.find((candidate) => candidate.endsWith(`→ \`${path}\``));
      assert.ok(line, `${path} must have its own event cue`);
      assert.match(line, trigger, `${path} must state when to report it`);
      const guide = fieldGuide(path)!;
      assert.ok(line.includes(guide.when), `${path} uses the existing when source`);
      assert.ok(!line.includes(guide.downstream), `${path} does not repeat its effect`);
    }
    assert.match(block, /only when the event happened/i);
  });

  it("keeps the file observation scope visible in live guidance and the field description", () => {
    const guidance = deriveSubmissionGuidance(sessionView(), { rounds: [] });
    const files = guidance.fields.find((entry) => entry.path === "execution_report.files_changed");
    assert.ok(files);
    for (const text of [files.when, fieldGuideDescription(files.path)]) {
      assert.match(text, /net content\/type change from round start/i);
      assert.match(text, /including deletions/i);
      assert.match(text, /commit alone adds nothing/i);
      assert.match(text, /only tracked and non-ignored untracked paths/i);
    }
  });

  it("gives live guidance and the prompt the same legal redirect object with the active id", () => {
    withVerifyCommand();
    const view = decodeCommittedRound(committedFeedbackRound(1, {
      loopId: "guidance-loop",
      contract: CONTRACT,
    }));
    assert.ok(view);
    const guidance = deriveSubmissionGuidance(sessionView(), { rounds: [view] });
    const example = guidance.fields.find((entry) => entry.path === "round_contract")
      ?.example as Record<string, unknown>;
    assert.ok(example);
    const modifier = example.supersedes as { contract_id: string; reason?: string };
    assert.equal(modifier.contract_id, guidance.active_contract?.id);
    assert.equal(typeof modifier.reason, "string");
    assert.deepEqual(validateContractShape({
      outcome: "partial",
      should_continue: true,
      round_contract: example,
    }, {
      observed: true,
      activeContractId: guidance.active_contract!.id,
      activeItemIdentities: new Set(CONTRACT.items.map(canonicalContractItemText)),
      activeItemIds: new Set(guidance.active_contract!.items.map((item) => item.id)),
      knownCriterionIds: new Set(),
      isConfiguredCommand: (name) => guidance.contract_commands.includes(name),
    }), [], "the advertised redirect example passes the real strict boundary");
    const block = renderSelfEvalBlock({
      round: 2,
      activeContract: { ...activeContract, id: guidance.active_contract!.id },
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
    });
    const json = block.match(/`round_contract\.supersedes`: `([^`]+)`/);
    assert.ok(json, "the prompt must show a JSON object, not just an id");
    assert.deepEqual(JSON.parse(json[1]), modifier);
    assert.match(block, /reason optional/);
    const first = fieldExample("round_contract", {
      activeContract: null,
      activeSubGoals: [],
      commands: ["verify"],
      contractVerificationAvailable: true,
    }) as Record<string, unknown>;
    assert.ok(!("supersedes" in first), "a first proposal never invents a redirect target");
  });

  it("v4.0.6: active-contract guidance follows the shared coverage rule", () => {
    const activeContract = {
      id: "rc-12345678",
      declared_at_round: 1,
      work_item: "Slice A",
      scope: [],
      items: [{
        id: "rci-12345678",
        description: "works",
        criterion_refs: [],
        verify_with: ["verify"],
      }],
      config_hash_by_command: {},
    } as NonNullable<SelfEvalPromptContext["activeContract"]>;
    const base: SelfEvalPromptContext = {
      round: 2,
      activeContract,
      itemStatuses: null,
      commands: [],
      contractVerificationAvailable: false,
      subGoals: [],
      gateEnabled: false,
    };
    const noCapability = renderSelfEvalBlock(base);
    assert.match(noCapability,
      /cannot be machine-verified and no successor is required/);
    assert.doesNotMatch(noCapability,
      /successor `round_contract` is REQUIRED/);

    const withCapability = renderSelfEvalBlock({
      ...base,
      commands: ["verify"],
      contractVerificationAvailable: true,
    });
    assert.match(withCapability,
      /If this round closes the contract and you continue, a successor/);
    assert.match(withCapability, /successor `round_contract` is REQUIRED/);
  });

  it("uses schema placeholders instead of seeding a task-specific contract", () => {
    const ctx: SelfEvalPromptContext = {
      round: 2,
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      gateEnabled: false,
      criteria: [criterion],
    };
    const block = renderSelfEvalBlock(ctx);
    assert.match(block, /"work_item": "<bounded deliverable>"/);
    assert.match(block, /"verify_with": \[/);
    assert.match(block, /"verify"/);
    assert.doesNotMatch(block, /"work_item": "All tests pass"/,
      "the example must not seed a real criterion as the slice");
    assert.match(block, /"criterion_refs": \[\]/,
      "the contract example is schema-only");
    assert.doesNotMatch(block, /\bsg-[a-f0-9]{8}\b/);
    assert.doesNotMatch(block, /\brci-[a-f0-9]{8}\b/);
  });

  it("leaves finding fields and actions to the Verification Gate", () => {
    const ctx: SelfEvalPromptContext = {
      round: 2,
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      gateEnabled: false,
      criteria: [criterion],
    };
    const block = renderSelfEvalBlock(ctx);
    assert.doesNotMatch(block, /Previous machine findings name these fields/);
    assert.doesNotMatch(block, /→ (Fix|Action):/);
  });

  it("uses one real claim id and never lists the criteria", () => {
    const criteria = Array.from({ length: 5 }, (_, index) => ({
      ...criterion,
      id: `cr-0000000${index}`,
      text: `Criterion ${index}`,
    }));
    const ctx: SelfEvalPromptContext = {
      round: 2,
      activeContract: null,
      itemStatuses: null,
      commands: ["verify"],
      contractVerificationAvailable: true,
      subGoals: [],
      gateEnabled: false,
      criteria,
    };
    const block = renderSelfEvalBlock(ctx);
    assert.match(block, /cr-00000000/);
    assert.doesNotMatch(block, /cr-00000003/);
    assert.doesNotMatch(block, /Criterion 3/);
  });

  it("derives criteria from the operator objective and committed claims", () => {
    const text = "All tests pass";
    const id = deriveCriterionId(text);
    const entry = committedFeedbackRound(1, {
      loopId: "guidance-criteria",
      remaining: [text],
    });
    const view = decodeCommittedRound(entry);
    assert.ok(view, "committed round decodes");
    const guidance = deriveSubmissionGuidance(
      { loopId: "guidance-criteria", currentRound: 2 },
      { rounds: [view!], objective: { success_criteria: [text] } },
    );
    assert.deepEqual(guidance.criteria, [{ id, text, status: "remaining" }]);
    const field = guidance.fields.find(
      (entry) => entry.path === "execution_report.claims");
    assert.ok(field);
    assert.deepEqual(field?.example, [{ id, outcome: "met" }]);
  });
});
