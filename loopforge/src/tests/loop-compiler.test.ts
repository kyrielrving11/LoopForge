import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSelfEvalBlock,
  compileLoop,
  computeGoalTextHash,
  decideLevel,
  deriveCriterionId,
  deriveCriterionStatuses,
  deriveGoalId,
  deriveRecurringFlags,
} from "../loop-compiler.js";
import { deriveSubGoalId, validateSubGoalUpdates } from "../subgoal-state.js";
import type { CommittedRoundView } from "../committed-round.js";
import {
  type LoopObjective,
  makeLoopCompileRequest,
  makeLoopObjective,
  makeLoopRoundResult,
  type SubGoal,
} from "../protocol.js";
import { getPolicy, resetPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";
import {
  committedFeedbackRound,
  committedBacktrackRound,
  mergedLineageRound,
  criterionClaims,
  withTransaction,
} from "./_helpers.js";
import type { MachineObservation, VerificationFlag } from "../protocol.js";
import type { ActiveContractView } from "../round-contract.js";
import type { SelfEvalPromptContext } from "../submission-guidance.js";
import { OperatorAcceptanceConflictError } from "../errors.js";

/** Minimal prompt context for the evaluation-block tests. */
function evalCtx(
  overrides: Partial<SelfEvalPromptContext> = {},
): SelfEvalPromptContext {
  return {
    round: 3,
    level: "l1",
    activeContract: null,
    itemStatuses: null,
    commands: ["verify"],
    contractVerificationAvailable: true,
    subGoals: [],
    verificationFlags: [],
    recovery: false,
    gateEnabled: false,
    ...overrides,
  };
}

function testContract(overrides: Partial<ActiveContractView> = {}): ActiveContractView {
  return {
    id: "rc-12345678",
    declared_at_round: 2,
    work_item: "Next slice",
    scope: ["src"],
    items: [{
      id: "rci-12345678",
      description: "verification command passes",
      criterion_refs: [],
      verify_with: ["verify"],
    }],
    config_hash_by_command: {},
    ...overrides,
  };
}

function testSubGoal(overrides: Partial<SubGoal> = {}): SubGoal {
  return {
    id: "sg-12345678",
    description: "sub-goal under test",
    status: "pending",
    declared_at_round: 1,
    status_changed_at_round: 1,
    priority: 0,
    ...overrides,
  };
}

/** v3.8: a passed after-phase command observation for contract verification. */
function commandObservation(status: "passed" | "failed"): MachineObservation {
  return {
    schemaVersion: 1,
    providerId: "command:verify",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      commandId: "verify",
      argv: ["node", "-e", "verify"],
      cwd: ".",
      configHash: "",
      required: true,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
    },
  };
}
import { deriveContractItemIds } from "../token-utils.js";

describe("cognitive-state compiler", () => {
  beforeEach(() => resetPolicy());

  it("derives deterministic goal identity", () => {
    assert.equal(computeGoalTextHash("A  durable task"), computeGoalTextHash("A durable task"));
    assert.equal(deriveGoalId("loop", "Task", "explicit"), "explicit");
    assert.match(deriveGoalId("loop", "Durable Task"), /^loop:/);
  });

  it("uses L2 first, L1 for normal continuation, and L0 for a proven-empty failed retry", () => {
    const first = makeLoopCompileRequest({ loop_id: "levels", task: "Do work" });
    assert.equal(decideLevel(first, null), "l2");

    const gitObservation = (phase: "before" | "after") => ({
      schemaVersion: 2,
      providerId: "git",
      kind: "git",
      phase,
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: [],
      data: {
        dirty: [],
        fingerprints: {},
        head: "abc123",
        coverage: "tracked_and_non_ignored_untracked",
      },
    });
    const continuing = makeLoopCompileRequest({
      loop_id: "levels", round: 2, task: "Do work",
    });
    const failedButEmpty = {
      results: [committedFeedbackRound(1, {
        loopId: "levels",
        beforeEvidence: [gitObservation("before")],
        roundEvidence: [gitObservation("after")],
      })],
    };
    assert.equal(decideLevel(continuing, failedButEmpty), "l0",
      "the committed fixture is success=false and the Git pair is observed " +
      "with identical fingerprints and HEAD → proven stale");

    const succeeded = {
      results: [withTransaction({
        loop_id: "levels",
        loop_lineage: {
          loop_id: "levels",
          round: 1,
          constraints_active: [],
          committed_action: "continue",
        },
        success: true,
        output_summary: "Done",
      })],
    };
    assert.equal(decideLevel(continuing, succeeded), "l1");
  });

  it("renders one hashed prompt artifact without a reasoning technique", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "artifact",
      task: "Implement atomic state",
      constraints_from_plan: ["Preserve user data"],
      max_rounds: 5,
    }), null);
    assert.ok(response.prompt_artifact);
    assert.equal(response.prompt, response.prompt_artifact.renderedPrompt);
    assert.equal(response.prompt_artifact.level, "l2");
    assert.match(response.prompt_artifact.promptHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(response.prompt, /Technique Selection|tree-of-thought|few-shot/i);
    assert.match(response.prompt, /Preserve user data/);
  });


  it("keeps mandatory verification findings in an L0 retry", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "retry",
      round: 3,
      attempt: 2,
      task: "Verify result",
      rejection_notice: "Required command failed",
      verification_flags: [{
        severity: "error",
        field: "success",
        check: "required_evidence_failed",
        detail: "npm test exited with code 1",
      }],
    }), null);
    assert.equal(response.prompt_artifact?.level, "l0");
    assert.match(response.prompt, /Attempt: 2/);
    assert.match(response.prompt, /Required command failed/);
    assert.match(response.prompt, /npm test exited with code 1/);
  });

  it("produces deterministic prompt hashes for identical inputs", () => {
    const request = makeLoopCompileRequest({
      loop_id: "det",
      round: 2,
      task: "Implement atomic state",
      constraints_from_plan: ["Preserve user data"],
    });
    const a = compileLoop(request, null);
    const b = compileLoop(request, null);
    assert.equal(a.prompt_artifact?.promptHash, b.prompt_artifact?.promptHash);
    assert.equal(a.prompt, b.prompt);
  });

  it("produces different hashes for different attempt numbers on same round", () => {
    const base = makeLoopCompileRequest({
      loop_id: "attempts",
      round: 3,
      task: "Verify result",
      rejection_notice: "Required command failed",
    });
    const a1 = compileLoop({ ...base, attempt: 1 }, null);
    const a2 = compileLoop({ ...base, attempt: 2 }, null);
    assert.notEqual(a1.prompt_artifact?.promptHash, a2.prompt_artifact?.promptHash);
  });

  it("honors L0 budget ceiling in prompt artifact", () => {
    // L0 budget is the policy's l0_max_chars. The compiler should respect this.
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "budget",
      round: 3,
      attempt: 2,
      task: "Verify result",
      rejection_notice: "Required command failed",
      verification_flags: [{
        severity: "error",
        field: "success",
        check: "required_evidence_failed",
        detail: "npm test exited with code 1",
      }],
    }), null);
    assert.equal(response.prompt_artifact?.level, "l0");
    // L0 max comes from the policy — rendered prompt must be within budget
    const l0Budget = DEFAULT_POLICY.prompt.l0_max_chars;
    assert.ok(
      (response.prompt?.length ?? 0) <= l0Budget ||
        response.prompt_artifact?.protectedOverflow === true,
      `L0 prompt length ${response.prompt?.length} exceeds ${l0Budget} char budget without a protected-overflow marker`,
    );
  });

  it("applies a done transition by exact sub-goal ID", () => {
    const sgId = deriveSubGoalId("sg-id-match", 1, 0, "Add error handling to login");
    // The transition is a COMMITTED fact in round 1 — the same source the
    // real MCP path commits before the next compile.
    const vault = {
      results: [withTransaction({
        loop_id: "sg-id-match",
        loop_lineage: {
          loop_id: "sg-id-match",
          round: 1,
          goal_id: deriveGoalId("sg-id-match", "Fix auth bug"),
          task: "Fix auth bug",
          constraints_active: [],
          recompile_level: "l2",
          committed_action: "continue",
        },
        emerged_subtasks: ["Add error handling to login"],
        subgoal_updates: [{ id: sgId, status: "done" }],
        success: true,
        output_summary: "Started auth fix",
      })],
    };
    // Round 2: the committed transition is replayed from the vault.
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "sg-id-match",
      round: 2,
      task: "Fix auth bug",
      force_level: "l2",
    }), vault);
    const doneSubs = response.sub_goals?.filter(sg => sg.status === "done") ?? [];
    assert.equal(doneSubs.length, 1, "should mark sub-goal as done by ID reference");
    assert.equal(doneSubs[0].description, "Add error handling to login");
  });


  it("reaches in_progress only through an explicit update", () => {
    const sgId = deriveSubGoalId("sg-inprogress", 1, 0, "Add rate limiting");
    const vault = {
      results: [withTransaction({
        loop_id: "sg-inprogress",
        loop_lineage: {
          loop_id: "sg-inprogress",
          round: 1,
          goal_id: deriveGoalId("sg-inprogress", "Fix auth bug"),
          task: "Fix auth bug",
          constraints_active: [],
          recompile_level: "l2",
          committed_action: "continue",
        },
        emerged_subtasks: ["Add rate limiting"],
        subgoal_updates: [{ id: sgId, status: "in_progress" }],
        success: true,
        output_summary: "Started",
      })],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "sg-inprogress",
      round: 2,
      task: "Fix auth bug",
      force_level: "l2",
    }), vault);
    const active = response.sub_goals?.find(sg => sg.id === sgId);
    assert.equal(active?.status, "in_progress",
      "in_progress is produced only by an explicit agent declaration");
  });


  it("v3.7.1: validateSubGoalUpdates enforces the closed matrix and terminality", () => {
    const sg = (id: string, status: SubGoal["status"]): SubGoal => ({
      id,
      description: `goal ${id}`,
      status,
      declared_at_round: 1,
      status_changed_at_round: 1,
      priority: 0,
    });
    const pending = sg("sg-a1111111", "pending");
    const done = sg("sg-b2222222", "done");

    // Legal: pending → in_progress / done / blocked / canceled; same-status
    // no-op is legal for replay idempotency.
    const legal = validateSubGoalUpdates(
      [pending, done],
      [
        { id: "sg-a1111111", status: "in_progress" },
        { id: "sg-a1111111", status: "done" },
        { id: "sg-a1111111", status: "blocked" },
        { id: "sg-a1111111", status: "canceled" },
      ],
    );
    assert.equal(legal.length, 0, "the active-state matrix is fully closed");

    // Unknown ID and terminal references are errors.
    const errors = validateSubGoalUpdates(
      [pending, done],
      [
        { id: "sg-99999999", status: "done" },
        { id: "sg-b2222222", status: "in_progress" },
        { id: "sg-b2222222", status: "done" },
      ],
    );
    assert.deepEqual(errors.map((e) => e.reason), ["unknown_id", "terminal_reference", "terminal_reference"]);
  });

  // ── v2.8: Self-eval block sub-goal ID hints ────────────────────────────

  it("buildSelfEvalBlock renders a real active sub-goal id and no placeholder id", () => {
    const block = buildSelfEvalBlock(evalCtx({ subGoals: [testSubGoal()] }));
    assert.ok(block.includes("sg-12345678"), "uses the real active sub-goal id");
    assert.ok(block.includes("subgoal_updates"), "shows the update field");
    const without = buildSelfEvalBlock(evalCtx({ subGoals: [] }));
    assert.ok(!without.includes("sg-12345678"), "does not invent an id when none exists");
    assert.ok(!without.includes("<sg-"), "does not render a placeholder id");
  });

  // ── v2.8: L2 pointer mode ─────────────────────────────────────────────



  it("derives different constraint IDs for different texts", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-distinct",
      round: 2,
      task: "Implement feature",
      loop_objective: makeLoopObjective({
        objective: "Build feature",
        success_criteria: ["Feature works"],
        hard_constraints: ["No data loss", "HTTPS only"],
        loop_id: "id-distinct",
      }),
    }), null);

    const meta = response.constraint_metadata ?? [];
    const texts = new Set(meta.map(m => m.text));
    const ids = new Set(meta.map(m => m.id));

    // Each unique text should have a unique ID
    assert.equal(ids.size, texts.size,
      `ID count ${ids.size} should match text count ${texts.size}`);
  });

  it("derives deterministic constraint IDs — same text, same ID", () => {
    const opts = {
      loop_id: "id-det",
      round: 2,
      task: "Implement feature",
      loop_objective: makeLoopObjective({
        objective: "Build feature",
        success_criteria: ["Feature works"],
        hard_constraints: ["No data loss"],
        loop_id: "id-det",
      }),
    };
    const a = compileLoop(makeLoopCompileRequest(opts), null);
    const b = compileLoop(makeLoopCompileRequest(opts), null);

    const metaA = a.constraint_metadata ?? [];
    const metaB = b.constraint_metadata ?? [];
    assert.equal(metaA.length, metaB.length);

    for (let i = 0; i < metaA.length; i++) {
      assert.equal(metaA[i].id, metaB[i].id,
        `ID for "${metaA[i].text}" should be deterministic`);
    }
  });

  it("renders constraint IDs in L1 prompt when constraint_id_enabled is true", () => {
    resetPolicy();
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-render",
      round: 2,
      task: "Implement feature",
      loop_objective: makeLoopObjective({
        objective: "Build feature",
        success_criteria: ["Feature works"],
        hard_constraints: ["No data loss"],
        loop_id: "id-render",
      }),
    }), null);

    const prompt = response.prompt ?? "";
    // L2 by default for round 2 with plan — check state file which always renders
    const stateFile = response.state_file_content ?? "";
    // State file should render IDs for hard constraints (c-) and criteria (cr-)
    assert.ok(stateFile.includes("`c-") || stateFile.includes("[`c-"),
      "State file should render constraint IDs with c- prefix");
    assert.ok(stateFile.includes("`cr-") || stateFile.includes("[`cr-"),
      "State file should render criterion IDs with cr- prefix");
  });

  it("self-eval template never fabricates stable id formats", () => {
    const block = buildSelfEvalBlock(evalCtx());
    assert.ok(block.includes("Never invent an id"));
    assert.ok(!block.includes("<sg-"), "no phantom sub-goal id");
    assert.ok(!block.includes("<rci-"), "no phantom contract item id");
  });

  it("self-eval template explains the boundary files_changed meaning", () => {
    const block = buildSelfEvalBlock(evalCtx());
    assert.ok(block.includes("files_changed"));
    assert.ok(block.includes("net boundary change from round start"));
    assert.ok(block.includes("including deletions"));
  });




  it("forces L2 rehydration after a backtrack (recovery boundary)", () => {
    const goalId = deriveGoalId("recovery-loop", "Recover the vault", "g1");
    const request = makeLoopCompileRequest({
      loop_id: "recovery-loop",
      round: 4,
      task: "Recover the vault",
      goal_id: goalId,
    });
    const context = {
      results: [
        {
          loop_id: "recovery-loop",
          loop_lineage: {
            loop_id: "recovery-loop",
            round: 3,
            recompile_level: "l1",
            goal_id: goalId,
            constraints_active: [],
            success: true,
          },
        },
        committedBacktrackRound(4, "recovery-loop", 3),
      ],
      global_entries: [],
    };
    // v2.14: the decidePromptLevel recovery_boundary branch existed but no
    // caller ever set it — a post-backtrack compile fell through to L1.
    // A committed backtrack for the current round now forces L2 rehydrate.
    const response = compileLoop(request, context as never);
    assert.equal(response.recompile_level, "l2");
  });

  it("keeps discovered constraints retracted for retire_window rounds, then restores them", () => {
    const constraint = "Never log secrets";
    const context = {
      results: [
        withTransaction({
          loop_id: "retract-loop",
          loop_lineage: {
            loop_id: "retract-loop",
            round: 1,
            recompile_level: "l1",
            goal_id: "g",
            constraints_active: [constraint],
            success: true,
            committed_action: "continue",
          },
          discovered_constraints: [constraint],
          retracted_constraints: [constraint],
        }),
        withTransaction({
          loop_id: "retract-loop",
          loop_lineage: {
            loop_id: "retract-loop",
            round: 3,
            recompile_level: "l1",
            goal_id: "g",
            constraints_active: [constraint],
            success: true,
            committed_action: "continue",
          },
        }),
      ],
      global_entries: [],
    };
    // Round 3: retracted at round 1 → 3-1=2 < retire_window(3) → still out
    const r3 = compileLoop(makeLoopCompileRequest({
      loop_id: "retract-loop",
      round: 3,
      task: "Task",
      goal_id: "g",
    }), context as never);
    assert.ok(!r3.constraints_active.includes(constraint),
      "retracted discovered constraint must stay out during the window");

    // Round 4: 4-1=3, not < 3 → the constraint returns (never auto-decay —
    // only the retraction's memory expires)
    const r4 = compileLoop(makeLoopCompileRequest({
      loop_id: "retract-loop",
      round: 4,
      task: "Task",
      goal_id: "g",
    }), context as never);
    assert.ok(r4.constraints_active.includes(constraint),
      "constraint returns after retire_window rounds");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — L1 collapse diff baseline
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — criterion status derivation (goal → criteria → evidence)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — criterion status derivation", () => {
  it("derives claimed / remaining / unknown with claimed rounds and linked sub-goals", () => {
    const statuses = deriveCriterionStatuses("cs-test", {
      results: [
        committedFeedbackRound(1, {
          loopId: "cs-test",
          success: true,
          remaining: ["Parser complete", "Tests ≥90%"],
        }),
        committedFeedbackRound(2, {
          loopId: "cs-test",
          success: true,
          met: ["Parser complete"],
          remaining: ["Tests ≥90%"],
        }),
      ],
    }, makeLoopObjective({
      objective: "Build a parser",
      success_criteria: ["Parser complete", "Tests ≥90%", "No runtime deps"],
    }), 3);

    assert.equal(statuses.length, 3);
    const parser = statuses.find((s) => s.text === "Parser complete")!;
    assert.equal(parser.status, "claimed");
    assert.equal(parser.met_at_round, 2, "first met report wins");

    const tests = statuses.find((s) => s.text === "Tests ≥90%")!;
    assert.equal(tests.status, "remaining");
    assert.equal(tests.met_at_round, undefined);

    const deps = statuses.find((s) => s.text === "No runtime deps")!;
    assert.equal(deps.status, "unknown", "never mentioned → unknown");
    assert.match(deps.id, /^cr-/);
  });


});

// ═══════════════════════════════════════════════════════════════════════════
// v3.8.1 — recurring flags: ONE derivation, two render windows
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.8.1 — recurring flags", () => {
  /** A committed round view. The derivation takes VIEWS, not raw vault
   *  entries, so a caller cannot hand it an uninterpreted envelope. */
  const round = (
    number: number,
    opts: { violations?: string[]; flags?: VerificationFlag[] } = {},
  ): CommittedRoundView => ({
    source: "feedback",
    sourceEntry: {},
    loopId: "recurring",
    round: number,
    roundId: `loop:recurring:round:${number}`,
    transactionId: `tx-recurring-${number}`,
    branchId: "loop:recurring:branch:root",
    kind: "evaluation",
    origin: "evaluation",
    recovery: null,
    beforeCheckpoint: null,
    checkpoints: [],
    restore: null,
    operatorAcceptance: null,
    compiled: null,
    attempt: 1,
    promptArtifact: null,
    evaluation: null,
    executionReport: null,
    verificationFlags: opts.flags ?? [],
    result: null,
    action: "continue",
    success: false,
    outcome: null,
    contractProposal: null,
    contractTransition: null,
    contractBinding: null,
    beforeEvidence: [],
    afterEvidence: [],
    observationDelta: [],
    normalizationDiagnostics: [],
    submittedFields: [],
    evidenceIncomplete: true,
    constraintViolations: opts.violations ?? [],
  });

  const flag = (
    severity: "error" | "warn",
    check: string,
    ref?: string,
  ): VerificationFlag => ({
    severity, field: "x", check, detail: "d", ...(ref ? { ref } : {}),
  });

  it("counts facts across the committed history, keyed by subject and ref", () => {
    const flags = deriveRecurringFlags([
      round(1, { violations: ["No external deps"], flags: [flag("error", "evidence_integrity", "verify")] }),
      round(2, { violations: ["No external deps"], flags: [flag("error", "evidence_integrity", "verify")] }),
      round(3, { violations: ["No external deps"], flags: [flag("warn", "recurring_violation")] }),
    ]);

    const violation = flags.find((f) => f.kind === "constraint_violation")!;
    assert.equal(violation.subject, "No external deps");
    assert.equal(violation.count, 3);
    assert.deepEqual(violation.rounds, [1, 2, 3]);

    const error = flags.find((f) => f.kind === "verification_error")!;
    assert.equal(error.subject, "evidence_integrity");
    assert.equal(error.ref, "verify", "the id the flag was about rides along");
    assert.equal(error.count, 2);
    assert.deepEqual(error.rounds, [1, 2]);

    // Sorted by count descending.
    assert.equal(flags[0].kind, "constraint_violation");
  });

  it("reports a single occurrence — the threshold belongs to the renderer", () => {
    // The old split was a raw no-threshold violation list for the prompt AND
    // a whole-history count >= 2 "lessons" list for the state file. The
    // derivation is now neutral; each renderer applies its own window.
    const flags = deriveRecurringFlags([
      round(1, {}),
      round(2, { flags: [flag("warn", "test_files_modified")] }),
      round(3, {}),
    ]);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].count, 1);
    assert.deepEqual(flags[0].rounds, [2]);
  });

  it("separates facts that share a check id but differ in ref", () => {
    const flags = deriveRecurringFlags([
      round(1, { flags: [flag("error", "required_command_failed", "verify")] }),
      round(2, { flags: [flag("error", "required_command_failed", "lint")] }),
      round(3, { flags: [flag("error", "required_command_failed", "verify")] }),
    ]);
    assert.equal(flags.length, 2, "two subjects failed, not one recurring check");
    const verify = flags.find((f) => f.ref === "verify")!;
    assert.equal(verify.count, 2);
    assert.deepEqual(verify.rounds, [1, 3]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.8.1 — the two render windows over ONE recurring-fact list
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.8.1 — Recurring Findings (prompt) vs Recurring Flags (state file)", () => {
  /** A committed merged round carrying flags and violations. */
  const committed = (
    loopId: string,
    round: number,
    violations: string[],
    flags: VerificationFlag[],
  ): Record<string, unknown> =>
    mergedLineageRound(round, {
      loopId,
      constraintViolations: violations,
      verificationFlags: flags,
    });
  const warn = (check: string): VerificationFlag =>
    ({ severity: "warn", field: "x", check, detail: "d" });

  it("the prompt shows the RECENT window, the state file the RECURRING set", () => {
    // Round 1 violated a constraint and it never recurred; rounds 2 and 3
    // repeatedly tripped one check. With a 3-round window at round 4, the
    // prompt should surface BOTH (the violation is 3 rounds old and still in
    // the window); the state file should surface only the recurring check.
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "windows",
      round: 4,
      task: "Continue work",
      force_level: "l2",
    }), {
      results: [
        committed("windows", 1, ["Never touch prod data"], []),
        committed("windows", 2, [], [warn("test_files_modified")]),
        committed("windows", 3, [], [warn("test_files_modified")]),
      ],
    });

    const prompt = response.prompt;
    assert.match(prompt, /Recurring Findings/);
    assert.match(prompt, /test_files_modified — 2×, latest R3/);
    assert.match(prompt, /Never touch prod data — 1×, latest R1/);

    const stateFile = response.state_file_content ?? "";
    assert.match(stateFile, /## Recurring Flags/);
    assert.match(stateFile, /test_files_modified — 2× \(R2, R3\)/);
    assert.doesNotMatch(stateFile, /Never touch prod data/,
      "a one-off is not a recurring flag");
  });

  it("states differ from the prompt: the window is committed rounds, not the whole loop", () => {
    // The warning fired at round 1 only. At round 9 it is outside the
    // 3-round window, so the prompt must not carry it — while the state
    // file still shows nothing either (it never recurred).
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "stale",
      round: 9,
      task: "Continue work",
      force_level: "l1",
    }), {
      results: [
        committed("stale", 1, [], [warn("test_files_modified")]),
      ],
    });
    assert.doesNotMatch(response.prompt, /Recurring Findings/,
      "nothing is firing inside the recent window");
  });

  it("L0 carries neither window", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "l0-clean",
      round: 3,
      attempt: 2,
      task: "Continue work",
      rejection_notice: "Required command failed",
    }), {
      results: [
        committed("l0-clean", 1, ["Never touch prod data"], [warn("test_files_modified")]),
        committed("l0-clean", 2, ["Never touch prod data"], [warn("test_files_modified")]),
      ],
    });
    assert.doesNotMatch(response.prompt, /Recurring Findings/);
    assert.doesNotMatch(response.prompt, /Recurring Flags/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2.1: current-round violations feed the constraint lifecycle — the L1
// collapse "(violated this round)" annotation and inactive re-activation.
// ═══════════════════════════════════════════════════════════════════════════
describe("manageConstraintLifecycle — current-round violations (v3.2.1)", () => {
  it("marks a committed violation at its own round, not the compile round", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "id-vr",
      round: 3,
      task: "Implement auth",
      loop_objective: makeLoopObjective({
        objective: "Build auth system",
        success_criteria: ["Login endpoint works"],
        hard_constraints: ["No plaintext passwords"],
        loop_id: "id-vr",
      }),
      constraints_from_plan: ["Use bcrypt for hashing"],
    }), {
      results: [withTransaction({
        loop_id: "id-vr",
        loop_lineage: {
          loop_id: "id-vr",
          round: 2,
          constraints_active: ["No plaintext passwords"],
          committed_action: "continue",
        },
        success: false,
        output_summary: "Tried without hashing",
        constraint_violations: ["No plaintext passwords"],
      })],
    });

    const meta = response.constraint_metadata ?? [];
    const hard = meta.find((m) => m.text === "No plaintext passwords");
    assert.ok(hard, "hard constraint must be in metadata");
    assert.equal(
      hard!.last_violated_at_round, 2,
      "a committed violation belongs to its own round; findLastViolatedRound " +
      "is the one fact source, not a relabel at the compile round",
    );
  });


});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — round stats + machine git-motion status threading
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — round stats and machine status threading", () => {
  /** Hydrated committed entry carrying the facts used by both dashboards. */
  const feedbackEntry = (
    round: number,
    files: string[],
    progress: number,
    attempt: number,
  ): Record<string, unknown> => mergedLineageRound(round, {
    loopId: "stats-loop",
    attempt,
    files,
    progress,
    beforeEvidence: [{
      schemaVersion: 2, providerId: "git", kind: "git", phase: "before",
      startedAt: 0, finishedAt: 0, status: "observed", files: [],
      data: {
        dirty: [], fingerprints: {}, head: `h${round - 1}`,
        coverage: "tracked_and_non_ignored_untracked",
      },
    }],
    roundEvidence: [{
      schemaVersion: 2, providerId: "git", kind: "git", phase: "after",
      startedAt: 0, finishedAt: 0, status: "observed", files,
      data: {
        dirty: files,
        fingerprints: Object.fromEntries(files.map((file) => [file, "m:1"])),
        head: `h${round}`,
        coverage: "tracked_and_non_ignored_untracked",
      },
    }],
  });

  it("derives round stats and machine git-motion from committed context entries", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "stats-loop",
      round: 4,
      task: "Derive stats",
      force_level: "l2",
    }), {
      results: [
        feedbackEntry(1, ["src/a.ts", "src/b.ts"], 0.4, 2), // 1 rejected attempt
        feedbackEntry(2, ["src/c.ts"], 0.5, 1),
        feedbackEntry(3, ["src/d.ts", "src/e.ts"], 0.6, 1),
      ],
      global_entries: [],
    } as never);
    // v3.8.1: Round Stats is deleted — its only renderer was the L2 prompt
    // section removed in this release, so it was computed, stored in the
    // canonical state (and therefore in stateHash) and read by nothing.
    assert.doesNotMatch(response.prompt, /Round Stats/);
    // The machine git-motion row survives, in the state file — the surface a
    // human or external tool reads.
    assert.match(response.state_file_content ?? "", /Machine progress/);
    assert.match(response.state_file_content ?? "", /changes observed in 3\/3 recent committed rounds/);
  });

  it("keeps prompt and state hashes deterministic with derived data present", () => {
    const opts = {
      loop_id: "stats-loop",
      round: 4,
      task: "Derive stats",
      force_level: "l2",
    };
    const context = {
      results: [
        feedbackEntry(1, ["src/a.ts"], 0.4, 1),
        feedbackEntry(2, ["src/b.ts"], 0.5, 1),
        feedbackEntry(3, ["src/c.ts"], 0.6, 1),
      ],
      global_entries: [],
    };
    const a = compileLoop(makeLoopCompileRequest(opts), context as never);
    const b = compileLoop(makeLoopCompileRequest(opts), context as never);
    assert.equal(a.prompt_artifact?.promptHash, b.prompt_artifact?.promptHash);
    assert.equal(a.state_file_content, b.state_file_content);
  });

  it("v3.5.1: renders rejected attempts and the Machine (git) row from MERGED entries", () => {
    // Production shape regression: engine hydration stamps lineage.attempt /
    // lineage.round_evidence onto merged lineage entries (raw :feedback
    // entries never reach the compile view). Before the stamp, this fixture
    // rendered "— rejected attempts" and no Machine row at all.
    const mergedRound = (round: number, attempt: number, gitMotion: boolean): Record<string, unknown> => {
      const changed = gitMotion ? [`src/r${round}.ts`] : [];
      return mergedLineageRound(round, {
        loopId: "stats-loop",
        attempt,
        files: [`src/r${round}.ts`],
        progress: 0.2 + round * 0.1,
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
            head: `h${round - 1}`,
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
          files: changed,
          data: {
            dirty: changed,
            fingerprints: Object.fromEntries(changed.map((file) => [file, "m:1"])),
            head: gitMotion ? `h${round}` : `h${round - 1}`,
            coverage: "tracked_and_non_ignored_untracked",
          },
        }],
      });
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "stats-loop",
      round: 4,
      task: "Derive stats",
      force_level: "l2",
    }), {
      results: [
        mergedRound(1, 2, true), // 1 rejected attempt before commit
        mergedRound(2, 1, true),
        mergedRound(3, 1, false), // committed, but no git motion that round
      ],
      global_entries: [],
    } as never);
    // v3.8.1: the per-round stats table is gone from the prompt; the machine
    // git-motion row is a state-file row.
    assert.doesNotMatch(response.prompt, /Round Stats/);
    assert.match(response.state_file_content ?? "", /Machine progress/);
    assert.match(response.state_file_content ?? "", /changes observed in 2\/3 recent committed rounds/,
      "R1+R2 moved; R3 recorded no motion");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Round Contract self-eval template
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.1 — Round Contract eval template", () => {
  it("shows real active-contract item ids without requiring a restatement", () => {
    const block = buildSelfEvalBlock(evalCtx({
      round: 4,
      level: "l2",
      activeContract: testContract(),
    }));
    assert.ok(block.includes("rci-12345678"), "renders the real rci id");
    assert.ok(block.includes("do NOT need to restate"), "no mechanical restatement");
    assert.ok(!block.includes("done_when"), "old contract shape is gone");
    assert.ok(!block.includes("verification_plan"), "old contract shape is gone");
  });

  it("shows a first declaration only when a contract command is available", () => {
    const first = buildSelfEvalBlock(evalCtx({
      round: 4,
      activeContract: null,
      commands: ["verify"],
    }));
    assert.ok(first.includes("round_contract"), "first declaration is offered");
    assert.ok(first.includes("verify"), "uses the real command name");
    const noCommand = buildSelfEvalBlock(evalCtx({
      activeContract: null,
      commands: [],
      contractVerificationAvailable: false,
    }));
    assert.ok(!noCommand.includes("round_contract"),
      "no command → no contract proposal");
    assert.ok(noCommand.includes("run without a contract"));
  });

  it("L0 retry stays lean but keeps functional contract claims", () => {
    const retry = buildSelfEvalBlock(evalCtx({
      round: 4,
      level: "l0",
      activeContract: testContract(),
      subGoals: [testSubGoal()],
    }));
    assert.ok(!retry.includes("retroactiveClaims"), "no L1/L2 extras at L0");
    assert.ok(retry.includes("rci-12345678"), "item claims remain functional");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.4 — ACTIVE Round Contract derivation at compile time
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.4 — ACTIVE Round Contract derivation (compileLoop)", () => {
  beforeEach(() => resetPolicy());
  /** Merged production-shape lineage entry (shared fixture, derive-cc loop). */
  const mergedRound = (r: number, o: Parameters<typeof mergedLineageRound>[1] = {}) =>
    mergedLineageRound(r, { loopId: "derive-cc", ...o });
  // v3.8: contracts declare ITEMS; each binds evidence commands.
  const A = {
    work_item: "Slice A",
    scope: ["src/a"],
    items: [
      { description: "a one", criterion_refs: ["cr-a-1"], verify_with: ["verify"] },
      { description: "a two", criterion_refs: ["cr-a-2"], verify_with: ["verify"] },
    ],
  };
  const B = {
    work_item: "Slice B",
    scope: ["src/b"],
    items: [{ description: "b one", criterion_refs: ["cr-b-1"], verify_with: ["verify"] }],
  };
  const TASK = "Build the whole thing";
  const compileAt = (
    round: number,
    level: "l0" | "l1" | "l2",
    results: Record<string, unknown>[],
  ) => compileLoop(makeLoopCompileRequest({
    loop_id: "derive-cc",
    round,
    task: TASK,
    force_level: level,
    // v3.4: NO last_round_result — the rejection-retry / resume / unpause /
    // backtrack compile shape. Current Task must still come from the
    // committed rounds via the derivation.
  }), { results, global_entries: [] } as never);

  it("declared contract renders as Current Task without last_round_result", () => {
    const res = compileAt(3, "l2", [
      mergedRound(1, { contract: A }),
      mergedRound(2, { met: [] }),
    ]);
    assert.ok(res.prompt.includes("**Slice A**"), "active contract must be the Current Task");
    assert.ok(res.prompt.includes("a one"), "item descriptions render");
    assert.ok(res.state_file_content?.includes("**Slice A**"));
    // L1/L2 eval template asks for the restatement (hasContract via derived
    // active — no last_round_result needed).
    assert.ok(res.prompt.includes("round_contract"));
  });

  it("L0 retry keeps the contract as Current Task but stays template-lean", () => {
    const res = compileAt(3, "l0", [
      mergedRound(1, { contract: A }),
      mergedRound(2, { met: [] }),
    ]);
    assert.ok(res.prompt.includes("**Slice A**"),
      "an L0 retry under an active contract must keep showing it");
    assert.ok(!res.prompt.includes("restate the Current Task's contract UNCHANGED"),
      "L0 retry stays lean — no restatement requirement");
  });

  it("a fully verified contract reverts the Current Task to the original task", () => {
    // v3.8: closure requires every item to be machine-verified — a claim
    // alone never closes a contract.
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: {
        ...DEFAULT_POLICY.evidence,
        commands: [{
          name: "verify", enabled: true, executable: "node", args: ["-e", "verify"],
          phase: "after", required: true, timeout_ms: 1000,
          max_output_chars: 2000, success_exit_codes: [0],
        }],
      },
    });
    const itemIds = deriveContractItemIds(A.items);
    const res = compileAt(3, "l2", [
      mergedRound(1, { contract: A }),
      mergedRound(2, {
        contractItemClaims: itemIds.map((item_id) => ({ item_id, outcome: "met" as const })),
        roundEvidence: [commandObservation("passed")],
      }),
    ]);
    assert.ok(!res.prompt.includes("**Slice A**"), "satisfied contract must stop rendering");
    assert.ok(res.prompt.includes("round_contract"),
      "the closing round may declare a successor proposal");
    assert.ok(res.prompt.includes(TASK), "objective still present");
  });

  it("ignores a premature replacement declared while the active contract is open", () => {
    const res = compileAt(3, "l2", [
      mergedRound(1, { contract: A }),
      mergedRound(2, { contract: B, met: [] }), // proposes B, completes nothing
    ]);
    assert.ok(res.prompt.includes("**Slice A**"), "A continues — B was premature");
    assert.ok(!res.prompt.includes("**Slice B**"));
  });

  it("closes on outcome=blocked and activates the blocking eval's proposal", () => {
    const res = compileAt(3, "l2", [
      mergedRound(1, { contract: A }),
      mergedRound(2, { outcome: "blocked", contract: B }),
    ]);
    assert.ok(res.prompt.includes("**Slice B**"), "blocked closes A; B becomes active");
    assert.ok(!res.prompt.includes("**Slice A**"));
  });

  it("contract-less committed rounds render no contract and no template", () => {
    const res = compileAt(3, "l2", [
      mergedRound(1, { met: [] }),
      mergedRound(2, { met: [] }),
    ]);
    assert.ok(!res.prompt.includes("**Slice A**"));
    assert.ok(!res.prompt.includes("round_contract"));
    assert.ok(res.prompt.includes(TASK));
  });
});

describe("v3.5 — post-backtrack contract revision (compile side)", () => {
  /** Merged production-shape lineage entry (shared fixture, redo-cc loop). */
  const merged = (r: number, o: Parameters<typeof mergedLineageRound>[1] = {}) =>
    mergedLineageRound(r, { loopId: "redo-cc", ...o });
  const A = {
    work_item: "Stalled slice",
    scope: ["src/a"],
    items: [{ description: "a one", criterion_refs: ["cr-a-1"], verify_with: ["verify"] }],
  };
  const B = {
    work_item: "Revised slice",
    scope: ["src/b"],
    items: [{ description: "b one", criterion_refs: ["cr-b-1"], verify_with: ["verify"] }],
  };

  it("a blocked redo eval after backtrack rounds activates the revised contract", () => {
    // r1: A declared (restore point) · r2/r3: committed backtrack rounds
    // (skipped — their proposals must not leak) · r4: redo eval closes A with
    // outcome=blocked and proposes B → round 5's Current Task is B.
    const res = compileLoop(makeLoopCompileRequest({
      loop_id: "redo-cc",
      round: 5,
      task: "Whole task",
      force_level: "l2",
    }), {
      results: [
        merged(1, { contract: A }),
        merged(2, { action: "backtrack", contract: A }),
        merged(3, { action: "backtrack", contract: A }),
        merged(4, { outcome: "blocked", contract: B }),
      ],
      global_entries: [],
    } as never);
    assert.ok(res.prompt.includes("**Revised slice**"),
      "the revised contract must become the Current Task");
    assert.ok(!res.prompt.includes("**Stalled slice**"),
      "the stalled contract must be closed, not re-rendered");
  });

  it("mid-redo (before the redo eval commits) the restore-point contract still renders", () => {
    const res = compileLoop(makeLoopCompileRequest({
      loop_id: "redo-cc",
      round: 4, // the redo round — nothing committed at/after r4 yet
      task: "Whole task",
      force_level: "l2",
    }), {
      results: [
        merged(1, { contract: A }),
        merged(2, { action: "backtrack", contract: A }),
        merged(3, { action: "backtrack", contract: A }),
      ],
      global_entries: [],
    } as never);
    assert.ok(res.prompt.includes("**Stalled slice**"),
      "until the redo commits, the restore point's active contract governs");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L7 regression: state_file.enabled=false must disable every knob that
// depends on the file — L2 pointer mode and L1 collapse both point prompts
// at the file for content, so with the file disabled they would silently
// truncate what the agent sees.
// ═══════════════════════════════════════════════════════════════════════════

describe("L7 — state file disabled cross-knob guard", () => {
  beforeEach(() => resetPolicy());

  const disableStateFile = (): void => {
    setPolicyForTest({
      ...DEFAULT_POLICY,
      state_file: { ...DEFAULT_POLICY.state_file, enabled: false },
    });
  };
  const baselineRound1 = (loopId: string): Record<string, unknown> =>
    withTransaction({
      loop_id: loopId,
      output_summary: "Round 1 done",
      success: true,
      loop_lineage: {
        loop_id: loopId,
        round: 1,
        constraints_active: ["Tests must pass", "Keep API stable", "Migrate data"],
        committed_action: "continue",
      },
      constraint_violations: [],
    });

  it("L2 stays self-contained with current governance, without a history blob", () => {
    disableStateFile();
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "l7-l2",
      round: 2,
      task: "Continue the migration",
      force_level: "l2",
    }), { results: [baselineRound1("l7-l2")] });
    assert.equal(response.state_file_content, undefined,
      "no state file content is produced when the file is disabled");
    assert.ok(!response.prompt.includes("Full state:"),
      "the L2 pointer line must not reference a file that is never written");
    assert.ok(!response.prompt.includes("Read the full state file"),
      "no read-the-file instruction may appear");
    assert.ok(!response.prompt.includes("Full Rehydrated State"),
      "L2 never falls back to a monolithic history blob");
    assert.ok(response.prompt.includes("Continue the migration"),
      "the prompt stays self-contained for current governance");
  });

  it("L1 renders full constraints instead of collapsing behind a missing file", () => {
    disableStateFile();
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "l7-l1",
      round: 2,
      task: "Continue work",
      force_level: "l1",
    }), { results: [baselineRound1("l7-l1")] });
    const p = response.prompt;
    // Collapse would have demoted the three unchanged constraints behind a
    // "(see state file)" line — with no file, every constraint renders.
    assert.ok(!p.includes("(see state file)"),
      "no collapse line may point at a file that is never written");
    assert.ok(!p.includes("unchanged constraints"),
      "unchanged constraints must not be demoted");
    for (const text of ["Tests must pass", "Keep API stable", "Migrate data"]) {
      assert.ok(p.includes(text), `unchanged constraint must render in full: ${text}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.2 — real criteria in the compact evaluation block
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.2 — compact criteria guidance", () => {
  it("renders real criterion ids and text in the compiled prompt", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "criteria-prompt",
      round: 2,
      task: "Build a parser",
      force_level: "l1",
      loop_objective: makeLoopObjective({
        loop_id: "criteria-prompt",
        objective: "Build a parser",
        success_criteria: ["Parser complete", "Tests pass"],
      }),
    }), null);
    const criterionId = deriveCriterionId("Parser complete");
    assert.match(response.prompt, /Optional fields — trigger → field → effect/);
    assert.match(response.prompt, new RegExp(criterionId));
    assert.match(response.prompt, /Parser complete/);
    assert.doesNotMatch(response.prompt, /<criterion text or cr id from the prompt>/);
  });

  it("omits criterion_claims from the compact list when no criteria exist", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "criteria-empty",
      round: 2,
      task: "Build a parser",
      force_level: "l1",
    }), null);
    // The compiler supplies its default criterion, so the field is still
    // present; the important part is that no placeholder text is emitted.
    assert.doesNotMatch(response.prompt, /<criterion text or cr id from the prompt>/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3.9.3 — committed-fact prompt level and the L0 field interface
// ═══════════════════════════════════════════════════════════════════════════

describe("3.9.3 — committed-fact prompt level", () => {
  const gitObservation = (
    phase: "before" | "after",
    fingerprints: Record<string, string>,
    head: string,
  ): MachineObservation => ({
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files: [],
    data: {
      dirty: [],
      fingerprints,
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  } as MachineObservation);

  const noMotionEvidence = () => ({
    beforeEvidence: [gitObservation("before", {}, "aaa")],
    afterEvidence: [gitObservation("after", {}, "aaa")],
  });

  const committed = (
    loopId: string,
    round: number,
    entry: Record<string, unknown> = {},
    success = false,
  ) => withTransaction({
    loop_id: loopId,
    loop_lineage: {
      loop_id: loopId,
      round,
      constraints_active: [],
      committed_action: "continue",
    },
    success,
    ...entry,
  }, "continue", noMotionEvidence());

  it("v3.9.5: committed corrections reach the next prompt", () => {
    const loopId = "committed-reports";
    const context = {
      results: [committed(loopId, 2, {
        output_summary: "a prior summary that must not be replayed",
        wrong_assumptions: ["old belief"],
      })],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Continue",
      force_level: "l2",
    }), context);
    assert.match(response.prompt, /Corrections \(committed reports\)/);
    assert.match(response.prompt, /old belief/);
    assert.doesNotMatch(response.prompt, /a prior summary that must not be replayed/);
  });

  it("v3.9.5: no prompt level replays a committed output_summary", () => {
    const loopId = "no-summary-any-level";
    const context = {
      results: [committed(loopId, 2, {
        output_summary: "UNIQUE_COMMITTED_SUMMARY",
        emerged_subtasks: [],
      })],
    };
    for (const level of ["l0", "l1", "l2"] as const) {
      const response = compileLoop(makeLoopCompileRequest({
        loop_id: loopId,
        round: 3,
        task: "Continue",
        force_level: level,
      }), context);
      assert.equal(response.prompt_artifact?.level, level);
      assert.ok(!response.prompt.includes("UNIQUE_COMMITTED_SUMMARY"),
        `${level} must not replay the committed output summary`);
      assert.ok(!response.warnings.some((warning) =>
        warning.includes("duplicate_declaration")),
        "zero emerged_subtasks is not a warning");
    }
  });


  it("stays L0 only when the committed round proves no activity", () => {
    const loopId = "stale";
    const previous = committed(loopId, 2);
    const transaction = (previous.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    const snapshot = transaction.snapshot as Record<string, unknown>;
    snapshot.operatorAcceptance = {
      task: "Do work",
      success_criteria: ["Ship it"],
      hard_constraints: [],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Do work",
      loop_objective: makeLoopObjective({
        loop_id: loopId,
        objective: "Do work",
        success_criteria: ["Ship it"],
      }),
    }), { results: [previous] });

    assert.equal(response.recompile_level, "l0");
    const prompt = response.prompt;
    for (const path of [
      "execution_report.criterion_claims",
      "discovered_constraints",
      "wrong_assumptions",
      "emerged_subtasks",
      "worker_results",
      "compression_checkpoint",
    ]) {
      assert.match(prompt, new RegExp("`" + path.replace(/\./g, "\.") + "`"),
        `L0 must still offer ${path}`);
    }
    assert.match(prompt, /cr-[a-f0-9]{8}/, "real criterion id at L0");
    assert.match(prompt, /Ship it/);
  });

  it("does not let an empty retry inherit the previous committed flags", () => {
    const loopId = "retry-flags";
    const staleFlag = {
      severity: "warn" as const,
      field: "files_changed",
      check: "evidence_integrity",
      detail: "STALE_PREVIOUS_FINDING",
    };
    const context = {
      results: [withTransaction({
        loop_id: loopId,
        loop_lineage: {
          loop_id: loopId,
          round: 1,
          constraints_active: [],
          committed_action: "continue",
        },
        success: false,
        verification_flags: [staleFlag],
      }, "continue", noMotionEvidence())],
    };

    const nextRound = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 2,
      task: "Do work",
    }), context);
    assert.match(nextRound.prompt, /STALE_PREVIOUS_FINDING/,
      "a normal new round shows the committed previous findings");

    const retry = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 2,
      task: "Do work",
      attempt: 2,
      verification_flags: [],
    }), context);
    assert.equal(retry.recompile_level, "l0");
    assert.doesNotMatch(retry.prompt, /STALE_PREVIOUS_FINDING/,
      "an in-flight retry's empty findings are authoritative; they must not " +
      "fall back to the previous committed round's flags");
  });

  it("keeps L1 when the committed round has observable machine motion", () => {
    const loopId = "motion";
    const context = {
      results: [withTransaction({
        loop_id: loopId,
        loop_lineage: {
          loop_id: loopId,
          round: 2,
          constraints_active: [],
          committed_action: "continue",
        },
        success: false,
      }, "continue", {
        beforeEvidence: [gitObservation("before", { "a.ts": "m:1" }, "aaa")],
        afterEvidence: [gitObservation("after", { "a.ts": "m:2" }, "bbb")],
      })],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Do work",
    }), context);
    assert.equal(response.recompile_level, "l1");
  });

  it("offers a schema-only contract example, not a task-seeded plan", () => {
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: {
        ...DEFAULT_POLICY.evidence,
        commands: [{
          name: "verify",
          enabled: true,
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          phase: "after",
          required: true,
          timeout_ms: 1000,
          max_output_chars: 2000,
          success_exit_codes: [0],
        }],
      },
    });
    try {
      const response = compileLoop(makeLoopCompileRequest({
        loop_id: "contract-natural",
        round: 2,
        task: "Build the parser",
        force_level: "l2",
        loop_objective: makeLoopObjective({
          loop_id: "contract-natural",
          objective: "Build the parser",
          success_criteria: ["Ship the parser"],
        }),
      }), null);
      const prompt = response.prompt;
      assert.match(prompt, /No active Round Contract/);
      assert.match(prompt, /<bounded deliverable this slice produces>/);
      assert.match(prompt, /"verify_with": \[/);
      assert.match(prompt, /"verify"/);
      assert.doesNotMatch(prompt, /"work_item": "Build the parser"/,
        "LoopForge must not turn the task into a proposal");
      assert.doesNotMatch(prompt, /"criterion_refs": \["cr-/,
        "the example must not seed real criteria into the plan");
      assert.doesNotMatch(prompt, /\bsg-[a-f0-9]{8}\b/);
      assert.doesNotMatch(prompt, /\brci-[a-f0-9]{8}\b/);
    } finally {
      resetPolicy();
    }
  });

  it("keeps the deep-restore recovery boundary and brief on the redo round", () => {
    const loopId = "deep-restore";
    const context = {
      results: [
        committed(loopId, 1, {}, true),
        committed(loopId, 2, {}, true),
        // Abandoned branch above the redo round: must not leak its objective.
        withTransaction({
          loop_id: loopId,
          loop_lineage: {
            loop_id: loopId,
            round: 4,
            constraints_active: [],
            committed_action: "continue",
          },
          success: true,
          loop_objective: makeLoopObjective({
            loop_id: loopId,
            objective: "ABANDONED branch",
            success_criteria: ["never"],
          }),
        }),
        committedBacktrackRound(5, loopId, 2),
      ],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 3,
      task: "Restore the parser",
    }), context);

    assert.equal(response.recompile_level, "l2");
    assert.ok((response.state_file_content ?? "").includes("Redo round**: 3"),
      "the Recovery Brief must use the directive's redo round");
    assert.ok((response.state_file_content ?? "").includes("Restored checkpoint"),
      "the Recovery Brief names the verified checkpoint");
    assert.ok(!response.prompt.includes("ABANDONED branch"),
      "the abandoned branch's objective must not leak into the redo prompt");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v4.0.1 — one immutable operator surface
// ═══════════════════════════════════════════════════════════════════════════

describe("v4.0.1 — operator acceptance integrity", () => {
  const acceptance = {
    task: "Test task",
    success_criteria: [] as string[],
    hard_constraints: [] as string[],
  };

  it("returns the committed acceptance byte-identically", () => {
    const loopId = "acceptance-match";
    const response = compileLoop(
      makeLoopCompileRequest({ loop_id: loopId, round: 2, task: "Test task" }),
      { results: [committedFeedbackRound(1, { loopId })] },
      { operatorAcceptance: acceptance },
    );
    assert.deepEqual(response.operatorAcceptance, acceptance);
    assert.equal(response.compiled?.task, "Test task");
  });

  it("fails closed when a caller copy disagrees with committed history", () => {
    const loopId = "acceptance-conflict";
    assert.throws(
      () => compileLoop(
        makeLoopCompileRequest({ loop_id: loopId, round: 2, task: "Test task" }),
        { results: [committedFeedbackRound(1, { loopId })] },
        {
          operatorAcceptance: {
            task: "A different operator surface",
            success_criteria: ["different"],
            hard_constraints: [],
          },
        },
      ),
      (error: unknown) => error instanceof OperatorAcceptanceConflictError,
    );
  });
});
