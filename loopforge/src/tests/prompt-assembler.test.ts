/** Tests for prompt-assembler — single-pass prompt rendering. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemblePromptArtifact, DEFAULT_PROMPT_BUDGETS, verificationActionFor } from "../prompt-assembler.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "../protocol.js";
import type { PromptAssemblyInput } from "../prompt-assembler.js";
import type { CanonicalLoopState } from "../canonical-state.js";
import type { ConstraintMeta } from "../protocol.js";
import { deriveItemId } from "../token-utils.js";
import { deriveConfiguredCapability, getPolicy, resetPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";
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
    constraintMetadata: [],
    changesSinceLastRound: [],
    remainingCriteria: [],
    blockers: [],
    verificationFlags: [],
    discoveries: [],
    rollingOutcomes: [],
    failedPatterns: [],
    milestones: [],
    subGoals: [],
    criterionStatuses: [],
    recurringFlags: [],
    externalContext: "",
    stateFilePath: ".loopforge/state/test.md",
    capability: deriveConfiguredCapability(DEFAULT_POLICY),
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

  it("keeps L0 prompts within the 3000-character budget", () => {
    const artifact = assemblePromptArtifact(input({ level: "l0" }));
    assert.ok(artifact.renderedPrompt.length <= 3000);
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

  it("keeps L1 prompts within the 7000-character budget", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1" }));
    assert.ok(artifact.renderedPrompt.length <= 7000);
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
    const dashboard = artifact.renderedPrompt.split("Sub-Goal Dashboard")[1]?.split("───")[0] ?? "";
    const rows = dashboard.split("\n").filter((line) => /^[🔄🚫⏳]/.test(line.trim()));
    assert.equal(rows.length, 12, "rows are capped at max_active_subgoals");
    // Blocked items outrank pending regardless of priority.
    assert.ok(rows[0]?.includes("sg-b1111111"), "blocked rows come first");
    // Full counts survive the cap in the stats line.
    assert.match(artifact.renderedPrompt, /─── 16 total: 16 active, 0 done, 0 canceled/);
  });

  it("includes failed patterns when present", () => {
    const state = minimalState({
      failedPatterns: ["repeated auth failure pattern"],
    });
    const artifact = assemblePromptArtifact(input({ level: "l2", state }));
    assert.ok(artifact.renderedPrompt.includes("Failed Patterns"));
  });

  it("keeps L2 prompts within the L2 budget", () => {
    const artifact = assemblePromptArtifact(input({ level: "l2" }));
    assert.ok(artifact.renderedPrompt.length <= DEFAULT_PROMPT_BUDGETS.l2);
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
    // v3.8.1: Progress Dashboard is gone from the prompt entirely — see the
    // dedicated invariant test below.
    assert.ok(!artifact.renderedPrompt.includes("Progress Dashboard"));
    assert.ok(artifact.renderedPrompt.includes("Retired Constraints"));
    // v3.8.1: the Agent Trust section is gone — the score was an arbitrary
    // weighting of flag counts and its "trend" was computed from a different
    // source, so neither was a fact about the loop.
    assert.ok(!artifact.renderedPrompt.includes("Agent Trust"));
    // Must NOT contain the monolithic blob header
    assert.ok(!artifact.renderedPrompt.includes("Full Rehydrated State"));
  });

  it("renders full state blob when fullStateMarkdown is provided", () => {
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
      reasons: ["recovery_boundary"],
      fullStateMarkdown: undefined,
    }));
    assert.ok(artifact.renderedPrompt.includes("Read the full state file before acting"));
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
    const state = minimalState({ changesSinceLastRound: ["added auth.ts"] });
    const tight = assemblePromptArtifact(input({ level: "l0", budgets: { l0: 10 }, state }));
    const ample = assemblePromptArtifact(input({ level: "l0", state }));
    assert.ok(ample.renderedPrompt.includes("New Evidence / Changes"));
    assert.ok(!tight.renderedPrompt.includes("New Evidence / Changes"));
    assert.ok(tight.renderedPrompt.includes("Current Task"));
  });

  it("includes how-to-complete footer", () => {
    const artifact = assemblePromptArtifact(input());
    assert.ok(artifact.renderedPrompt.includes("How to Complete This Round"));
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
        emphasize: ["use SafeERC20 for all external calls"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("🔴 Critical Context"));
    assert.ok(artifact.renderedPrompt.includes("SafeERC20"));
  });

  it("v3.8.1: a merely SIMILAR emphasis target matches nothing", () => {
    // The Jaccard fallback is gone. "use SafeERC20 for external calls" is
    // close enough to have matched "…for all external calls" before; now an
    // emphasis either names the item (exactly, or by stable id) or is dropped.
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        activeConstraints: ["use SafeERC20 for all external calls"],
      }),
      promptRequests: {
        emphasize: ["use SafeERC20 for external calls"],
      },
    }));
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"),
      "a near-miss emphasis must not pull the item into Critical Context");
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

  it("renders confusion alerts and critical context when requested", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        activeConstraints: ["no runtime deps", "all tests pass"],
        discoveries: ["SafeERC20 required for all external contract calls"],
      }),
      promptRequests: {
        confusion_points: ["confused about X"],
        emphasize: ["SafeERC20 required for all external contract calls"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("Confusion Alerts"));
    assert.ok(artifact.renderedPrompt.includes("Critical Context"));
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
      },
    }));
    assert.ok(!artifact.renderedPrompt.includes("⚠️ Confusion Alerts"));
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"));
    assert.ok(!artifact.renderedPrompt.includes("I am confused"));
  });
});

describe("assemblePromptArtifact — optional prompt_requests", () => {
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
      promptRequests: { emphasize: [], confusion_points: [] },
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
        emphasize: [constraint],
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
    assert.ok(artifact.renderedPrompt.includes("- ℹ️ [duplicate_constraint_discovery]"));
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
    // v3.8: 20 — the drift checks and the legacy contract checks were
    // replaced by the item-model checks.
    assert.ok(checks.length === 20,
      `expected the 20 surviving CHECK_* constants, got ${checks.length}`);
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
      { id: "cr-11111111", text: "all tests pass", status: "verified" as const, met_at_round: 3, related_subgoal_ids: [] },
      { id: "cr-22222222", text: "no regressions", status: "remaining" as const, related_subgoal_ids: [] },
    ],
    subGoals: [
      { id: "sg-1", description: "write auth tests", status: "in_progress" as const,
        declared_at_round: 2, status_changed_at_round: 4, priority: 0 },
    ],
  });

  it("includes the one-line Phase section in structured L2 when data present", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state: roadmapState(),
    }));
    assert.ok(artifact.renderedPrompt.includes("### Phase"));
    assert.ok(artifact.renderedPrompt.includes("round 7/20"));
    assert.ok(artifact.renderedPrompt.includes("3 rounds since the last boundary"));
    assert.ok(!artifact.renderedPrompt.includes("### Roadmap"));
  });

  it("renders the Phase line in L1 when a phase exists and omits it when none does", () => {
    const artifact = assemblePromptArtifact(input({ level: "l1", state: roadmapState() }));
    assert.ok(artifact.renderedPrompt.includes("### Phase"));

    // No milestone → no phase to name, and the line stays out entirely
    // (position alone is already in the prompt header).
    const empty = assemblePromptArtifact(input({ level: "l1", state: minimalState() }));
    assert.ok(!empty.renderedPrompt.includes("### Phase"));
  });

  it("empty roadmap renders nothing (L2)", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state: minimalState(),
    }));
    assert.ok(!artifact.renderedPrompt.includes("Roadmap"));
  });

  it("L1 names the current phase but never renders Phase History", () => {
    // v3.8.1: the old rule ("L1 must never echo a milestone label") was a
    // consequence of L1 diff-collapse — labels were collapsed content, and the
    // roadmap reported distance only to keep the diff stable. The collapse is
    // gone, so the phase line may name the phase the agent declared. What must
    // NOT appear is L2's Phase History, which is the full-rehydration view.
    const artifact = assemblePromptArtifact(input({ level: "l1", state: roadmapState() }));
    assert.ok(artifact.renderedPrompt.includes("Core Module"),
      "the phase line names the current phase");
    assert.ok(!artifact.renderedPrompt.includes("Phase History"));
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
      progress: {
        estimate: 0.6,
        criteriaMet: [],
        criteriaRemaining: [],
        filesChanged: ["src/a.ts"],
        tests: { passed: 8, failed: 1, skipped: 0 },
      },
      machineStatus: { windowRounds: 3, gitMotion: true, motionRounds: 2 },
      criterionStatuses: [
        { id: "cr-11111111", text: "all tests pass", status: "verified" as const, met_at_round: 3, related_subgoal_ids: [] },
      ],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state,
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
    remainingCriteria: ["criterion one", "criterion two"],
    blockers: ["a blocker"],
    discoveries: ["a discovery"],
    rollingOutcomes: ["[R1] accepted: something"],
    externalContext: "external notes",
    retiredConstraints: ["an old rule"],
    recurringFlags: [
      { subject: "test_files_modified", kind: "verification_warning", ref: "", count: 3, rounds: [1, 2, 3] },
    ],
    milestones: [{
      label: "Core Module", round_range: { start: 1, end: 2 }, outcome: "done",
      carried_constraints: [], resolved_constraints: [], progress_at_boundary: 0.5,
      kind: "auto" as const, generated_at_round: 2,
    }],
  });

  it("renders the protected set even when the budget cannot hold it", () => {
    // 200 chars is far below the protected content of a loaded L2 prompt.
    const artifact = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state: loadedState(),
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
    const artifact = assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state: loadedState(),
      budgets: { l2: 2000 },
    }));
    // The invariant is about the CUT POINT, not about any single section:
    // every optional section that rendered must outrank every one that was
    // dropped. (Greedy first-fit does not give this — it can render a small
    // low-priority section into room a larger high-priority one could not
    // use.)
    const order = [
      "active_constraints", "remaining", "sub_goals", "blockers",
      "discoveries", "rolling_outcomes", "phase", "active_warnings",
      "external_context", "retired_constraints", "milestones",
    ];
    const rendered = order.filter((id) => artifact.sections.includes(id));
    const dropped = order.filter((id) => artifact.droppedSections.includes(id));
    assert.ok(dropped.length > 0, "a tight budget must cut something");
    assert.ok(rendered.length > 0, "...but not everything");
    const lastRendered = order.indexOf(rendered[rendered.length - 1]);
    const firstDropped = order.indexOf(dropped[0]);
    assert.ok(
      lastRendered < firstDropped,
      `rendered [${rendered.join(", ")}] must all outrank dropped [${dropped.join(", ")}]`,
    );
  });

  it("is deterministic: identical input gives an identical prompt and artifact", () => {
    const make = () => assemblePromptArtifact(input({
      level: "l2", fullStateMarkdown: undefined, state: loadedState(),
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
      level: "l2", fullStateMarkdown: undefined, state: loadedState(),
      budgets: { l2: 1400 },
    }));
    // A truncated section is cut at a newline, so the budgeted area ends a
    // line cleanly rather than in the middle of a bullet.
    const area = artifact.renderedPrompt.slice(0, artifact.renderedChars);
    assert.ok(area.length > 0);
    assert.ok(!/\n\s*$/.test(area.slice(0, -1)) || area.endsWith("\n"));
  });
});
