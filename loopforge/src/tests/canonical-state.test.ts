/** Tests for canonical-state — state creation and Markdown rendering. */
import { criterionClaims } from "./_helpers.js";
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
    }), "test.md");
    assert.deepEqual(state.activeConstraints, ["c1", "c2"]);
    assert.deepEqual(state.retiredConstraints, ["old"]);
  });

  it("propagates rolling summary data", () => {
    const state = createCanonicalLoopState(request(), response({
      rolling_summary: {
        key_outcomes: ["[R1] accepted: fixed bug"],
        recurring_issues: ["flakey test"],
        rounds_sampled: 1,
        generated_at_round: 2,
        milestones: [],
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

  it("defaults maxRounds to the policy default (200)", () => {
    const state = createCanonicalLoopState(request({ max_rounds: undefined }), response(), "test.md");
    assert.equal(state.maxRounds, 200);
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
        execution_report: {
          files_changed: ["a.ts"],
          tests_reported: { passed: 8, failed: 1, skipped: 0 },
          criterion_claims: criterionClaims(["c1"], ["c2"]),
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
        { id: "sg-2", description: "Task B", status: "pending", declared_at_round: 2, status_changed_at_round: 2, priority: 1 },
      ],
    }), "test.md");
    const md = renderCanonicalStateMarkdown(state);
    assert.ok(md.includes("Sub-Goal Dashboard"));
    // v2.8/v3.7.1: active sub-goal IDs render as rows; done/canceled only
    // survive in the counts line.
    assert.ok(md.includes("`sg-2`"), "should render active sub-goal ID in state file");
    assert.ok(!md.includes("`sg-1`"), "done sub-goal rows no longer render in the state file");
    assert.ok(md.includes("1 done"), "done count survives in the dashboard totals line");
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
// v3.7.1 — state-file tiering (Current / Recent / Historical Summary)
// ═══════════════════════════════════════════════════════════════════════════

describe("state-file tiering (v3.7.1)", () => {
  // A state with content in every tier: verification flags → Recent,
  // milestones → Historical, objective/constraints → Current.
  function richState() {
    return createCanonicalLoopState(request({
      verification_flags: [
        { severity: "warn", field: "x", check: "c1", detail: "flag detail" },
      ],
    }), response({
      rolling_summary: {
        key_outcomes: [],
        recurring_issues: [],
        rounds_sampled: 1,
        generated_at_round: 2,
        milestones: [{
          label: "m",
          round_range: { start: 1, end: 2 },
          outcome: "done",
          carried_constraints: [],
          resolved_constraints: [],
          progress_at_boundary: 0.5,
          kind: "auto",
          generated_at_round: 2,
        }],
      },
    }), "test.md");
  }

  it("renders the three tiers in order with derived metadata", () => {
    const state = richState();
    const md = renderCanonicalStateMarkdown(state, { attempt: 2 });
    const idxCurrent = md.indexOf("## Current");
    const idxRecent = md.indexOf("## Recent");
    const idxHistorical = md.indexOf("## Historical Summary");
    assert.ok(idxCurrent >= 0 && idxRecent > idxCurrent && idxHistorical > idxRecent,
      "tiers must render in order: Current → Recent → Historical Summary");
    assert.ok(md.includes("**Derived**: true"), "derived marker in the header");
    assert.ok(md.includes("**Source**: round 2 (attempt 2)"), "attempt marker");
    assert.match(md, /\*\*State hash\*\*: [a-f0-9]{12}/);
    // Sections are demoted to H3 under their tier.
    const current = md.slice(idxCurrent, idxRecent);
    assert.ok(current.includes("### Loop Objective"), "Current holds the objective");
    assert.ok(current.includes("### Active Constraints"), "Current holds active constraints");
    const recent = md.slice(idxRecent, idxHistorical);
    assert.ok(recent.includes("### Verification"), "Recent holds verification findings");
    const historical = md.slice(idxHistorical);
    assert.ok(historical.includes("### Phase History"), "Historical holds milestones");
  });

  it("marks the retry attempt — attempt 2 differs from attempt 1", () => {
    const state = createCanonicalLoopState(request(), response(), "test.md");
    const a1 = renderCanonicalStateMarkdown(state, { attempt: 1 });
    const a2 = renderCanonicalStateMarkdown(state, { attempt: 2 });
    assert.notEqual(a1, a2, "attempt must be visible in the derived view");
    assert.ok(a1.includes("(attempt 1)"));
    assert.ok(a2.includes("(attempt 2)"));
  });

  it("injects the Recovery Brief into Recent only when provided", () => {
    const state = richState();
    const plain = renderCanonicalStateMarkdown(state);
    assert.ok(!plain.includes("Recovery Brief"), "no brief outside a recovery window");
    const withBrief = renderCanonicalStateMarkdown(state, {
      attempt: 1,
      recoveryBrief: ["- rolled back to round 3", "- do not repeat approach A"],
    });
    const idxRecent = withBrief.indexOf("## Recent");
    const idxHistorical = withBrief.indexOf("## Historical Summary");
    assert.ok(idxRecent >= 0 && idxHistorical > idxRecent);
    const recent = withBrief.slice(idxRecent, idxHistorical);
    assert.ok(recent.includes("### Recovery Brief"), "brief renders inside Recent");
    assert.ok(recent.includes("do not repeat approach A"));
  });

  it("produces byte-identical content for identical state and attempt", () => {
    const state = richState();
    const first = renderCanonicalStateMarkdown(state, { attempt: 1 });
    const second = renderCanonicalStateMarkdown(state, { attempt: 1 });
    assert.equal(first, second);
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
      rounds_sampled: 4,
      generated_at_round: 4,
    },
    criterion_statuses: [
      { id: "cr-11111111", text: "all tests pass", status: "verified" as const, met_at_round: 3, related_subgoal_ids: [] },
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
  // v3.8: the ACTIVE contract is the derived item view.
  const contract = {
    id: "rc-aaaaaaaa",
    declared_at_round: 2,
    work_item: "Implement auth",
    scope: ["src/auth"],
    items: [
      { id: "rci-11111111", description: "login works", criterion_refs: ["cr-auth-login"], subgoal_refs: [], verify_with: ["run-tests"] },
      { id: "rci-22222222", description: "logout works", criterion_refs: ["cr-auth-logout"], subgoal_refs: [], verify_with: ["run-tests"] },
    ],
    config_hash_by_command: {},
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
    assert.ok(state.currentTask.includes("**Implement auth** (rc-aaaaaaaa)"));
    assert.ok(state.currentTask.includes("- [`rci-11111111`] login works"));
    assert.ok(state.currentTask.includes("- Verify via: run-tests"));
    assert.ok(state.currentTask.includes("- Criteria: cr-auth-login"));
    assert.ok(state.currentTask.includes("- Scope: src/auth"));
    assert.ok(!state.currentTask.includes("Fix bugs in auth module"),
      "the original task is NOT the Current Task on a contract round");
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

  it("formatRoundContract renders compactly and omits empty arrays", () => {
    const text = formatRoundContract({
      id: "rc-bbbbbbbb",
      declared_at_round: 1,
      work_item: "Tidy",
      scope: [],
      items: [{ id: "rci-33333333", description: "lint clean", criterion_refs: [], subgoal_refs: [], verify_with: [] }],
      config_hash_by_command: {},
    });
    assert.equal(text, "**Tidy** (rc-bbbbbbbb)\n- [`rci-33333333`] lint clean");
    const noWorkItem = formatRoundContract({
      id: "rc-cccccccc",
      declared_at_round: 1,
      scope: [],
      items: [{ id: "rci-44444444", description: "tests pass", criterion_refs: [], subgoal_refs: [], verify_with: ["run-tests"] }],
      config_hash_by_command: {},
    });
    assert.equal(
      noWorkItem,
      "**Round Contract** (rc-cccccccc)\n- [`rci-44444444`] tests pass\n  - Verify via: run-tests",
    );
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
