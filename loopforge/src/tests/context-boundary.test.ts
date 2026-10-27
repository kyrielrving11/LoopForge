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
      { mode: "fresh_round", reason: "recovery_redo" },
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
      { mode: "fresh_round", reason: "first_round" },
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
      { mode: "fresh_round", reason: "next_round" },
    );
  });
});

describe("compileLoop — context boundary is an artifact fact", () => {
  it("round 1 is fresh/first_round", () => {
    const response = compile(null);
    assert.equal(response.prompt_artifact?.contextMode, "fresh_round");
    assert.equal(response.prompt_artifact?.contextReason, "first_round");
    assert.match(response.prompt, /Context: fresh \(first_round\)/);
  });

  it("a committed prior round makes the next round fresh/next_round", () => {
    const loopId = "context-loop";
    const response = compile({
      results: [committedFeedbackRound(1, { loopId })],
    }, { round: 2 });
    assert.equal(response.prompt_artifact?.contextMode, "fresh_round");
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
    assert.match(response.prompt, /Context: same-round retry \(enforcement_retry\)/);
    assert.doesNotMatch(response.prompt, /Working Memory \(committed history/);
    assert.doesNotMatch(response.prompt, /COMMITTED_REPORT_TEXT/);
    assert.equal(response.prompt_artifact?.workingMemory, undefined);
  });

  it("a pending rollback is a fresh recovery redo", () => {
    const loopId = "context-loop";
    const response = compile({
      results: [
        committedFeedbackRound(1, { loopId }),
        committedBacktrackRound(2, loopId, 1),
      ],
    }, { round: 2 });
    assert.equal(response.prompt_artifact?.contextMode, "fresh_round");
    assert.equal(response.prompt_artifact?.contextReason, "recovery_redo");
    // The redo still renders the retained committed memory and the current
    // Recovery Brief; the pending directive is not duplicated as recovery
    // history.
    assert.match(response.prompt, /Working Memory \(committed history/);
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
    assert.equal(response.prompt_artifact?.contextMode, "fresh_round");
    assert.equal(response.prompt_artifact?.contextReason, "enforcement_retry");
    assert.match(response.prompt, /Working Memory \(committed history/);
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
    assert.equal(response.prompt_artifact?.contextMode, "fresh_round");
    assert.equal(response.prompt_artifact?.contextReason, "enforcement_retry");
    assert.match(response.prompt, /COMMITTED_REPORT_TEXT/);
    assert.deepEqual(response.prompt_artifact?.workingMemory?.reportRounds, [1]);
  });
});
