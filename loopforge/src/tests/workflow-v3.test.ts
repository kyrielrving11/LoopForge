import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import { getPolicy, resetPolicy } from "../policy.js";
import { registerEvidenceProvider, unregisterEvidenceProvider } from "../evidence-provider.js";
import type { RoundReportV1, StructuredPlan } from "../protocol.js";
import { MemoryBackend } from "./_helpers.js";
import { normalizeRoundReport, stableClaimId } from "../round-report.js";

function plan(risk = false): StructuredPlan {
  return {
    objective: "Implement one safe change",
    successCriteria: ["verified"],
    constraints: ["preserve architecture"],
    steps: [{
      id: "ps-change",
      title: "Implement and verify",
      kind: "executable",
      dependsOn: [],
      scope: ["src/example.ts"],
      successCriteria: ["verified"],
      constraints: ["preserve architecture"],
      acceptanceCriteria: ["change works"],
      evidenceRequirements: ["tests pass"],
      refinement: "executable",
      riskTags: risk ? ["production_change"] : [],
      status: "ready",
    }],
  };
}

function completedReport(targets: Array<["ac" | "er" | "cr", string]> = [
  ["ac", "change works"],
  ["er", "tests pass"],
]): RoundReportV1 {
  return {
    status: "completed",
    summary: "Completed the assigned step and verified it.",
    evidence: {
      checks: [{ name: "test", status: "passed", counts: { passed: 3, failed: 0, skipped: 0 } }],
      claims: targets.map(([prefix, text]) => ({
        targetId: stableClaimId(prefix, text),
        evidenceRefs: ["check:test"],
      })),
      noChangeReason: "Workflow fixture validation does not modify repository files.",
    },
  };
}

async function submitReport(
  manager: SessionManager,
  sessionId: string,
  report: unknown,
  roundId?: string,
) {
  return TOOL_HANDLERS.loopforge_next(manager, {
    sessionId,
    roundId: roundId ?? manager.get(sessionId)?.roundSnapshot?.roundId,
    report,
  });
}

describe("MCP v3 planning workflow", () => {
  let manager: SessionManager;

  beforeEach(() => {
    resetPolicy();
    registerEvidenceProvider("test", () => ({
      name: "test",
      capture: () => ({
        provider: "test",
        timestamp: Date.now(),
        files: [],
        data: {
          kind: "command",
          commandName: "test",
          required: false,
          status: "passed",
          claimIds: [
            stableClaimId("ac", "change works"),
            stableClaimId("er", "tests pass"),
            stableClaimId("cr", "verified"),
          ],
        },
      }),
    }));
    getPolicy().evidence.providers = ["git", "test"];
    manager = new SessionManager(new MemoryBackend());
  });

  afterEach(() => {
    unregisterEvidenceProvider("test");
  });

  it("starts in planning without consuming Round 1", async () => {
    const result = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature" });
    assert.equal(result.phase, "planning");
    assert.equal(result.requiredAction, "submit_plan");
    assert.equal(result.round, 1);
    assert.equal(result.roundId, undefined);
  });

  it("reports workflow, constraint, evidence, stall, and readiness health", async () => {
    const started = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Implement feature",
      plan: plan(),
    });
    const loopId = manager.get(String(started.sessionId))!.loopId;
    const health = await TOOL_HANDLERS.loopforge_health(manager, {
      loopId,
    });

    assert.equal(health.loopId, loopId);
    assert.ok(health.workflow_alignment);
    assert.ok(health.constraint_integrity);
    assert.ok(health.evidence_integrity);
    assert.ok(health.stall_risk);
    assert.equal(health.readiness, "executing");
    assert.ok(health.progress);
    for (const removed of [
      "goal_alignment",
      "drift_detected",
      "strategy_stability",
      "task_continuity",
    ]) {
      assert.equal(health[removed], undefined);
    }
  });

  it("auto-enters execution for a low-risk plan and rejects stale round identity", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature" });
    const sessionId = String(start.sessionId);
    const submitted = await TOOL_HANDLERS.loopforge_plan_submit(manager, { sessionId, plan: plan() });
    assert.equal(submitted.phase, "executing");
    assert.equal(submitted.activeStepId, "ps-change");
    assert.equal(submitted.round, 1);
    assert.equal(typeof submitted.roundId, "string");
    assert.match(String(submitted.prompt), /ps-change/);
    assert.match(String(submitted.prompt), /Execute only the assigned active step/);

    const rejected = await submitReport(manager, sessionId, {
      status: "in_progress",
      summary: "Result belongs to a stale prompt.",
    }, "stale-round-id");
    assert.equal(rejected.requiredAction, "resubmit_round");
    assert.match(String(rejected.enforcementReason), /stale roundId/);
  });

  it("supports session-level every_revision approval for a low-risk plan", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Implement feature",
      approvalPolicy: "every_revision",
      plan: plan(),
    });
    const sessionId = String(start.sessionId);
    assert.equal(start.phase, "awaiting_approval");
    assert.equal(start.requiredAction, "approve_plan");
    assert.equal(start.approvalPolicy, "every_revision");

    const session = manager.get(sessionId)!;
    const approved = await TOOL_HANDLERS.loopforge_plan_approve(manager, {
      sessionId,
      approvalId: start.approvalId,
      planVersion: session.workflow.planVersion,
      decision: "approved",
      reason: "Review the initial plan",
    });
    assert.equal(approved.phase, "executing");
    assert.equal(manager.get(sessionId)?.workflow.approvalPolicy, "every_revision");
  });

  it("requires approval again when every_revision refines an outline", async () => {
    const outline = plan();
    outline.steps[0] = {
      ...outline.steps[0],
      kind: "outline",
      refinement: "outline",
      acceptanceCriteria: [],
      evidenceRequirements: [],
    };
    const start = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Implement feature",
      approvalPolicy: "every_revision",
      plan: outline,
    });
    const sessionId = String(start.sessionId);
    assert.equal(start.phase, "awaiting_approval");
    let session = manager.get(sessionId)!;
    const firstApproval = await TOOL_HANDLERS.loopforge_plan_approve(manager, {
      sessionId,
      approvalId: start.approvalId,
      planVersion: session.workflow.planVersion,
      decision: "approved",
      reason: "Review the phase outline",
    });
    assert.equal(firstApproval.requiredAction, "refine_plan");

    const refined = plan();
    const updated = await TOOL_HANDLERS.loopforge_plan_update(manager, {
      sessionId,
      baseVersion: 1,
      plan: refined,
      reason: "Refine the approved phase",
      changeSummary: "Replace the outline with an executable step",
      evidenceReferences: ["check:plan"],
    });
    assert.equal(updated.phase, "awaiting_approval");
    assert.equal(updated.requiredAction, "approve_plan");
    assert.equal(updated.approvalPolicy, "every_revision");
    session = manager.get(sessionId)!;
    assert.equal(session.workflow.planVersion, 2);
  });

  it("rejects an invalid session approval policy", async () => {
    await assert.rejects(
      TOOL_HANDLERS.loopforge_start(manager, {
        task: "Implement feature",
        approvalPolicy: "manual" as never,
      }),
      /invalid approvalPolicy/,
    );
  });

  it("persists the approval policy across a session restart", async () => {
    const backend = new MemoryBackend();
    const first = new SessionManager(backend);
    const started = await TOOL_HANDLERS.loopforge_start(first, {
      task: "Implement feature",
      loopId: "approval-policy-restart",
      approvalPolicy: "every_revision",
      plan: plan(),
    });
    assert.equal(started.phase, "awaiting_approval");
    first.close();

    const restarted = new SessionManager(backend);
    const resumed = restarted.resume("approval-policy-restart");
    assert.ok(resumed);
    assert.equal(restarted.get(String(resumed?.sessionId))?.workflow.approvalPolicy, "every_revision");
    assert.equal(restarted.get(String(resumed?.sessionId))?.workflow.phase, "awaiting_approval");
    restarted.close();
  });

  it("requires exact approval for a high-risk plan", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Deploy change" });
    const sessionId = String(start.sessionId);
    const submitted = await TOOL_HANDLERS.loopforge_plan_submit(manager, { sessionId, plan: plan(true) });
    assert.equal(submitted.phase, "awaiting_approval");
    assert.equal(submitted.requiredAction, "approve_plan");
    assert.equal(typeof submitted.approvalId, "string");
    const session = manager.get(sessionId)!;
    const approved = await TOOL_HANDLERS.loopforge_plan_approve(manager, {
      sessionId,
      approvalId: submitted.approvalId,
      planVersion: session.workflow.planVersion,
      decision: "approved",
      reason: "User approved the production impact",
    });
    assert.equal(approved.phase, "executing");
    assert.equal(approved.round, 1);
  });

  it("moves from the final executable step to audit before completed", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan: plan() });
    const sessionId = String(start.sessionId);
    const audit = await submitReport(manager, sessionId, completedReport());
    assert.equal(audit.phase, "auditing");
    assert.equal(audit.requiredAction, "execute_audit");
    assert.equal(audit.activeStepId, "audit-final");
    assert.equal(audit.terminal, false);
    assert.match(String(audit.prompt), /LoopForge Final Audit/);

    const completed = await submitReport(manager, sessionId, completedReport([["cr", "verified"]]));
    assert.equal(completed.stopReason, "completed");
    assert.equal(completed.phase, "terminal");
    assert.equal(completed.terminal, true);
  });

  it("requests rolling refinement for an outline and rejects stale updates", async () => {
    const outline = plan();
    outline.steps[0] = {
      ...outline.steps[0],
      kind: "outline",
      refinement: "outline",
      acceptanceCriteria: [],
      evidenceRequirements: [],
    };
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan: outline });
    const sessionId = String(start.sessionId);
    assert.equal(start.requiredAction, "refine_plan");
    assert.equal(start.round, 1);
    const stale = await TOOL_HANDLERS.loopforge_plan_update(manager, {
      sessionId,
      baseVersion: 99,
      plan: plan(),
      reason: "refined after repository inspection",
      changeSummary: "made ps-change executable",
      evidenceReferences: ["src/example.ts"],
    });
    assert.match(String(stale.stopDetail), /Stale plan/);
    const updated = await TOOL_HANDLERS.loopforge_plan_update(manager, {
      sessionId,
      baseVersion: 1,
      plan: plan(),
      reason: "refined after repository inspection",
      changeSummary: "made ps-change executable",
      evidenceReferences: ["src/example.ts"],
    });
    assert.equal(updated.phase, "executing");
    assert.equal(updated.planVersion, 2);
    assert.equal(updated.round, 1);
  });

  it("requires approval before weakening an active step contract", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan: plan() });
    const sessionId = String(start.sessionId);
    const planning = await submitReport(manager, sessionId, {
      status: "in_progress",
      summary: "The active step contract needs revision before continuing.",
      planChangeRequest: {
        timing: "before_continue",
        reason: "Clarify the acceptance and evidence contract",
        affectedIds: ["ps-change"],
      },
    });
    assert.equal(planning.phase, "planning");

    const revised = plan();
    revised.steps[0].acceptanceCriteria = ["summary written"];
    revised.steps[0].evidenceRequirements = ["manual confirmation"];
    const updated = await TOOL_HANDLERS.loopforge_plan_update(manager, {
      sessionId,
      baseVersion: 1,
      plan: revised,
      reason: "Weakened contract for a manual-only check",
      changeSummary: "Changed active acceptance and evidence requirements",
      evidenceReferences: ["review:contract"],
    });
    assert.equal(updated.phase, "awaiting_approval");
    assert.equal(updated.requiredAction, "approve_plan");
  });

  it("serializes concurrent plan updates and rejects the stale writer", async () => {
    const outline = plan();
    outline.steps[0] = {
      ...outline.steps[0],
      kind: "outline",
      refinement: "outline",
      acceptanceCriteria: [],
      evidenceRequirements: [],
    };
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan: outline });
    const sessionId = String(start.sessionId);
    const first = plan();
    first.steps[0].title = "Implement first revision";
    const second = plan();
    second.steps[0].title = "Implement competing revision";

    const results = await Promise.all([
      TOOL_HANDLERS.loopforge_plan_update(manager, {
        sessionId,
        baseVersion: 1,
        plan: first,
        reason: "repository evidence changed",
        changeSummary: "clarified the active step title",
        evidenceReferences: ["src/example.ts"],
      }),
      TOOL_HANDLERS.loopforge_plan_update(manager, {
        sessionId,
        baseVersion: 1,
        plan: second,
        reason: "repository evidence changed",
        changeSummary: "clarified the active step title differently",
        evidenceReferences: ["src/example.ts"],
      }),
    ]);

    const stale = results.find((result) => String(result.stopDetail).includes("Stale plan"));
    assert.ok(stale, "one concurrent writer must be rejected as stale");
    assert.equal(results.filter((result) => !String(result.stopDetail).includes("Stale plan")).length, 1);
    assert.equal(manager.get(sessionId)?.workflow.planVersion, 2);
  });

  it("restores the effective plan revision and step outcomes for a backtrack target", async () => {
    const initial = plan();
    initial.steps.push({
      id: "ps-followup",
      title: "Refine follow-up",
      kind: "outline",
      dependsOn: ["ps-change"],
      scope: ["src/followup.ts"],
      successCriteria: ["verified"],
      constraints: ["preserve architecture"],
      acceptanceCriteria: [],
      evidenceRequirements: [],
      refinement: "outline",
      riskTags: [],
      status: "ready",
    });
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan: initial });
    const sessionId = String(start.sessionId);
    await submitReport(manager, sessionId, completedReport());

    const session = manager.get(sessionId)!;
    const revised = structuredClone(session.workflow.plan!);
    revised.steps[1] = {
      id: "ps-followup",
      title: "Verify follow-up",
      kind: "executable",
      dependsOn: ["ps-change"],
      scope: ["src/followup.ts"],
      successCriteria: ["verified"],
      constraints: ["preserve architecture"],
      acceptanceCriteria: ["follow-up works"],
      evidenceRequirements: ["tests pass"],
      refinement: "executable",
      riskTags: [],
      status: "ready",
    };
    const updated = await TOOL_HANDLERS.loopforge_plan_update(manager, {
      sessionId,
      baseVersion: 1,
      plan: revised,
      reason: "new follow-up evidence",
      changeSummary: "added a follow-up verification step",
      evidenceReferences: ["src/followup.ts"],
    });
    assert.equal(updated.planVersion, 2);

    const restore = manager as unknown as {
      restoreWorkflowToRound(value: object, targetRound: number): void;
    };
    restore.restoreWorkflowToRound(session, 1);

    assert.equal(session.workflow.planVersion, 1);
    assert.equal(session.workflow.plan?.steps.length, 2);
    assert.equal(session.workflow.plan?.steps[0].status, "done");
    assert.equal(session.workflow.activeStepId, null);
    assert.equal(session.workflow.phase, "executing");
  });

  it("reselects the restored plan step and compiles a branch-aware backtrack prompt", async () => {
    const twoSteps = plan();
    twoSteps.steps.push({
      id: "ps-second",
      title: "Verify the second change",
      kind: "executable",
      dependsOn: ["ps-change"],
      scope: ["src/second.ts"],
      successCriteria: ["verified"],
      constraints: ["preserve architecture"],
      acceptanceCriteria: ["second change works"],
      evidenceRequirements: ["second tests pass"],
      refinement: "executable",
      riskTags: [],
      status: "pending",
    });
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement two changes", plan: twoSteps });
    const sessionId = String(start.sessionId);
    await submitReport(manager, sessionId, completedReport());
    const session = manager.get(sessionId)!;
    assert.equal(session.workflow.activeStepId, "ps-second");

    const backtrackManager = manager as unknown as {
      buildBacktrackResult(id: string, value: typeof session, result: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
    const result = await backtrackManager.buildBacktrackResult(sessionId, session, {
      action: "backtrack",
      success: false,
      verificationFlags: [],
      enforcementReason: "review reproduction",
      backtrackTarget: 1,
      backtrackPrompt: "The prior branch failed because its evidence stalled.",
      backtrackSkippedDiscoveries: [],
      backtrackSkippedFiles: [],
      backtrackTriggerRule: "R4",
    });

    assert.equal(session.executionEpoch, 1);
    assert.equal(session.workflow.activeStepId, "ps-second");
    assert.match(String(result.roundId), /:epoch:1:round:2$/);
    assert.match(String(result.prompt), /ps-second/);
    assert.match(String(result.prompt), /Required claims:/);
    assert.match(String(result.prompt), /prior branch failed/);
    assert.equal(session.roundSnapshot?.promptArtifact?.renderedPrompt, result.prompt);
  });

  it("returns rejected approvals to planning", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Deploy change", plan: plan(true) });
    const sessionId = String(start.sessionId);
    const session = manager.get(sessionId)!;
    const result = await TOOL_HANDLERS.loopforge_plan_approve(manager, {
      sessionId,
      approvalId: session.workflow.approvalId,
      planVersion: session.workflow.planVersion,
      decision: "rejected",
      reason: "Risk is not acceptable",
    });
    assert.equal(result.phase, "planning");
    assert.equal(result.requiredAction, "refine_plan");
    assert.match(String(result.prompt), /rejected plan version/i);
  });

  it("persists start constraints and rejects plans that omit them", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Implement feature",
      constraints: ["MUST-NOT-TOUCH-PRODUCTION"],
    });
    const sessionId = String(start.sessionId);
    const submitted = await TOOL_HANDLERS.loopforge_plan_submit(manager, {
      sessionId,
      plan: plan(),
    });
    assert.equal(submitted.phase, "planning");
    assert.match(String(submitted.prompt), /omits session hard constraints/);
    assert.deepEqual(manager.get(sessionId)?.workflow.baselineConstraints, ["MUST-NOT-TOUCH-PRODUCTION"]);

    const corrected = plan();
    corrected.constraints.push("MUST-NOT-TOUCH-PRODUCTION");
    corrected.steps[0].constraints.push("MUST-NOT-TOUCH-PRODUCTION");
    const accepted = await TOOL_HANDLERS.loopforge_plan_submit(manager, { sessionId, plan: corrected });
    assert.match(String(accepted.prompt), /MUST-NOT-TOUCH-PRODUCTION/);
  });

  it("rejects client-owned completed states in an initial plan", async () => {
    const supplied = plan();
    supplied.steps[0].status = "done";
    const result = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan: supplied });
    assert.equal(result.phase, "planning");
    assert.match(String(result.prompt), /initial plan status must be pending or ready/);
    assert.equal(result.planVersion, null);
  });

  it("does not complete a plan step without success and evidence", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan: plan() });
    const sessionId = String(start.sessionId);
    const result = await submitReport(manager, sessionId, {
      status: "completed",
      summary: "Implementation failed",
    });
    assert.equal(result.enforcementAction, "reject");
    assert.match(String(result.enforcementReason), /requires evidence/);
    assert.equal(manager.get(sessionId)?.workflow.plan?.steps[0].status, "active");
  });

  it("requires active regression obligations on later step completion", async () => {
    const twoSteps = plan();
    twoSteps.steps.push({
      id: "ps-second",
      title: "Make a follow-up change",
      kind: "executable",
      dependsOn: ["ps-change"],
      scope: ["src/second.ts"],
      successCriteria: ["verified"],
      constraints: ["preserve architecture"],
      acceptanceCriteria: ["follow-up works"],
      evidenceRequirements: ["follow-up tests pass"],
      refinement: "executable",
      riskTags: [],
      status: "pending",
    });
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement two changes", plan: twoSteps });
    const sessionId = String(start.sessionId);
    await submitReport(manager, sessionId, completedReport());

    const missingRegression = await submitReport(manager, sessionId, {
      status: "completed",
      summary: "Follow-up implementation is complete.",
      evidence: {
        checks: [{ name: "test", status: "passed", counts: { passed: 1, failed: 0, skipped: 0 } }],
        claims: [
          { targetId: stableClaimId("ac", "follow-up works"), evidenceRefs: ["check:test"] },
          { targetId: stableClaimId("er", "follow-up tests pass"), evidenceRefs: ["check:test"] },
        ],
      },
    });
    assert.equal(missingRegression.enforcementAction, "reject");
    assert.match(String(missingRegression.enforcementReason), /regression obligations missing/i);
  });

  it("requires every final criterion but accepts runtime checks without Agent duplication", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan: plan() });
    const sessionId = String(start.sessionId);
    await submitReport(manager, sessionId, completedReport());

    const missingCriterion = completedReport([]);
    const rejectedCriterion = await submitReport(manager, sessionId, missingCriterion);
    assert.equal(rejectedCriterion.enforcementAction, "reject");
    assert.match(String(rejectedCriterion.enforcementReason), /missing claim/);

    const runtimeVerified = completedReport([["cr", "verified"]]);
    runtimeVerified.evidence!.checks = [];
    const completed = await submitReport(manager, sessionId, runtimeVerified);
    assert.equal(completed.stopReason, "completed");
    assert.equal(completed.terminal, true);
  });

  it("blocks plan mutation and approval while paused", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Deploy change", plan: plan(true) });
    const sessionId = String(start.sessionId);
    assert.equal(manager.pause(sessionId).status, "paused");
    const approval = await TOOL_HANDLERS.loopforge_plan_approve(manager, {
      sessionId,
      approvalId: start.approvalId,
      planVersion: start.planVersion,
      decision: "approved",
      reason: "should not be accepted",
    });
    assert.equal(approval.stopReason, "paused");
    assert.equal(manager.get(sessionId)?.workflow.phase, "awaiting_approval");
  });

  it("rejects plan updates during execution without replacing the prompt artifact", async () => {
    const start = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan: plan() });
    const sessionId = String(start.sessionId);
    const before = manager.get(sessionId)?.roundSnapshot?.promptArtifact?.promptHash;
    const revised = plan();
    revised.steps[0].title = "Changed while executing";
    const result = await TOOL_HANDLERS.loopforge_plan_update(manager, {
      sessionId,
      baseVersion: 1,
      plan: revised,
      reason: "late change",
      changeSummary: "invalid active-round mutation",
      evidenceReferences: [],
    });
    assert.match(String(result.stopDetail), /planning or refinement boundary/);
    assert.equal(manager.get(sessionId)?.roundSnapshot?.promptArtifact?.promptHash, before);
    assert.equal(manager.get(sessionId)?.workflow.planVersion, 1);
  });

  it("rehydrates full state at the next plan-step boundary", async () => {
    const multiStep = plan();
    multiStep.steps.push({
      ...structuredClone(multiStep.steps[0]),
      id: "ps-followup",
      title: "Verify follow-up",
      dependsOn: ["ps-change"],
      status: "ready",
    });
    const start = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Implement one safe change",
      plan: multiStep,
    });
    const next = await submitReport(manager, String(start.sessionId), completedReport());
    assert.equal(start.level, "l2");
    assert.equal(next.level, "l2");
    assert.deepEqual(
      manager.get(String(start.sessionId))?.roundSnapshot?.promptArtifact?.levelReasons,
      ["plan_boundary"],
    );
  });

  it("replays a committed step result through the workflow reducer after a crash", async () => {
    const backend = new MemoryBackend();
    const first = new SessionManager(backend);
    const started = await TOOL_HANDLERS.loopforge_start(first, {
      task: "Implement feature",
      loopId: "workflow-crash-replay",
      plan: plan(),
    });
    const session = first.get(String(started.sessionId))!;
    const transaction = first as unknown as {
      executeRoundTransaction(value: object, evaluation: object): Promise<unknown>;
    };
    const evaluation = normalizeRoundReport(
      completedReport(),
      "executing",
      "ps-change",
      [stableClaimId("ac", "change works"), stableClaimId("er", "tests pass")],
    );
    await transaction.executeRoundTransaction(
      session,
      evaluation,
    );
    first.close();

    const restarted = new SessionManager(backend);
    const resumed = restarted.resume("workflow-crash-replay");
    const recovered = restarted.get(String(resumed?.sessionId));
    assert.equal(recovered?.workflow.plan?.steps[0].status, "done");
    assert.equal(recovered?.workflow.phase, "auditing");
    assert.equal(recovered?.workflow.activeStepId, "audit-final");
    assert.equal(recovered?.currentRound, 2);
  });

  it("rejects persisted pre-v3 sessions without workflow metadata", async () => {
    const backend = new MemoryBackend();
    backend.appendEntry({
      task_id: "loop:legacy-v2:session",
      task_type: "session_state",
      loop_id: "legacy-v2",
      task: "Continue legacy task",
      loop_lineage: {
        session_id: "legacy-session",
        current_round: 2,
        max_rounds: 10,
        success_trajectory: [],
        status: "paused",
        created_at: Date.now(),
      },
    });
    const restarted = new SessionManager(backend);
    await assert.rejects(() => restarted.unpause("legacy-v2"), /session_version_unsupported/);
  });

  it("stops honestly when an external gate is the only remaining node", async () => {
    const external = plan();
    external.steps[0] = {
      ...external.steps[0],
      id: "ps-release-gate",
      title: "Obtain production approval",
      kind: "external_gate",
      evidenceRequirements: ["approved production change ticket"],
      acceptanceCriteria: ["ticket approved"],
    };
    const result = await TOOL_HANDLERS.loopforge_start(manager, { task: "Release feature", plan: external });
    assert.equal(result.stopReason, "blocked");
    assert.equal(result.phase, "terminal");
    assert.match(String(result.stopDetail), /production approval/);
  });
});
