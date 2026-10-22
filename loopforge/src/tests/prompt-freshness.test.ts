/** 3.9.3 — prompt freshness is a pure fact about the committed round. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeRound,
  type CommittedRoundView,
} from "../committed-round.js";
import {
  derivePromptFreshness,
  UNKNOWN_PROMPT_FRESHNESS,
} from "../prompt-freshness.js";
import type { MachineObservation } from "../protocol.js";
import { withTransaction } from "./_helpers.js";

const FINGERPRINTS_EMPTY = {};

function gitObservation(
  phase: "before" | "after",
  fingerprints: Record<string, string>,
  head: string,
  status: "observed" | "timeout" | "error" | "unavailable" = "observed",
): MachineObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      dirty: [],
      fingerprints,
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  } as MachineObservation;
}

function commandObservation(
  status: "passed" | "failed" | "timeout" | "aborted" | "error" | "unavailable",
): MachineObservation {
  return {
    schemaVersion: 1,
    providerId: "command:verify",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      commandId: "verify",
      argv: [],
      cwd: ".",
      configHash: "hash",
      required: true,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdoutSha256: "",
      stderrSha256: "",
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
    },
  } as MachineObservation;
}

function committedView(input: {
  before?: MachineObservation[];
  after?: MachineObservation[];
  success?: boolean;
  /** Extra top-level evaluation fields understood by withTransaction. */
  evaluation?: Record<string, unknown>;
}): CommittedRoundView {
  const entry = withTransaction({
    loop_id: "freshness",
    loop_lineage: {
      loop_id: "freshness",
      round: 1,
      constraints_active: [],
      committed_action: "continue",
    },
    success: input.success ?? false,
    ...(input.evaluation ?? {}),
  }, "continue", {
    beforeEvidence: input.before ?? [],
    afterEvidence: input.after ?? [],
  });
  const view = decodeRound(entry);
  assert.ok(view, "fixture must decode to a committed round");
  return view;
}

describe("derivePromptFreshness", () => {
  it("treats observed content changes as fresh motion", () => {
    const view = committedView({
      before: [gitObservation("before", { "a.ts": "m:1" }, "aaa")],
      after: [gitObservation("after", { "a.ts": "m:2" }, "aaa")],
    });
    const freshness = derivePromptFreshness(view);
    assert.equal(freshness.machineMotion, true);
    assert.equal(freshness.observableNewInformation, true);
    assert.ok(freshness.reasons.includes("git_content_changed"));
  });

  it("treats a clean-worktree HEAD move as motion", () => {
    const view = committedView({
      before: [gitObservation("before", FINGERPRINTS_EMPTY, "aaa")],
      after: [gitObservation("after", FINGERPRINTS_EMPTY, "bbb")],
    });
    const freshness = derivePromptFreshness(view);
    assert.equal(freshness.machineMotion, true);
    assert.equal(freshness.observableNewInformation, true);
    assert.ok(freshness.reasons.includes("git_head_moved"));
  });

  it("treats attributable after-phase commands as activity", () => {
    for (const status of ["passed", "failed", "timeout", "aborted", "error"] as const) {
      const freshness = derivePromptFreshness(committedView({
        after: [commandObservation(status)],
      }));
      assert.equal(freshness.machineActivity, true, status);
      assert.equal(freshness.observableNewInformation, true, status);
      assert.ok(freshness.reasons.includes("after_command_activity"), status);
    }
  });

  it("does not treat an unavailable command as activity", () => {
    const freshness = derivePromptFreshness(committedView({
      after: [commandObservation("unavailable")],
    }));
    assert.equal(freshness.machineActivity, false);
  });

  it("treats a missing Git provider as unknown, not as no change", () => {
    const freshness = derivePromptFreshness(committedView({}));
    assert.equal(freshness.machineMotion, null);
    assert.equal(freshness.observableNewInformation, true);
    assert.ok(freshness.reasons.includes("no_git_provider"));
  });

  it("treats an uncomparable Git boundary as unknown", () => {
    const freshness = derivePromptFreshness(committedView({
      before: [gitObservation("before", FINGERPRINTS_EMPTY, "aaa")],
      after: [gitObservation("after", FINGERPRINTS_EMPTY, "aaa", "timeout")],
    }));
    assert.equal(freshness.machineMotion, null);
    assert.equal(freshness.observableNewInformation, true);
    assert.ok(freshness.reasons.includes("git_boundary_unknown"));
  });

  it("proves staleness only for an observed no-change with no other activity", () => {
    const freshness = derivePromptFreshness(committedView({
      before: [gitObservation("before", FINGERPRINTS_EMPTY, "aaa")],
      after: [gitObservation("after", FINGERPRINTS_EMPTY, "aaa")],
    }));
    assert.equal(freshness.machineMotion, false);
    assert.equal(freshness.observableNewInformation, false);
    assert.deepEqual(freshness.reasons, ["no_observable_activity"]);
  });

  it("does not let an Agent-reported files_changed prove freshness", () => {
    const freshness = derivePromptFreshness(committedView({
      before: [gitObservation("before", FINGERPRINTS_EMPTY, "aaa")],
      after: [gitObservation("after", FINGERPRINTS_EMPTY, "aaa")],
      evaluation: {
        execution_report: {
          files_changed: ["reported.ts"],
          tests_reported: { passed: 1, failed: 0, skipped: 0 },
        },
      },
    }));
    assert.equal(freshness.observableNewInformation, false,
      "a report cannot turn observed no-change into new information");
  });

  it("treats every committed semantic declaration as evolution", () => {
    const declarations: Array<Record<string, unknown>> = [
      { discovered_constraints: ["a limit"] },
      { objective_refinement: "a deeper understanding" },
      { emerged_subtasks: ["a new sub-problem"] },
      { subgoal_updates: [{ id: "sg-00000000", status: "in_progress" }] },
      { retracted_constraints: ["an old constraint"] },
      { wrong_assumptions: ["a falsified assumption"] },
      { worker_results: [{
        agentId: "w1",
        subTask: "scan",
        resultSummary: "found it",
        outcome: "success",
      }] },
      { round_contract: {
        work_item: "slice",
        scope: [],
        items: [{
          description: "outcome",
          criterion_refs: [],
          subgoal_refs: [],
          verify_with: ["verify"],
        }],
      } },
      { compression_checkpoint: true },
    ];
    for (const evaluation of declarations) {
      const freshness = derivePromptFreshness(committedView({
        before: [gitObservation("before", FINGERPRINTS_EMPTY, "aaa")],
        after: [gitObservation("after", FINGERPRINTS_EMPTY, "aaa")],
        evaluation,
      }));
      assert.equal(freshness.declaredEvolution, true,
        JSON.stringify(evaluation));
      assert.equal(freshness.observableNewInformation, true,
        JSON.stringify(evaluation));
      assert.ok(freshness.reasons.includes("declared_evolution"),
        JSON.stringify(evaluation));
    }
  });

  it("is deterministic for the same committed round", () => {
    const view = committedView({
      before: [gitObservation("before", { "a.ts": "m:1" }, "aaa")],
      after: [gitObservation("after", { "a.ts": "m:2" }, "bbb")],
    });
    assert.deepEqual(derivePromptFreshness(view), derivePromptFreshness(view));
  });

  it("returns the unknown sentinel when there is no committed round", () => {
    assert.equal(UNKNOWN_PROMPT_FRESHNESS.observableNewInformation, true);
    assert.equal(UNKNOWN_PROMPT_FRESHNESS.machineMotion, null);
    assert.deepEqual(UNKNOWN_PROMPT_FRESHNESS.reasons, ["no_previous_committed_round"]);
  });
});
