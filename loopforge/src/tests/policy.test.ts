/** Tests for policy loading and singleton. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPolicy,
  getPolicy,
  resetPolicy,
  DEFAULT_POLICY,
  POLICY_SCHEMA_VERSION,
} from "../policy.js";

describe("Policy — Defaults", () => {
  beforeEach(() => resetPolicy());

  it("DEFAULT_POLICY has correct constraint values", () => {
    assert.equal(DEFAULT_POLICY.constraints.retire_window, 3);
    assert.equal(DEFAULT_POLICY.evolution.max_active_constraints, 15);
  });

  it("DEFAULT_POLICY has correct summary values", () => {
    assert.equal(DEFAULT_POLICY.summary.window, 5);
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

  it("loadPolicy returns defaults when no file declares a policy", () => {
    const policy = loadPolicy("/nonexistent/path.json");
    assert.equal(policy.constraints.retire_window, 3);
    assert.equal(policy.version, POLICY_SCHEMA_VERSION);
  });
});

describe("Policy — the schema version is a boundary", () => {
  beforeEach(() => resetPolicy());

  /** Write a policy file into a throwaway directory and run loadPolicy on it. */
  const withPolicyFile = (body: Record<string, unknown>, run: (path: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "lf-policy-"));
    try {
      const path = join(dir, "loop_policy.json");
      writeFileSync(path, JSON.stringify(body));
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("loads the shipped loop_policy.json and inherits the keys it omits", () => {
    const policy = loadPolicy("loop_policy.json");
    assert.equal(policy.version, POLICY_SCHEMA_VERSION);
    assert.equal(policy.engine.backtrack_enabled, true);
    assert.equal(policy.prompt.l2_pointer_enabled, true);
    assert.equal(policy.gate.enabled, false);
  });

  it("REJECTS a file that declares a different schema version", () => {
    // v3.8.1: the version field used to be declarative — NOTHING read it — so
    // a policy written for an older schema was silently merged over the
    // current defaults. Now the file either declares this version or it is a
    // defect, reported instead of half-applied.
    withPolicyFile({ version: "3" }, (path) => {
      assert.throws(
        () => loadPolicy(path),
        /does not match the current schema version/,
      );
    });
  });

  it("REJECTS a file with no schema version at all", () => {
    withPolicyFile({ engine: { max_rounds: 5 } }, (path) => {
      assert.throws(() => loadPolicy(path), /does not match the current schema version/);
    });
  });

  it("REJECTS an unknown key instead of ignoring it", () => {
    // A typo used to be announced and then ignored, so the loop ran on a value
    // the operator never set.
    withPolicyFile(
      { version: POLICY_SCHEMA_VERSION, engin: { max_rounds: 5 } },
      (path) => {
        assert.throws(() => loadPolicy(path), /unknown policy key "engin"/);
      },
    );
  });
});
