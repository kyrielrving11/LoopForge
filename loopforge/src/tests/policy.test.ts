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
    assert.equal(DEFAULT_POLICY.evolution.max_active_constraints, 15);
  });

  it("DEFAULT_POLICY has correct summary values", () => {
    assert.equal(DEFAULT_POLICY.summary.window, 5);
    assert.equal(DEFAULT_POLICY.summary.health_check_interval, 1);
  });

  it("DEFAULT_POLICY has the stall lookback window", () => {
    assert.equal(DEFAULT_POLICY.engine.stall_lookback_rounds, 3);
  });

  it("uses the typed LoopStore root", () => {
    assert.equal(DEFAULT_POLICY.backend.root_dir, ".loopforge");
  });

  it("v3.8: evidence policy carries providers, timeout, and commands only", () => {
    assert.deepEqual(Object.keys(DEFAULT_POLICY.evidence).sort(), ["commands", "providers", "timeout_ms"]);
    // Old loop_policy.json files (missing keys) fall back to the defaults via
    // deepMerge — no migration needed (the v3.8 deletions simply inherit).
    resetPolicy();
    const policy = getPolicy("nonexistent_policy.json");
    assert.deepEqual(policy.evidence.commands, []);
  });
});

describe("Policy — Loading", () => {
  beforeEach(() => resetPolicy());

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
    assert.equal(policy.version, "3");
  });
});

describe("Policy — v3.7 shipped sample", () => {
  beforeEach(() => resetPolicy());

  it("loads loop_policy.json without unknown-key warnings and inherits defaults", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown, ...rest: unknown[]) => {
      warnings.push(String(message));
      originalWarn(message, ...rest);
    };
    try {
      const policy = loadPolicy("loop_policy.json");
      // v3.7: the stale keys (injection_mode, subgoal_auto_*,
      // constraint_inactive_rounds) were removed — no unknown-key warnings.
      assert.deepEqual(warnings, []);
      assert.equal(policy.version, "3");
      // Keys absent from the sample file inherit from DEFAULT_POLICY.
      assert.equal(policy.engine.backtrack_enabled, true);
      assert.equal(policy.prompt.l2_pointer_enabled, true);
      assert.equal(policy.evolution.constraint_id_enabled, true);
      assert.equal(policy.gate.enabled, false);
    } finally {
      console.warn = originalWarn;
    }
  });
});
