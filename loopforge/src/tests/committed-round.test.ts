import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCommittedRecord,
  decodeCommittedRound,
  decodeMergedRound,
  derivationRounds,
  historyRounds,
  pendingBacktrackRecord,
  persistedFrontier,
  readOnlyRounds,
  roundResultFromCommittedRound,
} from "../committed-round.js";
import {
  deriveRoundProgress,
  STALL_PROGRESS_COVERAGE,
} from "../progress.js";
import type { MachineObservation } from "../protocol.js";
import { committedBacktrackRound, committedFeedbackRound, mergedLineageRound, withTransaction } from "./_helpers.js";
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
    const rollback = decodeCommittedRecord(
      committedBacktrackRound(2, "view", 1),
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
      committedBacktrackRound(5, "ro", 2),
      sessionEntry("ro", 3),
    ];
    assert.deepEqual(
      derivationRounds(entries).map((view) => view.round),
      [1, 2],
      "the live branch window excludes the abandoned rounds",
    );
    assert.deepEqual(
      readOnlyRounds(entries).map((view) => view.round),
      [1, 2],
      "the read-only branch window excludes the abandoned rounds",
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

  it("projects a committed view to the compiler's previous-round shape", () => {
    const view = decodeCommittedRound(committedFeedbackRound(2, {
      loopId: "parity",
      success: true,
      outcome: "partial",
      discoveredConstraints: ["a limit"],
      files: ["src/a.ts"],
      met: ["criterion"],
    }));
    assert.ok(view);
    const result = roundResultFromCommittedRound(view);
    assert.equal(result.round, 2);
    assert.equal(result.success, true);
    assert.equal(result.output_summary, "Committed round 2.");
    assert.deepEqual(result.discovered_constraints, ["a limit"]);
    assert.equal(result.outcome, "partial");
    assert.equal(result.manual_fixes_needed, "");
    assert.deepEqual(result.execution_report, view.executionReport);
    assert.deepEqual(result.constraint_violations, []);
  });

  it("finds a deep-restore backtrack by target + 1", () => {
    const deep = committedBacktrackRound(5, "bt", 2);
    assert.equal(pendingBacktrackRecord([deep], 3)?.round, 5);
    assert.equal(pendingBacktrackRecord([deep], 4), null);
    const shallow = committedBacktrackRound(4, "bt", 3, {
      branchId: "tx-rollback-bt-5",
      transactionId: "tx-rollback-bt-4",
    });
    assert.equal(pendingBacktrackRecord([deep, shallow], 4)?.round, 4);
  });

  it("aggregates every Git provider when deriving round motion", () => {
    const git = (
      providerId: string,
      phase: "before" | "after",
      head: string,
    ): MachineObservation => ({
      schemaVersion: 2,
      providerId,
      kind: "git",
      phase,
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: [],
      data: {
        dirty: [],
        fingerprints: {},
        head,
        coverage: "tracked_and_non_ignored_untracked",
      },
    } as MachineObservation);
    const view = decodeMergedRound(withTransaction({
      loop_id: "motion",
      loop_lineage: {
        loop_id: "motion",
        round: 1,
        constraints_active: [],
        committed_action: "continue",
      },
      success: false,
    }, "continue", {
      beforeEvidence: [
        git("git", "before", "aaa"),
        git("git-alt", "before", "bbb"),
      ],
      afterEvidence: [
        git("git", "after", "aaa"),
        git("git-alt", "after", "ccc"),
      ],
    }));
    assert.ok(view);
    assert.equal(
      deriveRoundProgress(view.observationDelta, STALL_PROGRESS_COVERAGE).state,
      "changed",
      "the second Git provider's HEAD move is motion even when the first is still",
    );
  });
});
