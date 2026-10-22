/** v3.9.7 — provider-neutral progress derivation. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveObservationDeltas } from "../evidence-provider.js";
import { deriveRoundProgress } from "../progress.js";
import type {
  CustomObservation,
  GitObservation,
  MachineObservation,
  ProgressSnapshot,
} from "../protocol.js";
import { normalizeSelfEvaluation } from "../self-eval.js";

const fingerprint = (char: string): ProgressSnapshot => ({
  schemaVersion: 1,
  fingerprint: char.repeat(64),
});

function custom(
  phase: "before" | "after",
  progress: ProgressSnapshot | null,
  status: CustomObservation["status"] = "observed",
): CustomObservation {
  return {
    schemaVersion: 1,
    providerId: "tracker",
    kind: "custom",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: { progressCapable: true, progress },
  };
}

function git(
  phase: "before" | "after",
  files: Record<string, string>,
  head: string,
): GitObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
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
) {
  return deriveObservationDeltas(before, after);
}

describe("v3.9.7 — provider-neutral progress", () => {
  it("compares a custom provider's persisted fingerprints", () => {
    const changed = delta([custom("before", fingerprint("a"))], [custom("after", fingerprint("b"))]);
    assert.equal(changed[0].progress, "changed");
    assert.equal(deriveRoundProgress(changed).state, "changed");

    const unchanged = delta([custom("before", fingerprint("a"))], [custom("after", fingerprint("a"))]);
    assert.equal(unchanged[0].progress, "unchanged");
    assert.equal(deriveRoundProgress(unchanged).state, "unchanged");
  });

  it("never reads a missing/unobservable custom snapshot as no progress", () => {
    const missingSide = delta([], [custom("after", fingerprint("b"))]);
    assert.equal(missingSide[0].progress, "unknown");
    assert.equal(deriveRoundProgress(missingSide).state, "unknown");

    const unavailable = delta(
      [custom("before", null)],
      [custom("after", null, "unavailable")],
    );
    assert.equal(unavailable[0].progress, "unknown");
    assert.equal(deriveRoundProgress(unavailable).state, "unknown");

    const noCapability = delta(
      [{ ...custom("before", null), data: {} }],
      [{ ...custom("after", null), data: {} }],
    );
    assert.equal(noCapability[0].progress, "not_applicable");
    assert.equal(deriveRoundProgress(noCapability).state, "not_applicable");
  });

  it("keeps Git on its complete-boundary rule and combines providers", () => {
    const gitUnchanged = delta(
      [git("before", { "a.ts": "m:1" }, "aaa")],
      [git("after", { "a.ts": "m:1" }, "aaa")],
    );
    assert.equal(deriveRoundProgress(gitUnchanged).state, "unchanged");

    const combined = [
      ...gitUnchanged,
      ...delta([custom("before", fingerprint("a"))], [custom("after", fingerprint("b"))]),
    ];
    assert.equal(deriveRoundProgress(combined).state, "changed");
    assert.deepEqual(deriveRoundProgress(combined).providers, ["git", "tracker"]);
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
// Collector: capability is persisted, malformed snapshots become errors
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

describe("v3.9.7 — progress-capable collector", () => {
  it("persists progressCapable and compares fingerprints across phases", async () => {
    let value = "a";
    registerEvidenceProvider("test-progress", () => ({
      name: "test-progress",
      kind: "custom",
      progressCapable: true,
      capture: (context) => custom(
        context?.phase ?? "after",
        fingerprint(value === "a" ? "a" : "b"),
      ),
    }));
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: { providers: ["test-progress"], timeout_ms: 1000, commands: [] },
    });
    try {
      const collector = EvidenceCollector.fromPolicy();
      const before = await collector.collectAsync({ phase: "before" });
      value = "b";
      const after = await collector.collectAsync({ phase: "after" });
      assert.equal(
        (before[0] as CustomObservation).data.progressCapable,
        true,
      );
      const deltas = deriveObservationDeltas(before, after);
      assert.equal(deltas[0].progress, "changed");
      assert.equal(deriveRoundProgress(deltas).state, "changed");
    } finally {
      unregisterEvidenceProvider("test-progress");
      resetPolicy();
    }
  });

  it("turns an observed observation without a valid snapshot into an error", async () => {
    registerEvidenceProvider("test-progress-bad", () => ({
      name: "test-progress-bad",
      kind: "custom",
      progressCapable: true,
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
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: { providers: ["test-progress-bad"], timeout_ms: 1000, commands: [] },
    });
    try {
      const observations = await EvidenceCollector.fromPolicy()
        .collectAsync({ phase: "after" });
      assert.equal(observations[0].status, "error");
      assert.equal(
        (observations[0] as CustomObservation).data.progressCapable,
        true,
      );
      assert.equal(
        (observations[0] as CustomObservation).data.progress,
        null,
      );
    } finally {
      unregisterEvidenceProvider("test-progress-bad");
      resetPolicy();
    }
  });
});
