import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CommandEvidenceProvider } from "../evidence-provider.js";
import type { CommandEvidencePolicy } from "../policy.js";
import { normalizeRoundReport } from "../round-report.js";
import { verifyRoundEvaluation } from "../verification-gate.js";

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

async function capture(provider: CommandEvidenceProvider, phase: "before" | "after" = "after") {
  return provider.capture({ signal: new AbortController().signal, timeoutMs: 5000, loopId: "command-test", phase });
}

function evaluation() {
  return normalizeRoundReport({ status: "completed", summary: "Completed the step." }, "executing", "ps-one", []);
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

  it("captures failure, timeout, truncation, and unsafe cwd as evidence", async () => {
    const failed = await capture(new CommandEvidenceProvider(config({ args: ["-e", "process.exit(7)"] })));
    assert.equal(failed?.data.status, "failed");
    assert.equal(failed?.data.exitCode, 7);

    const timed = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "setTimeout(() => {}, 5000)"], timeout_ms: 25,
    })));
    assert.equal(timed?.data.status, "timeout");

    const capped = await capture(new CommandEvidenceProvider(config({
      args: ["-e", "process.stdout.write('x'.repeat(1000))"], max_output_chars: 40,
    })));
    assert.equal(capped?.data.truncated, true);
    assert.ok(String(capped?.data.stdout).length <= 40);

    const unsafe = await capture(new CommandEvidenceProvider(config({ cwd: ".." })));
    assert.equal(unsafe?.data.status, "invalid_cwd");
  });

  it("does not run after-only commands during before capture", async () => {
    assert.equal(await capture(new CommandEvidenceProvider(config()), "before"), null);
  });
});

describe("required command verification", () => {
  it("contradicts a completed report when a required command failed", () => {
    const result = verifyRoundEvaluation(evaluation(), 1, [], null, [{
      provider: "command:test",
      timestamp: Date.now(),
      files: [],
      data: { kind: "command", commandName: "test", required: true, status: "failed" },
    }]);
    assert.equal(result.verdict, "contradicted");
    assert.ok(result.flags.some((flag) => flag.check === "required_command_failed"));
  });

  it("does not reject an optional command failure by itself", () => {
    const result = verifyRoundEvaluation(evaluation(), 1, [], null, [{
      provider: "command:optional",
      timestamp: Date.now(),
      files: [],
      data: { kind: "command", commandName: "optional", required: false, status: "failed" },
    }]);
    assert.ok(!result.flags.some((flag) => flag.check === "required_command_failed"));
  });
});
