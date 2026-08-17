import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { VaultEntry } from "../backends/interface.js";
import {
  buildBacktrackPrompt,
  buildRejectionPrompt,
  enforceRound,
  findSafeRestorePoint,
} from "../enforcement-gate.js";
import { getPolicy, resetPolicy } from "../policy.js";
import { makeVerificationFlag, makeVerificationResult } from "../protocol.js";
import { normalizeRoundReport } from "../round-report.js";

function evaluation(status: "completed" | "in_progress" | "blocked" = "in_progress") {
  const value = normalizeRoundReport({ status, summary: "Round result." }, "executing", "ps-one", []);
  value.materialAdvancement = { material: false, signals: [], stepId: "ps-one" };
  return value;
}

function advancement(round: number, material = false): VaultEntry {
  return {
    task_id: `loop:test:r${round}:feedback`,
    loop_id: "test",
    loop_lineage: { round },
    material_advancement: { stepId: "ps-one", material },
  };
}

describe("v3 enforcement gate", () => {
  beforeEach(() => resetPolicy());

  it("accepts a trusted in-progress report", () => {
    assert.equal(enforceRound(evaluation(), makeVerificationResult(), 1, [], 0).action, "accept");
  });

  it("rejects an evidence error and terminates repeated rejected attempts", () => {
    const verification = makeVerificationResult({
      verdict: "contradicted",
      flags: [makeVerificationFlag({ severity: "error", check: "claim_reference_invalid", detail: "missing check" })],
    });
    assert.equal(enforceRound(evaluation("completed"), verification, 1, [], 0).action, "reject");
    assert.equal(enforceRound(evaluation("completed"), verification, 1, [], 2).action, "terminate");
  });

  it("rejects completion with known constraint violations", () => {
    const current = normalizeRoundReport({
      status: "completed",
      summary: "Done with a known violation.",
      violations: ["c-api"],
    }, "executing", "ps-one", []);
    const result = enforceRound(current, makeVerificationResult(), 2, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "completion_with_violation");
  });

  it("uses material evidence flatline for reject then backtrack", () => {
    const history = [advancement(1), advancement(2)];
    const first = enforceRound(evaluation(), makeVerificationResult(), 3, history, 0);
    assert.equal(first.action, "reject");
    assert.equal(first.check, "evidence_stall");
    const repeated = enforceRound(evaluation(), makeVerificationResult(), 3, history, 1);
    assert.equal(repeated.action, "backtrack");
  });

  it("uses the configured material-evidence stall window", () => {
    getPolicy().evolution.progress_stall_rounds = 4;
    const history = [advancement(1), advancement(2)];
    assert.equal(enforceRound(evaluation(), makeVerificationResult(), 3, history, 0).action, "accept");
    const stalled = enforceRound(evaluation(), makeVerificationResult(), 4, [...history, advancement(3)], 0);
    assert.equal(stalled.action, "reject");
    assert.match(stalled.reason, /4 accepted rounds/i);
  });
});

describe("backtrack helpers", () => {
  it("selects the most recent clean round and preserves typed discoveries", () => {
    const entries: VaultEntry[] = [
      { task_id: "loop:test:r1", loop_lineage: { round: 1 } },
      { task_id: "loop:test:r2", loop_lineage: { round: 2 }, verification_flags: [{ severity: "error" }] },
      {
        task_id: "loop:test:r3",
        loop_lineage: { round: 3 },
        round_report: { discoveries: { facts: ["The parser is shared."] } },
      },
    ];
    const restore = findSafeRestorePoint(4, entries, 3);
    assert.equal(restore?.round, 3);
    assert.deepEqual(restore?.skippedDiscoveries, []);
  });

  it("renders focused retry and backtrack instructions", () => {
    const backtrack = buildBacktrackPrompt(5, 2, "evidence_stall", ["fact"], ["src/a.ts"]);
    assert.match(backtrack, /Round 2/);
    assert.match(backtrack, /src\/a\.ts/);
    const rejection = buildRejectionPrompt(3, "Implement step", {
      action: "reject",
      reason: "missing evidence",
      fix_instructions: "Run the required check.",
      check: "claim_reference_invalid",
    }, []);
    assert.match(rejection, /same task and roundId/);
    assert.match(rejection, /Run the required check/);
  });
});
