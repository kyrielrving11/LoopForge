import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCommittedRound,
  decodeMergedRound,
  historyRounds,
} from "../committed-round.js";
import { committedFeedbackRound, mergedLineageRound } from "./_helpers.js";

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
      [durable.round, durable.attempt, durable.outcome, durable.executionEvidence?.success_criteria_met],
      [hydrated.round, hydrated.attempt, hydrated.outcome, hydrated.executionEvidence?.success_criteria_met],
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

  it("accepts the current direct-feedback envelope without inventing persisted state", () => {
    const entry = committedFeedbackRound(1, { loopId: "view" });
    const transaction = entry.loop_lineage!.round_transaction as Record<string, unknown>;
    delete transaction.snapshot;
    const decoded = decodeCommittedRound(entry);
    assert.equal(decoded?.round, 1);
    assert.equal(decoded?.action, "continue");
    assert.equal(decoded?.evaluation, null);
  });
});
