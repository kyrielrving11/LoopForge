/** v4.0.1 — machine progress is the Git workspace fact only. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveObservationDeltas,
} from "../evidence-provider.js";
import type { ObservationDelta } from "../evidence-provider.js";
import {
  deriveRoundProgress,
  deriveProgressWindow,
  GIT_WORKSPACE_COVERAGE,
} from "../progress.js";
import type {
  CustomObservation,
  GitObservation,
  MachineObservation,
} from "../protocol.js";
import { normalizeSelfEvaluation } from "../self-eval.js";
import {
  EvidenceCollector,
  registerEvidenceProvider,
  unregisterEvidenceProvider,
} from "../evidence-provider.js";
import {
  DEFAULT_POLICY,
  resetPolicy,
  setPolicyForTest,
} from "../policy.js";

function custom(
  phase: "before" | "after",
  data: Record<string, unknown> = {},
  providerId = "tracker",
): CustomObservation {
  return {
    schemaVersion: 1,
    providerId,
    kind: "custom",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files: [],
    data,
  };
}

function git(
  phase: "before" | "after",
  files: Record<string, string>,
  head: string,
  status: GitObservation["status"] = "observed",
): GitObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status,
    files: Object.keys(files),
    data: {
      dirty: [],
      fingerprints: files,
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

function delta(
  before: MachineObservation[],
  after: MachineObservation[],
): ObservationDelta[] {
  return deriveObservationDeltas(before, after);
}

describe("Git workspace progress", () => {
  it("reports file changes, HEAD-only motion, unchanged, and unknown", () => {
    const fileChange = delta(
      [git("before", { "a.ts": "m:1" }, "aaa")],
      [git("after", { "a.ts": "m:2" }, "aaa")],
    );
    assert.equal(fileChange[0].progress?.state, "changed");
    assert.deepEqual(fileChange[0].progress?.coverage, GIT_WORKSPACE_COVERAGE);
    assert.equal(deriveRoundProgress(fileChange).state, "changed");

    const headOnly = delta(
      [git("before", {}, "aaa")],
      [git("after", {}, "bbb")],
    );
    assert.equal(headOnly[0].progress?.state, "changed");

    const unchanged = delta(
      [git("before", { "a.ts": "m:1" }, "aaa")],
      [git("after", { "a.ts": "m:1" }, "aaa")],
    );
    assert.equal(unchanged[0].progress?.state, "unchanged");
    assert.equal(deriveRoundProgress(unchanged).state, "unchanged");

    const unknown = delta(
      [git("before", {}, "aaa")],
      [git("after", {}, "aaa", "timeout")],
    );
    assert.equal(unknown[0].progress?.state, "unknown");
    assert.equal(deriveRoundProgress(unknown).state, "unknown");
  });

  it("derives the fact coverage from the persisted observation", () => {
    const deltas = delta(
      [git("before", {}, "aaa")],
      [git("after", {}, "bbb")],
    );
    assert.deepEqual(deltas[0].progress?.coverage, {
      domain: "workspace",
      object: "git-motion",
      scope: "tracked_and_non_ignored_untracked",
      version: 2,
    });
  });

  it("ignores custom and command observations completely", () => {
    const customDeltas = delta(
      [custom("before", { progress: { fingerprint: "a".repeat(64) } })],
      [custom("after", { progress: { fingerprint: "b".repeat(64) } })],
    );
    assert.equal(customDeltas[0].progress, null);
    assert.equal(deriveRoundProgress(customDeltas).state, "not_applicable");

    const command = (phase: "before" | "after"): MachineObservation => ({
      schemaVersion: 1,
      providerId: "command:verify",
      kind: "command",
      phase,
      startedAt: 0,
      finishedAt: 0,
      status: "passed",
      files: [],
      data: {
        commandId: "verify",
        argv: [],
        cwd: ".",
        configHash: "h",
        required: false,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutSha256: "",
        stderrSha256: "",
        stdoutExcerpt: "",
        stderrExcerpt: "",
        truncated: false,
        entrypointFiles: [],
      },
    });
    const deltas = delta([command("before")], [command("after")]);
    assert.equal(deltas[0].progress, null);
    assert.equal(deriveRoundProgress(deltas).state, "not_applicable");
  });

  it("does not let an Agent report create progress", () => {
    const normalized = normalizeSelfEvaluation({
      success: false,
      output_summary: "nothing",
      constraint_violations: [],
      should_continue: true,
      progress: "changed",
    });
    assert.equal("progress" in normalized.evaluation, false);
    assert.ok(normalized.diagnostics.some((entry) => entry.path === "progress"));
  });

  it("a custom provider's data.progress is an opaque report, not a fact", async () => {
    registerEvidenceProvider("test-custom-report", () => ({
      name: "test-custom-report",
      kind: "custom",
      capture: (context) => custom(
        context?.phase ?? "after",
        { progress: { schemaVersion: 2, fingerprint: "a".repeat(64) } },
      ),
    }));
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: { providers: ["test-custom-report"], timeout_ms: 1000, commands: [] },
    });
    try {
      const before = await EvidenceCollector.fromPolicy()
        .collectAsync({ phase: "before" });
      const after = await EvidenceCollector.fromPolicy()
        .collectAsync({ phase: "after" });
      assert.equal(before[0].status, "observed");
      assert.equal(after[0].status, "observed");
      const deltas = deriveObservationDeltas(before, after);
      assert.equal(deltas[0].progress, null);
      assert.equal(deriveRoundProgress(deltas).state, "not_applicable");
    } finally {
      unregisterEvidenceProvider("test-custom-report");
      resetPolicy();
    }
  });
});

describe("progress window", () => {
  it("marks a missing round unknown, never unchanged", () => {
    const view = {
      round: 1,
      observationDelta: delta(
        [git("before", {}, "aaa")],
        [git("after", {}, "aaa")],
      ),
    } as unknown as import("../committed-round.js").CommittedRoundView;
    const window = deriveProgressWindow([view], 3, 2);
    assert.equal(window.incomplete, true);
    assert.equal(window.state, "unknown");

    const complete = deriveProgressWindow([view], 2, 1);
    assert.equal(complete.incomplete, false);
    assert.equal(complete.state, "unchanged");
  });
});
