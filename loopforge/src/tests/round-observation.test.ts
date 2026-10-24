/** v3.9.1 — transaction schema 3, complete boundary delta, and the read model. */
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
  derivationRounds,
  legacyTransactionRounds,
} from "../committed-round.js";
import { gitMotionSignal } from "../git-motion.js";
import {
  deriveProgressWindow,
  deriveRoundProgress,
} from "../progress.js";
import type {
  CustomObservation,
  GitObservation,
  MachineObservation,
  ProgressCoverage,
} from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";
import { fixtureBeforeCheckpointError } from "./_helpers.js";

function gitObservation(
  files: string[],
  fingerprints: Record<string, string> = {},
  head?: string,
): GitObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files,
    data: {
      dirty: files,
      fingerprints,
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

const COVERAGE: ProgressCoverage = {
  domain: "repository",
  object: "tracker-state",
  scope: "whole",
  version: 1,
};

function customObservation(
  data: Record<string, unknown>,
  phase: "before" | "after" = "after",
): CustomObservation {
  return {
    schemaVersion: 1,
    providerId: "tracker",
    kind: "custom",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files: [],
    data,
  } as CustomObservation;
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
          kind: "evaluation",
          branchId: `loop:${loopId}:branch:root`,
          transactionId: `tx-${loopId}-${round}-1`,
          roundId: `loop:${loopId}:round:${round}`,
          loopId,
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: opts.before ?? [],
          ...(opts.schemaVersion === undefined
            ? {
                ...fixtureBeforeCheckpointError(opts.before ?? []),
                operatorAcceptance: {
                  task: "Observe rounds",
                  success_criteria: [],
                  hard_constraints: [],
                },
                compiled: {
                  task: "Observe rounds",
                  goalId: "obs-loop:observe-rounds",
                  constraintsActive: [],
                  constraintsRetired: [],
                },
              }
            : {}),
          ...(opts.after ? { afterEvidence: opts.after } : {}),
          evaluation: {
            success: true,
            output_summary: `round ${round}`,
            constraint_violations: [],
            should_continue: true,
          },
          submittedFields: [
            "success", "output_summary", "constraint_violations", "should_continue",
          ],
          createdAt: 0,
          updatedAt: 0,
        },
        result: { action: "continue", verificationFlags: [], roundSuccess: true },
      },
    },
  };
}

describe("v3.8 — round observation delta", () => {
  it("derives added, removed, and changed files without mutating the input", () => {
    const before = [gitObservation(["a.ts", "b.ts"], { "a.ts": "m:1", "b.ts": "m:1" })];
    const after = [gitObservation(["a.ts", "c.ts"], { "a.ts": "m:2", "c.ts": "m:1" })];
    const delta = deriveRoundObservationDelta(before, after);
    assert.deepEqual(
      delta[0].changedFiles,
      ["a.ts", "b.ts", "c.ts"],
      "a.ts changed, b.ts disappeared, c.ts appeared",
    );
    assert.equal(delta[0].before, before[0], "before is the raw fact, not a copy");
    assert.equal(delta[0].after, after[0], "after is the raw fact, not a copy");
    assert.deepEqual(after[0].files, ["a.ts", "c.ts"], "the input observation is not mutated");
  });

  it("reports null when there is no baseline", () => {
    const after = [gitObservation(["a.ts"])];
    const delta = deriveRoundObservationDelta([], after);
    assert.equal(delta.length, 1);
    assert.equal(delta[0].before, null);
    assert.equal(delta[0].after, after[0]);
    assert.equal(delta[0].changedFiles, null,
      "an after-only collection is not a before→after change set");
  });

  it("keeps content-identical files out of the delta", () => {
    const before = [gitObservation(["a.ts"], { "a.ts": "m:same" })];
    const after = [gitObservation(["a.ts"], { "a.ts": "m:same" })];
    assert.deepEqual(deriveRoundObservationDelta(before, after)[0].changedFiles, []);
  });

  it("treats command observations as evidence, not file changes", () => {
    const command: MachineObservation = {
      schemaVersion: 1,
      providerId: "command:test",
      kind: "command",
      phase: "after",
      startedAt: 0,
      finishedAt: 0,
      status: "passed",
      files: [],
      data: {
        commandId: "test",
        argv: ["node", "-e", "process.exit(0)"],
        cwd: ".",
        configHash: "0".repeat(64),
        required: false,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutSha256: "0".repeat(64),
        stderrSha256: "0".repeat(64),
        stdoutExcerpt: "",
        stderrExcerpt: "",
        truncated: false,
        entrypointFiles: [],
      },
    };
    const delta = deriveRoundObservationDelta([], [command]);
    assert.equal(delta[0].kind, "command");
    assert.equal(delta[0].changedFiles, null);
    assert.equal(delta[0].after, command);
  });

  it("marks duplicate provider keys as unknown", () => {
    const before = [gitObservation(["a.ts"], { "a.ts": "m:1" })];
    const after = [
      gitObservation(["a.ts"], { "a.ts": "m:2" }),
      gitObservation(["b.ts"], { "b.ts": "m:1" }),
    ];
    const delta = deriveRoundObservationDelta(before, after);
    assert.equal(delta.length, 1);
    assert.equal(delta[0].changedFiles, null);
  });
});

describe("gitMotionSignal — the one motion definition", () => {
  it("counts a non-empty change set and a moved HEAD", () => {
    assert.equal(gitMotionSignal({ changedFiles: ["a.ts"] }), true);
    assert.equal(gitMotionSignal({ changedFiles: [], headBefore: "aaa", headAfter: "bbb" }), true);
  });

  it("returns false only when both HEADs are known and no file changed", () => {
    assert.equal(
      gitMotionSignal({ changedFiles: [], headBefore: "aaa", headAfter: "aaa" }),
      false,
    );
  });

  it("returns null when the file set or HEAD comparison is undecidable", () => {
    assert.equal(gitMotionSignal({ changedFiles: [] }), null,
      "an empty file set alone cannot rule out a commit-only move");
    assert.equal(
      gitMotionSignal({ changedFiles: [], headAfter: "aaa", headBefore: undefined }),
      null,
      "one-sided HEAD is not a movement",
    );
    assert.equal(
      gitMotionSignal({ changedFiles: null, headBefore: "aaa", headAfter: "aaa" }),
      null,
      "unknown files never become observed no-motion",
    );
    assert.equal(
      gitMotionSignal({ changedFiles: null, headBefore: "aaa", headAfter: "bbb" }),
      true,
      "HEAD movement is an independent machine fact",
    );
  });
});

describe("Git progress facts under the explicit selector", () => {
  it("reads the round's own before/after deltas", () => {
    assert.equal(
      deriveRoundProgress(
        deriveRoundObservationDelta(
          [gitObservation([], {}, "aaa")],
          [gitObservation([], {}, "bbb")],
        ),
            ).state,
      "changed",
    );
    const noBaseline = deriveRoundObservationDelta([], [gitObservation(["a.ts"])]);
    assert.equal(
      deriveRoundProgress(noBaseline).state,
      "unknown",
      "no baseline and no HEAD evidence is unknown, not motion",
    );
  });

  it("is not_applicable when Git never observed the round", () => {
    assert.equal(
      deriveRoundProgress([]).state,
      "not_applicable",
    );
    assert.equal(
      deriveRoundProgress(
        deriveRoundObservationDelta(
          [gitObservation([])],
          [{ ...gitObservation([]), status: "timeout" }],
        ),
            ).state,
      "unknown",
    );
  });

  it("does not count a restore as round motion", () => {
    const deltas = deriveRoundObservationDelta(
      [],
      [gitObservation([], {}, "abcdef123456")],
    );
    assert.equal(
      deriveRoundProgress(deltas).state,
      "unknown",
      "a before-less boundary is unknown, and a restore adds no motion arm",
    );
  });
});

describe("progress window under the Git selector", () => {
  it("counts clean committed slices as motion when HEAD advances", () => {
    const views = [
      feedbackEntry(1, {
        before: [gitObservation([], {}, "000000")],
        after: [gitObservation([], {}, "aaa111")],
      }),
      feedbackEntry(2, {
        before: [gitObservation([], {}, "aaa111")],
        after: [gitObservation([], {}, "bbb222")],
      }),
      feedbackEntry(3, {
        before: [gitObservation([], {}, "bbb222")],
        after: [gitObservation([], {}, "ccc333")],
      }),
    ].flatMap((entry) => derivationRounds([entry]));
    const window = deriveProgressWindow(views, 4, 3);
    assert.equal(window.state, "changed");
    assert.deepEqual(
      window.roundStates.map((entry) => entry.state),
      ["changed", "changed", "changed"],
    );
  });

  it("treats failed Git captures as unknown and never derives a file delta", () => {
    for (const status of ["unavailable", "timeout", "error", "aborted"] as const) {
      const views = derivationRounds([
        feedbackEntry(1, {
          before: [gitObservation(["a.ts"])],
          after: [{ ...gitObservation([]), status }],
        }),
        feedbackEntry(2, { after: [gitObservation([])] }),
        feedbackEntry(3, { after: [gitObservation([])] }),
      ]);
      assert.equal(views[0].observationDelta[0].changedFiles, null,
        "an unobservable after boundary must not manufacture a delta");
      assert.equal(
        deriveProgressWindow(views, 4, 3).state,
        "unknown",
        status,
      );
    }
  });

  it("keeps an unknown file set undecidable when HEAD does not move", () => {
    const views = derivationRounds([
      feedbackEntry(1, {
        before: [gitObservation([], {}, "same")],
        after: [gitObservation([], {}, "same")],
      }),
      feedbackEntry(2, { after: [gitObservation([], {}, "same")] }),
      feedbackEntry(3, { after: [gitObservation([], {}, "same")] }),
    ]);
    assert.equal(
      deriveProgressWindow(views, 4, 3).state,
      "unknown",
    );
  });
});

describe("v3.9.1 — transaction schema 3", () => {
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
    assert.deepEqual(legacyTransactionRounds(entries), [
      { round: 2, schemaVersion: 1, envelope: "transaction" },
    ]);
    const views = derivationRounds(entries);
    assert.deepEqual(views.map((view) => view.round), [1, 3],
      "legacy rounds are not history — the loss is reported, never silent");
  });

  it("v3.8.1: reports a legacy PROMPT ARTIFACT version too", () => {
    // The artifact schema is versioned separately from the transaction, and
    // the transaction parser rejects a snapshot whose artifact version it does
    // not know — dropping the whole round. Reporting only the transaction
    // version would let that deletion happen silently.
    const stale = feedbackEntry(2);
    const envelope = (stale.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    (envelope.snapshot as Record<string, unknown>).promptArtifact = {
      schemaVersion: 1,
      roundId: "loop:obs:round:2",
      attempt: 1,
      level: "l1",
      renderedPrompt: "p",
      promptHash: "h",
      stateHash: "s",
    };
    const entries = [feedbackEntry(1), stale];
    assert.deepEqual(legacyTransactionRounds(entries), [
      { round: 2, schemaVersion: 1, envelope: "prompt_artifact" },
    ]);
    assert.deepEqual(
      derivationRounds(entries).map((view) => view.round),
      [1],
      "an unknown artifact version is not history either",
    );
  });

  it("v3.9.1: reports a legacy Git observation schema too", () => {
    const stale = feedbackEntry(2);
    const envelope = (stale.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    (envelope.snapshot as Record<string, unknown>).afterEvidence = [{
      schemaVersion: 1,
      providerId: "git",
      kind: "git",
      phase: "after",
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: [],
      data: { dirty: [], fingerprints: {}, coverage: "tracked_and_non_ignored_untracked" },
    }];
    const entries = [feedbackEntry(1), stale];
    assert.deepEqual(legacyTransactionRounds(entries), [
      { round: 2, schemaVersion: 1, envelope: "observation" },
    ]);
    assert.deepEqual(derivationRounds(entries).map((view) => view.round), [1]);
  });

  it("v3.9.9: keeps a custom observation without progress readable", () => {
    const entry = feedbackEntry(1, {
      after: [customObservation({})],
    });
    assert.deepEqual(legacyTransactionRounds([entry]), []);
    assert.deepEqual(
      derivationRounds([entry]).map((view) => view.round), [1],
      "custom base schema stays 1, so history without progress survives",
    );
  });


});

describe("v3.8 — read-model observation fields", () => {
  it("derives the delta from the committed collections", () => {
    const entry = feedbackEntry(1, {
      before: [gitObservation(["a.ts"], { "a.ts": "m:1" })],
      after: [gitObservation(["a.ts", "b.ts"], { "a.ts": "m:1", "b.ts": "m:1" })],
    });
    const view = derivationRounds([entry])[0];
    assert.deepEqual(view.observationDelta[0].changedFiles, ["b.ts"]);
    assert.equal(view.evidenceIncomplete, false);
  });

  it("marks a round without after observations as evidence-incomplete", () => {
    const view = derivationRounds([feedbackEntry(1)])[0];
    assert.equal(view.evidenceIncomplete, true);
    assert.deepEqual(view.observationDelta, []);
  });

  it("marks a no-baseline Git round as evidence-incomplete with an unknown change set", () => {
    const view = derivationRounds([
      feedbackEntry(1, { after: [gitObservation(["a.ts"])] }),
    ])[0];
    assert.equal(view.evidenceIncomplete, true);
    assert.equal(view.observationDelta[0].changedFiles, null);
  });

  it("reads git motion from the derived delta", () => {
    const rounds = derivationRounds([
      feedbackEntry(1, {
        before: [gitObservation([], {}, "h0")],
        after: [gitObservation(["a.ts"], { "a.ts": "m:1" }, "h1")],
      }),
      feedbackEntry(2, {
        before: [gitObservation(["a.ts"], { "a.ts": "m:1" }, "h1")],
        after: [gitObservation(["a.ts"], { "a.ts": "m:1" }, "h1")],
      }),
      feedbackEntry(3, {
        before: [gitObservation(["a.ts"], { "a.ts": "m:1" }, "h1")],
        after: [gitObservation(["c.ts"], { "c.ts": "m:1" }, "h2")],
      }),
    ]);
    const window = deriveProgressWindow(rounds, 4, 3);
    assert.equal(window.state, "changed");
    assert.deepEqual(
      window.roundStates.map((entry) => entry.state),
      ["changed", "unchanged", "changed"],
    );
  });
});
