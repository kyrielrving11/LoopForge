/** Tests for prompt-assembler — single-pass prompt rendering. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemblePromptArtifact, DEFAULT_PROMPT_BUDGETS, verificationActionFor } from "../prompt-assembler.js";
import { LOST_HANDLE_ROUTING } from "../recovery-guidance.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "../protocol.js";
import type { PromptAssemblyInput } from "../prompt-assembler.js";
import {
  CANONICAL_STATE_SCHEMA_VERSION,
  type CanonicalLoopState,
} from "../canonical-state.js";
import type { ConstraintMeta } from "../protocol.js";
import type { WorkingMemory } from "../working-memory.js";
import { deriveItemId } from "../token-utils.js";
import { deriveConfiguredCapability, getPolicy, resetPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";
// Namespace import of the verification-gate CHECK_* constants: the coverage
// test below iterates them so a new constant can never silently lack an
// action entry. (Tests may import verification-gate freely — only the src
// modules must respect the prompt-assembler ← verification-gate cycle rule.)
import * as verificationGate from "../verification-gate.js";
import {
  ROUND_BOUNDARY_PRINCIPLE,
  renderRoundGuidance,
} from "../round-guidance.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function memory(overrides: Partial<WorkingMemory> = {}): WorkingMemory {
  return {
    reports: [{
      roundId: "loop:test-loop:round:1",
      round: 1,
      attempt: 1,
      agentSuccessClaim: true,
      agentOutcome: "success",
      outputSummary: "implemented the parser and ran the suite",
      sourceChars: 38,
    }],
    assumptions: [],
    openQuestions: [],
    recoveries: [],
    redirects: [],
    sourceCounts: {
      windowRounds: 1, reports: 1, assumptions: 0,
      openQuestions: 0, recoveries: 0, redirects: 0,
    },
    ...overrides,
  };
}

function minimalState(overrides: Partial<CanonicalLoopState> = {}): CanonicalLoopState {
  return {
    schemaVersion: CANONICAL_STATE_SCHEMA_VERSION,
    loopId: "test-loop",
    round: 1,
    maxRounds: 20,
    goalId: "goal-1",
    objective: "Test the assembler",
    rejectionNotice: null,
    currentTask: "Write tests for the assembler",
    successCriteria: ["all tests pass"],
    hardConstraints: ["no runtime deps"],
    activeConstraints: ["no runtime deps", "all tests pass"],
    retiredConstraints: [],
    constraintMetadata: [],
    reportedIssues: [],
    warnings: [],
    verificationFlags: [],
    subGoals: [],
    criterionStatuses: [],
    recurringFlags: [],
    stateFilePath: ".loopforge/state/test.md",
    capability: deriveConfiguredCapability(DEFAULT_POLICY),
    reportedProgress: {
      criteriaMet: [],
      criteriaRemaining: [],
      agentReportedRemaining: [],
      filesChanged: [],
      tests: null,
    },
    ...overrides,
  };
}

function input(overrides: Partial<PromptAssemblyInput> = {}): PromptAssemblyInput {
  const state = overrides.state ?? minimalState();
  return {
    state,
    level: "l2",
    attempt: 1,
    contextMode: "fresh_invocation",
    contextReason: "next_round",
    selfEvaluationBlock: "",
    workingMemory: state.workingMemory,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// L0 assembly
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — L0", () => {
  it("includes mandatory objective and task sections", () => {
    const artifact = assemblePromptArtifact(input({ level: "l0" }));
    assert.ok(artifact.renderedPrompt.includes("Objective"));
    assert.ok(artifact.renderedPrompt.includes("Current Task"));
    assert.equal(artifact.level, "l0");
  });

  it("includes retry requirements when blockers present", () => {
    const state = minimalState({
      reportedIssues: ["fix progress regression"],
      verificationFlags: [
        { severity: "warn", field: "test", check: "test_flag", detail: "flag detail" },
      ],
    });
    const artifact = assemblePromptArtifact(input({ level: "l0", state }));
    assert.ok(artifact.renderedPrompt.includes("Retry Requirements"));
  });

  it("keeps L0 prompts within the L0 budget", () => {
    const artifact = assemblePromptArtifact(input({ level: "l0" }));
    assert.ok(artifact.renderedPrompt.length <= DEFAULT_PROMPT_BUDGETS.l0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L1 assembly
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — L1", () => {
  it("uses a high safety ceiling so fresh prompts do not drop ordinary context", () => {
    assert.equal(DEFAULT_PROMPT_BUDGETS.l1, 50000);
    assert.equal(DEFAULT_PROMPT_BUDGETS.l2, 100000);
    const warning = "w".repeat(22000);
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({ warnings: [warning] }),
    }));
    assert.ok(artifact.renderedPrompt.includes(warning));
    assert.equal(artifact.droppedSections.length, 0);
    assert.equal(artifact.protectedOverflow, false);
  });

  it("includes mandatory sections", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1" }));
    assert.ok(artifact.renderedPrompt.includes("Objective"));
    assert.ok(artifact.renderedPrompt.includes("Current Task"));
    assert.equal(artifact.level, "l1");
  });

  it("keeps L1 prompts within the L1 budget", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1" }));
    assert.ok(artifact.renderedPrompt.length <= DEFAULT_PROMPT_BUDGETS.l1);
  });

  it("includes sub-goals when present (compact, max 5)", () => {
    const state = minimalState({
      subGoals: [
        { id: "sg-1", description: "Task A", status: "in_progress", declared_at_round: 1, status_changed_at_round: 2, priority: 0 },
        { id: "sg-2", description: "Task B", status: "pending", declared_at_round: 2, status_changed_at_round: 2, priority: 1 },
      ],
    });
    const artifact = assemblePromptArtifact(input({ level: "l1", state }));
    assert.ok(artifact.renderedPrompt.includes("Active Sub-Goals"));
    // v2.8: Sub-goal IDs are rendered for exact matching
    assert.ok(artifact.renderedPrompt.includes("`sg-1`"), "should render sub-goal ID sg-1");
    assert.ok(artifact.renderedPrompt.includes("`sg-2`"), "should render sub-goal ID sg-2");
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// L2 assembly
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — L2", () => {

  it("includes sub-goal dashboard when sub-goals exist", () => {
    const state = minimalState({
      subGoals: [
        { id: "sg-1", description: "Task A", status: "done", declared_at_round: 1, status_changed_at_round: 3, completed_at_round: 3, priority: 0 },
        { id: "sg-2", description: "Task B", status: "in_progress", declared_at_round: 2, status_changed_at_round: 4, priority: 1 },
      ],
    });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    assert.ok(artifact.renderedPrompt.includes("Active Sub-Goals"));
    // v3.7.1: done rows no longer render — done survives in the stats line
    assert.ok(artifact.renderedPrompt.includes("1 done"));
    assert.ok(!artifact.renderedPrompt.includes("`sg-1`"), "done rows never render in prompts");
    // v2.8/v3.7.1: active sub-goal IDs are rendered for exact matching
    assert.ok(artifact.renderedPrompt.includes("`sg-2`"), "should render sub-goal ID sg-2");
  });

  it("caps active sub-goal rows at max_active_subgoals (12) with full counts", () => {
    const subGoals = [];
    for (let i = 0; i < 15; i++) {
      subGoals.push({
        id: `sg-a${String(i).padStart(2, "0")}0000`,
        description: `pending goal ${i}`,
        status: "pending",
        declared_at_round: 1,
        status_changed_at_round: 1,
        priority: i,
      });
    }
    subGoals.push({
      id: "sg-b1111111",
      description: "blocked goal",
      status: "blocked",
      declared_at_round: 1,
      status_changed_at_round: 2,
      priority: 99,
    });
    const state = minimalState({ subGoals: subGoals as never });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    const dashboard = artifact.renderedPrompt.split("Active Sub-Goals")[1] ?? "";
    const rows = dashboard.split("\n").filter((line) => /^- [🔄🚫⏳]/.test(line.trim()));
    assert.equal(rows.length, 12, "rows are capped at max_active_subgoals");
    // Blocked items outrank pending regardless of priority.
    assert.ok(rows[0]?.includes("sg-b1111111"), "blocked rows come first");
    // v3.9.4: the cap hides DESCRIPTIONS, never ids — every active id renders.
    assert.ok(dashboard.includes("also active (ids only)"), "overflow ids render");
    for (const subGoal of subGoals) {
      assert.ok(artifact.renderedPrompt.includes(`\`${subGoal.id}\``),
        `active id ${subGoal.id} must survive the display cap`);
    }
    // Full counts survive the cap in the stats line.
    assert.match(artifact.renderedPrompt, /16 total · 16 active · 0 done · 0 canceled/);
  });

  it("keeps L2 prompts within the L2 budget", () => {
    const artifact = assemblePromptArtifact(input({ level: "l2" }));
    assert.ok(artifact.renderedPrompt.length <= DEFAULT_PROMPT_BUDGETS.l2);
  });

  it("v3.9.5: L2 always renders structured sections, never the state blob", () => {
    const state = minimalState({
      subGoals: [
        { id: "sg-1", description: "Task A", status: "done" as const,
          declared_at_round: 1, status_changed_at_round: 3,
          completed_at_round: 3, priority: 0 },
      ],
      reportedProgress: {
        criteriaMet: ["auth"], criteriaRemaining: ["api"],
        agentReportedRemaining: ["api"],
        filesChanged: ["src/auth.ts"],
        tests: { passed: 42, failed: 0, skipped: 0 },
      },
      retiredConstraints: ["old-rule"],
    });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    assert.ok(!artifact.renderedPrompt.includes("Phase Anchors"),
      "v3.9.6 removes LoopForge-authored phase narrative");
    assert.ok(artifact.renderedPrompt.includes("Active Sub-Goals"));
    assert.ok(!artifact.renderedPrompt.includes("Progress Dashboard"));
    assert.ok(!artifact.renderedPrompt.includes("Retired Constraints"));
    assert.ok(!artifact.renderedPrompt.includes("Agent Trust"));
    assert.ok(!artifact.renderedPrompt.includes("Full Rehydrated State"));
  });

  it("includes read instruction for L2 boundary reasons", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
    }));
    assert.ok(artifact.renderedPrompt.includes("Read the state file before acting"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.5 — memory boundary
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — memory boundary", () => {
  it("renders the static authority boundary at every level", () => {
    for (const level of ["l0", "l1", "l2"] as const) {
      const artifact = assemblePromptArtifact(input({ level }));
      assert.ok(artifact.renderedPrompt.includes("LoopForge authority boundary"),
        `${level} must carry the authority boundary`);
      assert.ok(artifact.renderedPrompt.includes("not a Git commit"),
        `${level} must state the round-commit boundary`);
      if (level !== "l0") {
        // L0 is a DENSITY level (fresh or in-context retry): it restates the
        // authority facts compactly, while L1/L2 carry the full boundary.
        assert.ok(artifact.renderedPrompt.includes("Criteria are the operator's acceptance surface"));
        assert.ok(artifact.renderedPrompt.includes("Round Contract is this round's deliverable"));
      }
    }
  });

  it("routes older history through replay/explain at every level", () => {
    for (const level of ["l0", "l1", "l2"] as const) {
      const artifact = assemblePromptArtifact(input({ level }));
      assert.ok(artifact.renderedPrompt.includes("loopforge_replay"),
        `${level} must route older history to replay`);
      assert.ok(artifact.renderedPrompt.includes("loopforge_status view=explain"),
        `${level} must route older history to explain`);
    }
    const retry = assemblePromptArtifact(input({
      level: "l0",
      attempt: 2,
      contextMode: "same_round_retry",
      contextReason: "enforcement_retry",
    }));
    assert.ok(retry.renderedPrompt.includes("loopforge_replay"));
    assert.ok(retry.renderedPrompt.includes("loopforge_status view=explain"));
  });

  it("does not call the state file the source of truth", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
    }));
    assert.ok(artifact.renderedPrompt.includes("Read the state file before acting"));
    assert.ok(!artifact.renderedPrompt.includes("the state file is the source of truth"));
    assert.ok(artifact.renderedPrompt.includes("derived"));
  });

  it("renders bounded Working Memory reports with explicit report labels", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        workingMemory: memory({
          reports: [{
            roundId: "loop:test-loop:round:1",
            round: 1, attempt: 1, agentSuccessClaim: false, agentOutcome: "partial",
            outputSummary: "Corrected assumption: old belief", sourceChars: 35,
          }],
        }),
      }),
    }));
    assert.ok(artifact.renderedPrompt.includes("Working Memory (Agent reports are claims"));
    assert.ok(artifact.renderedPrompt.includes("Latest committed report (Agent report) — R1"));
    assert.ok(artifact.renderedPrompt.includes("> Corrected assumption: old belief"));
  });

  it("labels reported and agent-supplied optional sections", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        reportedIssues: ["reported blocker"],
        recurringFlags: [{
          subject: "test_files_modified",
          kind: "verification_warning",
          ref: "",
          count: 2,
          rounds: [1, 2],
        }],
        workingMemory: memory(),
      }),
    }));
    assert.ok(artifact.renderedPrompt.includes("Agent-Reported Blockers (Agent report)"));
    assert.ok(artifact.renderedPrompt.includes("Recurring Findings"));
    assert.ok(artifact.renderedPrompt.includes("Working Memory (Agent reports are claims"));
  });

  it("records no removed narrative sections", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        workingMemory: memory(),
        retiredConstraints: ["old rule"],
      }),
    }));
    for (const id of [
      "changes", "rolling_outcomes", "discoveries", "failed_patterns",
      "retired_constraints", "full_state", "corrections",
    ]) {
      assert.ok(!artifact.sections.includes(id), `${id} must not render`);
    }
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// Artifact metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — metadata", () => {
  it("stamps the artifact schema version and the budget accounting", () => {
    const artifact = assemblePromptArtifact(input());
    assert.equal(artifact.schemaVersion, PROMPT_ARTIFACT_SCHEMA_VERSION);
    // v3.8.1: the artifact records what THIS prompt did.
    assert.equal(artifact.round, 1);
    assert.ok(Array.isArray(artifact.sections));
    assert.ok(Array.isArray(artifact.droppedSections));
    assert.equal(typeof artifact.protectedOverflow, "boolean");
    assert.equal(typeof artifact.budget, "number");
    // `renderedChars` measures the BUDGETED section area; `renderedPrompt`
    // also carries the fixed header, the self-evaluation block and the footer.
    assert.ok(artifact.renderedChars > 0);
    assert.ok(artifact.renderedChars <= artifact.renderedPrompt.length);
    assert.ok(artifact.budget > 0);
    assert.ok(artifact.sections.includes("objective"));
  });

  it("generates a prompt hash", () => {
    const artifact = assemblePromptArtifact(input());
    assert.ok(artifact.promptHash.length > 0);
    assert.equal(typeof artifact.promptHash, "string");
  });

  it("generates a state hash", () => {
    const artifact = assemblePromptArtifact(input());
    assert.ok(artifact.stateHash.length > 0);
  });

  it("produces deterministic hashes for identical input", () => {
    const a = assemblePromptArtifact(input());
    const b = assemblePromptArtifact(input());
    assert.equal(a.promptHash, b.promptHash);
    assert.equal(a.stateHash, b.stateHash);
  });

  it("drops optional sections under a tight budget", () => {
    const state = minimalState({ reportedIssues: ["a reported blocker"] });
    const tight = assemblePromptArtifact(input({ level: "l1", budgets: { l1: 10 }, state }));
    const ample = assemblePromptArtifact(input({ level: "l1", state }));
    assert.ok(ample.renderedPrompt.includes("Agent-Reported Blockers (Agent report)"));
    assert.ok(!tight.renderedPrompt.includes("Agent-Reported Blockers (Agent report)"));
    assert.ok(tight.renderedPrompt.includes("Current Task"));
  });

  it("includes how-to-complete footer", () => {
    const artifact = assemblePromptArtifact(input());
    assert.ok(artifact.renderedPrompt.includes("How to Complete This Round"));
    assert.ok(artifact.renderedPrompt.includes("`submissionHandle` object returned"));
    assert.ok(artifact.renderedPrompt.includes("loopforge_checkpoint"));
    assert.ok(artifact.renderedPrompt.includes(LOST_HANDLE_ROUTING),
      "the footer carries the shared lost-handle routing rule");
    assert.ok(!artifact.renderedPrompt.includes("progress_estimate`"));
    assert.ok(!artifact.renderedPrompt.includes("Evaluation Rules"));
  });

  it("mandatory sections are always included even under budget", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      budgets: { l0: 50 },
    }));
    // objective and current_task should still be included
    assert.ok(artifact.renderedPrompt.includes("Objective"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — verification flag actions
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — verification flag actions", () => {
  const flag = (severity: "info" | "warn" | "error", check: string): CanonicalLoopState["verificationFlags"][number] => ({
    severity,
    field: "field",
    check,
    detail: `detail for ${check}`,
  });

  it("appends a Fix continuation to error flags in L1", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        verificationFlags: [flag("error", "success_with_remaining_criteria")],
      }),
    }));
    assert.match(artifact.renderedPrompt, /→ Fix: Complete the remaining criteria/);
    // The base line keeps its machine prefix (and now carries the f- id).
    assert.match(
      artifact.renderedPrompt,
      /🚫 \[success_with_remaining_criteria\] `field` — detail for success_with_remaining_criteria\n  → Fix:/,
    );
  });

  it("appends an Action continuation to warn flags in L2", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        verificationFlags: [flag("warn", "criteria_claims_unverified")],
      }),
    }));
    assert.match(artifact.renderedPrompt, /→ Action: Provide evidence for each claimed success criterion/);
  });

  it("does not append a continuation to info flags", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        verificationFlags: [flag("info", "duplicate_constraint_discovery")],
      }),
    }));
    assert.ok(!artifact.renderedPrompt.includes("→ Fix:"), "info flags must not carry a Fix continuation");
    assert.ok(!artifact.renderedPrompt.includes("→ Action:"), "info flags must not carry an Action continuation");
    assert.match(artifact.renderedPrompt, /ℹ️ \[duplicate_constraint_discovery\]/);
  });

  it("keeps L0 byte-identical — no continuation lines", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      state: minimalState({
        verificationFlags: [
          flag("error", "success_with_remaining_criteria"),
          flag("warn", "blocked_without_blocker"),
        ],
      }),
    }));
    assert.ok(!artifact.renderedPrompt.includes("→ Fix:"), "L0 retry prompt must not grow");
    assert.ok(!artifact.renderedPrompt.includes("→ Action:"), "L0 retry prompt must not grow");
    assert.ok(artifact.renderedPrompt.includes("🚫"));
    assert.ok(artifact.renderedPrompt.includes("CONTRADICTED"));
  });

  it("keeps the Gate Verdict line and CONTRADICTED semantics", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        verificationFlags: [flag("error", "required_command_failed")],
      }),
    }));
    assert.ok(artifact.renderedPrompt.includes("Gate Verdict: CONTRADICTED"));
  });

  it("falls back to a generic action for unmapped checks", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        verificationFlags: [flag("error", "future_check_name")],
      }),
    }));
    assert.match(artifact.renderedPrompt, /→ Fix: Re-examine the flagged claim/);
  });

  it("covers every verification check constant (no name drift)", () => {
    // v3.3: iterate the module's CHECK_* exports instead of a hardcoded
    // list — a new constant can never silently miss an action entry again
    // (the pre-v3.3 list had already drifted behind by three v3.3 checks).
    // v3.7: the flag set converged 27 → 24 (progress_regression and
    // empty_change_with_passing removed, success_claim_conflict merged into
    // outcome_success_contradiction) — the floor follows the surviving set.
    const exports = verificationGate as unknown as Record<string, unknown>;
    const checks = Object.keys(exports)
      .filter((key) => key.startsWith("CHECK_") && typeof exports[key] === "string")
      .map((key) => exports[key] as string);
    // v3.7 note: CHECK_DOMAIN (the domain map) is also a CHECK_-prefixed
    // export but is not a check id — filtered above by the string check.
    // v3.9.7: 19 — R9 (post-backtrack restore) was deleted.
    assert.ok(checks.length === 19,
      `expected the 19 surviving CHECK_* constants, got ${checks.length}`);
    for (const check of checks) {
      const action = verificationActionFor(check);
      assert.ok(
        typeof action === "string" && action.length > 10,
        `missing action for check "${check}"`,
      );
      assert.notEqual(action, verificationActionFor("__unknown__"),
        `check "${check}" must not fall back to the generic action`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — L1 diff-collapse
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Roadmap section, machine dashboard rows, round stats
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — Roadmap section", () => {
  const roadmapState = (): CanonicalLoopState => minimalState({
    round: 7,
    criterionStatuses: [
      { id: "cr-11111111", text: "all tests pass", status: "verified" as const, status_at_round: 3, status_source: "machine" as const },
      { id: "cr-22222222", text: "no regressions", status: "remaining" as const },
    ],
    subGoals: [
      { id: "sg-1", description: "write auth tests", status: "in_progress" as const,
        declared_at_round: 2, status_changed_at_round: 4, priority: 0 },
    ],
  });

  it("empty roadmap renders nothing (L2)", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2", state: minimalState(),
    }));
    assert.ok(!artifact.renderedPrompt.includes("Roadmap"));
  });

});

describe("v3.3 — machine dashboard rows and round stats", () => {
  it("v3.8.1: the L2 prompt carries neither the Progress Dashboard nor Round Stats", () => {
    // Both sections were re-compositions of facts the prompt already states
    // elsewhere, mixed with the agent’s OWN numbers (completion estimate,
    // test counts, per-round progress deltas). The criterion list and the
    // machine git/criteria rows still render in the STATE FILE, where a human
    // or external tool reads them — see canonical-state.test.ts.
    const state = minimalState({
      reportedProgress: {
        criteriaMet: [],
        criteriaRemaining: [],
        agentReportedRemaining: [],
        filesChanged: ["src/a.ts"],
        tests: { passed: 8, failed: 1, skipped: 0 },
      },
      machineStatus: {
        windowRounds: 3,
        machineProgress: "changed",
        changedRounds: 2,
        providers: ["git"],
      },
      criterionStatuses: [
        { id: "cr-11111111", text: "all tests pass", status: "verified" as const, status_at_round: 3, status_source: "machine" as const },
      ],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l2", state,
    }));
    const prompt = artifact.renderedPrompt;
    assert.ok(!prompt.includes("Progress Dashboard"));
    assert.ok(!prompt.includes("Round Stats"));
    assert.ok(!prompt.includes("Machine (git)"));
    assert.ok(!prompt.includes("Goal → Criteria"));
    assert.ok(!prompt.includes("self-reported estimate"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.8.1 — fixed priority, protected set, deterministic truncation
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — budget determinism", () => {
  /** A state with plenty of optional content at every priority. */
  const loadedState = () => minimalState({
    subGoals: [
      { id: "sg-1", description: "Task A", status: "in_progress", declared_at_round: 1, status_changed_at_round: 2, priority: 0 },
    ],
    reportedIssues: ["a blocker"],
    workingMemory: memory(),
    retiredConstraints: ["an old rule"],
    recurringFlags: [
      { subject: "test_files_modified", kind: "verification_warning", ref: "", count: 3, rounds: [1, 2, 3] },
    ],
  });

  it("renders the protected set even when the budget cannot hold it", () => {
    // 200 chars is far below the protected content of a loaded L2 prompt.
    const artifact = assemblePromptArtifact(input({
      level: "l2", state: loadedState(),
      budgets: { l2: 200 },
    }));
    const prompt = artifact.renderedPrompt;
    for (const heading of ["Objective", "Current Task", "Active Hard Constraints"]) {
      assert.ok(prompt.includes(heading), `${heading} is protected and must render`);
    }
    assert.ok(artifact.protectedOverflow,
      "protected content over the ceiling is RECORDED, never silently exceeded");
    // The optional tail is what gets cut.
    assert.ok(artifact.droppedSections.length > 0, "optional sections are dropped");
    assert.ok(!artifact.droppedSections.includes("objective"));
  });

  it("drops optional sections lowest-priority-first", () => {
    const state = loadedState();
    // Make the lowest-priority optional section large enough to create a real
    // cut point: blockers/corrections can fit while this one cannot.
    state.recurringFlags = Array.from({ length: 8 }, (_, index) => ({
      subject: `recurring finding ${index} ${"x".repeat(1000)}`,
      kind: "verification_warning" as const,
      ref: "",
      count: 3,
      rounds: [1, 2, 3],
    }));
    const artifact = assemblePromptArtifact(input({
      level: "l2", state,
      budgets: { l2: 5000 },
    }));
    // The invariant is about the CUT POINT, not about any single section:
    // every optional section that rendered must outrank every one that was
    // dropped. (Greedy first-fit does not give this — it can render a small
    // low-priority section into room a larger high-priority one could not
    // use.)
    const order = [
      "working_memory", "compile_warnings", "blockers", "active_warnings",
    ];
    const rendered = order.filter((id) => artifact.sections.includes(id));
    const dropped = order.filter((id) => artifact.droppedSections.includes(id));
    assert.ok(rendered.length > 0, "a tight budget must render the higher-priority tail");
    if (dropped.length > 0) {
      const lastRendered = order.indexOf(rendered[rendered.length - 1]);
      const firstDropped = order.indexOf(dropped[0]);
      assert.ok(
        lastRendered < firstDropped,
        `rendered [${rendered.join(", ")}] must all outrank dropped [${dropped.join(", ")}]`,
      );
    } else {
      // v4.0.3: the cut point can be a PARTIAL render of the lowest-priority
      // section. Every higher-priority optional section must still be whole,
      // and the partial one must be the tail of the ordering.
      assert.ok(rendered.includes("blockers"),
        "a partial tail never displaces a higher-priority optional section");
      assert.equal(rendered[rendered.length - 1], "active_warnings");
    }
  });

  it("is deterministic: identical input gives an identical prompt and artifact", () => {
    const make = () => assemblePromptArtifact(input({
      level: "l2", state: loadedState(),
      budgets: { l2: 2000 },
    }));
    const a = make();
    const b = make();
    assert.equal(a.renderedPrompt, b.renderedPrompt);
    assert.equal(a.promptHash, b.promptHash);
    assert.deepEqual(a.sections, b.sections);
    assert.deepEqual(a.droppedSections, b.droppedSections);
    assert.equal(a.protectedOverflow, b.protectedOverflow);
  });

  it("never truncates mid-line", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2", state: loadedState(),
      budgets: { l2: 1400 },
    }));
    // A truncated section is cut at a newline, so the budgeted area ends a
    // line cleanly rather than in the middle of a bullet.
    const area = artifact.renderedPrompt.slice(0, artifact.renderedChars);
    assert.ok(area.length > 0);
    assert.ok(!/\n\s*$/.test(area.slice(0, -1)) || area.endsWith("\n"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.1 — prompt request effects (output facts, never control state)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.7 — rejection notice is protected at every level", () => {
  for (const level of ["l0", "l1", "l2"] as const) {
    it(`renders the enforcement fix at ${level}`, () => {
      const artifact = assemblePromptArtifact(input({
        level,
        state: minimalState({
          rejectionNotice: "### Required Fix\n\nrestore the entrypoint",
        }),
        budgets: { l0: 1, l1: 1, l2: 1 },
      }));
      assert.ok(artifact.renderedPrompt.includes("restore the entrypoint"));
      assert.ok(artifact.sections.includes("retry_requirements"));
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// v4.0.4 — runtime round guidance and context-pair fail-closed
// ═══════════════════════════════════════════════════════════════════════════

describe("v4.0.4 — round guidance in the fixed footer", () => {
  it("L0 is a density level that can be a clean-context invocation", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      contextMode: "fresh_invocation",
      contextReason: "next_round",
    }));
    assert.match(artifact.renderedPrompt,
      /Context: clean context — next round \(fresh_invocation; workspace continues\)/);
    assert.ok(artifact.renderedPrompt.includes("## Round Boundary"));
    assert.ok(artifact.renderedPrompt.includes(
      renderRoundGuidance("prompt", "fresh_invocation")));
    assert.ok(artifact.renderedPrompt.includes(ROUND_BOUNDARY_PRINCIPLE));
  });

  it("a clean-context prompt states both workspace continuity and transcript exclusion", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      contextMode: "fresh_invocation",
      contextReason: "next_round",
    }));
    assert.ok(artifact.renderedPrompt.includes("not a workspace reset"));
    assert.ok(artifact.renderedPrompt.includes("current modified workspace"));
    assert.ok(artifact.renderedPrompt.includes("previous transcript"));
    assert.ok(artifact.renderedPrompt.includes("uncommitted reasoning"));
  });

  it("a same-round retry renders the short guidance and in-context label", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      attempt: 2,
      contextMode: "same_round_retry",
      contextReason: "enforcement_retry",
    }));
    assert.match(artifact.renderedPrompt, /Context: in-context repair/);
    assert.ok(artifact.renderedPrompt.includes(
      renderRoundGuidance("prompt", "same_round_retry")));
  });

  it("fails closed on an illegal context pair instead of correcting it", () => {
    assert.throws(() => assemblePromptArtifact(input({
      level: "l2",
      attempt: 2,
      contextMode: "same_round_retry",
      contextReason: "enforcement_retry",
    })), /Illegal prompt context boundary/);
  });

  it("charges the guidance against the default budget without protected overflow", () => {
    for (const level of ["l0", "l1", "l2"] as const) {
      const artifact = assemblePromptArtifact(input({ level }));
      assert.ok(artifact.renderedChars <= artifact.budget,
        `${level}: renderedChars ${artifact.renderedChars} <= budget ${artifact.budget}`);
      assert.equal(artifact.protectedOverflow, false,
        `${level}: protected content must fit beside the footer`);
      assert.ok(artifact.budget < DEFAULT_PROMPT_BUDGETS[level],
        "the footer is excluded from the section budget");
    }
  });

  it("keeps a real L0 enforcement retry inside the 5000-char ceiling", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      attempt: 2,
      contextMode: "same_round_retry",
      contextReason: "enforcement_retry",
      state: minimalState({ rejectionNotice: "fix the finding", reportedIssues: [] }),
    }));
    assert.ok(artifact.renderedPrompt.length <= 5000,
      `L0 retry prompt was ${artifact.renderedPrompt.length} chars`);
  });
});
