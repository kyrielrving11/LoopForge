/** Tests for verification-gate — Layer 1 cross-round consistency checks. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  makeExecutionEvidence,
  makeSelfEvaluation,
  type SelfEvaluation,
} from "../protocol.js";
import type { VaultEntry } from "../backends/interface.js";
import { verifySelfEvaluation } from "../verification-gate.js";

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

/** Build a vault entry with a given round and optional constraint_violations. */
function vaultRound(
  round: number,
  violations: string[] = [],
): VaultEntry {
  return {
    task_id: `loop:test-loop:r${round}`,
    loop_id: "test-loop",
    loop_lineage: { round, success: true, task: "test task" },
    constraint_violations: violations,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Happy path
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — happy path", () => {
  it("trusted verdict when all checks pass with consistent data", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 3, failed: 1, skipped: 0 },
        success_criteria_met: ["impl"],
        success_criteria_remaining: ["tests"],
        progress_estimate: 0.7,
      }),
      constraint_violations: ["deadline"],
      discovered_constraints: ["new: must handle null"],
    });

    const prev = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/bar.ts"],
        test_results: { passed: 1, failed: 2, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["impl", "tests"],
        progress_estimate: 0.3,
      }),
      constraint_violations: ["missing docs"],
      discovered_constraints: ["must use async"],
    });

    const vault = [vaultRound(1, ["missing docs"])];

    const result = verifySelfEvaluation(curr, 2, vault, prev);
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });

  it("trusted verdict for first round (no previous data)", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        progress_estimate: 0.0,
      }),
    });

    const result = verifySelfEvaluation(curr, 1, [], null);
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Check 1: Progress regression
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — progress regression", () => {
  it("flags when estimate drops > 0.2", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.3 }),
    });
    const prev = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.8 }),
    });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "suspect");
    const flag = result.flags.find((f) => f.check === "progress_regression");
    assert.ok(flag);
    assert.equal(flag.field, "progress_estimate");
    assert.equal(flag.severity, "warn");
  });

  it("does not flag when estimate drops ≤ 0.2", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.6 }),
    });
    const prev = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.8 }),
    });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when estimate increases", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.9 }),
    });
    const prev = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.5 }),
    });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when no previous execution evidence", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.3 }),
    });
    const prev = se({ execution_evidence: undefined });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "trusted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Check 2: Empty change + all passing
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — empty change with passing tests", () => {
  it("flags when no files changed, all tests pass, and success is true", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: { passed: 5, failed: 0, skipped: 0 },
      }),
    });

    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.equal(result.verdict, "suspect");
    const flag = result.flags.find((f) => f.check === "empty_change_with_passing");
    assert.ok(flag);
    assert.equal(flag.severity, "warn");
  });

  it("does not flag when tests have failures", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: { passed: 3, failed: 1, skipped: 0 },
      }),
    });

    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when files were changed", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 5, failed: 0, skipped: 0 },
      }),
    });

    const result = verifySelfEvaluation(curr, 2, [], null);
    const flag = result.flags.find((f) => f.check === "empty_change_with_passing");
    assert.equal(flag, undefined);
  });

  it("does not flag when success is false", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: { passed: 5, failed: 0, skipped: 0 },
      }),
    });

    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.equal(result.verdict, "trusted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Check 3: Success with remaining criteria
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — success with remaining criteria", () => {
  it("flags when success=true but criteria remain unmet", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        success_criteria_met: ["builds"],
        success_criteria_remaining: ["tests pass", "docs updated"],
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null);
    assert.equal(result.verdict, "contradicted");
    const flag = result.flags.find((f) => f.check === "success_with_remaining_criteria");
    assert.ok(flag);
    assert.equal(flag.severity, "error");
    assert.ok(flag.detail.includes("tests pass"));
  });

  it("does not flag when success=true and criteria list is empty", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        success_criteria_met: ["builds", "tests pass"],
        success_criteria_remaining: [],
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when success is false even with remaining criteria", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        success_criteria_remaining: ["tests pass"],
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null);
    assert.equal(result.verdict, "trusted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Check 4: Duplicate constraint discovery
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — duplicate constraint discovery", () => {
  it("flags when discovered constraint was already in previous round", () => {
    const curr = se({
      discovered_constraints: ["must handle null"],
    });
    const prev = se({
      discovered_constraints: ["must handle null"],
    });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "suspect");
    const flag = result.flags.find((f) => f.check === "duplicate_constraint_discovery");
    assert.ok(flag);
    assert.equal(flag.severity, "warn");
  });

  it("flags when discovered constraint was a previous violation", () => {
    const curr = se({
      discovered_constraints: ["deadline pressure"],
    });
    const prev = se({
      constraint_violations: ["deadline pressure"],
    });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "suspect");
  });

  it("does not flag when constraint is genuinely new", () => {
    const curr = se({
      discovered_constraints: ["must validate input"],
    });
    const prev = se({
      discovered_constraints: ["must handle null"],
      constraint_violations: ["deadline"],
    });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "trusted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Check 5: Recurring violation
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — recurring violation", () => {
  it("flags when same violation appears 3 consecutive rounds", () => {
    const curr = se({
      constraint_violations: ["deadline", "new issue"],
    });
    const prev = se({
      constraint_violations: ["deadline", "other"],
    });
    // Entry for round 2 (current is round 3) stores violations from round 1
    const vault = [
      vaultRound(2, ["deadline"]), // violations from round 1
    ];

    const result = verifySelfEvaluation(curr, 3, vault, prev);
    assert.equal(result.verdict, "contradicted");
    const flag = result.flags.find((f) => f.check === "recurring_violation");
    assert.ok(flag);
    assert.equal(flag.severity, "error");
    assert.ok(flag.detail.includes("deadline"));
  });

  it("does not flag after only 2 consecutive rounds", () => {
    const curr = se({
      constraint_violations: ["deadline"],
    });
    const prev = se({
      constraint_violations: ["deadline"],
    });
    // Only 2 rounds of data (current + prev) — no vault entry with the 3rd
    const vault: VaultEntry[] = []; // no deeper history

    const result = verifySelfEvaluation(curr, 2, vault, prev);
    // Should be trusted or suspect at most (not contradicted for recurring)
    const flag = result.flags.find((f) => f.check === "recurring_violation");
    assert.equal(flag, undefined);
  });

  it("does not flag when violations differ each round", () => {
    const curr = se({
      constraint_violations: ["issue C"],
    });
    const prev = se({
      constraint_violations: ["issue B"],
    });
    const vault = [vaultRound(2, ["issue A"])]; // round 1 violations

    const result = verifySelfEvaluation(curr, 3, vault, prev);
    const flag = result.flags.find((f) => f.check === "recurring_violation");
    assert.equal(flag, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Check 6: Retract fresh constraint
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — retract fresh constraint", () => {
  it("flags when retracting a constraint discovered in previous round", () => {
    const curr = se({
      retracted_constraints: ["must use async"],
    });
    const prev = se({
      discovered_constraints: ["must use async", "must handle null"],
    });

    const result = verifySelfEvaluation(curr, 3, [], prev);
    assert.equal(result.verdict, "suspect");
    const flag = result.flags.find((f) => f.check === "retract_fresh_constraint");
    assert.ok(flag);
    assert.equal(flag.severity, "warn");
    assert.ok(flag.detail.includes("round 2"));
  });

  it("does not flag when retracting an older constraint", () => {
    const curr = se({
      retracted_constraints: ["old constraint"],
    });
    const prev = se({
      discovered_constraints: ["new constraint"],
    });

    const result = verifySelfEvaluation(curr, 3, [], prev);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when no previous round exists", () => {
    const curr = se({
      retracted_constraints: ["some constraint"],
    });

    const result = verifySelfEvaluation(curr, 1, [], null);
    assert.equal(result.verdict, "trusted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Verdict aggregation
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — verdict aggregation", () => {
  it("single warn flag → suspect", () => {
    const curr = se({
      discovered_constraints: ["must handle null"],
    });
    const prev = se({
      discovered_constraints: ["must handle null"],
    });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "suspect");
    assert.equal(result.flags.length, 1);
  });

  it("single error flag → contradicted", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        success_criteria_remaining: ["tests pass"],
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null);
    assert.equal(result.verdict, "contradicted");
    assert.equal(result.flags.length, 1);
  });

  it("multiple warn + one error → contradicted (error wins)", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: { passed: 3, failed: 0, skipped: 0 },
        success_criteria_remaining: ["tests pass"],
      }),
      discovered_constraints: ["must handle null"],
    });
    const prev = se({
      discovered_constraints: ["must handle null"],
    });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "contradicted");
    // Should have both the warn and error flags
    assert.ok(result.flags.length >= 2);
  });

  it("all checks pass → trusted", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: { passed: 3, failed: 1, skipped: 0 },
        success_criteria_remaining: ["tests"],
        progress_estimate: 0.5,
      }),
      constraint_violations: ["minor"],
      discovered_constraints: ["unique constraint"],
    });
    const prev = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        progress_estimate: 0.3,
      }),
      constraint_violations: ["other"],
      discovered_constraints: ["different constraint"],
    });

    const result = verifySelfEvaluation(curr, 2, [], prev);
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });

  // ── v1.16: files_integrity check ──────────────────────────────────────────

  it("checkFilesIntegrity: flags mismatch when agent reports different files than git", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts", "src/bar.ts"],
        progress_estimate: 0.5,
      }),
    });
    // Git only detected src/foo.ts — agent falsely reported src/bar.ts
    const result = verifySelfEvaluation(curr, 2, [], null, ["src/foo.ts"]);
    assert.ok(result.flags.length >= 1);
    const flag = result.flags.find(f => f.check === "files_integrity");
    assert.ok(flag, "should have files_integrity flag");
    assert.equal(flag!.severity, "warn");
    assert.ok(flag!.detail.includes("src/bar.ts"), "should mention ghost file");
  });

  it("checkFilesIntegrity: flags when agent says no files but git shows changes", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        progress_estimate: 0.5,
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null, ["src/real.ts"]);
    assert.ok(result.flags.length >= 1);
    const flag = result.flags.find(f => f.check === "files_integrity");
    assert.ok(flag, "should flag when agent reports empty but git shows files");
  });

  it("checkFilesIntegrity: no flag when both are empty", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        progress_estimate: 0.5,
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null, []);
    const flag = result.flags.find(f => f.check === "files_integrity");
    assert.equal(flag, undefined, "should not flag when both empty");
  });

  it("checkFilesIntegrity: no flag when git is unavailable (null)", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        progress_estimate: 0.5,
      }),
    });
    // null = git unavailable, should skip check entirely
    const result = verifySelfEvaluation(curr, 2, [], null, null);
    const flag = result.flags.find(f => f.check === "files_integrity");
    assert.equal(flag, undefined, "should not flag when git unavailable");
  });

  it("checkFilesIntegrity: no flag when reported matches git exactly", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts", "src/b.ts"],
        progress_estimate: 0.5,
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null, ["src/a.ts", "src/b.ts"]);
    const flag = result.flags.find(f => f.check === "files_integrity");
    assert.equal(flag, undefined, "should not flag when files match");
  });
});
