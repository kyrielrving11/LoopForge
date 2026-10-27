import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  heldPromptSnapshot,
  makeSubmissionHandle,
  parseSubmissionHandle,
  staleHandleWarning,
  validateSubmissionHandle,
  type HeldSessionView,
} from "../mcp/submission-handle.js";
import {
  PROMPT_ARTIFACT_SCHEMA_VERSION,
  type PromptArtifact,
} from "../protocol.js";
import {
  ROUND_TRANSACTION_SCHEMA_VERSION,
  type RoundTransactionSnapshot,
} from "../round-transaction.js";

const ROUND_ID = "loop:handle-test:round:2";
const TX = "tx-0123456789abcdef01234567";

function artifact(overrides: Partial<PromptArtifact> = {}): PromptArtifact {
  return {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
    roundId: ROUND_ID,
    round: 2,
    attempt: 1,
    level: "l1",
    contextMode: "fresh_round",
    contextReason: "next_round",
    renderedPrompt: "the held prompt",
    promptHash: "prompt-hash",
    stateHash: "state-hash",
    sections: [],
    droppedSections: [],
    protectedOverflow: false,
    budget: 10_000,
    renderedChars: 100,
    coverage: { active: [], rendered: [], omitted: [], complete: true },
    ...overrides,
  };
}

function snapshot(overrides: Partial<RoundTransactionSnapshot> = {}): RoundTransactionSnapshot {
  return {
    schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
    branchId: "loop:handle-test:branch:root",
    transactionId: TX,
    kind: "evaluation",
    roundId: ROUND_ID,
    loopId: "handle-test",
    round: 2,
    attempt: 1,
    phase: "prompted",
    beforeEvidence: [],
    createdAt: 1,
    updatedAt: 1,
    promptArtifact: artifact(),
    ...overrides,
  };
}

function session(overrides: Partial<HeldSessionView> = {}): HeldSessionView {
  return {
    sessionId: "session-1",
    currentRound: 2,
    status: "running",
    roundSnapshot: snapshot(),
    ...overrides,
  };
}

describe("v4.0.0 submission handle", () => {
  it("derives exactly the three identities from a held prompted snapshot", () => {
    const handle = makeSubmissionHandle(session());
    assert.deepEqual(handle, {
      sessionId: "session-1",
      roundId: ROUND_ID,
      transactionId: TX,
    });
    assert.deepEqual(makeSubmissionHandle(session()), handle, "deterministic");
  });

  it("fails closed when the snapshot is not a held prompted evaluation", () => {
    assert.equal(heldPromptSnapshot(undefined), null);
    assert.equal(heldPromptSnapshot(session({ status: "stopped" })), null);
    assert.equal(heldPromptSnapshot(session({ roundSnapshot: null })), null);
    assert.equal(heldPromptSnapshot(session({ roundSnapshot: snapshot({ kind: "rollback" }) })), null);
    assert.equal(heldPromptSnapshot(session({ currentRound: 3 })), null);
    assert.equal(heldPromptSnapshot(session({ roundSnapshot: snapshot({ phase: "prepared" }) })), null);
    assert.equal(heldPromptSnapshot(session({ roundSnapshot: snapshot({ phase: "committed" }) })), null);
    assert.equal(heldPromptSnapshot(session({ roundSnapshot: snapshot({ phase: "rejected" }) })), null);
    assert.equal(heldPromptSnapshot(session({ roundSnapshot: snapshot({ phase: "terminated" }) })), null);
    assert.equal(heldPromptSnapshot(session({ roundSnapshot: snapshot({ promptArtifact: undefined }) })), null);
  });

  it("requires the artifact to name the same round and attempt", () => {
    assert.equal(heldPromptSnapshot(session({
      roundSnapshot: snapshot({ promptArtifact: artifact({ roundId: "loop:handle-test:round:1" }) }),
    })), null);
    assert.equal(heldPromptSnapshot(session({
      roundSnapshot: snapshot({ promptArtifact: artifact({ round: 1 }) }),
    })), null);
    assert.equal(heldPromptSnapshot(session({
      roundSnapshot: snapshot({ promptArtifact: artifact({ attempt: 2 }) }),
    })), null);
    assert.equal(heldPromptSnapshot(session({
      roundSnapshot: snapshot({ promptArtifact: artifact({ renderedPrompt: "" }) }),
    })), null);
  });

  it("parses only a plain object with exactly three non-empty strings", () => {
    assert.deepEqual(parseSubmissionHandle({
      sessionId: "session-1", roundId: ROUND_ID, transactionId: TX,
    }), { sessionId: "session-1", roundId: ROUND_ID, transactionId: TX });
    assert.equal(parseSubmissionHandle(null), null);
    assert.equal(parseSubmissionHandle([]), null);
    assert.equal(parseSubmissionHandle("x"), null);
    assert.equal(parseSubmissionHandle({ sessionId: "s", roundId: "r" }), null);
    assert.equal(parseSubmissionHandle({
      sessionId: "s", roundId: "r", transactionId: "t", extra: "x",
    }), null);
    assert.equal(parseSubmissionHandle({
      sessionId: "", roundId: "r", transactionId: "t",
    }), null);
    assert.equal(parseSubmissionHandle({
      sessionId: "s", roundId: "r", transactionId: 3,
    }), null);
  });

  it("accepts the exact current handle", () => {
    const check = validateSubmissionHandle(
      { sessionId: "session-1", roundId: ROUND_ID, transactionId: TX },
      session(),
    );
    assert.equal(check.ok, true);
    if (check.ok) {
      assert.deepEqual(check.handle, {
        sessionId: "session-1", roundId: ROUND_ID, transactionId: TX,
      });
      assert.equal(check.snapshot.roundId, ROUND_ID);
    }
  });

  it("rejects each differing field without trimming or normalization", () => {
    const base = { sessionId: "session-1", roundId: ROUND_ID, transactionId: TX };
    for (const [field, value] of [
      ["sessionId", "session-2"],
      ["roundId", "loop:handle-test:round:1"],
      ["transactionId", "tx-ffffffffffffffffffffffff"],
    ] as const) {
      const check = validateSubmissionHandle({ ...base, [field]: value }, session());
      assert.equal(check.ok, false);
      if (!check.ok) {
        assert.equal(check.code, "submission_handle_mismatch");
        assert.deepEqual(check.mismatched, [field]);
        assert.deepEqual(check.current, base);
      }
    }
    const whitespace = validateSubmissionHandle(
      { ...base, roundId: ` ${ROUND_ID} ` },
      session(),
    );
    assert.equal(whitespace.ok, false);
    if (!whitespace.ok) assert.deepEqual(whitespace.mismatched, ["roundId"]);
  });

  it("distinguishes shape, missing session, and no held prompt", () => {
    const missing = validateSubmissionHandle({}, session());
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "submission_handle_required");

    const noSession = validateSubmissionHandle(
      { sessionId: "session-1", roundId: ROUND_ID, transactionId: TX },
      undefined,
    );
    assert.equal(noSession.ok, false);
    if (!noSession.ok) {
      assert.equal(noSession.code, "session_not_found");
      assert.match(noSession.detail, /loopforge_status/);
      assert.match(noSession.detail, /loopforge_resume/);
    }

    const noPrompt = validateSubmissionHandle(
      { sessionId: "session-1", roundId: ROUND_ID, transactionId: TX },
      session({ roundSnapshot: null }),
    );
    assert.equal(noPrompt.ok, false);
    if (!noPrompt.ok) {
      assert.equal(noPrompt.code, "submission_handle_mismatch");
      assert.equal(noPrompt.reason, "no_held_prompt");
      assert.equal(noPrompt.current, null);
      assert.match(noPrompt.detail, /loopforge_resume/);
    }
  });

  it("does not mutate the session or persist the handle", () => {
    const value = session();
    const before = JSON.stringify(value);
    const first = makeSubmissionHandle(value);
    const second = makeSubmissionHandle(value);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(value), before);
    assert.ok(!before.includes("submissionHandle"));
  });

  it("uses one deterministic stale warning", () => {
    assert.equal(staleHandleWarning(), staleHandleWarning());
    assert.match(staleHandleWarning(), /submissionHandle/);
  });
});
