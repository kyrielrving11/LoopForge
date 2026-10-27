/** v4.0.3 — historical determinism for contract items and criteria.
 *
 *  These tests pin two invariants that the read model previously violated:
 *  - a command's historical observation is not rewritten by later policy
 *    (disable/reconfigure);
 *  - criterion facts are latest-wins across rounds, and an insufficient round
 *    never erases a verified/contradicted fact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  committedFeedbackRound,
} from "./_helpers.js";
import { derivationRounds } from "../committed-round.js";
import {
  committedRoundFacts,
  deriveRoundContractView,
} from "../round-contract.js";
import { deriveCriterionFacts } from "../round-facts.js";
import { deriveCriterionStatuses } from "../criterion-status.js";
import {
  deriveContractId,
  deriveContractItemIds,
  deriveCriterionId,
} from "../token-utils.js";
import type {
  CommandObservation,
  RoundContractProposal,
} from "../protocol.js";

const LOOP = "history-loop";
const CRITERION = "login works end to end";
const CRITERION_ID = deriveCriterionId(CRITERION);

const PROPOSAL: RoundContractProposal = {
  work_item: "login slice",
  scope: [],
  items: [
    {
      description: "login is verified by the bound command",
      criterion_refs: [CRITERION_ID],
      verify_with: ["verify"],
    },
    // A second, never-claimed item keeps the contract OPEN so later rounds
    // still execute it (a closed contract would have no successor).
    {
      description: "documentation is verified separately",
      criterion_refs: [],
      verify_with: ["docs"],
    },
  ],
};

const ITEM_ID = deriveContractItemIds(PROPOSAL.items)[0]!;
const BINDING = {
  rc_id: deriveContractId(LOOP, PROPOSAL),
  item_ids: [ITEM_ID],
  config_hash_by_command: { verify: "declared-hash" },
};

function commandObservation(
  status: CommandObservation["status"],
  configHash = "declared-hash",
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
      argv: ["node", "verify.js"],
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
      entrypointFiles: [],
    },
  };
}

/** Round 1 declares the contract; later rounds claim the item met and carry
 *  the given after observation (or none). */
function history(
  evidence: Array<CommandObservation | null>,
  currentRound = evidence.length + 2,
) {
  const entries = [
    committedFeedbackRound(1, {
      loopId: LOOP,
      contract: PROPOSAL,
      contractBinding: BINDING,
    }),
  ];
  evidence.forEach((observation, index) => {
    entries.push(committedFeedbackRound(index + 2, {
      loopId: LOOP,
      contractItemClaims: [{ item_id: ITEM_ID, outcome: "met" }],
      roundEvidence: observation ? [observation] : [],
    }));
  });
  return derivationRounds(entries, currentRound);
}

function itemStatus(rounds: ReturnType<typeof history>, commands: [] = []) {
  // Judge the claiming round itself, after the command configuration changed:
  // the observation is the historical fact, not the current policy.
  const claimingRound = rounds.find((round) => round.round === 2)!;
  return deriveRoundContractView({
    rounds,
    round: 2,
    current: committedRoundFacts(claimingRound),
    commands,
  }).statuses;
}

describe("v4.0.3 — command history is not rewritten by later policy", () => {
  it("keeps a passed observation verified after the command is disabled", () => {
    const statuses = itemStatus(history([commandObservation("passed")]));
    assert.equal(statuses.items[0]?.status, "verified");
  });

  it("is insufficient when the command was disabled and never observed", () => {
    const statuses = itemStatus(history([null]));
    assert.equal(statuses.items[0]?.status, "insufficient");
    assert.match(statuses.items[0]?.reasons[0] ?? "", /no longer configured/);
  });

  it("does not treat a reconfigured command's pass as the declared command", () => {
    const statuses = itemStatus(history([
      commandObservation("passed", "reconfigured-hash"),
    ]));
    assert.equal(statuses.items[0]?.status, "insufficient");
    assert.match(statuses.items[0]?.reasons[0] ?? "", /reconfigured/);
  });
});

describe("v4.0.3 — criterion facts are latest-wins", () => {
  it("lets a later verification recover an earlier contradiction", () => {
    const rounds = history([
      commandObservation("failed"),      // R2 contradicted
      commandObservation("passed"),      // R3 verified
      null,                              // R4 insufficient — must not erase
      commandObservation("failed"),      // R5 contradicted
      commandObservation("passed"),      // R6 verified
    ]);
    const facts = deriveCriterionFacts({ rounds, commands: [] });
    assert.deepEqual(facts, [{
      criterion_id: CRITERION_ID,
      status: "verified",
      status_at_round: 6,
    }]);
  });

  it("does not let an insufficient round erase a verified fact", () => {
    const rounds = history([
      commandObservation("passed"),      // R2 verified
      null,                              // R3 insufficient
    ]);
    const facts = deriveCriterionFacts({ rounds, commands: [] });
    assert.deepEqual(facts, [{
      criterion_id: CRITERION_ID,
      status: "verified",
      status_at_round: 2,
    }]);
  });
});

describe("v4.0.3 — criterion rows use latest claim + machine source", () => {
  it("uses the latest claim, not the first one", () => {
    const statuses = deriveCriterionStatuses({
      rounds: derivationRounds([
        committedFeedbackRound(1, { loopId: LOOP, met: [CRITERION] }),
        committedFeedbackRound(2, { loopId: LOOP, remaining: [CRITERION] }),
      ]),
      currentRound: 3,
      objective: { success_criteria: [CRITERION] },
      criterionFacts: [],
    });
    assert.equal(statuses[0]?.status, "remaining");
    assert.equal(statuses[0]?.status_at_round, 2);
    assert.equal(statuses[0]?.status_source, "agent");
  });

  it("lets the machine fact outrank an Agent claim and name its own round", () => {
    const statuses = deriveCriterionStatuses({
      rounds: derivationRounds([
        committedFeedbackRound(1, { loopId: LOOP, remaining: [CRITERION] }),
        committedFeedbackRound(2, { loopId: LOOP, remaining: [CRITERION] }),
      ]),
      currentRound: 3,
      objective: { success_criteria: [CRITERION] },
      criterionFacts: [{
        criterion_id: CRITERION_ID,
        status: "verified",
        status_at_round: 2,
      }],
    });
    assert.equal(statuses[0]?.status, "verified");
    assert.equal(statuses[0]?.status_at_round, 2);
    assert.equal(statuses[0]?.status_source, "machine");
  });
});
