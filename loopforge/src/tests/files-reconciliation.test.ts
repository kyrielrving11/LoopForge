/** v3.9.2 — the ONE reported-vs-observed files reconciliation. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveFilesReconciliation,
} from "../files-reconciliation.js";
import type { ObservationDelta } from "../evidence-provider.js";

function gitDelta(changedFiles: string[] | null): ObservationDelta {
  return {
    providerId: "git",
    kind: "git",
    before: null,
    after: null,
    changedFiles,
  };
}

function report(files_changed: string[]) {
  return { files_changed };
}

describe("deriveFilesReconciliation — matching", () => {
  it("matches identical sets regardless of order", () => {
    const result = deriveFilesReconciliation(
      report(["b.ts", "a.ts"]),
      [gitDelta(["a.ts", "b.ts"])],
    );
    assert.equal(result.status, "match");
    assert.deepEqual(result.reported, ["b.ts", "a.ts"], "reported keeps first-seen order");
    assert.deepEqual(result.observed, ["a.ts", "b.ts"], "observed is sorted");
    assert.deepEqual(result.unreported, []);
    assert.deepEqual(result.unconfirmed, []);
    assert.equal(result.scope, "tracked_and_non_ignored_untracked");
  });

  it("matches two empty sets", () => {
    const result = deriveFilesReconciliation(
      report([]),
      [gitDelta([])],
      { attempted: true },
    );
    assert.equal(result.status, "match");
    assert.deepEqual(result.observed, []);
  });

  it("collapses duplicate reported paths for the status", () => {
    const result = deriveFilesReconciliation(
      report(["a.ts", "a.ts"]),
      [gitDelta(["a.ts"])],
    );
    assert.equal(result.status, "match");
    assert.deepEqual(result.reported, ["a.ts", "a.ts"], "duplicates remain visible");
    assert.deepEqual(result.unconfirmed, []);
  });
});

describe("deriveFilesReconciliation — mismatches", () => {
  it("reports only missed files", () => {
    const result = deriveFilesReconciliation(
      report(["a.ts"]),
      [gitDelta(["a.ts", "b.ts"])],
    );
    assert.equal(result.status, "mismatch");
    assert.deepEqual(result.unreported, ["b.ts"]);
    assert.deepEqual(result.unconfirmed, []);
  });

  it("reports only ghost files", () => {
    const result = deriveFilesReconciliation(
      report(["a.ts", "b.ts"]),
      [gitDelta(["a.ts"])],
    );
    assert.equal(result.status, "mismatch");
    assert.deepEqual(result.unreported, []);
    assert.deepEqual(result.unconfirmed, ["b.ts"]);
  });

  it("reports both directions", () => {
    const result = deriveFilesReconciliation(
      report(["ghost.ts", "a.ts"]),
      [gitDelta(["a.ts", "missed.ts"])],
    );
    assert.equal(result.status, "mismatch");
    assert.deepEqual(result.unreported, ["missed.ts"]);
    assert.deepEqual(result.unconfirmed, ["ghost.ts"]);
  });

  it("treats an omitted report with observed changes as a mismatch", () => {
    const result = deriveFilesReconciliation(
      null,
      [gitDelta(["a.ts"])],
      { attempted: false },
    );
    assert.equal(result.status, "mismatch");
    assert.equal(result.attempted, false);
    assert.deepEqual(result.reported, []);
    assert.deepEqual(result.unreported, ["a.ts"]);
  });

  it("treats an omitted report with no changes as not applicable", () => {
    const result = deriveFilesReconciliation(
      null,
      [gitDelta([])],
      { attempted: false },
    );
    assert.equal(result.status, "not_applicable");
    assert.equal(result.attempted, false);
    assert.deepEqual(result.observed, []);
  });
});

describe("deriveFilesReconciliation — unknown and not applicable", () => {
  it("returns unknown without manufacturing an empty set", () => {
    const result = deriveFilesReconciliation(
      report(["a.ts"]),
      [gitDelta(null)],
      { attempted: true },
    );
    assert.equal(result.status, "unknown");
    assert.equal(result.observed, null);
    assert.deepEqual(result.unreported, []);
    assert.deepEqual(result.unconfirmed, []);
  });

  it("returns not_applicable when no Git provider participated", () => {
    const result = deriveFilesReconciliation(report(["a.ts"]), []);
    assert.equal(result.status, "not_applicable");
    assert.equal(result.observed, null);
  });

  it("unions multiple Git deltas", () => {
    const result = deriveFilesReconciliation(
      report(["a.ts", "b.ts"]),
      [gitDelta(["a.ts"]), gitDelta(["b.ts"])],
    );
    assert.equal(result.status, "match");
    assert.deepEqual(result.observed, ["a.ts", "b.ts"]);
  });
});

describe("deriveFilesReconciliation — exact path semantics", () => {
  it("does not normalize separators or leading ./", () => {
    const result = deriveFilesReconciliation(
      report(["src\\a.ts", "./src/b.ts"]),
      [gitDelta(["src/a.ts", "src/b.ts"])],
    );
    assert.equal(result.status, "mismatch");
    assert.deepEqual(result.unreported, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(result.unconfirmed, ["./src/b.ts", "src\\a.ts"]);
  });
});
