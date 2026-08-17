import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoundReportBlock } from "../loop-compiler.js";
import { TOOL_HANDLERS, TOOL_SCHEMAS } from "../mcp/tools.js";
import { SessionManager } from "../mcp/session.js";
import { mergeRuntimeEvidence, normalizeRoundReport, stableClaimId } from "../round-report.js";
import { verifyRoundEvaluation } from "../verification-gate.js";
import type { StructuredPlan } from "../protocol.js";
import { getPolicy, resetPolicy } from "../policy.js";
import { MemoryBackend } from "./_helpers.js";
import { StoreLocator, WorkspaceRuntime } from "../workspace-runtime.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executablePlan(): StructuredPlan {
  return {
    objective: "Implement and verify one change",
    successCriteria: ["verified"],
    constraints: ["preserve architecture"],
    steps: [{
      id: "ps-change",
      title: "Implement change",
      kind: "executable",
      dependsOn: [],
      scope: ["src/example.ts"],
      successCriteria: ["verified"],
      constraints: ["preserve architecture"],
      acceptanceCriteria: ["change works"],
      evidenceRequirements: ["tests pass"],
      refinement: "executable",
      riskTags: [],
      status: "ready",
    }],
  };
}

function completedReport(targets: Array<["ac" | "er" | "cr", string]>) {
  return {
    status: "completed",
    summary: "Completed and verified the assigned work.",
    evidence: {
      checks: [{ name: "test", status: "passed", counts: { passed: 1, failed: 0, skipped: 0 } }],
      claims: targets.map(([prefix, text]) => ({
        targetId: stableClaimId(prefix, text),
        evidenceRefs: ["check:test"],
      })),
      noChangeReason: "This workflow fixture verifies governance without changing repository files.",
    },
  };
}

async function report(
  manager: SessionManager,
  sessionId: string,
  value: Record<string, unknown>,
  roundId?: string,
) {
  return TOOL_HANDLERS.loopforge_next(manager, {
    sessionId,
    roundId: roundId ?? manager.get(sessionId)?.roundSnapshot?.roundId,
    report: value,
  });
}

describe("P1 compact reports and prompt modes", () => {
  let manager: SessionManager;

  beforeEach(() => {
    resetPolicy();
    manager = new SessionManager(new MemoryBackend());
  });

  it("keeps the public schema and report template within budget", () => {
    const all = JSON.stringify(TOOL_SCHEMAS).length;
    const next = JSON.stringify(TOOL_SCHEMAS.find((tool) => tool.name === "loopforge_next")).length;
    const template = buildRoundReportBlock({
      report_mode: "step_start",
      report_claim_targets: [
        { id: "ac-12345678", text: "works", kind: "acceptance" },
        { id: "er-12345678", text: "tests", kind: "evidence" },
      ],
      attempt: 1,
    });
    assert.equal(TOOL_SCHEMAS.length, 12);
    assert.ok(next <= 4_500, `loopforge_next schema: ${next}`);
    assert.ok(next / all <= 0.2, `loopforge_next ratio: ${next / all}`);
    assert.ok(all <= 24_000, `all tool schemas: ${all}`);
    assert.ok(template.length <= 900, `report template chars: ${template.length}`);
    assert.ok(template.split(/\r?\n/).length <= 30);
    assert.doesNotMatch(template, /"violations":\[\]|"delegations":\[\]/);
  });

  it("compiles step_start, step_continue, step_retry, refinement, and audit prompts", async () => {
    const started = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Implement feature",
      plan: executablePlan(),
    });
    const sessionId = String(started.sessionId);
    assert.match(String(started.prompt), /Mode: step_start/);
    assert.match(String(started.prompt), /### Active Graph Slice/);
    assert.ok(manager.get(sessionId)?.roundSnapshot?.promptArtifact?.includedSections.includes("graph_slice"));
    assert.ok(started.capabilityPreflight);

    const continued = await report(manager, sessionId, {
      status: "in_progress",
      summary: "Inspected the implementation surface; verification is still pending.",
    });
    assert.match(String(continued.prompt), /Mode: step_continue/);
    assert.match(String(continued.prompt), /### Active Graph Slice/);

    const retry = await report(manager, sessionId, {
      status: "completed",
      summary: "Claimed completion without a real check.",
      evidence: {
        claims: [
          { targetId: stableClaimId("ac", "change works"), evidenceRefs: ["check:test"] },
          { targetId: stableClaimId("er", "tests pass"), evidenceRefs: ["check:test"] },
        ],
      },
    });
    assert.equal(retry.enforcementAction, "reject");
    assert.match(String(retry.prompt), /Mode: step_retry/);
    assert.doesNotMatch(String(retry.prompt), /### Active Graph Slice/);

    const accepted = await report(manager, sessionId, completedReport([
      ["ac", "change works"],
      ["er", "tests pass"],
    ]));
    assert.equal(accepted.phase, "auditing");
    assert.match(String(accepted.prompt), /Mode: audit/);

    const outline = executablePlan();
    outline.steps[0] = {
      ...outline.steps[0],
      kind: "outline",
      refinement: "outline",
      acceptanceCriteria: [],
      evidenceRequirements: [],
    };
    const refinement = await TOOL_HANDLERS.loopforge_start(new SessionManager(new MemoryBackend()), {
      task: "Refine feature",
      plan: outline,
    });
    assert.equal(refinement.requiredAction, "refine_plan");
    assert.match(String(refinement.prompt), /Mode: refine_plan/);
  });

  it("keeps unrelated future steps out of the active graph slice and hashes relevant changes", async () => {
    const plan = executablePlan();
    plan.steps.push({
      ...structuredClone(plan.steps[0]),
      id: "ps-future",
      title: "Future unrelated implementation detail",
      dependsOn: ["ps-change"],
      successCriteria: [],
      constraints: [],
      status: "pending",
    });
    const started = await TOOL_HANDLERS.loopforge_start(manager, { task: "Implement feature", plan });
    const sessionId = String(started.sessionId);
    const startArtifact = manager.get(sessionId)?.roundSnapshot?.promptArtifact;
    assert.ok(startArtifact);
    assert.match(startArtifact.renderedPrompt, /### Active Graph Slice/);
    assert.doesNotMatch(startArtifact.renderedPrompt, /Future unrelated implementation detail/);

    await report(manager, sessionId, {
      status: "in_progress",
      summary: "The first attempt identified a missing verification case.",
      discoveries: { facts: ["The verification fixture needs one more assertion."] },
    });
    const continuedArtifact = manager.get(sessionId)?.roundSnapshot?.promptArtifact;
    assert.ok(continuedArtifact);
    assert.notEqual(continuedArtifact.promptHash, startArtifact.promptHash);
    assert.match(continuedArtifact.renderedPrompt, /Prior attempt: The first attempt identified a missing verification case/);
    assert.doesNotMatch(continuedArtifact.renderedPrompt, /Future unrelated implementation detail/);
    assert.equal(continuedArtifact.budgetExceeded, false);
  });

  it("uses evidence movement rather than repeated summaries for stall detection", async () => {
    const started = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Implement feature",
      plan: executablePlan(),
    });
    const sessionId = String(started.sessionId);
    for (let index = 0; index < 2; index++) {
      const result = await report(manager, sessionId, {
        status: "in_progress",
        summary: `Repeated status wording ${index}`,
      });
      assert.notEqual(result.enforcementAction, "reject");
    }
    const stalled = await report(manager, sessionId, {
      status: "in_progress",
      summary: "A third summary with no new claim, check, file, or discovery.",
    });
    assert.equal(stalled.enforcementAction, "reject");
    assert.match(String(stalled.enforcementReason), /without material evidence advancement/);
  });

  it("routes before_continue changes to planning without completing the active step", async () => {
    const started = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Implement feature",
      plan: executablePlan(),
    });
    const sessionId = String(started.sessionId);
    const result = await report(manager, sessionId, {
      status: "in_progress",
      summary: "Repository evidence invalidated a plan constraint.",
      discoveries: { newConstraints: ["new invariant"] },
      planChangeRequest: {
        timing: "before_continue",
        reason: "The active step must account for the new invariant.",
        affectedIds: ["ps-change"],
      },
    });
    assert.equal(result.phase, "planning");
    assert.equal(result.requiredAction, "refine_plan");
    assert.equal(manager.get(sessionId)?.workflow.plan?.steps[0].status, "ready");
    assert.equal(manager.get(sessionId)?.workflow.pendingPlanChange?.timing, "before_continue");
  });
});

describe("P1 evidence provenance", () => {
  function normalized(phase: "executing" | "auditing" = "executing", claims = [{
    targetId: "ac-target",
    evidenceRefs: ["check:lint"],
  }]) {
    return normalizeRoundReport({
      status: "completed",
      summary: "Completed the assigned verification.",
      evidence: {
        checks: [
          { name: "unit", status: "passed" },
          { name: "lint", status: "failed" },
        ],
        claims,
      },
    }, phase, phase === "auditing" ? "audit-final" : "ps-step", []);
  }

  it("merges runtime checks without dropping unmatched Agent checks", () => {
    const evaluation = normalized();
    mergeRuntimeEvidence(evaluation, [{
      provider: "command-provider",
      timestamp: Date.now(),
      files: [],
      data: { kind: "command", commandName: "lint", required: false, status: "passed" },
    }]);
    assert.deepEqual(evaluation.evidenceEnvelope.checks.value.map((check) => check.name), ["unit", "lint"]);
    assert.equal(evaluation.evidenceEnvelope.checkProvenance?.unit?.confidence, "claimed");
    assert.equal(evaluation.evidenceEnvelope.checkProvenance?.lint?.confidence, "verified");
    assert.equal(evaluation.evidenceEnvelope.checks.value.find((check) => check.name === "lint")?.status, "passed");
  });

  it("does not let a failed optional provider prove a claim", () => {
    const evaluation = normalized();
    mergeRuntimeEvidence(evaluation, [{
      provider: "lint-provider",
      timestamp: Date.now(),
      files: [],
      data: {
        kind: "command", commandName: "lint", required: false, status: "failed",
        claimIds: ["ac-target"],
      },
    }]);
    const result = verifyRoundEvaluation(evaluation, 1, []);
    assert.equal(result.verdict, "contradicted");
    assert.ok(result.flags.some((flag) => flag.check === "claim_reference_invalid"));
    assert.deepEqual(evaluation.evidenceEnvelope.providerClaims, {});
  });

  it("requires explicit provider claim bindings instead of provider names", () => {
    const evaluation = normalized("executing", [{ targetId: "ac-target", evidenceRefs: ["provider:git"] }]);
    mergeRuntimeEvidence(evaluation, [{
      provider: "git",
      timestamp: Date.now(),
      files: ["src/example.ts"],
      data: { kind: "git", fingerprints: {} },
    }]);
    const result = verifyRoundEvaluation(evaluation, 1, []);
    assert.equal(result.verdict, "contradicted");
    assert.ok(result.flags.some((flag) => flag.check === "claim_reference_invalid"));
  });

  it("rejects a final audit backed only by Agent-claimed checks", () => {
    const evaluation = normalized("auditing");
    const result = verifyRoundEvaluation(evaluation, 1, []);
    assert.equal(result.verdict, "contradicted");
    assert.ok(result.flags.some((flag) => flag.check === "audit_claim_not_verified"));
  });

  it("detects content changes when a dirty Git path remains the same", () => {
    const previous = normalizeRoundReport({
      status: "in_progress",
      summary: "Initial edit.",
    }, "executing", "ps-step", []);
    mergeRuntimeEvidence(previous, [{
      provider: "git",
      timestamp: 1,
      files: ["src/example.ts"],
      data: { fingerprints: { "src/example.ts": "100644:before" } },
    }]);

    const current = normalizeRoundReport({
      status: "in_progress",
      summary: "Refined the same file.",
    }, "executing", "ps-step", []);
    mergeRuntimeEvidence(current, [{
      provider: "git",
      timestamp: 2,
      files: ["src/example.ts"],
      data: { fingerprints: { "src/example.ts": "100644:after" } },
    }], previous);

    assert.deepEqual(current.evidenceEnvelope.fileFingerprints, { "src/example.ts": "100644:after" });
    assert.ok(current.materialAdvancement?.signals.includes("new_git_change"));
  });

  it("counts a structured failed-investigation discovery as material advancement", () => {
    const evaluation = normalizeRoundReport({
      status: "in_progress",
      summary: "The attempted parser route failed.",
      discoveries: { wrongAssumptions: ["The tokenizer does not own this delimiter."] },
    }, "executing", "ps-step", []);
    mergeRuntimeEvidence(evaluation, []);
    assert.equal(evaluation.materialAdvancement?.material, true);
    assert.ok(evaluation.materialAdvancement?.signals.includes("new_discovery"));
  });
});

describe("P1 external gate recovery", () => {
  beforeEach(() => {
    resetPolicy();
  });

  it("requires exact gate identity and evidence, then advances to audit", async () => {
    const manager = new SessionManager(new MemoryBackend());
    const gatePlan: StructuredPlan = {
      objective: "Pass an external approval gate",
      successCriteria: ["approval recorded"],
      constraints: [],
      steps: [{
        id: "ps-approval",
        title: "External approval",
        kind: "external_gate",
        dependsOn: [],
        scope: [],
        successCriteria: ["approval recorded"],
        constraints: [],
        acceptanceCriteria: [],
        evidenceRequirements: ["approval ticket"],
        refinement: "executable",
        riskTags: [],
        status: "ready",
      }],
    };
    const blocked = await TOOL_HANDLERS.loopforge_start(manager, {
      task: "Complete external approval",
      loopId: "p1-external-gate",
      plan: gatePlan,
    });
    assert.equal(blocked.stopReason, "blocked");
    assert.equal(manager.get(String(blocked.sessionId))?.workflow.blockingGate?.stepId, "ps-approval");

    assert.throws(() => manager.resumeWithWorkspace(
      "p1-external-gate",
      undefined,
      undefined,
      { planVersion: 2, stepId: "ps-approval", summary: "approved", evidenceReferences: ["ticket:42"] },
    ), /planVersion mismatch/);

    const resumed = manager.resumeWithWorkspace(
      "p1-external-gate",
      undefined,
      undefined,
      { planVersion: 1, stepId: "ps-approval", summary: "Approval granted", evidenceReferences: ["ticket:42"] },
    );
    assert.equal(resumed?.phase, "auditing");
    assert.equal(resumed?.activeStepId, "audit-final");
    assert.equal(manager.get(String(resumed?.sessionId))?.workflow.plan?.steps[0].status, "done");
    assert.equal(manager.get(String(resumed?.sessionId))?.workflow.blockingGate, null);
  });

  it("recovers an external gate after process restart without binding on invalid evidence", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "loopforge-p1-gate-"));
    temporaryRoots.push(workspace);
    const gatePlan: StructuredPlan = {
      objective: "Pass approval",
      successCriteria: ["approval recorded"],
      constraints: [],
      steps: [{
        id: "ps-approval",
        title: "Approval",
        kind: "external_gate",
        dependsOn: [],
        scope: [],
        successCriteria: ["approval recorded"],
        constraints: [],
        acceptanceCriteria: [],
        evidenceRequirements: ["approval ticket"],
        refinement: "executable",
        riskTags: [],
        status: "ready",
      }],
    };
    const firstRuntime = new WorkspaceRuntime(undefined, new StoreLocator(join(workspace, "locator-a.json")));
    const first = new SessionManager(undefined, undefined, firstRuntime);
    const blocked = await first.create({
      task: "Complete approval",
      loopId: "p1-gate-restart",
      workspaceRoot: workspace,
      plan: gatePlan,
    });
    assert.equal(blocked.stopReason, "blocked");
    first.close();

    const secondRuntime = new WorkspaceRuntime(undefined, new StoreLocator(join(workspace, "locator-b.json")));
    const second = new SessionManager(undefined, undefined, secondRuntime);
    assert.throws(() => second.resumeWithWorkspace(
      "p1-gate-restart",
      workspace,
      undefined,
      { planVersion: 1, stepId: "ps-approval", summary: "approved", evidenceReferences: [] },
    ), /evidenceReferences/);
    assert.equal(secondRuntime.isBound, false);

    const resumed = second.resumeWithWorkspace(
      "p1-gate-restart",
      workspace,
      undefined,
      { planVersion: 1, stepId: "ps-approval", summary: "approved", evidenceReferences: ["ticket:42"] },
    );
    assert.equal(secondRuntime.isBound, true);
    assert.equal(resumed?.phase, "auditing");
    second.close();
  });
});
