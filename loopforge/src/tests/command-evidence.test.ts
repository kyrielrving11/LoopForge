import { describe, it } from "node:test";
import { criterionClaims } from "./_helpers.js";
import assert from "node:assert/strict";
import { CommandEvidenceProvider } from "../evidence-provider.js";
import type { CommandEvidencePolicy } from "../policy.js";
import { resetPolicy, getPolicy } from "../policy.js";
import { makeSelfEvaluation } from "../protocol.js";
import { verifySelfEvaluation } from "../verification-gate.js";

function config(overrides: Partial<CommandEvidencePolicy> = {}): CommandEvidencePolicy {
  return {
    name: "node-check",
    enabled: true,
    executable: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    cwd: ".",
    phase: "after",
    required: true,
    timeout_ms: 2000,
    max_output_chars: 20_000,
    success_exit_codes: [0],
    ...overrides,
  };
}

async function capture(
  provider: CommandEvidenceProvider,
  phase: "before" | "after" = "after",
) {
  const controller = new AbortController();
  return provider.capture({
    signal: controller.signal,
    timeoutMs: 5000,
    loopId: "command-test",
    phase,
  });
}

describe("CommandEvidenceProvider", () => {
  it("runs an explicit executable without a shell", async () => {
    const argument = "value; echo must-not-run";
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "process.stdout.write(process.argv[1])", argument],
    })));
    assert.equal(snapshot?.status, "passed");
    assert.equal(snapshot?.data.stdoutExcerpt, argument);
    assert.equal(snapshot?.data.exitCode, 0);
  });

  it("captures a failing exit code as structured evidence", async () => {
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
    })));
    assert.equal(snapshot?.status, "failed");
    assert.equal(snapshot?.data.exitCode, 7);
    assert.equal(snapshot?.data.stderrExcerpt, "bad");
  });

  it("terminates a command at its own deadline", async () => {
    const started = Date.now();
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "setTimeout(() => {}, 10000)"],
      timeout_ms: 40,
    })));
    assert.equal(snapshot?.status, "timeout");
    assert.ok(Date.now() - started < 1000);
  });

  it("caps combined retained output and reports truncation", async () => {
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "process.stdout.write('x'.repeat(100))"],
      max_output_chars: 10,
    })));
    assert.equal(snapshot?.data.stdoutExcerpt, "xxxxxxxxxx");
    assert.equal(snapshot?.data.truncated, true);
  });

  it("L8: honors a configured cap larger than the old 20k clamp", async () => {
    // The old code silently clamped max_output_chars at 20_000 — a policy
    // configured with 50_000 retained only 20k of a 30k stream.
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "process.stdout.write('x'.repeat(30_000))"],
      max_output_chars: 50_000,
    })));
    assert.equal(snapshot?.data.truncated, false,
      "30k of output under a 50k cap must not be truncated");
    assert.equal((snapshot?.data.stdoutExcerpt as string).length, 30_000,
      "the configured cap must be honored above 20k");
  });

  it("records missing executables and unsafe cwd without throwing", async () => {
    // v3.8: a missing executable is `unavailable` (the machine could not
    // observe anything); an unsafe cwd is `error` (the configuration is
    // wrong). Both are recorded, never thrown.
    const missing = await capture(new CommandEvidenceProvider(config({
      executable: `loopforge-missing-${Date.now()}`,
    })));
    assert.equal(missing?.status, "unavailable");
    assert.equal(missing?.data.failureDetail, "ENOENT");

    const invalid = await capture(new CommandEvidenceProvider(config({ cwd: ".." })));
    assert.equal(invalid?.status, "error");
    assert.match(String(invalid?.data.failureDetail), /workspace/);
  });

  it("does not run after-only commands in the before phase", async () => {
    const snapshot = await capture(new CommandEvidenceProvider(config()), "before");
    assert.equal(snapshot, null);
  });

  it("v3.3: resolves workspace entrypoint files from the args", async () => {
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "process.exit(0)", "src/evidence-provider.ts"],
    })));
    assert.equal(snapshot?.status, "passed");
    assert.ok(
      (snapshot?.data.entrypointFiles as string[]).includes("src/evidence-provider.ts"),
      "args resolving to workspace files must be listed as entrypoints",
    );
  });

  it("v3.3: external commands only resolve package.json (or nothing)", async () => {
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "process.exit(0)"],
    })));
    assert.equal(snapshot?.status, "passed");
    const entrypoints = (snapshot?.data.entrypointFiles ?? []) as string[];
    assert.deepEqual(entrypoints, ["package.json"],
      "no path-shaped arg means only the package.json indirection is observable",
    );
  });
});

describe("required command verification", () => {
  it("contradicts a success claim when a required command failed", () => {
    const evaluation = makeSelfEvaluation({ success: true });
    const result = verifySelfEvaluation(evaluation, 1, [], null, [{
      schemaVersion: 1,
      providerId: "command:test",
      kind: "command",
      phase: "after",
      startedAt: 0,
      finishedAt: 0,
      status: "failed",
      files: [],
      data: {
        commandId: "tests",
        argv: ["npm", "test"],
        cwd: ".",
        configHash: "0".repeat(64),
        required: true,
        exitCode: 1,
        signal: null,
        durationMs: 1,
        stdoutSha256: "0".repeat(64),
        stderrSha256: "0".repeat(64),
        stdoutExcerpt: "",
        stderrExcerpt: "",
        truncated: false,
        entrypointFiles: [],
      },
    }]);
    assert.equal(result.verdict, "contradicted");
    assert.equal(result.flags.some((flag) => flag.check === "required_command_failed"), true);
  });

  it("does not contradict optional command failures", () => {
    resetPolicy();
    // v3.8: an optional (required=false) bound command failing does not
    // reject the round — the required_command_failed check only fires for
    // required commands.
    try {
      const evaluation = makeSelfEvaluation({
        success: true,
        execution_report: {
          files_changed: ["src/a.ts"],
          tests_reported: { passed: 1, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims([], []),
          progress_estimate: 0.5,
        },
      });
      const result = verifySelfEvaluation(evaluation, 1, [], null, [{
        schemaVersion: 1,
        providerId: "command:optional",
        kind: "command",
        phase: "after",
        startedAt: 0,
        finishedAt: 0,
        status: "failed",
        files: [],
        data: {
          commandId: "lint",
          argv: ["npm", "run", "lint"],
          cwd: ".",
          configHash: "0".repeat(64),
          required: false,
          exitCode: 1,
          signal: null,
          durationMs: 1,
          stdoutSha256: "0".repeat(64),
          stderrSha256: "0".repeat(64),
          stdoutExcerpt: "",
          stderrExcerpt: "",
          truncated: false,
          entrypointFiles: [],
        },
      }]);
      // v3.2: optional failure + claimed success = unverified success — the
      // round is suspect (success_unverified warn), not contradicted (error).
      assert.equal(result.verdict, "suspect");
    } finally {
      resetPolicy();
    }
  });
});
