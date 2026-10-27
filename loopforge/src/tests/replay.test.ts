import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReplayBackend, ReplayWindowError } from "../replay.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "../protocol.js";
import type { PromptArtifact } from "../protocol.js";
import {
  committedBacktrackRound,
  committedFeedbackRound,
  MemoryLoopStore,
} from "./_helpers.js";

function artifact(
  round: number,
  level: "l0" | "l1" | "l2",
  renderedPrompt = "",
): PromptArtifact {
  return {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
    roundId: `loop:test:round:${round}`,
    round,
    attempt: 1,
    level,
    contextMode: "fresh_round",
    contextReason: "next_round",
    renderedPrompt,
    promptHash: `hash-${round}`,
    stateHash: `state-${round}`,
    sections: [],
    droppedSections: [],
    protectedOverflow: false,
    budget: 18000,
    renderedChars: renderedPrompt.length,
    coverage: { active: [], rendered: [], omitted: [], complete: true },
  };
}

function appendRound(
  store: MemoryLoopStore,
  round: number,
  overrides: Parameters<typeof committedFeedbackRound>[1] = {},
): void {
  store.appendEntry(committedFeedbackRound(round, {
    loopId: "test",
    promptArtifact: artifact(round, round === 1 ? "l2" : "l1"),
    compiled: {
      task: `Round ${round}`,
      goalId: `test:round-${round}`,
      constraintsActive: [],
      constraintsRetired: [],
    },
    ...overrides,
  }));
}

describe("ReplayBackend", () => {
  let store: MemoryLoopStore;
  let replay: ReplayBackend;

  beforeEach(() => {
    store = new MemoryLoopStore();
    replay = new ReplayBackend(store);
  });

  it("returns only committed rounds", () => {
    assert.equal(replay.getRound("test", 1), null);
    store.appendEntry(committedFeedbackRound(1, { loopId: "test" }));
    assert.equal(replay.getRound("test", 1)?.round, 1);
    assert.equal(replay.getRound("test", 1)?.source, "feedback");
  });

  it("does not confuse round 1 with round 10", () => {
    appendRound(store, 10);
    appendRound(store, 1);
    assert.equal(replay.getRound("test", 1)?.round, 1);
    assert.equal(replay.getRound("test", 10)?.round, 10);
  });

  it("returns the committed prompt artifact and result", () => {
    appendRound(store, 1, {
      promptArtifact: artifact(1, "l2", "## Compiled Prompt"),
      success: true,
    });
    const view = replay.getRound("test", 1);
    assert.equal(view?.promptArtifact?.renderedPrompt, "## Compiled Prompt");
    assert.equal(view?.agentSuccessClaim, true);
  });

  it("replays committed rounds in a selected range", () => {
    for (let round = 1; round <= 5; round++) appendRound(store, round);
    assert.equal(replay.replay("test").length, 5);
    assert.deepEqual(
      replay.replay("test", { start: 2, end: 4 }).map((view) => view.round),
      [2, 3, 4],
    );
  });

  it("excludes rollback directives from normal rounds", () => {
    appendRound(store, 1);
    store.appendEntry(committedBacktrackRound(2, "test", 1));
    assert.deepEqual(
      replay.replay("test").map((view) => view.round),
      [1],
    );
  });

  it("v3.9.9: exposes per-provider progress facts and committed transitions", () => {
    const git = (phase: "before" | "after", head: string) => ({
      schemaVersion: 2,
      providerId: "git",
      kind: "git" as const,
      phase,
      startedAt: 0,
      finishedAt: 0,
      status: "observed" as const,
      files: [],
      data: {
        dirty: [],
        fingerprints: {},
        head,
        coverage: "tracked_and_non_ignored_untracked" as const,
      },
    });
    appendRound(store, 1, {
      beforeEvidence: [git("before", "aaa")],
      roundEvidence: [git("after", "bbb")],
      contractTransition: {
        kind: "supersede",
        contract_id: "rc-12345678",
        reason: "route changed",
      },
    });
    const [row] = replay.timeline("test");
    assert.equal(row?.machine_progress, "changed");
    assert.deepEqual(row?.progress_facts, [{
      kind: "git",
      providerId: "git",
      coverage: {
        domain: "workspace",
        object: "git-motion",
        scope: "tracked_and_non_ignored_untracked",
        version: 2,
      },
      state: "changed",
      complete: true,
    }]);
    assert.deepEqual(row?.contract_redirect, {
      kind: "supersede",
      contract_id: "rc-12345678",
      reason: "route changed",
    });
  });

  it("returns a sorted factual timeline with compile facts", () => {
    appendRound(store, 3);
    appendRound(store, 1);
    const timeline = replay.timeline("test");
    assert.deepEqual(timeline.map((row) => row.round), [1, 3]);
    assert.equal(timeline[0]?.recompile_level, "l2");
    assert.equal(timeline[1]?.recompile_level, "l1");
    assert.equal(timeline[1]?.task, "Round 3");
    assert.equal(timeline[1]?.goal_id, "test:round-3");
  });

  it("v4.0.1: reads the vault once per timeline and never per round", () => {
    for (let round = 1; round <= 4; round++) appendRound(store, round);
    let calls = 0;
    const original = store.listEntries.bind(store);
    store.listEntries = (loopId?: string, opts?: { sinceRound?: number }) => {
      calls++;
      return original(loopId, opts);
    };
    const timeline = replay.timeline("test");
    assert.equal(timeline.length, 4);
    assert.equal(calls, 1);
  });

  it("keeps unsupported envelopes visible as legacy rows", () => {
    appendRound(store, 1);
    const legacy = committedFeedbackRound(2, { loopId: "test" });
    const transaction = (legacy.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    (transaction.snapshot as Record<string, unknown>).schemaVersion = 5;
    store.appendEntry(legacy);
    const timeline = replay.timeline("test");
    assert.deepEqual(timeline.map((row) => row.round), [1, 2]);
    assert.equal(timeline[1]?.legacy, true);
    assert.equal(timeline[1]?.envelope, "transaction");
  });

  it("returns empty views for an unknown loop", () => {
    assert.equal(replay.getRound("missing", 1), null);
    assert.deepEqual(replay.replay("missing"), []);
    assert.deepEqual(replay.timeline("missing"), []);
  });
});

describe("v4.0.2 — bounded replay window", () => {
  let store: MemoryLoopStore;
  let replay: ReplayBackend;

  beforeEach(() => {
    store = new MemoryLoopStore();
    replay = new ReplayBackend(store);
  });

  it("defaults to the last 10 committed rounds and reports the window", () => {
    for (let round = 1; round <= 12; round++) {
      store.appendEntry(committedFeedbackRound(round, { loopId: "test" }));
    }
    const page = replay.page("test");
    assert.deepEqual(page.timeline.map((row) => row.round),
      [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(page.window, {
      start: 3,
      end: 12,
      totalRounds: 12,
      hasBefore: true,
      hasAfter: false,
    });
  });

  it("honours an explicit inclusive start/end window", () => {
    for (let round = 1; round <= 6; round++) {
      store.appendEntry(committedFeedbackRound(round, { loopId: "test" }));
    }
    const page = replay.page("test", { start: 2, end: 4 });
    assert.deepEqual(page.timeline.map((row) => row.round), [2, 3, 4]);
    assert.deepEqual(page.window, {
      start: 2,
      end: 4,
      totalRounds: 6,
      hasBefore: true,
      hasAfter: true,
    });
  });

  it("rejects invalid or oversized explicit windows", () => {
    assert.throws(() => replay.page("test", { start: 0 }), ReplayWindowError);
    assert.throws(() => replay.page("test", { start: 5, end: 4 }), ReplayWindowError);
    assert.throws(() => replay.page("test", { start: 1, end: 51 }), ReplayWindowError);
  });

  it("carries context, report, assumptions, questions and redirect", () => {
    store.appendEntry(committedFeedbackRound(1, {
      loopId: "test",
      promptArtifact: {
        ...artifact(1, "l1"),
        contextMode: "same_round_retry",
        contextReason: "enforcement_retry",
      },
      success: false,
      outcome: "partial",
      outputSummary: "bounded report",
      wrongAssumptions: ["old belief"],
      retractedConstraints: ["old rule"],
      openQuestions: ["still open?"],
      blocker: "needs input",
      contractTransition: {
        kind: "supersede",
        contract_id: "rc-12345678",
        reason: "route changed",
      },
    }));
    const [row] = replay.timeline("test");
    assert.equal(row?.context_mode, "same_round_retry");
    assert.equal(row?.context_reason, "enforcement_retry");
    assert.equal(row?.attempt, 1);
    assert.equal(row?.agent_success_claim, false);
    assert.equal(row?.agent_outcome, "partial");
    assert.equal(row?.machine_backed_success, false);
    assert.equal(
      (row?.report as Record<string, unknown>)?.output_summary,
      "bounded report",
    );
    assert.equal(
      (row?.report as Record<string, unknown>)?.blocker,
      "needs input",
    );
    assert.equal(
      (row?.report as Record<string, unknown>)?.truncated,
      false,
    );
    assert.equal(
      "success" in (row?.report as Record<string, unknown>),
      false,
      "the row's claim is not duplicated inside the report block",
    );
    assert.deepEqual(row?.wrong_assumptions, ["old belief"]);
    assert.deepEqual(row?.retracted_constraints, ["old rule"]);
    assert.deepEqual(row?.open_questions, ["still open?"]);
    assert.equal(row?.blocker, "needs input");
    assert.deepEqual(row?.contract_redirect, {
      kind: "supersede",
      contract_id: "rc-12345678",
      reason: "route changed",
    });
  });
});
