/** Tests for token-utils — content-addressed ids, normalization, dedup, and
 *  entry helpers. v3.8.1 deleted `tokenize` / `jaccardSimilarity` and their
 *  tests with them; `normalizeText` is now the identity primitive the
 *  criterion / constraint / emphasize matchers are built on, so it is
 *  covered here. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  entryRound,
  normalizeText,
  unique,
} from "../token-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// normalizeText — the identity primitive for text-only references
// ═══════════════════════════════════════════════════════════════════════════

describe("normalizeText", () => {
  it("folds whitespace and case so restatements are equal", () => {
    assert.equal(
      normalizeText("Unit  test coverage at 90%"),
      normalizeText("unit test coverage at 90%"),
    );
  });

  it("does NOT fold wording — a paraphrase is a different string", () => {
    // This is the point of the v3.8.1 change: criteriaMatch,
    // matchesConstraintText and matchEmphasize all compare with this, so a
    // near-miss must compare unequal. These two strings used to score >= 0.4
    // by Jaccard and count as the same criterion.
    assert.notEqual(
      normalizeText("unit test coverage at 90 percent"),
      normalizeText("unit test coverage reached 90%"),
    );
  });

  it("trims the ends", () => {
    assert.equal(normalizeText("  spaced  "), "spaced");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// unique
// ═══════════════════════════════════════════════════════════════════════════

describe("unique", () => {
  it("removes duplicates", () => {
    assert.deepEqual(unique(["a", "b", "a", "c"]), ["a", "b", "c"]);
  });

  it("filters null and undefined", () => {
    assert.deepEqual(unique(["a", null, "b", undefined, "c"]), ["a", "b", "c"]);
  });

  it("trims whitespace", () => {
    assert.deepEqual(unique(["  a ", "b  "]), ["a", "b"]);
  });

  it("filters empty strings after trim", () => {
    assert.deepEqual(unique(["a", "  ", ""]), ["a"]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(unique([]), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// entryRound
// ═══════════════════════════════════════════════════════════════════════════

describe("entryRound", () => {
  it("reads round from loop_lineage", () => {
    const entry = { loop_lineage: { round: 5 } };
    assert.equal(entryRound(entry), 5);
  });

  it("returns 0 when the legacy top-level lineage alias is used", () => {
    // v3.7: the legacy `lineage` alias was removed — only loop_lineage counts.
    const entry = { lineage: { round: 3 } };
    assert.equal(entryRound(entry), 0);
  });

  it("returns 0 when no lineage exists", () => {
    assert.equal(entryRound({}), 0);
  });

  it("returns 0 when lineage has no round field", () => {
    assert.equal(entryRound({ loop_lineage: { goal_id: "x" } }), 0);
  });

  it("returns 0 for non-integer round values", () => {
    assert.equal(entryRound({ loop_lineage: { round: 1.5 } }), 0);
  });
});
