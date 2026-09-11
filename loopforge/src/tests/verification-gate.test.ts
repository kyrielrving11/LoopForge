/** Tests for verification-gate — Layer 1 cross-round consistency checks. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  makeExecutionReport,
  makeSelfEvaluation,
  type SelfEvaluation,
  type VerificationFlag,
} from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";
import { committedFeedbackRound as committedRound, testCommandProvider, criterionClaims } from "./_helpers.js";
import { verifySelfEvaluation as rawVerifySelfEvaluation, parseTestOutput, deriveEvidenceStatus, machineProgressSeries, CHECK_VERIFICATION_ENTRYPOINT_MODIFIED, CHECK_TEST_FILES_MODIFIED, CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE } from "../verification-gate.js";
import type {
  CommandObservation,
  CommandObservationData,
  GitObservation,
  MachineObservation,
  ObservationStatus,
} from "../protocol.js";
import { computeGoalTextHash, deriveCriterionId } from "../loop-compiler.js";
import { commandConfigHash, resetPolicy, getPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";
import type { ContractBinding, RoundContractProposal } from "../protocol.js";
import { deriveContractId, deriveContractItemIds } from "../token-utils.js";
import {
  CHECK_ROUND_SCOPE_DRIFT,
  CHECK_CONTRACT_ITEMS_UNVERIFIED,
  CHECK_CONTRACT_PREMATURE,
  CHECK_DOMAIN,
  CHECK_USER_GATE_UNRESOLVED,
  normalizeScopeEntry,
  isFileInScope,
  collectOutOfScopeFiles,
} from "../verification-gate.js";
import * as verificationGate from "../verification-gate.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Build a minimal SelfEvaluation for testing. The default fixture carries
 *  machine-verifiable test evidence so the v2.12 success_without_verified_
 *  evidence check stays silent unless a test explicitly removes it. */
/** v3.2: A verified git snapshot (machine observation present) — keeps the
 *  success_unverified check silent in tests that assert "no flag" outcomes. */
function gitSnap(files: string[] = ["src/a.ts"]): GitObservation {
  return {
    schemaVersion: 1,
    providerId: "git",
    kind: "git",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
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
    execution_report: makeExecutionReport({
      files_changed: ["src/a.ts"],
      tests_reported: { passed: 1, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims(["criterion A"], []),
      progress_estimate: 0.5,
    }),
    ...overrides,
  });
}

/** v3.2: A passed/failed after-phase command snapshot. The default stdout
 *  parses to {passed: 1, failed: 0} — matches the se() fixture's
 *  tests_reported so count-comparison checks stay silent. */
function cmdSnap(
  status: ObservationStatus,
  overrides: Partial<CommandObservationData> = {},
): CommandObservation {
  return {
    schemaVersion: 1,
    providerId: "command:test",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      commandId: "test",
      argv: ["node", "-e", "test"],
      cwd: ".",
      configHash: "0".repeat(64),
      required: false,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 100,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: status === "passed" ? "Tests: 1 passed, 1 total" : "Tests: 0 passed, 1 failed",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
      ...overrides,
    },
  };
}

/** v3.3: A verified evidence pair — git observation plus a passed command.
 *  Success claims with self-reported tests_reported alone are no longer
 *  machine evidence (R8 required by default), so tests that assert unrelated
 *  checks must pass a passed command snapshot. */
function verifiedEvidence(files: string[] = ["src/a.ts"]): MachineObservation[] {
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
  evidenceSnapshots: MachineObservation[] = [cmdSnap("passed")],
  backtrackSkippedFiles: string[] = [],
  backtrackSkippedFingerprints: Record<string, string> = {},
  backtrackTargetGitHead?: string,
  gateEntries: VaultEntry[] = [],
): ReturnType<typeof rawVerifySelfEvaluation> {
  return rawVerifySelfEvaluation(
    selfEval,
    currentRound,
    vaultEntries,
    prevSelfEval,
    evidenceSnapshots,
    backtrackSkippedFiles,
    backtrackSkippedFingerprints,
    backtrackTargetGitHead,
    gateEntries,
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
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: { passed: 3, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims(["impl"], ["tests"]),
        progress_estimate: 0.7,
      }),
      constraint_violations: ["deadline"],
      discovered_constraints: ["new: must handle null"],
    });

    const prev = se({
      success: false,
      execution_report: makeExecutionReport({
        files_changed: ["src/bar.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], ["impl", "tests"]),
        progress_estimate: 0.3,
      }),
      constraint_violations: ["missing docs"],
      discovered_constraints: ["must use async"],
    });

    const vault = [vaultRound(1, ["missing docs"])];

    // A passed command with matching counts keeps criteria_claims_unverified,
    // command_evidence_mismatch, R8 and success_unverified all silent
    // (v3.3: self-reported tests_reported alone are no longer machine evidence).
    const result = verifySelfEvaluation(curr, 2, vault, prev,
      [cmdSnap("passed", { stdoutExcerpt: "Tests: 3 passed, 3 total" })]);
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });

  it("trusted verdict for first round (no previous data)", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        progress_estimate: 0.0,
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        files_changed: ["src/a.ts"],
      }),
    });

    const result = verifySelfEvaluation(curr, 1, [], null, [gitSnap(), cmdSnap("passed")]);
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Success with remaining criteria
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — success with remaining criteria", () => {
  it("flags when success=true but criteria remain unmet", () => {
    const curr = se({
      success: true,
      execution_report: makeExecutionReport({
        criterion_claims: criterionClaims(["builds"], ["tests pass", "docs updated"]),
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
      execution_report: makeExecutionReport({
        criterion_claims: criterionClaims(["builds", "tests pass"], []),
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        files_changed: ["src/a.ts"],
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null, [gitSnap(), cmdSnap("passed")]);
    assert.equal(result.verdict, "trusted");
  });

  it("does not flag when success is false even with remaining criteria", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
        criterion_claims: criterionClaims([], ["tests pass"]),
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
      execution_report: makeExecutionReport({
        criterion_claims: criterionClaims([], ["tests pass"]),
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
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
      execution_report: makeExecutionReport({
        files_changed: [],
        tests_reported: { passed: 3, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], ["tests pass"]),
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
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: { passed: 3, failed: 1, skipped: 0 },
        criterion_claims: criterionClaims([], ["tests"]),
        progress_estimate: 0.5,
      }),
      constraint_violations: ["minor"],
      discovered_constraints: ["unique constraint"],
    });
    const prev = se({
      success: false,
      execution_report: makeExecutionReport({
        progress_estimate: 0.3,
      }),
      constraint_violations: ["other"],
      discovered_constraints: ["different constraint"],
    });

    const result = verifySelfEvaluation(curr, 2, [], prev,
      [gitSnap(["src/foo.ts"]), cmdSnap("passed", { stdoutExcerpt: "Tests: 3 passed, 1 failed" })]);
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
function cmdSnapshot(
  overrides: Partial<CommandObservationData> = {},
  observation: Partial<Omit<CommandObservation, "data">> = {},
): CommandObservation {
  return {
    schemaVersion: 1,
    providerId: "command:test",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "passed",
    files: [],
    ...observation,
    data: {
      commandId: "test",
      argv: ["node", "-e", "test"],
      cwd: ".",
      configHash: "0".repeat(64),
      required: false,
      exitCode: 0,
      signal: null,
      durationMs: 100,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
      ...overrides,
    },
  };
}

describe("verification-gate — command evidence integrity", () => {
  it("no flag when test counts match exactly", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: [],
        tests_reported: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({ stdoutExcerpt: "Tests: 1 failed, 8 passed, 9 total" });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should not flag when counts match");
  });

  it("warn when passed counts differ", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: [],
        tests_reported: { passed: 10, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({ stdoutExcerpt: "Tests: 1 failed, 8 passed, 9 total" });
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
      execution_report: makeExecutionReport({
        files_changed: [],
        tests_reported: { passed: 8, failed: 0, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({ stdoutExcerpt: "Tests: 2 failed, 8 passed, 10 total" });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.ok(flag, "should flag hidden failures");
    assert.equal(flag!.severity, "error");
  });

  it("no flag when agent has no tests_reported", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: null,
      }),
    });
    const snap = cmdSnapshot({ stdoutExcerpt: "Tests: 1 failed, 8 passed, 9 total" });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip when no tests_reported reported");
  });

  it("no flag when command output is truncated", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        tests_reported: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({
      stdoutExcerpt: "Tests: 1 failed, 8 passed, 9 total",
      truncated: true,
    });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip when output is truncated");
  });

  it("no flag when command status is not passed", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        tests_reported: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot(
      { stdoutExcerpt: "Tests: 1 failed, 8 passed, 9 total", exitCode: 1 },
      { status: "failed" },
    );
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip non-passed commands");
  });

  it("no flag for non-command evidence providers", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        tests_reported: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    // A non-command provider (e.g. a hypothetical coverage provider)
    const snap: MachineObservation = {
      schemaVersion: 1,
      providerId: "coverage",
      kind: "custom",
      phase: "after",
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: [],
      data: { kind: "coverage", coverage: 0.8 },
    };
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip non-command providers");
  });

  it("no flag when command output is unparseable", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        tests_reported: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const snap = cmdSnapshot({ stdoutExcerpt: "All checks passed! ✨" });
    const result = verifySelfEvaluation(curr, 2, [], null, [snap]);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip unparseable output");
  });

  it("no flag with empty evidence snapshots", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        tests_reported: { passed: 8, failed: 1, skipped: 0 },
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null, []);
    const flag = result.flags.find(f => f.check === "command_evidence_mismatch");
    assert.equal(flag, undefined, "should skip when no snapshots");
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
      execution_report: makeExecutionReport({
        files_changed: ["src/new-feature.ts"],
        progress_estimate: 0.5,
      }),
      ...overrides,
    });
  }

  it("no flag when backtrackSkippedFiles is empty", () => {
    const result = verifySelfEvaluation(
      se({ execution_report: makeExecutionReport({
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
      se({ execution_report: makeExecutionReport({
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
      se({ execution_report: makeExecutionReport({
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

  it("warns (not errors) on significant self-reported overlap (M3)", () => {
    // A restored-then-redone file is indistinguishable from a never-restored
    // one by self-report alone — a legitimate multi-file redo must never be
    // terminated on this signal, so overlap stays guidance.
    const result = verifySelfEvaluation(
      se({ execution_report: makeExecutionReport({
        files_changed: ["src/a.ts", "src/b.ts", "src/c.ts"],
      })}),
      3, [], null, [],
      ["src/a.ts", "src/b.ts", "src/c.ts", "lib/x.go"],
    );
    const flag = result.flags.find(
      (f) => f.check === "backtrack_workspace_not_restored",
    );
    assert.ok(flag, "should flag significant overlap");
    assert.equal(flag.severity, "warn",
      "self-reported overlap alone can no longer produce an error");
  });

  it("M3: errors only when a skipped file is byte-identical to its failed state", () => {
    // Machine arm: the current git fingerprint still matches the fingerprint
    // recorded at the failed round → the file was never touched since the
    // rollback → the workspace was not restored.
    const git: GitObservation = {
      schemaVersion: 1,
      providerId: "git",
      kind: "git",
      phase: "after",
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: ["src/a.ts"],
      data: {
        tracked: ["src/a.ts"], staged: [], untracked: [],
        fingerprints: { "src/a.ts": "m:same", "lib/other.ts": "m:other" },
      },
    };
    const result = verifySelfEvaluation(
      se({ execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],
      })}),
      3, [], null, [git],
      ["src/a.ts", "lib/other.ts"],
      { "src/a.ts": "m:same", "lib/other.ts": "m:changed" },
    );
    const flag = result.flags.find(
      (f) => f.check === "backtrack_workspace_not_restored",
    );
    assert.ok(flag, "untouched failed-round files must error");
    assert.equal(flag!.severity, "error");
  });

  it("M3: a restored-and-redone file does not error", () => {
    // The agent restored the workspace, then legitimately re-modified the
    // file during the redo — the fingerprint moved on, so no machine
    // contradiction exists even though the claimed file overlaps.
    const git: GitObservation = {
      schemaVersion: 1,
      providerId: "git",
      kind: "git",
      phase: "after",
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: ["src/a.ts"],
      data: {
        tracked: ["src/a.ts"], staged: [], untracked: [],
        fingerprints: { "src/a.ts": "m:redone" },
      },
    };
    const result = verifySelfEvaluation(
      se({ execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],
      })}),
      3, [], null, [git],
      ["src/a.ts"],
      { "src/a.ts": "m:failed-state" },
    );
    assert.ok(!result.flags.some((f) =>
      f.check === "backtrack_workspace_not_restored" && f.severity === "error"),
    "a legitimate redo must not raise the restore error");
  });

  it("no flag when execution_report is absent", () => {
    const result = verifySelfEvaluation(
      se({ execution_report: undefined }),
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
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], ["tests pass"]),
        progress_estimate: 0.5,
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    // outcome wins: the success-class check must not fire; the declared
    // non-success vs the core success=true flag produces a warning.
    assert.ok(!result.flags.some((f) => f.check === "success_with_remaining_criteria"));
    // v3.7: the warn direction shares the outcome_success_contradiction id.
    const warnFlag = result.flags.find((f) => f.check === "outcome_success_contradiction");
    assert.ok(warnFlag);
    assert.equal(warnFlag.severity, "warn");
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

  it("warns when outcome=failed but success=true (inconsistent claim)", () => {
    const curr = se({
      success: true,
      outcome: "failed",
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.equal(result.verdict, "suspect");
    // v3.7: the warn direction shares the outcome_success_contradiction id.
    const warnFlag = result.flags.find((f) => f.check === "outcome_success_contradiction");
    assert.ok(warnFlag);
    assert.equal(warnFlag.severity, "warn");
    assert.ok(warnFlag.detail.includes("failed"));
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
          schema_version: 2,
          round_id: "loop:test-loop:round:1",
          snapshot: {
            schemaVersion: 2,
            roundId: "loop:test-loop:round:1",
            loopId: "test-loop",
            round: 1,
            attempt: 1,
            phase: "committed" as const,
            beforeEvidence: [],
            afterEvidence: [{
              schemaVersion: 1,
              providerId: "git",
              kind: "git",
              phase: "after",
              startedAt: 0,
              finishedAt: 0,
              status: "observed",
              files: ["src/fixed.ts"],
              data: { head: "abc", fingerprints: {} },
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
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],
        tests_reported: null,
        criterion_claims: criterionClaims(["tests pass", "docs updated"], []),
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
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],
        tests_reported: { passed: 4, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims(["tests pass"], []),
        progress_estimate: 0.8,
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.ok(!result.flags.some((f) => f.check === "criteria_claims_unverified"));
  });

  it("stays silent when no criteria are reported met", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],
        tests_reported: null,
        criterion_claims: criterionClaims([], ["tests pass"]),
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
      execution_report: makeExecutionReport({
        files_changed: [],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
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



// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — machineProgressSeries (R4/R5 heuristic-path fallback)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — machineProgressSeries", () => {
  const feedbackRound = (round: number, gitFiles: string[]): VaultEntry =>
    committedRound(round, {
      loopId: "mp",
      roundEvidence: [{ schemaVersion: 1, providerId: "git", kind: "git", phase: "after", startedAt: 0, finishedAt: 0, status: "observed", files: gitFiles, data: { fingerprints: {} } }],
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
// ═══════════════════════════════════════════════════════════════════════════


// v3.3 — Round Contract checks
// ═══════════════════════════════════════════════════════════════════════════

/** The "run-tests" command policy the item-model tests configure. */
const policyRunTestsCommand = () => ({
  name: "run-tests", enabled: true, executable: "node", args: ["test"],
  phase: "after" as const, required: false, timeout_ms: 1000,
  max_output_chars: 2000, success_exit_codes: [0],
});

/** Configure a "run-tests" command so the item model can observe it. */
const withRunTestsConfigured = (): void => {
  setPolicyForTest({
    ...DEFAULT_POLICY,
    evidence: { ...DEFAULT_POLICY.evidence, commands: [policyRunTestsCommand()] },
  });
};

describe("Round Contract checks (v3.8 item model)", () => {
  afterEach(() => resetPolicy());

  /** A contract with one item bound to the test command. */
  const itemContract = (overrides: Partial<RoundContractProposal> = {}): RoundContractProposal => ({
    work_item: "Slice A",
    scope: ["src/auth"],
    items: [{ description: "login works", criterion_refs: [], subgoal_refs: [], verify_with: ["run-tests"] }],
    ...overrides,
  });

  /** The binding the runtime stamps when the declaring round commits. */
  /** The config hash the runtime stamps when the declaring round commits. */
  const declaredHash = (): string => commandConfigHash(policyRunTestsCommand());
  const bindingFor = (value: RoundContractProposal): ContractBinding => ({
    rc_id: deriveContractId("test-loop", value),
    item_ids: deriveContractItemIds(value.items),
    config_hash_by_command: { "run-tests": declaredHash() },
  });

  const itemIds = (value: RoundContractProposal): string[] => deriveContractItemIds(value.items);

  const activeRound = (value: RoundContractProposal) =>
    committedRound(1, { contract: value, contractBinding: bindingFor(value) });

  const claimsMet = (value: RoundContractProposal) =>
    itemIds(value).map((item_id) => ({ item_id, outcome: "met" as const }));

  it("contract_items_unverified: claimed met without a passing command → warn", () => {
    withRunTestsConfigured();
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({
        execution_report: makeExecutionReport({ contract_item_claims: claimsMet(contract) }),
      }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/auth/a.ts"])],
    );
    const flag = result.flags.find((f) => f.check === CHECK_CONTRACT_ITEMS_UNVERIFIED);
    assert.ok(flag, "an unverified claim must be surfaced");
    assert.equal(flag!.severity, "warn");
  });

  it("contract_items_unverified: silent when the bound command passed", () => {
    withRunTestsConfigured();
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({
        execution_report: makeExecutionReport({ contract_item_claims: claimsMet(contract) }),
      }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/auth/a.ts"]), cmdSnap("passed", { commandId: "run-tests", configHash: declaredHash() })],
    );
    assert.ok(!result.flags.some((f) => f.check === CHECK_CONTRACT_ITEMS_UNVERIFIED));
  });

  it("round_scope_drift: files outside the active contract's scope → warn", () => {
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({ success: false, execution_report: makeExecutionReport({ files_changed: ["src/other.ts"] }) }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/other.ts"])],
    );
    assert.ok(result.flags.some((f) =>
      f.check === CHECK_ROUND_SCOPE_DRIFT && f.severity === "warn"));
  });

  it("round_scope_drift: silent when the active contract declares no scope", () => {
    const contract = itemContract({ scope: [] });
    const result = verifySelfEvaluation(
      se({ success: false, execution_report: makeExecutionReport({ files_changed: ["src/other.ts"] }) }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/other.ts"])],
    );
    assert.ok(!result.flags.some((f) => f.check === CHECK_ROUND_SCOPE_DRIFT));
  });

  it("contract_premature: a different proposal while open → warn", () => {
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({
        success: false,
        execution_report: makeExecutionReport({}),
        round_contract: itemContract({ work_item: "Slice B" }),
      }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/auth/a.ts"])],
    );
    assert.ok(result.flags.some((f) =>
      f.check === CHECK_CONTRACT_PREMATURE && f.severity === "warn"));
  });

  it("contract_premature: a restate is not flagged", () => {
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({
        success: false,
        execution_report: makeExecutionReport({}),
        round_contract: itemContract(),
      }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/auth/a.ts"])],
    );
    assert.ok(!result.flags.some((f) => f.check === CHECK_CONTRACT_PREMATURE));
  });

  it("contract_premature: silent when the round declares outcome=blocked", () => {
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({
        success: false,
        outcome: "blocked",
        blocker: "scope too narrow",
        execution_report: makeExecutionReport({}),
        round_contract: itemContract({ work_item: "Slice B" }),
      }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/auth/a.ts"])],
    );
    assert.ok(!result.flags.some((f) => f.check === CHECK_CONTRACT_PREMATURE));
  });
});

describe("verification-gate — v3.7 CHECK_DOMAIN membership", () => {
  it("maps every surviving CHECK_* constant into one of the four domains", () => {
    const exports = verificationGate as unknown as Record<string, unknown>;
    const constants = Object.keys(exports)
      .filter((key) => key.startsWith("CHECK_") && typeof exports[key] === "string");
    // v3.8: the drift checks were deleted and the four contract checks were
    // replaced by the item-model checks (25 → 20).
    assert.equal(constants.length, 20, "the surviving check set is 20");
    const domains = new Set<string>();
    for (const key of constants) {
      const id = exports[key] as string;
      const domain = CHECK_DOMAIN[id];
      assert.ok(domain, `check "${id}" has no domain`);
      domains.add(domain);
    }
    assert.deepEqual(
      [...domains].sort(),
      ["evaluation_consistency", "evidence_integrity", "plan_contract", "progress_recovery"],
      "all four domains are populated",
    );
  });

  it("has no orphan domain entries and the expected domain sizes", () => {
    const counts: Record<string, number> = {};
    for (const domain of Object.values(CHECK_DOMAIN)) counts[domain] = (counts[domain] ?? 0) + 1;
    // v3.8: 20 checks after the drift and legacy contract checks were
    // replaced by the item-model checks.
    assert.equal(Object.keys(CHECK_DOMAIN).length, 20, "CHECK_DOMAIN covers exactly the 20 checks");
    assert.deepEqual(counts, {
      evaluation_consistency: 8,
      evidence_integrity: 7,
      plan_contract: 4,
      progress_recovery: 1,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.7.1 — opt-in gate blocking: user_gate_unresolved
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — v3.7.1 user_gate_unresolved", () => {
  afterEach(() => resetPolicy());

  function openedGate(gateId: string, actionText: string): VaultEntry {
    return {
      id: gateId,
      task_id: `loop:g:gate:${gateId}`,
      task_type: "gate_opened",
      loop_id: "test-loop",
      timestamp: "2026-09-01T00:00:00.000Z",
      gate_id: gateId,
      gate_action: actionText,
      loop_lineage: { round: 1, gate_id: gateId },
    };
  }

  function decision(gateId: string, approved: boolean): VaultEntry {
    return {
      id: `${gateId}:decision`,
      task_id: `loop:g:gate:${gateId}:decision`,
      task_type: "gate_decision",
      loop_id: "test-loop",
      timestamp: "2026-09-02T00:00:00.000Z",
      gate_id: gateId,
      approved,
      loop_lineage: { round: 1, gate_id: gateId, action_hash: "x" },
    };
  }

  const GATE_ID = "gate-111111111111";
  const userActionJson = JSON.stringify({
    description: "Deploy to production", scope: ["prod"],
    effects: ["production"], reversibility: "unknown",
    authorization: "user_required",
  });
  const agentActionJson = JSON.stringify({
    description: "Refactor store", scope: ["src/store.ts"],
    effects: ["workspace_write"], reversibility: "reversible",
    authorization: "agent_allowed",
  });

  const flagFor = (result: ReturnType<typeof rawVerifySelfEvaluation>) =>
    result.flags.find((f) => f.check === CHECK_USER_GATE_UNRESOLVED);

  it("skips citations entirely when policy.gate.enabled=false (the default)", () => {
    resetPolicy();
    const result = verifySelfEvaluation(se({ gate_ids: [GATE_ID] }), 2);
    assert.equal(flagFor(result), undefined, "no gate checks when the layer is off");
  });

  it("errors with not_found when the cited gate was never opened", () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const result = verifySelfEvaluation(se({ gate_ids: [GATE_ID] }), 2);
    const flag = flagFor(result);
    assert.ok(flag, "cited unknown gate must flag");
    assert.equal(flag!.severity, "error");
    assert.match(flag!.detail, /not_found/);
  });

  it("errors with not_user_gate for agent-classified gates", () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const result = verifySelfEvaluation(
      se({ gate_ids: [GATE_ID] }), 2, [], null, [cmdSnap("passed")], [], {}, undefined,
      [openedGate(GATE_ID, agentActionJson)]);
    const flag = flagFor(result);
    assert.ok(flag, "an agent gate cannot satisfy a user citation");
    assert.match(flag!.detail, /not_user_gate/);
  });

  it("errors with not_approved when no approved decision exists", () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const result = verifySelfEvaluation(
      se({ gate_ids: [GATE_ID] }), 2, [], null, [cmdSnap("passed")], [], {}, undefined, [
        openedGate(GATE_ID, userActionJson),
        decision(GATE_ID, false),
      ]);
    const flag = flagFor(result);
    assert.ok(flag, "a declined gate cannot satisfy the citation");
    assert.match(flag!.detail, /not_approved/);
  });

  it("stays silent when the cited user gate has an approved decision", () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const result = verifySelfEvaluation(
      se({ gate_ids: [GATE_ID] }), 2, [], null, [cmdSnap("passed")], [], {}, undefined, [
        openedGate(GATE_ID, userActionJson),
        decision(GATE_ID, true),
      ]);
    assert.equal(flagFor(result), undefined, "approved gate satisfies the citation");
  });

  it("supports legacy flat-text user gates (blocked-round auto-records)", () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const legacyId = "gate-222222222222";
    const result = verifySelfEvaluation(
      se({ gate_ids: [legacyId] }), 2, [], null, [cmdSnap("passed")], [], {}, undefined, [
        openedGate(legacyId, "publish the release to production"),
        decision(legacyId, true),
      ]);
    assert.equal(flagFor(result), undefined,
      "flat USER_RISK-classified records count as user gates");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.7 — success-evidence merge: the empty/missing-evidence arm absorbed the
// former enforcement-only empty_success (R3) posture. These rows lock the
// arm's boundaries — unconditional error (policy switch and no_change_reason
// do NOT downgrade it), evaluated BEFORE the machine-verified early exit,
// and suppressed by the declared outcome (effectiveSuccess).
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — v3.7 success-evidence merge (empty arm)", () => {
  afterEach(() => resetPolicy());

  const successNoEvidence = (overrides: Partial<SelfEvaluation> = {}): SelfEvaluation =>
    se({
      success: true,
      execution_report: makeExecutionReport({
        files_changed: [],
        tests_reported: null,
        progress_estimate: 0.5,
      }),
      ...overrides,
    });

  const emptyArmFlag = (result: ReturnType<typeof rawVerifySelfEvaluation>) =>
    result.flags.find((f) =>
      f.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE && f.severity === "error");

  it("errors when success=true with no files changed and no tests run", () => {
    const result = verifySelfEvaluation(successNoEvidence(), 2);
    assert.equal(result.verdict, "contradicted");
    assert.ok(emptyArmFlag(result), "empty arm must fire");
  });

  it("errors when success=true carries no execution_report at all (mandatory)", () => {
    const bare = se({ success: true });
    (bare as unknown as Record<string, unknown>).execution_report = undefined;
    const result = verifySelfEvaluation(bare, 2);
    assert.equal(result.verdict, "contradicted");
    const flag = emptyArmFlag(result);
    assert.ok(flag);
    assert.ok(flag.detail.includes("no execution_report"),
      `detail should say evidence is missing, got: ${flag.detail}`);
  });

  it("still errors when no_change_reason is declared (no change with zero evidence is unbacked)", () => {
    const result = verifySelfEvaluation(
      successNoEvidence({ no_change_reason: "Nothing needed changing." }),
      2,
    );
    assert.equal(result.verdict, "contradicted");
    assert.ok(emptyArmFlag(result), "no_change_reason only downgrades the claims arm");
  });

  it("still errors when a machine command verified this round (evidence stays mandatory)", () => {
    // The empty arm runs BEFORE the providerStatus==="verified" early exit —
    // a passed command never rescues a success claim that recorded no work.
    const result = verifySelfEvaluation(successNoEvidence(), 2, [], null, [cmdSnap("passed")]);
    assert.equal(result.verdict, "contradicted");
    assert.ok(emptyArmFlag(result));
  });

  it("stays silent when the declared outcome wins (outcome=partial suppresses the arm)", () => {
    const result = verifySelfEvaluation(successNoEvidence({ outcome: "partial" }), 2);
    assert.ok(!emptyArmFlag(result), "effectiveSuccess=false suppresses the whole check");
  });

  it("stays silent when execution_report is non-empty (claims arm owns the posture)", () => {
    const result = verifySelfEvaluation(
      se({
        success: true,
        execution_report: makeExecutionReport({
          files_changed: ["src/foo.ts"],
          tests_reported: { passed: 1, failed: 0, skipped: 0 },
        }),
      }),
      2,
      [], null, [cmdSnap("passed")],
    );
    assert.ok(!emptyArmFlag(result));
    assert.equal(result.verdict, "trusted");
  });
});
