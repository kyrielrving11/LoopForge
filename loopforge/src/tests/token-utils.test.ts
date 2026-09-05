/** Tests for token-utils — shared Jaccard similarity, dedup, and entry helpers. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  jaccardSimilarity,
  unique,
  entryRound,
} from "../token-utils.js";

// ═══════════════════════════════════════════════════════════════════════════
// tokenize
// ═══════════════════════════════════════════════════════════════════════════

describe("tokenize", () => {
  it("splits on word boundaries", () => {
    const result = tokenize("hello world");
    assert.deepEqual(result, new Set(["hello", "world"]));
  });

  it("lowercases all tokens", () => {
    const result = tokenize("Hello WORLD");
    assert.deepEqual(result, new Set(["hello", "world"]));
  });

  it("handles Chinese characters", () => {
    // Consecutive CJK characters form overlapping 2-grams
    const result = tokenize("修复重入漏洞");
    assert.ok(result.has("修复"));
    assert.ok(result.has("重入"));
    assert.ok(result.has("漏洞"));
  });

  it("handles CJK Extension A", () => {
    // Extension A chars are within 㐀-鿿 range; 3 chars → 2 bigrams
    const result = tokenize("㐀㐁㐂");
    assert.ok(result.has("㐀㐁"));
    assert.ok(result.has("㐁㐂"));
  });

  it("returns empty set for empty input", () => {
    assert.deepEqual(tokenize(""), new Set());
  });

  it("returns empty set for punctuation-only input", () => {
    assert.deepEqual(tokenize("!@#$%^"), new Set());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// jaccardSimilarity
// ═══════════════════════════════════════════════════════════════════════════

describe("jaccardSimilarity", () => {
  it("returns 1 for identical strings", () => {
    assert.equal(jaccardSimilarity("hello world", "hello world"), 1);
  });

  it("returns 0 for completely different strings", () => {
    assert.equal(jaccardSimilarity("hello world", "foo bar"), 0);
  });

  it("returns 1/3 for one shared token out of three", () => {
    // {hello, world} ∩ {hello, foo} = {hello} → 1/3
    const score = jaccardSimilarity("hello world", "hello foo");
    assert.ok(Math.abs(score - 1/3) < 0.01);
  });

  it("returns 0 when either set is empty (empty never matches anything)", () => {
    // v2.14: an empty description carries no information — a score of 1
    // made `[""]` a wildcard that falsely marked sub-goals done and
    // suppressed criteria milestones. The original comment's stated intent
    // ("empty descriptions never match anything") requires 0.
    assert.equal(jaccardSimilarity("", ""), 0);
    assert.equal(jaccardSimilarity("hello", ""), 0);
    assert.equal(jaccardSimilarity("", "world"), 0);
  });

  it("handles case-insensitive comparison", () => {
    const score = jaccardSimilarity("Hello World", "hello world");
    assert.equal(score, 1);
  });

  it("handles Chinese text similarity", () => {
    const score = jaccardSimilarity("修复重入漏洞", "修复重入漏洞");
    assert.equal(score, 1);
    // Bigram overlap: {修复, 漏洞} shared out of 8 bigrams → 0.25,
    // not 0 (single-token baseline) — CJK similarity is graded
    const score2 = jaccardSimilarity("修复重入漏洞", "修复溢出漏洞");
    assert.equal(score2, 0.25);
  });

  it("handles synonymous phrasing for criteria dedup", () => {
    // "unit test coverage at 90 percent" vs "unit test coverage reached 90%"
    const score = jaccardSimilarity(
      "unit test coverage at 90 percent",
      "unit test coverage reached 90%",
    );
    // Should be above 0.45 for dedup, but below 1
    assert.ok(score >= 0.4, `score ${score} should be >= 0.4`);
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
