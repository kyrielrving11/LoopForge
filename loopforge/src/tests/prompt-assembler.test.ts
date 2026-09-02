/** Tests for prompt-assembler — single-pass prompt rendering. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemblePromptArtifact, DEFAULT_PROMPT_BUDGETS, verificationActionFor } from "../prompt-assembler.js";
import type { PromptAssemblyInput } from "../prompt-assembler.js";
import type { CanonicalLoopState, PresentedStateSnapshot } from "../canonical-state.js";
import type { ConstraintMeta } from "../protocol.js";
import { deriveItemId } from "../token-utils.js";
import { getPolicy, resetPolicy, setPolicyForTest } from "../policy.js";
// Namespace import of the verification-gate CHECK_* constants: the coverage
// test below iterates them so a new constant can never silently lack an
// action entry. (Tests may import verification-gate freely — only the src
// modules must respect the prompt-assembler ← verification-gate cycle rule.)
import * as verificationGate from "../verification-gate.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function minimalState(overrides: Partial<CanonicalLoopState> = {}): CanonicalLoopState {
  return {
    schemaVersion: 1 as const,
    loopId: "test-loop",
    round: 1,
    maxRounds: 20,
    goalId: "goal-1",
    objective: "Test the assembler",
    objectiveVersion: 1,
    currentTask: "Write tests for the assembler",
    successCriteria: ["all tests pass"],
    hardConstraints: ["no runtime deps"],
    activeConstraints: ["no runtime deps", "all tests pass"],
    retiredConstraints: [],
    inactiveConstraints: [],
    constraintMetadata: [],
    changesSinceLastRound: [],
    remainingCriteria: [],
    blockers: [],
    verificationFlags: [],
    discoveries: [],
    nextAction: "",
    rollingOutcomes: [],
    recurringIssues: [],
    failedPatterns: [],
    milestones: [],
    loopSynthesis: "",
    subGoals: [],
    criterionStatuses: [],
    lessons: [],
    suggestedNextTask: "",
    externalContext: "",
    agentTrustScore: undefined,
    agentTrustTrend: [],
    stateFilePath: ".loopforge/state/test.md",
    progress: {
      estimate: null,
      criteriaMet: [],
      criteriaRemaining: [],
      filesChanged: [],
      tests: null,
    },
    ...overrides,
  };
}

function input(overrides: Partial<PromptAssemblyInput> = {}): PromptAssemblyInput {
  return {
    state: minimalState(),
    level: "l2",
    reasons: ["first_round"],
    mode: "adaptive",
    attempt: 1,
    selfEvaluationBlock: "",
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
      blockers: ["fix progress regression"],
      verificationFlags: [
        { severity: "warn", field: "test", check: "test_flag", detail: "flag detail" },
      ],
    });
    const artifact = assemblePromptArtifact(input({ level: "l0", state }));
    assert.ok(artifact.renderedPrompt.includes("Retry Requirements"));
  });

  it("respects L0 budget of 3000 characters", () => {
    const artifact = assemblePromptArtifact(input({ level: "l0" }));
    assert.equal(artifact.budgetChars, 3000);
  });

  it("records included sections", () => {
    const artifact = assemblePromptArtifact(input({ level: "l0" }));
    assert.ok(artifact.includedSections.includes("objective"));
    assert.ok(artifact.includedSections.includes("current_task"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L1 assembly
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — L1", () => {
  it("includes mandatory sections", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1" }));
    assert.ok(artifact.renderedPrompt.includes("Objective"));
    assert.ok(artifact.renderedPrompt.includes("Current Task"));
    assert.equal(artifact.level, "l1");
  });

  it("respects L1 budget of 7000 characters", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1" }));
    assert.equal(artifact.budgetChars, 7000);
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

  it("shows recent rounds when outcomes exist", () => {
    const state = minimalState({
      rollingOutcomes: ["[R1] accepted: fixed auth"],
    });
    const artifact = assemblePromptArtifact(input({ level: "l1", state }));
    assert.ok(artifact.renderedPrompt.includes("Recent Rounds"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// L2 assembly
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — L2", () => {
  it("includes full state when fullStateMarkdown is provided", () => {
    const md = "# Full State\nThe complete state content.";
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      fullStateMarkdown: md,
    }));
    assert.ok(artifact.renderedPrompt.includes("Full Rehydrated State"));
  });

  it("includes milestones section when milestones exist", () => {
    const state = minimalState({
      milestones: [{
        label: "Phase 1",
        round_range: { start: 1, end: 5 },
        outcome: "completed core",
        carried_constraints: ["no deps"],
        resolved_constraints: [],
        progress_at_boundary: 0.5,
        kind: "auto",
        generated_at_round: 5,
      }],
    });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    assert.ok(artifact.renderedPrompt.includes("Phase History"));
  });

  it("includes sub-goal dashboard when sub-goals exist", () => {
    const state = minimalState({
      subGoals: [
        { id: "sg-1", description: "Task A", status: "done", declared_at_round: 1, status_changed_at_round: 3, completed_at_round: 3, priority: 0 },
        { id: "sg-2", description: "Task B", status: "in_progress", declared_at_round: 2, status_changed_at_round: 4, priority: 1 },
      ],
    });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    assert.ok(artifact.renderedPrompt.includes("Sub-Goal Dashboard"));
    assert.ok(artifact.renderedPrompt.includes("done"));
    // v2.8: Sub-goal IDs are rendered for exact matching
    assert.ok(artifact.renderedPrompt.includes("`sg-1`"), "should render sub-goal ID sg-1");
    assert.ok(artifact.renderedPrompt.includes("`sg-2`"), "should render sub-goal ID sg-2");
  });

  it("includes failed patterns when present", () => {
    const state = minimalState({
      failedPatterns: ["repeated auth failure pattern"],
    });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    assert.ok(artifact.renderedPrompt.includes("Failed Patterns"));
  });

  it("respects L2 budget", () => {
    const artifact = assemblePromptArtifact(input({ level: "l2" }));
    assert.equal(artifact.budgetChars, DEFAULT_PROMPT_BUDGETS.l2);
  });

  // ── v2.8: L2 pointer mode — path B structured rendering ──────────────

  it("renders structured sections (not blob) when fullStateMarkdown is absent", () => {
    const state = minimalState({
      milestones: [{
        label: "Phase 1", round_range: { start: 1, end: 5 },
        outcome: "done", carried_constraints: [], resolved_constraints: [],
        progress_at_boundary: 0.5, kind: "auto" as const, generated_at_round: 5,
      }],
      subGoals: [
        { id: "sg-1", description: "Task A", status: "done" as const,
          declared_at_round: 1, status_changed_at_round: 3,
          completed_at_round: 3, priority: 0 },
      ],
      inactiveConstraints: ["old-constraint"],
      constraintMetadata: [{
        id: "c-oldcons", text: "old-constraint", discovered_at_round: 1,
        last_violated_at_round: 0, source: "discovered" as const,
        status: "inactive" as const,
      }],
      agentTrustScore: 0.85,
      agentTrustTrend: [0.9, 0.85],
      progress: {
        estimate: 0.6, criteriaMet: ["auth"], criteriaRemaining: ["api"],
        filesChanged: ["src/auth.ts"],
        tests: { passed: 42, failed: 0, skipped: 0 },
      },
      retiredConstraints: ["old-rule"],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      fullStateMarkdown: undefined, // ← pointer mode
      state,
    }));
    // Path B structured rendering
    assert.ok(artifact.renderedPrompt.includes("Phase History"));
    assert.ok(artifact.renderedPrompt.includes("Sub-Goal Dashboard"));
    // v2.8 gap fills
    assert.ok(artifact.renderedPrompt.includes("Progress Dashboard"));
    assert.ok(artifact.renderedPrompt.includes("60%"));
    assert.ok(artifact.renderedPrompt.includes("Inactive Constraints"));
    assert.ok(artifact.renderedPrompt.includes("Agent Trust"));
    assert.ok(artifact.renderedPrompt.includes("85%"));
    assert.ok(artifact.renderedPrompt.includes("Retired Constraints"));
    // Must NOT contain the monolithic blob header
    assert.ok(!artifact.renderedPrompt.includes("Full Rehydrated State"));
  });

  it("renders full state blob when fullStateMarkdown is provided (backward compat)", () => {
    const md = "# Full State\nThe complete cognitive state.";
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      fullStateMarkdown: md,
    }));
    assert.ok(artifact.renderedPrompt.includes("Full Rehydrated State"));
  });

  it("includes read instruction for L2 pointer mode reasons", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      reasons: ["periodic_refresh"],
      fullStateMarkdown: undefined,
    }));
    assert.ok(artifact.renderedPrompt.includes("Read the full state file before acting"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Artifact metadata
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — metadata", () => {
  it("includes schema version", () => {
    const artifact = assemblePromptArtifact(input());
    assert.equal(artifact.schemaVersion, 1);
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

  it("records budget exceeded when applicable", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      budgets: { l0: 10 },
    }));
    assert.ok(artifact.budgetExceeded);
  });

  it("includes how-to-complete footer", () => {
    const artifact = assemblePromptArtifact(input());
    assert.ok(artifact.renderedPrompt.includes("How to Complete This Round"));
  });

  it("includes level reasons", () => {
    const artifact = assemblePromptArtifact(input({ reasons: ["first_round", "plan_boundary"] }));
    assert.ok(artifact.levelReasons.includes("first_round"));
    assert.ok(artifact.levelReasons.includes("plan_boundary"));
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
// v2.9: prompt_requests rendering
// ═══════════════════════════════════════════════════════════════════════════

describe("assemblePromptArtifact — prompt_requests L2", () => {
  it("renders confusion alerts at the top when present", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      promptRequests: {
        confusion_points: ["I don't understand milestone tracking"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("⚠️ Confusion Alerts"));
    assert.ok(artifact.renderedPrompt.includes("I don't understand milestone tracking"));
    // Confusion alerts should appear before the Objective
    const alertIdx = artifact.renderedPrompt.indexOf("⚠️ Confusion Alerts");
    const objIdx = artifact.renderedPrompt.indexOf("Objective");
    assert.ok(alertIdx < objIdx, "confusion alerts should come before objective");
  });

  it("renders critical context with emphasized items", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        activeConstraints: ["use SafeERC20 for all external calls"],
        discoveries: ["timelock has minimum delay of 2 days"],
      }),
      promptRequests: {
        emphasize: ["use SafeERC20 for external calls"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("🔴 Critical Context"));
    assert.ok(artifact.renderedPrompt.includes("SafeERC20"));
  });

  it("does not duplicate an emphasized hard constraint or success criterion", () => {
    // Real state shape: hard constraints and success criteria live in BOTH
    // their own sections and the active-constraint list (loop-compiler merges
    // objective.hard_constraints / success_criteria into constraints_active).
    // v3.2.1: emphasized items must be MOVED (pure reorder) — the source
    // sections lose them, so each renders exactly once.
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        activeConstraints: ["no runtime deps", "all tests pass"],
        hardConstraints: ["no runtime deps"],
        successCriteria: ["all tests pass"],
      }),
      promptRequests: {
        emphasize: ["no runtime deps", "all tests pass"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("🔴 Critical Context"));
    const hardCount = artifact.renderedPrompt.split("no runtime deps").length - 1;
    assert.equal(hardCount, 1,
      `emphasized hard constraint must render exactly once (Critical Context only), got ${hardCount}`);
    const criteriaCount = artifact.renderedPrompt.split("all tests pass").length - 1;
    assert.equal(criteriaCount, 1,
      `emphasized success criterion must render exactly once (Critical Context only), got ${criteriaCount}`);
  });

  it("includes confusion_alerts and critical_context in includedSections", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        activeConstraints: ["no runtime deps", "all tests pass"],
        discoveries: ["SafeERC20 required for all external contract calls"],
      }),
      promptRequests: {
        confusion_points: ["confused about X"],
        emphasize: ["SafeERC20 required for external calls"],
      },
    }));
    assert.ok(artifact.includedSections.includes("confusion_alerts"));
    assert.ok(artifact.includedSections.includes("critical_context"));
  });

  it("ignores expand in L2 (already expanded)", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({ milestones: [{ label: "Phase 1", round_range: { start: 1, end: 5 }, outcome: "done", carried_constraints: [], resolved_constraints: [], progress_at_boundary: 0.5, kind: "agent_declared", generated_at_round: 5 }] }),
      promptRequests: {
        expand: ["milestones"],
      },
    }));
    // Should NOT have an "expand:" entry in includedSections for L2
    const expandEntries = artifact.includedSections.filter((s) => s.startsWith("expand:"));
    assert.equal(expandEntries.length, 0);
  });
});

describe("assemblePromptArtifact — prompt_requests L1", () => {
  it("renders confusion alerts with first entry only", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      promptRequests: {
        confusion_points: ["confused about A", "also confused about B"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("confused about A"));
    // Second confusion point should be collapsed
    assert.ok(artifact.renderedPrompt.includes("1 more confusion point"));
    assert.ok(!artifact.renderedPrompt.includes("also confused about B"));
  });

  it("expands a single section when requested", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        loopSynthesis: "Loop spans 15 rounds across 3 phases.",
      }),
      promptRequests: {
        expand: ["loop_synthesis"],
      },
    }));
    assert.ok(artifact.includedSections.some((s) => s === "expand:loop_synthesis"));
    assert.ok(artifact.renderedPrompt.includes("Loop spans"));
  });

  it("only expands first section when multiple requested in L1", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        milestones: [{ label: "P1", round_range: { start: 1, end: 3 }, outcome: "ok", carried_constraints: [], resolved_constraints: [], progress_at_boundary: 0.3, kind: "auto", generated_at_round: 3 }],
        loopSynthesis: "Synthesis text.",
      }),
      promptRequests: {
        expand: ["milestones", "loop_synthesis"],
      },
    }));
    // Only the first expand entry should be rendered
    const expandEntries = artifact.includedSections.filter((s) => s.startsWith("expand:"));
    assert.equal(expandEntries.length, 1);
    assert.equal(expandEntries[0], "expand:milestones");
  });

  it("caps emphasize at L1 limit (3)", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        activeConstraints: ["A", "B", "C", "D", "E"],
      }),
      promptRequests: {
        emphasize: ["A", "B", "C", "D", "E"],
      },
    }));
    // Should only show at most 3 (L1 cap)
    const criticalSection = artifact.renderedPrompt.indexOf("🔴 Critical Context");
    assert.ok(criticalSection >= 0);
  });
});

describe("assemblePromptArtifact — prompt_requests L0", () => {
  it("ignores all prompt_requests in L0", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      promptRequests: {
        confusion_points: ["I am confused"],
        emphasize: ["important constraint"],
        expand: ["milestones"],
      },
    }));
    assert.ok(!artifact.renderedPrompt.includes("⚠️ Confusion Alerts"));
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"));
    assert.ok(!artifact.renderedPrompt.includes("I am confused"));
  });
});

describe("assemblePromptArtifact — prompt_requests backward compatibility", () => {
  it("renders normally when promptRequests is undefined", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      promptRequests: undefined,
    }));
    assert.ok(artifact.renderedPrompt.includes("Objective"));
    assert.ok(!artifact.renderedPrompt.includes("⚠️ Confusion Alerts"));
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"));
  });

  it("renders normally with empty prompt_requests fields", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      promptRequests: { emphasize: [], expand: [], confusion_points: [] },
    }));
    assert.ok(artifact.renderedPrompt.includes("Objective"));
    assert.ok(!artifact.renderedPrompt.includes("⚠️ Confusion Alerts"));
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"));
  });

  it("emphasize is a pure reorder — the matched item appears exactly once", () => {
    const constraint = "use SafeERC20 for all external calls";
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({ activeConstraints: [constraint] }),
      promptRequests: {
        emphasize: ["use SafeERC20 for external calls"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("🔴 Critical Context"));
    // v2.14: the item is MOVED to Critical Context, not duplicated — the
    // old implementation appended it while keeping the original section
    // entry, doubling the token cost of every emphasize.
    const occurrences = artifact.renderedPrompt.split(constraint).length - 1;
    assert.equal(occurrences, 1, `expected exactly 1 occurrence, got ${occurrences}`);
  });

  it("L2 renders at most max_confusion_points confusion alerts", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      promptRequests: {
        confusion_points: [
          "confused about alpha",
          "confused about beta",
          "confused about gamma",
          "confused about delta",
          "confused about epsilon",
        ],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("confused about alpha"));
    assert.ok(artifact.renderedPrompt.includes("confused about gamma"));
    // v2.14: the L2 render was unbounded by max_confusion_points (policy=3)
    assert.ok(!artifact.renderedPrompt.includes("confused about delta"));
    assert.ok(!artifact.renderedPrompt.includes("confused about epsilon"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — Verification Gate actionable instructions
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
    // The base line keeps its exact prefix.
    assert.match(artifact.renderedPrompt, /- 🚫 \[success_with_remaining_criteria\] detail for success_with_remaining_criteria\n  → Fix:/);
  });

  it("appends an Action continuation to warn flags in L2", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        verificationFlags: [flag("warn", "progress_regression")],
      }),
    }));
    assert.match(artifact.renderedPrompt, /→ Action: Correct progress_estimate/);
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
    assert.ok(artifact.renderedPrompt.includes("- ℹ️ [duplicate_constraint_discovery]"));
  });

  it("keeps L0 byte-identical — no continuation lines", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      state: minimalState({
        verificationFlags: [
          flag("error", "success_with_remaining_criteria"),
          flag("warn", "progress_regression"),
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
    const checks = Object.keys(verificationGate)
      .filter((key) => key.startsWith("CHECK_"))
      .map((key) => (verificationGate as unknown as Record<string, string>)[key]);
    assert.ok(checks.length >= 26,
      `expected all CHECK_* constants, got ${checks.length}`);
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

describe("v3.2 — L1 diff-collapse", () => {
  const baselineOf = (overrides: Partial<PresentedStateSnapshot> = {}): PresentedStateSnapshot => ({
    round: 2,
    constraintIds: ["c-11111111", "c-22222222", "c-33333333", "c-44444444"],
    subGoals: [["sg-11111111", "pending"], ["sg-22222222", "pending"], ["sg-33333333", "pending"]],
    milestoneRanges: [[1, 2]],
    ...overrides,
  });
  const constraints = [
    "No external dependencies",
    "Tests must pass",
    "Keep API stable",
    "Migrate data",
  ];
  const constraintMeta = (): ConstraintMeta[] => constraints.map((text) => ({
    id: `c-${deriveItemId(text)}`,
    text,
    discovered_at_round: 1,
    last_violated_at_round: 0,
    source: "discovered" as const,
    status: "active" as const,
  }));

  it("renders changed constraints in full with markers and a collapse line", () => {
    const meta = constraintMeta();
    const baseline = baselineOf({ constraintIds: meta.map((m) => m.id) });
    const state = minimalState({
      round: 3,
      activeConstraints: [
        "No external dependencies",
        "Tests must pass",
        "Keep API stable",
        "Migrate data",
        "New constraint added",
      ],
      constraintMetadata: [
        ...meta,
        { id: `c-${deriveItemId("New constraint added")}`, text: "New constraint added",
          discovered_at_round: 3, last_violated_at_round: 0, source: "discovered" as const, status: "active" as const },
      ],
      hardConstraints: [],
    });
    // "Keep API stable" violated this round.
    state.constraintMetadata = state.constraintMetadata.map((m) =>
      m.text === "Keep API stable" ? { ...m, last_violated_at_round: 3 } : m);

    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state,
      presentedBaseline: baseline,
    }));
    const p = artifact.renderedPrompt;
    assert.match(p, /New constraint added \(new this round\)/);
    assert.match(p, /Keep API stable \(violated this round\)/);
    assert.match(p, /… 3 unchanged constraints, 0 demoted since R2 \(see state file\)/);
    assert.match(p, /📄 Full state: `\.loopforge\/state\/test\.md` \(updated round 3\)/);
    assert.ok(!p.includes("No external dependencies] No external dependencies") &&
      !p.includes("Tests must pass] Tests must pass"),
      "unchanged constraints must be collapsed");
  });

  it("renders sub-goal status transitions in full and collapses the rest", () => {
    const baseline = baselineOf({ subGoals: [
      ["sg-11111111", "pending"], ["sg-22222222", "pending"], ["sg-33333333", "pending"], ["sg-44444444", "pending"],
    ] });
    const state = minimalState({
      round: 3,
      subGoals: [
        { id: "sg-11111111", description: "Task A", status: "pending", declared_at_round: 1, status_changed_at_round: 1, priority: 0 },
        { id: "sg-22222222", description: "Task B", status: "in_progress", declared_at_round: 1, status_changed_at_round: 3, priority: 1 },
        { id: "sg-33333333", description: "Task C", status: "pending", declared_at_round: 1, status_changed_at_round: 1, priority: 2 },
        { id: "sg-44444444", description: "Task D", status: "pending", declared_at_round: 1, status_changed_at_round: 1, priority: 3 },
      ],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state,
      presentedBaseline: baseline,
    }));
    const p = artifact.renderedPrompt;
    assert.match(p, /🔄 \[`sg-22222222`\] Task B/);
    assert.match(p, /… 3 unchanged sub-goals, 1 changed since R2 \(see state file\)/);
  });

  it("collapses earlier Recent Rounds but keeps the newest three", () => {
    const state = minimalState({
      round: 5,
      rollingOutcomes: [
        "[R1] accepted: one",
        "[R2] accepted: two",
        "[R3] accepted: three",
        "[R4] accepted: four",
      ],
      milestones: [{ label: "M", round_range: { start: 1, end: 2 }, outcome: "o",
        carried_constraints: [], resolved_constraints: [], progress_at_boundary: 0.5,
        kind: "agent_declared", generated_at_round: 2 }],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state,
      presentedBaseline: baselineOf(),
    }));
    const p = artifact.renderedPrompt;
    assert.ok(p.includes("[R4] accepted: four"));
    assert.ok(p.includes("[R3] accepted: three"));
    assert.ok(p.includes("[R2] accepted: two"));
    assert.match(p, /… 1 earlier round \(see state file\)/);
  });

  it("renders all Recent Rounds when a milestone boundary was crossed", () => {
    const state = minimalState({
      round: 5,
      rollingOutcomes: ["[R1] a", "[R2] b", "[R3] c", "[R4] d"],
      milestones: [{ label: "M2", round_range: { start: 3, end: 4 }, outcome: "o",
        carried_constraints: [], resolved_constraints: [], progress_at_boundary: 0.8,
        kind: "criteria_milestone", generated_at_round: 4 }],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state,
      presentedBaseline: baselineOf(),
    }));
    const p = artifact.renderedPrompt;
    assert.ok(p.includes("[R1] a"), "milestone boundary must force full render");
    assert.ok(!p.includes("earlier round"), "no collapse line when boundary crossed");
  });

  it("leaves L2 unaffected by a baseline — no collapse lines, plain pointer", () => {
    const meta = constraintMeta();
    const baseline = baselineOf({ constraintIds: meta.map((m) => m.id) });
    const state = minimalState({
      round: 3,
      activeConstraints: ["No external dependencies", "Tests must pass", "Keep API stable", "Migrate data"],
      constraintMetadata: meta,
      milestones: [{ label: "M", round_range: { start: 1, end: 2 }, outcome: "o",
        carried_constraints: [], resolved_constraints: [], progress_at_boundary: 0.5,
        kind: "auto", generated_at_round: 2 }],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state,
      presentedBaseline: baseline,
    }));
    const p = artifact.renderedPrompt;
    assert.ok(!p.includes("unchanged constraints"), "L2 must not collapse");
    assert.ok(!p.includes("(updated round"), "L2 pointer must stay plain");
  });

  it("renders in full when there is no baseline (first round / old-format vault)", () => {
    const meta = constraintMeta();
    const state = minimalState({
      round: 3,
      activeConstraints: ["No external dependencies", "Tests must pass", "Keep API stable"],
      constraintMetadata: meta,
    });
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state,
      presentedBaseline: null,
    }));
    const p = artifact.renderedPrompt;
    assert.ok(p.includes("No external dependencies"), "no baseline → full render");
    assert.ok(!p.includes("unchanged constraints"), "no collapse line without baseline");
  });

  it("renders in full when l1_collapse_enabled is false", () => {
    const policy = { ...getPolicy(), prompt: { ...getPolicy().prompt, l1_collapse_enabled: false } };
    setPolicyForTest(policy);
    try {
      const meta = constraintMeta();
      const baseline = baselineOf({ constraintIds: meta.map((m) => m.id) });
      const state = minimalState({
        round: 3,
        activeConstraints: ["No external dependencies", "Tests must pass", "Keep API stable", "Migrate data"],
        constraintMetadata: meta,
      });
      const artifact = assemblePromptArtifact(input({
        level: "l1",
        state,
        presentedBaseline: baseline,
      }));
      const p = artifact.renderedPrompt;
      assert.ok(p.includes("No external dependencies"), "kill switch → full render");
      assert.ok(!p.includes("unchanged constraints"));
    } finally {
      resetPolicy();
    }
  });

  it("emphasized constraints are excluded from the demoted count and render in Critical Context", () => {
    const meta = constraintMeta();
    const baseline = baselineOf({ constraintIds: meta.map((m) => m.id) });
    // "Tests must pass" is in the baseline but absent from active this round
    // (demoted), and the agent emphasized it — it must NOT count as demoted.
    const state = minimalState({
      round: 3,
      activeConstraints: [
        "No external dependencies",
        "Tests must pass",
        "Keep API stable",
        "Migrate data",
        "Another active one",
      ],
      constraintMetadata: [
        ...meta,
        { id: `c-${deriveItemId("Another active one")}`, text: "Another active one",
          discovered_at_round: 2, last_violated_at_round: 0, source: "discovered" as const, status: "active" as const },
      ],
      hardConstraints: [],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state,
      presentedBaseline: baseline,
      promptRequests: { emphasize: ["Tests must pass"] },
    }));
    const p = artifact.renderedPrompt;
    assert.ok(p.includes("🔴 Critical Context"), "emphasized item must render in Critical Context");
    // unchanged = No external deps + Keep API stable + Migrate data = 3 (Another active one is new);
    // removed = Tests must pass (emphasized, excluded) = 0.
    assert.match(p, /… 3 unchanged constraints, 0 demoted since R2/,
      "emphasized baseline item must not count as demoted");
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v3.2 — external context in L1
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.2 — external context in L1", () => {
  it("renders External Context in L1 when provided", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({ externalContext: "Repo convention: ESM only, no CommonJS." }),
    }));
    assert.ok(artifact.renderedPrompt.includes("External Context"));
    assert.ok(artifact.renderedPrompt.includes("ESM only"));
  });

  it("omits External Context from L1 when empty", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1" }));
    assert.ok(!artifact.renderedPrompt.includes("External Context"));
  });

  it("keeps L0 free of External Context", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      state: minimalState({ externalContext: "Repo convention: ESM only." }),
    }));
    assert.ok(!artifact.renderedPrompt.includes("External Context"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Roadmap section, machine dashboard rows, round stats
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.3 — Roadmap section", () => {
  const roadmapState = (): CanonicalLoopState => minimalState({
    round: 7,
    milestones: [{
      label: "Core Module", round_range: { start: 1, end: 4 },
      outcome: "completed core module", carried_constraints: [],
      resolved_constraints: [], progress_at_boundary: 0.4,
      kind: "auto" as const, generated_at_round: 4,
    }],
    criterionStatuses: [
      { id: "cr-11111111", text: "all tests pass", status: "met" as const, met_at_round: 3, related_subgoal_ids: [] },
      { id: "cr-22222222", text: "no regressions", status: "remaining" as const, related_subgoal_ids: [] },
    ],
    subGoals: [
      { id: "sg-1", description: "write auth tests", status: "in_progress" as const,
        declared_at_round: 2, status_changed_at_round: 4, priority: 0 },
    ],
  });

  it("includes the Roadmap section in structured L2 when data present", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state: roadmapState(),
    }));
    assert.ok(artifact.includedSections.includes("roadmap"));
    assert.ok(artifact.renderedPrompt.includes("### Roadmap"));
    assert.ok(artifact.renderedPrompt.includes("Position: round 7/20"));
    assert.ok(artifact.renderedPrompt.includes("3 rounds since the last milestone boundary"));
    assert.ok(artifact.renderedPrompt.includes("1/2 met · 1 remaining"));
    assert.ok(artifact.renderedPrompt.includes("1 in progress · 0 pending"));
  });

  it("renders Roadmap in L1 when data present and omits it when absent", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1", state: roadmapState() }));
    assert.ok(artifact.includedSections.includes("roadmap"));
    assert.ok(artifact.renderedPrompt.includes("### Roadmap"));

    const empty = assemblePromptArtifact(input({ level: "l1", state: minimalState() }));
    assert.ok(!empty.includedSections.includes("roadmap"));
    assert.ok(!empty.renderedPrompt.includes("Roadmap"));
  });

  it("empty roadmap adds nothing to budget or includedSections (L2)", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state: minimalState(),
    }));
    assert.ok(!artifact.includedSections.includes("roadmap"));
    assert.ok(!artifact.renderedPrompt.includes("Roadmap"));
  });

  it("L1 collapse invariant: roadmap never echoes milestone labels", () => {
    // Milestone labels are collapsed content in L1 (diff-collapse invariant);
    // the roadmap reports distance only, never the boundary's identity.
    const artifact = assemblePromptArtifact(input({ level: "l1", state: roadmapState() }));
    assert.ok(!artifact.renderedPrompt.includes("Core Module"));
  });
});

describe("v3.3 — machine dashboard rows and round stats", () => {
  it("Progress Dashboard shows machine rows when machineStatus is present", () => {
    const state = minimalState({
      progress: {
        estimate: 0.6,
        criteriaMet: [],
        criteriaRemaining: [],
        filesChanged: ["src/a.ts"],
        tests: null,
      },
      machineStatus: { windowRounds: 3, gitMotion: true, motionRounds: 2 },
      criterionStatuses: [
        { id: "cr-11111111", text: "all tests pass", status: "met" as const, met_at_round: 3, related_subgoal_ids: [] },
        { id: "cr-22222222", text: "no regressions", status: "remaining" as const, related_subgoal_ids: [] },
      ],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state,
    }));
    const prompt = artifact.renderedPrompt;
    assert.ok(prompt.includes("Machine (git)"));
    assert.ok(prompt.includes("changes in 2/3 recent committed rounds"));
    assert.ok(prompt.includes("Machine (criteria)"));
    assert.ok(prompt.includes("1/2 met across committed rounds"));
    assert.ok(prompt.includes("self-reported estimate (unverified until machine-backed)"));
  });

  it("renders Round Stats from state.roundStats and omits the section without it", () => {
    const withStats = minimalState({
      roundStats: [
        { round: 12, filesChangedCount: 3, rejectedAttempts: 1, progressDelta: 0.1 },
        { round: 13, filesChangedCount: 0, rejectedAttempts: 0, progressDelta: -0.05 },
      ],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state: withStats,
    }));
    assert.ok(artifact.includedSections.includes("round_stats"));
    assert.ok(artifact.renderedPrompt.includes("R12: 3 files, 1 rejected attempt, Δ+0.10"));
    assert.ok(artifact.renderedPrompt.includes("R13: 0 files, Δ-0.05"));

    const without = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state: minimalState(),
    }));
    assert.ok(!without.includedSections.includes("round_stats"));
    assert.ok(!without.renderedPrompt.includes("Round Stats"));
  });
});
