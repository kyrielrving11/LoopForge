/** Tests for canonical-state — state creation and Markdown rendering. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createCanonicalLoopState,
  renderCanonicalStateMarkdown,
  hashCanonicalState,
  stableStringify,
  formatRoundContract,
  milestoneHeading,
  trustBarLine,
  CANONICAL_STATE_SCHEMA_VERSION,
} from "../canonical-state.js";
import {
  makeLoopCompileRequest,
  makeLoopCompileResponse,
  makeLoopObjective,
  makeLoopRoundResult,
  type LoopCompileRequest,
  type LoopCompileResponse,
} from "../protocol.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function request(overrides: Partial<LoopCompileRequest> = {}): LoopCompileRequest {
  return makeLoopCompileRequest({
    loop_id: "test-loop",
    round: 2,
    task: "Fix bugs in auth module",
    max_rounds: 20,
    ...overrides,
  });
}

function response(overrides: Partial<LoopCompileResponse> = {}): LoopCompileResponse {
  return makeLoopCompileResponse({
    loop_id: "test-loop",
    round: 2,
    goal_id: "goal-1",
    loop_objective: makeLoopObjective({
      objective: "Fix bugs in auth module",
      success_criteria: ["all tests pass", "no regressions"],
      hard_constraints: ["no external deps"],
      loop_id: "test-loop",
    }),
    constraints_active: ["no external deps", "all tests pass"],
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// stableStringify
// ═══════════════════════════════════════════════════════════════════════════

describe("stableStringify", () => {
  it("produces deterministic output for object keys", () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    assert.equal(a, b);
  });

  it("handles arrays", () => {
    const result = stableStringify([3, 1, 2]);
    assert.equal(result, "[3,1,2]");
  });

  it("handles nested objects", () => {
    const result = stableStringify({ z: { b: 2, a: 1 }, y: 3 });
    assert.ok(result.includes('"a":1'));
    assert.ok(result.includes('"b":2'));
  });

  it("handles null", () => {
    assert.equal(stableStringify(null), "null");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// hashCanonicalState
// ═══════════════════════════════════════════════════════════════════════════

describe("hashCanonicalState", () => {
  it("produces same hash for equivalent state", () => {
    const req = request();
    const res = response();
    const state1 = createCanonicalLoopState(req, res, "test.md");
    const state2 = createCanonicalLoopState(req, res, "test.md");
    assert.equal(hashCanonicalState(state1), hashCanonicalState(state2));
  });

  it("produces different hash for different state", () => {
    const req = request();
    const state1 = createCanonicalLoopState(req, response(), "a.md");
    const state2 = createCanonicalLoopState(req, response({ round: 3 }), "b.md");
    assert.notEqual(hashCanonicalState(state1), hashCanonicalState(state2));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// createCanonicalLoopState
// ═══════════════════════════════════════════════════════════════════════════

describe("createCanonicalLoopState", () => {
  it("sets schema version", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    assert.equal(state.schemaVersion, CANONICAL_STATE_SCHEMA_VERSION);
  });

  it("propagates loopId and round", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    assert.equal(state.loopId, "test-loop");
    assert.equal(state.round, 2);
  });

  it("propagates objective from response", () => {
    const state = createCanonicalLoopState(request(), response({
      loop_objective: makeLoopObjective({
        objective: "Complete all subtasks",
        success_criteria: ["c1", "c2"],
        hard_constraints: ["h1"],
        loop_id: "test-loop",
      }),
    }), "test.md");
    assert.equal(state.objective, "Complete all subtasks");
    assert.deepEqual(state.successCriteria, ["c1", "c2"]);
    assert.deepEqual(state.hardConstraints, ["h1"]);
  });

  it("falls back to task when objective is missing", () => {
    const state = createCanonicalLoopState(request(), response({
      loop_objective: null,
    }), "test.md");
    assert.equal(state.objective, "Fix bugs in auth module");
  });

  it("propagates constraints from response", () => {
    const state = createCanonicalLoopState(request(), response({
      constraints_active: ["c1", "c2"],
      constraints_retired: ["old"],
      constraints_inactive: ["stale"],
    }), "test.md");
    assert.deepEqual(state.activeConstraints, ["c1", "c2"]);
    assert.deepEqual(state.retiredConstraints, ["old"]);
    assert.deepEqual(state.inactiveConstraints, ["stale"]);
  });

  it("propagates rolling summary data", () => {
    const state = createCanonicalLoopState(request(), response({
      rolling_summary: {
        key_outcomes: ["[R1] accepted: fixed bug"],
        recurring_issues: ["flakey test"],
        rounds_sampled: 1,
        generated_at_round: 2,
        milestones: [],
        loop_synthesis: "Loop spans 1 round.",
      },
    }), "test.md");
    assert.ok(state.rollingOutcomes.length > 0);
    assert.ok(state.recurringIssues.length > 0);
  });

  it("propagates sub-goals", () => {
    const state = createCanonicalLoopState(request(), response({
      sub_goals: [
        { id: "sg-1", description: "Task A", status: "pending", declared_at_round: 1, status_changed_at_round: 1, priority: 0 },
      ],
    }), "test.md");
    assert.equal(state.subGoals.length, 1);
    assert.equal(state.subGoals[0].description, "Task A");
  });

  it("uses maxRounds from request when provided", () => {
    const state = createCanonicalLoopState(request({ max_rounds: 50 }), response(), "test.md");
    assert.equal(state.maxRounds, 50);
  });

  it("defaults maxRounds to 20", () => {
    const state = createCanonicalLoopState(request({ max_rounds: undefined }), response(), "test.md");
    assert.equal(state.maxRounds, 20);
  });

  it("propagates verification flags", () => {
    const state = createCanonicalLoopState(request({
      verification_flags: [
        { severity: "warn", field: "test", check: "c1", detail: "detail" },
      ],
    }), response(), "test.md");
    assert.equal(state.verificationFlags.length, 1);
  });

  it("handles empty state without errors", () => {
    const state = createCanonicalLoopState(request({
      last_round_result: null,
    }), response({
      loop_objective: null,
      rolling_summary: null,
    }), "test.md");
    assert.ok(state.objective);
    assert.equal(state.progress.estimate, null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// renderCanonicalStateMarkdown
// ═══════════════════════════════════════════════════════════════════════════

describe("renderCanonicalStateMarkdown", () => {
  it("renders objective and current task", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Loop Objective"));
    assert.ok(md.includes("Current Task"));
    assert.ok(md.includes(state.objective));
  });

  it("renders success criteria", () => {
    const state = createCanonicalLoopState(request(), response({
      loop_objective: makeLoopObjective({
        objective: "test",
        success_criteria: ["c1", "c2"],
        hard_constraints: [],
        loop_id: "test-loop",
      }),
    }), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Success Criteria"));
    assert.ok(md.includes("c1"));
    assert.ok(md.includes("c2"));
  });

  it("renders progress dashboard when estimate is set", () => {
    const req = request({
      last_round_result: {
        round: 1,
        success: true,
        output_summary: "done",
        constraint_violations: [],
        manual_fixes_needed: "",
        execution_evidence: {
          files_changed: ["a.ts"],
          test_results: { passed: 8, failed: 1, skipped: 0 },
          success_criteria_met: ["c1"],
          success_criteria_remaining: ["c2"],
          progress_estimate: 0.5,
        },
      },
    });
    const state = createCanonicalLoopState(req, response(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Progress Dashboard"));
    assert.ok(md.includes("50%"));
    assert.ok(md.includes("8 passed"));
    assert.ok(md.includes("1 failed"));
  });

  it("renders milestone phase history", () => {
    const state = createCanonicalLoopState(request(), response({
      rolling_summary: {
        key_outcomes: [],
        recurring_issues: [],
        rounds_sampled: 1,
        generated_at_round: 2,
        milestones: [{
          label: "Phase 1: Auth done",
          round_range: { start: 1, end: 5 },
          outcome: "Completed auth module",
          carried_constraints: ["no deps"],
          resolved_constraints: [],
          progress_at_boundary: 0.3,
          kind: "agent_declared",
          generated_at_round: 5,
        }],
      },
    }), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Phase History"));
    assert.ok(md.includes("Phase 1: Auth done"));
  });

  it("renders sub-goal dashboard", () => {
    const state = createCanonicalLoopState(request(), response({
      sub_goals: [
        { id: "sg-1", description: "Task A", status: "done", declared_at_round: 1, status_changed_at_round: 3, completed_at_round: 3, priority: 0 },
      ],
    }), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Sub-Goal Dashboard"));
    // v2.8: Sub-goal IDs are rendered in the state file
    assert.ok(md.includes("`sg-1`"), "should render sub-goal ID in state file");
  });

  it("renders verification flags", () => {
    const state = createCanonicalLoopState(request({
      verification_flags: [
        { severity: "warn", field: "x", check: "test", detail: "detail text" },
      ],
    }), response(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Verification"));
    assert.ok(md.includes("detail text"));
  });

  it("renders agent trust when score is available", () => {
    const state = createCanonicalLoopState(request(), response({
      agent_trust_score: 0.85,
      agent_trust_trend: [0.9, 0.85, 0.8],
    }), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Agent Trust"));
    assert.ok(md.includes("85%"));
    assert.ok(md.includes("0.9 → 0.85 → 0.8"));
  });

  it("always ends with a newline", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.endsWith("\n"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Roadmap view + derived state propagation
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — Roadmap and derived state", () => {
  /** Response carrying milestones, per-criterion statuses and sub-goals so
   *  the Roadmap has real forward-looking content to render. */
  const fullResponse = (): LoopCompileResponse => response({
    round: 7,
    rolling_summary: {
      milestones: [{
        label: "Core Module",
        round_range: { start: 1, end: 4 },
        outcome: "completed core module",
        carried_constraints: [],
        resolved_constraints: [],
        progress_at_boundary: 0.4,
        kind: "auto" as const,
        generated_at_round: 4,
      }],
      key_outcomes: [],
      recurring_issues: [],
      failed_patterns: [],
      loop_synthesis: "",
      rounds_sampled: 4,
      generated_at_round: 4,
    },
    criterion_statuses: [
      { id: "cr-11111111", text: "all tests pass", status: "met" as const, met_at_round: 3, related_subgoal_ids: [] },
      { id: "cr-22222222", text: "no regressions", status: "remaining" as const, related_subgoal_ids: [] },
      { id: "cr-33333333", text: "clean lint", status: "unknown" as const, related_subgoal_ids: [] },
    ],
    sub_goals: [{
      id: "sg-1",
      description: "write auth tests",
      status: "in_progress" as const,
      declared_at_round: 2,
      status_changed_at_round: 4,
      priority: 0,
    }],
  });

  it("renders Roadmap with position, criteria counts, remaining IDs and sub-goal activity", () => {
    const state = createCanonicalLoopState(request({ round: 7 }), fullResponse(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("## Roadmap"));
    assert.ok(md.includes("Position: round 7/20"));
    assert.ok(md.includes("3 rounds since the last milestone boundary"));
    assert.ok(md.includes("1/3 met · 2 remaining"));
    assert.ok(md.includes("cr-22222222"), "remaining criterion IDs render");
    assert.ok(md.includes("1 in progress · 0 pending"));
  });

  it("omits Roadmap when milestones and criteria are empty", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(!md.includes("## Roadmap"));
  });

  it("propagates derived roundStats/machineStatus conditionally and deterministically", () => {
    const req = request();
    const res = response();
    const plain1 = createCanonicalLoopState(req, res, "test.md");
    const plain2 = createCanonicalLoopState(req, res, "test.md");
    assert.equal("roundStats" in plain1, false, "no derived data → key absent (hash stability)");
    assert.equal("machineStatus" in plain1, false);
    assert.equal(hashCanonicalState(plain1), hashCanonicalState(plain2));

    const derived = () => createCanonicalLoopState(req, res, "test.md", {
      roundStats: [{ round: 1, filesChangedCount: 3, rejectedAttempts: 1, progressDelta: null }],
      machineStatus: { windowRounds: 3, gitMotion: true, motionRounds: 2 },
    });
    const state = derived();
    assert.equal(state.roundStats?.length, 1);
    assert.equal(state.roundStats![0].rejectedAttempts, 1);
    assert.equal(state.machineStatus?.gitMotion, true);
    assert.notEqual(hashCanonicalState(plain1), hashCanonicalState(state));
    assert.equal(hashCanonicalState(state), hashCanonicalState(derived()),
      "same derived input → same hash");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Round Contract: Current Task replacement + state-file rendering
// ═══════════════════════════════════════════════════════════════════════════

describe("Round Contract state (v3.3 rendering, v3.4 active source)", () => {
  const contract = {
    work_item: "Implement auth",
    done_when: ["cr-auth-login", "cr-auth-logout"],
    verification_plan: ["run-tests"],
    scope: ["src/auth"],
    boundary_reason: "verifiable vertical slice — auth is independently testable",
  };

  /** v3.4: The ACTIVE contract arrives in the derived bag (computed by
   *  loop-compiler.deriveActiveContract from committed rounds) — never via
   *  request.last_round_result, which no longer carries it. */
  const withActiveContract = () =>
    createCanonicalLoopState(request({ round: 3 }), response({ round: 3 }), "test.md", {
      roundContract: contract,
    });

  it("active contract replaces Current Task and lands in state.roundContract", () => {
    const state = withActiveContract();
    assert.equal(state.roundContract?.work_item, "Implement auth");
    assert.ok(state.currentTask.includes("**Implement auth**"));
    assert.ok(state.currentTask.includes("- Done when: cr-auth-login"));
    assert.ok(state.currentTask.includes("- Verify via: run-tests"));
    assert.ok(state.currentTask.includes("- Scope: src/auth"));
    assert.ok(!state.currentTask.includes("Fix bugs in auth module"),
      "the original task is NOT the Current Task on a contract round");
  });

  it("derived active wins even when last_round_result.round_contract differs", () => {
    // Defense-in-depth for the v3.4 second-source-of-truth elimination: the
    // stale field (still legal on the request type) must never drive the
    // Current Task again. Pre-v3.4 the renderer read this field, so a
    // request carrying STALE would have shown STALE.
    const staleRequest = request({
      round: 3,
      last_round_result: makeLoopRoundResult({
        round: 2,
        success: false,
        output_summary: "Started auth module",
        constraint_violations: [],
        manual_fixes_needed: "",
        round_contract: { work_item: "STALE", done_when: ["x"], verification_plan: [], scope: [] },
      }),
    });
    assert.equal(staleRequest.last_round_result?.round_contract?.work_item, "STALE",
      "fixture must actually carry the stale field to prove it is ignored");
    // No derived active → original task, never STALE.
    const stale = createCanonicalLoopState(staleRequest, response({ round: 3 }), "test.md");
    assert.equal(stale.currentTask, "Fix bugs in auth module");
    assert.ok(!stale.currentTask.includes("STALE"));
    // Derived active wins over the stale field.
    const derived = createCanonicalLoopState(staleRequest, response({ round: 3 }), "test.md", {
      roundContract: contract,
    });
    assert.equal(derived.roundContract?.work_item, "Implement auth");
    assert.ok(derived.currentTask.includes("**Implement auth**"));
    assert.ok(!derived.currentTask.includes("STALE"));
  });

  it("no contract → original task text and no roundContract key (hash-neutral)", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    assert.equal(state.currentTask, "Fix bugs in auth module");
    assert.equal("roundContract" in state, false);
    // Empty derived bag stays hash-identical to no derived bag.
    const bagged = createCanonicalLoopState(request(), response(), "test.md", {});
    assert.equal(hashCanonicalState(state), hashCanonicalState(bagged));
    // Deterministic with the active contract present; differs when absent.
    const active1 = withActiveContract();
    const active2 = withActiveContract();
    assert.equal(hashCanonicalState(active1), hashCanonicalState(active2));
    assert.notEqual(hashCanonicalState(state), hashCanonicalState(active1));
  });

  it("state file records boundary_reason under Current Task", () => {
    const state = withActiveContract();
    const md = renderCanonicalStateMarkdown(state);
    assert.match(md, /> Contract boundary: verifiable vertical slice/);
  });

  it("formatRoundContract renders compactly and omits empty arrays", () => {
    const text = formatRoundContract({
      work_item: "Tidy",
      done_when: ["lint clean"],
      verification_plan: [],
      scope: [],
    });
    assert.equal(text, "**Tidy**\n- Done when: lint clean");
    const noWorkItem = formatRoundContract({
      done_when: [],
      verification_plan: ["run-tests"],
      scope: [],
    });
    assert.equal(noWorkItem, "**Round Contract**\n- Verify via: run-tests");
  });
});

describe("Shared presentation atoms (v3.3.1)", () => {
  it("trustBarLine renders the fixed-width bar and percentage", () => {
    assert.equal(trustBarLine(0.6), "██████░░░░ 60%");
    assert.equal(trustBarLine(0), "░░░░░░░░░░ 0%");
    assert.equal(trustBarLine(1), "██████████ 100%");
    // Math.round(2.5) rounds half up → 3 filled cells at 25%.
    assert.equal(trustBarLine(0.25), "███░░░░░░░ 25%");
  });

  it("milestoneHeading renders icon, label, round range and progress", () => {
    const base = {
      label: "Round 7",
      round_range: { start: 3, end: 7 },
      outcome: "phase done",
      carried_constraints: [],
      resolved_constraints: [],
      progress_at_boundary: 0.6,
      kind: "auto",
      generated_at_round: 7,
    };
    assert.equal(
      milestoneHeading({ ...base, kind: "auto" }),
      "**📍 Round 7** (Rounds 3–7, 60%)",
    );
    assert.equal(
      milestoneHeading({ ...base, kind: "agent_declared" }),
      "**🏁 Round 7** (Rounds 3–7, 60%)",
    );
    assert.equal(
      milestoneHeading({ ...base, kind: "criteria_milestone", label: "Done: X" }),
      "**✅ Done: X** (Rounds 3–7, 60%)",
    );
  });
});
