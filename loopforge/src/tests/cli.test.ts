import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { FileLoopStore } from "../loop-store.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "../protocol.js";
import { POLICY_SCHEMA_VERSION } from "../policy.js";

const cli = resolve("dist/cli.js");

// Single version source: package.json. The CLI must agree with it.
const pkgVersion = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version as string;

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
    assert.match(help.stdout, new RegExp(`LoopForge ${pkgVersion.replace(/\./g, "\\.")}`));
    assert.match(help.stdout, /loopforge mcp/);
    assert.match(help.stdout, /loopforge inspect/);
    assert.match(help.stdout, /loopforge explain/);
    assert.equal(run(["--version"]).stdout.trim(), pkgVersion);
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

  it("inspect accepts options BEFORE the LOOP_ID (v3.3.1)", () => {
    const root = temporaryDirectory();
    try {
      const store = new FileLoopStore(join(root, ".loopforge"));
      store.appendEntry({
        task_id: "loop:inspect-me:r1",
        task_type: "loop_lineage",
        loop_id: "inspect-me",
        loop_lineage: { round: 1, task: "inspect" },
      });
      // Regression: `inspect --round 1 inspect-me` took the option VALUE "1"
      // as the LOOP_ID (first non-dash argument) and reported
      // "round not found: 1#1" — the real loop was never read.
      const result = run(["inspect", "--round", "1", "inspect-me", "--json"], root);
      assert.equal(result.status, 0, result.stderr);
      const document = JSON.parse(result.stdout) as { round: number };
      assert.equal(document.round, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inspect hides prompt TEXT even when the round carries a prompt artifact", () => {
    const root = temporaryDirectory();
    try {
      const store = new FileLoopStore(join(root, ".loopforge"));
      // A committed round whose transaction carries a full prompt artifact —
      // the shape that previously leaked renderedPrompt through the
      // whitelisted promptArtifact key (the old \bprompt\b filter never
      // matched underscore/camelCase keys at all).
      store.appendEntry({
        task_id: "loop:inspect-me:r1:feedback",
        task_type: "feedback",
        loop_id: "inspect-me",
        loop_lineage: {
          round: 1,
          round_transaction: {
            schema_version: 2,
            round_id: "loop:inspect-me:round:1",
            snapshot: {
              schemaVersion: 2,
              roundId: "loop:inspect-me:round:1",
              loopId: "inspect-me",
              round: 1,
              attempt: 1,
              phase: "committed",
              beforeEvidence: [],
              promptArtifact: {
                schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
                roundId: "loop:inspect-me:round:1",
                round: 1,
                attempt: 1,
                level: "l2",
                renderedPrompt: "TOP-SECRET-PROMPT-TEXT",
                promptHash: "abc123",
                stateHash: "def456",
                sections: ["objective"],
                droppedSections: [],
                protectedOverflow: false,
                budget: 18000,
                renderedChars: 21,
              },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            result: { action: "continue", verificationFlags: [] },
          },
        },
      });
      const result = run(["inspect", "inspect-me", "--round", "1", "--json"], root);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes("TOP-SECRET-PROMPT-TEXT"),
        "prompt text must not leak without --prompt");
      const document = JSON.parse(result.stdout) as {
        promptArtifact?: { level?: string; promptHash?: string; renderedPrompt?: string };
      };
      assert.equal(document.promptArtifact?.level, "l2", "artifact metadata is preserved");
      assert.equal(document.promptArtifact?.promptHash, "abc123", "hash metadata is preserved");
      assert.equal(document.promptArtifact?.renderedPrompt, undefined,
        "rendered text is stripped from the artifact");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains a loop from committed facts without creating history", () => {
    const root = temporaryDirectory();
    try {
      const store = new FileLoopStore(join(root, ".loopforge"));
      store.appendEntry({
        task_id: "loop:explain-me:r1:feedback",
        task_type: "feedback",
        loop_id: "explain-me",
        loop_lineage: {
          round: 1,
          round_transaction: {
            schema_version: 2,
            round_id: "loop:explain-me:round:1",
            snapshot: {
              schemaVersion: 2,
              roundId: "loop:explain-me:round:1",
              loopId: "explain-me",
              round: 1,
              attempt: 1,
              phase: "committed",
              beforeEvidence: [],
              afterEvidence: [],
              evaluation: {
                success: false,
                output_summary: "Scaffolded the module.",
                constraint_violations: [],
                should_continue: true,
              },
              createdAt: 0,
              updatedAt: 0,
            },
            result: { action: "continue", verificationFlags: [], roundSuccess: false },
          },
        },
      });
      const before = store.listEntries("explain-me").length;
      const result = run(["explain", "explain-me", "--json"], root);
      assert.equal(result.status, 0, result.stderr);
      const explained = JSON.parse(result.stdout) as { loopId: string; rounds: unknown[] };
      assert.equal(explained.loopId, "explain-me");
      assert.equal(explained.rounds.length, 1);
      // Read-only: explaining never appends a round.
      assert.equal(store.listEntries("explain-me").length, before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports static-only doctor checks including provider registration", () => {
    const root = temporaryDirectory();
    try {
      const result = run(["doctor", "--json"], root);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as {
        checks: Array<{ name: string; ok: boolean }>;
      };
      assert.ok(report.checks.some((check) => check.name === "provider:git"),
        "registered providers are reported");
      assert.ok(report.checks.every((check) => check.name !== "command:missing"),
        "no verification command is executed or invented by doctor");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("v3.8.1: doctor REPORTS a policy defect instead of dying on it", () => {
    // Loading the policy used to run first and throw, so `doctor --json` died
    // on exactly the defect it exists to diagnose — the one situation where a
    // report is needed produced a bare stderr line and no JSON at all.
    const root = temporaryDirectory();
    try {
      writeFileSync(join(root, "loop_policy.json"), JSON.stringify({
        version: POLICY_SCHEMA_VERSION,
        engin: { max_rounds: 5 }, // typo for "engine"
      }));
      const result = run(["doctor", "--json"], root);
      assert.equal(result.status, 1, "a failed required check must exit non-zero");
      const report = JSON.parse(result.stdout) as {
        ok: boolean;
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      assert.equal(report.ok, false);
      const policyCheck = report.checks.find((check) => check.name === "policy");
      assert.ok(policyCheck, "the policy load is reported as a check");
      assert.equal(policyCheck!.ok, false);
      assert.match(policyCheck!.detail, /unknown policy key "engin"/);
      assert.ok(report.checks.some((check) => check.name === "node"),
        "the remaining checks still ran against the defaults");
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
      // v3.8.1: the written file must declare the CURRENT schema version —
      // the version is load-bearing now, so a stale literal here would make
      // `init` produce a policy the runtime rejects.
      assert.equal(raw.version, POLICY_SCHEMA_VERSION);
      assert.equal(raw.engine.max_rounds, 200);
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
