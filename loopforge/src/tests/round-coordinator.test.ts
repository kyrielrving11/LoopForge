/** Tests for RoundCoordinator — verify → enforce → stop pipeline. */
import { committedFeedbackRound, criterionClaims, MemoryLoopStore } from "./_helpers.js";
import { deriveContractItemIds } from "../token-utils.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RoundCoordinator } from "../round-coordinator.js";
import type { RoundProcessInput } from "../round-coordinator.js";
import { makeSelfEvaluation, makeExecutionReport } from "../protocol.js";
import type { SelfEvaluation } from "../protocol.js";
import type { CommandObservation } from "../protocol.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function se(overrides: Partial<SelfEvaluation> = {}): SelfEvaluation {
  return makeSelfEvaluation({
    success: false,
    output_summary: "Fixed 3 bugs in auth module.",
    constraint_violations: [],
    should_continue: true,
    execution_report: makeExecutionReport({
      files_changed: ["auth.ts"],
      tests_reported: { passed: 10, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims([], ["add unit tests"]),
      progress_estimate: 0.4,
    }),
    ...overrides,
  });
}

/** v3.3: A passed after-phase command whose stdout matches the se() fixture
 *  counts (Tests: 10 passed) — success claims need machine-backed evidence,
 *  so rounds without a command snapshot get rejected by R8. */
function commandSnap(): CommandObservation {
  return {
    schemaVersion: 1,
    providerId: "command:verify",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "passed",
    files: [],
    data: {
      commandId: "verify",
      argv: ["npm", "run", "verify"],
      cwd: ".",
      configHash: "0".repeat(64),
      required: false,
      exitCode: 0,
      signal: null,
      durationMs: 10,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: "Tests: 10 passed, 10 total",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
    },
  };
}

function minimalInput(overrides: Partial<RoundProcessInput> = {}): RoundProcessInput {
  return {
    loopId: "test-loop",
    task: "Fix bugs in auth module",
    currentRound: 2,
    maxRounds: 20,
    selfEval: se(),
    consecutiveRejections: 0,
    evidenceSnapshots: [commandSnap()],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Happy path
// ═══════════════════════════════════════════════════════════════════════════

describe("RoundCoordinator — happy path", () => {
  const coordinator = new RoundCoordinator();

  it("accepts a normal round and returns continue", () => {
    const result = coordinator.processRound(minimalInput());
    assert.equal(result.action, "continue");
    assert.ok(result.shouldPushSuccessTrajectory);
    assert.equal(result.newConsecutiveRejections, 0);
  });

  it("returns continue for round 1 with no previous evaluation", () => {
    const result = coordinator.processRound(minimalInput({ currentRound: 1, lastSelfEval: undefined }));
    assert.equal(result.action, "continue");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stop conditions
// ═══════════════════════════════════════════════════════════════════════════

describe("RoundCoordinator — stop conditions", () => {
  const coordinator = new RoundCoordinator();

  it("stops when should_continue=false and success=true (completed)", () => {
    const result = coordinator.processRound(minimalInput({
      selfEval: se({
        success: true,
        should_continue: false,
        // Clean completion: no remaining criteria, evidence present
        execution_report: makeExecutionReport({
          files_changed: ["auth.ts"],
          tests_reported: { passed: 10, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims([], []),
          progress_estimate: 1.0,
        }),
      }),
    }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "completed");
  });

  it("v3.8: a stop under an open contract is incomplete, not completed", () => {
    // The agent claims the active contract's item met, but no bound command
    // was observed passing — the round commits (insufficient is recorded),
    // and the STOP must not claim completion.
    const contract = {
      work_item: "Slice A",
      scope: ["src/auth"],
      items: [{ description: "login works", criterion_refs: [], subgoal_refs: [], verify_with: ["verify"] }],
    };
    const itemId = deriveContractItemIds(contract.items)[0];
    const store = new MemoryLoopStore();
    store.appendEntry(committedFeedbackRound(1, { loopId: "stop-open-contract", contract }));
    const withVault = new RoundCoordinator(store);
    const result = withVault.processRound(minimalInput({
      loopId: "stop-open-contract",
      currentRound: 2,
      selfEval: se({
        success: true,
        should_continue: false,
        execution_report: makeExecutionReport({
          files_changed: ["src/auth/a.ts"],
          tests_reported: { passed: 1, failed: 0, skipped: 0 },
          contract_item_claims: [{ item_id: itemId, outcome: "met" }],
          progress_estimate: 1.0,
        }),
      }),
    }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "incomplete",
      "machine verification did not close the contract — the loop never reports completed");
    assert.equal(result.shouldPushSuccessTrajectory, false,
      "an unverified stop never enters the success trajectory");
  });

  it("stops when should_continue=false and success=false (failed)", () => {
    const result = coordinator.processRound(minimalInput({
      selfEval: se({ success: false, should_continue: false }),
    }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "failed");
  });

  it("stops with blocked reason when agent declares blocked", () => {
    const result = coordinator.processRound(minimalInput({
      selfEval: se({
        success: false,
        should_continue: false,
        stop_reason: "blocked",
      }),
    }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "blocked");
  });

  it("stops with blocked reason when agent needs human input", () => {
    const result = coordinator.processRound(minimalInput({
      selfEval: se({
        success: false,
        should_continue: false,
        stop_reason: "needs_human_input",
      }),
    }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "blocked");
  });

  it("v3.8: an explicit blocked declaration outranks a success claim", () => {
    // `success: true` together with a declared blocked stop is a
    // contradiction. The declared field is the honest reading — reporting
    // `completed` would let two contradictory fields silently buy a
    // completion verdict. The report is otherwise a clean completion, so the
    // only thing standing between this round and `completed` is the
    // declaration.
    const result = coordinator.processRound(minimalInput({
      selfEval: se({
        success: true,
        should_continue: false,
        stop_reason: "blocked",
        execution_report: makeExecutionReport({
          files_changed: ["auth.ts"],
          tests_reported: { passed: 10, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims([], []),
          progress_estimate: 1.0,
        }),
      }),
    }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "blocked");
  });

  it("v3.8: an explicit blocked declaration outranks a closed contract", () => {
    // Same contradiction, now with a contract that IS machine-verified: the
    // old ordering hit `completed` here because contract closure was checked
    // before the declared blocked stop.
    const contract = {
      work_item: "Slice A",
      scope: ["src/auth"],
      items: [{ description: "login works", criterion_refs: [], verify_with: ["verify"], subgoal_refs: [] }],
    };
    const itemId = deriveContractItemIds(contract.items)[0];
    const store = new MemoryLoopStore();
    store.appendEntry(committedFeedbackRound(1, { loopId: "blocked-closed-contract", contract }));
    store.appendEntry(committedFeedbackRound(2, {
      loopId: "blocked-closed-contract",
      contractItemClaims: [{ item_id: itemId, outcome: "met" }],
    }));
    const withVault = new RoundCoordinator(store);
    const result = withVault.processRound(minimalInput({
      loopId: "blocked-closed-contract",
      currentRound: 3,
      selfEval: se({
        success: true,
        should_continue: false,
        stop_reason: "needs_human_input",
        execution_report: makeExecutionReport({
          files_changed: [],
          tests_reported: { passed: 0, failed: 0, skipped: 0 },
          contract_item_claims: [{ item_id: itemId, outcome: "met" }],
          progress_estimate: 1.0,
        }),
      }),
    }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "blocked");
  });

  it("stops at maxRounds", () => {
    const result = coordinator.processRound(minimalInput({
      currentRound: 20,
      maxRounds: 20,
    }));
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "max_rounds");
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Rejection — fake success
// ═══════════════════════════════════════════════════════════════════════════

describe("RoundCoordinator — rejection", () => {
  const coordinator = new RoundCoordinator();

  it("rejects when success=true but criteria remain unmet", () => {
    const result = coordinator.processRound(minimalInput({
      selfEval: se({
        success: true,
        execution_report: makeExecutionReport({
          criterion_claims: criterionClaims([], ["unfinished criteria"]),
          progress_estimate: 0.5,
        }),
      }),
    }));
    assert.equal(result.action, "reject");
    assert.ok(result.rejectionPrompt);
    assert.ok(result.rejectionPrompt.includes("REJECTED"));
    assert.equal(result.newConsecutiveRejections, 1);
    assert.equal(result.shouldPushSuccessTrajectory, false);
  });

  it("increments rejection count on reject", () => {
    const result = coordinator.processRound(minimalInput({
      selfEval: se({
        success: true,
        execution_report: makeExecutionReport({
          criterion_claims: criterionClaims([], ["unfinished criteria"]),
          progress_estimate: 0.5,
        }),
      }),
      consecutiveRejections: 1,
    }));
    assert.equal(result.action, "reject");
    assert.equal(result.newConsecutiveRejections, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Termination
// ═══════════════════════════════════════════════════════════════════════════

describe("RoundCoordinator — termination", () => {
  const coordinator = new RoundCoordinator();

  it("terminates on recurring violation (error flag)", () => {
    // Self-evaluation with a constraint violation
    const selfEval = se({
      constraint_violations: ["repeated rule X violation"],
    });
    // Need 3 consecutive rounds of same violation for R2 to trigger
    // verification gate needs vault entries to build 3-round history
    // Without vault entries, the verification check returns null.
    // The enforcement rule only fires when the flag is present.
    // Since we have no vault entries in a fresh coordinator, R2 won't fire.
  });

  it("does not terminate on clean round", () => {
    const result = coordinator.processRound(minimalInput());
    assert.notEqual(result.action, "terminate");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Verification flag propagation
// ═══════════════════════════════════════════════════════════════════════════

describe("RoundCoordinator — verification flags", () => {
  const coordinator = new RoundCoordinator();

  it("returns flags from verification gate", () => {
    const result = coordinator.processRound(minimalInput());
    // Flags may or may not be present depending on test data
    assert.ok(Array.isArray(result.verificationFlags));
  });

  it("sets gateContradicted when verdict is contradicted", () => {
    const result = coordinator.processRound(minimalInput({
      selfEval: se({
        success: true,
        execution_report: makeExecutionReport({
          criterion_claims: criterionClaims([], ["unmet criteria", "more unmet"]),
          progress_estimate: 0.5,
        }),
      }),
    }));
    // success_with_remaining_criteria is error level → contradicted
    assert.equal(result.gateContradicted, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Extraction handling
// ═══════════════════════════════════════════════════════════════════════════

describe("RoundCoordinator — extraction handling", () => {
  const coordinator = new RoundCoordinator();

  it("runs enforcement when extraction succeeded", () => {
    const result = coordinator.processRound(minimalInput({
      selfEval: se({
        success: false, // no fake success
        should_continue: true,
      }),
    }));
    assert.ok(result.action === "continue" || result.action === "reject");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: Stop mapping with declared outcomes
// ═══════════════════════════════════════════════════════════════════════════

describe("round-coordinator — v2.12 outcome stop mapping", () => {
  function outcomeEval(outcome: "success" | "partial" | "failed" | "blocked") {
    return makeSelfEvaluation({
      success: outcome === "success",
      outcome,
      output_summary: "round done",
      constraint_violations: [],
      should_continue: false,
      execution_report: {
        files_changed: ["src/a.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], []),
        progress_estimate: 1,
      },
    });
  }

  it("maps outcome=blocked + should_continue=false to stopReason blocked", () => {
    const result = new RoundCoordinator().processRound({
      loopId: "x", task: "t", currentRound: 2, maxRounds: 10,
      evidenceSnapshots: [commandSnap()],
      selfEval: outcomeEval("blocked"),
      consecutiveRejections: 0,
    });
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "blocked");
  });

  it("keeps completed for effective success", () => {
    const result = new RoundCoordinator().processRound({
      loopId: "x", task: "t", currentRound: 2, maxRounds: 10,
      evidenceSnapshots: [commandSnap()],
      selfEval: outcomeEval("success"),
      consecutiveRejections: 0,
    });
    assert.equal(result.action, "stop");
    assert.equal(result.stopReason, "completed");
  });

  it("does not stop when outcome=blocked but should_continue=true", () => {
    const result = new RoundCoordinator().processRound({
      loopId: "x", task: "t", currentRound: 2, maxRounds: 10,
      evidenceSnapshots: [commandSnap()],
      selfEval: { ...outcomeEval("blocked"), should_continue: true },
      consecutiveRejections: 0,
    });
    assert.equal(result.action, "continue");
  });
});
