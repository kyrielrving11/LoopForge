/** v4.0.2 — the derived prompt context boundary.
 *
 * The boundary is a compiler fact, written into the PromptArtifact. It is
 * never submitted by the Agent and never re-derived by a response builder.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  derivePromptContextBoundary,
  promptContextPairIssue,
} from "../context-boundary.js";
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

describe("derivePromptContextBoundary — explicit context policy", () => {
  it("a retry below the rejection escalation threshold stays in context", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 3,
        attempt: 2,
        consecutiveRejections: 1,
        recoveryBoundary: true,
        hasPreviousCommittedRound: true,
        invocationRecovery: false,
      }),
      { mode: "same_round_retry", reason: "enforcement_retry" },
    );
  });

  it("repeated same-check rejection starts clean context regardless of prompt level", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 3,
        attempt: 3,
        consecutiveRejections: 2,
        recoveryBoundary: false,
        hasPreviousCommittedRound: true,
        invocationRecovery: false,
      }),
      { mode: "fresh_invocation", reason: "rejection_escalation" },
    );
  });

  it("a recovery boundary with attempt 1 is a fresh redo", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 3,
        attempt: 1,
        consecutiveRejections: 0,
        recoveryBoundary: true,
        hasPreviousCommittedRound: true,
        invocationRecovery: false,
      }),
      { mode: "fresh_invocation", reason: "recovery_redo" },
    );
  });

  it("round 1 without prior committed history is first_round", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 1,
        attempt: 1,
        consecutiveRejections: 0,
        recoveryBoundary: false,
        hasPreviousCommittedRound: false,
        invocationRecovery: false,
      }),
      { mode: "fresh_invocation", reason: "first_round" },
    );
  });

  it("a later round is next_round", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 4,
        attempt: 1,
        consecutiveRejections: 0,
        recoveryBoundary: false,
        hasPreviousCommittedRound: true,
        invocationRecovery: false,
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

  it("a recovery redo retry below the escalation threshold stays in context", () => {
    const loopId = "context-loop";
    const response = compile({
      results: [
        committedFeedbackRound(1, { loopId }),
        committedBacktrackRound(2, loopId, 1),
      ],
    }, { round: 2, attempt: 2, rejection_notice: "fix the finding" });
    assert.equal(response.recompile_level, "l2");
    assert.equal(response.prompt_artifact?.contextMode, "same_round_retry");
    assert.equal(response.prompt_artifact?.contextReason, "enforcement_retry");
    assert.ok(!response.prompt.includes("Working Memory (Agent reports are claims"));
    assert.match(response.prompt, /Context: in-context repair/);
    assert.match(response.prompt, /Recovery Brief/);
  });

  it("rejection escalation starts a fresh invocation and re-renders committed memory", () => {
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
    assert.equal(response.prompt_artifact?.contextReason, "rejection_escalation");
    assert.match(response.prompt, /COMMITTED_REPORT_TEXT/);
    assert.match(response.prompt, /not a current workspace snapshot/);
    assert.match(response.prompt, /Inspect the current workspace before acting/);
    assert.deepEqual(response.prompt_artifact?.workingMemory?.reportRounds, [1]);
    assert.equal(response.prompt_artifact?.round, 2);
    assert.equal(response.prompt_artifact?.attempt, 2);
  });
});

describe("v4.0.5 — invocation recovery is a cold retry boundary", () => {
  it("below the escalation threshold a lost invocation becomes fresh context", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 3,
        attempt: 2,
        consecutiveRejections: 1,
        recoveryBoundary: true,
        hasPreviousCommittedRound: true,
        invocationRecovery: true,
      }),
      { mode: "fresh_invocation", reason: "invocation_recovery" },
    );
  });

  it("the escalation threshold wins over invocation recovery", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 3,
        attempt: 3,
        consecutiveRejections: 2,
        recoveryBoundary: false,
        hasPreviousCommittedRound: true,
        invocationRecovery: true,
      }),
      { mode: "fresh_invocation", reason: "rejection_escalation" },
    );
  });

  it("without the flag the first retry stays in context", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 3,
        attempt: 2,
        consecutiveRejections: 0,
        recoveryBoundary: false,
        hasPreviousCommittedRound: true,
        invocationRecovery: false,
      }),
      { mode: "same_round_retry", reason: "enforcement_retry" },
    );
  });

  it("attempt 1 ignores the flag", () => {
    assert.deepEqual(
      derivePromptContextBoundary({
        round: 3,
        attempt: 1,
        consecutiveRejections: 0,
        recoveryBoundary: false,
        hasPreviousCommittedRound: true,
        invocationRecovery: true,
      }),
      { mode: "fresh_invocation", reason: "next_round" },
    );
  });

  it("a cold handoff rehydrates L2 with memory, prior evidence and routing", () => {
    const loopId = "context-loop";
    const response = compile({
      results: [committedFeedbackRound(1, {
        loopId,
        outputSummary: "COMMITTED_REPORT_TEXT",
      })],
    }, {
      round: 2,
      attempt: 2,
      invocation_recovery: true,
      rejection_notice: "fix the finding",
    });
    assert.equal(response.recompile_level, "l2");
    assert.equal(response.prompt_artifact?.contextMode, "fresh_invocation");
    assert.equal(response.prompt_artifact?.contextReason, "invocation_recovery");
    assert.match(response.prompt, /clean context repair \+ invocation recovery/);
    assert.match(response.prompt, /COMMITTED_REPORT_TEXT/);
    assert.match(response.prompt, /Working Memory \(Agent reports are claims\)/);
    assert.match(response.prompt, /Machine Evidence — previous committed round R1/);
    assert.doesNotMatch(response.prompt, /self-contained prompt/);
    assert.match(response.prompt, /SAME logical round and/);
  });

  it("the pair guard requires clean context and attempt > 1", () => {
    assert.equal(promptContextPairIssue({
      level: "l2",
      mode: "fresh_invocation",
      reason: "invocation_recovery",
      attempt: 2,
      round: 2,
    }), null);
    assert.ok(promptContextPairIssue({
      level: "l2",
      mode: "same_round_retry",
      reason: "invocation_recovery",
      attempt: 2,
      round: 2,
    }));
    assert.ok(promptContextPairIssue({
      level: "l2",
      mode: "fresh_invocation",
      reason: "invocation_recovery",
      attempt: 1,
      round: 2,
    }));
  });
});

describe("prompt level does not choose context boundary", () => {
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
        `${name} is a new-round boundary and must use clean context`);
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

describe("the decoder enforces the same context pairs", () => {
  it("accepts L2 with same_round_retry because density and context are independent", async () => {
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
    assert.ok(parseRoundTransactionSnapshot(snapshot.snapshot),
      "a legal L2 in-context retry remains readable committed history");
  });
});
