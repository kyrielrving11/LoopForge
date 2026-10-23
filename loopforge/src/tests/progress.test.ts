/** v3.9.9 — coverage-selected progress facts. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveObservationDeltas,
  isValidProgressSnapshot,
} from "../evidence-provider.js";
import type { ObservationDelta } from "../evidence-provider.js";
import {
  deriveRoundProgress,
  GIT_WORKSPACE_COVERAGE,
  STALL_PROGRESS_COVERAGE,
  type ProgressCoverageSelector,
} from "../progress.js";
import type {
  CustomObservation,
  GitObservation,
  MachineObservation,
  ProgressCoverage,
  ProgressSnapshot,
} from "../protocol.js";
import { normalizeSelfEvaluation } from "../self-eval.js";

const CUSTOM_COVERAGE: ProgressCoverage = {
  domain: "repository",
  object: "tracker-state",
  scope: "whole",
  version: 1,
};
const OTHER_COVERAGE: ProgressCoverage = {
  domain: "repository",
  object: "tracker-state",
  scope: "partial",
  version: 1,
};
const CUSTOM_SELECTOR: ProgressCoverageSelector = {
  kind: "custom",
  coverage: CUSTOM_COVERAGE,
};

function snapshot(
  char: string,
  coverage: ProgressCoverage = CUSTOM_COVERAGE,
  complete = true,
): ProgressSnapshot {
  return {
    schemaVersion: 2,
    coverage,
    complete,
    fingerprint: char.repeat(64),
  };
}

function failedSnapshot(coverage: ProgressCoverage = CUSTOM_COVERAGE): ProgressSnapshot {
  return { schemaVersion: 2, coverage, complete: false, fingerprint: null };
}

function custom(
  phase: "before" | "after",
  progress: ProgressSnapshot | null | undefined,
  status: CustomObservation["status"] = "observed",
  coverage: ProgressCoverage | undefined = CUSTOM_COVERAGE,
  providerId = "tracker",
): CustomObservation {
  return {
    schemaVersion: 1,
    providerId,
    kind: "custom",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      ...(coverage ? { progress } : {}),
    },
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

describe("v3.9.9 — coverage-selected custom progress", () => {
  it("compares fingerprints under an exact selector", () => {
    const changed = delta(
      [custom("before", snapshot("a"))],
      [custom("after", snapshot("b"))],
    );
    assert.equal(changed[0].progress?.state, "changed");
    assert.equal(
      deriveRoundProgress(changed, [CUSTOM_SELECTOR]).state,
      "changed",
    );

    const unchanged = delta(
      [custom("before", snapshot("a"))],
      [custom("after", snapshot("a"))],
    );
    assert.equal(unchanged[0].progress?.state, "unchanged");
    assert.equal(
      deriveRoundProgress(unchanged, [CUSTOM_SELECTOR]).state,
      "unchanged",
    );
  });

  it("never reads a missing, failed, or incomplete side as no progress", () => {
    const missingSide = delta([], [custom("after", snapshot("b"))]);
    assert.equal(missingSide[0].progress?.state, "unknown");
    assert.equal(deriveRoundProgress(missingSide, [CUSTOM_SELECTOR]).state, "unknown");

    const failedPair = delta(
      [custom("before", failedSnapshot(), "unavailable")],
      [custom("after", failedSnapshot(), "timeout")],
    );
    assert.equal(failedPair[0].progress?.state, "unknown");
    assert.equal(
      deriveRoundProgress(failedPair, [CUSTOM_SELECTOR]).state,
      "unknown",
      "two failed captures must remain unknown, never not_applicable",
    );

    const incomplete = delta(
      [custom("before", snapshot("a", CUSTOM_COVERAGE, false))],
      [custom("after", snapshot("a", CUSTOM_COVERAGE, false))],
    );
    assert.equal(incomplete[0].progress?.state, "unknown");
  });

  it("treats a coverage change as unknown, never as an empty change", () => {
    const deltas = delta(
      [custom("before", snapshot("a", CUSTOM_COVERAGE))],
      [custom("after", snapshot("a", OTHER_COVERAGE))],
    );
    assert.equal(deltas[0].progress?.state, "unknown");
    assert.match(deltas[0].progress?.detail ?? "", /coverage changed/);
    // The fact is keyed by the AFTER side's coverage. A rule selecting the
    // current (after) coverage sees an explicit unknown — never an empty
    // change; a rule selecting the now-stale before coverage simply has no
    // matching fact.
    assert.equal(
      deriveRoundProgress(deltas, [{ kind: "custom", coverage: OTHER_COVERAGE }]).state,
      "unknown",
    );
    assert.equal(
      deriveRoundProgress(deltas, [CUSTOM_SELECTOR]).state,
      "not_applicable",
    );
  });

  it("produces no fact for a provider that declared no coverage", () => {
    const deltas = delta(
      [custom("before", undefined, "observed", undefined)],
      [custom("after", undefined, "observed", undefined)],
    );
    assert.equal(deltas[0].progress, null);
    assert.equal(
      deriveRoundProgress(deltas, [CUSTOM_SELECTOR]).state,
      "not_applicable",
    );
  });

  it("is kind-gated: a custom provider cannot impersonate Git coverage", () => {
    const forged = delta(
      [custom("before", snapshot("a", GIT_WORKSPACE_COVERAGE))],
      [custom("after", snapshot("b", GIT_WORKSPACE_COVERAGE))],
    );
    assert.equal(deriveRoundProgress(forged, STALL_PROGRESS_COVERAGE).state,
      "not_applicable",
      "custom changed facts must not affect the Git-only stall rule");
    assert.equal(deriveRoundProgress(forged, "any").state, "changed",
      "display surfaces still see every fact");
  });

  it("requires EVERY selector: a missing required coverage is unknown", () => {
    const deltas = delta(
      [custom("before", snapshot("a"))],
      [custom("after", snapshot("a"))],
    );
    const bothRequired = [
      CUSTOM_SELECTOR,
      { kind: "custom" as const, coverage: OTHER_COVERAGE },
    ];
    assert.equal(deriveRoundProgress(deltas, bothRequired).state, "unknown",
      "a missing required coverage must never read as unchanged");
    assert.equal(deriveRoundProgress(deltas, [CUSTOM_SELECTOR]).state, "unchanged");
    assert.equal(deriveRoundProgress([], bothRequired).state, "not_applicable");
  });
});

describe("v3.9.9 — Git stays on its complete-boundary rule", () => {
  it("reports file changes, HEAD-only motion, unchanged, and unknown", () => {
    const fileChange = delta(
      [git("before", { "a.ts": "m:1" }, "aaa")],
      [git("after", { "a.ts": "m:2" }, "aaa")],
    );
    assert.equal(fileChange[0].progress?.state, "changed");
    assert.deepEqual(fileChange[0].progress?.coverage, GIT_WORKSPACE_COVERAGE);

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

    const unknown = delta(
      [git("before", {}, "aaa")],
      [git("after", {}, "aaa", "timeout")],
    );
    assert.equal(unknown[0].progress?.state, "unknown");
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

  it("ignores custom facts for the Git-only stall selector", () => {
    const combined = [
      ...delta(
        [git("before", {}, "aaa")],
        [git("after", {}, "aaa")],
      ),
      ...delta(
        [custom("before", snapshot("a"))],
        [custom("after", snapshot("b"))],
      ),
    ];
    assert.equal(deriveRoundProgress(combined, STALL_PROGRESS_COVERAGE).state,
      "unchanged",
      "a custom changed fact cannot prevent a Git stall");
    assert.equal(deriveRoundProgress(combined, "any").state, "changed");
  });

  it("command observations never produce a progress fact", () => {
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
    assert.equal(deriveRoundProgress(deltas, "any").state, "not_applicable");
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
});

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot validation
// ═══════════════════════════════════════════════════════════════════════════

describe("v3.9.9 — progress snapshot validation", () => {
  it("accepts inner schema 2 and rejects malformed declarations", () => {
    assert.equal(isValidProgressSnapshot(snapshot("a"), "observed"), true);
    assert.equal(isValidProgressSnapshot(
      { schemaVersion: 1, fingerprint: "a".repeat(64) }, "observed"), false);
    assert.equal(isValidProgressSnapshot(
      { ...snapshot("a"), coverage: { ...CUSTOM_COVERAGE, scope: " whole" } },
      "observed"), false, "untrimmed coverage is a different identity");
    assert.equal(isValidProgressSnapshot(
      { ...snapshot("a"), coverage: { ...CUSTOM_COVERAGE, version: 0 } },
      "observed"), false);
    assert.equal(isValidProgressSnapshot(
      { ...snapshot("a"), fingerprint: "NOTHEX" }, "observed"), false);
  });

  it("allows a null fingerprint only on a failed capture", () => {
    assert.equal(isValidProgressSnapshot(failedSnapshot(), "timeout"), true);
    assert.equal(isValidProgressSnapshot(failedSnapshot(), "observed"), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Collector
// ═══════════════════════════════════════════════════════════════════════════

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

function useProvider(name: string): void {
  setPolicyForTest({
    ...DEFAULT_POLICY,
    evidence: { providers: [name], timeout_ms: 1000, commands: [] },
  });
}

describe("v3.9.9 — progressCoverage collector", () => {
  it("persists the declared snapshot without a capability marker", async () => {
    let value = "a";
    registerEvidenceProvider("test-progress", () => ({
      name: "test-progress",
      kind: "custom",
      progressCoverage: CUSTOM_COVERAGE,
      capture: (context) => custom(
        context?.phase ?? "after",
        snapshot(value),
      ),
    }));
    useProvider("test-progress");
    try {
      const collector = EvidenceCollector.fromPolicy();
      const before = await collector.collectAsync({ phase: "before" });
      value = "b";
      const after = await collector.collectAsync({ phase: "after" });
      const beforeData = (before[0] as CustomObservation).data;
      assert.equal("progressCapable" in beforeData, false);
      assert.deepEqual(
        (beforeData.progress as ProgressSnapshot).coverage,
        CUSTOM_COVERAGE,
      );
      const deltas = deriveObservationDeltas(before, after);
      assert.equal(deltas[0].progress?.state, "changed");
      assert.equal(
        deriveRoundProgress(deltas, [CUSTOM_SELECTOR]).state,
        "changed",
      );
    } finally {
      unregisterEvidenceProvider("test-progress");
      resetPolicy();
    }
  });

  it("turns an observed observation without a snapshot into an explicit error", async () => {
    registerEvidenceProvider("test-progress-bad", () => ({
      name: "test-progress-bad",
      kind: "custom",
      progressCoverage: CUSTOM_COVERAGE,
      capture: (context) => ({
        schemaVersion: 1,
        providerId: "test-progress-bad",
        kind: "custom",
        phase: context?.phase ?? "after",
        startedAt: 0,
        finishedAt: 0,
        status: "observed",
        files: [],
        data: {},
      }),
    }));
    useProvider("test-progress-bad");
    try {
      const observations = await EvidenceCollector.fromPolicy()
        .collectAsync({ phase: "after" });
      assert.equal(observations[0].status, "error");
      assert.equal(observations[0].schemaVersion, 1,
        "custom observations keep base schema 1");
      const data = (observations[0] as CustomObservation).data;
      assert.equal("progressCapable" in data, false);
      assert.deepEqual(data.progress, failedSnapshot());
      assert.equal((data.progress as ProgressSnapshot).schemaVersion, 2,
        "the nested progress snapshot is inner schema 2");
    } finally {
      unregisterEvidenceProvider("test-progress-bad");
      resetPolicy();
    }
  });

  it("fills the declared coverage on a failed capture instead of dropping it", async () => {
    registerEvidenceProvider("test-progress-fail", () => ({
      name: "test-progress-fail",
      kind: "custom",
      progressCoverage: CUSTOM_COVERAGE,
      capture: () => {
        throw new Error("boom");
      },
    }));
    useProvider("test-progress-fail");
    try {
      const observations = await EvidenceCollector.fromPolicy()
        .collectAsync({ phase: "after" });
      assert.equal(observations[0].status, "error");
      const progress = (observations[0] as CustomObservation).data.progress;
      assert.deepEqual(progress, failedSnapshot());
      // Failed captures still produce an unknown fact, never a missing one.
      const deltas = deriveObservationDeltas(observations, observations);
      assert.equal(deltas[0].progress?.state, "unknown");
    } finally {
      unregisterEvidenceProvider("test-progress-fail");
      resetPolicy();
    }
  });

  it("rejects the retired progressCapable marker", async () => {
    registerEvidenceProvider("test-progress-legacy", () => ({
      name: "test-progress-legacy",
      kind: "custom",
      // A live provider still emitting the retired marker. The fixture is
      // deliberately untyped so it can carry the prohibited field.
      capture: (context) => ({
        schemaVersion: 1,
        providerId: "test-progress-legacy",
        kind: "custom",
        phase: context?.phase ?? "after",
        startedAt: 0,
        finishedAt: 0,
        status: "observed",
        files: [],
        data: {
          progressCapable: true,
          progress: { schemaVersion: 1, fingerprint: "a".repeat(64) },
        },
      } as unknown as CustomObservation),
    }));
    useProvider("test-progress-legacy");
    try {
      const observations = await EvidenceCollector.fromPolicy()
        .collectAsync({ phase: "after" });
      assert.equal(observations[0].status, "error");
      assert.equal(
        "progressCapable" in (observations[0] as CustomObservation).data,
        false,
        "a prohibited field must never be written into history",
      );
    } finally {
      unregisterEvidenceProvider("test-progress-legacy");
      resetPolicy();
    }
  });

  it("rejects a snapshot whose coverage differs from the declaration", async () => {
    registerEvidenceProvider("test-progress-mismatch", () => ({
      name: "test-progress-mismatch",
      kind: "custom",
      progressCoverage: CUSTOM_COVERAGE,
      capture: (context) => custom(
        context?.phase ?? "after",
        snapshot("a", OTHER_COVERAGE),
      ),
    }));
    useProvider("test-progress-mismatch");
    try {
      const observations = await EvidenceCollector.fromPolicy()
        .collectAsync({ phase: "after" });
      assert.equal(observations[0].status, "error");
      assert.deepEqual(
        (observations[0] as CustomObservation).data.progress,
        failedSnapshot(),
      );
    } finally {
      unregisterEvidenceProvider("test-progress-mismatch");
      resetPolicy();
    }
  });
});
