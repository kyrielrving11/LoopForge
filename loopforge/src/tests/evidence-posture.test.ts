/** v4.0.3: the evidence-posture judgment table, ordering and caps.
 *
 *  These tests pin the ONE derivation every read surface consumes. The rules
 *  under test are the release invariants: contradicted outranks everything,
 *  unknown never degrades to verified/empty, a success claim needs machine
 *  backing, and the display caps never change the status decision.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_POSTURE_CAPS,
  deriveEvidencePosture,
  rollbackEvidencePosture,
  type EvidencePostureInput,
} from "../evidence-posture.js";
import type {
  CommandObservation,
  CustomObservation,
  GitObservation,
  MachineObservation,
  SelfEvaluation,
  VerificationFlag,
} from "../protocol.js";
import { makeSelfEvaluation, makeVerificationFlag } from "../protocol.js";
import type { ObservationDelta } from "../evidence-provider.js";
import type { ContractItemStatusView, ItemStatusRecord } from "../contract-items.js";
import type { ActiveContractView } from "../round-contract.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

function gitObservation(): GitObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase: "after",
    startedAt: 1,
    finishedAt: 2,
    status: "observed",
    files: [],
    data: {
      dirty: [],
      fingerprints: {},
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

function commandObservation(
  commandId: string,
  status: CommandObservation["status"],
  required = false,
): CommandObservation {
  return {
    schemaVersion: 1,
    providerId: `command:${commandId}`,
    kind: "command",
    phase: "after",
    startedAt: 1,
    finishedAt: 2,
    status,
    files: [],
    data: {
      commandId,
      argv: ["node", "verify.js"],
      cwd: ".",
      configHash: "hash",
      required,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdoutSha256: "",
      stderrSha256: "",
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
    },
  };
}

function customObservation(
  providerId: string,
  status: CustomObservation["status"],
): CustomObservation {
  return {
    schemaVersion: 1,
    providerId,
    kind: "custom",
    phase: "after",
    startedAt: 1,
    finishedAt: 2,
    status,
    files: [],
    data: {},
  };
}

function delta(
  observation: MachineObservation,
  changedFiles: string[] | null = null,
): ObservationDelta {
  return {
    providerId: observation.providerId,
    kind: observation.kind,
    before: null,
    after: observation,
    changedFiles,
    progress: null,
  };
}

function claim(overrides: Partial<SelfEvaluation> = {}): SelfEvaluation {
  return makeSelfEvaluation({
    success: true,
    output_summary: "did work",
    constraint_violations: [],
    should_continue: true,
    ...overrides,
  });
}

const EMPTY_STATUSES: ContractItemStatusView = {
  contractId: "",
  closure: "open",
  closed_at_round: null,
  items: [],
  verifiedCount: 0,
  contradictedCount: 0,
  insufficientCount: 0,
};

function item(
  id: string,
  status: ItemStatusRecord["status"],
  reasons: string[] = [],
): ItemStatusRecord {
  return {
    itemId: id,
    description: `item ${id}`,
    status,
    status_at_round: 1,
    history: [],
    reasons,
  };
}

function statuses(
  overrides: Partial<ContractItemStatusView>,
): ContractItemStatusView {
  return { ...EMPTY_STATUSES, ...overrides };
}

function activeContract(
  items: Array<{ id: string; criterionRefs?: string[] }>,
): ActiveContractView {
  return {
    id: "rc-00000001",
    declared_at_round: 1,
    work_item: "slice",
    scope: [],
    items: items.map((entry) => ({
      id: entry.id,
      description: `item ${entry.id}`,
      criterion_refs: entry.criterionRefs ?? [],
      verify_with: ["verify"],
    })),
    config_hash_by_command: { verify: "hash" },
  };
}

function input(overrides: Partial<EvidencePostureInput> = {}): EvidencePostureInput {
  return {
    round: 1,
    kind: "evaluation",
    selfEval: null,
    afterEvidence: [],
    evidenceDeltas: [],
    verificationFlags: [],
    machineBackedSuccess: false,
    activeContract: null,
    contractStatuses: EMPTY_STATUSES,
    verificationConfigured: false,
    filesReconciliation: null,
    ...overrides,
  };
}

// ── Judgment table ─────────────────────────────────────────────────────────

describe("deriveEvidencePosture — judgment table", () => {
  it("a rollback directive is not_applicable and fabricates nothing", () => {
    const posture = deriveEvidencePosture(input({
      round: 4,
      kind: "rollback",
      selfEval: claim({ success: true }),
      verificationFlags: [makeVerificationFlag({
        severity: "error",
        field: "success",
        check: "boom",
        detail: "boom",
      })],
      machineBackedSuccess: true,
    }));
    assert.deepEqual(posture, rollbackEvidencePosture(4));
    assert.equal(posture.status, "not_applicable");
    assert.equal(posture.machineBackedSuccess, false);
    assert.equal(posture.verificationConfigured, false);
    assert.equal(posture.workspace.status, "not_applicable");
    assert.equal(posture.files, null);
    assert.deepEqual(posture.providers, []);
    assert.deepEqual(posture.commands, []);
    assert.equal(posture.contract, null);
    assert.deepEqual(posture.findings, []);
  });

  it("no claim, no contract and no verification capability is not_applicable", () => {
    const posture = deriveEvidencePosture(input({
      selfEval: claim({ success: false }),
      afterEvidence: [commandObservation("verify", "passed")],
      evidenceDeltas: [delta(commandObservation("verify", "passed"))],
    }));
    assert.equal(posture.status, "not_applicable");
    // A passed command stays a listed fact; it does not turn the round into
    // "verified".
    assert.deepEqual(posture.commands, [
      { commandId: "verify", status: "passed", required: false },
    ]);
  });

  it("a fully verified contract with no success claim is verified coverage", () => {
    const contract = activeContract([{ id: "rci-00000001", criterionRefs: ["cr-00000001"] }]);
    const posture = deriveEvidencePosture(input({
      selfEval: claim({ success: false }),
      activeContract: contract,
      contractStatuses: statuses({
        contractId: contract.id,
        closure: "verified",
        items: [item("rci-00000001", "verified")],
        verifiedCount: 1,
      }),
      afterEvidence: [commandObservation("verify", "passed")],
      evidenceDeltas: [delta(commandObservation("verify", "passed"))],
    }));
    assert.equal(posture.status, "verified");
    // Coverage is complete; the task itself was never claimed successful.
    assert.equal(posture.machineBackedSuccess, false);
  });

  it("a success claim with no verification capability is insufficient", () => {
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
    }));
    assert.equal(posture.status, "insufficient");
    assert.equal(posture.verificationConfigured, false);
  });

  it("a success claim backed by the verification gate is verified", () => {
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      machineBackedSuccess: true,
      afterEvidence: [commandObservation("verify", "passed")],
      evidenceDeltas: [delta(commandObservation("verify", "passed"))],
      verificationConfigured: true,
    }));
    assert.equal(posture.status, "verified");
    assert.equal(posture.machineBackedSuccess, true);
  });

  it("a passed command does not back a claim the gate rejected", () => {
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      machineBackedSuccess: false,
      afterEvidence: [commandObservation("verify", "passed")],
      evidenceDeltas: [delta(commandObservation("verify", "passed"))],
      verificationConfigured: true,
    }));
    assert.equal(posture.status, "insufficient");
  });

  it("a failed after command is contradicted", () => {
    const failed = commandObservation("verify", "failed");
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      afterEvidence: [failed],
      evidenceDeltas: [delta(failed)],
      verificationConfigured: true,
    }));
    assert.equal(posture.status, "contradicted");
  });

  it("an error-level finding outranks a verified contract closure", () => {
    const contract = activeContract([{ id: "rci-00000001" }]);
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      activeContract: contract,
      contractStatuses: statuses({
        contractId: contract.id,
        closure: "verified",
        items: [item("rci-00000001", "verified")],
        verifiedCount: 1,
      }),
      machineBackedSuccess: true,
      verificationFlags: [makeVerificationFlag({
        severity: "error",
        field: "execution_report",
        check: "verification_entrypoint_modified",
        detail: "entrypoint changed",
        ref: "verify",
      })],
    }));
    assert.equal(posture.status, "contradicted");
    assert.equal(posture.findings.length, 1);
    assert.match(posture.findings[0]!.id, /^f-[a-f0-9]{8}$/);
  });

  it("a contradicted contract item is contradicted", () => {
    const contract = activeContract([{ id: "rci-00000001" }]);
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      activeContract: contract,
      contractStatuses: statuses({
        contractId: contract.id,
        closure: "open",
        items: [item("rci-00000001", "contradicted", ["command failed"])],
        contradictedCount: 1,
      }),
    }));
    assert.equal(posture.status, "contradicted");
    assert.equal(posture.contract?.contradictedCount, 1);
  });

  it("a timeout/unavailable/error/aborted observation is unknown, never a pass", () => {
    for (const status of ["timeout", "unavailable", "error", "aborted"] as const) {
      const observation = customObservation("probe", status);
      const posture = deriveEvidencePosture(input({
        selfEval: claim(),
        afterEvidence: [observation],
        evidenceDeltas: [delta(observation)],
      }));
      assert.equal(posture.status, "unknown", `status ${status}`);
    }
  });

  it("an unobservable workspace with an active contract is unknown", () => {
    const contract = activeContract([{ id: "rci-00000001" }]);
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      activeContract: contract,
      contractStatuses: statuses({
        contractId: contract.id,
        items: [item("rci-00000001", "pending")],
      }),
      afterEvidence: [gitObservation()],
      evidenceDeltas: [delta(gitObservation(), null)],
      verificationConfigured: true,
    }));
    assert.equal(posture.status, "unknown");
    assert.deepEqual(posture.workspace, { status: "unknown", changedPathCount: 0 });
  });

  it("configured verification with no after command observation is unknown", () => {
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      verificationConfigured: true,
    }));
    assert.equal(posture.status, "unknown");
  });

  it("a contract still open or blocked is insufficient", () => {
    for (const closure of ["open", "blocked", "superseded"] as const) {
      const contract = activeContract([{ id: "rci-00000001" }]);
      const posture = deriveEvidencePosture(input({
        selfEval: claim(),
        activeContract: contract,
        contractStatuses: statuses({
          contractId: contract.id,
          closure,
          items: [item("rci-00000001", "insufficient")],
          insufficientCount: 1,
        }),
        verificationConfigured: true,
        afterEvidence: [commandObservation("verify", "passed")],
        evidenceDeltas: [delta(commandObservation("verify", "passed"))],
      }));
      assert.equal(posture.status, "insufficient", `closure ${closure}`);
    }
  });
});

// ── Projection details ─────────────────────────────────────────────────────

describe("deriveEvidencePosture — projection", () => {
  it("projects the committed Git change count and agent-file reconciliation", () => {
    const git = gitObservation();
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      machineBackedSuccess: true,
      verificationConfigured: true,
      afterEvidence: [git, commandObservation("verify", "passed")],
      evidenceDeltas: [delta(git, ["a.ts", "b.ts"]), delta(commandObservation("verify", "passed"))],
      filesReconciliation: {
        status: "mismatch",
        reported: ["a.ts"],
        observed: ["a.ts", "b.ts"],
      },
    }));
    assert.deepEqual(posture.workspace, { status: "observed", changedPathCount: 2 });
    assert.deepEqual(posture.files, {
      reconciliation: "mismatch",
      reported: 1,
      observed: 2,
    });
  });

  it("orders providers, commands, contract items and findings deterministically", () => {
    const contract = activeContract([
      { id: "rci-00000002", criterionRefs: ["cr-00000002"] },
      { id: "rci-00000001", criterionRefs: ["cr-00000001"] },
    ]);
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      activeContract: contract,
      contractStatuses: statuses({
        contractId: contract.id,
        items: [
          item("rci-00000002", "insufficient", ["z", "z", "y", "x"]),
          item("rci-00000001", "verified"),
        ],
        verifiedCount: 1,
        insufficientCount: 1,
      }),
      afterEvidence: [
        commandObservation("zeta", "passed"),
        commandObservation("alpha", "passed"),
        customObservation("custom-b", "observed"),
        gitObservation(),
        customObservation("custom-a", "observed"),
      ],
      evidenceDeltas: [delta(gitObservation(), [])],
      verificationFlags: [
        makeVerificationFlag({ severity: "info", field: "f", check: "z-check", detail: "z" }),
        makeVerificationFlag({ severity: "error", field: "f", check: "b-check", detail: "b" }),
        makeVerificationFlag({ severity: "warn", field: "f", check: "a-check", detail: "a" }),
        makeVerificationFlag({ severity: "error", field: "f", check: "a-check", detail: "a" }),
      ],
    }));
    assert.deepEqual(posture.providers.map((entry) => entry.providerId), [
      "git", "custom-a", "custom-b",
    ]);
    assert.deepEqual(posture.commands.map((entry) => entry.commandId), ["alpha", "zeta"]);
    assert.deepEqual(posture.contract?.items.map((entry) => entry.id), [
      "rci-00000001", "rci-00000002",
    ]);
    // Reasons are deduped and capped to two; criterion refs come from the
    // active contract item.
    assert.deepEqual(posture.contract?.items[1]?.reasons, ["z", "y"]);
    assert.deepEqual(posture.contract?.items[0]?.criterionRefs, ["cr-00000001"]);
    // The warn and error findings for the same subject share one stable id;
    // the stronger severity wins rather than being hidden by insertion order.
    assert.deepEqual(posture.findings.map((entry) => [entry.severity, entry.check]), [
      ["error", "a-check"],
      ["error", "b-check"],
      ["info", "z-check"],
    ]);
  });

  it("caps display arrays but computes status and counts from the full data", () => {
    const items: ItemStatusRecord[] = [];
    for (let index = 0; index < EVIDENCE_POSTURE_CAPS.contractItems + 1; index++) {
      // The only contradicted item sorts after the cap boundary, so a status
      // derived from the capped list would silently become non-contradicted.
      const id = `rci-${index.toString(16).padStart(8, "0")}`;
      items.push(item(id, index === EVIDENCE_POSTURE_CAPS.contractItems
        ? "contradicted"
        : "verified"));
    }
    const commands: CommandObservation[] = [];
    for (let index = 0; index < EVIDENCE_POSTURE_CAPS.commands + 2; index++) {
      commands.push(commandObservation(`command-${String(index).padStart(2, "0")}`, "passed"));
    }
    const providers: MachineObservation[] = [];
    for (let index = 0; index < EVIDENCE_POSTURE_CAPS.providers + 3; index++) {
      providers.push(customObservation(`probe-${String(index).padStart(2, "0")}`, "observed"));
    }
    const flags: VerificationFlag[] = [];
    for (let index = 0; index < EVIDENCE_POSTURE_CAPS.findings + 5; index++) {
      flags.push(makeVerificationFlag({
        severity: "warn",
        field: "f",
        check: `check-${String(index).padStart(2, "0")}`,
        detail: "d",
      }));
    }
    const contract = activeContract(items.map((entry) => ({ id: entry.itemId })));
    const posture = deriveEvidencePosture(input({
      selfEval: claim(),
      activeContract: contract,
      contractStatuses: statuses({
        contractId: contract.id,
        closure: "open",
        items,
        verifiedCount: EVIDENCE_POSTURE_CAPS.contractItems,
        contradictedCount: 1,
      }),
      afterEvidence: [...providers, ...commands],
      evidenceDeltas: [delta(gitObservation(), [])],
      verificationFlags: flags,
      verificationConfigured: true,
    }));
    assert.equal(posture.status, "contradicted");
    assert.equal(posture.providers.length, EVIDENCE_POSTURE_CAPS.providers);
    assert.equal(posture.commands.length, EVIDENCE_POSTURE_CAPS.commands);
    assert.equal(posture.contract?.items.length, EVIDENCE_POSTURE_CAPS.contractItems);
    assert.equal(posture.findings.length, EVIDENCE_POSTURE_CAPS.findings);
    assert.deepEqual(posture.omitted, {
      providers: 3,
      commands: 2,
      contractItems: 1,
      findings: 5,
    });
    assert.equal(posture.contract?.pendingCount, 0);
  });

  it("is deterministic for the same transaction facts", () => {
    const facts = input({
      selfEval: claim(),
      machineBackedSuccess: true,
      verificationConfigured: true,
      afterEvidence: [
        customObservation("probe", "observed"),
        gitObservation(),
        commandObservation("verify", "passed"),
      ],
      evidenceDeltas: [delta(gitObservation(), ["a.ts"])],
      verificationFlags: [makeVerificationFlag({
        severity: "warn",
        field: "success",
        check: "success_without_verified_evidence",
        detail: "d",
        ref: "verify",
      })],
      filesReconciliation: { status: "match", reported: ["a.ts"], observed: ["a.ts"] },
    });
    assert.deepEqual(deriveEvidencePosture(facts), deriveEvidencePosture(facts));
    assert.equal(
      JSON.stringify(deriveEvidencePosture(facts)),
      JSON.stringify(deriveEvidencePosture(facts)),
    );
  });
});
