import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { FileLoopStore } from "../loop-store.js";

const cli = resolve("dist/cli.js");

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "loopforge-cli-"));
}

function run(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

describe("loopforge CLI", () => {
  it("exposes one versioned command surface", () => {
    const help = run(["--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /LoopForge 2\.0\.1/);
    assert.match(help.stdout, /loopforge mcp/);
    assert.match(help.stdout, /loopforge inspect/);
    assert.equal(run(["--version"]).stdout.trim(), "2.0.1");
  });

  it("returns machine-readable doctor results", () => {
    const result = run(["doctor", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as { ok: boolean; checks: unknown[] };
    assert.equal(report.ok, true);
    assert.ok(report.checks.length >= 2);
  });

  it("inspects typed round state and hides prompts unless requested", () => {
    const root = temporaryDirectory();
    try {
      const store = new FileLoopStore(join(root, ".loopforge"));
      store.appendEntry({
        task_id: "loop:inspect-me:r1",
        task_type: "loop_lineage",
        loop_id: "inspect-me",
        loop_lineage: { round: 1, task: "inspect" },
      });
      const result = run(["inspect", "inspect-me", "--round", "1", "--json"], root);
      assert.equal(result.status, 0, result.stderr);
      const document = JSON.parse(result.stdout) as { round: number; promptArtifact?: unknown };
      assert.equal(document.round, 1);
      assert.equal(document.promptArtifact, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates a legacy vault once", () => {
    const root = temporaryDirectory();
    try {
      const source = join(root, "legacy.json");
      writeFileSync(source, JSON.stringify({ entries: [{
        task_id: "loop:migrated-cli:r1",
        task_type: "loop_lineage",
        loop_id: "migrated-cli",
        loop_lineage: { round: 1 },
      }] }), "utf8");
      const result = run(["migrate", "--from", source, "--json"], root);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).imported, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs only the Perception skill for a generic client", () => {
    const root = temporaryDirectory();
    try {
      const target = join(root, "skills");
      mkdirSync(target);
      const result = run(["init", "--client", "generic", "--target", target]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Installed:/);
      assert.match(result.stdout, /"loopforge"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a default loop_policy.json during init", () => {
    const root = temporaryDirectory();
    try {
      const result = run(["init", "--client", "generic", "--target", root]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Created:/);
      const policyPath = join(root, "loop_policy.json");
      assert.ok(existsSync(policyPath), "loop_policy.json should exist");
      const raw = JSON.parse(readFileSync(policyPath, "utf8"));
      assert.equal(raw.version, "2");
      assert.equal(raw.prompt.injection_mode, "adaptive");
      assert.equal(raw.engine.max_rounds, 20);
      assert.equal(raw.evidence.providers[0], "git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite loop_policy.json without --force", () => {
    const root = temporaryDirectory();
    try {
      // First init creates the policy
      run(["init", "--client", "generic", "--target", root]);
      // Second init without force should skip
      const result = run(["init", "--client", "generic", "--target", root]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Already present:.*loop_policy\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
