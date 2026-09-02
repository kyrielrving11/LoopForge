/** Tests for verification-gate — Layer 1 cross-round consistency checks. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  makeExecutionEvidence,
  makeSelfEvaluation,
  type SelfEvaluation,
  type VerificationFlag,
} from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";
import { verifySelfEvaluation as rawVerifySelfEvaluation, parseTestOutput, deriveEvidenceStatus, machineProgressSeries, hasNewCriteriaCompletion, CHECK_SUCCESS_UNVERIFIED, CHECK_VERIFICATION_ENTRYPOINT_MODIFIED, CHECK_TEST_FILES_MODIFIED, CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE } from "../verification-gate.js";
import type { ProviderSnapshot } from "../evidence-provider.js";
import { computeGoalTextHash, deriveCriterionId } from "../loop-compiler.js";
import { resetPolicy, getPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";
import type { RoundContract } from "../protocol.js";
import {
  CHECK_ROUND_UNDERSPECIFIED,
  CHECK_ROUND_UNVERIFIABLE,
  CHECK_ROUND_SCOPE_DRIFT,
  CHECK_PREMATURE_BOUNDARY,
  normalizeScopeEntry,
  isFileInScope,
  collectOutOfScopeFiles,
} from "../verification-gate.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Build a minimal SelfEvaluation for testing. The default fixture carries
 *  machine-verifiable test evidence so the v2.12 success_without_verified_
 *  evidence check stays silent unless a test explicitly removes it. */
/** v3.2: A verified git snapshot (machine observation present) — keeps the
 *  success_unverified check silent in tests that assert "no flag" outcomes. */
function gitSnap(files: string[] = ["src/a.ts"]): ProviderSnapshot {
  return {
    provider: "git",
    timestamp: Date.now(),
    files,
    data: { tracked: files, staged: [], untracked: [], fingerprints: {} },
  };
}

function se(overrides: Partial<SelfEvaluation> = {}): SelfEvaluation {
  return makeSelfEvaluation({
    success: true,
    output_summary: "Task completed.",
    constraint_violations: [],
    should_continue: true,
    execution_evidence: makeExecutionEvidence({
      files_changed: ["src/a.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: ["criterion A"],
      success_criteria_remaining: [],
      progress_estimate: 0.5,
    }),
    ...overrides,
  });
}

/** v3.2: A passed/failed after-phase command snapshot. The default stdout
 *  parses to {passed: 1, failed: 0} — matches the se() fixture's
 *  test_results so count-comparison checks stay silent. */
function cmdSnap(
  status: "passed" | "failed",
  overrides: Partial<ProviderSnapshot["data"]> = {},
): ProviderSnapshot {
  return {
    provider: "command:test",
    timestamp: Date.now(),
    files: [],
    data: {
      kind: "command",
      commandName: "test",
      required: false,
      phase: "after",
      status,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 100,
      stdout: status === "passed" ? "Tests: 1 passed, 1 total" : "Tests: 0 passed, 1 failed",
      stderr: "",
      truncated: false,
      entrypointFiles: [],
      ...overrides,
    },
  };
}

/** v3.3: A verified evidence pair — git observation plus a passed command.
 *  Success claims with self-reported test_results alone are no longer
 *  machine evidence (R8 required by default), so tests that assert unrelated
 *  checks must pass a passed command snapshot. */
function verifiedEvidence(files: string[] = ["src/a.ts"]): ProviderSnapshot[] {
  return [gitSnap(files), cmdSnap("passed")];
}

/** v3.3: Local wrapper with a passed command snapshot by default — keeps the
 *  ~50 call sites that test unrelated checks silent on R8 / success_unverified.
 *  Tests that deliberately exercise "no machine evidence" behavior pass an
 *  explicit [] or git-only evidence. */
function verifySelfEvaluation(
  selfEval: SelfEvaluation,
  currentRound: number,
  vaultEntries: VaultEntry[] = [],
  prevSelfEval: SelfEvaluation | null = null,
  evidenceSnapshots: ProviderSnapshot[] = [cmdSnap("passed")],
  backtrackSkippedFiles: string[] = [],
  backtrackTargetGitHead?: string,
): ReturnType<typeof rawVerifySelfEvaluation> {
  return rawVerifySelfEvaluation(
    selfEval,
    currentRound,
    vaultEntries,
    prevSelfEval,
    evidenceSnapshots,
    backtrackSkippedFiles,
    backtrackTargetGitHead,
  );
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
        test_results: { passed: 3, failed: 0, skipped: 0 },
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
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["impl", "tests"],
        progress_estimate: 0.3,
      }),
      constraint_violations: ["missing docs"],
      discovered_constraints: ["must use async"],
    });

    const vault = [vaultRound(1, ["missing docs"])];

    // A passed command with matching counts keeps criteria_claims_unverified,
    // command_evidence_mismatch, R8 and success_unverified all silent
    // (v3.3: self-reported test_results alone are no longer machine evidence).
    const result = verifySelfEvaluation(curr, 2, vault, prev,
      [cmdSnap("passed", { stdout: "Tests: 3 passed, 3 total" })]);
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });

  it("trusted verdict for first round (no previous data)", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        progress_estimate: 0.0,
        test_results: { passed: 1, failed: 0, skipped: 0 },
        files_changed: ["src/a.ts"],
      }),
    });

    const result = verifySelfEvaluation(curr, 1, [], null, [gitSnap(), cmdSnap("passed")]);
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
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.3, test_results: { passed: 1, failed: 0, skipped: 0 }, files_changed: ["src/a.ts"] }),
    });
    const prev = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.8, test_results: { passed: 1, failed: 0, skipped: 0 }, files_changed: ["src/a.ts"] }),
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
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.6, test_results: { passed: 1, failed: 0, skipped: 0 }, files_changed: ["src/a.ts"] }),
    });
    const prev = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.8, test_results: { passed: 1, failed: 0, skipped: 0 }, files_changed: ["src/a.ts"] }),
    });

    const result = verifySelfEvaluation(curr, 2, [], prev, [gitSnap(), cmdSnap("passed")]);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when estimate increases", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.9, test_results: { passed: 1, failed: 0, skipped: 0 }, files_changed: ["src/a.ts"] }),
    });
    const prev = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.5, test_results: { passed: 1, failed: 0, skipped: 0 }, files_changed: ["src/a.ts"] }),
    });

    const result = verifySelfEvaluation(curr, 2, [], prev, [gitSnap(), cmdSnap("passed")]);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when no previous execution evidence", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({ progress_estimate: 0.3, test_results: { passed: 1, failed: 0, skipped: 0 }, files_changed: ["src/a.ts"] }),
    });
    const prev = se({ execution_evidence: undefined });

    const result = verifySelfEvaluation(curr, 2, [], prev, [gitSnap(), cmdSnap("passed")]);
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

    // Command stdout must agree with the reported counts, or the
    // command_evidence_mismatch warn fires and the verdict leaves trusted.
    const result = verifySelfEvaluation(curr, 2, [], null,
      [gitSnap([]), cmdSnap("passed", { stdout: "Tests: 3 passed, 1 failed" })]);
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

    const result = verifySelfEvaluation(curr, 2, [], null,
      [gitSnap([]), cmdSnap("passed", { stdout: "Tests: 5 passed, 5 total" })]);
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
        test_results: { passed: 1, failed: 0, skipped: 0 },
        files_changed: ["src/a.ts"],
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null, [gitSnap(), cmdSnap("passed")]);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when success is false even with remaining criteria", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        success_criteria_remaining: ["tests pass"],
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null, [gitSnap([]), cmdSnap("passed")]);
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

    const result = verifySelfEvaluation(curr, 2, [], prev, [gitSnap(), cmdSnap("passed")]);
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

    const result = verifySelfEvaluation(curr, 3, [], prev, [gitSnap(), cmdSnap("passed")]);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when no previous round exists", () => {
    const curr = se({
      retracted_constraints: ["some constraint"],
    });

    const result = verifySelfEvaluation(curr, 1, [], null, [gitSnap(), cmdSnap("passed")]);
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

    const result = verifySelfEvaluation(curr, 2, [], prev, [gitSnap(), cmdSnap("passed")]);
    assert.equal(result.verdict, "suspect");
    assert.equal(result.flags.length, 1);
  });

  it("single error flag → contradicted", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        success_criteria_remaining: ["tests pass"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        files_changed: ["src/a.ts"],
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null, [gitSnap(), cmdSnap("passed")]);
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

    const result = verifySelfEvaluation(curr, 2, [], prev,
      [gitSnap(["src/foo.ts"]), cmdSnap("passed", { stdout: "Tests: 3 passed, 1 failed" })]);
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// parseTestOutput — unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe("parseTestOutput", () => {
  it("parses Jest verbose: Tests: 1 failed, 8 passed, 9 total", () => {
    const result = parseTestOutput("Tests: 1 failed, 8 passed, 9 total");
    assert.deepEqual(result, { passed: 8, failed: 1, skipped: 0, total: 9 });
  });

  it("parses Jest compact: Tests: 8 passed, 9 total", () => {
    const result = parseTestOutput("Tests: 8 passed, 9 total");
    assert.deepEqual(result, { passed: 8, failed: 1, skipped: 0, total: 9 });
  });

  it("parses Mocha: 8 passing, 2 failing", () => {
    const result = parseTestOutput("  8 passing (2s)\n  2 failing\n");
    assert.deepEqual(result, { passed: 8, failed: 2, skipped: 0, total: 10 });
  });

  it("parses Mocha: 15 passing only (no failures)", () => {
    const result = parseTestOutput("  15 passing (3s)\n");
    assert.deepEqual(result, { passed: 15, failed: 0, skipped: 0, total: 15 });
  });

  it("parses Go test: --- PASS / --- FAIL lines", () => {
    const stdout = "--- PASS: TestFoo (0.01s)\n--- PASS: TestBar (0.02s)\n--- FAIL: TestBaz (0.01s)\n";
    const result = parseTestOutput(stdout);
    assert.deepEqual(result, { passed: 2, failed: 1, skipped: 0, total: 3 });
  });

  it("parses Go test: all pass", () => {
    const stdout = "--- PASS: TestA\n--- PASS: TestB\n--- PASS: TestC\nok  example.com/pkg  0.123s\n";
    const result = parseTestOutput(stdout);
    assert.deepEqual(result, { passed: 3, failed: 0, skipped: 0, total: 3 });
  });

  it("parses pytest: 8 passed, 1 failed", () => {
    const result = parseTestOutput("======= 8 passed, 1 failed in 2.34s =======");
    assert.deepEqual(result, { passed: 8, failed: 1, skipped: 0, total: 9 });
  });

  it("parses pytest: 42 passed", () => {
    const result = parseTestOutput("============ test session starts ============\n42 passed in 5.12s");
    assert.deepEqual(result, { passed: 42, failed: 0, skipped: 0, total: 42 });
  });

  it("parses PHPUnit: OK (8 tests, 16 assertions)", () => {
    const result = parseTestOutput("OK (8 tests, 16 assertions)");
    assert.deepEqual(result, { passed: 8, failed: 0, skipped: 0, total: 8 });
  });

  it("returns null for unrecognized output", () => {
    const result = parseTestOutput("Build completed successfully.");
    assert.equal(result, null);
  });

  it("returns null for empty string", () => {
    const result = parseTestOutput("");
    assert.equal(result, null);
  });

  it("scans only last 2000 characters for summary", () => {
    const prefix = "x".repeat(3000);
    const result = parseTestOutput(prefix + "\nTests: 3 passed, 3 total");
    assert.deepEqual(result, { passed: 3, failed: 0, skipped: 0, total: 3 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// checkCommandEvidenceIntegrity — via verifySelfEvaluation
// ═══════════════════════════════════════════════════════════════════════════

/** Build a minimal command evidence snapshot for testing. */
function cmdSnapshot(overrides: Record<string, unknown> = {}): ProviderSnapshot {
  return {
    provider: "command:test",
    timestamp: Date.now(),
    files: [],
    data: {
      kind: "command",
      commandName: "test",
      required: false,
      phase: "after",
      status: "passed",
      exitCode: 0,
      signal: null,
      durationMs: 100,
      stdout: "",
      stderr: "",
      truncated: false,
      ...overrides,
    },
  };
}

describe("verification-gate — command evidence integrity", () => {
  it("no flag when test counts match exactly", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({ stdout: "Tests: 1 failed, 8 passed, 9 total" });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should not flag when counts match");
  });

  it("warn when passed counts differ", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: { passed: 10, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({ stdout: "Tests: 1 failed, 8 passed, 9 total" });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.ok(flag, "should flag mismatch");
    assert.equal(flag!.severity, "warn");
    assert.ok(flag!.detail.includes("reported 10"), "should mention reported count");
    assert.ok(flag!.detail.includes("shows 8"), "should mention command count");
  });

  it("error when agent reports 0 failed but command shows failures", () => {
    const curr = se({
      success: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: { passed: 8, failed: 0, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({ stdout: "Tests: 2 failed, 8 passed, 10 total" });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.ok(flag, "should flag hidden failures");
    assert.equal(flag!.severity, "error");
  });

  it("no flag when agent has no test_results", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/foo.ts"],
        test_results: null,
      }),
    });
    const snap = cmdSnapshot({ stdout: "Tests: 1 failed, 8 passed, 9 total" });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip when no test_results reported");
  });

  it("no flag when command output is truncated", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        test_results: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({
      stdout: "Tests: 1 failed, 8 passed, 9 total",
      truncated: true,
    });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip when output is truncated");
  });

  it("no flag when command status is not passed", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        test_results: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({
      stdout: "Tests: 1 failed, 8 passed, 9 total",
      status: "failed",
      exitCode: 1,
    });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip non-passed commands");
  });

  it("no flag for non-command evidence providers", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        test_results: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    // A non-command provider (e.g. a hypothetical coverage provider)
    const snap: ProviderSnapshot = {
      provider: "coverage",
      timestamp: Date.now(),
      files: [],
      data: { kind: "coverage", coverage: 0.8 },
    };
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip non-command providers");
  });

  it("no flag when command output is unparseable", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        test_results: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({ stdout: "All checks passed! ✨" });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip unparseable output");
  });

  it("no flag with empty evidence snapshots", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        test_results: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null, []);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip when no snapshots");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.1: Intent-action drift detection
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — intent-action drift", () => {
  it("no flag when next_action and output_summary are semantically similar", () => {
    const prev = se({ next_action: "Refactor the authentication module" });
    const curr = se({ output_summary: "Refactored the authentication module — extracted middleware, updated tests" });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "should not flag when intent matches action");
  });

  it("warn flag when next_action is completely unrelated to output_summary", () => {
    const prev = se({ next_action: "Refactor the authentication module" });
    const curr = se({ output_summary: "Fixed CSS padding on login button and adjusted margins" });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.ok(flag, "should flag intent-action drift");
    assert.equal(flag.severity, "warn");
    assert.ok(flag.detail.includes("intent"), "detail should mention declared intent");
    assert.ok(flag.detail.includes("similarity"), "detail should include similarity score");
  });

  it("no flag when prevSelfEval is null (round 1 has no prior intent)", () => {
    const curr = se({ output_summary: "Fixed CSS padding" });
    const result = verifySelfEvaluation(curr, 1, [], null);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "should not flag without previous self-eval");
  });

  it("no flag when next_action is empty string", () => {
    const prev = se({ next_action: "" });
    const curr = se({ output_summary: "Fixed CSS padding" });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "should not flag when intent is empty");
  });

  it("no flag when output_summary is empty", () => {
    const prev = se({ next_action: "Refactor auth module" });
    const curr = se({ output_summary: "" });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "should not flag when summary is empty");
  });

  it("no flag when next_action is undefined", () => {
    const prev = se({ next_action: undefined });
    const curr = se({ output_summary: "Fixed CSS padding" });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "should not flag when intent is undefined");
  });

  it("verdict is suspect when intent drift is the only flag", () => {
    const prev = se({ next_action: "Refactor auth" });
    const curr = se({ output_summary: "Fixed CSS padding" });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    assert.equal(result.verdict, "suspect", "intent_drift is a warn-level flag");
  });

  // ── v2.14: structured-ID-first alignment signals ─────────────────────────

  it("no flag when completed_subtasks carries the referenced sub-goal ID (even with 12% similarity)", () => {
    const prev = se({
      next_action: "Complete sg-bfebcdd7 — segmentation, idempotency, and state machine tests",
    });
    const curr = se({
      output_summary:
        "Implemented three test suites covering chunk-boundary segmentation, " +
        "idempotent rerun assertions, and state machine transition tables",
      completed_subtasks: ["sg-bfebcdd7"],
    });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "sub-goal ID completion is intent alignment, not drift");
  });

  it("no flag when a completed_subtask description derives the referenced sub-goal ID", () => {
    const desc = "Add segmentation tests for chunk boundaries";
    const sgId = "sg-" + computeGoalTextHash(desc).slice(0, 8);
    const prev = se({
      next_action: `Complete ${sgId} — segmentation, idempotency, and state machine tests`,
    });
    const curr = se({
      output_summary: "Implemented chunk-boundary coverage across three suites",
      completed_subtasks: [desc],
    });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "description text matching the ID's hash is alignment");
  });

  it("no flag when a completed_subtask paraphrases the referenced sub-goal description", () => {
    const desc = "Add idempotency guards for the payment flow";
    const sgId = "sg-" + computeGoalTextHash(desc).slice(0, 8);
    const prev = se({
      next_action: `Work on ${sgId}`,
      emerged_subtasks: [desc],
    });
    const curr = se({
      output_summary: "Billed double charges on retry",
      completed_subtasks: ["Adding idempotency guards for payment flow"],
    });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "paraphrased completion above the match threshold is alignment");
  });

  it("still flags when the referenced sub-goal ID was not completed", () => {
    const prev = se({
      next_action: "Complete sg-aaaa1111 — parser rewrite",
    });
    const curr = se({
      output_summary: "Rewrote the scheduler from scratch",
      completed_subtasks: ["Rewrote the scheduler"],
    });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.ok(flag, "uncompleted referenced sub-goal is genuine drift");
    assert.ok(
      flag.detail.includes("did not match completed_subtasks"),
      "detail should report the unmatched sub-goal ID",
    );
  });

  it("no flag when a file path named in next_action appears in files_changed", () => {
    const prev = se({ next_action: "Refactor src/auth/login.ts" });
    const curr = se({
      output_summary: "Adjusted the login flow",
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/auth/login.ts"],
      }),
    });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "file-path evidence is alignment");
  });

  it("no flag when intent mentions tests and test files changed with tests run", () => {
    const prev = se({ next_action: "Write unit tests for the auth module" });
    const curr = se({
      output_summary: "Covered authentication logic",
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/auth/login.test.ts"],
        test_results: { passed: 12, failed: 0, skipped: 0 },
      }),
    });
    const result = verifySelfEvaluation(curr, 3, [], prev);
    const flag = result.flags.find(f => f.check === "intent_drift");
    assert.equal(flag, undefined, "test-file evidence with passing counts is alignment");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.2 / v2.14: Sub-goal drift — stable ID alignment first
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — sub-goal drift ID alignment", () => {
  const sgA = "Add error handling to login";
  const sgB = "Write API integration tests";
  const sgC = "Refactor database layer";
  const idA = "sg-" + computeGoalTextHash(sgA).slice(0, 8);

  function vaultWithSubGoals(): VaultEntry[] {
    return [
      { ...vaultRound(2), emerged_subtasks: [sgA, sgB, sgC] },
    ];
  }

  it("no flag when next_action references a pending sub-goal by ID", () => {
    const curr = se({ next_action: `Finish ${idA} with regression coverage` });
    const result = verifySelfEvaluation(curr, 3, vaultWithSubGoals(), null);
    const flag = result.flags.find(f => f.check === "subgoal_drift");
    assert.equal(flag, undefined, "ID reference to a pending sub-goal is aligned by definition");
  });

  it("still flags when next_action aligns with no pending sub-goal", () => {
    const curr = se({ next_action: "Investigate CI flakiness" });
    const result = verifySelfEvaluation(curr, 3, vaultWithSubGoals(), null);
    const flag = result.flags.find(f => f.check === "subgoal_drift");
    assert.ok(flag, "unrelated next_action should still flag sub-goal drift");
    assert.equal(flag.severity, "warn");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.13: Backtrack workspace restore check
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — backtrack workspace restore", () => {
  function se(overrides: Partial<SelfEvaluation> = {}): SelfEvaluation {
    return makeSelfEvaluation({
      success: false,
      output_summary: "Worked on feature",
      should_continue: true,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/new-feature.ts"],
        progress_estimate: 0.5,
      }),
      ...overrides,
    });
  }

  it("no flag when backtrackSkippedFiles is empty", () => {
    const result = verifySelfEvaluation(
      se({ execution_evidence: makeExecutionEvidence({
        files_changed: ["src/auth.ts"],
      })}),
      3, [], null, [], [],
    );
    const flag = result.flags.find(
      (f) => f.check === "backtrack_workspace_not_restored",
    );
    assert.equal(flag, undefined,
      "should not flag when no backtrack skipped files");
  });

  it("no flag when files_changed has no overlap with skipped files", () => {
    const result = verifySelfEvaluation(
      se({ execution_evidence: makeExecutionEvidence({
        files_changed: ["src/auth.ts"],
      })}),
      3, [], null, [],
      ["src/old-feature.ts", "tests/old.test.ts"],
    );
    const flag = result.flags.find(
      (f) => f.check === "backtrack_workspace_not_restored",
    );
    assert.equal(flag, undefined,
      "should not flag when agent works on different files");
  });

  it("warns when files_changed has minor overlap with skipped files", () => {
    const result = verifySelfEvaluation(
      se({ execution_evidence: makeExecutionEvidence({
        files_changed: ["src/auth.ts", "src/new.ts"],
      })}),
      3, [], null, [],
      ["src/auth.ts", "lib/old.go"],
    );
    const flag = result.flags.find(
      (f) => f.check === "backtrack_workspace_not_restored",
    );
    assert.ok(flag, "should flag minor overlap");
    assert.equal(flag.severity, "warn",
      "minor overlap (1-2 files) should be a warning");
  });

  it("errors when files_changed has significant overlap (>= 3 files)", () => {
    const result = verifySelfEvaluation(
      se({ execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts", "src/b.ts", "src/c.ts"],
      })}),
      3, [], null, [],
      ["src/a.ts", "src/b.ts", "src/c.ts", "lib/x.go"],
    );
    const flag = result.flags.find(
      (f) => f.check === "backtrack_workspace_not_restored",
    );
    assert.ok(flag, "should flag significant overlap");
    assert.equal(flag.severity, "error",
      ">= 3 overlapping files should be an error");
  });

  it("errors when ALL files_changed overlap with skipped files", () => {
    const result = verifySelfEvaluation(
      se({ execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts", "src/b.ts"],
      })}),
      3, [], null, [],
      ["src/a.ts", "src/b.ts"],
    );
    const flag = result.flags.find(
      (f) => f.check === "backtrack_workspace_not_restored",
    );
    assert.ok(flag, "should flag when all files overlap");
    assert.equal(flag.severity, "error",
      "100% overlap should be an error");
  });

  it("no flag when execution_evidence is absent", () => {
    const result = verifySelfEvaluation(
      se({ execution_evidence: undefined }),
      3, [], null, [],
      ["src/auth.ts"],
    );
    const flag = result.flags.find(
      (f) => f.check === "backtrack_workspace_not_restored",
    );
    assert.equal(flag, undefined,
      "should not flag when no execution evidence");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: Tri-state outcome consistency + retroactive claims
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — v2.12 outcome consistency", () => {
  it("suppresses success-class checks when outcome=partial even with success=true", () => {
    // success=true + outcome=partial + remaining criteria: the declared
    // outcome wins, so success_with_remaining_criteria must NOT fire.
    const curr = se({
      success: true,
      outcome: "partial",
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["tests pass"],
        progress_estimate: 0.5,
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    // outcome wins: the success-class check must not fire; the declared
    // non-success vs legacy success=true does produce a warn conflict flag.
    assert.ok(!result.flags.some((f) => f.check === "success_with_remaining_criteria"));
    assert.ok(result.flags.some((f) => f.check === "success_claim_conflict"));
    assert.equal(result.verdict, "suspect");
  });

  it("errors when outcome=success but success=false (self-contradiction)", () => {
    const curr = se({
      success: false,
      outcome: "success",
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.equal(result.verdict, "contradicted");
    assert.ok(result.flags.some((f) => f.check === "outcome_success_contradiction"));
  });

  it("warns when outcome=failed but success=true (compat conflict)", () => {
    const curr = se({
      success: true,
      outcome: "failed",
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.equal(result.verdict, "suspect");
    assert.ok(result.flags.some((f) => f.check === "success_claim_conflict"));
  });

  it("warns when outcome=blocked without a blocker description", () => {
    const curr = se({
      success: false,
      outcome: "blocked",
      should_continue: false,
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.ok(result.flags.some((f) => f.check === "blocked_without_blocker"));
  });

  it("warns on retroactive claims targeting a non-prior round", () => {
    const curr = se({
      retroactiveClaims: [{ round: 0, claim: "fixed in round 0" }],
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.ok(result.flags.some((f) => f.check === "retroactive_claim_bad_round"));
  });

  it("flags EVERY offending retroactive claim, not just the first (v3.3.1)", () => {
    // Regression: checkRetroactiveClaims collected one flag per problem but
    // returned only flags[0] — a submission with several bad claims showed
    // the agent just one until the next round.
    const curr = se({
      retroactiveClaims: [
        { round: 9, claim: "fixed in future round" },
        { round: 0, claim: "fixed in round zero" },
        { round: 8, claim: "claims a later round again" },
      ],
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    const badRound = result.flags.filter((f) => f.check === "retroactive_claim_bad_round");
    assert.equal(badRound.length, 3,
      "each offending claim must produce its own flag, got " + badRound.length);
    assert.equal(result.verdict, "suspect");
  });

  it("does not flag retroactive claims whose files are all observed", () => {
    const vault = [{
      ...vaultRound(1),
      task_id: "loop:test-loop:r1:feedback",
      loop_lineage: {
        round: 1,
        round_transaction: {
          schema_version: 1,
          round_id: "loop:test-loop:round:1",
          snapshot: {
            schemaVersion: 1,
            roundId: "loop:test-loop:round:1",
            loopId: "test-loop",
            round: 1,
            attempt: 1,
            phase: "committed" as const,
            beforeEvidence: [],
            afterEvidence: [{
              provider: "git",
              timestamp: Date.now(),
              files: ["src/fixed.ts"],
              data: { head: "abc" },
            }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          result: { action: "continue", verificationFlags: [] },
        },
      },
    }];
    const curr = se({
      retroactiveClaims: [{ round: 1, claim: "fixed src/fixed.ts in round 1" }],
    });
    const result = verifySelfEvaluation(curr, 2, vault, null);
    assert.ok(!result.flags.some((f) => f.check.startsWith("retroactive_claim")));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: Unverified criteria claims (mild criterion-specific rule)
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — v2.12 unverified criteria claims", () => {
  it("warns when criteria are met but none machine-verified", () => {
    const curr = se({
      success: false,
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: null,
        success_criteria_met: ["tests pass", "docs updated"],
        success_criteria_remaining: [],
        progress_estimate: 0.5,
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    const flag = result.flags.find((f) => f.check === "criteria_claims_unverified");
    assert.ok(flag);
    assert.equal(flag.severity, "warn");
  });

  it("stays silent when test evidence backs the claims", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: { passed: 4, failed: 0, skipped: 0 },
        success_criteria_met: ["tests pass"],
        success_criteria_remaining: [],
        progress_estimate: 0.8,
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.ok(!result.flags.some((f) => f.check === "criteria_claims_unverified"));
  });

  it("stays silent when no criteria are reported met", () => {
    const curr = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: null,
        success_criteria_met: [],
        success_criteria_remaining: ["tests pass"],
        progress_estimate: 0.3,
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.ok(!result.flags.some((f) => f.check === "criteria_claims_unverified"));
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — runtime evidence status + success_unverified
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — deriveEvidenceStatus", () => {
  it("git diff observed but no passed command → unavailable (v3.3)", () => {
    const status = deriveEvidenceStatus(se(), [gitSnap(["src/a.ts"])]);
    assert.equal(status.providerStatus, "unavailable");
    assert.equal(status.gitObserved, true);
    assert.equal(status.reportedFilesMatch, true);
  });

  it("git snapshot present but no changes → unavailable", () => {
    const status = deriveEvidenceStatus(se(), [gitSnap([])]);
    assert.equal(status.providerStatus, "unavailable");
    assert.equal(status.gitObserved, false);
  });

  it("no snapshots → absent", () => {
    const status = deriveEvidenceStatus(se(), []);
    assert.equal(status.providerStatus, "absent");
  });

  it("passed after-command → verified, testsMachineBacked when counts agree", () => {
    const selfEval = se({
      execution_evidence: makeExecutionEvidence({
        files_changed: [],
        test_results: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const status = deriveEvidenceStatus(selfEval, [cmdSnap("passed")]);
    assert.equal(status.providerStatus, "verified");
    assert.equal(status.commandVerified, true);
    assert.equal(status.testsMachineBacked, true);
  });

  it("failed after-command → unavailable, testsMachineBacked false", () => {
    const status = deriveEvidenceStatus(se(), [cmdSnap("failed")]);
    assert.equal(status.providerStatus, "unavailable");
    assert.equal(status.testsMachineBacked, false);
  });
});

describe("v3.2 — success_unverified check", () => {
  const hasUnverified = (result: { flags: VerificationFlag[] }): boolean =>
    result.flags.some((f) => f.check === CHECK_SUCCESS_UNVERIFIED && f.severity === "warn");

  it("flags success with no machine observation (absent)", () => {
    // v3.3: with machine_backed_success=required, R8 also fires (error) —
    // the verdict is contradicted, but the unverified warn is still present.
    const result = verifySelfEvaluation(se(), 2, [], null, []);
    assert.ok(hasUnverified(result), "absent provider must flag unverified success");
    assert.equal(result.verdict, "contradicted");
  });

  it("flags success with an observation-less snapshot (unavailable)", () => {
    const result = verifySelfEvaluation(se(), 2, [], null, [gitSnap([])]);
    assert.ok(hasUnverified(result));
  });

  it("stays silent when a passed after-command backs the success (verified)", () => {
    const result = verifySelfEvaluation(se(), 2, [], null, [cmdSnap("passed")]);
    assert.ok(!hasUnverified(result));
  });

  it("flags git-only observation as unverified (v3.3)", () => {
    const result = verifySelfEvaluation(se(), 2, [], null, [gitSnap(["src/a.ts"])]);
    assert.ok(hasUnverified(result), "git-only must not count as machine verification");
  });

  it("stays silent with a declared no_change_reason", () => {
    const result = verifySelfEvaluation(se({ no_change_reason: "docs-only round" }), 2, [], null);
    assert.ok(!hasUnverified(result));
  });

  it("stays silent when success is false", () => {
    const result = verifySelfEvaluation(se({ success: false }), 2, [], null);
    assert.ok(!hasUnverified(result));
  });

  it("does not alter the contradicted verdict", () => {
    const result = verifySelfEvaluation(se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: [],
        success_criteria_remaining: ["still open"],
      }),
    }), 2, [], null, [gitSnap(["src/a.ts"])]);
    assert.equal(result.verdict, "contradicted"); // success_with_remaining_criteria error
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — machineProgressSeries (R4/R5 heuristic-path fallback)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — machineProgressSeries", () => {
  const feedbackRound = (round: number, gitFiles: string[]): VaultEntry => ({
    task_id: `loop:mp:r${round}:feedback`,
    loop_id: "mp",
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: 1,
        round_id: `loop:mp:round:${round}`,
        snapshot: {
          schemaVersion: 1,
          roundId: `loop:mp:round:${round}`,
          loopId: "mp",
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

  it("reports per-round git observations for the lookback window", () => {
    const series = machineProgressSeries(
      [feedbackRound(1, ["a.ts"]), feedbackRound(2, []), feedbackRound(3, ["b.ts"])],
      4,
      3,
    );
    assert.deepEqual(series, [true, false, true]);
  });

  it("returns null when fewer than lookback rounds carry git snapshots", () => {
    const series = machineProgressSeries(
      [feedbackRound(1, []), feedbackRound(2, [])],
      4,
      3,
    );
    assert.equal(series, null);
  });

  it("returns null when the recent rounds are not contiguous (unknown motion)", () => {
    const series = machineProgressSeries(
      [feedbackRound(1, []), feedbackRound(3, [])],
      4,
      2,
    );
    assert.equal(series, null);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — machine_backed_success policy switch (R8 severity)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — machine_backed_success switch", () => {
  afterEach(() => resetPolicy());

  // Fabricated success: files changed + self-reported passing tests, no
  // command snapshot — the v3.3 attack the tightening closes.
  const fabricated = (): SelfEvaluation => se({
    execution_evidence: makeExecutionEvidence({
      files_changed: ["src/a.ts"],
      test_results: { passed: 5, failed: 0, skipped: 0 },
      success_criteria_met: ["tests pass"],
      success_criteria_remaining: [],
      progress_estimate: 0.9,
    }),
  });

  it("required (default): fabricated success is an R8 error", () => {
    const result = verifySelfEvaluation(fabricated(), 2, [], null, [gitSnap(["src/a.ts"])]);
    const flag = result.flags.find((f) => f.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE);
    assert.ok(flag, "R8 flag must fire");
    assert.equal(flag!.severity, "error");
    assert.equal(result.verdict, "contradicted");
  });

  it("warn: fabricated success downgrades to a warn and keeps the verdict suspect", () => {
    resetPolicy();
    getPolicy().evidence.machine_backed_success = "warn";
    const result = verifySelfEvaluation(fabricated(), 2, [], null, [gitSnap(["src/a.ts"])]);
    const flag = result.flags.find((f) => f.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE);
    assert.ok(flag, "R8 flag must fire");
    assert.equal(flag!.severity, "warn");
    assert.equal(result.verdict, "suspect");
  });

  it("a passed command still satisfies the claim in both modes", () => {
    const result = verifySelfEvaluation(fabricated(), 2, [], null,
      [cmdSnap("passed", { stdout: "Tests: 5 passed, 5 total" })]);
    assert.ok(!result.flags.some((f) =>
      f.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE && f.severity === "error"));
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — verification domain integrity (entrypoint / test-file pollution)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — verification domain integrity", () => {
  it("entrypoint changed this round → error + command no longer verified", () => {
    const git = gitSnap(["run-tests.sh"]);
    const cmd = cmdSnap("passed", { entrypointFiles: ["run-tests.sh"] });
    const result = verifySelfEvaluation(se(), 2, [], null, [git, cmd]);
    const flag = result.flags.find((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED);
    assert.ok(flag, "entrypoint modification must be flagged");
    assert.equal(flag!.severity, "error");
    // The tainted command must not count as machine verification.
    const status = deriveEvidenceStatus(se(), [git, cmd]);
    assert.equal(status.providerStatus, "unavailable");
    assert.equal(status.commandVerified, false);
  });

  it("test files changed in the same round → warn, command stays usable", () => {
    const git = gitSnap(["src/a.test.ts"]);
    const cmd = cmdSnap("passed");
    const result = verifySelfEvaluation(se(), 2, [], null, [git, cmd]);
    const flag = result.flags.find((f) => f.check === CHECK_TEST_FILES_MODIFIED);
    assert.ok(flag, "test-file change must be flagged");
    assert.equal(flag!.severity, "warn");
    // TDD flow: the passed command still backs the success.
    const status = deriveEvidenceStatus(se(), [git, cmd]);
    assert.equal(status.providerStatus, "verified");
    assert.equal(status.commandVerified, true);
  });

  it("entrypoint untouched with test files changed → only the warn", () => {
    const git = gitSnap(["src/a.test.ts", "src/impl.ts"]);
    const cmd = cmdSnap("passed", { entrypointFiles: ["run-tests.sh"] });
    const result = verifySelfEvaluation(se(), 2, [], null, [git, cmd]);
    assert.ok(!result.flags.some((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED));
    assert.ok(result.flags.some((f) => f.check === CHECK_TEST_FILES_MODIFIED));
  });

  it("command without resolvable entrypoint → fail open", () => {
    const git = gitSnap(["src/impl.ts"]);
    const cmd = cmdSnap("passed", { entrypointFiles: [] });
    const result = verifySelfEvaluation(se(), 2, [], null, [git, cmd]);
    assert.ok(!result.flags.some((f) =>
      f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED ||
      f.check === CHECK_TEST_FILES_MODIFIED));
  });

  it("no git snapshot → fail open", () => {
    const cmd = cmdSnap("passed", { entrypointFiles: ["run-tests.sh"] });
    const result = verifySelfEvaluation(se(), 2, [], null, [cmd]);
    assert.ok(!result.flags.some((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — hasNewCriteriaCompletion (R4/R5 exculpatory signal)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — hasNewCriteriaCompletion", () => {
  const criteriaRound = (round: number, met: string[]): VaultEntry => ({
    task_id: `loop:mp:r${round}:feedback`,
    loop_id: "mp",
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: 1,
        round_id: `loop:mp:round:${round}`,
        snapshot: {
          schemaVersion: 1,
          roundId: `loop:mp:round:${round}`,
          loopId: "mp",
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: [],
          roundEvidence: [],
          createdAt: 0,
          updatedAt: 0,
        },
      },
    },
    execution_evidence: {
      files_changed: [],
      test_results: null,
      success_criteria_met: met,
      success_criteria_remaining: [],
      progress_estimate: 0.5,
    },
  });

  it("detects a newly met criterion inside the window between adjacent rounds", () => {
    const entries = [
      criteriaRound(1, []),
      criteriaRound(2, []),
      criteriaRound(3, ["auth module completed"]),
    ];
    assert.equal(hasNewCriteriaCompletion(entries, 4, 3), true);
  });

  it("returns false when no entries or no criteria data exist in the window", () => {
    assert.equal(hasNewCriteriaCompletion([], 4, 3), false);
    const entries = [criteriaRound(1, []), criteriaRound(2, []), criteriaRound(3, [])];
    assert.equal(hasNewCriteriaCompletion(entries, 4, 3), false);
  });

  it("does not count criteria first met before the window; ID-first matching dedups rewording", () => {
    // Criterion first met at round 1 — before the window [2, 4] — so later
    // repetitions (as text and as its derived cr-ID) must not count as new.
    const id = deriveCriterionId("auth module completed");
    const entries = [
      criteriaRound(1, ["auth module completed"]),
      criteriaRound(2, ["auth module completed"]),
      criteriaRound(3, [id]),
      criteriaRound(4, []),
    ];
    assert.equal(hasNewCriteriaCompletion(entries, 5, 3), false);
    // A genuinely new criterion inside the window still fires.
    const withNew = [...entries, criteriaRound(4, ["rate limiting added"])];
    assert.equal(hasNewCriteriaCompletion(withNew, 5, 3), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Round Contract checks
// ═══════════════════════════════════════════════════════════════════════════

describe("Round Contract checks (v3.3 proposal declaration + v3.4 active split)", () => {
  afterEach(() => resetPolicy());

  /** Default policy has empty evidence.commands → "run-tests" is NOT
   *  configured, which is what the round_unverifiable tests rely on. */
  const contract = (overrides: Partial<RoundContract> = {}): RoundContract => ({
    work_item: "Implement auth",
    done_when: ["criterion A"],
    verification_plan: ["run-tests"],
    scope: ["src/auth"],
    ...overrides,
  });

  const withRunTestsConfigured = (): void => {
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: {
        ...DEFAULT_POLICY.evidence,
        commands: [{
          name: "run-tests", enabled: true, executable: "node", args: ["test"],
          phase: "after", required: false, timeout_ms: 1000,
          max_output_chars: 1000, success_exit_codes: [0],
        }],
      },
    });
  };

  /** v3.4: A committed :feedback entry carrying a full round-transaction
   *  evaluation — the vault shape the ACTIVE-contract derivation reads.
   *  A contract passed here was PROPOSED at `round` and therefore becomes
   *  the ACTIVE contract for round+1 (declaration-round met claims never
   *  satisfy its own proposal). */
  function committedRound(
    round: number,
    opts: {
      contract?: RoundContract;
      outcome?: SelfEvaluation["outcome"];
      met?: string[];
      action?: string;
    } = {},
  ): VaultEntry {
    return {
      task_id: `loop:cc:r${round}:feedback`,
      loop_id: "cc",
      loop_lineage: {
        round,
        round_transaction: {
          schema_version: 1,
          round_id: `loop:cc:round:${round}`,
          snapshot: {
            schemaVersion: 1,
            roundId: `loop:cc:round:${round}`,
            loopId: "cc",
            round,
            attempt: 1,
            phase: "committed",
            beforeEvidence: [],
            roundEvidence: [],
            createdAt: 0,
            updatedAt: 0,
            evaluation: makeSelfEvaluation({
              success: false,
              output_summary: `Committed round ${round}.`,
              constraint_violations: [],
              should_continue: true,
              outcome: opts.outcome,
              round_contract: opts.contract,
              execution_evidence: makeExecutionEvidence({
                files_changed: [],
                test_results: { passed: 0, failed: 0, skipped: 0 },
                success_criteria_met: opts.met ?? [],
                success_criteria_remaining: [],
                progress_estimate: 0.2,
              }),
            }),
          },
          result: { action: opts.action ?? "continue" },
        },
      },
    };
  }

  it("round_underspecified: contract with empty done_when → warn", () => {
    const result = verifySelfEvaluation(
      se({ round_contract: contract({ done_when: [] }) }), 2);
    const flag = result.flags.find((f) => f.check === CHECK_ROUND_UNDERSPECIFIED);
    assert.ok(flag, "empty done_when must be flagged");
    assert.equal(flag!.severity, "warn");
  });

  it("round_unverifiable: empty verification_plan → warn", () => {
    const result = verifySelfEvaluation(
      se({ round_contract: contract({ verification_plan: [] }) }), 2);
    assert.ok(result.flags.some((f) =>
      f.check === CHECK_ROUND_UNVERIFIABLE && f.severity === "warn"));
  });

  it("round_unverifiable: command not configured → warn naming it", () => {
    const result = verifySelfEvaluation(
      se({ round_contract: contract({ verification_plan: ["run-tests"] }) }), 2);
    const flag = result.flags.find((f) => f.check === CHECK_ROUND_UNVERIFIABLE);
    assert.ok(flag);
    assert.match(flag!.detail, /run-tests/);
  });

  it("round_unverifiable: configured and enabled command passes", () => {
    withRunTestsConfigured();
    const result = verifySelfEvaluation(
      se({ round_contract: contract({ verification_plan: ["run-tests"] }) }), 2);
    assert.ok(!result.flags.some((f) => f.check === CHECK_ROUND_UNVERIFIABLE));
  });

  it("no contract → all four contract checks stay silent", () => {
    const result = verifySelfEvaluation(se(), 2);
    const checks = [
      CHECK_ROUND_UNDERSPECIFIED,
      CHECK_ROUND_UNVERIFIABLE,
      CHECK_ROUND_SCOPE_DRIFT,
      CHECK_PREMATURE_BOUNDARY,
    ];
    for (const check of checks) {
      assert.ok(!result.flags.some((f) => f.check === check), `${check} must stay silent`);
    }
  });

  // ── v3.4: Execution conformance targets the ACTIVE contract (committed
  // ── rounds), never the submission's own proposal. The eval under test is
  // ── round 2 executing under a contract proposed at round 1. ─────────────

  it("premature_boundary: active done_when claimed met with zero machine evidence → error", () => {
    // Round 2 executes under ACTIVE "criterion A"; success=true, "criterion
    // A" IS in success_criteria_met, but no passed command snapshot →
    // round-uniform claim model says unverified.
    const active = [committedRound(1, { contract: contract() })];
    const result = verifySelfEvaluation(
      se({ round_contract: contract() }), 2, active, null, []);
    const flag = result.flags.find((f) => f.check === CHECK_PREMATURE_BOUNDARY);
    assert.ok(flag, "met-without-evidence claim must be flagged");
    assert.equal(flag!.severity, "error");
    assert.match(flag!.detail, /criterion A/);
  });

  it("premature_boundary: same eval with NO active contract stays silent", () => {
    // Round 1 of the loop: the eval's round_contract is a PROPOSAL for the
    // NEXT round — nothing was executed under it, so claiming success while
    // proposing a contract must not fire premature_boundary (the v3.3
    // off-by-one noise this split removes). Success-class gates (R1,
    // success_unverified) police the claim instead.
    const result = verifySelfEvaluation(se({ round_contract: contract() }), 2, [], null, []);
    assert.ok(!result.flags.some((f) => f.check === CHECK_PREMATURE_BOUNDARY));
    assert.ok(!result.flags.some((f) => f.check === CHECK_ROUND_SCOPE_DRIFT));
  });

  it("premature_boundary: machine-verified met claims pass", () => {
    // Wrapper default injects a passed command snapshot → verifiedCount > 0.
    const active = [committedRound(1, { contract: contract() })];
    const result = verifySelfEvaluation(
      se({ round_contract: contract() }), 2, active);
    assert.ok(!result.flags.some((f) => f.check === CHECK_PREMATURE_BOUNDARY));
  });

  it("premature_boundary: active done_when silently dropped (neither met nor remaining) → error", () => {
    // "criterion B" (in the ACTIVE contract from round 1) is neither met
    // nor remaining in round 2's eval.
    const active = [committedRound(1, { contract: contract({ done_when: ["criterion A", "criterion B"] }) })];
    const result = verifySelfEvaluation(se({
      round_contract: contract({ done_when: ["criterion A", "criterion B"] }),
    }), 2, active);
    const flag = result.flags.find((f) => f.check === CHECK_PREMATURE_BOUNDARY);
    assert.ok(flag);
    assert.match(flag!.detail, /criterion B/);
  });

  it("premature_boundary: honest remaining listing does not double-flag (R1's domain)", () => {
    const active = [committedRound(1, { contract: contract({ done_when: ["criterion A", "criterion B"] }) })];
    const result = verifySelfEvaluation(se({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        success_criteria_met: ["criterion A"],
        success_criteria_remaining: ["criterion B"],
        progress_estimate: 0.5,
      }),
      round_contract: contract({ done_when: ["criterion A", "criterion B"] }),
    }), 2, active);
    assert.ok(!result.flags.some((f) => f.check === CHECK_PREMATURE_BOUNDARY),
      "items listed in remaining are R1's domain, not premature_boundary");
  });

  it("premature_boundary: no_change_reason downgrades to info", () => {
    const active = [committedRound(1, { contract: contract() })];
    const result = verifySelfEvaluation(se({
      no_change_reason: "documentation-only round",
      round_contract: contract(),
    }), 2, active, null, []);
    const flag = result.flags.find((f) => f.check === CHECK_PREMATURE_BOUNDARY);
    assert.ok(flag);
    assert.equal(flag!.severity, "info");
  });

  it("round_scope_drift: git changes fully inside the ACTIVE scope → silent", () => {
    const active = [committedRound(1, { contract: contract() })];
    const result = verifySelfEvaluation(
      se({ round_contract: contract() }), 2, active, null, [gitSnap(["src/auth/login.ts"])]);
    assert.ok(!result.flags.some((f) => f.check === CHECK_ROUND_SCOPE_DRIFT));
  });

  it("round_scope_drift: out-of-scope git change → warn naming the file", () => {
    const active = [committedRound(1, { contract: contract() })];
    const result = verifySelfEvaluation(
      se({ round_contract: contract() }), 2, active, null, [gitSnap(["src/other.ts"])]);
    const flag = result.flags.find((f) => f.check === CHECK_ROUND_SCOPE_DRIFT);
    assert.ok(flag);
    assert.equal(flag!.severity, "warn");
    assert.match(flag!.detail, /src\/other\.ts/);
  });

  it("round_scope_drift: no git snapshot or empty scope → fail open", () => {
    const active = [committedRound(1, { contract: contract() })];
    const noGit = verifySelfEvaluation(se({ round_contract: contract() }), 2, active);
    assert.ok(!noGit.flags.some((f) => f.check === CHECK_ROUND_SCOPE_DRIFT));
    const emptyActive = [committedRound(1, { contract: contract({ scope: [] }) })];
    const emptyScope = verifySelfEvaluation(
      se({ round_contract: contract({ scope: [] }) }), 2, emptyActive, null, [gitSnap(["src/other.ts"])]);
    assert.ok(!emptyScope.flags.some((f) => f.check === CHECK_ROUND_SCOPE_DRIFT));
  });

  it("scope and premature read the ACTIVE contract, not the submission's proposal", () => {
    // Round 2 executes under ACTIVE A (done_when "criterion A", scope
    // src/auth). Its eval proposes B (scope src/other, done_when "criterion
    // B") while honestly reporting A done. B's scope would be violated by
    // the round's git changes — but B was NOT executed this round, so no
    // drift fires; A's done_when met with machine evidence (verifiedEvidence),
    // so no premature boundary fires. The old selfEval-based checks would
    // have flagged both.
    const active = [committedRound(1, { contract: contract() })];
    const result = verifySelfEvaluation(se({
      round_contract: contract({ work_item: "Next slice", done_when: ["criterion B"], scope: ["src/other"] }),
    }), 2, active, null, verifiedEvidence(["src/auth/login.ts"]));
    assert.ok(!result.flags.some((f) => f.check === CHECK_ROUND_SCOPE_DRIFT));
    assert.ok(!result.flags.some((f) => f.check === CHECK_PREMATURE_BOUNDARY));
  });

  it("scope helpers: normalization, directory prefix and single-file matching", () => {
    assert.equal(normalizeScopeEntry("./src/auth/"), "src/auth");
    assert.equal(normalizeScopeEntry("src\\auth\\"), "src/auth");
    assert.equal(normalizeScopeEntry("./"), "");
    assert.equal(normalizeScopeEntry("."), "");
    assert.ok(isFileInScope("src/auth/login.ts", ["src/auth"]));
    assert.ok(isFileInScope("src/auth/login.ts", ["./src/auth/"]));
    assert.ok(isFileInScope("src/auth.ts", ["src/auth.ts"]), "exact single-file scope");
    assert.ok(isFileInScope("anything.txt", ["./"]), "repo root scope matches all");
    assert.ok(!isFileInScope("src/other.ts", ["src/auth"]));
    assert.deepEqual(collectOutOfScopeFiles(
      ["src/auth/login.ts", "src/other.ts"], ["src/auth"]), ["src/other.ts"]);
  });
});
