/** v3.8 — Sub-goal lifecycle: identity, replay, terminality, diagnostics. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUBGOAL_TRANSITIONS,
  canTransitionSubGoal,
  deriveEmergedItems,
  deriveSubGoalId,
  deriveSubGoals,
  duplicateEmergedDeclarations,
  validateSubGoalUpdates,
} from "../subgoal-state.js";
import type { SubGoal } from "../protocol.js";

const round = (
  r: number,
  emerged: string[] = [],
  updates: Array<{ id: string; status: "in_progress" | "done" | "blocked" | "canceled" }> = [],
) => ({ round: r, emergedSubtasks: emerged, subgoalUpdates: updates });

describe("v3.8 — sub-goal identity", () => {
  it("scopes the id to the declaration event, not the text alone", () => {
    const first = deriveSubGoalId("loop", 1, 0, "Add error handling");
    const sameEvent = deriveSubGoalId("loop", 1, 0, "Add error handling");
    const laterRound = deriveSubGoalId("loop", 2, 0, "Add error handling");
    const otherLoop = deriveSubGoalId("other", 1, 0, "Add error handling");
    const otherOrdinal = deriveSubGoalId("loop", 1, 1, "Add error handling");
    assert.equal(first, sameEvent, "same event derives the same id");
    assert.notEqual(first, laterRound, "re-declaring the same text later is a NEW sub-goal");
    assert.notEqual(first, otherLoop, "ids are loop-scoped");
    assert.notEqual(first, otherOrdinal, "ordinal disambiguates identical text in one round");
    assert.match(first, /^sg-[a-f0-9]{8}$/);
  });

  it("normalizes case and whitespace for identity", () => {
    assert.equal(
      deriveSubGoalId("loop", 1, 0, "Add  Error   Handling"),
      deriveSubGoalId("loop", 1, 0, "add error handling"),
    );
  });

  it("keeps only the first exact duplicate within a round", () => {
    const items = deriveEmergedItems("loop", 1, ["fix parser", "fix parser", "wire config"]);
    assert.deepEqual(items.map((item) => item.description), ["fix parser", "wire config"]);
    assert.equal(items[1].id, deriveSubGoalId("loop", 1, 1, "wire config"));
  });
});

describe("v3.8 — sub-goal replay", () => {
  it("creates pending items and applies that round's transitions in order", () => {
    const id = deriveSubGoalId("loop", 1, 0, "first step");
    const goals = deriveSubGoals({
      loopId: "loop",
      currentRound: 3,
      rounds: [
        round(1, ["first step"]),
        round(2, [], [{ id, status: "done" }]),
      ],
    });
    assert.equal(goals.length, 1);
    assert.equal(goals[0].status, "done");
    assert.equal(goals[0].completed_at_round, 2);
  });

  it("re-declaring the same text in a later round creates a second sub-goal", () => {
    const firstId = deriveSubGoalId("loop", 1, 0, "harden withdraw");
    const goals = deriveSubGoals({
      loopId: "loop",
      currentRound: 3,
      rounds: [
        round(1, ["harden withdraw"]),
        round(2, [], [{ id: firstId, status: "canceled" }]),
        round(3, ["harden withdraw"]),
      ],
    });
    assert.equal(goals.length, 2, "the terminal declaration never blocks a new one");
    const terminal = goals.find((g) => g.id === firstId);
    const fresh = goals.find((g) => g.id !== firstId);
    assert.equal(terminal?.status, "canceled");
    assert.equal(fresh?.status, "pending");
    assert.equal(fresh?.declared_at_round, 3);
  });

  it("never regresses older transitions on later compiles", () => {
    const id = deriveSubGoalId("loop", 1, 0, "first step");
    const rounds = [round(1, ["first step"]), round(2, [], [{ id, status: "done" }])];
    const atRound3 = deriveSubGoals({ loopId: "loop", currentRound: 3, rounds });
    const atRound4 = deriveSubGoals({ loopId: "loop", currentRound: 4, rounds });
    assert.equal(atRound3[0].status, "done");
    assert.equal(atRound4[0].status, "done");
  });

  it("re-applying the in-flight report is idempotent", () => {
    const goals = deriveSubGoals({
      loopId: "loop",
      currentRound: 2,
      rounds: [round(1, ["first step"])],
      currentReport: { round: 1, emergedSubtasks: ["first step"], subgoalUpdates: [] },
    });
    assert.equal(goals.length, 1, "the same declaration event must not duplicate");
  });

  it("ignores updates that reference unknown ids", () => {
    const goals = deriveSubGoals({
      loopId: "loop",
      currentRound: 2,
      rounds: [round(1, ["first step"], [{ id: "sg-99999999", status: "done" }])],
    });
    assert.equal(goals[0].status, "pending");
  });
});

describe("v3.8 — transition matrix and terminality", () => {
  const sg = (id: string, status: SubGoal["status"]): SubGoal => ({
    id,
    description: `goal ${id}`,
    status,
    declared_at_round: 1,
    status_changed_at_round: 1,
    priority: 0,
  });

  it("keeps done and canceled terminal", () => {
    for (const terminal of ["done", "canceled"] as const) {
      const errors = validateSubGoalUpdates(
        [sg("sg-aaaaaaaa", terminal)],
        [{ id: "sg-aaaaaaaa", status: "in_progress" }],
      );
      assert.equal(errors[0]?.reason, "terminal_reference", `${terminal} must be terminal`);
    }
    assert.deepEqual(SUBGOAL_TRANSITIONS.done, ["pending", "in_progress", "blocked"]);
    assert.equal(canTransitionSubGoal("done", "done"), true, "same-status no-op stays legal");
  });

  it("rejects unknown ids and accepts every active-state migration", () => {
    // The matrix is fully connected for ACTIVE states (pending/in_progress/
    // blocked); the only rejected references are unknown ids and terminal
    // sources, which are checked before the matrix.
    const errors = validateSubGoalUpdates(
      [sg("sg-aaaaaaaa", "pending"), sg("sg-bbbbbbbb", "blocked")],
      [
        { id: "sg-cccccccc", status: "done" },
        { id: "sg-aaaaaaaa", status: "in_progress" },
        { id: "sg-bbbbbbbb", status: "done" },
      ],
    );
    assert.deepEqual(errors.map((e) => e.reason), ["unknown_id"]);
  });
});

describe("v3.8.1 — exact declaration duplicates are stated as fact", () => {
  it("reports the exact repeats dropped from one round's emerged list", () => {
    // Normalized-exact only: whitespace and case are folded, wording is not.
    const duplicates = duplicateEmergedDeclarations([
      "Fix the parser bug",
      "fix   the parser bug",
      "fix the parser bugs",
    ]);
    assert.deepEqual(duplicates, ["fix the parser bug"]);
  });

  it("reports each repeated declaration once, regardless of how often it recurs", () => {
    assert.deepEqual(
      duplicateEmergedDeclarations(["a b", "a b", "a b", "c d"]),
      ["a b"],
    );
  });

  it("is silent when every declaration is distinct, and ignores blanks", () => {
    assert.deepEqual(duplicateEmergedDeclarations(["one", "two", "three"]), []);
    assert.deepEqual(duplicateEmergedDeclarations(["", "  ", "one"]), []);
  });
});
