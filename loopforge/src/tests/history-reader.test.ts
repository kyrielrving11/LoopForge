/** Phase 1A: the read-only history loader composes the existing read models
 *  without adding a second branch rule or a second decode pass. */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { derivationRounds } from "../committed-round.js";
import {
  buildCommittedHistory,
  emptyCommittedHistory,
  historyWindow,
  loadCommittedHistory,
} from "../history.js";
import type { VaultEntry } from "../loop-store.js";
import {
  committedBacktrackRound,
  committedFeedbackRound,
  MemoryLoopStore,
} from "./_helpers.js";

const CHILD_BRANCH = "tx-rollback-hist-2";

function sampleEntries(): VaultEntry[] {
  return [
    committedFeedbackRound(1, { loopId: "hist", success: true }),
    committedBacktrackRound(2, "hist", 1),
    committedFeedbackRound(3, { loopId: "hist", branchId: CHILD_BRANCH, success: false }),
  ];
}

describe("committed history reader", () => {
  it("keeps the loader stateless and composes the branch read model", () => {
    const history = buildCommittedHistory(sampleEntries());
    assert.equal(history.loopId, "hist");
    assert.deepEqual(history.rounds.map((view) => view.round), [1, 3]);
    assert.deepEqual(history.directives.map((view) => view.round), [2]);
    assert.equal(history.pendingDirective, null);
    assert.equal(history.branch.branchId, CHILD_BRANCH);
  });

  it("historyWindow is exactly derivationRounds over the same entries", () => {
    const entries = sampleEntries();
    const history = buildCommittedHistory(entries);
    for (const round of [1, 2, 3, 4]) {
      assert.deepEqual(
        historyWindow(history, round).map((view) => view.round),
        derivationRounds(entries, round).map((view) => view.round),
      );
    }
  });

  it("loads with one store read", () => {
    const store = new MemoryLoopStore();
    for (const entry of sampleEntries()) store.appendEntry(entry);
    let calls = 0;
    const original = store.listEntries.bind(store);
    store.listEntries = (loopId?: string, opts?: { sinceRound?: number }) => {
      calls++;
      return original(loopId, opts);
    };
    const history = loadCommittedHistory(store, "hist");
    assert.equal(calls, 1);
    assert.equal(history.rounds.length, 2);
  });

  it("reports unsupported envelopes instead of silently dropping them", () => {
    const legacy = committedFeedbackRound(4, { loopId: "hist" });
    const transaction = (legacy.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    (transaction.snapshot as Record<string, unknown>).schemaVersion = 4;
    const history = buildCommittedHistory([...sampleEntries(), legacy]);
    assert.deepEqual(history.legacyRounds, [
      { round: 4, schemaVersion: 4, envelope: "transaction" },
    ]);
    assert.equal(history.rounds.some((view) => view.round === 4), false);
  });

  it("reports an illegal prompt-context pair instead of silently dropping its round", () => {
    const invalid = committedFeedbackRound(1, { loopId: "hist" });
    const transaction = (invalid.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    const snapshot = transaction.snapshot as Record<string, unknown>;
    snapshot.promptArtifact = {
      schemaVersion: 11,
      roundId: "loop:hist:round:1",
      round: 1,
      attempt: 2,
      level: "l2",
      contextMode: "same_round_retry",
      contextReason: "rejection_escalation",
      renderedPrompt: "retry",
      promptHash: "hash-1",
      stateHash: "state-1",
      sections: [],
      droppedSections: [],
      protectedOverflow: false,
      budget: 10_000,
      renderedChars: 5,
      coverage: { active: [], rendered: [], omitted: [], complete: true },
    };

    const history = buildCommittedHistory([invalid]);
    assert.equal(history.rounds.some((view) => view.round === 1), false);
    assert.deepEqual(history.legacyRounds, [
      { round: 1, schemaVersion: 11, envelope: "prompt_context" },
    ]);
  });

  it("empty history is a valid read model", () => {
    const history = emptyCommittedHistory("empty");
    assert.equal(history.loopId, "empty");
    assert.deepEqual(history.rounds, []);
    assert.deepEqual(history.legacyRounds, []);
  });

  it("v4.0.1: runtime consumers never query raw entries directly", () => {
    // queryLoopEntries is a low-level legacy/CLI query. Every runtime read
    // goes through loadCommittedHistory so branch, window and legacy
    // reporting cannot drift between consumers.
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const allowed = new Set(["loop-store.ts", "history.ts", "cli.ts", "index.ts"]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (item.isDirectory()) {
          if (item.name !== "tests") walk(join(dir, item.name));
          continue;
        }
        if (!item.name.endsWith(".ts")) continue;
        if (allowed.has(basename(item.name))) continue;
        const text = readFileSync(join(dir, item.name), "utf8");
        if (/\bqueryLoopEntries\s*\(/.test(text)) offenders.push(item.name);
      }
    };
    walk(src);
    assert.deepEqual(offenders, []);
  });
});
