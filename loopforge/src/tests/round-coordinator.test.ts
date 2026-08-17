import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoundCoordinator } from "../round-coordinator.js";
import type { RoundProcessInput } from "../round-coordinator.js";
import { normalizeRoundReport } from "../round-report.js";

function input(overrides: Partial<RoundProcessInput> = {}): RoundProcessInput {
  return {
    loopId: "coordinator-v3",
    task: "Implement the active step",
    currentRound: 1,
    maxRounds: 10,
    evaluation: normalizeRoundReport({
      status: "in_progress",
      summary: "Implemented part of the active step.",
    }, "executing", "ps-one", []),
    consecutiveRejections: 0,
    ...overrides,
  };
}

describe("RoundCoordinator v3 pipeline", () => {
  const coordinator = new RoundCoordinator();

  it("continues an accepted in-progress report", () => {
    const result = coordinator.processRound(input());
    assert.equal(result.action, "continue");
    assert.equal(result.enforcementAction, "accept");
    assert.equal(result.newLastEvaluation?.reportVersion, 1);
  });

  it("stops on a typed blocker", () => {
    const evaluation = normalizeRoundReport({
      status: "blocked",
      summary: "Waiting for an external credential.",
      blocker: { kind: "needs_human_input", reason: "Credential required." },
    }, "executing", "ps-one", []);
    const result = coordinator.processRound(input({ evaluation }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "blocked");
  });

  it("stops at the configured round limit", () => {
    const result = coordinator.processRound(input({ currentRound: 10, maxRounds: 10 }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "max_rounds");
  });

  it("rejects a completed report with an invalid evidence reference", () => {
    const evaluation = normalizeRoundReport({
      status: "completed",
      summary: "Claimed completion.",
      evidence: { claims: [{ targetId: "ac-one", evidenceRefs: ["check:missing"] }] },
    }, "executing", "ps-one", []);
    const result = coordinator.processRound(input({ evaluation }));
    assert.equal(result.action, "reject");
    assert.equal(result.rejectionCheck, "claim_reference_invalid");
    assert.match(String(result.rejectionPrompt), /same task and roundId/);
  });
});
