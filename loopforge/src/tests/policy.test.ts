/** Tests for policy loading and singleton. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadPolicy,
  getPolicy,
  resetPolicy,
  DEFAULT_POLICY,
} from "../policy.js";

describe("Policy — Defaults", () => {
  beforeEach(() => resetPolicy());

  it("DEFAULT_POLICY has correct constraint values", () => {
    assert.equal(DEFAULT_POLICY.constraints.retire_window, 3);
    assert.equal(DEFAULT_POLICY.constraints.max_active, 12);
  });

  it("DEFAULT_POLICY has correct summary values", () => {
    assert.equal(DEFAULT_POLICY.summary.window, 5);
    assert.equal(DEFAULT_POLICY.summary.health_check_interval, 1);
  });

  it("DEFAULT_POLICY has correct engine values", () => {
    assert.equal(DEFAULT_POLICY.engine.feedback_flush_interval, 5);
    assert.equal(DEFAULT_POLICY.engine.max_circuit_breaker, 3);
  });

  it("DEFAULT_POLICY fallback_chain is complete", () => {
    const chain = DEFAULT_POLICY.technique.fallback_chain;
    assert.equal(chain["zero-shot"], "few-shot");
    assert.equal(chain["few-shot"], "zero-shot-cot");
    assert.equal(chain["tree-of-thought"], "tree-of-thought");
  });

  it("DEFAULT_POLICY routing_table has 6 entries", () => {
    const rt = DEFAULT_POLICY.technique.routing_table;
    assert.equal(Object.keys(rt).length, 6);
    assert.equal(rt["continuous_high"], "few-shot-cot");
    assert.equal(rt["independent_high"], "tree-of-thought");
  });

  it("DEFAULT_POLICY recompile_triggers has L1 and L2 lists", () => {
    assert.ok(DEFAULT_POLICY.recompile_triggers.l1.includes("new_constraints"));
    assert.ok(DEFAULT_POLICY.recompile_triggers.l2.includes("goal_id_changed"));
  });

  it("getPolicy returns DEFAULT_POLICY when no file found", () => {
    resetPolicy();
    const policy = getPolicy("nonexistent_policy.json");
    assert.equal(policy.constraints.retire_window, 3);
  });

  it("getPolicy is a singleton within a session", () => {
    resetPolicy();
    const p1 = getPolicy();
    const p2 = getPolicy();
    assert.strictEqual(p1, p2);
  });

  it("resetPolicy clears the singleton", () => {
    resetPolicy();
    const p1 = getPolicy();
    resetPolicy();
    const p2 = getPolicy();
    assert.notStrictEqual(p1, p2);
  });

  it("loadPolicy returns defaults when given invalid path", () => {
    const policy = loadPolicy("/nonexistent/path.json");
    assert.equal(policy.constraints.retire_window, 3);
    assert.equal(policy.version, "1");
  });
});
