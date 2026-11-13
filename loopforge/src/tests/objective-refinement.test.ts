/** v4.0.6 — objective_refinement evolves the OVERALL working objective.
 *
 *  It never rewrites Operator Acceptance, criteria or hard constraints, and
 *  it is not the round task or the Round Contract.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../mcp/session.js";
import {
  MemoryLoopStore,
  committedBacktrackRound,
  committedFeedbackRound,
  installTestCommandProvider,
} from "./_helpers.js";
import { resetPolicy } from "../policy.js";
import { latestObjective } from "../loop-compiler.js";
import { deriveCriterionId } from "../token-utils.js";

function continuing(refinement?: string): Record<string, unknown> {
  return {
    outcome: "failed",
    output_summary: "made progress",
    constraint_violations: [],
    should_continue: true,
    ...(refinement !== undefined ? { objective_refinement: refinement } : {}),
  };
}

describe("v4.0.6 — objective_refinement", () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });
  afterEach(() => mgr.close());

  it("rejects malformed refinements with zero side effects", async () => {
    for (const invalid of ["", "   ", 42, "x".repeat(1001)]) {
      const started = await mgr.create({
        task: "Refinement validation",
        loopId: `refine-invalid-${String(invalid).length}`,
      });
      const handle = started.submissionHandle!;
      const entriesBefore = store.listEntries(started.loopId!).length;
      const result = await mgr.advance(handle, "", {
        ...continuing(),
        objective_refinement: invalid,
      });
      assert.equal(result.submissionError?.code, "evaluation_invalid");
      assert.deepEqual(result.submissionHandle, handle);
      assert.equal(mgr.get(started.sessionId)?.currentRound, 1);
      assert.equal(store.listEntries(started.loopId!).length, entriesBefore);
    }
  });

  it("commits the refinement, changes goalId and selects L2", async () => {
    const loopId = "refine-working";
    const criterion = "Ship the customer portal";
    const constraint = "Do not break the public API";
    const started = await mgr.create({
      task: "Original operator task",
      loopId,
      criteria: [criterion],
      constraints: [constraint],
    });

    const accepted = await mgr.advance(started.submissionHandle!, "", continuing(
      "Deliver the customer portal and its migration tooling",
    ));
    assert.equal(accepted.round, 2);
    assert.equal(accepted.level, "l2",
      "a working-objective change is a goal change and must rehydrate at L2");
    const prompt = String(accepted.prompt);
    assert.ok(prompt.includes("Deliver the customer portal and its migration tooling"));
    assert.ok(prompt.includes(criterion), "criteria still come from acceptance");
    assert.ok(prompt.includes(deriveCriterionId(criterion)));
    assert.ok(prompt.includes(constraint), "hard constraints are unchanged");
  });

  it("the latest committed refinement wins", async () => {
    const loopId = "refine-latest";
    const started = await mgr.create({ task: "Latest objective", loopId });
    const r2 = await mgr.advance(started.submissionHandle!, "", continuing(
      "First overall objective",
    ));
    const r3 = await mgr.advance(r2.submissionHandle!, "", continuing(
      "Second overall objective",
    ));
    assert.ok(String(r3.prompt).includes("Second overall objective"));
    assert.ok(!String(r3.prompt).includes("First overall objective"));

    const objective = latestObjective(loopId, {
      results: store.listEntries(loopId),
    });
    assert.equal(objective?.objective, "Second overall objective");

    const audit = mgr.getAudit(loopId) as {
      rounds: Array<{ round: number; objectiveRefinement: string | null }>;
    } | null;
    assert.equal(
      audit?.rounds.find((round) => round.round === 1)?.objectiveRefinement,
      "First overall objective",
      "audit exposes the committed refinement as an Agent report",
    );
  });

  it("only refinements on the CURRENT branch apply", () => {
    const loopId = "refine-branch";
    const entries = [
      committedFeedbackRound(1, {
        loopId,
        task: "Test task",
        objectiveRefinement: "Root objective",
      }),
      committedFeedbackRound(2, {
        loopId,
        task: "Test task",
        objectiveRefinement: "Abandoned objective",
      }),
      committedBacktrackRound(2, loopId, 1),
    ];
    const objective = latestObjective(loopId, { results: entries });
    assert.equal(objective?.objective, "Root objective",
      "the refinement committed on the abandoned branch must not apply");
    assert.deepEqual(objective?.success_criteria, []);
  });

  it("current_user_instruction never changes the working objective", async () => {
    const loopId = "refine-instruction";
    const started = await mgr.create({ task: "Instruction task", loopId });
    const r2 = await mgr.advance(started.submissionHandle!, "", continuing(
      "Working objective from the Agent",
    ));
    const { TOOL_HANDLERS } = await import("../mcp/tools.js");
    const recompiled = await TOOL_HANDLERS.loopforge_next(mgr, {
      submissionHandle: r2.submissionHandle,
      currentUserInstruction: "A separate host instruction for this invocation",
    });
    assert.equal(recompiled.error, undefined);
    const prompt = String(recompiled.prompt);
    assert.ok(prompt.includes("Working objective from the Agent"));
    assert.ok(prompt.includes("A separate host instruction for this invocation"));
    assert.equal(mgr.get(r2.sessionId)?.task, "Instruction task",
      "the loop task is invocation-independent");
    const objective = latestObjective(loopId, {
      results: store.listEntries(loopId),
    });
    assert.equal(objective?.objective, "Working objective from the Agent");
  });

  it("without a contract the Current Task falls back to the working objective", async () => {
    const loopId = "refine-current-task";
    const started = await mgr.create({ task: "Fallback task", loopId });
    const accepted = await mgr.advance(started.submissionHandle!, "", continuing(
      "The revised overall objective",
    ));
    const prompt = String(accepted.prompt);
    const marker = prompt.includes("### Objective / Current Task")
      ? "### Objective / Current Task"
      : "## Current Task";
    const currentTask = prompt.split(marker)[1] ?? "";
    assert.ok(currentTask.includes("The revised overall objective"));
  });

  it("with an active contract the Current Task stays the contract", async () => {
    installTestCommandProvider();
    const loopId = "refine-with-contract";
    const started = await mgr.create({ task: "Contract task", loopId });
    const accepted = await mgr.advance(started.submissionHandle!, "", {
      ...continuing("The revised overall objective"),
      round_contract: {
        work_item: "Slice A",
        items: [{ description: "A is done", verify_with: ["verify"] }],
      },
    });
    const prompt = String(accepted.prompt);
    assert.ok(prompt.includes("**Slice A**"));
    const currentTask = prompt.split("## Current Task")[1] ?? "";
    assert.ok(!currentTask.includes("The revised overall objective"),
      "the objective belongs to the Objective section, not the Current Task");
    assert.ok(prompt.includes("The revised overall objective"));
  });
});
