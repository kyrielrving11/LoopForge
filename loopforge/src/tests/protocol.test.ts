/** Tests for protocol type factories and serialisation. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Mode,
  AgentStatus,
  makeExecutionFeedback,
  makeLoopObjective,
  makeLoopHealth,
  makeRollingSummary,
  makeTaskAlignment,
  makeLoopRoundResult,
  makeLoopCompileRequest,
  makeLoopCompileResponse,
  makeSessionState,
  makeTaskId,
  makeSelfEvaluation,
} from "../protocol.js";

describe("Protocol — Enums", () => {
  it("Mode has 2 values", () => {
    assert.equal(Object.values(Mode).length, 2);
    assert.equal(Mode.LOOP_COMPILE, "loop_compile");
    assert.equal(Mode.FEEDBACK, "feedback");
  });

  it("AgentStatus has 3 values", () => {
    assert.equal(AgentStatus.OK, "ok");
    assert.equal(AgentStatus.ERROR, "error");
    assert.equal(AgentStatus.STALLED, "stalled");
  });

});

describe("Protocol — Factory functions", () => {
  it("makeLoopCompileRequest returns sensible defaults", () => {
    const req = makeLoopCompileRequest();
    assert.equal(req.mode, "loop_compile");
    assert.equal(req.round, 1);
    assert.equal(req.force_level, "auto");
    assert.equal(req.health_check_interval, 1);
    assert.equal(req.loop_objective, null);
    assert.deepEqual(req.constraints_from_plan, []);
  });

  it("makeLoopCompileResponse returns sensible defaults", () => {
    const resp = makeLoopCompileResponse();
    assert.equal(resp.status, "ok");
    assert.equal(resp.recompile_level, "l2");
    assert.equal(resp.round, 0);
    assert.deepEqual(resp.warnings, []);
  });

  it("makeTaskId derives kebab-case from description", () => {
    assert.equal(makeTaskId("Audit ERC20 token"), "audit-erc20-token");
    assert.equal(makeTaskId(""), "unnamed-task");
  });

  it("makeSelfEvaluation includes worker_results default", () => {
    const se = makeSelfEvaluation();
    assert.deepEqual(se.worker_results, []);
  });

  it("makeSelfEvaluation accepts worker_results override", () => {
    const wr = [{ agentId: "abc", subAgentType: "explore", subTask: "search", resultSummary: "found 3 bugs", success: true }];
    const se = makeSelfEvaluation({ worker_results: wr });
    assert.equal(se.worker_results!.length, 1);
    assert.equal(se.worker_results![0].agentId, "abc");
    assert.equal(se.worker_results![0].success, true);
  });
});
