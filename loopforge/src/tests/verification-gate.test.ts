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
import {
  committedFeedbackRound as committedRound,
  criterionClaims,
  deltasFrom,
  fixtureEvidencePosture,
  testCommandProvider,
} from "./_helpers.js";
import { ROUND_TRANSACTION_SCHEMA_VERSION } from "../round-transaction.js";
import type { EntrypointDrift } from "../evidence-provider.js";
import { verifySelfEvaluation as rawVerifySelfEvaluation, deriveEvidenceStatus, CHECK_VERIFICATION_ENTRYPOINT_MODIFIED, CHECK_TEST_FILES_MODIFIED, CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE } from "../verification-gate.js";
import {
  deriveProgressWindow,
} from "../progress.js";
import { derivationRounds } from "../committed-round.js";
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
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files,
    data: {
      dirty: files,
      fingerprints: Object.fromEntries(files.map((file) => [file, "m:1"])),
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

function se(overrides: Partial<SelfEvaluation> = {}): SelfEvaluation {
  return makeSelfEvaluation({
    outcome: "partial",
    output_summary: "Task completed.",
    constraint_violations: [],
    should_continue: true,
    execution_report: makeExecutionReport({
      files_changed: ["src/a.ts"],

      // v4.0.3: no default criterion claim; a claim needs a machine fact.
    }),
    ...overrides,
  });
}

/** v4.0.6: A passed/failed after-phase command snapshot. Command observations
 *  are the test fact; there is no Agent-reported test count to compare. */
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
 *  An unbacked success claim is insufficient observation, so tests that assert
 *  unrelated checks pass a passed command snapshot. */
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
  gateEntries: VaultEntry[] = [],
  /** v3.8.3: the trusted entrypoint baseline drift the coordinator derives. */
  entrypointDrift: EntrypointDrift[] = [],
): ReturnType<typeof rawVerifySelfEvaluation> {
  return rawVerifySelfEvaluation(
    selfEval,
    currentRound,
    vaultEntries,
    prevSelfEval,
    deltasFrom(evidenceSnapshots),
    gateEntries,
    entrypointDrift,
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
    loop_lineage: { round, outcome: "success", task: "test task" },
    constraint_violations: violations,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Happy path
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — happy path", () => {
  it("trusted verdict when all checks pass with consistent data", () => {
    const curr = se({
      outcome: "failed",
      execution_report: makeExecutionReport({
        files_changed: ["src/foo.ts"],

        claims: criterionClaims([], ["tests"]),
      }),
      constraint_violations: ["deadline"],
      discovered_constraints: ["new: must handle null"],
    });

    const prev = se({
      outcome: "failed",
      execution_report: makeExecutionReport({
        files_changed: ["src/bar.ts"],

        claims: criterionClaims([], ["impl", "tests"]),
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
  it("flags when outcome=success but criteria remain unmet", () => {
    const curr = se({
      outcome: "success",
      execution_report: makeExecutionReport({
        claims: criterionClaims(["builds"], ["tests pass", "docs updated"]),
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null);
    assert.equal(result.verdict, "contradicted");
    const flag = result.flags.find((f) => f.check === "success_with_remaining_criteria");
    assert.ok(flag);
    assert.equal(flag.severity, "error");
    assert.ok(flag.detail.includes("criteria remain unmet"));
  });

  it("flags met criteria that no machine fact backs, even with no contract", () => {
    const curr = se({
      outcome: "success",
      execution_report: makeExecutionReport({
        claims: criterionClaims(["builds", "tests pass"], []),

        files_changed: ["src/a.ts"],
      }),
    });

    const result = verifySelfEvaluation(curr, 3, [], null, [gitSnap(), cmdSnap("passed")]);
    assert.equal(result.verdict, "suspect");
    assert.ok(result.flags.some(
      (flag) => flag.check === "criteria_claims_unverified"));
  });

  it("does not flag when success is false even with remaining criteria", () => {
    const curr = se({
      outcome: "failed",
      execution_report: makeExecutionReport({
        claims: criterionClaims([], ["tests pass"]),
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
    // The committed evaluations carry each round's own violations.
    const withViolations = (
      round: number,
      violations: string[],
    ): VaultEntry => {
      const entry = committedRound(round, { loopId: "test-loop" });
      const transaction = entry.loop_lineage!.round_transaction as Record<string, unknown>;
      const snapshot = transaction.snapshot as Record<string, unknown>;
      (snapshot.evaluation as Record<string, unknown>).constraint_violations = violations;
      return entry;
    };
    const vault = [
      withViolations(1, ["deadline"]),
      withViolations(2, ["deadline", "other"]),
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

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: Tri-state outcome consistency + retroactive claims
// ═══════════════════════════════════════════════════════════════════════════

describe("verification-gate — v2.12 outcome consistency", () => {
  it("outcome=partial suppresses the success-class checks", () => {
    const curr = se({
      outcome: "partial",
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],
        claims: criterionClaims([], ["tests pass"]),
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.ok(!result.flags.some((f) => f.check === "success_with_remaining_criteria"));
    assert.equal(result.verdict, "trusted");
  });

  it("outcome=blocked is the ONE blocked declaration", () => {
    const curr = se({
      outcome: "blocked",
      blocker: "missing credentials",
      should_continue: false,
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    // The strict submission boundary owns blocker completeness; the gate
    // performs no second blocked-without-blocker judgment.
    assert.ok(!result.flags.some((f) => f.check === "blocked_without_blocker"));
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
      task_type: "feedback",
      loop_lineage: {
        round: 1,
        round_transaction: {
          schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
          round_id: "loop:test-loop:round:1",
          snapshot: {
            schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
            kind: "evaluation" as const,
            branchId: "loop:test-loop:branch:root",
            transactionId: "tx-test-loop-1-1",
            roundId: "loop:test-loop:round:1",
            loopId: "test-loop",
            round: 1,
            attempt: 1,
            phase: "committed" as const,
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
                head: "abc",
                coverage: "tracked_and_non_ignored_untracked",
              },
            }],
            beforeCheckpointError: {
              code: "fixture_unavailable",
              detail: "test fixture",
              at: 0,
            },
            afterEvidence: [{
              schemaVersion: 2,
              providerId: "git",
              kind: "git",
              phase: "after",
              startedAt: 0,
              finishedAt: 0,
              status: "observed",
              files: ["src/fixed.ts"],
              data: {
                dirty: ["src/fixed.ts"],
                fingerprints: { "src/fixed.ts": "m:1" },
                head: "abc",
                coverage: "tracked_and_non_ignored_untracked",
              },
            }],
            operatorAcceptance: {
              task: "Verification task",
              success_criteria: [],
              hard_constraints: [],
            },
            compiled: {
              task: "Verification task",
              goalId: "test-loop:verification-task",
              constraintsActive: [],
              constraintsRetired: [],
            },
            submittedFields: [
              "outcome", "output_summary", "constraint_violations", "should_continue",
            ],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          result: {
            action: "continue",
            verificationFlags: [],
            agentSuccessClaim: false,
            agentOutcome: "failed",
            evidencePosture: fixtureEvidencePosture(1),
          },
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
      outcome: "failed",
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],

        claims: criterionClaims(["tests pass", "docs updated"], []),
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    const flag = result.flags.find((f) => f.check === "criteria_claims_unverified");
    assert.ok(flag);
    assert.equal(flag.severity, "warn");
  });

  it("Agent-reported test counts never back a criterion claim", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],

        claims: criterionClaims(["tests pass"], []),
      }),
    });
    const result = verifySelfEvaluation(curr, 2, [], null);
    assert.ok(result.flags.some(
      (flag) => flag.check === "criteria_claims_unverified"),
      "tests_reported is a claim, not a machine criterion fact");
  });

  it("stays silent when no criteria are reported met", () => {
    const curr = se({
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],

        claims: criterionClaims([], ["tests pass"]),
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
    const status = deriveEvidenceStatus(se(), deltasFrom([gitSnap(["src/a.ts"])]));
    assert.equal(status.providerStatus, "unavailable");
    assert.equal(status.gitChangeState, "observed");
  });

  it("git snapshot present but no changes → observed boundary, unavailable verification", () => {
    const status = deriveEvidenceStatus(se(), deltasFrom([gitSnap([])]));
    assert.equal(status.providerStatus, "unavailable");
    assert.equal(status.gitChangeState, "observed",
      "an observed empty boundary is not the same as an unobservable one");
  });

  it("no snapshots → absent", () => {
    const status = deriveEvidenceStatus(se(), []);
    assert.equal(status.providerStatus, "absent");
  });

  it("passed after-command → verified", () => {
    const selfEval = se({
      execution_report: makeExecutionReport({
        files_changed: [],

      }),
    });
    const status = deriveEvidenceStatus(selfEval, deltasFrom([cmdSnap("passed")]));
    assert.equal(status.providerStatus, "verified");
    assert.equal(status.commandVerified, true);
  });

  it("failed after-command → unavailable", () => {
    const status = deriveEvidenceStatus(se(), deltasFrom([cmdSnap("failed")]));
    assert.equal(status.providerStatus, "unavailable");
  });
});



// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — machineProgressSeries (R4/R5 heuristic-path fallback)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — machineProgressSeries", () => {
  const machineProgressSeries = (
    entries: VaultEntry[],
    currentRound: number,
    lookback: number,
  ) => deriveProgressWindow(
    derivationRounds(entries, currentRound),
    currentRound,
    lookback,
  );
  const feedbackRound = (
    round: number,
    changedFiles: string[],
    beforeHead: string,
    afterHead: string,
  ): VaultEntry => {
    const fingerprints = Object.fromEntries(
      changedFiles.map((file) => [file, "m:1"]),
    );
    return committedRound(round, {
      loopId: "mp",
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
        startedAt: 0, finishedAt: 0, status: "observed", files: changedFiles,
        data: {
          dirty: changedFiles, fingerprints, head: afterHead,
          coverage: "tracked_and_non_ignored_untracked",
        },
      }],
    });
  };

  it("reports per-round git observations for the lookback window", () => {
    const window = machineProgressSeries(
      [
        feedbackRound(1, ["a.ts"], "h0", "h1"),
        feedbackRound(2, [], "h1", "h1"),
        feedbackRound(3, ["b.ts"], "h1", "h2"),
      ],
      4,
      3,
    );
    assert.equal(window.state, "changed");
    assert.deepEqual(
      window.roundStates.map((entry) => entry.state),
      ["changed", "unchanged", "changed"],
    );
  });

  it("is unknown when fewer than lookback rounds carry git snapshots", () => {
    const window = machineProgressSeries(
      [feedbackRound(1, [], "h0", "h1"), feedbackRound(2, [], "h1", "h1")],
      4,
      3,
    );
    assert.equal(window.state, "unknown");
  });

  it("is unknown when the recent rounds are not contiguous", () => {
    const window = machineProgressSeries(
      [feedbackRound(1, [], "h0", "h1"), feedbackRound(3, [], "h1", "h1")],
      4,
      2,
    );
    assert.equal(window.state, "unknown");
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
    const status = deriveEvidenceStatus(se(), deltasFrom([git, cmd]));
    assert.equal(status.providerStatus, "unavailable");
    assert.equal(status.commandVerified, false);
  });

  it("entrypoint drift is flagged even when git cannot see the file", () => {
    // v3.8.3: the absolute arm. A gitignored entrypoint appears in no git
    // diff, so the delta rule alone reads a rewritten script as untouched.
    // The trusted round-start baseline is the fact that answers it.
    const cmd = cmdSnap("passed", { entrypointFiles: ["verify.js"] });
    const result = verifySelfEvaluation(
      se(), 2, [], null, [cmd], [],
      [{ file: "verify.js", roundStart: "present" }],
    );
    const flag = result.flags.find((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED);
    assert.ok(flag, "drift must be flagged without a git observation");
    assert.match(flag!.detail, /"verify\.js" was present/);
  });

  it("states when the entrypoint did not exist at round start", () => {
    // The case the old message could not describe: "keep it unchanged" is not
    // an instruction the agent can act on for a file the round created.
    const cmd = cmdSnap("passed", { entrypointFiles: ["verify.js"] });
    const result = verifySelfEvaluation(
      se(), 2, [], null, [cmd], [],
      [{ file: "verify.js", roundStart: "absent" }],
    );
    const flag = result.flags.find((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED);
    assert.ok(flag);
    assert.match(flag!.detail, /"verify\.js" did not exist/);
  });

  it("no drift and no git observation stays silent", () => {
    const cmd = cmdSnap("passed", { entrypointFiles: ["verify.js"] });
    const result = verifySelfEvaluation(se(), 2, [], null, [cmd]);
    assert.equal(
      result.flags.some((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED),
      false,
    );
  });

  it("test files changed in the same round → warn, command stays usable", () => {
    const git = gitSnap(["src/a.test.ts"]);
    const cmd = cmdSnap("passed");
    const result = verifySelfEvaluation(se(), 2, [], null, [git, cmd]);
    const flag = result.flags.find((f) => f.check === CHECK_TEST_FILES_MODIFIED);
    assert.ok(flag, "test-file change must be flagged");
    assert.equal(flag!.severity, "warn");
    // TDD flow: the passed command still backs the success.
    const status = deriveEvidenceStatus(se(), deltasFrom([git, cmd]));
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

  it("v3.8.1: a tampered entrypoint is found behind an earlier test-file-only command", () => {
    // `testFilesModified` comes from the git file set alone, so it is true for
    // EVERY command as soon as the round touched a test file. Returning that
    // warn on the first command in array order hid a rewritten verification
    // entrypoint in a later one: the error flag never existed, so the
    // enforcement row that reacts to it never fired, and the round could be
    // accepted on a "machine observation" the agent had just rewritten.
    const git = gitSnap(["src/a.test.ts", "run-tests.sh"]);
    const unitOnly = cmdSnap("passed", { commandId: "unit", entrypointFiles: ["other.sh"] });
    const tampered = cmdSnap("passed", { commandId: "e2e", entrypointFiles: ["run-tests.sh"] });

    const result = verifySelfEvaluation(se(), 2, [], null, [git, unitOnly, tampered]);
    const flag = result.flags.find((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED);
    assert.ok(flag, "the tampered entrypoint must be reported whatever the observation order");
    assert.equal(flag!.severity, "error");

    // The verdict cannot depend on which command the array happened to list first.
    const reversed = verifySelfEvaluation(se(), 2, [], null, [git, tampered, unitOnly]);
    assert.ok(reversed.flags.some((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED));
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
    items: [{ description: "login works", criterion_refs: [], verify_with: ["run-tests"] }],
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
    itemIds(value).map((id) => ({ id, outcome: "met" as const }));

  it("contract_items_unverified: claimed met without a passing command → warn", () => {
    withRunTestsConfigured();
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({
        execution_report: makeExecutionReport({ claims: claimsMet(contract) }),
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

  it("v3.9.4: contract_items_unverified names EVERY insufficient item", () => {
    withRunTestsConfigured();
    const contract = itemContract({
      items: Array.from({ length: 5 }, (_, index) => ({
        description: `slice ${index}`,
        criterion_refs: [],
        verify_with: ["run-tests"],
      })),
    });
    const result = verifySelfEvaluation(
      se({
        execution_report: makeExecutionReport({ claims: claimsMet(contract) }),
      }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/auth/a.ts"])],
    );
    const flag = result.flags.find((f) => f.check === CHECK_CONTRACT_ITEMS_UNVERIFIED);
    assert.ok(flag);
    for (const itemId of itemIds(contract)) {
      assert.ok(flag!.detail.includes(itemId),
        `the debt detail must name ${itemId}`);
    }
  });

  it("contract_items_unverified: silent when the bound command passed", () => {
    withRunTestsConfigured();
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({
        execution_report: makeExecutionReport({ claims: claimsMet(contract) }),
      }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/auth/a.ts"]), cmdSnap("passed", { commandId: "run-tests", configHash: declaredHash() })],
    );
    assert.ok(!result.flags.some((f) => f.check === CHECK_CONTRACT_ITEMS_UNVERIFIED));
  });

  it("round_scope_drift: files outside the declared scope → info report only", () => {
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({ outcome: "failed", execution_report: makeExecutionReport({ files_changed: ["src/other.ts"] }) }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/other.ts"])],
    );
    const flag = result.flags.find((f) => f.check === CHECK_ROUND_SCOPE_DRIFT);
    assert.ok(flag);
    assert.equal(flag!.severity, "info");
    assert.match(flag!.detail, /report only; this does not block the round/);
    assert.equal(result.verdict, "trusted",
      "an info fact does not even make the round suspect");
  });

  it("round_scope_drift: silent when the active contract declares no scope", () => {
    const contract = itemContract({ scope: [] });
    const result = verifySelfEvaluation(
      se({ outcome: "failed", execution_report: makeExecutionReport({ files_changed: ["src/other.ts"] }) }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/other.ts"])],
    );
    assert.ok(!result.flags.some((f) => f.check === CHECK_ROUND_SCOPE_DRIFT));
  });

  it("contract_premature: a different proposal while open → error", () => {
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({
        outcome: "failed",
        execution_report: makeExecutionReport({}),
        round_contract: itemContract({ work_item: "Slice B" }),
      }),
      2,
      [activeRound(contract)],
      null,
      [gitSnap(["src/auth/a.ts"])],
    );
    assert.ok(result.flags.some((f) =>
      f.check === CHECK_CONTRACT_PREMATURE && f.severity === "error"));
  });

  it("contract_premature: a restate is not flagged", () => {
    const contract = itemContract();
    const result = verifySelfEvaluation(
      se({
        outcome: "failed",
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
  it("maps every surviving CHECK_* constant into a domain", () => {
    const exports = verificationGate as unknown as Record<string, unknown>;
    const constants = Object.keys(exports)
      .filter((key) => key.startsWith("CHECK_") && typeof exports[key] === "string");
    assert.equal(constants.length, 18, "the surviving check set is 18");
    const domains = new Set<string>();
    for (const key of constants) {
      const id = exports[key] as string;
      const domain = CHECK_DOMAIN[id];
      assert.ok(domain, `check "${id}" has no domain`);
      domains.add(domain);
    }
    assert.deepEqual(
      [...domains].sort(),
      ["evaluation_consistency", "evidence_integrity", "plan_contract"],
      "the three populated domains",
    );
  });

  it("has no orphan domain entries and the expected domain sizes", () => {
    const counts: Record<string, number> = {};
    for (const domain of Object.values(CHECK_DOMAIN)) counts[domain] = (counts[domain] ?? 0) + 1;
    assert.equal(Object.keys(CHECK_DOMAIN).length, 18, "CHECK_DOMAIN covers exactly the 18 checks");
    assert.deepEqual(counts, {
      evaluation_consistency: 6,
      evidence_integrity: 6,
      plan_contract: 6,
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
      se({ gate_ids: [GATE_ID] }), 2, [], null, [cmdSnap("passed")],
      [openedGate(GATE_ID, agentActionJson)]);
    const flag = flagFor(result);
    assert.ok(flag, "an agent gate cannot satisfy a user citation");
    assert.match(flag!.detail, /not_user_gate/);
  });

  it("errors with not_approved when no approved decision exists", () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const result = verifySelfEvaluation(
      se({ gate_ids: [GATE_ID] }), 2, [], null, [cmdSnap("passed")], [
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
      se({ gate_ids: [GATE_ID] }), 2, [], null, [cmdSnap("passed")], [
        openedGate(GATE_ID, userActionJson),
        decision(GATE_ID, true),
      ]);
    assert.equal(flagFor(result), undefined, "approved gate satisfies the citation");
  });

  it("supports legacy flat-text user gates (blocked-round auto-records)", () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const legacyId = "gate-222222222222";
    const result = verifySelfEvaluation(
      se({ gate_ids: [legacyId] }), 2, [], null, [cmdSnap("passed")], [
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

describe("verification-gate — v3.9.1 success-evidence report gap (empty arm)", () => {
  afterEach(() => resetPolicy());

  const successNoEvidence = (overrides: Partial<SelfEvaluation> = {}): SelfEvaluation =>
    se({
      outcome: "success",
      execution_report: makeExecutionReport({
        files_changed: [],

      }),
      ...overrides,
    });

  const emptyArmFlag = (result: ReturnType<typeof rawVerifySelfEvaluation>) =>
    result.flags.find((f) =>
      f.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE && f.severity === "warn");

  it("does not treat an empty files_changed as a reporting gap (v4.0.6)", () => {
    const result = verifySelfEvaluation(successNoEvidence(), 2);
    assert.ok(!emptyArmFlag(result),
      "only a COMPLETELY missing execution_report is a report gap");
    assert.equal(result.verdict, "trusted");
  });

  it("warns when success=true carries no execution_report at all", () => {
    const bare = se({ outcome: "success" });
    (bare as unknown as Record<string, unknown>).execution_report = undefined;
    const result = verifySelfEvaluation(bare, 2);
    assert.equal(result.verdict, "suspect");
    const flag = emptyArmFlag(result);
    assert.ok(flag);
    assert.ok(flag.detail.includes("no execution_report"),
      `detail should say the report is missing, got: ${flag.detail}`);
  });

  it("keeps an execution_report present even when no_change_reason is declared", () => {
    const result = verifySelfEvaluation(
      successNoEvidence({ no_change_reason: "Nothing needed changing." }),
      2,
    );
    assert.equal(result.verdict, "trusted");
    assert.ok(!emptyArmFlag(result));
  });

  it("stays trusted when a machine command verified the round", () => {
    const result = verifySelfEvaluation(successNoEvidence(), 2, [], null, [cmdSnap("passed")]);
    assert.equal(result.verdict, "trusted");
    assert.ok(!emptyArmFlag(result));
  });

  it("stays silent when the declared outcome wins (outcome=partial suppresses the arm)", () => {
    const result = verifySelfEvaluation(successNoEvidence({ outcome: "partial" }), 2);
    assert.ok(!emptyArmFlag(result), "effectiveSuccess=false suppresses the whole check");
  });

  it("stays silent when execution_report is non-empty (claims arm owns the posture)", () => {
    const result = verifySelfEvaluation(
      se({
        outcome: "success",
        execution_report: makeExecutionReport({
          files_changed: ["src/foo.ts"],

        }),
      }),
      2,
      [], null, [cmdSnap("passed")],
    );
    assert.ok(!emptyArmFlag(result));
    assert.equal(result.verdict, "trusted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.2 — the shared files reconciliation
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.2 — evidence_integrity uses the shared reconciliation", () => {
  const withFiles = (files: string[]) => se({
    execution_report: makeExecutionReport({
      files_changed: files,

    }),
  });

  it("warns on a real mismatch", () => {
    const result = verifySelfEvaluation(
      withFiles(["src/a.ts"]), 2, [], null, [gitSnap(["src/b.ts"])],
    );
    assert.ok(result.flags.some((flag) => flag.check === "evidence_integrity"));
  });

  it("stays silent on a match", () => {
    const result = verifySelfEvaluation(
      withFiles(["src/a.ts"]), 2, [], null, [gitSnap(["src/a.ts"])],
    );
    assert.ok(!result.flags.some((flag) => flag.check === "evidence_integrity"));
  });

  it("stays silent on duplicate reported paths", () => {
    const result = verifySelfEvaluation(
      withFiles(["src/a.ts", "src/a.ts"]), 2, [], null, [gitSnap(["src/a.ts"])],
    );
    assert.ok(!result.flags.some((flag) => flag.check === "evidence_integrity"));
  });

  it("stays silent when the Git boundary is unknown", () => {
    const result = rawVerifySelfEvaluation(
      withFiles(["src/a.ts"]), 2, [], null, [{
        providerId: "git", kind: "git", before: null, after: null,
        changedFiles: null, progress: null,
      }],
    );
    assert.ok(!result.flags.some((flag) => flag.check === "evidence_integrity"));
  });

  it("v3.9.4: an omitted report with observed changes is the SAME mismatch the receipt reports", () => {
    const selfEval = se({ execution_report: undefined });
    const result = verifySelfEvaluation(
      selfEval, 2, [], null, [gitSnap(["src/a.ts"])],
    );
    const flag = result.flags.find((entry) => entry.check === "evidence_integrity");
    assert.ok(flag, "an omitted files_changed field is a reporting gap, not silence");
    assert.match(flag!.detail, /unreported: \[src\/a\.ts\]/);
  });

  it("stays silent when the report is absent and the Git boundary observed no change", () => {
    const selfEval = se({ execution_report: undefined });
    const result = verifySelfEvaluation(
      selfEval, 2, [], null, [gitSnap([])],
    );
    assert.ok(!result.flags.some((flag) => flag.check === "evidence_integrity"));
  });
});
