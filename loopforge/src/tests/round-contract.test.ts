/** v3.8 — Round Contract identity and the active-contract walker. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activateContract,
  contractCriterionIds,
  deriveActiveRoundContract,
  sameContract,
} from "../round-contract.js";
import { deriveContractId, deriveContractItemId, deriveContractItemIds } from "../token-utils.js";
import type { CommittedRoundView } from "../committed-round.js";
import type {
  ContractBinding,
  MachineObservation,
  RoundContractProposal,
  RoundOutcome,
} from "../protocol.js";
import type { CommandEvidencePolicy } from "../policy.js";

const COMMAND: CommandEvidencePolicy = {
  name: "run-tests",
  enabled: true,
  executable: "node",
  args: ["-e", "process.exit(0)"],
  phase: "after",
  required: true,
  timeout_ms: 5000,
  max_output_chars: 2000,
  success_exit_codes: [0],
};

function proposal(overrides: Partial<RoundContractProposal> = {}): RoundContractProposal {
  return {
    work_item: "Implement auth",
    scope: ["src/auth"],
    items: [{ description: "login works", criterion_refs: ["cr-11111111"], subgoal_refs: [], verify_with: ["run-tests"] }],
    ...overrides,
  };
}

function bindingFor(value: RoundContractProposal, loopId: string): ContractBinding {
  const hashes: Record<string, string> = {};
  for (const item of value.items) {
    for (const commandId of item.verify_with) hashes[commandId] = "hash-1";
  }
  return {
    rc_id: deriveContractId(loopId, value),
    item_ids: deriveContractItemIds(value.items),
    config_hash_by_command: hashes,
  };
}

function commandObservation(
  status: "passed" | "failed",
  configHash = "hash-1",
  files: string[] = [],
  commandId = "run-tests",
): MachineObservation {
  return {
    schemaVersion: 1,
    providerId: `command:${commandId}`,
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      commandId,
      argv: ["node", "-e", "process.exit(0)"],
      cwd: ".",
      configHash,
      required: true,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: files,
    },
  };
}

function round(
  number: number,
  opts: {
    contract?: RoundContractProposal;
    outcome?: RoundOutcome;
    claims?: Array<{ item_id: string; outcome: "met" | "remaining" }>;
    observations?: MachineObservation[];
    loopId?: string;
  } = {},
): CommittedRoundView {
  const loopId = opts.loopId ?? "cc";
  const contract = opts.contract;
  return {
    source: "feedback",
    sourceEntry: {},
    loopId,
    round: number,
    roundId: `loop:${loopId}:round:${number}`,
    attempt: 1,
    promptArtifact: null,
    evaluation: null,
    executionReport: opts.claims
      ? { contract_item_claims: opts.claims }
      : null,
    verificationFlags: [],
    result: null,
    action: "continue",
    success: false,
    outcome: opts.outcome ?? null,
    contractProposal: contract ?? null,
    contractBinding: contract ? bindingFor(contract, loopId) : null,
    beforeEvidence: [],
    afterEvidence: opts.observations ?? [],
    observationDelta: opts.observations ?? [],
    evidenceIncomplete: false,
    backtrack: null,
  };
}

describe("v3.8 — contract identity", () => {
  it("derives the same id for the same content and different ids otherwise", () => {
    const base = proposal();
    assert.equal(deriveContractId("cc", base), deriveContractId("cc", proposal()));
    assert.notEqual(deriveContractId("cc", base), deriveContractId("other", base));
    assert.notEqual(
      deriveContractId("cc", base),
      deriveContractId("cc", proposal({ work_item: "Something else" })),
    );
  });

  it("keeps item ids stable when unrelated proposal fields change", () => {
    const base = proposal();
    const edited = proposal({ work_item: "Renamed", scope: ["src/auth", "src/db"] });
    assert.deepEqual(deriveContractItemIds(base.items), deriveContractItemIds(edited.items));
    assert.notEqual(deriveContractId("cc", base), deriveContractId("cc", edited));
  });

  it("gives identical item text distinct ids through the duplicate ordinal", () => {
    const item = { description: "same", criterion_refs: [], subgoal_refs: [], verify_with: [] };
    const ids = deriveContractItemIds([item, item]);
    assert.equal(new Set(ids).size, 2);
    assert.equal(ids[0], deriveContractItemId(item, 0));
    assert.equal(ids[1], deriveContractItemId(item, 1));
  });

  it("treats a restate as the same contract and a rewrite as a different one", () => {
    assert.equal(sameContract(proposal(), proposal()), true);
    assert.equal(sameContract(proposal(), proposal({ work_item: "Changed" })), false);
  });

  it("normalizes case and whitespace in identity", () => {
    const a = proposal({ work_item: "Implement  AUTH" });
    const b = proposal({ work_item: "implement auth" });
    assert.equal(deriveContractId("cc", a), deriveContractId("cc", b));
  });
});

describe("v3.8 — active contract walker", () => {
  it("activates a proposal only after its declaring round commits", () => {
    const contract = proposal();
    assert.equal(deriveActiveRoundContract([], [COMMAND]), null);
    const active = deriveActiveRoundContract([round(1, { contract })], [COMMAND]);
    assert.equal(active?.id, deriveContractId("cc", contract));
    assert.equal(active?.declared_at_round, 1);
    assert.equal(active?.config_hash_by_command["run-tests"], "hash-1");
  });

  it("closes when every item is verified and activates the closing round's proposal", () => {
    const first = proposal();
    const itemId = deriveContractItemIds(first.items)[0];
    const second = proposal({ work_item: "Next slice" });
    const active = deriveActiveRoundContract([
      round(1, { contract: first }),
      round(2, {
        contract: second,
        claims: [{ item_id: itemId, outcome: "met" }],
        observations: [commandObservation("passed")],
      }),
    ], [COMMAND]);
    assert.equal(active?.work_item, "Next slice");
  });

  it("keeps the active contract open while an item is unverified", () => {
    const first = proposal();
    const itemId = deriveContractItemIds(first.items)[0];
    const active = deriveActiveRoundContract([
      round(1, { contract: first }),
      round(2, {
        contract: proposal({ work_item: "Ignored" }),
        claims: [{ item_id: itemId, outcome: "met" }],
        observations: [commandObservation("failed")],
      }),
    ], [COMMAND]);
    assert.equal(active?.work_item, "Implement auth", "the replacement is ignored");
  });

  it("closes on a blocked outcome", () => {
    const first = proposal();
    const active = deriveActiveRoundContract([
      round(1, { contract: first }),
      round(2, { outcome: "blocked", contract: proposal({ work_item: "After block" }) }),
    ], [COMMAND]);
    assert.equal(active?.work_item, "After block");
  });

  it("exposes the criterion ids its items reference", () => {
    const active = activateContract(proposal(), 1, null, "cc");
    assert.deepEqual(contractCriterionIds(active), ["cr-11111111"]);
  });

  it("v3.8.1: a later failing observation overturns an earlier pass", () => {
    // "every bound command observed passing in the CLOSING round" only holds
    // if the latest observation decides. Scanning forward let the round-2 pass
    // outlive the round-3 failure: the item stayed `verified`, the contract
    // closed, and the machine's own denial of the claim was never read.
    //
    // Two items on two commands, so the contract is still OPEN when the later
    // failure arrives — a single-item contract closes at round 2 and would
    // never reach the round being tested.
    const E2E: CommandEvidencePolicy = { ...COMMAND, name: "e2e" };
    const twoItems = proposal({
      items: [
        { description: "login works", criterion_refs: [], subgoal_refs: [], verify_with: ["run-tests"] },
        { description: "signup works", criterion_refs: [], subgoal_refs: [], verify_with: ["e2e"] },
      ],
    });
    const [loginId, signupId] = deriveContractItemIds(twoItems.items);
    const active = deriveActiveRoundContract([
      round(1, { contract: twoItems }),
      round(2, {
        claims: [{ item_id: loginId!, outcome: "met" }],
        observations: [commandObservation("passed")],
      }),
      round(3, {
        contract: proposal({ work_item: "Next slice" }),
        claims: [{ item_id: signupId!, outcome: "met" }],
        observations: [
          commandObservation("passed", "hash-1", [], "e2e"),
          commandObservation("failed", "hash-1", [], "run-tests"),
        ],
      }),
    ], [COMMAND, E2E]);
    assert.equal(active?.work_item, "Implement auth",
      "the bound command failed in the closing round — the item cannot stay verified");
  });

  it("v3.8.1: a malformed command observation cannot crash the shared derivation", () => {
    // deriveRoundContractView is called by the compile path, the projection,
    // the coordinator, explain and audit. A hand-written or externally written
    // round document that the transaction parser accepts must not take all of
    // them down with a TypeError.
    const first = proposal();
    const itemId = deriveContractItemIds(first.items)[0];
    const malformed = commandObservation("passed");
    delete (malformed.data as Record<string, unknown>).entrypointFiles;
    const git: MachineObservation = {
      schemaVersion: 1,
      providerId: "git",
      kind: "git",
      phase: "after",
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: ["scripts/run-tests.sh"],
      data: { tracked: [], staged: [], untracked: [], fingerprints: {} },
    };
    assert.doesNotThrow(() => deriveActiveRoundContract([
      round(1, { contract: first }),
      round(2, {
        claims: [{ item_id: itemId, outcome: "met" }],
        observations: [git, malformed],
      }),
    ], [COMMAND]));
  });
});
