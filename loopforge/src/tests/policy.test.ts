import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  getPolicy,
  loadPolicy,
  resetPolicy,
} from "../policy.js";

describe("Policy defaults", () => {
  beforeEach(() => resetPolicy());

  it("keeps only active workflow evolution controls", () => {
    assert.equal(DEFAULT_POLICY.evolution.max_active_constraints, 15);
    assert.equal(DEFAULT_POLICY.evolution.progress_stall_rounds, 3);
  });

  it("keeps workflow-derived summary controls", () => {
    assert.equal(DEFAULT_POLICY.summary.window, 5);
    assert.equal(DEFAULT_POLICY.summary.max_milestones, 10);
  });

  it("keeps active engine controls", () => {
    assert.equal(DEFAULT_POLICY.engine.max_rounds, 20);
    assert.equal(DEFAULT_POLICY.engine.backtrack_enabled, true);
  });

  it("uses the typed LoopStore root", () => {
    assert.equal(DEFAULT_POLICY.backend.root_dir, ".loopforge");
  });

  it("defaults to risk-only plan approval", () => {
    assert.equal(DEFAULT_POLICY.workflow.approval_policy, "risk_only");
  });
});

describe("Policy loading", () => {
  beforeEach(() => resetPolicy());

  it("returns defaults when no policy file exists", () => {
    const policy = getPolicy("nonexistent_policy.json");
    assert.equal(policy.evolution.max_active_constraints, 15);
  });

  it("is a singleton within a session", () => {
    assert.strictEqual(getPolicy(), getPolicy());
  });

  it("resetPolicy clears the singleton", () => {
    const first = getPolicy();
    resetPolicy();
    assert.notStrictEqual(first, getPolicy());
  });

  it("returns defaults for an invalid path", () => {
    const policy = loadPolicy("/nonexistent/path.json");
    assert.equal(policy.engine.max_rounds, 20);
    assert.equal(policy.version, "3");
  });
});
