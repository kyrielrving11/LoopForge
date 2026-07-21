import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExtractionContext, parseLoopExtras } from "../loop-extras-parser.js";

describe("ExtractionContext", () => {
  // ── string ──────────────────────────────────────────────────────────────
  describe("string()", () => {
    it("returns the value when it is a string", () => {
      const ctx = new ExtractionContext({ name: "hello" });
      assert.equal(ctx.string("name"), "hello");
    });

    it("returns fallback when key is missing", () => {
      const ctx = new ExtractionContext({});
      assert.equal(ctx.string("name", "default"), "default");
    });

    it("returns fallback and records error when value is wrong type", () => {
      const ctx = new ExtractionContext({ name: 42 });
      assert.equal(ctx.string("name", "fallback"), "fallback");
      assert.equal(ctx.errors.length, 1);
      assert.equal(ctx.errors[0].field, "name");
    });

    it("returns empty string as default fallback", () => {
      const ctx = new ExtractionContext({});
      assert.equal(ctx.string("name"), "");
    });
  });

  // ── optionalString ──────────────────────────────────────────────────────
  describe("optionalString()", () => {
    it("returns the value when present", () => {
      const ctx = new ExtractionContext({ ref: "abc" });
      assert.equal(ctx.optionalString("ref"), "abc");
    });

    it("returns null when key is missing", () => {
      const ctx = new ExtractionContext({});
      assert.equal(ctx.optionalString("ref"), null);
    });

    it("returns custom fallback when wrong type", () => {
      const ctx = new ExtractionContext({ ref: [1, 2] });
      assert.equal(ctx.optionalString("ref", "custom"), "custom");
      assert.equal(ctx.errors.length, 1);
    });
  });

  // ── number ──────────────────────────────────────────────────────────────
  describe("number()", () => {
    it("returns the value when it is a number", () => {
      const ctx = new ExtractionContext({ count: 5 });
      assert.equal(ctx.number("count", 0), 5);
    });

    it("returns fallback when key is missing", () => {
      const ctx = new ExtractionContext({});
      assert.equal(ctx.number("count", 10), 10);
    });

    it("clamps to min", () => {
      const ctx = new ExtractionContext({ count: -3 });
      assert.equal(ctx.number("count", 0, { min: 1 }), 1);
    });

    it("truncates floats when truncate option is set", () => {
      const ctx = new ExtractionContext({ count: 3.7 });
      assert.equal(ctx.number("count", 0, { truncate: true }), 3);
    });

    it("records error when value is not a number", () => {
      const ctx = new ExtractionContext({ count: "abc" });
      assert.equal(ctx.number("count", 0), 0);
      assert.equal(ctx.errors.length, 1);
    });

    it("records error for NaN", () => {
      const ctx = new ExtractionContext({ count: NaN });
      assert.equal(ctx.number("count", 0), 0);
      assert.equal(ctx.errors.length, 1);
    });
  });

  // ── boolean ─────────────────────────────────────────────────────────────
  describe("boolean()", () => {
    it("returns the value when it is a boolean", () => {
      const ctx = new ExtractionContext({ enabled: true });
      assert.equal(ctx.boolean("enabled"), true);
    });

    it("returns fallback when missing", () => {
      const ctx = new ExtractionContext({});
      assert.equal(ctx.boolean("enabled", true), true);
    });

    it("records error for non-boolean", () => {
      const ctx = new ExtractionContext({ enabled: "yes" });
      assert.equal(ctx.boolean("enabled"), false);
      assert.equal(ctx.errors.length, 1);
    });
  });

  // ── stringArray ─────────────────────────────────────────────────────────
  describe("stringArray()", () => {
    it("returns the array when all elements are strings", () => {
      const ctx = new ExtractionContext({ tags: ["a", "b"] });
      assert.deepEqual(ctx.stringArray("tags"), ["a", "b"]);
    });

    it("returns fallback when missing", () => {
      const ctx = new ExtractionContext({});
      assert.deepEqual(ctx.stringArray("tags"), []);
    });

    it("filters non-string elements and records errors", () => {
      const ctx = new ExtractionContext({ tags: ["ok", 42, "also-ok"] });
      const result = ctx.stringArray("tags");
      assert.deepEqual(result, ["ok", "also-ok"]);
      assert.equal(ctx.errors.length, 1);
      assert.equal(ctx.errors[0].field, "tags[1]");
    });

    it("records error for non-array value", () => {
      const ctx = new ExtractionContext({ tags: "not-an-array" });
      assert.deepEqual(ctx.stringArray("tags"), []);
      assert.equal(ctx.errors.length, 1);
    });
  });

  // ── object ──────────────────────────────────────────────────────────────
  describe("object()", () => {
    it("returns the object when present", () => {
      const ctx = new ExtractionContext({ data: { key: "val" } });
      assert.deepEqual(ctx.object("data"), { key: "val" });
    });

    it("returns null when missing", () => {
      const ctx = new ExtractionContext({});
      assert.equal(ctx.object("data"), null);
    });

    it("returns null and records error for arrays", () => {
      const ctx = new ExtractionContext({ data: [1, 2] });
      assert.equal(ctx.object("data"), null);
      assert.equal(ctx.errors.length, 1);
    });
  });

  // ── has ─────────────────────────────────────────────────────────────────
  describe("has()", () => {
    it("returns true when key exists", () => {
      const ctx = new ExtractionContext({ max_rounds: 10 });
      assert.equal(ctx.has("max_rounds"), true);
    });

    it("returns false when key is absent", () => {
      const ctx = new ExtractionContext({});
      assert.equal(ctx.has("max_rounds"), false);
    });
  });
});

describe("parseLoopExtras", () => {
  it("parses a full extras payload with all fields", () => {
    const { parsed, ctx } = parseLoopExtras({
      loop_id: "loop-1",
      round: 3,
      goal_id: "goal-x",
      domain: "solidity",
      next_task_proposal: "Audit upgrade",
      plan_source: "docs/plan.md",
      constraints_from_plan: ["No data loss", "Preserve API"],
      new_since_last_round: "Fixed reentrancy",
      force_level: "l2",
      health_check_interval: 2,
      external_context: "Context from CI",
      max_rounds: 15,
      verification_flags: [{
        severity: "warn",
        field: "progress",
        check: "progress_regression",
        detail: "Progress dropped",
      }],
      attempt: 2,
      consecutive_rejections: 1,
      rejection_notice: "Required command failed",
      last_round_result: { round: 2, success: true },
      loop_objective: { objective: "Secure contracts", success_criteria: ["No bugs"] },
    }, "fallback-id");

    assert.equal(ctx.errors.length, 0);
    assert.equal(parsed.loop_id, "loop-1");
    assert.equal(parsed.round, 3);
    assert.equal(parsed.goal_id, "goal-x");
    assert.equal(parsed.domain, "solidity");
    assert.equal(parsed.plan_source, "docs/plan.md");
    assert.deepEqual(parsed.constraints_from_plan, ["No data loss", "Preserve API"]);
    assert.equal(parsed.force_level, "l2");
    assert.equal(parsed.health_check_interval, 2);
    assert.equal(parsed.max_rounds, 15);
    assert.equal(parsed.verification_flags.length, 1);
    assert.equal(parsed.attempt, 2);
    assert.equal(parsed.consecutive_rejections, 1);
    assert.equal(parsed.rejection_notice, "Required command failed");
    assert.ok(parsed.last_round_result);
    assert.ok(parsed.loop_objective);
  });

  it("uses defaults when all fields are missing", () => {
    const { parsed, ctx } = parseLoopExtras({}, "task-id");

    assert.equal(parsed.loop_id, "task-id"); // falls back to taskId
    assert.equal(parsed.round, 1);
    assert.equal(parsed.goal_id, "");
    assert.equal(parsed.attempt, 1);
    assert.equal(parsed.consecutive_rejections, 0);
    assert.equal(parsed.rejection_notice, "");
    assert.deepEqual(parsed.verification_flags, []);
    assert.equal(parsed.last_round_result, null);
    assert.equal(parsed.loop_objective, null);
    assert.equal(parsed.max_rounds, undefined);
  });

  it("clamps round to minimum 1", () => {
    const { parsed } = parseLoopExtras({ round: 0 }, "id");
    assert.equal(parsed.round, 1);
  });

  it("clamps attempt to minimum 1", () => {
    const { parsed } = parseLoopExtras({ attempt: -5 }, "id");
    assert.equal(parsed.attempt, 1);
  });

  it("uses loop_id from extras when provided", () => {
    const { parsed } = parseLoopExtras({ loop_id: "explicit-id" }, "task-id");
    assert.equal(parsed.loop_id, "explicit-id");
  });

  it("collects multiple errors without throwing", () => {
    const { parsed, ctx } = parseLoopExtras({
      round: "bad",
      attempt: true,
      verification_flags: "not-array",
      constraints_from_plan: "not-array",
    }, "id");

    // Best-effort defaults still returned
    assert.equal(parsed.round, 1);
    assert.equal(parsed.attempt, 1);
    assert.deepEqual(parsed.verification_flags, []);

    // All type errors collected
    assert.ok(ctx.errors.length >= 2);
  });
});
