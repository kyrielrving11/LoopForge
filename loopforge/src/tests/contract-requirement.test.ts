/** v4.0.6 — the ONE contract-coverage rule. Pure matrix over facts only. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveContractRequirement } from "../contract-requirement.js";
import type { ActiveContractView } from "../round-contract.js";

const ACTIVE: ActiveContractView = {
  id: "rc-12345678",
  declared_at_round: 1,
  work_item: "Slice A",
  scope: [],
  items: [{
    id: "rci-12345678",
    description: "works",
    criterion_refs: [],
    verify_with: ["verify"],
  }],
  config_hash_by_command: {},
};

function requirement(overrides: Partial<Parameters<typeof deriveContractRequirement>[0]> = {}) {
  return deriveContractRequirement({
    shouldContinue: true,
    blocked: false,
    proposalPresent: false,
    activeContract: null,
    closure: "open",
    contractCapability: true,
    ...overrides,
  });
}

describe("deriveContractRequirement", () => {
  it("does not require a contract when the round stops", () => {
    assert.deepEqual(
      requirement({ shouldContinue: false }),
      { required: false, reason: "not_continuing", activeContractId: null },
    );
  });

  it("does not require a contract for a blocked round", () => {
    assert.deepEqual(
      requirement({ blocked: true }),
      { required: false, reason: "blocked", activeContractId: null },
    );
  });

  it("does not require a contract without after-capable commands", () => {
    assert.deepEqual(
      requirement({ contractCapability: false }),
      { required: false, reason: "no_contract_capability", activeContractId: null },
    );
  });

  it("requires a proposal when continuing with capability and no active contract", () => {
    assert.deepEqual(
      requirement(),
      { required: true, reason: "no_active_contract", activeContractId: null },
    );
  });

  it("is satisfied by a proposal when no contract is active", () => {
    assert.deepEqual(
      requirement({ proposalPresent: true }),
      { required: false, reason: "satisfied_by_proposal", activeContractId: null },
    );
  });

  it("an open active contract continues without a new proposal", () => {
    assert.deepEqual(
      requirement({ activeContract: ACTIVE, closure: "open" }),
      {
        required: false,
        reason: "active_contract_continues",
        activeContractId: ACTIVE.id,
      },
    );
  });

  it("a closed active contract requires a successor", () => {
    for (const closure of ["verified", "superseded", "blocked"] as const) {
      assert.deepEqual(
        requirement({ activeContract: ACTIVE, closure }),
        {
          required: true,
          reason: "active_contract_closed",
          activeContractId: ACTIVE.id,
        },
      );
    }
  });

  it("a successor satisfies a closed active contract", () => {
    assert.deepEqual(
      requirement({
        activeContract: ACTIVE,
        closure: "verified",
        proposalPresent: true,
      }),
      {
        required: false,
        reason: "satisfied_by_successor",
        activeContractId: ACTIVE.id,
      },
    );
  });

  // Round 1, redo and empty-branch coverage is exercised through the real
  // submission boundary in contract-coverage.test.ts: the rule itself has no
  // round or history input, so a unit test cannot distinguish those cases.
});
