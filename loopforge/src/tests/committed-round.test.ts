import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCommittedRound,
  decodeMergedRound,
  derivationRounds,
  historyRounds,
  persistedFrontier,
  readOnlyRounds,
} from "../committed-round.js";
import { committedBacktrackRound, committedFeedbackRound, mergedLineageRound } from "./_helpers.js";
import { claimedMetCriteria } from "../self-eval.js";

/** The durable session document — the frontier a read-only view reads. */
function sessionEntry(loopId: string, currentRound: number): Record<string, unknown> {
  return {
    task_id: `loop:${loopId}:session`,
    task_type: "session_state",
    loop_id: loopId,
    loop_lineage: { current_round: currentRound },
  };
}

describe("CommittedRoundView", () => {
  it("normalizes durable and hydrated representations to the same facts", () => {
    const raw = committedFeedbackRound(2, {
      loopId: "view",
      outcome: "partial",
      met: ["criterion"],
      files: ["src/a.ts"],
      attempt: 3,
    });
    raw.sequence = 2;
    const merged = mergedLineageRound(2, {
      loopId: "view",
      outcome: "partial",
      met: ["criterion"],
      files: ["src/a.ts"],
      attempt: 3,
    });
    const durable = decodeCommittedRound(raw)!;
    const hydrated = decodeMergedRound(merged)!;
    assert.deepEqual(
      [durable.round, durable.attempt, durable.outcome, claimedMetCriteria(durable.executionReport)],
      [hydrated.round, hydrated.attempt, hydrated.outcome, claimedMetCriteria(hydrated.executionReport)],
    );
    assert.equal(durable.sequence, 2);
  });

  it("excludes in-flight and rejected snapshots", () => {
    const prepared = committedFeedbackRound(1, { loopId: "view" });
    const transaction = prepared.loop_lineage!.round_transaction as Record<string, unknown>;
    (transaction.snapshot as Record<string, unknown>).phase = "prepared";
    assert.equal(decodeCommittedRound(prepared), null);
    (transaction.snapshot as Record<string, unknown>).phase = "rejected";
    assert.equal(decodeCommittedRound(prepared), null);
  });

  it("deduplicates by logical round and removes rollback directives", () => {
    const first = decodeCommittedRound(committedFeedbackRound(1, { loopId: "view" }))!;
    const replacementEntry = committedFeedbackRound(1, { loopId: "view", outcome: "blocked" });
    const replacement = decodeCommittedRound(replacementEntry)!;
    const rollback = decodeCommittedRound(
      committedFeedbackRound(2, { loopId: "view", action: "backtrack" }),
    )!;
    const history = historyRounds([first, rollback, replacement]);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.outcome, "blocked");
  });

  it("v3.8.1: read-only views drop a backtracked branch while a directive stands", () => {
    // The live paths bound their window at the session frontier, which is what
    // keeps a backtracked branch out of history. Read-only views had no such
    // bound, so after a rollback they reported the abandoned rounds as this
    // branch's history — and disagreed with the prompt about it.
    const entries = [
      committedFeedbackRound(1, { loopId: "ro" }),
      committedFeedbackRound(2, { loopId: "ro" }),
      committedFeedbackRound(3, { loopId: "ro" }),
      committedFeedbackRound(4, { loopId: "ro" }),
      committedBacktrackRound(5, "ro"),
      sessionEntry("ro", 3),
    ];
    assert.deepEqual(
      derivationRounds(entries).map((view) => view.round),
      [1, 2, 3, 4],
      "precondition: the unbounded window still sees the abandoned round documents",
    );
    assert.deepEqual(
      readOnlyRounds(entries).map((view) => view.round),
      [1, 2],
      "the frontier the rollback recorded is the window's bound",
    );
  });

  it("v3.8.1: once the redo replaced the directive, the whole branch counts again", () => {
    // The directive stops being history the moment the redo commit replaces
    // its round's record — the abandoned rounds have been re-committed by
    // then, so they are this branch's history again.
    const entries = [
      committedFeedbackRound(1, { loopId: "ro" }),
      committedFeedbackRound(2, { loopId: "ro" }),
      committedFeedbackRound(3, { loopId: "ro", outcome: "success" }),
      sessionEntry("ro", 4),
    ];
    assert.deepEqual(
      readOnlyRounds(entries).map((view) => view.round),
      [1, 2, 3],
    );
  });

  it("v3.8.1: a stopped loop keeps its final round", () => {
    // A stop / terminate / max_rounds leaves currentRound ON the round it just
    // committed. Bounding there — which is what a naive read-only bound would
    // do — silently drops the loop's last round. No directive is in effect, so
    // the window stays unbounded and the final round survives.
    const entries = [
      committedFeedbackRound(1, { loopId: "ro", outcome: "success" }),
      sessionEntry("ro", 1),
    ];
    assert.deepEqual(readOnlyRounds(entries).map((view) => view.round), [1]);
    assert.equal(persistedFrontier(entries), 1, "the frontier is still observable");
  });

  it("rejects an envelope without a parseable snapshot (v3.8 hard break)", () => {
    // v3.8: the transaction schema is a hard version break — an envelope that
    // does not parse is not committed history. legacyTransactionRounds()
    // reports the loss explicitly instead of decoding a partial view.
    const entry = committedFeedbackRound(1, { loopId: "view" });
    const transaction = entry.loop_lineage!.round_transaction as Record<string, unknown>;
    delete transaction.snapshot;
    assert.equal(decodeCommittedRound(entry), null);
  });
});
