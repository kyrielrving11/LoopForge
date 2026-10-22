/** v3.9.7 — the ONE constraint provenance + retraction resolver. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveConstraintProvenance,
  resolveConstraintRetractions,
} from "../constraint-lifecycle.js";
import type { CommittedRoundView } from "../committed-round.js";
import { deriveConstraintId } from "../token-utils.js";
import type { LoopObjective } from "../protocol.js";

function objective(overrides: Partial<LoopObjective> = {}): LoopObjective {
  return {
    objective: "Ship it",
    success_criteria: ["All tests pass"],
    hard_constraints: ["No data loss"],
    created_at_round: 1,
    loop_id: "life",
    ...overrides,
  };
}

function round(input: {
  round: number;
  active?: string[];
  discovered?: string[];
  retracted?: string[];
}): CommittedRoundView {
  return {
    round: input.round,
    activeConstraints: input.active ?? [],
    discoveredConstraints: input.discovered ?? [],
    retractedConstraints: input.retracted ?? [],
  } as unknown as CommittedRoundView;
}

function provenance(text: string, rounds: CommittedRoundView[]) {
  return deriveConstraintProvenance({
    text,
    objective: objective(),
    windowRounds: rounds,
    roundOnePlan: [],
    preservedDiscoveries: [],
  });
}

describe("v3.9.7 — constraint provenance", () => {
  it("keeps operator criteria/hard constraints as operator", () => {
    assert.deepEqual(provenance("All tests pass", []), {
      source: "criteria",
      source_round: 1,
    });
    assert.deepEqual(provenance("No data loss", []), {
      source: "hard",
      source_round: 1,
    });
  });

  it("labels a normal discovery with the discovery round", () => {
    assert.deepEqual(provenance("Rate limit", [
      round({ round: 1 }),
      round({ round: 2, discovered: ["Rate limit"] }),
      round({ round: 3, active: ["Rate limit"] }),
    ]), { source: "discovered", source_round: 2 });
  });

  it("uses the current active streak after a retirement", () => {
    assert.deepEqual(provenance("Rate limit", [
      round({ round: 2, discovered: ["Rate limit"] }),
      round({ round: 3, active: ["Rate limit"] }),
      round({ round: 5, active: ["Rate limit"], retracted: ["Rate limit"] }),
      round({ round: 10, discovered: ["Rate limit"] }),
      round({ round: 11, active: ["Rate limit"] }),
    ]), { source: "discovered", source_round: 10 });
  });

  it("does not relabel a plan constraint that the Agent later re-declares", () => {
    assert.deepEqual(provenance("No external deps", [
      round({ round: 1, active: ["No external deps"] }),
      round({ round: 3, active: ["No external deps"], discovered: ["No external deps"] }),
    ]), { source: "plan", source_round: 1 });
  });

  it("is honest when no committed origin exists", () => {
    assert.deepEqual(provenance("mystery", []), { source: "unrecorded" });
  });
});

describe("v3.9.7 — constraint retractions", () => {
  const active = [
    { text: "Rate limit", provenance: { source: "discovered" as const, source_round: 2 } },
    { text: "No data loss", provenance: { source: "hard" as const, source_round: 1 } },
    { text: "Plan rule", provenance: { source: "plan" as const, source_round: 1 } },
  ];

  it("resolves a c- id and normalized text", () => {
    const result = resolveConstraintRetractions({
      targets: [deriveConstraintId("Rate limit"), " rate limit "],
      active,
      newDiscoveries: [],
      previouslyRetired: ["Old rule"],
    });
    assert.deepEqual(result.effective, ["Rate limit"]);
    assert.equal(result.noops.length, 1, "duplicate request is inert");
    assert.equal(result.noops[0].reason, "duplicate_request");
    assert.equal(result.errors.length, 0);
  });

  it("rejects operator and plan targets", () => {
    const result = resolveConstraintRetractions({
      targets: ["No data loss", "Plan rule"],
      active,
      newDiscoveries: [],
      previouslyRetired: [],
    });
    assert.deepEqual(result.effective, []);
    assert.deepEqual(result.errors.map((error) => error.reason).sort(), [
      "immutable_constraint",
      "not_retractable",
    ]);
  });

  it("treats same-round discoveries, retired targets and unknown text as no-ops", () => {
    const result = resolveConstraintRetractions({
      targets: ["New thing", "Old rule", "nope"],
      active,
      newDiscoveries: ["New thing"],
      previouslyRetired: ["Old rule"],
    });
    assert.deepEqual(result.effective, []);
    assert.deepEqual(result.noops.map((noop) => noop.reason), [
      "same_round_discovery",
      "already_retired",
      "unknown_target",
    ]);
  });
});
