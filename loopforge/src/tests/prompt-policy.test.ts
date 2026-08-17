/** Tests for prompt-policy — L0/L1/L2 level decision logic. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decidePromptLevel,
  type PromptLevelInput,
} from "../prompt-policy.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function defaults(overrides: Partial<PromptLevelInput> = {}): PromptLevelInput {
  return {
    round: 1,
    attempt: 1,
    hasPlanSource: false,
    checkpointBoundary: false,
    goalChanged: false,
    previousStateMissing: false,
    previousFailedWithoutNewInformation: false,
    verificationContradicted: false,
    fullRefreshInterval: 5,
    lastFullRound: 1,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Level decisions
// ═══════════════════════════════════════════════════════════════════════════

describe("decidePromptLevel", () => {
  it("returns L2 for round 1 (first_round)", () => {
    const d = decidePromptLevel(defaults({ round: 1 }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("first_round"));
  });

  it("returns L1 for normal continuation (state_capsule)", () => {
    const d = decidePromptLevel(defaults({ round: 2 }));
    assert.equal(d.level, "l1");
    assert.ok(d.reasons.includes("state_capsule"));
  });

  it("returns L2 for plan_boundary when plan source is present", () => {
    const d = decidePromptLevel(defaults({ hasPlanSource: true, round: 2 }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("plan_boundary"));
  });

  it("returns L2 for checkpoint_boundary", () => {
    const d = decidePromptLevel(defaults({ checkpointBoundary: true, round: 2 }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("checkpoint_boundary"));
  });

  it("returns L2 for goal_changed", () => {
    const d = decidePromptLevel(defaults({ goalChanged: true, round: 2 }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("goal_changed"));
  });

  it("returns L2 for missing_previous_state", () => {
    const d = decidePromptLevel(defaults({ previousStateMissing: true, round: 2 }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("missing_previous_state"));
  });

  it("returns L0 for attempt > 1 (retry_delta)", () => {
    const d = decidePromptLevel(defaults({ attempt: 2, round: 2 }));
    assert.equal(d.level, "l0");
    assert.ok(d.reasons.includes("retry_delta"));
  });

  it("returns L0 for previousFailedWithoutNewInformation (retry_delta)", () => {
    const d = decidePromptLevel(defaults({
      previousFailedWithoutNewInformation: true,
      round: 2,
    }));
    assert.equal(d.level, "l0");
    assert.ok(d.reasons.includes("retry_delta"));
  });

  it("returns L2 for verification_contradicted", () => {
    const d = decidePromptLevel(defaults({ verificationContradicted: true, round: 2 }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("verification_contradicted"));
  });

  it("returns L2 for rejection_rehydrate (2+ consecutive rejections)", () => {
    const d = decidePromptLevel(defaults({ consecutiveRejections: 2, round: 2 }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("rejection_rehydrate"));
  });

  it("returns L2 for recovery_boundary", () => {
    const d = decidePromptLevel(defaults({ recoveryBoundary: true, round: 2 }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("recovery_boundary"));
  });

  it("returns L2 for state_drift", () => {
    const d = decidePromptLevel(defaults({ stateDrift: true, round: 2 }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("state_drift"));
  });

  it("returns L2 for periodic_refresh when interval exceeded", () => {
    const d = decidePromptLevel(defaults({
      round: 7,
      lastFullRound: 1,
      fullRefreshInterval: 5,
    }));
    assert.equal(d.level, "l2");
    assert.ok(d.reasons.includes("periodic_refresh"));
  });

  it("returns L1 when periodic_refresh interval not yet reached", () => {
    const d = decidePromptLevel(defaults({
      round: 3,
      lastFullRound: 1,
      fullRefreshInterval: 5,
    }));
    assert.equal(d.level, "l1");
  });

  it("returns L1 when fullRefreshInterval is 0 (periodic refresh disabled)", () => {
    // v2.6 default: periodic refresh off — "thin prompt, fat state file"
    const d = decidePromptLevel(defaults({
      round: 100,
      lastFullRound: 1,
      fullRefreshInterval: 0,
    }));
    assert.equal(d.level, "l1");
    // Reasons should NOT include periodic_refresh
    const hasRefresh = d.reasons.includes("periodic_refresh");
    assert.equal(hasRefresh, false);
  });

  it("L0 wins over L1 (attempt > 1 bypasses state_capsule)", () => {
    const d = decidePromptLevel(defaults({ attempt: 2, round: 2 }));
    assert.equal(d.level, "l0");
  });

  it("L0 retry wins over L2 first_round when attempt > 1", () => {
    // attempt > 1 fires before round === 1 in priority order
    const d = decidePromptLevel(defaults({ round: 1, attempt: 2 }));
    assert.equal(d.level, "l0");
    assert.ok(d.reasons.includes("retry_delta"));
  });

  it("explicit_override honors force Level", () => {
    const d = decidePromptLevel(defaults({ forceLevel: "l0", round: 1 }));
    // first_round fires before forceLevel check in priority order
    assert.equal(d.level, "l2");
  });

  it("explicit_override works after round 1", () => {
    const d = decidePromptLevel(defaults({ forceLevel: "l0", round: 2 }));
    assert.equal(d.level, "l0");
  });
});
