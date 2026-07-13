import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CommandEvidenceProvider } from "../evidence-provider.js";
import type { CommandEvidencePolicy } from "../policy.js";
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
    assert.equal(snapshot?.data.status, "passed");
    assert.equal(snapshot?.data.stdout, argument);
    assert.equal(snapshot?.data.exitCode, 0);
  });

  it("captures a failing exit code as structured evidence", async () => {
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
    })));
    assert.equal(snapshot?.data.status, "failed");
    assert.equal(snapshot?.data.exitCode, 7);
    assert.equal(snapshot?.data.stderr, "bad");
  });

  it("terminates a command at its own deadline", async () => {
    const started = Date.now();
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "setTimeout(() => {}, 10000)"],
      timeout_ms: 40,
    })));
    assert.equal(snapshot?.data.status, "timeout");
    assert.ok(Date.now() - started < 1000);
  });

  it("caps combined retained output and reports truncation", async () => {
    const snapshot = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "process.stdout.write('x'.repeat(100))"],
      max_output_chars: 10,
    })));
    assert.equal(snapshot?.data.stdout, "xxxxxxxxxx");
    assert.equal(snapshot?.data.truncated, true);
  });

  it("records missing executables and unsafe cwd without throwing", async () => {
    const missing = await capture(new CommandEvidenceProvider(config({
      executable: `loopforge-missing-${Date.now()}`,
    })));
    assert.equal(missing?.data.status, "missing");

    const invalid = await capture(new CommandEvidenceProvider(config({ cwd: ".." })));
    assert.equal(invalid?.data.status, "invalid_cwd");
  });

  it("does not run after-only commands in the before phase", async () => {
    const snapshot = await capture(new CommandEvidenceProvider(config()), "before");
    assert.equal(snapshot, null);
  });
});

describe("required command verification", () => {
  it("contradicts a success claim when a required command failed", () => {
    const evaluation = makeSelfEvaluation({ success: true });
    const result = verifySelfEvaluation(evaluation, 1, [], null, null, [{
      provider: "command:test",
      timestamp: Date.now(),
      files: [],
      data: {
        kind: "command",
        commandName: "tests",
        required: true,
        phase: "after",
        status: "failed",
        exitCode: 1,
      },
    }]);
    assert.equal(result.verdict, "contradicted");
    assert.equal(result.flags.some((flag) => flag.check === "required_command_failed"), true);
  });

  it("does not contradict optional command failures", () => {
    const evaluation = makeSelfEvaluation({ success: true });
    const result = verifySelfEvaluation(evaluation, 1, [], null, null, [{
      provider: "command:optional",
      timestamp: Date.now(),
      files: [],
      data: {
        kind: "command",
        commandName: "lint",
        required: false,
        phase: "after",
        status: "failed",
        exitCode: 1,
      },
    }]);
    assert.equal(result.verdict, "trusted");
  });
});
