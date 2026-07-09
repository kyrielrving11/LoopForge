/** Tests for enforcement-gate — Layer 2 round-boundary runtime enforcement. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
import type { VaultEntry } from "../backends/interface.js";
import { enforceRound, buildRejectionPrompt } from "../enforcement-gate.js";

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

  it("skips when execution_evidence is undefined (heuristic fallback)", () => {
    // Heuristic self-evaluations have no execution_evidence.
    // R3 should not fire in this case — it only fires when
    // execution_evidence IS provided but shows empty work.
    const curr = makeSelfEvaluation({
      success: true,
      output_summary: "Done.",
      constraint_violations: [],
      should_continue: true,
    });
    // Explicitly remove execution_evidence (default factory sets it)
    (curr as unknown as Record<string, unknown>).execution_evidence = undefined;
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "accept");
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

  it("terminates on second consecutive stall rejection", () => {
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
    // consecutiveRejections=1 (was already rejected once before)
    const result = enforceRound(curr, trusted(), 4, vault, 1);
    assert.equal(result.action, "terminate");
    assert.ok(result.reason.includes("previous rejection"));
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
  it("terminates after 2 consecutive rejections", () => {
    const curr = se({ success: false });
    const result = enforceRound(curr, trusted(), 3, [], 2);
    assert.equal(result.action, "terminate");
    assert.ok(result.reason.includes("consecutive enforcement rejections"));
  });

  it("does not terminate with only 1 rejection", () => {
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
