/** v3.8 — static/observed verification capability. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  capabilityWarnings,
  deriveEvidenceCapability,
  deriveObservedCapability,
  isPassedAfterObservation,
  registerEvidenceProvider,
  unregisterEvidenceProvider,
} from "../evidence-provider.js";
import { commandConfigHash, deriveConfiguredCapability, DEFAULT_POLICY } from "../policy.js";
import type { CommandObservation, MachineObservation } from "../protocol.js";
import type { LoopPolicy } from "../policy.js";

function policy(overrides: Partial<LoopPolicy["evidence"]> = {}): LoopPolicy {
  return {
    ...DEFAULT_POLICY,
    evidence: { ...DEFAULT_POLICY.evidence, ...overrides },
  };
}

const command = {
  name: "verify",
  enabled: true,
  executable: "node",
  args: ["-e", "process.exit(0)"],
  phase: "after" as const,
  required: true,
  timeout_ms: 5000,
  max_output_chars: 2000,
  success_exit_codes: [0],
};

function commandObservation(
  status: CommandObservation["status"],
  overrides: Partial<CommandObservation["data"]> = {},
): CommandObservation {
  return {
    schemaVersion: 1,
    providerId: "command:verify",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      commandId: "verify",
      argv: ["node", "-e", "process.exit(0)"],
      cwd: ".",
      configHash: "abc",
      required: true,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
      ...overrides,
    },
  };
}

describe("v3.8 — ConfiguredCapability", () => {
  it("is a pure function of policy (stable across calls)", () => {
    const p = policy({ providers: ["git"], commands: [command] });
    assert.deepEqual(deriveConfiguredCapability(p), deriveConfiguredCapability(p));
  });

  it("reports observation and contract-verification availability", () => {
    const configured = deriveConfiguredCapability(policy({ providers: ["git"], commands: [command] }));
    assert.equal(configured.observationConfigured, true);
    assert.equal(configured.contractVerificationAvailable, true);
    assert.equal(configured.providers[0].providerId, "git");
    assert.equal(configured.commands[0].commandId, "verify");
    assert.equal(configured.commands[0].configHash, commandConfigHash(command));
  });

  it("reports a loop with no providers or commands", () => {
    const configured = deriveConfiguredCapability(policy({ providers: [], commands: [] }));
    assert.equal(configured.observationConfigured, false);
    assert.equal(configured.contractVerificationAvailable, false);
  });

  it("ignores disabled commands for verification availability", () => {
    const configured = deriveConfiguredCapability(
      policy({ providers: ["git"], commands: [{ ...command, enabled: false }] }),
    );
    assert.equal(configured.contractVerificationAvailable, false);
  });

  it("hashes equivalent configs equally and changed configs differently", () => {
    assert.equal(
      commandConfigHash({ ...command, success_exit_codes: [1, 0] }),
      commandConfigHash({ ...command, success_exit_codes: [0, 1] }),
      "exit-code order must not matter",
    );
    assert.notEqual(
      commandConfigHash(command),
      commandConfigHash({ ...command, args: ["-e", "process.exit(1)"] }),
      "args order/content is meaningful",
    );
    assert.notEqual(
      commandConfigHash(command),
      commandConfigHash({ ...command, required: false }),
    );
  });
});

describe("v3.8 — ObservedCapability and warnings", () => {
  it("derives the latest status per provider and command", () => {
    const configured = deriveConfiguredCapability(policy({ providers: ["git"], commands: [command] }));
    const observations: MachineObservation[] = [
      {
        schemaVersion: 1, providerId: "git", kind: "git", phase: "after",
        startedAt: 0, finishedAt: 0, status: "observed", files: [],
        data: { tracked: [], staged: [], untracked: [], fingerprints: {} },
      },
      commandObservation("passed"),
    ];
    const observed = deriveObservedCapability(observations, configured);
    assert.equal(observed.providers[0].status, "observed");
    assert.equal(observed.commands[0].status, "passed");
    assert.equal(observed.commands[0].configHash, "abc");
  });

  it("marks unobserved entries unavailable", () => {
    const configured = deriveConfiguredCapability(policy({ providers: ["git"], commands: [command] }));
    const observed = deriveObservedCapability([], configured);
    assert.equal(observed.providers[0].status, "unavailable");
    assert.equal(observed.commands[0].status, "unavailable");
    // The declared config hash is still reported so a mismatch is visible.
    assert.equal(observed.commands[0].configHash, commandConfigHash(command));
  });

  it("warns when nothing can be observed or verified", () => {
    const configured = deriveConfiguredCapability(policy({ providers: [], commands: [] }));
    const warnings = capabilityWarnings(configured);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((warning) => warning.includes("No evidence provider")));
    assert.ok(warnings.some((warning) => warning.includes("No enabled verification command")));
  });

  it("warns when a configured provider produced no observation", () => {
    const configured = deriveConfiguredCapability(policy({ providers: ["git"], commands: [command] }));
    const observed = deriveObservedCapability([
      {
        schemaVersion: 1, providerId: "git", kind: "custom", phase: "after",
        startedAt: 0, finishedAt: 0, status: "unavailable", files: [],
        data: { detail: "git is not a repository" },
      },
    ], configured);
    const warnings = capabilityWarnings(configured, observed);
    assert.ok(warnings.some((warning) => warning.includes("Evidence provider(s) unavailable: git")));
  });
});

describe("v3.8 — the single machine-backed predicate", () => {
  it("accepts only after-phase passed commands", () => {
    assert.equal(isPassedAfterObservation(commandObservation("passed"), null), true);
    assert.equal(isPassedAfterObservation(commandObservation("failed"), null), false);
    assert.equal(
      isPassedAfterObservation({ ...commandObservation("passed"), phase: "before" }, null),
      false,
      "a before-phase baseline is never evidence",
    );
  });

  it("excludes a command whose entrypoint changed this round", () => {
    const observation = commandObservation("passed", { entrypointFiles: ["package.json"] });
    assert.equal(isPassedAfterObservation(observation, new Set(["package.json"])), false);
    assert.equal(isPassedAfterObservation(observation, new Set(["src/a.ts"])), true);
    assert.equal(
      isPassedAfterObservation(observation, null),
      true,
      "no git delta → the entrypoint arm fails open",
    );
  });

  it("never treats non-command observations as machine-backed", () => {
    const git: MachineObservation = {
      schemaVersion: 1, providerId: "git", kind: "git", phase: "after",
      startedAt: 0, finishedAt: 0, status: "passed", files: [],
      data: { tracked: [], staged: [], untracked: [], fingerprints: {} },
    };
    assert.equal(isPassedAfterObservation(git, null), false);
  });
});

describe("v3.8 — EvidenceCapability (the prepared round's single fact)", () => {
  it("unions the hashed half with the rendered half", () => {
    const capability = deriveEvidenceCapability(
      policy({ providers: ["git", "ghost"], commands: [command] }),
    );
    assert.equal(capability.schemaVersion, 1);
    assert.deepEqual(
      capability.providers.map((provider) => [provider.providerId, provider.available]),
      [["git", true], ["ghost", false]],
      "`available` is provider-registry state — reported, never hashed",
    );
    assert.deepEqual(capability.providers.map((provider) => provider.status), ["unavailable", "unavailable"]);
    assert.equal(capability.commands[0].commandId, "verify");
    assert.equal(capability.commands[0].ready, true);
    assert.equal(capability.contractVerificationAvailable, true);
  });

  it("reports the live provider status from the baseline observations", () => {
    const git: MachineObservation = {
      schemaVersion: 1, providerId: "git", kind: "git", phase: "before",
      startedAt: 0, finishedAt: 0, status: "observed", files: ["src/a.ts"],
      data: { tracked: ["src/a.ts"], staged: [], untracked: [], fingerprints: {} },
    };
    const withBaseline = deriveEvidenceCapability(policy({ providers: ["git"] }), [git]);
    assert.equal(withBaseline.providers[0].status, "observed");
    assert.equal(deriveEvidenceCapability(policy({ providers: ["git"] })).providers[0].status,
      "unavailable",
      "no baseline yet → nothing has been observed this round");
  });

  it("carries the capability warnings so start/resume/status share one voice", () => {
    const bare = deriveEvidenceCapability(policy({ providers: [], commands: [] }));
    assert.equal(bare.warnings.length, 2);
    assert.deepEqual(bare.warnings, capabilityWarnings(
      deriveConfiguredCapability(policy({ providers: [], commands: [] })),
      deriveObservedCapability([], deriveConfiguredCapability(policy({ providers: [], commands: [] }))),
    ));
  });

  it("marks an unregistered configured provider unavailable in its own observation", () => {
    registerEvidenceProvider("cap-test", () => ({
      name: "cap-test", kind: "custom",
      capture: () => commandObservation("passed"),
    }));
    try {
      const capability = deriveEvidenceCapability(policy({ providers: ["cap-test", "ghost"] }));
      assert.deepEqual(
        capability.providers.map((provider) => provider.available),
        [true, false],
      );
    } finally {
      unregisterEvidenceProvider("cap-test");
    }
  });
});
