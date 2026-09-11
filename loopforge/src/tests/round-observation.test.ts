/** v3.8 — transaction schema 2, derived round delta, and the read model. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROUND_TRANSACTION_SCHEMA_VERSION,
  deriveRoundObservationDelta,
  parseRoundTransactionSnapshot,
  prepareRoundTransaction,
  transactionSchemaVersionOf,
} from "../round-transaction.js";
import {
  committedRoundsFromEntries,
  legacyTransactionRounds,
  machineGitMotionSeries,
} from "../committed-round.js";
import type { GitObservation, MachineObservation } from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";

function gitObservation(files: string[], fingerprints: Record<string, string> = {}): GitObservation {
  return {
    schemaVersion: 1,
    providerId: "git",
    kind: "git",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files,
    data: { tracked: files, staged: [], untracked: [], fingerprints },
  };
}

function feedbackEntry(
  round: number,
  opts: {
    schemaVersion?: number;
    before?: MachineObservation[];
    after?: MachineObservation[];
  } = {},
): VaultEntry {
  const loopId = "obs-loop";
  return {
    task_id: `loop:${loopId}:r${round}:feedback`,
    loop_id: loopId,
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: opts.schemaVersion ?? ROUND_TRANSACTION_SCHEMA_VERSION,
        round_id: `loop:${loopId}:round:${round}`,
        snapshot: {
          schemaVersion: opts.schemaVersion ?? ROUND_TRANSACTION_SCHEMA_VERSION,
          roundId: `loop:${loopId}:round:${round}`,
          loopId,
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: opts.before ?? [],
          ...(opts.after ? { afterEvidence: opts.after } : {}),
          evaluation: {
            success: true,
            output_summary: `round ${round}`,
            constraint_violations: [],
            should_continue: true,
          },
          createdAt: 0,
          updatedAt: 0,
        },
        result: { action: "continue", verificationFlags: [], roundSuccess: true },
      },
    },
  };
}

describe("v3.8 — round observation delta", () => {
  it("narrows the after collection to added, removed, and changed files", () => {
    const before = [gitObservation(["a.ts", "b.ts"], { "a.ts": "m:1", "b.ts": "m:1" })];
    const after = [gitObservation(["a.ts", "c.ts"], { "a.ts": "m:2", "c.ts": "m:1" })];
    const delta = deriveRoundObservationDelta(before, after);
    assert.deepEqual(
      delta[0].files,
      ["a.ts", "b.ts", "c.ts"],
      "a.ts changed, b.ts disappeared, c.ts appeared",
    );
    assert.deepEqual(after[0].files, ["a.ts", "c.ts"], "the input observation is not mutated");
  });

  it("returns the after collection unchanged when there is no baseline", () => {
    const after = [gitObservation(["a.ts"])];
    assert.deepEqual(deriveRoundObservationDelta([], after), after);
  });

  it("keeps content-identical files out of the delta", () => {
    const before = [gitObservation(["a.ts"], { "a.ts": "m:same" })];
    const after = [gitObservation(["a.ts"], { "a.ts": "m:same" })];
    assert.deepEqual(deriveRoundObservationDelta(before, after)[0].files, []);
  });
});

describe("v3.8 — transaction schema 2", () => {
  it("round-trips at the current schema version", () => {
    const snapshot = prepareRoundTransaction("obs-loop", 1, [gitObservation(["a.ts"])]);
    assert.equal(snapshot.schemaVersion, ROUND_TRANSACTION_SCHEMA_VERSION);
    const parsed = parseRoundTransactionSnapshot(JSON.parse(JSON.stringify(snapshot)));
    assert.ok(parsed);
    assert.equal(parsed?.roundId, "loop:obs-loop:round:1");
    assert.equal(parsed?.beforeEvidence.length, 1);
    assert.equal(parsed?.beforeEvidence[0].providerId, "git");
  });

  it("no longer persists a round delta", () => {
    const snapshot = prepareRoundTransaction("obs-loop", 1, []);
    assert.equal("roundEvidence" in snapshot, false);
  });

  it("rejects a legacy envelope instead of parsing it", () => {
    const legacy = {
      schemaVersion: 1,
      roundId: "loop:obs-loop:round:1",
      loopId: "obs-loop",
      round: 1,
      attempt: 1,
      phase: "committed",
      beforeEvidence: [],
      createdAt: 0,
      updatedAt: 0,
    };
    assert.equal(parseRoundTransactionSnapshot(legacy), null);
    assert.equal(transactionSchemaVersionOf(legacy), 1);
  });

  it("surfaces legacy rounds explicitly", () => {
    const entries = [feedbackEntry(1), feedbackEntry(2, { schemaVersion: 1 }), feedbackEntry(3)];
    assert.deepEqual(legacyTransactionRounds(entries), [{ round: 2, schemaVersion: 1 }]);
    const views = committedRoundsFromEntries(entries);
    assert.deepEqual(views.map((view) => view.round), [1, 3],
      "legacy rounds are not history — the loss is reported, never silent");
  });
});

describe("v3.8 — read-model observation fields", () => {
  it("derives the delta from the committed collections", () => {
    const entry = feedbackEntry(1, {
      before: [gitObservation(["a.ts"], { "a.ts": "m:1" })],
      after: [gitObservation(["a.ts", "b.ts"], { "a.ts": "m:1", "b.ts": "m:1" })],
    });
    const view = committedRoundsFromEntries([entry])[0];
    assert.deepEqual(view.observationDelta[0].files, ["b.ts"]);
    assert.equal(view.evidenceIncomplete, false);
  });

  it("marks a round without after observations as evidence-incomplete", () => {
    const view = committedRoundsFromEntries([feedbackEntry(1)])[0];
    assert.equal(view.evidenceIncomplete, true);
    assert.deepEqual(view.observationDelta, []);
  });

  it("reads git motion from the derived delta", () => {
    const rounds = committedRoundsFromEntries([
      feedbackEntry(1, { before: [], after: [gitObservation(["a.ts"])] }),
      feedbackEntry(2, { before: [], after: [gitObservation([])] }),
      feedbackEntry(3, { before: [], after: [gitObservation(["c.ts"])] }),
    ]);
    assert.deepEqual(machineGitMotionSeries(rounds, 4, 3), [true, false, true]);
  });
});
