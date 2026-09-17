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

  it("v3.8.3: doctor states the evidence posture the runtime will use", () => {
    const root = temporaryDirectory();
    try {
      // No policy file: the defaults have no commands, so the report has to
      // say what that means. Same wording the round prompts use, from the one
      // capability derivation.
      const report = JSON.parse(run(["doctor", "--json"], root).stdout) as {
        checks: Array<{ name: string; ok: boolean; required: boolean; detail: string }>;
      };
      const evidence = report.checks.find((check) => check.name === "evidence");
      assert.ok(evidence, "the evidence posture is reported");
      assert.equal(evidence!.ok, false);
      assert.equal(evidence!.required, false, "a contract-less loop is legitimate");
      assert.match(evidence!.detail, /Round Contract items cannot be machine-verified/);

      // With an after-capable command configured it flips to ready.
      writeFileSync(join(root, "loop_policy.json"), JSON.stringify({
        version: POLICY_SCHEMA_VERSION,
        evidence: {
          commands: [{
            name: "verify", enabled: true, executable: "node", args: ["-e", "0"],
            phase: "after", required: false, timeout_ms: 5000,
            max_output_chars: 2000, success_exit_codes: [0],
          }],
        },
      }));
      const withCommand = JSON.parse(run(["doctor", "--json"], root).stdout) as {
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      const ready = withCommand.checks.find((check) => check.name === "evidence");
      assert.equal(ready!.ok, true);
      assert.match(ready!.detail, /can back a contract item/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("v3.8.3: doctor's failures carry the next step, not only the defect", () => {
    const root = temporaryDirectory();
    try {
      writeFileSync(join(root, "loop_policy.json"), "{ not json\n");
      const report = JSON.parse(run(["doctor", "--json"], root).stdout) as {
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      const policyCheck = report.checks.find((check) => check.name === "policy");
      assert.equal(policyCheck!.ok, false);
      assert.match(policyCheck!.detail, /fix it or delete it/);
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

  it("writes the default loop_policy.json into the workspace", () => {
    const root = temporaryDirectory();
    const skillsRoot = temporaryDirectory();
    try {
      // v3.8.3: --workspace is the runtime boundary, so this is where the
      // policy the runtime will actually read has to land.
      const result = run([
        "init", "--client", "generic", "--target", skillsRoot, "--workspace", root,
      ]);
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
      // The output names all three locations, so "where did it go?" is
      // answered without reading the source.
      assert.match(result.stdout, /(Installed|Already present):.*SKILL\.md/);
      assert.match(result.stdout, /Workspace: /);
      assert.match(result.stdout, /loopforge mcp/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(skillsRoot, { recursive: true, force: true });
    }
  });

  it("keeps --target about the skill and --workspace about the runtime", () => {
    const skillsRoot = temporaryDirectory();
    const workspaceRoot = temporaryDirectory();
    try {
      const result = run([
        "init", "--client", "generic",
        "--target", skillsRoot, "--workspace", workspaceRoot,
      ]);
      assert.equal(result.status, 0, result.stderr);
      // The skill goes where --target says...
      assert.ok(existsSync(join(skillsRoot, "perception", "SKILL.md")));
      // ...and the policy goes where --workspace says, NOT under --target.
      assert.ok(existsSync(join(workspaceRoot, "loop_policy.json")));
      assert.equal(existsSync(join(skillsRoot, "loop_policy.json")), false);
    } finally {
      rmSync(skillsRoot, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not overwrite loop_policy.json without --force", () => {
    const root = temporaryDirectory();
    try {
      // First init creates the policy
      run(["init", "--client", "generic", "--workspace", root]);
      // Second init without force should skip
      const result = run(["init", "--client", "generic", "--workspace", root]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Already present:.*loop_policy\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unknown option instead of ignoring it", () => {
    // A typo used to behave exactly like the flag was never passed.
    const unknown = run(["mcp", "--targt", "x"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown option: --targt/);

    const missingValue = run(["init", "--client", "generic", "--workspace"]);
    assert.equal(missingValue.status, 1);
    assert.match(missingValue.stderr, /--workspace requires a value/);
  });

  it("starts the MCP server against the workspace it is given", () => {
    // The server reads its policy and resolves its store root at construction,
    // so --workspace must take effect before that. Proven with a policy that
    // is broken only inside the target directory: the diagnostic names it, so
    // the server demonstrably read THAT file and not the cwd's.
    const root = temporaryDirectory();
    const elsewhere = temporaryDirectory();
    try {
      writeFileSync(join(root, "loop_policy.json"), "{ not json\n");
      const result = run(["mcp", "--workspace", root], elsewhere);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /policy_invalid:/);
      // The path in the message is the workspace's, not the cwd's.
      assert.ok(
        result.stderr.includes(join(root, "loop_policy.json")),
        `diagnostic must name the workspace policy, got: ${result.stderr}`,
      );

      // A directory that is not there is refused rather than ignored.
      const missing = join(root, "does-not-exist");
      const bad = run(["mcp", "--workspace", missing], elsewhere);
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("reports a broken policy as policy_invalid with the file path", () => {
    const root = temporaryDirectory();
    try {
      // Present but unparseable: the operator believes a policy is in force.
      writeFileSync(join(root, "loop_policy.json"), "{ not json\n");
      const result = run(["mcp"], root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /policy_invalid:/);
      assert.match(result.stderr, /loop_policy\.json/);
      assert.match(result.stderr, /loopforge doctor/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
