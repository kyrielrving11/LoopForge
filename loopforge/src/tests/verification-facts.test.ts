/** v3.8 — the derived verification view: verified sub-goal facts, the round
 *  verification posture, and the verification debt that reaches the handoff. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveVerificationDebt,
  deriveVerifiedSubGoals,
} from "../cognitive-facts.js";
import { deriveActiveRoundContract } from "../round-contract.js";
import { NO_IN_FLIGHT_ROUND, deriveRoundFacts } from "../round-facts.js";
import { deriveContractItemStatuses } from "../contract-items.js";
import type { ContractItemStatusView } from "../contract-items.js";
import type { CommandObservation, RoundContractProposal, SubGoal } from "../protocol.js";
import type { CommittedRoundView } from "../committed-round.js";
import type { CommandEvidencePolicy } from "../policy.js";

const COMMAND: CommandEvidencePolicy = {
  name: "verify",
  enabled: true,
  executable: "node",
  args: ["-e", "verify"],
  phase: "after",
  required: true,
  timeout_ms: 5000,
  max_output_chars: 2000,
  success_exit_codes: [0],
};

const CONTRACT: RoundContractProposal = {
  work_item: "Slice A",
  scope: ["src/a"],
  items: [{
    description: "login works",
    criterion_refs: ["cr-11111111"],
    subgoal_refs: ["sg-11111111"],
    verify_with: ["verify"],
  }],
};

/** The round that declares the contract — activation requires a commit. */
function declaringRound(): CommittedRoundView {
  return {
    source: "feedback", sourceEntry: {}, loopId: "vf-loop", round: 1,
    roundId: "loop:vf-loop:round:1", attempt: 1, promptArtifact: null,
    evaluation: null, executionReport: null, verificationFlags: [], result: null,
    action: "continue", success: false, outcome: null,
    contractProposal: CONTRACT,
    contractBinding: { rc_id: "rc-aaaaaaaa", item_ids: [], config_hash_by_command: {} },
    beforeEvidence: [], afterEvidence: [], observationDelta: [], evidenceIncomplete: false,
    backtrack: null,
  };
}

/** A COMMITTED round that claims the contract's item `met` and carries the
 *  passing command observation — the shape machine verification leaves in
 *  history. */
function verifyingRound(): CommittedRoundView {
  return {
    ...declaringRound(),
    round: 2,
    roundId: "loop:vf-loop:round:2",
    contractProposal: null,
    executionReport: { contract_item_claims: [{ item_id: itemId(), outcome: "met" }] },
    observationDelta: [commandObservation("passed")],
    outcome: "success",
    afterEvidence: [commandObservation("passed")],
    evidenceIncomplete: false,
  };
}

/** The in-flight round's report, applied to the ACTIVE contract. */
function statusesFor(
  currentRound: number,
  claims: Array<{ item_id: string; outcome: "met" | "remaining" }> | null,
  observations: CommandObservation[],
): ContractItemStatusView {
  const rounds = [declaringRound()];
  return deriveContractItemStatuses({
    contract: deriveActiveRoundContract(rounds, [COMMAND]),
    rounds,
    currentRound,
    currentReport: claims ? { contract_item_claims: claims } : null,
    currentObservations: observations,
    commands: [COMMAND],
  });
}

/** The contract's single item id, derived the same way the runtime does. */
function itemId(): string {
  return statusesFor(2, null, []).items[0].itemId;
}

function commandObservation(status: "passed" | "failed"): CommandObservation {
  return {
    schemaVersion: 1, providerId: "command:verify", kind: "command", phase: "after",
    startedAt: 0, finishedAt: 0, status, files: [],
    data: {
      commandId: "verify", argv: ["node", "-e", "verify"], cwd: ".",
      configHash: "0".repeat(64), required: true,
      exitCode: status === "passed" ? 0 : 1, signal: null, durationMs: 1,
      stdoutSha256: "0".repeat(64), stderrSha256: "0".repeat(64),
      stdoutExcerpt: "", stderrExcerpt: "", truncated: false, entrypointFiles: [],
    },
  };
}

function subGoal(id: string, description: string, status: SubGoal["status"]): SubGoal {
  return { id, description, status, declared_at_round: 1, status_changed_at_round: 1, priority: 0 };
}

describe("v3.8 — verified sub-goal facts", () => {
  const facts = (rounds: CommittedRoundView[], subGoals: SubGoal[] = [
    subGoal("sg-11111111", "login works", "done"),
  ]) => deriveVerifiedSubGoals({ subGoals, rounds, commands: [COMMAND] });

  it("produces a fact when a verified item references the sub-goal", () => {
    const id = itemId();
    const statuses = statusesFor(2, [{ item_id: id, outcome: "met" }], [commandObservation("passed")]);
    assert.equal(statuses.verifiedCount, 1, "the bound command passed → verified");
    const result = facts([declaringRound(), verifyingRound()]);
    assert.equal(result.length, 1);
    assert.equal(result[0].subgoal_id, "sg-11111111");
    assert.deepEqual(result[0].contract_item_ids, [id]);
    assert.equal(result[0].verified_at_round, 2);
  });

  it("keeps the fact after its contract closes", () => {
    // The active contract disappears the moment its last item verifies. The
    // machine fact must not disappear with it — otherwise a sub-goal the
    // machine JUST verified is reported as verification debt.
    const rounds = [declaringRound(), verifyingRound()];
    assert.equal(deriveActiveRoundContract(rounds, [COMMAND]), null,
      "precondition: closure makes the contract inactive");
    assert.equal(facts(rounds).length, 1);
  });

  it("produces no fact while the item is unverified", () => {
    const statuses = statusesFor(2, [{ item_id: itemId(), outcome: "met" }], []);
    assert.equal(statuses.insufficientCount, 1);
    assert.deepEqual(
      facts([declaringRound()]),
      [],
      "an unverified claim never produces a machine fact",
    );
  });

  it("never writes SubGoal.status — the fact is a separate statement", () => {
    const goals = [subGoal("sg-11111111", "login works", "in_progress")];
    const result = facts([declaringRound(), verifyingRound()], goals);
    assert.equal(result.length, 1, "the machine fact exists");
    assert.equal(goals[0].status, "in_progress", "the lifecycle status is untouched");
  });

  it("ignores a sub-goal reference the loop never declared", () => {
    assert.deepEqual(facts([declaringRound(), verifyingRound()], []), []);
  });
});

describe("v3.8.1 — criterion machine facts", () => {
  const facts = (rounds: CommittedRoundView[]) => deriveRoundFacts({
    rounds,
    currentRound: 3,
    inFlight: NO_IN_FLIGHT_ROUND,
    subGoals: [],
    commands: [COMMAND],
  }).criterionFacts;

  it("keeps the criterion's machine status and links after its contract closes", () => {
    // The criterion side of the same fact the verified-sub-goal set keeps: it
    // was re-derived from the ACTIVE contract, so a fully verified contract
    // took the criterion's ✅ (and its `(related: sg-…)` links) with it — the
    // state file fell back to the agent's claim while the machine had already
    // decided.
    const rounds = [declaringRound(), verifyingRound()];
    assert.equal(deriveActiveRoundContract(rounds, [COMMAND]), null,
      "precondition: closure makes the contract inactive");
    const found = facts(rounds).find((fact) => fact.criterion_id === "cr-11111111");
    assert.ok(found, "the criterion fact must survive its contract closing");
    assert.equal(found!.status, "verified");
    assert.deepEqual(found!.related_subgoal_ids, ["sg-11111111"],
      "the explicit links travel with the status");
  });

  it("carries links but no status while the referencing item is pending", () => {
    // A declared item is machine knowledge about WHICH sub-goal the criterion
    // belongs to; `pending` is "no claim yet" and says nothing about the
    // criterion's own state, so the criterion keeps its claim-derived status.
    const found = facts([declaringRound()]).find((fact) => fact.criterion_id === "cr-11111111");
    assert.ok(found, "the declaration alone makes the criterion known");
    assert.equal(found!.status, undefined);
    assert.deepEqual(found!.related_subgoal_ids, ["sg-11111111"]);
  });
});

describe("v3.8 — verification debt", () => {
  it("reports a done sub-goal with no machine backing", () => {
    const debt = deriveVerificationDebt(
      [subGoal("sg-22222222", "wire config", "done")],
      [],
      statusesFor(2, null, []),
    );
    assert.equal(debt.length, 1);
    assert.match(debt[0], /sg-22222222/);
    assert.match(debt[0], /agent reported done, machine verification absent/);
  });

  it("stays silent for a done sub-goal a verified item backs", () => {
    const debt = deriveVerificationDebt(
      [subGoal("sg-22222222", "wire config", "done")],
      [{ subgoal_id: "sg-22222222", contract_item_ids: ["rci-11111111"], verified_at_round: 2 }],
      statusesFor(2, null, []),
    );
    assert.deepEqual(debt, []);
  });

  it("reports an insufficient contract item with its reason", () => {
    const id = itemId();
    const statuses = statusesFor(2, [{ item_id: id, outcome: "met" }], []);
    const debt = deriveVerificationDebt([], [], statuses);
    assert.equal(debt.length, 1);
    assert.match(debt[0], new RegExp(id));
    assert.match(debt[0], /not machine-verified/);
  });
});

describe("v3.8 — contract closure through observations", () => {
  it("closes only when every bound command was observed passing", () => {
    const id = itemId();
    assert.equal(
      statusesFor(2, [{ item_id: id, outcome: "met" }], [commandObservation("passed")]).closure,
      "verified",
    );
    assert.equal(
      statusesFor(2, [{ item_id: id, outcome: "met" }], []).closure,
      "open",
      "a claim without an observation leaves the contract open",
    );
    assert.equal(
      statusesFor(2, [{ item_id: id, outcome: "met" }], [commandObservation("failed")]).closure,
      "open",
    );
  });

  it("keeps a failed bound command contradicted rather than merely pending", () => {
    const statuses = statusesFor(2, [{ item_id: itemId(), outcome: "met" }], [commandObservation("failed")]);
    assert.equal(statuses.contradictedCount, 1);
    assert.equal(statuses.items[0].status, "contradicted");
  });
});
