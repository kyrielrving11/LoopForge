/** Tests for enforcement-gate — Layer 2 round-boundary runtime enforcement. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getPolicy, resetPolicy } from "../policy.js";
import {
  makeEnforcementResult,
  makeExecutionEvidence,
  makeSelfEvaluation,
  makeVerificationFlag,
  makeVerificationResult,
  type EnforcementResult,
  type SelfEvaluation,
  type VerificationResult,
} from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";
import {
  enforceRound,
  buildRejectionPrompt,
  findSafeRestorePoint,
  buildBacktrackPrompt,
} from "../enforcement-gate.js";
import { deriveConstraintId, deriveCriterionId, deriveSubGoalId } from "../loop-compiler.js";
import { verifyBacktrackPrompt } from "./_backtrack-asserts.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Build a minimal SelfEvaluation for testing. */
function se(overrides: Partial<SelfEvaluation> = {}): SelfEvaluation {
  return makeSelfEvaluation({
    success: true,
    output_summary: "Task completed.",
    constraint_violations: [],
    should_continue: true,
    ...overrides,
  });
}

/** Build a trusted VerificationResult with no flags. */
function trusted(): VerificationResult {
  return makeVerificationResult({ verdict: "trusted", flags: [] });
}

/** Build a VerificationResult with a "success_with_remaining_criteria" error flag. */
function contradictedSuccessWithRemaining(criteria: string[]): VerificationResult {
  return makeVerificationResult({
    verdict: "contradicted",
    flags: [
      makeVerificationFlag({
        severity: "error",
        field: "success",
        check: "success_with_remaining_criteria",
        detail: `Agent claims success but ${criteria.length} criteria remain unmet: ${criteria.join("; ")}`,
      }),
    ],
  });
}

/** Build a VerificationResult with a "recurring_violation" error flag. */
function contradictedRecurringViolation(violation: string): VerificationResult {
  return makeVerificationResult({
    verdict: "contradicted",
    flags: [
      makeVerificationFlag({
        severity: "error",
        field: "constraint_violations",
        check: "recurring_violation",
        detail: `Constraint violation "${violation}" has appeared in 3 consecutive rounds without resolution`,
      }),
    ],
  });
}

/** Build a vault entry with round and optional progress data. */
function vaultRound(
  round: number,
  progressEstimate?: number,
): VaultEntry {
  const entry: VaultEntry = {
    task_id: `loop:test-loop:r${round}`,
    loop_id: "test-loop",
    loop_lineage: { round, success: true, task: "test task" },
  };
  if (typeof progressEstimate === "number") {
    entry.execution_evidence = {
      files_changed: ["src/foo.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: [],
      success_criteria_remaining: [],
      progress_estimate: progressEstimate,
    };
  }
  return entry;
}

// ═══════════════════════════════════════════════════════════════════════════
// Happy path — trusted verdict, no issues
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — happy path", () => {
  it("accepts a round with trusted verdict and clean self-eval", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 3, failed: 1, skipped: 0 },
        progress_estimate: 0.5,
      }),
    });
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "accept");
    assert.equal(result.reason, "");
  });

  it("accepts a round with suspect verdict (warn only, not error)", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/bar.ts"],
        test_results: { passed: 5, failed: 0, skipped: 0 },
        progress_estimate: 0.3,
      }),
    });
    const suspect: VerificationResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "progress_estimate",
          check: "progress_regression",
          detail: "Progress dropped from 0.5 to 0.3",
        }),
      ],
    });
    const result = enforceRound(curr, suspect, 2, [], 0);
    assert.equal(result.action, "accept");
  });

  it("accepts round 1 with no prior vault data", () => {
    const curr = se({ success: false });
    const result = enforceRound(curr, trusted(), 1, [], 0);
    assert.equal(result.action, "accept");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R1: success=true with remaining criteria
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R1: fake success", () => {
  it("rejects when agent claims success but criteria remain unmet", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        success_criteria_met: ["criteria-1"],
        success_criteria_remaining: ["criteria-2", "criteria-3"],
        progress_estimate: 0.5,
      }),
    });
    const result = enforceRound(
      curr,
      contradictedSuccessWithRemaining(["criteria-2", "criteria-3"]),
      3, [], 0,
    );
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("criteria remain unmet"));
    assert.ok(result.fix_instructions.length > 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R2: recurring violation
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R2: recurring violation", () => {
  it("rejects when same violation appears in 3 consecutive rounds", () => {
    const curr = se({
      success: false,
      constraint_violations: ["missing docs"],
    });
    const result = enforceRound(
      curr,
      contradictedRecurringViolation("missing docs"),
      4, [], 0,
    );
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("3 consecutive rounds"));
    assert.ok(result.fix_instructions.includes("DIFFERENT approach"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R3: empty success — no files changed, no tests, claims success
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R3: empty success", () => {
  it("rejects when agent claims success with no files and no tests", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: null,
        progress_estimate: 1.0,
      }),
    });
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("no verifiable evidence"));
  });

  it("accepts when success=true with files_changed (not empty)", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/fixed.ts"],
        test_results: { passed: 10, failed: 0, skipped: 0 },
        progress_estimate: 1.0,
      }),
    });
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "accept");
  });

  it("rejects when execution_evidence is undefined — evidence is now mandatory", () => {
    // v1.17: execution_evidence is MANDATORY for structured self-evaluations.
    // Missing evidence when success=true → reject (agent must provide evidence).
    const curr = makeSelfEvaluation({
      success: true,
      output_summary: "Done.",
      constraint_violations: [],
      should_continue: true,
    });
    // Explicitly remove execution_evidence (default factory sets it)
    (curr as unknown as Record<string, unknown>).execution_evidence = undefined;
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("no execution_evidence"),
      `expected reason to mention missing evidence, got: ${result.reason}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R4: progress stall
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R4: progress stall", () => {
  it("rejects when progress is flat for 3 rounds", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.33,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.31),
      vaultRound(3, 0.32),
    ];
    const result = enforceRound(curr, trusted(), 4, vault, 0);
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("stalled"));
  });

  it("accepts when progress is increasing", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.80,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.50),
      vaultRound(3, 0.70),
    ];
    const result = enforceRound(curr, trusted(), 4, vault, 0);
    assert.equal(result.action, "accept");
  });

  it("backtracks on second consecutive stall rejection instead of terminating", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.33,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.31),
      vaultRound(3, 0.32),
    ];
    // v2.10: consecutiveRejections=1 + escalation + backtrack_enabled → backtrack
    // instead of v2.7's escalated reject. The agent is rolled back to the
    // last clean round rather than redoing the same round with guidance.
    const result = enforceRound(curr, trusted(), 4, vault, 1);
    assert.equal(result.action, "backtrack");
    assert.equal(result.check, "progress_stall");
  });

  it("terminates on third consecutive stall rejection after escalation", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.33,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.31),
      vaultRound(3, 0.32),
    ];
    // v2.7: consecutiveRejections=2 → terminate (escalation already given)
    const result = enforceRound(curr, trusted(), 4, vault, 2);
    assert.equal(result.action, "terminate");
    assert.equal(result.check, "progress_stall");
  });

  it("does not fire with less than 3 rounds of vault data", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        progress_estimate: 0.32,
      }),
    });
    const vault = [vaultRound(1, 0.30)];
    const result = enforceRound(curr, trusted(), 2, vault, 0);
    assert.equal(result.action, "accept");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R5: max rejections
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R5: max rejections", () => {
  it("escalates after 2 consecutive rejections instead of terminating", () => {
    const curr = se({ success: false });
    // v2.7: consecutiveRejections=2 now escalates (reject + guidance) instead
    // of terminating immediately.
    const result = enforceRound(curr, trusted(), 3, [], 2);
    assert.equal(result.action, "reject");
    assert.ok(result.fix_instructions.includes("Escalation"));
    assert.equal(result.check, "max_rejections");
  });

  it("terminates after 3 consecutive rejections", () => {
    const curr = se({ success: false });
    // v2.7: consecutiveRejections=3 → terminate (escalation already given)
    const result = enforceRound(curr, trusted(), 3, [], 3);
    assert.equal(result.action, "terminate");
    assert.ok(result.reason.includes("consecutive enforcement rejections"));
  });

  it("does not escalate with only 1 rejection", () => {
    const curr = se({ success: false });
    const result = enforceRound(curr, trusted(), 3, [], 1);
    assert.equal(result.action, "accept");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Priority — R1 takes precedence over R3 when both conditions exist
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — rule priority", () => {
  it("R1 (fake success) fires before R3 (empty success)", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],       // triggers R3
        test_results: null,       // triggers R3
        success_criteria_met: ["x"],
        success_criteria_remaining: ["y", "z"],  // triggers R1
        progress_estimate: 1.0,
      }),
    });
    const result = enforceRound(
      curr,
      contradictedSuccessWithRemaining(["y", "z"]),
      2, [], 0,
    );
    // R1 should fire (criteria remaining), not R3 (empty success)
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("criteria remain unmet"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildRejectionPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("buildRejectionPrompt", () => {
  it("produces a prompt containing REJECTED, reason, and retry instructions", () => {
    const enforceResult = makeEnforcementResult({
      action: "reject",
      reason: "Agent claims success but 3 criteria remain unmet.",
      fix_instructions: "Complete all criteria or set success=false.",
    });
    const prompt = buildRejectionPrompt(5, "Audit the ERC20 token", enforceResult);
    assert.ok(prompt.includes("REJECTED"));
    assert.ok(prompt.includes("Round 5"));
    assert.ok(prompt.includes("criteria remain unmet"));
    assert.ok(prompt.includes("Complete all criteria"));
    assert.ok(prompt.includes("Audit the ERC20 token"));
    assert.ok(prompt.includes("Retry"));
    assert.ok(prompt.includes("do NOT advance"));
  });

  it("includes the task in the retry section", () => {
    const enforceResult = makeEnforcementResult({
      action: "reject",
      reason: "Test reason.",
      fix_instructions: "Test fix.",
    });
    const prompt = buildRejectionPrompt(2, "Fix bugs in auth module", enforceResult);
    assert.ok(prompt.includes("Fix bugs in auth module"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.8: R7 — Intent drift with drift_clarification
// ═══════════════════════════════════════════════════════════════════════════

describe("enforceRound — R7 intent drift with clarification", () => {
  it("rejects when intent_drift flag present without clarification", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "output_summary",
          check: "intent_drift",
          detail: "Declared intent was refactor auth but actual output fixed css — similarity 8%",
        }),
      ],
    });
    const result = enforceRound(selfEval, verifyResult, 3, [], 0);
    assert.equal(result.action, "reject", "should reject without clarification");
    assert.equal(result.check, "intent_drift");
  });

  it("accepts (skips reject) when agent provides substantive drift_clarification", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/components/Login.css"],
        test_results: null,
        success_criteria_met: [],
        success_criteria_remaining: [],
        progress_estimate: 0.6,
      }),
      drift_clarification:
        "Pivoted from auth refactor because data showed CSS layout was the actual user complaint. " +
        "The auth module refactor was preempted by this higher-priority fix. " +
        "Changed src/components/Login.css to fix the visual regression.",
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "output_summary",
          check: "intent_drift",
          detail: "Declared intent was refactor auth but actual output fixed css — similarity 8%",
        }),
      ],
    });
    const result = enforceRound(selfEval, verifyResult, 3, [], 0);
    assert.notEqual(result.action, "reject",
      "should not reject when clarification is provided");
    // v2.12: Should signal clarification was accepted
    assert.equal(result.clarification_accepted, true,
      "should mark clarification as accepted");
  });

  it("rejects when drift_clarification is too short (under 20 chars)", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      drift_clarification: "Changed plan.",
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "output_summary",
          check: "intent_drift",
          detail: "Declared intent was refactor auth but actual output fixed css — similarity 8%",
        }),
      ],
    });
    const result = enforceRound(selfEval, verifyResult, 3, [], 0);
    assert.equal(result.action, "reject",
      "should reject when clarification is too short");
  });

  it("terminates on the third consecutive intent_drift without clarification", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding again",
      should_continue: true,
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "output_summary",
          check: "intent_drift",
          detail: "Declared intent was audit contracts but actual output fixed css — similarity 5%",
        }),
      ],
    });
    // v2.14: the no-clarification branch counts toward the SAME streak as
    // weak clarifications (README: "three consecutive weak clarifications
    // terminate"). streak=2 → this is the 3rd consecutive un-explained drift.
    const result = enforceRound(selfEval, verifyResult, 5, [], 0, 2);
    assert.equal(result.action, "terminate",
      "should terminate on third consecutive drift without clarification");
  });

  it("does not terminate on the first drift after an unrelated rejection", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "output_summary",
          check: "intent_drift",
          detail: "Declared intent was audit contracts but actual output fixed css — similarity 5%",
        }),
      ],
    });
    // consecutiveRejections=1 comes from an UNRELATED rejection (e.g. R1).
    // The old branch read the global counter and terminated on the very
    // first drift; the v2.14 streak semantics give the agent its full
    // three-round runway regardless of other rejections.
    const result = enforceRound(selfEval, verifyResult, 5, [], 1);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "intent_drift");
  });

  // ── v2.12: Semantic anchor detection ─────────────────────────────────

  it("accepts clarification with a real constraint ID anchor", () => {
    const constraintId = deriveConstraintId("rate limiting");
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      discovered_constraints: ["rate limiting"],
      drift_clarification:
        `Pivoted because constraint ${constraintId} (rate limiting) was already satisfied. ` +
        "The CSS fix was higher priority.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, 0);
    assert.notEqual(result.action, "reject",
      "should accept when clarification has constraint ID");
    assert.equal(result.clarification_accepted, true,
      "should signal clarification was accepted");
  });

  it("accepts clarification with a real sub-goal ID anchor", () => {
    const subGoalId = deriveSubGoalId("util structure");
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Refactored utils",
      should_continue: true,
      discovered_constraints: ["util structure"],
      drift_clarification:
        `Discovered that sub-goal ${subGoalId} was blocked by the util structure. ` +
        "Refactored it first so the sub-goal can proceed next round.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, 0);
    assert.notEqual(result.action, "reject",
      "should accept when clarification has sub-goal ID");
    assert.equal(result.clarification_accepted, true);
  });

  it("accepts clarification with a real criterion ID anchor", () => {
    const criterionId = deriveCriterionId("integration coverage");
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Wrote integration tests",
      should_continue: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: null,
        success_criteria_met: ["integration coverage"],
        success_criteria_remaining: [],
        progress_estimate: 0.5,
      }),
      drift_clarification:
        `Pivoted to write tests because criterion ${criterionId} requires ` +
        "integration coverage before the feature is considered done.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, 0);
    assert.notEqual(result.action, "reject",
      "should accept when clarification has criterion ID");
    assert.equal(result.clarification_accepted, true);
  });

  it("accepts clarification with a real file path anchor", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/components/Login.tsx"],
        test_results: null,
        success_criteria_met: [],
        success_criteria_remaining: [],
        progress_estimate: 0.6,
      }),
      drift_clarification:
        "Pivoted because I found a bug in src/components/Login.tsx that " +
        "was causing the layout issue. Fixed that before continuing auth work.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, 0);
    assert.notEqual(result.action, "reject",
      "should accept when clarification has file path");
    assert.equal(result.clarification_accepted, true);
  });

  it("rejects weak clarification (>= 20 chars but no anchors) on first occurrence", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      drift_clarification:
        "Because I think this is necessary for the current step implementation. " +
        "The direction change was needed for better results.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, 0);
    assert.equal(result.action, "reject",
      "should reject weak clarification without anchors");
    assert.equal(result.check, "intent_drift");
    // fix_instructions should mention the need for concrete references
    assert.ok(
      (result.fix_instructions ?? "").includes("drift_clarification"),
      "fix_instructions should mention drift_clarification",
    );
  });

  it("terminates on third consecutive weak clarification (streak >= 3)", () => {
    const makeDriftEval = () => makeSelfEvaluation({
      success: false,
      output_summary: "Did something else",
      should_continue: true,
      drift_clarification:
        "I changed direction because I felt this approach was more optimal " +
        "for the current implementation requirements. It was the right call.",
    });
    const verifyResult = makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    });

    // Streak = 0 → first weak clarification → reject only
    const r0 = enforceRound(makeDriftEval(), verifyResult, 3, [], 0, 0);
    assert.equal(r0.action, "reject",
      "streak 0 should reject (first weak clarification)");

    // Streak = 1 → second weak clarification → still reject, but with warning
    const r1 = enforceRound(makeDriftEval(), verifyResult, 4, [], 0, 1);
    assert.equal(r1.action, "reject",
      "streak 1 should still reject (second weak clarification)");
    assert.ok(
      (r1.fix_instructions ?? "").includes("Repeated Weak Clarification"),
      "fix_instructions should warn about repeated weak clarification on streak >= 2",
    );

    // Streak = 2 → third weak clarification (2 + 1 = 3 >= max_streak=3) → terminate
    const r2 = enforceRound(makeDriftEval(), verifyResult, 5, [], 0, 2);
    assert.equal(r2.action, "terminate",
      "streak 2 + 1 = 3 should terminate (reaches max_streak=3)");
  });

  it("keeps streak unchanged for substantive clarification", () => {
    // Even with an existing streak, a strong clarification should be accepted
    // without resetting the streak (the enforcement gate doesn't track state;
    // the SessionManager does). But the result should NOT be reject/terminate.
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS",
      should_continue: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/styles/main.css"],
        test_results: null,
        success_criteria_met: [],
        success_criteria_remaining: [],
        progress_estimate: 0.6,
      }),
      drift_clarification:
        "Pivoted because src/styles/main.css had a layout-breaking regression. " +
        "The auth work was blocked by this visual bug.",
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, 2); // streak = 2
    assert.notEqual(result.action, "reject",
      "should accept substantive clarification even with existing streak");
    assert.equal(result.clarification_accepted, true);
  });

  it("still rejects when drift_clarification is absent entirely (original behavior)", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS padding",
      should_continue: true,
      // No drift_clarification at all
    });
    const result = enforceRound(selfEval, makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    }), 3, [], 0, 0);
    assert.equal(result.action, "reject",
      "should reject when no clarification provided");
  });

  it("weak clarification streak escalation disabled when max_streak is 0", () => {
    // Temporarily override the policy to disable the streak limit
    resetPolicy();
    const p = getPolicy();
    const orig = p.engine.drift_clarification_max_streak;
    p.engine.drift_clarification_max_streak = 0;

    try {
      const selfEval = makeSelfEvaluation({
        success: false,
        output_summary: "Did something else",
        should_continue: true,
        drift_clarification:
          "I changed direction because I felt this approach was better. " +
          "No concrete details but the length check still passes.",
      });
      const result = enforceRound(selfEval, makeVerificationResult({
        verdict: "suspect",
        flags: [makeVerificationFlag({
          severity: "warn", field: "output_summary",
          check: "intent_drift",
          detail: "Drift detected",
        })],
      }), 3, [], 0, 0);
      assert.notEqual(result.action, "reject",
        "should accept when max_streak is 0 (pre-v2.12 behavior)");
      assert.equal(result.clarification_accepted, true);
    } finally {
      p.engine.drift_clarification_max_streak = orig;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.10: Backtrack — safe restore point
// ═══════════════════════════════════════════════════════════════════════════

describe("findSafeRestorePoint", () => {
  /** Build a clean vault entry for a round. */
  // v3.3.1: fixtures now use the REAL committed-round shape — a :feedback
  // task_id carrying the decision in lineage.round_transaction (v3.2.1:
  // restore points judge only committed feedback entries; rejections never
  // commit, so a committed round's decision is action "continue" and its
  // dirtiness shows in the committed verification flags).
  function cleanRound(rnd: number): VaultEntry {
    return {
      task_id: `loop:test:r${rnd}:feedback`,
      task_type: "round_entry",
      timestamp: new Date().toISOString(),
      success: true,
      task: "test task",
      output_summary: `Round ${rnd} done`,
      constraint_violations: [],
      constraint_violations_entry: [],
      loop_id: "test",
      loop_lineage: {
        round: rnd,
        task: `Round ${rnd}`,
        success: true,
        round_transaction: {
          result: { action: "continue", verificationFlags: [] },
        },
      },
    };
  }

  function dirtyRound(rnd: number, severity: "warn" | "error" = "error"): VaultEntry {
    return {
      task_id: `loop:test:r${rnd}:feedback`,
      task_type: "round_entry",
      timestamp: new Date().toISOString(),
      success: false,
      task: "test task",
      output_summary: `Round ${rnd} failed`,
      constraint_violations: ["bad thing"],
      constraint_violations_entry: ["bad thing"],
      loop_id: "test",
      loop_lineage: {
        round: rnd,
        task: `Round ${rnd}`,
        success: false,
        round_transaction: {
          result: { action: "continue", verificationFlags: [] },
        },
      },
      verification_flags: [{ check: "test_flag", detail: "error", severity }],
    };
  }

  it("returns the most recent clean round (current - 1)", () => {
    const vault = [
      cleanRound(1),
      cleanRound(2),
      cleanRound(3),
      cleanRound(4),
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 4);
    assert.deepEqual(result!.skippedDiscoveries, []);
  });

  it("skips a dirty round and returns the next clean one", () => {
    const vault = [
      cleanRound(1),
      cleanRound(2),
      cleanRound(3),       // clean
      dirtyRound(4),       // dirty — should be skipped
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 3, "should skip round 4 and restore to round 3");
  });

  it("collects discoveries from skipped rounds", () => {
    const vault = [
      cleanRound(1),
      cleanRound(2),
      cleanRound(3),       // clean — restore target
      { ...dirtyRound(4), discovered_constraints: ["discovery from r4"] },
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 3);
    assert.ok(result!.skippedDiscoveries.includes("discovery from r4"));
  });

  it("skips multiple dirty rounds to find a clean one", () => {
    // v3.2.1: rejected rounds never commit a feedback entry in the real
    // vault, so a rejected round is represented by its absence, not by an
    // entry. Use two error-flagged dirty rounds instead.
    const vault = [
      cleanRound(1),
      cleanRound(2),       // clean — restore target
      dirtyRound(3),       // dirty
      dirtyRound(4),       // dirty
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 2, "should skip rounds 4 and 3 to reach round 2");
  });

  it("returns null when maxDepth is exceeded", () => {
    const vault = [
      dirtyRound(1),
      dirtyRound(2),
      dirtyRound(3),
      dirtyRound(4),
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.equal(result, null);
  });

  it("returns null when no entries exist before currentRound", () => {
    const result = findSafeRestorePoint(1, [], 3);
    assert.equal(result, null);
  });

  it("skips rounds with error-level verification flags", () => {
    const vault = [
      cleanRound(1),
      cleanRound(2),       // clean
      {                       // round 3: has error flag → not clean
        ...cleanRound(3),
        success: false,
        verification_flags: [{ check: "test", detail: "error", severity: "error" }],
      },
      cleanRound(4),       // round 4: clean but... wait, this is the one we're at
    ];
    // currentRound=5, round 4 is clean, so restore to 4
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    // Round 4 is clean, round 3 is skipped (has errors)
    // Actually wait - we're scanning backwards from currentRound-1
    // depth=1: round 4 (clean) → found!
    assert.equal(result!.round, 4);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // v3.2.1 regression: real vault shape — every round carries a compile-time
  // lineage entry (engine.ts hardcodes `success: true` on it, no
  // round_transaction) BEFORE the committed feedback entry. Before the fix,
  // findSafeRestorePoint hit the lineage entry first, so every round looked
  // clean and the restore point was always currentRound-1 — dirty rounds
  // were never skipped and skippedDiscoveries (depth > 1) never collected.
  // ═════════════════════════════════════════════════════════════════════════
  function lineageRound(rnd: number): VaultEntry {
    return {
      task_id: `loop:test:r${rnd}`,
      task_type: "loop_lineage",
      timestamp: new Date().toISOString(),
      task: "test task",
      output_summary: "",
      constraint_violations: [],
      loop_id: "test",
      // engine.ts persists `success: true` on lineage entries — the shape
      // that previously masked dirty feedback rounds.
      loop_lineage: { round: rnd, task: `Round ${rnd}`, success: true },
    };
  }

  it("ignores compile-time lineage entries when picking a restore point", () => {
    const vault = [
      lineageRound(1),
      cleanRound(1),
      lineageRound(2),
      cleanRound(2),
      lineageRound(3),
      cleanRound(3),
      lineageRound(4),   // claims success:true — must NOT mask the dirty round
      dirtyRound(4),     // dirty feedback — should be skipped
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(
      result!.round, 3,
      "dirty round 4 must be skipped even with a lineage entry claiming success",
    );
  });

  it("collects discoveries from skipped rounds in the real vault shape", () => {
    const vault = [
      lineageRound(1),
      cleanRound(1),
      lineageRound(2),
      cleanRound(2),
      lineageRound(3),
      cleanRound(3),     // clean restore target
      lineageRound(4),
      { ...dirtyRound(4), discovered_constraints: ["discovery from r4"] },
    ];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 3);
    assert.ok(
      result!.skippedDiscoveries.includes("discovery from r4"),
      "discoveries from skipped rounds must be collected from feedback entries",
    );
  });

  it("accepts rounds with warn-level flags as clean", () => {
    const entryWithWarn = {
      ...cleanRound(3),
      verification_flags: [{ check: "test_warn", detail: "just a warning", severity: "warn" }],
    };
    const vault = [cleanRound(1), cleanRound(2), entryWithWarn, cleanRound(4)];
    const result = findSafeRestorePoint(5, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 4); // r4 is clean and closer
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.10: Build backtrack prompt
// ═══════════════════════════════════════════════════════════════════════════

describe("buildBacktrackPrompt", () => {
  // ── Round-number exactness (regression guard for ${fromRound} literal bug) ──

  it("renders exact round numbers in all key positions", () => {
    const prompt = buildBacktrackPrompt(45, 42, "progress_stall", [],
      ["src/auth.ts"]);
    verifyBacktrackPrompt(prompt, 45, 42, [
      "Backtrack",
      "did not work",
      "different",
    ]);
    // No literal template expressions survive
    assert.ok(!prompt.includes("${"), "prompt must not contain any ${...} literal");
  });

  // ── v3.5: stalled Round Contract revision channel ────────────────────────

  it("tells the agent to close a stalled Round Contract via blocked + revision", () => {
    for (const trigger of ["progress_stall", "progress_stall_terminal"]) {
      const prompt = buildBacktrackPrompt(45, 42, trigger, []);
      assert.ok(prompt.includes("Round Contract that caused the stall"),
        `${trigger}: the stalled-contract bullet must appear`);
      assert.ok(prompt.includes('outcome="blocked"'),
        `${trigger}: the closed-with-blocked channel must be named`);
      assert.ok(prompt.includes("REVISED contract"),
        `${trigger}: declaring the revised contract in the same submission must be named`);
      assert.ok(prompt.includes("silently restate the stalled contract"),
        `${trigger}: the forbidden silent restate must be named`);
    }
  });

  // ── Trigger-rule guidance ────────────────────────────────────────────────

  it("renders stall-specific guidance for progress_stall", () => {
    const prompt = buildBacktrackPrompt(45, 42, "progress_stall", []);
    verifyBacktrackPrompt(prompt, 45, 42, [
      "did not work",
      "different",
    ]);
    assert.ok(!prompt.includes("radically different"),
      "progress_stall should NOT include terminal-level language");
  });

  it("renders radical-change guidance for progress_stall_terminal", () => {
    const prompt = buildBacktrackPrompt(50, 45, "progress_stall_terminal", []);
    verifyBacktrackPrompt(prompt, 50, 45, [
      "radically different",
      "zero forward motion",
    ]);
  });

  // ── Discoveries + workspace restore ──────────────────────────────────────

  it("renders preserved discoveries and skipped files", () => {
    const discoveries = ["SafeERC20 required", "2-day timelock"];
    const skippedFiles = ["src/auth.ts", "lib/utils.go", "README.md"];
    const prompt = buildBacktrackPrompt(10, 8, "progress_stall",
      discoveries, skippedFiles);
    verifyBacktrackPrompt(prompt, 10, 8, [
      "Preserved Discoveries",
      "SafeERC20 required",
      "2-day timelock",
      "Workspace Restore",
      "src/auth.ts",
      "lib/utils.go",
      "README.md",
      "If git is unavailable",
      "rejected",
    ]);
  });

  it("truncates long file lists and omits discovery section when empty", () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    const prompt = buildBacktrackPrompt(10, 5, "progress_stall", [],
      manyFiles);
    verifyBacktrackPrompt(prompt, 10, 5, [
      "Workspace Restore",
      "and 5 more files",
      "Files modified in skipped rounds",
    ]);
    assert.ok(!prompt.includes("Preserved Discoveries"),
      "should not render discovery section when empty");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: Effective-success semantics (R3) with declared outcomes
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — v2.12 effective success", () => {
  it("R3 accepts outcome=partial without execution evidence (declared non-success)", () => {
    const selfEval = makeSelfEvaluation({
      success: true, // legacy boolean contradicts, but outcome wins
      outcome: "partial",
      output_summary: "partial progress",
      constraint_violations: [],
      should_continue: true,
    });
    const result = enforceRound(selfEval, { verdict: "trusted", flags: [] }, 2, [], 0, 0);
    assert.equal(result.action, "accept");
  });

  it("R3 still rejects legacy success=true with no evidence (no outcome declared)", () => {
    const selfEval = makeSelfEvaluation({
      success: true,
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
    });
    const result = enforceRound(selfEval, { verdict: "trusted", flags: [] }, 2, [], 0, 0);
    assert.equal(result.action, "reject");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: R7 real-anchor validation — fabricated IDs no longer count
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — v2.12 real anchor validation", () => {
  function driftVerify(): VerificationResult {
    return makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "output_summary",
        check: "intent_drift",
        detail: "Drift detected",
      })],
    });
  }

  it("rejects a fabricated constraint ID that does not derive from any known text", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS",
      should_continue: true,
      drift_clarification:
        "Pivoted because constraint c-00000000 was already satisfied. The CSS fix was higher priority.",
    });
    const result = enforceRound(selfEval, driftVerify(), 3, [], 0, 0);
    assert.equal(result.action, "reject",
      "fabricated IDs must not count as substantive anchors");
    assert.notEqual(result.clarification_accepted, true);
  });

  it("rejects a file path that was never reported or observed", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS",
      should_continue: true,
      drift_clarification:
        "Pivoted because src/fake/path.ts was the actual problem.",
    });
    const result = enforceRound(selfEval, driftVerify(), 3, [], 0, 0);
    assert.equal(result.action, "reject");
  });

  it("accepts a real anchor found in vault entries (not just the current report)", () => {
    const constraintId = deriveConstraintId("rate limiting");
    const vault: VaultEntry[] = [{
      id: "loop:anchor-loop:r2",
      task_id: "loop:anchor-loop:r2",
      task_type: "loop_lineage",
      loop_id: "anchor-loop",
      timestamp: new Date().toISOString(),
      loop_lineage: { round: 2 },
      discovered_constraints: ["rate limiting"],
    }];
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Fixed CSS",
      should_continue: true,
      drift_clarification:
        `Pivoted because constraint ${constraintId} was satisfied in an earlier round.`,
    });
    const result = enforceRound(selfEval, driftVerify(), 3, vault, 0, 0);
    assert.equal(result.action, "accept");
    assert.equal(result.clarification_accepted, true);
  });
});

// R4 deadlock guard (v2.14): a backtrack that already committed for this
// round must not be repeated forever — the second escalation terminates.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R4: backtrack deadlock guard", () => {
  it("terminates instead of backtracking when a backtrack already committed for this round", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.33,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.31),
      vaultRound(3, 0.32),
      // The previous stall cycle already committed a backtrack for round 4 —
      // the loop is re-walking rolled-back territory with the same stall.
      {
        task_id: "loop:test-loop:r4:feedback",
        loop_id: "test-loop",
        loop_lineage: {
          round: 4,
          round_transaction: {
            schema_version: 1,
            round_id: "test-loop:4",
            snapshot: {},
            result: { action: "backtrack", verificationFlags: [] },
          },
        },
      },
    ];
    const result = enforceRound(curr, trusted(), 4, vault, 1);
    assert.equal(result.action, "terminate");
    assert.equal(result.check, "progress_stall");
  });

  it("still backtracks on a fresh stall window with no committed backtrack", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.43,
      }),
    });
    // A backtrack committed at round 2 is BELOW the current window — the
    // agent recovered, progressed, and then stalled again at rounds 3-5.
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.31),
      {
        task_id: "loop:test-loop:r2:feedback",
        loop_id: "test-loop",
        loop_lineage: {
          round: 2,
          round_transaction: {
            schema_version: 1,
            round_id: "test-loop:2",
            snapshot: {},
            result: { action: "backtrack", verificationFlags: [] },
          },
        },
      },
      vaultRound(3, 0.40),
      vaultRound(4, 0.41),
      vaultRound(5, 0.42),
    ];
    const result = enforceRound(curr, trusted(), 6, vault, 1);
    assert.equal(result.action, "backtrack");
    assert.equal(result.check, "progress_stall");
  });
});

// R-EVID (v2.14): evidence contradictions — required command failure,
// hidden test failures, and self-contradictory outcome claims.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R-EVID: evidence contradictions", () => {
  it("rejects when a required command failed", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const verify = makeVerificationResult({
      verdict: "contradicted",
      flags: [
        makeVerificationFlag({
          severity: "error",
          field: "command_evidence",
          check: "required_command_failed",
          detail: 'Required command "npm test" exited 1 but success was claimed',
        }),
      ],
    });
    const result = enforceRound(curr, verify, 4, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "required_command_failed");
  });

  it("rejects when reported test results hide failures", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const verify = makeVerificationResult({
      verdict: "contradicted",
      flags: [
        makeVerificationFlag({
          severity: "error",
          field: "test_results",
          check: "command_evidence_mismatch",
          detail: 'Agent test_results don\'t match "npm test" output: failed: reported 0, command shows 5',
        }),
      ],
    });
    const result = enforceRound(curr, verify, 4, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "command_evidence_mismatch");
  });

  it("rejects on a self-contradictory outcome claim", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const verify = makeVerificationResult({
      verdict: "contradicted",
      flags: [
        makeVerificationFlag({
          severity: "error",
          field: "outcome",
          check: "outcome_success_contradiction",
          detail: "outcome=success but success=false — self-contradiction",
        }),
      ],
    });
    const result = enforceRound(curr, verify, 4, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "outcome_success_contradiction");
  });

  it("accepts when the contradiction flags are absent", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const result = enforceRound(curr, trusted(), 4, [], 0);
    assert.equal(result.action, "accept");
  });
});

describe("enforcement-gate — v3.3 R-EVID-VERIFY: entrypoint tampering", () => {
  const entrypointTainted = (): VerificationResult => makeVerificationResult({
    verdict: "contradicted",
    flags: [
      makeVerificationFlag({
        severity: "error",
        field: "execution_evidence",
        check: "verification_entrypoint_modified",
        detail: 'Verification command "run-tests" entrypoint changed this round',
      }),
    ],
  });

  it("rejects when the verification command entrypoint changed this round", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["run-tests.sh"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const result = enforceRound(curr, entrypointTainted(), 4, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "verification_entrypoint_modified");
  });

  it("takes precedence over R8 when both fire (entrypoint reason is specific)", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const verify = makeVerificationResult({
      verdict: "contradicted",
      flags: [
        makeVerificationFlag({
          severity: "error",
          field: "execution_evidence",
          check: "verification_entrypoint_modified",
          detail: 'Verification command "run-tests" entrypoint changed this round',
        }),
        makeVerificationFlag({
          severity: "error",
          field: "success",
          check: "success_without_verified_evidence",
          detail: "success with zero verified claims and no test evidence",
        }),
      ],
    });
    const result = enforceRound(curr, verify, 4, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "verification_entrypoint_modified");
  });

  it("does not fire when the entrypoint flag is warn-level or absent", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const verify = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "execution_evidence",
          check: "test_files_modified",
          detail: "Test files changed in the same round the command passed",
        }),
      ],
    });
    const result = enforceRound(curr, verify, 4, [], 0);
    assert.equal(result.action, "accept");
  });
});

// R5 continuity guard (v2.14): flatline requires the recent data points to
// cover the most recent rounds — rounds without evidence are unknown motion.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R5: continuity guard", () => {
  it("does not terminate on flatline when recent rounds have no progress data", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.40,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.30),
      vaultRound(3, 0.30),
      // Rounds 4-5 committed without execution_evidence — unknown motion,
      // not zero motion. R4's window is discontinuous (returns null); R5
      // previously looked at rounds 1-3 and terminated/backtracked anyway.
      { task_id: "loop:test-loop:r4", loop_id: "test-loop", loop_lineage: { round: 4, success: true } },
      { task_id: "loop:test-loop:r5", loop_id: "test-loop", loop_lineage: { round: 5, success: true } },
    ];
    const result = enforceRound(curr, trusted(), 6, vault, 1);
    assert.equal(result.action, "accept");
  });

  it("still triggers enforcement on a continuous flatline window (R4 preempts)", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.30,
      }),
    });
    const vault = [
      vaultRound(1, 0.30),
      vaultRound(2, 0.30),
      vaultRound(3, 0.30),
      vaultRound(4, 0.30),
      vaultRound(5, 0.30),
    ];
    // A continuous flatline satisfies R4's stall condition too, and R4 runs
    // first — the first occurrence rejects (R5's flatline-specific branch
    // is only reachable through R4's escalation). The continuity guard must
    // not suppress enforcement on the legitimate flatline window.
    const result = enforceRound(curr, trusted(), 6, vault, 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "progress_stall");
  });
});

// R9 deadlock guard (v2.14): a non-restoring agent must not cycle
// R9-backtrack forever — backtracks do not increment the rejection counter.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R9: workspace restore guard", () => {
  function unrestoredVerify(): VerificationResult {
    return makeVerificationResult({
      verdict: "contradicted",
      flags: [
        makeVerificationFlag({
          severity: "error",
          field: "workspace",
          check: "backtrack_workspace_not_restored",
          detail: "Workspace HEAD (abc123) does not match the backtrack restore commit (def456)",
        }),
      ],
    });
  }

  function committedBacktrackEntry(round: number): VaultEntry {
    return {
      task_id: `loop:test-loop:r${round}:feedback`,
      loop_id: "test-loop",
      loop_lineage: {
        round,
        round_transaction: {
          schema_version: 1,
          round_id: `loop:test-loop:${round}`,
          snapshot: {},
          result: { action: "backtrack", verificationFlags: [] },
        },
      },
    };
  }

  it("backtracks when no prior backtrack committed for this round", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const result = enforceRound(curr, unrestoredVerify(), 3, [], 0);
    assert.equal(result.action, "backtrack");
    assert.equal(result.check, "backtrack_workspace_not_restored");
  });

  it("terminates when the workspace was never restored after a prior backtrack", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const vault = [committedBacktrackEntry(3)];
    const result = enforceRound(curr, unrestoredVerify(), 3, vault, 0);
    assert.equal(result.action, "terminate");
    assert.equal(result.check, "backtrack_workspace_not_restored");
  });

  it("buildBacktrackPrompt includes a git reset command when a restore commit exists", () => {
    const prompt = buildBacktrackPrompt(5, 3, "progress_stall", [], [], "abc123def4567890");
    assert.ok(prompt.includes("git reset --hard abc123def4"),
      "prompt must show how to move HEAD to the restore commit");
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — R4/R5 machine progress fallback (heuristic path)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — R4 machine progress fallback", () => {
  const feedbackRound = (round: number, gitFiles: string[]): VaultEntry => ({
    task_id: `loop:test-loop:r${round}:feedback`,
    loop_id: "test-loop",
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: 1,
        round_id: `loop:test-loop:round:${round}`,
        snapshot: {
          schemaVersion: 1,
          roundId: `loop:test-loop:round:${round}`,
          loopId: "test-loop",
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: [],
          roundEvidence: [{ provider: "git", timestamp: Date.now(), files: gitFiles, data: {} }],
          createdAt: 0,
          updatedAt: 0,
        },
      },
    },
  });

  it("detects stall from three rounds without git changes on the heuristic path", () => {
    const entries = [feedbackRound(1, []), feedbackRound(2, []), feedbackRound(3, [])];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.ok(result, "machine stall must fire where the rule used to self-skip");
    assert.equal(result!.action, "reject");
    assert.equal(result!.check, "progress_stall");
  });

  it("does not fire when git observed changes in the window", () => {
    const entries = [feedbackRound(1, ["a.ts"]), feedbackRound(2, ["b.ts"]), feedbackRound(3, ["c.ts"])];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "accept", "observed changes → no stall");
  });

  it("keeps the legacy skip when no git snapshots exist", () => {
    const entries = [
      { task_id: "loop:test-loop:r1:feedback", loop_id: "test-loop", loop_lineage: { round: 1, round_transaction: { snapshot: { roundEvidence: [] } } } },
      { task_id: "loop:test-loop:r2:feedback", loop_id: "test-loop", loop_lineage: { round: 2, round_transaction: { snapshot: { roundEvidence: [] } } } },
      { task_id: "loop:test-loop:r3:feedback", loop_id: "test-loop", loop_lineage: { round: 3, round_transaction: { snapshot: { roundEvidence: [] } } } },
    ] as VaultEntry[];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "accept", "no git signal → the rule keeps skipping");
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — R4/R5 exculpatory machine cross-check (evidence path)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — R4/R5 exculpatory machine cross-check", () => {
  /** Committed feedback round carrying progress + git snapshot + met
   *  criteria — the full evidence-path shape R4/R5 and the machine
   *  signals (machineProgressSeries / hasNewCriteriaCompletion) read. */
  const machineRound = (
    round: number,
    progress: number,
    gitFiles: string[],
    met: string[] = [],
  ): VaultEntry => ({
    task_id: `loop:test-loop:r${round}:feedback`,
    loop_id: "test-loop",
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: 1,
        round_id: `loop:test-loop:round:${round}`,
        snapshot: {
          schemaVersion: 1,
          roundId: `loop:test-loop:round:${round}`,
          loopId: "test-loop",
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: [],
          roundEvidence: [{ provider: "git", timestamp: Date.now(), files: gitFiles, data: {} }],
          createdAt: 0,
          updatedAt: 0,
        },
      },
    },
    execution_evidence: {
      files_changed: gitFiles,
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: met,
      success_criteria_remaining: [],
      progress_estimate: progress,
    },
  });

  it("does not fire R4 when git motion was observed in the window (evidence path)", () => {
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.31, ["src/a.ts"]),
      machineRound(3, 0.32, []),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "accept", "git motion exculpates the delta-based stall");
  });

  it("v3.6: a newly completed criterion does NOT exculpate the stall (git motion only)", () => {
    // Self-reported criteria completions never buy a machine verdict — only
    // observed git motion can veto the delta-based stall.
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.31, []),
      machineRound(3, 0.32, [], ["auth module completed"]),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "reject");
    assert.equal(result!.check, "progress_stall");
  });

  it("R4 reason annotates the missing machine signal when git is flat", () => {
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.31, []),
      machineRound(3, 0.32, []),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "reject");
    assert.equal(result!.check, "progress_stall");
    assert.match(
      result!.reason,
      /no machine-observed git motion in rounds 1–3/,
    );
  });

  it("v3.6: R5 flatline is NOT excluded by a criterion completion over the breaker window", () => {
    // v3.6: criteria no longer exculpate — an exactly-flat run with only a
    // self-reported completion stalls on R4 and flatlines R5.
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.30, []),
      machineRound(3, 0.30, [], ["auth module completed"]),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "reject");
    assert.equal(result!.check, "progress_stall");
  });

  it("R5 flatline is excluded by git motion over the breaker window", () => {
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.30, ["src/a.ts"]),
      machineRound(3, 0.30, []),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "accept", "git motion exculpates the flatline");
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Round Contract enforcement (R-C1 premature_boundary / R-C2 scope)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — Round Contract enforcement", () => {
  /** VerificationResult carrying a single flag of the given check. */
  const withFlag = (check: string, severity: "warn" | "error" | "info" = "error"): VerificationResult =>
    makeVerificationResult({
      verdict: severity === "error" ? "contradicted" : "suspect",
      flags: [makeVerificationFlag({
        severity,
        field: "round_contract",
        check,
        detail: `contract issue: ${check}`,
      })],
    });

  /** Evidence-carrying success claim — keeps R3 (empty_success) and other
   *  pre-contract rules out of the way so R-C1 is what the round trips. */
  const claimingSuccess = (): SelfEvaluation => se({
    success: true,
    execution_evidence: makeExecutionEvidence({
      files_changed: ["src/auth.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: ["criterion A"],
      success_criteria_remaining: [],
      progress_estimate: 0.9,
    }),
  });

  it("R-C1: premature_boundary error flag → reject with contract wording", () => {
    const result = enforceRound(claimingSuccess(), withFlag("premature_boundary"), 3, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "premature_boundary");
    assert.match(result.fix_instructions, /verification_plan/);
    assert.match(result.fix_instructions, /success_criteria_remaining/);
  });

  it("R-C1: repeated premature_boundary → terminate", () => {
    const result = enforceRound(claimingSuccess(), withFlag("premature_boundary"), 3, [], 2);
    assert.equal(result.action, "terminate");
    assert.equal(result.check, "premature_boundary");
  });

  it("R-C1 outranks R8 on contract rounds (rule order regression)", () => {
    // Both premature_boundary AND success_without_verified_evidence fire on
    // an unverified contract success claim; the contract gets its own
    // reason and its own rejection counter.
    const result = enforceRound(claimingSuccess(), makeVerificationResult({
      verdict: "contradicted",
      flags: [
        makeVerificationFlag({ severity: "error", field: "success",
          check: "success_without_verified_evidence", detail: "no evidence" }),
        makeVerificationFlag({ severity: "error", field: "round_contract",
          check: "premature_boundary", detail: "done_when unverified" }),
      ],
    }), 3, [], 0);
    assert.equal(result.check, "premature_boundary");
  });

  it("R-C2: scope drift with substantive clarification → accept", () => {
    // The clarification names the out-of-scope file, which sits in the
    // selfEval's own files_changed → real anchor, ≥ 20 chars.
    const selfEval = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/other.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: [],
        progress_estimate: 0.5,
      }),
      drift_clarification:
        "Extended scope to src/other.ts because the API types moved there",
    });
    const result = enforceRound(selfEval, withFlag("round_scope_drift", "warn"), 3, [], 0);
    assert.equal(result.action, "accept");
    assert.equal(result.clarification_accepted, true);
  });

  it("R-C2: scope drift without clarification → reject", () => {
    const result = enforceRound(se({ success: false }), withFlag("round_scope_drift", "warn"), 3, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "round_scope_drift");
    assert.match(result.fix_instructions, /drift_clarification/);
  });

  it("R-C2: weak clarification (no anchors) rejects; repeated → terminate", () => {
    const weak = se({
      success: false,
      drift_clarification: "I changed direction because it was better overall",
    });
    const first = enforceRound(weak, withFlag("round_scope_drift", "warn"), 3, [], 0);
    assert.equal(first.action, "reject", "anchor-less clarification must not accept");
    const repeated = enforceRound(weak, withFlag("round_scope_drift", "warn"), 3, [], 2);
    assert.equal(repeated.action, "terminate");
    assert.equal(repeated.check, "round_scope_drift");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.5 — contract_completion_unverified enforcement rule
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.5 — contract completion enforcement", () => {
  /** VerificationResult carrying one flag of the given check/severity. */
  const withFlag = (check: string, severity: "warn" | "error" | "info" = "error"): VerificationResult =>
    makeVerificationResult({
      verdict: severity === "error" ? "contradicted" : "suspect",
      flags: [makeVerificationFlag({
        severity,
        field: "round_contract",
        check,
        detail: `contract issue: ${check}`,
      })],
    });

  /** Evidence-carrying eval — keeps R3 (empty_success) and R8 out of the
   *  way so the injected flag is what the round trips. */
  const claiming = (): SelfEvaluation => se({
    execution_evidence: makeExecutionEvidence({
      files_changed: ["src/auth.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: ["criterion A"],
      success_criteria_remaining: [],
      progress_estimate: 0.9,
    }),
  });

  it("completion-unverified error → reject with the contract's own wording", () => {
    const result = enforceRound(
      claiming(), withFlag("contract_completion_unverified"), 3, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "contract_completion_unverified");
    assert.match(result.fix_instructions, /verification_plan/);
    assert.match(result.fix_instructions, /no_change_reason/);
  });

  it("second consecutive completion-unverified → terminate", () => {
    const first = enforceRound(
      claiming(), withFlag("contract_completion_unverified"), 3, [], 0);
    assert.equal(first.action, "reject");
    const repeated = enforceRound(
      claiming(), withFlag("contract_completion_unverified"), 3, [], 2);
    assert.equal(repeated.action, "terminate");
    assert.equal(repeated.check, "contract_completion_unverified");
  });

  it("completion-unverified outranks premature_boundary (registration order)", () => {
    // A completing eval that also trips the boundary gets the completion
    // reason first — the completion-truth question precedes boundary nuance.
    const both = makeVerificationResult({
      verdict: "contradicted",
      flags: [
        makeVerificationFlag({
          severity: "error", field: "round_contract",
          check: "premature_boundary", detail: "boundary",
        }),
        makeVerificationFlag({
          severity: "error", field: "round_contract",
          check: "contract_completion_unverified", detail: "completion",
        }),
      ],
    });
    const result = enforceRound(claiming(), both, 3, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "contract_completion_unverified");
  });

  it("contract_premature warn alone → accept (warn never rejects)", () => {
    const result = enforceRound(
      claiming(), withFlag("contract_premature", "warn"), 3, [], 0);
    assert.equal(result.action, "accept");
  });
});
