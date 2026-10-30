/** v4.0.2 — the derived prompt context boundary.
 *
 * The boundary is a compiler fact, written into the PromptArtifact. It is
 * never submitted by the Agent and never re-derived by a response builder.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePromptContextBoundary } from "../context-boundary.js";
import { compileLoop } from "../loop-compiler.js";
import { makeLoopCompileRequest } from "../protocol.js";
import { committedBacktrackRound, committedFeedbackRound } from "./_helpers.js";

function compile(
  context: Record<string, unknown> | null,
  overrides: Partial<ReturnType<typeof makeLoopCompileRequest>> = {},
) {
  return compileLoop(makeLoopCompileRequest({
    loop_id: "context-loop",
    task: "Do the work",
    ...overrides,
  }), context);
}

describe("derivePromptContextBoundary — fixed priority", () => {
  it("attempt > 1 is an enforcement retry, even inside a recovery redo", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 3,
        attempt: 2,
        level: "l0",
        recoveryBoundary: true,
        hasPreviousCommittedRound: true,
      }),
      { mode: "same_round_retry", reason: "enforcement_retry" },
    );
  });

  it("a recovery boundary with attempt 1 is a fresh redo", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 3,
        attempt: 1,
        level: "l2",
        recoveryBoundary: true,
        hasPreviousCommittedRound: true,
      }),
      { mode: "fresh_invocation", reason: "recovery_redo" },
    );
  });

  it("round 1 without prior committed history is first_round", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 1,
        attempt: 1,
        level: "l2",
        recoveryBoundary: false,
        hasPreviousCommittedRound: false,
      }),
      { mode: "fresh_invocation", reason: "first_round" },
    );
  });

  it("a later round is next_round", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 4,
        attempt: 1,
        level: "l1",
        recoveryBoundary: false,
        hasPreviousCommittedRound: true,
      }),
      { mode: "fresh_invocation", reason: "next_round" },
    );
  });
});

describe("compileLoop — context boundary is an artifact fact", () => {
  it("round 1 is fresh/first_round", () => {
    const response = compile(null);
    assert.equal(response.prompt_artifact?.contextMode, "fresh_invocation");
    assert.equal(response.prompt_artifact?.contextReason, "first_round");
    assert.match(response.prompt, /Context: clean context — first round \(fresh_invocation\)/);
  });

  it("a committed prior round makes the next round fresh/next_round", () => {
    const loopId = "context-loop";
    const response = compile({
      results: [committedFeedbackRound(1, { loopId })],
    }, { round: 2 });
    assert.equal(response.prompt_artifact?.contextMode, "fresh_invocation");
    assert.equal(response.prompt_artifact?.contextReason, "next_round");
  });

  it("attempt 2 is same_round_retry and renders no Working Memory", () => {
    const loopId = "context-loop";
    const response = compile({
      results: [committedFeedbackRound(1, {
        loopId,
        outputSummary: "COMMITTED_REPORT_TEXT",
      })],
    }, { round: 2, attempt: 2, rejection_notice: "fix the finding" });
    assert.equal(response.prompt_artifact?.contextMode, "same_round_retry");
    assert.equal(response.prompt_artifact?.contextReason, "enforcement_retry");
    assert.match(response.prompt, /Context: in-context repair \(same_round_retry; enforcement_retry; continue original invocation if alive; lessons injected\)/);
    assert.ok(!response.prompt.includes("Working Memory (Agent reports are claims"));
    assert.doesNotMatch(response.prompt, /COMMITTED_REPORT_TEXT/);
    assert.equal(response.prompt_artifact?.workingMemory, undefined);
    // The first L0 retry is in-context repair: the failure lessons are IN the
    // original invocation's prompt.
    assert.ok(response.prompt.includes("fix the finding"));
    assert.ok(response.prompt.includes("## Round Boundary"));
  });

  it("a pending rollback is a fresh recovery redo", () => {
    const loopId = "context-loop";
    const response = compile({
      results: [
        committedFeedbackRound(1, { loopId }),
        committedBacktrackRound(2, loopId, 1),
      ],
    }, { round: 2 });
    assert.equal(response.prompt_artifact?.contextMode, "fresh_invocation");
    assert.equal(response.prompt_artifact?.contextReason, "recovery_redo");
    // The redo still renders the retained committed memory and the current
    // Recovery Brief; the pending directive is not duplicated as recovery
    // history.
    assert.ok(response.prompt.includes("Working Memory (Agent reports are claims"));
    assert.match(response.prompt, /Recovery Brief/);
    const memory = response.prompt_artifact?.workingMemory;
    assert.deepEqual(memory?.reportRounds, [1]);
  });

  it("a recovery redo retry at L2 starts a fresh invocation", () => {
    const loopId = "context-loop";
    const response = compile({
      results: [
        committedFeedbackRound(1, { loopId }),
        committedBacktrackRound(2, loopId, 1),
      ],
    }, { round: 2, attempt: 2, rejection_notice: "fix the finding" });
    assert.equal(response.recompile_level, "l2");
    assert.equal(response.prompt_artifact?.contextMode, "fresh_invocation");
    assert.equal(response.prompt_artifact?.contextReason, "enforcement_retry");
    assert.ok(response.prompt.includes("Working Memory (Agent reports are claims"));
    // The reason field becomes enforcement_retry, but the strategy label and
    // the Recovery Brief must keep the recovery semantics.
    assert.match(response.prompt,
      /Context: clean context repair \+ recovery retry \(fresh_invocation; enforcement_retry; recovery lessons carried\)/);
    assert.match(response.prompt, /Recovery Brief/);
  });

  it("an L2 enforcement retry re-renders committed memory for a fresh invocation", () => {
    const loopId = "context-loop";
    const response = compile({
      results: [committedFeedbackRound(1, {
        loopId,
        outputSummary: "COMMITTED_REPORT_TEXT",
      })],
    }, {
      round: 2,
      attempt: 2,
      consecutive_rejections: 2,
      rejection_notice: "rebuild from committed facts",
    });
    assert.equal(response.recompile_level, "l2");
    assert.equal(response.prompt_artifact?.contextMode, "fresh_invocation");
    assert.equal(response.prompt_artifact?.contextReason, "enforcement_retry");
    assert.match(response.prompt, /COMMITTED_REPORT_TEXT/);
    assert.deepEqual(response.prompt_artifact?.workingMemory?.reportRounds, [1]);
  });
});

describe("v4.0.4 — every L2 trigger is a clean context", () => {
  const loopId = "l2-clean";
  const cases: Array<[string, () => ReturnType<typeof compile>]> = [
    ["first round", () => compile(null)],
    ["forced L2", () => compile({
      results: [committedFeedbackRound(1, { loopId })],
    }, { round: 2, force_level: "l2" })],
    ["plan boundary", () => compile({
      results: [committedFeedbackRound(1, { loopId })],
    }, { round: 2, plan_source: "docs/plan.md" })],
    ["missing previous state", () => compile(null, { round: 2 })],
    ["subtask boundary", () => compile({
      results: [committedFeedbackRound(1, {
        loopId,
        subtaskBoundary: true,
        subtaskBoundaryLabel: "parser done",
      })],
    }, { round: 2 })],
    ["verification contradiction", () => compile({
      results: [committedFeedbackRound(1, {
        loopId,
        verificationFlags: [{
          field: "success",
          check: "success_contradiction",
          severity: "error",
          detail: "machine evidence denies the claim",
        }],
      })],
    }, { round: 2 })],
    ["goal change", () => compile({
      results: [committedFeedbackRound(1, {
        loopId,
        compiled: {
          task: "old task",
          goalId: "a-different-goal",
          constraintsActive: [],
          constraintsRetired: [],
        },
      })],
    }, { round: 2 })],
    ["repeated rejection", () => compile({
      results: [committedFeedbackRound(1, { loopId })],
    }, {
      round: 2,
      attempt: 2,
      consecutive_rejections: 2,
      rejection_notice: "rebuild from committed facts",
    })],
    ["recovery redo", () => compile({
      results: [
        committedFeedbackRound(1, { loopId }),
        committedBacktrackRound(2, loopId, 1),
      ],
    }, { round: 2 })],
  ];

  for (const [name, run] of cases) {
    it(name, () => {
      const response = run();
      assert.equal(response.recompile_level, "l2", `${name} must select L2`);
      assert.equal(response.prompt_artifact?.contextMode, "fresh_invocation",
        `${name} must use clean context`);
      // Repeated rejection legitimately reports reason=enforcement_retry, but
      // the context strategy is still clean (fresh_invocation).
    });
  }
});

describe("v4.0.4 — contradiction and retry are opposite strategies", () => {
  it("a single verification contradiction is L2 clean context with findings, not a retry notice", () => {
    const loopId = "contradiction-clean";
    const response = compile({
      results: [committedFeedbackRound(1, {
        loopId,
        verificationFlags: [{
          field: "success",
          check: "success_contradiction",
          severity: "error",
          detail: "MACHINE_DENIES_CLAIM",
        }],
      })],
    }, { round: 2 });
    assert.equal(response.recompile_level, "l2");
    assert.equal(response.prompt_artifact?.contextMode, "fresh_invocation");
    assert.equal(response.prompt_artifact?.contextReason, "next_round",
      "a contradiction is a next-round rehydration, not an enforcement retry");
    assert.ok(response.prompt.includes("MACHINE_DENIES_CLAIM"),
      "the machine finding is carried into the clean context");
    assert.ok(!response.prompt.includes("Retry Requirements"),
      "a non-retry rehydration must not fabricate a rejection notice");
  });
});

describe("v4.0.4 — the decoder enforces the same context pairs", () => {
  it("rejects a committed artifact with L2 + same_round_retry", async () => {
    const { parseRoundTransactionSnapshot } = await import("../round-transaction.js");
    const { promptArtifact } = await import("./_helpers.js");
    const entry = committedFeedbackRound(1, {
      loopId: "illegal-pair",
      attempt: 2,
      promptArtifact: {
        ...promptArtifact({
          roundId: "loop:illegal-pair:round:1",
          round: 1,
          renderedPrompt: "retry",
        }),
        attempt: 2,
        level: "l2",
        contextMode: "same_round_retry",
        contextReason: "enforcement_retry",
      },
    });
    const snapshot = (entry.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    assert.equal(parseRoundTransactionSnapshot(snapshot.snapshot), null,
      "an illegal context pair is not committed history");
  });
});
