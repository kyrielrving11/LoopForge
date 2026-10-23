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
    schemaVersion: 4 as const,
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
    corrections: [],
    remainingCriteria: [],
    blockers: [],
    verificationFlags: [],
    discoveries: [],
    subGoals: [],
    criterionStatuses: [],
    recurringFlags: [],
    stateFilePath: ".loopforge/state/test.md",
    capability: deriveConfiguredCapability(DEFAULT_POLICY),
    progress: {
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

  it("keeps L0 prompts within the L0 budget", () => {
    const artifact = assemblePromptArtifact(input({ level: "l0" }));
    assert.ok(artifact.renderedPrompt.length <= DEFAULT_PROMPT_BUDGETS.l0);
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
      progress: {
        criteriaMet: ["auth"], criteriaRemaining: ["api"],
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
      reasons: ["recovery_boundary"],
    }));
    assert.ok(artifact.renderedPrompt.includes("Read the full state file before acting"));
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
      assert.ok(artifact.renderedPrompt.includes("Criteria are the operator's acceptance surface"));
      assert.ok(artifact.renderedPrompt.includes("Round Contract is this round's deliverable"));
    }
  });

  it("does not call the state file the source of truth", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      reasons: ["recovery_boundary"],
    }));
    assert.ok(artifact.renderedPrompt.includes("Read the full state file before acting"));
    assert.ok(!artifact.renderedPrompt.includes("the state file is the source of truth"));
    assert.ok(artifact.renderedPrompt.includes("derived"));
  });

  it("renders committed Corrections but not output summaries", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        corrections: ["Corrected assumption: old belief"],
      }),
    }));
    assert.ok(artifact.renderedPrompt.includes("Corrections (committed reports)"));
    assert.ok(artifact.renderedPrompt.includes("Corrected assumption: old belief"));
    assert.ok(!artifact.renderedPrompt.includes("prior summary"));
  });

  it("labels reported and agent-supplied optional sections", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        blockers: ["reported blocker"],
        recurringFlags: [{
          subject: "test_files_modified",
          kind: "verification_warning",
          ref: "",
          count: 2,
          rounds: [1, 2],
        }],
        corrections: ["Corrected assumption: old belief"],
      }),
    }));
    assert.ok(artifact.renderedPrompt.includes("Blockers (reported/current)"));
    assert.ok(artifact.renderedPrompt.includes("Recurring Findings"));
    assert.ok(artifact.renderedPrompt.includes("Corrections (committed reports)"));
  });

  it("records no removed narrative sections", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        corrections: ["Corrected assumption: old belief"],
        discoveries: ["a discovery"],
        retiredConstraints: ["old rule"],
      }),
    }));
    for (const id of [
      "changes", "rolling_outcomes", "discoveries", "failed_patterns",
      "retired_constraints", "full_state",
    ]) {
      assert.ok(!artifact.sections.includes(id), `${id} must not render`);
    }
  });

  it("does not point confusion alerts at a disabled state file", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({ stateFilePath: "" }),
      promptRequests: { confusion_points: ["what is this?"] },
    }));
    assert.ok(artifact.renderedPrompt.toLowerCase().includes("no state file is enabled"));
    assert.ok(!artifact.renderedPrompt.includes("the state file has full context"));
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
    const state = minimalState({ corrections: ["Corrected assumption: added auth.ts"] });
    const tight = assemblePromptArtifact(input({ level: "l1", budgets: { l1: 10 }, state }));
    const ample = assemblePromptArtifact(input({ level: "l1", state }));
    assert.ok(ample.renderedPrompt.includes("Corrections"));
    assert.ok(!tight.renderedPrompt.includes("Corrections"));
    assert.ok(tight.renderedPrompt.includes("Current Task"));
  });

  it("includes how-to-complete footer", () => {
    const artifact = assemblePromptArtifact(input());
    assert.ok(artifact.renderedPrompt.includes("How to Complete This Round"));
    assert.ok(artifact.renderedPrompt.includes("`transactionId` from the latest LoopForge response"));
    assert.ok(artifact.renderedPrompt.includes("loopforge_checkpoint"));
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

  it("renders constraint provenance in normative sections and critical context", () => {
    const state = minimalState({
      activeConstraints: ["discovered rule", "preserved rule", "planned rule", "legacy rule"],
      hardConstraints: [],
      constraintMetadata: [
        { id: "c-discover", text: "discovered rule", last_violated_at_round: 0, source: "discovered", source_round: 2 },
        { id: "c-preserve", text: "preserved rule", last_violated_at_round: 0, source: "preserved", source_round: 3 },
        { id: "c-plan", text: "planned rule", last_violated_at_round: 0, source: "plan", source_round: 1 },
        { id: "c-legacy", text: "legacy rule", last_violated_at_round: 0, source: "unrecorded" },
      ],
    });
    const artifact = assemblePromptArtifact(input({
      state,
      promptRequests: { emphasize: ["discovered rule"] },
    }));
    assert.ok(artifact.renderedPrompt.includes("(Agent-declared R2; report, not machine-verified)"));
    assert.ok(artifact.renderedPrompt.includes("(Agent discovery preserved by rollback R3; report)"));
    assert.ok(artifact.renderedPrompt.includes("(plan/carried R1)"));
    assert.ok(artifact.renderedPrompt.includes("(origin not recorded in committed rounds)"));
    const critical = artifact.renderedPrompt.split("🔴 Critical Context")[1] ?? "";
    assert.ok(critical.includes("(Agent-declared R2; report, not machine-verified)"));
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
        activeConstraints: [
          "no runtime deps",
          "all tests pass",
          "SafeERC20 required for all external contract calls",
        ],
      }),
      promptRequests: {
        confusion_points: ["confused about X"],
        emphasize: ["SafeERC20 required for all external contract calls"],
      },
    }));
    assert.ok(artifact.renderedPrompt.includes("Confusion Alerts"));
    assert.ok(artifact.renderedPrompt.includes("Critical Context"));
  });

  it("v3.9.5: emphasize cannot resurrect a removed discovery narrative", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state: minimalState({
        activeConstraints: ["no runtime deps"],
        discoveries: ["SafeERC20 required for all external contract calls"],
      }),
      promptRequests: {
        emphasize: ["SafeERC20 required for all external contract calls"],
      },
    }));
    assert.ok(!artifact.renderedPrompt.includes("Critical Context"));
    assert.ok(!artifact.renderedPrompt.includes("SafeERC20"));
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
      { id: "cr-11111111", text: "all tests pass", status: "verified" as const, met_at_round: 3, related_subgoal_ids: [] },
      { id: "cr-22222222", text: "no regressions", status: "remaining" as const, related_subgoal_ids: [] },
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
      progress: {
        criteriaMet: [],
        criteriaRemaining: [],
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
        { id: "cr-11111111", text: "all tests pass", status: "verified" as const, met_at_round: 3, related_subgoal_ids: [] },
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
    remainingCriteria: ["criterion one", "criterion two"],
    blockers: ["a blocker"],
    corrections: ["Corrected assumption: an old belief"],
    discoveries: ["a discovery"],
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
    const artifact = assemblePromptArtifact(input({
      level: "l2", state: loadedState(),
      budgets: { l2: 2200 },
    }));
    // The invariant is about the CUT POINT, not about any single section:
    // every optional section that rendered must outrank every one that was
    // dropped. (Greedy first-fit does not give this — it can render a small
    // low-priority section into room a larger high-priority one could not
    // use.)
    const order = [
      "blockers", "corrections", "active_warnings",
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

describe("v3.9.1 — prompt request effects", () => {
  it("records applied/no_match/capped for emphasize and confusion points", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state: minimalState({
        activeConstraints: ["alpha", "beta", "gamma", "delta"],
        hardConstraints: [],
        successCriteria: [],
      }),
      promptRequests: {
        emphasize: ["alpha", "missing-item", "beta", "gamma", "delta"],
        confusion_points: ["first confusion", "second confusion"],
      },
    }));
    const effects = artifact.promptRequestEffects ?? [];
    const emphasize = new Map(
      effects.filter((effect) => effect.field === "emphasize")
        .map((effect) => [effect.request, effect.status]),
    );
    assert.equal(emphasize.get("alpha"), "applied");
    assert.equal(emphasize.get("missing-item"), "no_match");
    assert.equal(emphasize.get("delta"), "capped",
      "L1 keeps at most three emphasized candidates");
    const confusion = effects.filter((effect) => effect.field === "confusion_points");
    assert.deepEqual(confusion.map((effect) => effect.status), ["applied", "capped"],
      "L1 renders one confusion point");
  });

  it("records level_ignored when L0 ignores prompt requests", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l0",
      promptRequests: {
        emphasize: ["alpha"],
        confusion_points: ["confused"],
      },
    }));
    const effects = artifact.promptRequestEffects ?? [];
    assert.deepEqual(effects.map((effect) => effect.status),
      ["level_ignored", "level_ignored"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.9.7 — structured emphasis candidates (all current governance objects)
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.7 — structured emphasis candidates", () => {
  const flag = {
    severity: "warn" as const,
    field: "success",
    check: "test_flag",
    detail: "the machine saw detail text",
  };

  it("moves a sub-goal by its real sg- id and does not duplicate it", () => {
    const state = minimalState({
      subGoals: [{
        id: "sg-12345678",
        description: "Add login",
        status: "pending",
        declared_at_round: 1,
        status_changed_at_round: 1,
        priority: 0,
      }],
    });
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state,
      promptRequests: { emphasize: ["sg-12345678"] },
    }));
    assert.ok(artifact.renderedPrompt.includes("🔴 Critical Context"));
    assert.equal(
      artifact.renderedPrompt.match(/Add login/g)?.length,
      1,
      "the sub-goal is moved, not copied",
    );
    assert.ok(artifact.promptRequestEffects?.some((effect) =>
      effect.status === "applied" && effect.matched_ids?.includes("sg-12345678")));
  });

  it("moves a finding by f- id and removes it from the Verification Gate", () => {
    const state = minimalState({ verificationFlags: [flag] });
    const findingId = `f-${deriveItemId(JSON.stringify([flag.check, flag.field, ""]))}`;
    const artifact = assemblePromptArtifact(input({
      level: "l1",
      state,
      promptRequests: { emphasize: [findingId] },
    }));
    assert.equal(
      artifact.renderedPrompt.match(/the machine saw detail text/g)?.length,
      1,
      "the finding renders once, in Critical Context",
    );
    assert.ok(artifact.promptRequestEffects?.some((effect) =>
      effect.status === "applied" && effect.matched_ids?.includes(findingId)));
  });

  it("moves one contract item while keeping the heading and other items", () => {
    const state = minimalState({
      currentTask: "stale",
      roundContract: {
        id: "rc-12345678",
        declared_at_round: 1,
        work_item: "Ship auth",
        scope: ["src"],
        items: [
          {
            id: "rci-11111111",
            description: "login works",
            criterion_refs: [],
            subgoal_refs: [],
            verify_with: ["verify"],
          },
          {
            id: "rci-22222222",
            description: "logout works",
            criterion_refs: [],
            subgoal_refs: [],
            verify_with: ["verify"],
          },
        ],
        config_hash_by_command: {},
      },
      contractItemStatuses: {
        contractId: "rc-12345678",
        closure: "open",
        closed_at_round: null,
        items: [],
        verifiedCount: 0,
        contradictedCount: 0,
        insufficientCount: 0,
      },
    });
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state,
      promptRequests: { emphasize: ["rci-11111111"] },
    }));
    assert.equal(artifact.renderedPrompt.match(/login works/g)?.length, 1);
    assert.ok(artifact.renderedPrompt.includes("logout works"));
    assert.ok(artifact.renderedPrompt.includes("Ship auth"));
  });

  it("moves the recovery brief by its reserved id", () => {
    const state = minimalState({ recoveryBrief: ["- **Trigger**: progress_stall"] });
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      state,
      promptRequests: { emphasize: ["recovery"] },
    }));
    assert.equal(artifact.renderedPrompt.match(/Trigger/g)?.length, 1);
    assert.ok(artifact.renderedPrompt.includes("Critical Context"));
  });

  it("never resurrects an unknown or historical target", () => {
    const artifact = assemblePromptArtifact(input({
      level: "l2",
      promptRequests: { emphasize: ["sg-deadbeef"] },
    }));
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"));
    assert.equal(artifact.promptRequestEffects?.[0]?.status, "no_match");
  });

  it("reports ambiguous normalized text without choosing a normative object", () => {
    const state = minimalState({
      subGoals: [
        { id: "sg-11111111", description: "same work", status: "pending", declared_at_round: 1, status_changed_at_round: 1, priority: 0 },
        { id: "sg-22222222", description: "same work", status: "pending", declared_at_round: 1, status_changed_at_round: 1, priority: 1 },
      ],
    });
    const artifact = assemblePromptArtifact(input({
      state,
      promptRequests: { emphasize: ["same work"] },
    }));
    const effect = artifact.promptRequestEffects?.[0];
    assert.equal(effect?.status, "ambiguous");
    assert.deepEqual(effect?.matched_ids, ["sg-11111111", "sg-22222222"]);
    assert.equal(effect?.matched_count, 2);
    assert.ok(!artifact.renderedPrompt.includes("🔴 Critical Context"));

    const explicit = assemblePromptArtifact(input({
      state,
      promptRequests: { emphasize: ["sg-22222222"] },
    }));
    assert.equal(explicit.promptRequestEffects?.[0]?.status, "applied");
    assert.ok(explicit.renderedPrompt.includes("🔴 Critical Context"));
  });
});

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
