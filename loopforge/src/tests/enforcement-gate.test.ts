/** Tests for enforcement-gate — Layer 2 round-boundary runtime enforcement. */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getPolicy,
  resetPolicy,
  setPolicyForTest,
  type LoopPolicy,
} from "../policy.js";
import {
  makeEnforcementResult,
  makeExecutionReport,
  makeSelfEvaluation,
  makeVerificationFlag,
  makeVerificationResult,
  type EnforcementResult,
  type SelfEvaluation,
  type VerificationFlag,
  type VerificationResult,
} from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";
import {
  enforceRound,
  buildRejectionPrompt,
  findSafeRestorePoint,
} from "../enforcement-gate.js";

import { verifyBacktrackPrompt } from "./_backtrack-asserts.js";
import { committedBacktrackRound, committedFeedbackRound, testCommandProvider, criterionClaims } from "./_helpers.js";
import { deriveContractItemIds } from "../token-utils.js";
import { commandConfigHash } from "../policy.js";
import { CHECK_CONTRACT_ITEMS_UNVERIFIED } from "../verification-gate.js";

/** The command policy the item-model enforcement tests bind to. */
const testCommandProviderPolicy = () => testCommandProvider();

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

/** Build a committed round with an observable Git delta. */
function vaultRound(
  round: number,
  gitFiles: string[] = [],
  branchId?: string,
): VaultEntry {
  const beforeHead = `h${round - 1}`;
  const afterHead = gitFiles.length > 0 ? `h${round}` : beforeHead;
  return committedFeedbackRound(round, {
    loopId: "test-loop",
    ...(branchId ? { branchId } : {}),
    files: ["src/foo.ts"],
    beforeEvidence: [{
      schemaVersion: 2,
      providerId: "git",
      kind: "git",
      phase: "before",
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: [],
      data: {
        dirty: [],
        fingerprints: {},
        head: beforeHead,
        coverage: "tracked_and_non_ignored_untracked",
      },
    }],
    roundEvidence: [{
      schemaVersion: 2,
      providerId: "git",
      kind: "git",
      phase: "after",
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: gitFiles,
      data: {
        dirty: gitFiles,
        fingerprints: Object.fromEntries(gitFiles.map((file) => [file, "m:1"])),
        head: afterHead,
        coverage: "tracked_and_non_ignored_untracked",
      },
    }],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Happy path — trusted verdict, no issues
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — happy path", () => {
  it("accepts a round with trusted verdict and clean self-eval", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: { passed: 3, failed: 1, skipped: 0 },
      }),
    });
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "accept");
    assert.equal(result.reason, "");
  });

  it("accepts a round with suspect verdict (warn only, not error)", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
        files_changed: ["src/bar.ts"],
        tests_reported: { passed: 5, failed: 0, skipped: 0 },
      }),
    });
    const suspect: VerificationResult = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "blocker",
          check: "blocked_without_blocker",
          detail: "outcome=blocked without a blocker",
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
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        criterion_claims: criterionClaims(["criteria-1"], ["criteria-2", "criteria-3"]),
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
    assert.ok(!result.fix_instructions.includes("DIFFERENT approach"));
    assert.ok(result.fix_instructions.includes("does not prescribe a technique"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.7: success evidence row — the ex-R3 empty/missing-evidence posture is
// v3.9.1: R8 was removed. Its only trigger was the empty-report arm of
// success_without_verified_evidence, which is now a warn; report coverage no
// longer decides acceptance. The machine-evidence warn still excludes an
// unbacked success from the success trajectory. Flag production is covered in
// verification-gate.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — success evidence row (R8 removed in v3.9.1)", () => {
  const evidenceFlag = (
    severity: "warn" | "error" = "warn",
    detail = "Agent claims success but provided no execution_report.",
  ): VerificationFlag =>
    makeVerificationFlag({
      severity,
      field: "success",
      check: "success_without_verified_evidence",
      detail,
    });

  it("accepts when success=true with files_changed (not empty)", () => {
    const curr = se({
      success: true,
      execution_report: makeExecutionReport({
        files_changed: ["src/fixed.ts"],
        tests_reported: { passed: 10, failed: 0, skipped: 0 },
      }),
    });
    const result = enforceRound(curr, trusted(), 2, [], 0);
    assert.equal(result.action, "accept");
  });

  it("does not reject on a warn-severity success-evidence flag", () => {
    const curr = se({
      success: true,
      execution_report: makeExecutionReport({
        files_changed: [],
        tests_reported: null,
      }),
    });
    const result = enforceRound(
      curr,
      makeVerificationResult({ verdict: "contradicted", flags: [evidenceFlag("warn")] }),
      2, [], 0,
    );
    assert.equal(result.action, "accept",
      "an unbacked success commits as insufficient; no R8 rejection exists");
  });

  it("does not act on a legacy error-severity flag (no producer, no row)", () => {
    const curr = se({ success: true });
    const result = enforceRound(
      curr,
      makeVerificationResult({ verdict: "contradicted", flags: [evidenceFlag("error")] }),
      2, [], 0,
    );
    assert.equal(result.action, "accept",
      "R8 is gone; a stale error flag cannot revive it");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R4: progress stall
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — progress stall evaluator (v3.7: R4/R5 merged)", () => {
  it("rejects when Git shows no motion for 3 rounds", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
      }),
    });
    const vault = [
      vaultRound(1, []),
      vaultRound(2, []),
      vaultRound(3, []),
    ];
    const result = enforceRound(curr, trusted(), 4, vault, 0, "", false, { state: "unchanged", providers: ["git"] });
    assert.equal(result.action, "reject");
    assert.ok(result.reason.includes("Machine-observed progress is flat"));
  });

  it("accepts when Git observes file changes in the window", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
      }),
    });
    const vault = [
      vaultRound(1, []),
      vaultRound(2, ["src/a.ts"]),
      vaultRound(3, []),
    ];
    const result = enforceRound(curr, trusted(), 4, vault, 0);
    assert.equal(result.action, "accept");
  });

  it("backtracks on second consecutive stall rejection instead of terminating", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
      }),
    });
    const vault = [
      vaultRound(1, []),
      vaultRound(2, []),
      vaultRound(3, []),
    ];
    // v2.10: consecutiveRejections=1 + escalation + backtrack_enabled → backtrack
    // instead of v2.7's escalated reject. The agent is rolled back to the
    // last clean round rather than redoing the same round with guidance.
    // v3.8.3: the stall's own streak — the check name is the one the counter
    // belongs to, not an assumption.
    const result = enforceRound(curr, trusted(), 4, vault, 1, "progress_stall", false, { state: "unchanged", providers: ["git"] });
    assert.equal(result.action, "backtrack");
    assert.equal(result.check, "progress_stall");
  });

  it("terminates on third consecutive stall rejection after escalation", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
      }),
    });
    const vault = [
      vaultRound(1, []),
      vaultRound(2, []),
      vaultRound(3, []),
    ];
    // v2.7: consecutiveRejections=2 → terminate (escalation already given)
    const result = enforceRound(curr, trusted(), 4, vault, 2, "progress_stall", false, { state: "unchanged", providers: ["git"] });
    assert.equal(result.action, "terminate");
    assert.equal(result.check, "progress_stall");
  });

  it("does not fire with less than 3 rounds of vault data", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
      }),
    });
    const vault = [vaultRound(1, [])];
    const result = enforceRound(curr, trusted(), 2, vault, 0);
    assert.equal(result.action, "accept");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// R6: max rejections
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R6: max rejections", () => {
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
      execution_report: makeExecutionReport({
        files_changed: [],       // triggers R3
        tests_reported: null,       // triggers R3
        criterion_claims: criterionClaims(["x"], ["y", "z"]),  // triggers R1
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
    assert.ok(!prompt.includes("Audit the ERC20 token"),
      "the original task is rendered by Objective/Current Task, not repeated here");
    assert.ok(prompt.includes("Re-execute"));
    assert.ok(prompt.includes("do NOT advance"));
  });

  it("does not repeat the task; Objective/Current Task own it", () => {
    const enforceResult = makeEnforcementResult({
      action: "reject",
      reason: "Test reason.",
      fix_instructions: "Test fix.",
    });
    const prompt = buildRejectionPrompt(2, "Fix bugs in auth module", enforceResult);
    assert.ok(!prompt.includes("Fix bugs in auth module"));
    assert.ok(prompt.includes("Test fix."));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.8: R7 — Intent drift with drift_clarification
// ═══════════════════════════════════════════════════════════════════════════

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
    return committedFeedbackRound(rnd, { loopId: "test" });
  }

  function dirtyRound(
    rnd: number,
    severity: "warn" | "error" = "error",
    discoveries: string[] = [],
  ): VaultEntry {
    return committedFeedbackRound(rnd, {
      loopId: "test",
      discoveredConstraints: discoveries,
      verificationFlags: [{
        check: "test_flag",
        field: "round",
        detail: "error",
        severity,
      }],
    });
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
      dirtyRound(4, "error", ["discovery from r4"]),
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
      dirtyRound(3),
    ];
    const result = findSafeRestorePoint(4, vault, 3);
    assert.ok(result);
    assert.equal(result!.round, 2);
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
      dirtyRound(4, "error", ["discovery from r4"]),
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
// v2.12: Effective-success semantics (R3) with declared outcomes
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — v2.12 effective success", () => {
  it("accepts outcome=partial without execution evidence (declared non-success)", () => {
    const selfEval = makeSelfEvaluation({
      success: true, // Core flag contradicts the optional outcome, which wins.
      outcome: "partial",
      output_summary: "partial progress",
      constraint_violations: [],
      should_continue: true,
    });
    const result = enforceRound(selfEval, makeVerificationResult({ verdict: "trusted" }), 2, [], 0);
    assert.equal(result.action, "accept");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: R7 real-anchor validation — fabricated IDs no longer count
// ═══════════════════════════════════════════════════════════════════════════

// R4 deadlock guard (v2.14): a backtrack that already committed for this
// round must not be repeated forever — the second escalation terminates.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — progress stall: backtrack deadlock guard", () => {
  it("terminates instead of backtracking when a backtrack already committed for this round", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
      }),
    });
    const vault = [
      vaultRound(1, []),
      vaultRound(2, []),
      vaultRound(3, []),
      // The previous stall cycle already committed a backtrack for round 4 —
      // the loop is re-walking rolled-back territory with the same stall.
      committedBacktrackRound(4),
    ];
    const result = enforceRound(curr, trusted(), 4, vault, 1, "progress_stall", false, { state: "unchanged", providers: ["git"] });
    assert.equal(result.action, "terminate");
    assert.equal(result.check, "progress_stall");
  });

  it("still backtracks on a fresh stall window with no committed backtrack", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
      }),
    });
    // A backtrack committed at round 2 is BELOW the current window — the
    // agent recovered, progressed, and then stalled again at rounds 3-5.
    const branch = "tx-rollback-test-loop-2";
    const vault = [
      vaultRound(1, []),
      vaultRound(2, []),
      committedBacktrackRound(2),
      vaultRound(3, [], branch),
      vaultRound(4, [], branch),
      vaultRound(5, [], branch),
    ];
    const result = enforceRound(curr, trusted(), 6, vault, 1, "progress_stall", false, { state: "unchanged", providers: ["git"] });
    assert.equal(result.action, "backtrack");
    assert.equal(result.check, "progress_stall");
  });

  it("excuses a stalled window when the submitted round itself moved Git", () => {
    // v3.9: the redo's own work is in flight and cannot be in the committed
    // window — without this the abandoned window judges every redo forever.
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"] }),
    });
    const vault = [vaultRound(1, []), vaultRound(2, []), vaultRound(3, [])];
    const result = enforceRound(curr, trusted(), 4, vault, 0, "", false, {
      state: "changed",
      providers: ["git"],
    });
    assert.equal(result.action, "accept");
  });

  it("keeps the verdict only when the submitted round is proven unchanged", () => {
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"] }),
    });
    const vault = [vaultRound(1, []), vaultRound(2, []), vaultRound(3, [])];
    const unchanged = enforceRound(curr, trusted(), 4, vault, 0, "", false, {
      state: "unchanged",
      providers: ["git"],
    });
    assert.equal(unchanged.action, "reject");
    assert.equal(unchanged.check, "progress_stall");

    // Unknown never stalls: an unobservable submitted round gains no verdict.
    const unknown = enforceRound(curr, trusted(), 4, vault, 0, "", false, {
      state: "unknown",
      providers: ["git"],
    });
    assert.equal(unknown.action, "accept");
  });

  it("still terminates a stalled redo that a rollback already moved", () => {
    // The deadlock guard must survive the in-flight excuse: a round that
    // moved nothing after its own rollback is not a recovery checkpoint.
    const curr = se({
      success: false,
      execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"] }),
    });
    const vault = [
      vaultRound(1, []), vaultRound(2, []), vaultRound(3, []),
      committedBacktrackRound(4),
    ];
    const result = enforceRound(curr, trusted(), 4, vault, 1, "progress_stall", false, {
      state: "unchanged",
      providers: ["git"],
    });
    assert.equal(result.action, "terminate");
    assert.equal(result.check, "progress_stall");
  });
});

// R-EVID (v2.14): evidence contradictions — required command failure,
// hidden test failures, and self-contradictory outcome claims.
// ═══════════════════════════════════════════════════════════════════════════

describe("enforcement-gate — R-EVID: evidence contradictions", () => {
  it("rejects when a required command failed", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
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
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const verify = makeVerificationResult({
      verdict: "contradicted",
      flags: [
        makeVerificationFlag({
          severity: "error",
          field: "tests_reported",
          check: "command_evidence_mismatch",
          detail: 'Agent tests_reported don\'t match "npm test" output: failed: reported 0, command shows 5',
        }),
      ],
    });
    const result = enforceRound(curr, verify, 4, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "command_evidence_mismatch");
  });

  it("rejects on a self-contradictory outcome claim", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
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
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
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
        field: "execution_report",
        check: "verification_entrypoint_modified",
        detail: 'Verification command "run-tests" entrypoint changed this round',
      }),
    ],
  });

  it("rejects when the verification command entrypoint changed this round", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: ["run-tests.sh"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const result = enforceRound(curr, entrypointTainted(), 4, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "verification_entrypoint_modified");
  });

  it("takes precedence over R8 when both fire (entrypoint reason is specific)", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const verify = makeVerificationResult({
      verdict: "contradicted",
      flags: [
        makeVerificationFlag({
          severity: "error",
          field: "execution_report",
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
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],
        tests_reported: { passed: 1, failed: 0, skipped: 0 },
      }),
    });
    const verify = makeVerificationResult({
      verdict: "suspect",
      flags: [
        makeVerificationFlag({
          severity: "warn",
          field: "execution_report",
          check: "test_files_modified",
          detail: "Test files changed in the same round the command passed",
        }),
      ],
    });
    const result = enforceRound(curr, verify, 4, [], 0);
    assert.equal(result.action, "accept");
  });
});

// v2.14/v3.7: progress continuity guard — stall (and its flatline tier)
// requires the recent data points to cover the most recent rounds; rounds
// without evidence are unknown motion, not zero motion.
// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — R4/R5 machine progress fallback (heuristic path)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — R4 machine progress fallback", () => {
  const feedbackRound = (round: number, gitFiles: string[]): VaultEntry => {
    const beforeHead = `h${round - 1}`;
    const afterHead = gitFiles.length > 0 ? `h${round}` : beforeHead;
    return committedFeedbackRound(round, {
      loopId: "test-loop",
      beforeEvidence: [{
        schemaVersion: 2, providerId: "git", kind: "git", phase: "before",
        startedAt: 0, finishedAt: 0, status: "observed", files: [],
        data: {
          dirty: [], fingerprints: {}, head: beforeHead,
          coverage: "tracked_and_non_ignored_untracked",
        },
      }],
      roundEvidence: [{
        schemaVersion: 2, providerId: "git", kind: "git", phase: "after",
        startedAt: 0, finishedAt: 0, status: "observed", files: gitFiles,
        data: {
          dirty: gitFiles,
          fingerprints: Object.fromEntries(gitFiles.map((file) => [file, "m:1"])),
          head: afterHead,
          coverage: "tracked_and_non_ignored_untracked",
        },
      }],
    });
  };

  it("detects stall from three rounds without git changes on the heuristic path", () => {
    const entries = [feedbackRound(1, []), feedbackRound(2, []), feedbackRound(3, [])];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0, "", false, { state: "unchanged", providers: ["git"] });
    assert.ok(result, "machine stall must fire where the rule used to self-skip");
    assert.equal(result!.action, "reject");
    assert.equal(result!.check, "progress_stall");
  });

  it("does not fire when git observed changes in the window", () => {
    const entries = [feedbackRound(1, ["a.ts"]), feedbackRound(2, ["b.ts"]), feedbackRound(3, ["c.ts"])];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "accept", "observed changes → no stall");
  });

  it("skips when no git snapshots exist", () => {
    const entries = [
      committedFeedbackRound(1, { loopId: "test-loop", roundEvidence: [], noExecutionReport: true }),
      committedFeedbackRound(2, { loopId: "test-loop", roundEvidence: [], noExecutionReport: true }),
      committedFeedbackRound(3, { loopId: "test-loop", roundEvidence: [], noExecutionReport: true }),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "accept", "no git signal → the rule keeps skipping");
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — R4/R5 exculpatory machine cross-check (evidence path)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — progress stall exculpatory machine cross-check", () => {
  /** Committed feedback round carrying progress + git snapshot + met
   *  criteria — the full evidence-path shape R4/R5 and the machine
   *  signals (machineProgressSeries / hasNewCriteriaCompletion) read. */
  const machineRound = (
    round: number,
    progress: number,
    gitFiles: string[],
    met: string[] = [],
  ): VaultEntry => {
    const beforeHead = `h${round - 1}`;
    const afterHead = gitFiles.length > 0 ? `h${round}` : beforeHead;
    return committedFeedbackRound(round, {
      loopId: "test-loop",
      files: gitFiles,
      progress,
      met,
      beforeEvidence: [{
        schemaVersion: 2, providerId: "git", kind: "git", phase: "before",
        startedAt: 0, finishedAt: 0, status: "observed", files: [],
        data: {
          dirty: [], fingerprints: {}, head: beforeHead,
          coverage: "tracked_and_non_ignored_untracked",
        },
      }],
      roundEvidence: [{
        schemaVersion: 2, providerId: "git", kind: "git", phase: "after",
        startedAt: 0, finishedAt: 0, status: "observed", files: gitFiles,
        data: {
          dirty: gitFiles,
          fingerprints: Object.fromEntries(gitFiles.map((file) => [file, "m:1"])),
          head: afterHead,
          coverage: "tracked_and_non_ignored_untracked",
        },
      }],
    });
  };

  it("does not fire R4 when git motion was observed in the window (evidence path)", () => {
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.31, ["src/a.ts"]),
      machineRound(3, 0.32, []),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0);
    assert.equal(result!.action, "accept", "git motion exculpates the delta-based stall");
  });

  it("v3.8.1: a machine-backed completion is not a stall, however flat the window", () => {
    // The closing round of a loop often changes no files — it runs the
    // verification and declares success. That is finishing, not churning, and
    // the machine is the one saying so: `machineBackedSuccess` comes from the
    // gate's own evidence status (a passed after-phase command the runtime
    // observed). It replaces the old self-reported `>= 0.95` guard, which let
    // the agent's own number decide whether the loop could end.
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.30, []),
      machineRound(3, 0.30, []),
    ];
    const backed = makeVerificationResult({ verdict: "trusted", machineBackedSuccess: true });
    const accepted = enforceRound(se({ success: true }), backed, 4, entries, 0);
    assert.equal(accepted.action, "accept",
      "a machine-verified round must be able to close the loop");

    // Without the machine fact the same window still stalls.
    const stalled = enforceRound(se({ success: false }), trusted(), 4, entries, 0, "", false, { state: "unchanged", providers: ["git"] });
    assert.equal(stalled.action, "reject");
    assert.equal(stalled.check, "progress_stall");
  });

  it("v3.6: a newly completed criterion does NOT exculpate the stall (git motion only)", () => {
    // Self-reported criteria completions never buy a machine verdict — only
    // observed git motion can veto the delta-based stall.
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.31, []),
      machineRound(3, 0.32, [], ["auth module completed"]),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0, "", false, { state: "unchanged", providers: ["git"] });
    assert.equal(result!.action, "reject");
    assert.equal(result!.check, "progress_stall");
  });

  it("R4 reason states the machine signal when git is flat", () => {
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.31, []),
      machineRound(3, 0.32, []),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0, "", false, { state: "unchanged", providers: ["git"] });
    assert.equal(result!.action, "reject");
    assert.equal(result!.check, "progress_stall");
    // v3.8.1: the machine series decides when it is observable, so the reason
    // states the machine fact directly. The old wording appended it as an
    // annotation to a self-report-derived verdict; here the verdict IS the
    // machine observation (the rising self-report does not enter it).
    assert.match(result!.reason, /no machine-observed progress in the last 3 committed rounds/);
  });

  it("v3.6: R5 flatline is NOT excluded by a criterion completion over the breaker window", () => {
    // v3.6: criteria no longer exculpate — an exactly-flat run with only a
    // self-reported completion stalls on R4 and flatlines R5.
    const entries = [
      machineRound(1, 0.30, []),
      machineRound(2, 0.30, []),
      machineRound(3, 0.30, [], ["auth module completed"]),
    ];
    const result = enforceRound(se({ success: false }), trusted(), 4, entries, 0, "", false, { state: "unchanged", providers: ["git"] });
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
// v3.8 — Round Contract enforcement: scope drift (machine fact, no waiver)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.8 — Round Contract item enforcement", () => {
  /** A contract with one item bound to the configured test command. */
  const itemContract = (overrides: Record<string, unknown> = {}) => ({
    work_item: "Slice A",
    scope: ["src/auth"],
    items: [{ description: "login works", criterion_refs: [], subgoal_refs: [], verify_with: ["verify"] }],
    ...overrides,
  });

  const bindingFor = (value: ReturnType<typeof itemContract>) => ({
    rc_id: "rc-aaaaaaaa",
    item_ids: deriveContractItemIds(value.items),
    config_hash_by_command: { verify: commandConfigHash(testCommandProviderPolicy()) },
  });

  const declaredRound = (value: ReturnType<typeof itemContract>): VaultEntry =>
    committedFeedbackRound(1, {
      loopId: "test-loop",
      contract: value,
      contractBinding: bindingFor(value),
    });

  const priorDebt = (contract: ReturnType<typeof itemContract>, round: number): VaultEntry =>
    committedFeedbackRound(round, {
      loopId: "test-loop",
      contract,
      contractBinding: bindingFor(contract),
      verificationFlags: [{
        severity: "warn", field: "round_contract",
        check: CHECK_CONTRACT_ITEMS_UNVERIFIED, detail: "debt",
      }],
    });

  const debtFlag = (): VerificationResult =>
    makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn",
        field: "round_contract",
        check: CHECK_CONTRACT_ITEMS_UNVERIFIED,
        detail: "1 contract item(s) claimed met but not machine-verified: rci-1",
      })],
    });

  const scopeDriftFlag = (): VerificationResult =>
    makeVerificationResult({
      verdict: "suspect",
      flags: [makeVerificationFlag({
        severity: "warn", field: "round_contract",
        check: "round_scope_drift", detail: "files changed outside scope",
      })],
    });

  it("verification debt does not reject below the configured streak", () => {
    const result = enforceRound(se({ success: false }), debtFlag(), 2, [
      declaredRound(itemContract()),
    ], 0);
    assert.equal(result.action, "accept");
  });

  it("verification debt rejects once the streak reaches the limit", () => {
    const contract = itemContract();
    const result = enforceRound(se({ success: false }), debtFlag(), 4, [
      declaredRound(contract), priorDebt(contract, 2), priorDebt(contract, 3),
    ], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "contract_items_unverified");
    assert.match(result.fix_instructions, /bound command/);
  });

  it("repeated verification debt terminates as incomplete", () => {
    // v3.8.1: the streak must belong to THIS check — the same rule every
    // uniform row applies. An unrelated streak is covered below.
    const contract = itemContract();
    const result = enforceRound(se({ success: false }), debtFlag(), 4, [
      declaredRound(contract), priorDebt(contract, 2), priorDebt(contract, 3),
    ], 2, "contract_items_unverified");
    assert.equal(result.action, "terminate");
    assert.equal(result.stopReason, "incomplete");
  });

  it("v3.8.1: an unrelated rejection streak cannot terminate verification debt", () => {
    // `consecutiveRejections` is reset whenever the check changes, so it only
    // measures one check's streak. Reading the bare counter let a streak
    // earned by a DIFFERENT check turn this row's FIRST appearance into a
    // termination as `incomplete`.
    const contract = itemContract();
    const result = enforceRound(se({ success: false }), debtFlag(), 4, [
      declaredRound(contract), priorDebt(contract, 2), priorDebt(contract, 3),
    ], 2, "required_command_failed");
    assert.equal(result.action, "reject",
      "the first appearance of this check must reject, not terminate");
    assert.equal(result.check, "contract_items_unverified");
  });

  it("v3.8.1: the escalation notice is appended exactly once", () => {
    // The handler owns this row's ladder; the uniform block used to apply the
    // ladder again, so one fix_instructions carried the notice twice.
    const contract = itemContract();
    const result = enforceRound(se({ success: false }), debtFlag(), 4, [
      declaredRound(contract), priorDebt(contract, 2), priorDebt(contract, 3),
    ], 1, "contract_items_unverified");
    assert.equal(result.action, "reject");
    const appearances = result.fix_instructions.split("Human Decision Required").length - 1;
    assert.equal(appearances, 1, "the escalation notice must not be duplicated");
  });

  it("scope drift rejects even without an explanation (v3.8: machine fact)", () => {
    const result = enforceRound(se({ success: false }), scopeDriftFlag(), 3, [], 0);
    assert.equal(result.action, "reject");
    assert.equal(result.check, "round_scope_drift");
  });

  it("repeated scope drift terminates", () => {
    const result = enforceRound(
      se({ success: false }), scopeDriftFlag(), 3, [], 2, "round_scope_drift");
    assert.equal(result.action, "terminate");
    assert.equal(result.check, "round_scope_drift");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.7 — behavior-equality compatibility matrix
//
// Transcribed from the v3.6 enforcement semantics BEFORE the convergence
// merge (one rule per posture + uniform escalation). It locks the decision
// level — accept / reject / backtrack / terminate — of every surviving rule
// across strike counts and policy switches, so the v3.7 merge must produce
// the same action for the same input. Reason text may differ; actions must
// not. Rows pass gate-shaped flags: the flag set a real round would carry.
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.7 — behavior-equality compatibility matrix", () => {
  afterEach(() => resetPolicy());

  const flag = (severity: "info" | "warn" | "error", check: string): VerificationFlag =>
    makeVerificationFlag({
      severity,
      field: "success",
      check,
      detail: `detail for ${check}`,
    });

  const okEval = (): SelfEvaluation => se({
    execution_report: makeExecutionReport({
      files_changed: ["src/foo.ts"],
      tests_reported: { passed: 1, failed: 0, skipped: 0 },
    }),
  });

  /** Flat 3-round progress window (rounds 1-3), the current round is 4. */
  const stallVault = (): VaultEntry[] => [
    vaultRound(1, []),
    vaultRound(2, []),
    vaultRound(3, []),
  ];

  /** Vault with a backtrack committed for the CURRENT round (deadlock). */
  const deadlockVault = (round: number): VaultEntry[] => [
    ...stallVault(),
    committedBacktrackRound(round),
  ];

  const withPolicy = (
    mutate: (p: LoopPolicy) => void,
    run: () => "accept" | "reject" | "terminate" | "backtrack",
  ): string => {
    const p = structuredClone(getPolicy());
    mutate(p);
    setPolicyForTest(p);
    return run();
  };

  type MatrixCase = {
    name: string;
    selfEval?: SelfEvaluation;
    flags?: VerificationFlag[];
    round?: number;
    vault?: VaultEntry[];
    strikes?: number;
    streak?: number;
    /** L4: check that was rejected in the previous round (own-streak basis).
     *  Defaults to the case's own check when strikes are set — the realistic
     *  same-issue streak shape the coordinator maintains. */
    lastCheck?: string;
    policy?: (p: LoopPolicy) => void;
    /** v3.8.3: the coordinator's scope-drift waiver verdict (blocked round +
     *  a proposal whose scope covers every drifted file). */
    driftWaiver?: boolean;
    expected: "accept" | "reject" | "terminate" | "backtrack";
    check?: string;
  };

  const CASES: MatrixCase[] = [
    // ── clean rounds ─────────────────────────────────────────────────────────
    { name: "clean round accepts", expected: "accept" },

    // ── success_with_remaining_criteria (uniform ladder) ────────────────────
    { name: "R1 first strike rejects", flags: [flag("error", "success_with_remaining_criteria")], expected: "reject", check: "success_with_remaining_criteria" },
    { name: "R1 second strike rejects", flags: [flag("error", "success_with_remaining_criteria")], strikes: 1, expected: "reject" },
    { name: "R1 third strike terminates", flags: [flag("error", "success_with_remaining_criteria")], strikes: 2, expected: "terminate" },

    // ── recurring_violation (uniform ladder) ─────────────────────────────────
    { name: "R2 first strike rejects", flags: [flag("error", "recurring_violation")], expected: "reject" },
    { name: "R2 third strike terminates", flags: [flag("error", "recurring_violation")], strikes: 2, expected: "terminate" },

    // ── evidence contradiction family (uniform ladder) ──────────────────────
    { name: "required command failed rejects", flags: [flag("error", "required_command_failed")], expected: "reject", check: "required_command_failed" },
    { name: "command evidence mismatch rejects", flags: [flag("error", "command_evidence_mismatch")], expected: "reject", check: "command_evidence_mismatch" },
    { name: "outcome success contradiction (error arm) rejects", flags: [flag("error", "outcome_success_contradiction")], expected: "reject", check: "outcome_success_contradiction" },
    { name: "outcome contradiction warn arm is not enforced (accept)", flags: [flag("warn", "outcome_success_contradiction")], expected: "accept" },
    { name: "evidence contradiction third strike terminates", flags: [flag("error", "required_command_failed")], strikes: 2, expected: "terminate" },

    // ── verification_entrypoint_modified ─────────────────────────────────────
    { name: "entrypoint tampered rejects", flags: [flag("error", "verification_entrypoint_modified")], expected: "reject", check: "verification_entrypoint_modified" },
    { name: "entrypoint tampered wins over a legacy success-evidence flag", flags: [flag("error", "verification_entrypoint_modified"), flag("error", "success_without_verified_evidence")], expected: "reject", check: "verification_entrypoint_modified" },
    // v3.8.3: the row owns its ladder. A frozen round baseline means asking
    // again cannot fix a rewritten entrypoint, so the second occurrence rolls
    // the work back instead of terminating the loop.
    { name: "entrypoint tampered second strike backtracks",
      flags: [flag("error", "verification_entrypoint_modified")], strikes: 1,
      expected: "backtrack", check: "verification_entrypoint_modified" },
    { name: "entrypoint tampered second strike terminates when backtrack disabled",
      flags: [flag("error", "verification_entrypoint_modified")], strikes: 1,
      policy: (p) => { p.engine.backtrack_enabled = false; },
      expected: "terminate", check: "verification_entrypoint_modified" },
    { name: "entrypoint tampered terminates when a backtrack already committed for this round",
      flags: [flag("error", "verification_entrypoint_modified")], strikes: 1,
      vault: deadlockVault(4), round: 4,
      expected: "terminate", check: "verification_entrypoint_modified" },

    // ── contract closure family (internal ladders) ───────────────────────────

    // ── success evidence (R8 removed in v3.9.1) ──────────────────────────────
    // The empty-report arm is now a warn and has no enforcement row; report
    // coverage is not an acceptance gate. The claims-arm info flag still
    // accepts, and an unbacked success is excluded from the trajectory.
    { name: "success-evidence warn flag is not enforced",
      flags: [flag("warn", "success_without_verified_evidence")],
      expected: "accept" },
    { name: "no_change_reason claims-arm info flag accepts",
      flags: [flag("info", "success_without_verified_evidence")],
      expected: "accept" },

    // ── round_scope_drift (v3.8: machine fact, no clarification waiver) ─────
    { name: "scope drift rejects",
      selfEval: okEval(), flags: [flag("warn", "round_scope_drift")], expected: "reject", check: "round_scope_drift" },
    { name: "scope drift third strike terminates",
      selfEval: okEval(),
      flags: [flag("warn", "round_scope_drift")], strikes: 2, expected: "terminate" },
    // v3.8.3: the legal exit. The coordinator has already verified that the
    // round declares blocked AND that its proposal's scope covers every
    // drifted file — what arrives here is that verdict, not a hint.
    { name: "scope drift waived by a covering blocked contract is accepted",
      selfEval: se({ outcome: "blocked", should_continue: false }),
      flags: [flag("warn", "round_scope_drift")], driftWaiver: true, expected: "accept" },
    { name: "the waiver holds after the streak would have terminated",
      selfEval: se({ outcome: "blocked", should_continue: false }),
      flags: [flag("warn", "round_scope_drift")], strikes: 2,
      driftWaiver: true, expected: "accept" },
    { name: "an identical round without the waiver still rejects",
      selfEval: se({ outcome: "blocked", should_continue: false }),
      flags: [flag("warn", "round_scope_drift")], expected: "reject", check: "round_scope_drift" },
    // v3.8.3: a first-time occurrence is no longer converted into termination
    // by a streak another check earned.
    { name: "first scope drift after two foreign rejections still rejects",
      selfEval: okEval(),
      flags: [flag("warn", "round_scope_drift")], strikes: 2,
      lastCheck: "success_without_verified_evidence",
      expected: "reject", check: "round_scope_drift" },
    { name: "first stall after two foreign rejections rejects rather than terminating",
      selfEval: se({ execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"]}) }),
      vault: stallVault(), round: 4, strikes: 2,
      lastCheck: "round_scope_drift",
      expected: "reject", check: "progress_stall" },
    { name: "max_rejections still escalates on the shared counter",
      selfEval: okEval(), strikes: 2, lastCheck: "something_else",
      expected: "reject", check: "max_rejections" },

    // ── progress stall (single evaluator after merge) ────────────────────────
    { name: "flat window first strike rejects",
      selfEval: se({ execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"]}) }),
      vault: stallVault(), round: 4, expected: "reject", check: "progress_stall" },
    { name: "flat window second strike backtracks (escalation + backtrack)",
      selfEval: se({ execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"]}) }),
      vault: stallVault(), round: 4, strikes: 1, expected: "backtrack", check: "progress_stall" },
    { name: "flat window third strike terminates",
      selfEval: se({ execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"]}) }),
      vault: stallVault(), round: 4, strikes: 2, expected: "terminate", check: "progress_stall" },
    { name: "stall deadlock guard terminates instead of re-backtracking",
      selfEval: se({ execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"]}) }),
      vault: deadlockVault(4), round: 4, strikes: 1, expected: "terminate", check: "progress_stall" },
    { name: "flat window terminates on second strike when escalation disabled",
      selfEval: se({ execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"]}) }),
      vault: stallVault(), round: 4, strikes: 1,
      policy: (p) => { p.engine.enforcement_escalation_enabled = false; },
      expected: "terminate", check: "progress_stall" },
    { name: "flat window rejects with notice on second strike when backtrack disabled",
      selfEval: se({ execution_report: makeExecutionReport({ files_changed: ["src/foo.ts"]}) }),
      vault: stallVault(), round: 4, strikes: 1,
      policy: (p) => { p.engine.backtrack_enabled = false; },
      expected: "reject", check: "progress_stall" },

    // ── user_gate_unresolved (uniform ladder, own-streak from L4) ───────────
    { name: "user gate first strike rejects",
      flags: [flag("error", "user_gate_unresolved")], expected: "reject", check: "user_gate_unresolved" },
    { name: "user gate cited after unrelated rejections rejects, not terminates",
      // Two fake-success rejections preceded this round — a streak the gate
      // check never earned must not convert its first occurrence into
      // termination: the agent must get the approval instructions.
      flags: [flag("error", "user_gate_unresolved")], strikes: 2,
      lastCheck: "success_with_remaining_criteria",
      expected: "reject", check: "user_gate_unresolved" },
    { name: "user gate third own strike terminates",
      flags: [flag("error", "user_gate_unresolved")], strikes: 2,
      lastCheck: "user_gate_unresolved",
      expected: "terminate", check: "user_gate_unresolved" },

    // ── warn-only flags never enforce ────────────────────────────────────────
    { name: "warn-only flag set accepts", flags: [flag("warn", "criteria_claims_unverified"), flag("warn", "contract_premature")], expected: "accept" },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      // L4: same-issue streaks are the realistic shape — the coordinator
      // resets the counter when the rejection check changes, and uniform
      // rows now escalate on their OWN streak (lastRejectionCheck basis).
      const lastCheck = c.lastCheck ??
        (c.strikes ? c.check ?? c.flags?.[0]?.check ?? "" : "");
      const run = (): "accept" | "reject" | "terminate" | "backtrack" => {
        const flags = c.flags ?? [];
        const verdict = flags.some((f) => f.severity === "error")
          ? "contradicted"
          : flags.some((f) => f.severity === "warn") ? "suspect" : "trusted";
        const verify = makeVerificationResult({ verdict, flags });
        const result = enforceRound(
          c.selfEval ?? okEval(),
          verify,
          c.round ?? 2,
          c.vault ?? [],
          c.strikes ?? 0,
          lastCheck,
          c.driftWaiver ?? false,
          { state: "unchanged", providers: ["git"] },
        );
        return result.action;
      };
      const action = c.policy ? withPolicy(c.policy, run) : run();
      assert.equal(action, c.expected, c.name);
      if (c.check) {
        // Lock rows that carry a stable check id assert it; rows whose id may
        // legitimately change across the merge assert actions only.
        const result = enforceRound(
          c.selfEval ?? okEval(),
          makeVerificationResult({
            verdict: "contradicted",
            flags: c.flags ?? [],
          }),
          c.round ?? 2,
          c.vault ?? [],
          c.strikes ?? 0,
          lastCheck,
          false,
          { state: "unchanged", providers: ["git"] },
        );
        assert.equal(result.check, c.check, `${c.name}: check id`);
      }
    });
  }
});
