/** The derived before→after delta: one provider entry, one change set.
 *
 * `changedFiles` is the only file-change fact. Raw observations keep their own
 * observation-local `files`; unknown boundaries are null and never collapse
 * into an observed empty set.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  afterObservations,
  deriveObservationDeltas,
  gitDeltaState,
  isPassedAfterObservation,
} from "../evidence-provider.js";
import type {
  CommandObservation,
  CustomObservation,
  GitObservation,
  MachineObservation,
} from "../protocol.js";
import { gitState } from "./_helpers.js";

function git(
  phase: "before" | "after",
  files: string[],
  fingerprints: Record<string, string>,
  status: GitObservation["status"] = "observed",
  head?: string,
): GitObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status,
    files,
    data: {
      dirty: files,
      fingerprints,
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

function command(status: CommandObservation["status"] = "passed"): CommandObservation {
  return {
    schemaVersion: 1,
    providerId: "command:test",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      commandId: "test",
      argv: ["node", "-e", "process.exit(0)"],
      cwd: ".",
      configHash: "0".repeat(64),
      required: false,
      exitCode: status === "passed" ? 0 : 1,
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
}

function custom(providerId = "custom:one"): CustomObservation {
  return {
    schemaVersion: 1,
    providerId,
    kind: "custom",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files: ["display-only.txt"],
    data: {},
  };
}

describe("deriveObservationDeltas — Git change sets", () => {
  it("computes the fingerprint diff and preserves raw references", () => {
    const before = git("before", ["a.ts", "b.ts"], { "a.ts": "m:1", "b.ts": "m:1" }, "observed", "h0");
    const after = git("after", [], { "a.ts": "m:2", "c.ts": "m:1" }, "observed", "h1");
    const deltas = deriveObservationDeltas([before], [after]);
    assert.equal(deltas.length, 1);
    assert.deepEqual(deltas[0].changedFiles, ["a.ts", "b.ts", "c.ts"]);
    assert.equal(deltas[0].before, before);
    assert.equal(deltas[0].after, after);
    assert.deepEqual(after.files, [], "the raw observation is never mutated");
  });

  it("returns [] when both observed fingerprint maps match", () => {
    const before = git("before", ["a.ts"], { "a.ts": "same" });
    const after = git("after", ["a.ts"], { "a.ts": "same" });
    assert.deepEqual(deriveObservationDeltas([before], [after])[0].changedFiles, []);
  });

  it("keeps a clean-worktree committed change visible", () => {
    // The worktree is clean after the commit, so the raw after `files` list is
    // empty. The complete boundary fingerprints are what prove the change.
    const before = git("before", [], { "a.ts": "v1" });
    const after = git("after", [], { "a.ts": "v2" });
    const delta = deriveObservationDeltas([before], [after])[0];
    assert.deepEqual(after.files, []);
    assert.deepEqual(delta.changedFiles, ["a.ts"]);
  });

  it("returns null for a missing side and keeps before-only entries", () => {
    const beforeOnly = git("before", ["a.ts"], { "a.ts": "v1" });
    beforeOnly.providerId = "git:old";
    const afterOnly = git("after", ["b.ts"], { "b.ts": "v1" });
    afterOnly.providerId = "git:new";
    const deltas = deriveObservationDeltas([beforeOnly], [afterOnly]);
    assert.equal(deltas.length, 2);
    for (const delta of deltas) {
      assert.equal(delta.changedFiles, null);
      assert.equal(delta.before === null || delta.after === null, true);
    }
  });

  it("returns null for every non-observed boundary status", () => {
    for (const status of ["unavailable", "timeout", "error", "aborted"] as const) {
      const before = git("before", ["a.ts"], { "a.ts": "v1" });
      const after = git("after", [], { "a.ts": "v2" }, status);
      assert.equal(
        deriveObservationDeltas([before], [after])[0].changedFiles,
        null,
        status,
      );
    }
  });

  it("returns null when either fingerprint map is malformed", () => {
    const valid = git("before", ["a.ts"], { "a.ts": "v1" });
    const nonString = git("after", [], { "a.ts": 1 as unknown as string });
    assert.equal(deriveObservationDeltas([valid], [nonString])[0].changedFiles, null);

    const arrayMap = git("after", [], [] as unknown as Record<string, string>);
    assert.equal(deriveObservationDeltas([valid], [arrayMap])[0].changedFiles, null);
  });

  it("treats duplicate provider keys as ambiguous", () => {
    const before = git("before", ["a.ts"], { "a.ts": "v1" });
    const after = git("after", ["a.ts"], { "a.ts": "v2" });
    const secondAfter = git("after", ["b.ts"], { "b.ts": "v1" });
    const deltas = deriveObservationDeltas([before], [after, secondAfter]);
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].changedFiles, null);
  });

  it("keeps the same provider id under different kinds distinct", () => {
    const gitObs = git("after", ["a.ts"], { "a.ts": "v1" });
    const customObs = custom("git");
    const deltas = deriveObservationDeltas([], [gitObs, customObs]);
    assert.equal(deltas.length, 2);
    assert.equal(deltas.filter((delta) => delta.kind === "git").length, 1);
    assert.equal(deltas.filter((delta) => delta.kind === "custom").length, 1);
  });

  it("orders kinds and provider ids deterministically", () => {
    const observations: MachineObservation[] = [
      custom("custom:b"),
      command(),
      custom("custom:a"),
      git("after", [], {}),
    ];
    const first = deriveObservationDeltas([], observations);
    const second = deriveObservationDeltas([], [...observations].reverse());
    assert.deepEqual(
      first.map((delta) => `${delta.kind}:${delta.providerId}`),
      second.map((delta) => `${delta.kind}:${delta.providerId}`),
    );
    assert.deepEqual(
      first.map((delta) => delta.kind),
      ["git", "command", "custom", "custom"],
    );
    assert.deepEqual(
      first.filter((delta) => delta.kind === "custom").map((delta) => delta.providerId),
      ["custom:a", "custom:b"],
    );
  });
});

describe("deriveObservationDeltas — non-Git providers", () => {
  it("never attributes a file-change set to command or custom providers", () => {
    const deltas = deriveObservationDeltas([], [command(), custom()]);
    assert.equal(deltas.length, 2);
    for (const delta of deltas) {
      assert.equal(delta.changedFiles, null);
    }
    assert.equal(deltas.find((delta) => delta.kind === "command")?.after?.kind, "command");
  });

  it("exposes the raw after observations", () => {
    const cmd = command();
    const deltas = deriveObservationDeltas([], [cmd]);
    assert.equal(afterObservations(deltas)[0], cmd);
  });
});

describe("gitDeltaState — applicability vs observability", () => {
  it("is not_applicable when no Git provider participated", () => {
    assert.deepEqual(gitDeltaState(deriveObservationDeltas([], [command()])), {
      state: "not_applicable",
    });
  });

  it("is unknown when a Git delta cannot be compared", () => {
    const delta = deriveObservationDeltas(
      [git("before", ["a.ts"], { "a.ts": "v1" })],
      [git("after", [], { "a.ts": "v2" }, "timeout")],
    )[0];
    assert.deepEqual(gitDeltaState([delta]), { state: "unknown" });
  });

  it("unions observed Git change sets", () => {
    const delta = deriveObservationDeltas(
      [git("before", [], { "a.ts": "v1" })],
      [git("after", [], { "a.ts": "v2", "b.ts": "v1" })],
    )[0];
    assert.deepEqual(gitDeltaState([delta]), {
      state: "observed",
      changedFiles: new Set(["a.ts", "b.ts"]),
    });
  });

  it("distinguishes observed-no-change from unknown", () => {
    const delta = deriveObservationDeltas(
      [git("before", [], { "a.ts": "same" })],
      [git("after", [], { "a.ts": "same" })],
    )[0];
    assert.deepEqual(gitDeltaState([delta]), {
      state: "observed",
      changedFiles: new Set(),
    });
  });
});

describe("isPassedAfterObservation — tri-state entrypoint arm", () => {
  it("is not applicable when Git never participated", () => {
    assert.equal(isPassedAfterObservation(command("passed"), gitState()), true);
  });

  it("does not verify a passed command when Git is applicable but unknown", () => {
    assert.equal(isPassedAfterObservation(command("passed"), gitState(null)), false);
  });

  it("rejects an observed entrypoint change", () => {
    const observation = command("passed");
    observation.data.entrypointFiles = ["package.json"];
    assert.equal(
      isPassedAfterObservation(observation, gitState(["package.json"])),
      false,
    );
    assert.equal(
      isPassedAfterObservation(observation, gitState(["src/a.ts"])),
      true,
    );
  });
});
