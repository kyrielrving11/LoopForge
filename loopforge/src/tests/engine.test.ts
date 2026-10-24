/** Tests for engine: lifecycle, feedback, circuit breaker, metrics. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  LoopForgeEngine,
  createEngine,
} from "../engine.js";
import { compileLoop } from "../loop-compiler.js";
import { LegacyHistoryError } from "../errors.js";
import {
  AgentStatus,
  makeLoopCompileRequest,
  type LoopCompileRequest,
} from "../protocol.js";
import { resetPolicy } from "../policy.js";
import {
  installTestCommandProvider,
  criterionClaims,
  committedBacktrackRound,
  committedFeedbackRound,
  MemoryLoopStore,
} from "./_helpers.js";
import { deriveItemId } from "../token-utils.js";

function makeRequest(overrides: Partial<LoopCompileRequest> = {}): LoopCompileRequest {
  return makeLoopCompileRequest({
    task: "Audit ERC20 token",
    loop_id: "loop:engine-test",
    ...overrides,
  });
}

describe("Engine — Initialisation", () => {
  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
  });

  it("createEngine returns LoopForgeEngine instance", () => {
    const engine = createEngine();
    assert.ok(engine instanceof LoopForgeEngine);
  });

  it("the engine has no round-history write API", () => {
    const engine = createEngine() as unknown as Record<string, unknown>;
    for (const name of [
      "invokeFeedback",
      "autoFeedback",
      "commitRollbackDirective",
      "recordDelegation",
    ]) {
      assert.equal(typeof engine[name], "undefined", `${name} must not be public`);
    }
  });
});

describe("Engine — Circuit breaker (v2.5: removed)", () => {
  it("shouldBreak() method no longer exists — stalled loops are now detected by enforcement gate R4/R5", () => {
    const engine = createEngine();
    // shouldBreak was removed in v2.5. The enforcement gate (R4/R5) now
    // handles stall detection from machine-observed repository motion instead
    // of subjective self-reported progress.
    assert.equal(typeof (engine as unknown as Record<string, unknown>).shouldBreak, "undefined");
  });
});

describe("Engine — Loop Compile mode", () => {
  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence — install a real
    // passing command so R8 / success_unverified stay silent in these flows.
    installTestCommandProvider();
  });

  it("returns OK with compiled prompt for round 1", () => {
    const engine = createEngine();
    const req = makeRequest({
      loop_id: "test",
      round: 1,
      goal_id: "audit",
      task: "Audit ERC20 token",
    });
    const result = engine.invokeLoopCompile(req);
    assert.equal(result.status, AgentStatus.OK);
    assert.ok(result.prompt.includes("Level: L2"));
    assert.equal(result.prompt_artifact?.level, "l2");
  });

  it("includes loop health in prompt", () => {
    const engine = createEngine();
    const req = makeRequest({
      loop_id: "test",
      round: 1,
      goal_id: "audit",
      task: "Audit ERC20 token",
      loop_objective: {
        objective: "Full security audit",
        success_criteria: ["All tests pass"],
        hard_constraints: [],
        created_at_round: 1,
        loop_id: "test",
      },
    });
    const result = engine.invokeLoopCompile(req);
    // v2.8: L2 pointer mode renders "### Objective" (path B), not
    // "Loop Objective" from the full state blob (path A).
    assert.ok(result.prompt.includes("Full security audit"));
  });

  it("handles round 2 with existing vault context", () => {
    const engine = createEngine();
    const req = makeRequest({
      loop_id: "test-r2",
      round: 2,
      goal_id: "audit",
      task: "Check approve race condition",
    });
    // Compiles at L2 when no prior lineage found
    const result = engine.invokeLoopCompile(req);
    assert.equal(result.status, AgentStatus.OK);
  });

  it("includes a committed recovery brief when a redo targets round 1", () => {
    const store = new MemoryLoopStore();
    store.appendEntry(committedBacktrackRound(2, "round-one-redo", 0));
    const engine = new LoopForgeEngine(store);
    const response = engine.invokeLoopCompile(makeLoopCompileRequest({
      loop_id: "round-one-redo",
      round: 1,
      task: "Test task",
    }));

    assert.equal(response.status, AgentStatus.OK);
    assert.ok(response.prompt.includes("### Recovery Brief"));
    assert.ok(response.prompt.includes("test_restore"));
  });

  it("fails closed on legacy history through engine and direct compile APIs", () => {
    const legacy = committedFeedbackRound(1, { loopId: "legacy-compile" });
    const transaction = legacy.loop_lineage!.round_transaction as Record<string, unknown>;
    (transaction.snapshot as Record<string, unknown>).schemaVersion = 5;
    const request = makeLoopCompileRequest({
      loop_id: "legacy-compile",
      round: 1,
      task: "Test task",
    });
    const store = new MemoryLoopStore();
    store.appendEntry(legacy);

    assert.throws(
      () => new LoopForgeEngine(store).invokeLoopCompile(request),
      LegacyHistoryError,
    );
    assert.throws(
      () => compileLoop(request, { results: [legacy] }),
      LegacyHistoryError,
    );
  });
});

describe("Engine — P0-P5 Cognitive Evolution (v1.7 E2E)", () => {
  beforeEach(() => {
    resetPolicy();
    // v3.3: success claims need machine-backed evidence — install a real
    // passing command so R8 / success_unverified stay silent in these flows.
    installTestCommandProvider();
  });

  it("verification_flags are rendered as Verification Gate section in prompt", () => {
    const engine = createEngine();
    const req = makeRequest({
      loop_id: "vg-test",
      round: 2,
      goal_id: "audit",
      task: "Audit ERC20",
    });
    const result = engine.invokeLoopCompile({
      ...req,
      verification_flags: [
        { severity: "error", field: "success", check: "success_with_remaining_criteria",
          detail: "Agent claims success but 2 criteria remain unmet: Access control, Overflow" },
        { severity: "warn", field: "blocker", check: "blocked_without_blocker",
          detail: "outcome=blocked but no blocker description" },
      ],
    });
    assert.equal(result.status, AgentStatus.OK);
    const prompt = result.prompt;
    assert.ok(prompt.includes("Verification Gate"), "Gate section missing");
    assert.ok(prompt.includes("🚫"), "Error flag icon missing");
    assert.ok(prompt.includes("CONTRADICTED"), "Contradicted verdict message missing");
    assert.ok(prompt.includes("blocked_without_blocker"), "Warn flag check name missing");
    // v3.2: error/warn flags carry actionable continuation lines.
    assert.ok(prompt.includes("→ Fix: Complete the remaining criteria"),
      "error flag must carry a Fix instruction");
    assert.ok(prompt.includes("→ Action: State the concrete blocker"),
      "warn flag must carry an Action instruction");
  });
});

describe("Engine — identity & round-view consistency (v3.3.1)", () => {
  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
  });

  it("renders a success-criterion text under ONE identity (cr-) in the L2 prompt", () => {
    // Regression: criterion texts are merged into the active constraint set,
    // and the active list used to re-derive a c-XXXXXXXX id for them while
    // their own Success Criteria section (and the verification gate's
    // criteriaMatch) speaks cr-XXXXXXXX. One text, two IDs — an agent
    // echoing the active-list ID into success_criteria_met could never match.
    const engine = createEngine();
    const result = engine.invokeLoopCompile(makeRequest({
      loop_id: "identity-loop",
      round: 1,
      task: "Deliver the data pipeline",
      force_level: "l2",
      loop_objective: {
        objective: "Deliver the data pipeline",
        success_criteria: ["Ship the ETL module"],
        hard_constraints: ["Never touch prod data"],
        created_at_round: 1,
        loop_id: "identity-loop",
      },
    }));
    assert.equal(result.status, AgentStatus.OK);
    const prompt = result.prompt ?? "";
    const criterionHash = deriveItemId("Ship the ETL module");
    assert.ok(prompt.includes(`cr-${criterionHash}`),
      "the criterion must render under its cr- identity");
    assert.ok(!prompt.includes(`c-${criterionHash}`),
      "the same text must never render under a c- identity");
    const constraintHash = deriveItemId("Never touch prod data");
    assert.ok(prompt.includes(`c-${constraintHash}`),
      "a hard constraint keeps its c- identity");
    assert.ok(!prompt.includes(`cr-${constraintHash}`),
      "the constraint must never render under a cr- identity");
  });

});
