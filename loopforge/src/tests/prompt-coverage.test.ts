/** v3.9.4 — ID-level prompt coverage. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemblePromptArtifact } from "../prompt-assembler.js";
import {
  assertPromptCoverage,
  derivePromptCoverage,
  ProjectionCoverageError,
} from "../prompt-coverage.js";
import {
  formatRoundContract,
  renderCanonicalStateMarkdown,
  type CanonicalLoopState,
} from "../canonical-state.js";
import type { ActiveContractView } from "../round-contract.js";
import type { ConstraintMeta, SubGoal } from "../protocol.js";
import { makeConstraintMeta } from "../protocol.js";
import { deriveCriterionId } from "../token-utils.js";
import { DEFAULT_POLICY, deriveConfiguredCapability } from "../policy.js";
import { applyToolEnvelope } from "../mcp/server.js";

const AUTH = "auth works";
const API = "api works";
const AUTH_ID = deriveCriterionId(AUTH);
const API_ID = deriveCriterionId(API);

function meta(
  text: string,
  source: ConstraintMeta["source"],
  id: string,
): ConstraintMeta {
  return makeConstraintMeta({ id, text, source });
}

function subGoal(overrides: Partial<SubGoal> = {}): SubGoal {
  return {
    id: "sg-11111111",
    description: "wire login",
    status: "in_progress",
    declared_at_round: 1,
    status_changed_at_round: 1,
    priority: 0,
    ...overrides,
  };
}

function contract(): ActiveContractView {
  return {
    id: "rc-12345678",
    declared_at_round: 1,
    work_item: "Ship auth",
    scope: ["src"],
    items: [{
      id: "rci-12345678",
      description: "login works",
      criterion_refs: [AUTH_ID],
      verify_with: ["verify"],
    }],
    config_hash_by_command: {},
  };
}

function state(overrides: Partial<CanonicalLoopState> = {}): CanonicalLoopState {
  const activeContract = contract();
  const base: CanonicalLoopState = {
    schemaVersion: 6 as const,
    loopId: "coverage-loop",
    round: 3,
    maxRounds: 20,
    goalId: "goal",
    objective: "Ship auth",
    rejectionNotice: null,
    currentTask: formatRoundContract(activeContract, null),
    successCriteria: [AUTH, API],
    hardConstraints: ["no runtime deps"],
    activeConstraints: [AUTH, API, "no runtime deps", "discovered rule"],
    retiredConstraints: [],
    constraintMetadata: [
      meta(AUTH, "criteria", AUTH_ID),
      meta(API, "criteria", API_ID),
      meta("no runtime deps", "hard", "c-11111111"),
      meta("discovered rule", "discovered", "c-22222222"),
    ],
    remainingCriteria: [],
    blockers: [],
    verificationFlags: [{
      severity: "warn",
      field: "execution_report.files_changed",
      check: "evidence_integrity",
      detail: "Agent files_changed doesn't match evidence: unreported: [src/a.ts]",
    }],
    subGoals: [subGoal(), subGoal({ id: "sg-22222222", description: "wire api", priority: 1 })],
    criterionStatuses: [
      { id: AUTH_ID, text: AUTH, status: "remaining" },
      { id: API_ID, text: API, status: "unknown" },
    ],
    recurringFlags: [],
    stateFilePath: ".loopforge/state/coverage-state.md",
    progress: { criteriaMet: [], criteriaRemaining: [], filesChanged: [], tests: null },
    roundContract: activeContract,
    capability: deriveConfiguredCapability(DEFAULT_POLICY),
    ...overrides,
  };
  return base;
}

function artifact(level: "l0" | "l1" | "l2", value = state()) {
  return assemblePromptArtifact({
    state: value,
    level,
    reasons: level === "l2" ? ["first_round"] : [],
    attempt: 1,
    selfEvaluationBlock: "",
  });
}

describe("v3.9.4 — PromptCoverage", () => {
  it("has the same active set at L0/L1/L2 and renders every stable id", () => {
    const artifacts = (["l0", "l1", "l2"] as const).map((level) => artifact(level));
    const expected = JSON.stringify(artifacts[0]!.coverage.active);
    for (const current of artifacts) {
      assert.equal(current.coverage.complete, true);
      assert.equal(JSON.stringify(current.coverage.active), expected,
        "the active normative set must not depend on the level");
    }
    const prompt = artifacts[0]!.renderedPrompt;
    for (const id of [AUTH_ID, API_ID, "c-11111111", "c-22222222", "rci-12345678", "sg-11111111", "sg-22222222"]) {
      assert.ok(prompt.includes(`\`${id}\``), `prompt must render ${id}`);
    }
    // The contract id is rendered as `(rc-…)` by formatRoundContract, not
    // backticked; it is still a rendered identity.
    assert.ok(prompt.includes("rc-12345678"));
    assert.ok(prompt.includes("evidence_integrity"), "findings render their check");
    assert.ok(prompt.includes("unreported: [src/a.ts]"), "findings render their detail");
  });

  it("renders every id of a 20-item, multi-command contract", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: `rci-${(index + 1).toString(16).padStart(8, "0")}`,
      description: `condition ${index}`,
      criterion_refs: [],
      verify_with: ["verify", "lint"],
    }));
    const active: ActiveContractView = {
      ...contract(),
      id: "rc-99999999",
      items,
    };
    const current = artifact("l1", state({
      roundContract: active,
      currentTask: formatRoundContract(active, null),
    }));
    assert.equal(current.coverage.complete, true);
    for (const item of items) {
      assert.ok(current.renderedPrompt.includes(`\`${item.id}\``),
        `item ${item.id} must render`);
    }
    assert.ok(current.renderedPrompt.includes("Verify via: verify, lint"));
  });

  it("does not include solved historical facts or closed-contract ids", () => {
    const closed = state({
      roundContract: undefined,
      contractItemStatuses: undefined,
      currentTask: "Ship auth",
    });
    const current = artifact("l1", closed);
    assert.equal(current.coverage.complete, true);
    assert.ok(!current.coverage.active.some((entry) => entry.kind === "contract"));
    assert.ok(!current.coverage.active.some((entry) => entry.kind === "contract_item"));
  });

  it("reports omitted ids with a deterministic reason and fails closed", () => {
    const coverage = derivePromptCoverage({
      active: [
        { id: "cr-aaaaaaaa", kind: "criterion" },
        { id: "never-rendered", kind: "recovery" },
      ],
      rendered: ["cr-aaaaaaaa"],
    });
    assert.equal(coverage.complete, false);
    assert.deepEqual(coverage.omitted, [{ id: "never-rendered", reason: "defect" }]);
    assert.throws(
      () => assertPromptCoverage(coverage),
      (error: unknown) =>
        error instanceof ProjectionCoverageError &&
        error.code === "projection_incomplete" &&
        error.coverage.omitted.length === 1,
    );
  });

  it("renders contract ids from the structured contract, not the currentTask string", () => {
    // v3.9.7: Current Task is re-rendered by the contract formatter and its
    // emitted ids are declared directly; a hand-built stale currentTask string
    // can no longer hide a contract id.
    const rebuilt = state({ currentTask: "Ship auth" });
    const a = artifact("l1", rebuilt);
    assert.ok(a.renderedPrompt.includes("rc-12345678"));
    assert.ok(a.renderedPrompt.includes("rci-12345678"));
    assert.equal(a.coverage.complete, true);
  });

  it("renders all active ids even when the protected set overflows the budget", () => {
    const many = Array.from({ length: 80 }, (_, index) => `constraint ${index}`);
    const value = state({
      hardConstraints: many,
      activeConstraints: [...many, AUTH, API, "no runtime deps", "discovered rule"],
      constraintMetadata: [
        ...many.map((text, index) => meta(text, "hard", `c-${String(index).padStart(8, "0")}`)),
        meta(AUTH, "criteria", AUTH_ID),
        meta(API, "criteria", API_ID),
        meta("no runtime deps", "hard", "c-11111111"),
        meta("discovered rule", "discovered", "c-22222222"),
      ],
    });
    const current = assemblePromptArtifact({
      state: value,
      level: "l0",
      reasons: [],
      attempt: 1,
      selfEvaluationBlock: "",
      budgets: { l0: 1 },
    });
    assert.equal(current.protectedOverflow, true);
    assert.equal(current.coverage.complete, true);
    for (const text of many) {
      assert.ok(current.renderedPrompt.includes(text), `protected text ${text} renders`);
    }
  });


  it("keeps every active sub-goal id when rows are capped", () => {
    const subGoals = Array.from({ length: 15 }, (_, index) => subGoal({
      id: `sg-a${String(index).padStart(7, "0")}`,
      description: `goal ${index}`,
      priority: index,
    }));
    const current = artifact("l2", state({ subGoals }));
    assert.equal(current.coverage.complete, true);
    for (const value of subGoals) {
      assert.ok(current.renderedPrompt.includes(`\`${value.id}\``),
        `sub-goal ${value.id} must survive the display cap`);
    }
  });

  it("is deterministic for the same state", () => {
    const left = artifact("l1");
    const right = artifact("l1");
    assert.equal(left.renderedPrompt, right.renderedPrompt);
    assert.equal(left.promptHash, right.promptHash);
    assert.equal(left.stateHash, right.stateHash);
    assert.deepEqual(left.coverage, right.coverage);
  });

  it("maps a projectionError to the stable non-retryable MCP envelope", () => {
    const envelope = applyToolEnvelope({
      projectionError: {
        code: "projection_incomplete",
        details: { coverage: { active: [], rendered: [], omitted: [], complete: false } },
      },
      stopDetail: "prompt projection incomplete — missing cr-aaaaaaaa",
    }) as { ok: boolean; error: { code: string; retryable: boolean; details: unknown } };
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, "projection_incomplete");
    assert.equal(envelope.error.retryable, false);
    assert.ok(envelope.error.details);
  });

  it("renders every item of a 20-item active contract", () => {
    const base = contract();
    const big: ActiveContractView = {
      ...base,
      items: Array.from({ length: 20 }, (_, index) => ({
        id: `rci-${String(index).padStart(8, "0")}`,
        description: `item ${index}`,
        criterion_refs: [AUTH_ID],
        verify_with: ["verify"],
      })),
    };
    const value = state({
      roundContract: big,
      currentTask: formatRoundContract(big, null),
    });
    const current = artifact("l0", value);
    assert.equal(current.coverage.complete, true);
    for (const item of big.items) {
      assert.ok(current.renderedPrompt.includes(`\`${item.id}\``),
        `contract item ${item.id} must render at L0`);
    }
  });

  it("keeps the same stable ids in the state file", () => {
    const value = state();
    const current = artifact("l1", value);
    const markdown = renderCanonicalStateMarkdown(value);
    for (const entry of current.coverage.active) {
      if (entry.kind === "finding") continue; // findings render check/detail, not the coverage key
      assert.ok(markdown.includes(entry.id),
        `state file must carry ${entry.kind} ${entry.id}`);
    }
  });

  it("includes a recovery marker and the restore facts when present", () => {
    const current = assemblePromptArtifact({
      state: state(),
      level: "l2",
      reasons: ["recovery_boundary"],
      attempt: 1,
      selfEvaluationBlock: "",
      recoveryBrief: [
        "- **Trigger**: progress_stall",
        "- **Restored checkpoint**: `ck-0123456789abcdef01234567` (machine-verified by LoopForge)",
        "- **Redo round**: 3",
        "- **Files changed in failed rounds**:",
        "  - `src/a.ts`",
      ],
    });
    assert.equal(current.coverage.complete, true);
    assert.ok(current.coverage.active.some((entry) => entry.kind === "recovery"));
    assert.ok(current.renderedPrompt.includes("Recovery Brief"));
    assert.ok(current.renderedPrompt.includes("Restored checkpoint"));
    assert.ok(current.renderedPrompt.includes("src/a.ts"));
  });
});
