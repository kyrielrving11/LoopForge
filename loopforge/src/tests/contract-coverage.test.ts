/** v4.0.6 — contract coverage through the real submission path.
 *
 *  With an after-capable command, a continuing round with a successor
 *  available must leave an ACTIVE contract for the next round. These tests drive SessionManager directly
 *  (not the fixture wrappers) so the boundary and the post-evidence gate are
 *  the production rule, and every refusal is asserted to have zero side
 *  effects.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../mcp/session.js";
import { validateSubmission } from "../mcp/submission-boundary.js";
import {
  MemoryLoopStore,
  installTestCommandProvider,
} from "./_helpers.js";
import { resetPolicy, getPolicy } from "../policy.js";
import { deriveContractItemIds, deriveContractId } from "../token-utils.js";
import type { RoundContractProposal } from "../protocol.js";

function contract(workItem = "Slice A"): RoundContractProposal {
  return {
    work_item: workItem,
    items: [{
      description: `${workItem} acceptance`,
      criterion_refs: [],
      verify_with: ["verify"],
    }],
  };
}

function continuing(proposal?: RoundContractProposal): Record<string, unknown> {
  return {
    outcome: "failed",
    output_summary: "continued the slice",
    constraint_violations: [],
    should_continue: true,
    ...(proposal ? { round_contract: proposal } : {}),
  };
}

function itemIdOf(proposal: RoundContractProposal): string {
  return deriveContractItemIds(proposal.items)[0]!;
}

describe("v4.0.6 — contract coverage", () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });
  afterEach(() => mgr.close());

  async function start(loopId: string) {
    const started = await mgr.create({ task: `Task for ${loopId}`, loopId });
    return { started, handle: started.submissionHandle! };
  }

  it("round 1 continuing without a contract is a zero-side-effect contract_invalid", async () => {
    const { started, handle } = await start("coverage-required");
    const entriesBefore = store.listEntries("coverage-required").length;

    const result = await mgr.advance(handle, "", continuing());

    assert.equal(result.submissionError?.code, "contract_invalid");
    const details = result.submissionError?.details as {
      contract_errors?: Array<{ reason: string }>;
    };
    assert.ok(details.contract_errors?.some((error) =>
      error.reason === "contract_required"));
    assert.match(String(result.stopDetail), /must leave an active Round Contract/,
      "a coverage refusal is not described as a malformed declaration");
    assert.equal(result.round, 1, "the round does not advance");
    assert.deepEqual(result.submissionHandle, handle,
      "the same held attempt and handle remain");
    assert.equal(mgr.get(started.sessionId)?.currentRound, 1);
    assert.equal(store.listEntries("coverage-required").length, entriesBefore,
      "no Vault entry");
  });

  it("a first-round contract becomes round 2's Current Task", async () => {
    const { started, handle } = await start("coverage-first");
    const accepted = await mgr.advance(handle, "", continuing(contract()));

    assert.equal(accepted.round, 2);
    assert.equal(accepted.enforcementAction, undefined);
    assert.ok(String(accepted.prompt).includes("**Slice A**"));
    assert.equal(
      mgr.getActiveContract(started.sessionId)?.work_item,
      "Slice A",
    );
  });

  it("an open active contract continues when the proposal is omitted", async () => {
    const { started, handle } = await start("coverage-continue");
    const r2 = await mgr.advance(handle, "", continuing(contract()));
    const r3 = await mgr.advance(r2.submissionHandle!, "", continuing());

    assert.equal(r3.round, 3);
    assert.ok(String(r3.prompt).includes("**Slice A**"));
    assert.equal(mgr.getActiveContract(started.sessionId)?.id,
      deriveContractId("coverage-continue", contract()));
  });

  it("a closed contract without a successor is rejected after evidence", async () => {
    const { started, handle } = await start("coverage-closed-missing");
    const r2 = await mgr.advance(handle, "", continuing(contract()));
    const entriesBefore = store.listEntries("coverage-closed-missing").length;
    const itemId = itemIdOf(contract());

    const closed = await mgr.advance(r2.submissionHandle!, "", {
      outcome: "failed",
      output_summary: "verified the slice",
      constraint_violations: [],
      should_continue: true,
      execution_report: {
        files_changed: [],
        claims: [{ id: itemId, outcome: "met" }],
      },
    });

    assert.equal(closed.enforcementAction, "reject");
    assert.match(String(closed.enforcementReason), /no successor/);
    assert.equal(mgr.get(started.sessionId)?.currentRound, 2,
      "the rejected attempt does not advance the round");
    assert.equal(store.listEntries("coverage-closed-missing").length,
      entriesBefore, "a rejection writes no Vault entry");
  });

  it("a successor repeating the closed acceptance items is rejected", async () => {
    const { handle } = await start("coverage-unchanged");
    const first = contract("Slice A");
    const r2 = await mgr.advance(handle, "", continuing(first));
    const itemId = itemIdOf(first);

    const unchanged = await mgr.advance(r2.submissionHandle!, "", {
      outcome: "failed",
      output_summary: "closed A and restated it",
      constraint_violations: [],
      should_continue: true,
      execution_report: {
        files_changed: [],
        claims: [{ id: itemId, outcome: "met" }],
      },
      round_contract: {
        ...first,
        work_item: "Renamed only",
      },
    });

    assert.equal(unchanged.enforcementAction, "reject");
    assert.match(String(unchanged.enforcementReason), /repeats/);
  });

  it("a different proposal while the contract is open needs supersedes", async () => {
    const { handle } = await start("coverage-premature");
    const r2 = await mgr.advance(handle, "", continuing(contract("Slice A")));

    const premature = await mgr.advance(r2.submissionHandle!, "", continuing(contract("Slice B")));
    assert.equal(premature.enforcementAction, "reject");
    assert.match(String(premature.enforcementReason), /still open/);
    assert.equal(mgr.getByLoopId("coverage-premature")?.currentRound, 2);
  });

  it("supersedes closes the old contract and activates the successor", async () => {
    const { started, handle } = await start("coverage-supersede");
    const first = contract("Slice A");
    const successor = contract("Slice B");
    const r2 = await mgr.advance(handle, "", continuing(first));

    const redirected = await mgr.advance(r2.submissionHandle!, "", continuing({
      ...successor,
      supersedes: { contract_id: deriveContractId("coverage-supersede", first) },
    }));
    assert.equal(redirected.round, 3);
    assert.ok(String(redirected.prompt).includes("**Slice B**"));
    assert.equal(mgr.getActiveContract(started.sessionId)?.work_item, "Slice B");

    const receipt = redirected.submission_receipt as {
      effects: { contract: { superseded?: boolean; before_id?: string; after_id?: string } };
    };
    assert.equal(receipt.effects.contract.superseded, true);
    assert.equal(receipt.effects.contract.before_id,
      deriveContractId("coverage-supersede", first));
    assert.equal(receipt.effects.contract.after_id,
      deriveContractId("coverage-supersede", successor));

    const audit = mgr.getAudit("coverage-supersede") as {
      rounds: Array<{
        round: number;
        contractRedirect: { contract_id: string } | null;
      }>;
    } | null;
    assert.equal(
      audit?.rounds.find((round) => round.round === 2)?.contractRedirect?.contract_id,
      deriveContractId("coverage-supersede", first),
      "audit exposes the committed redirect",
    );
  });

  it("a stale supersede target is a zero-side-effect contract_invalid", async () => {
    const { handle } = await start("coverage-stale");
    const r2 = await mgr.advance(handle, "", continuing(contract("Slice A")));
    const held = r2.submissionHandle!;
    const entriesBefore = store.listEntries("coverage-stale").length;

    const stale = await mgr.advance(held, "", continuing({
      ...contract("Slice B"),
      supersedes: { contract_id: "rc-99999999" },
    }));

    assert.equal(stale.submissionError?.code, "contract_invalid");
    const details = stale.submissionError?.details as {
      contract_errors?: Array<{ reason: string }>;
    };
    assert.ok(details.contract_errors?.some((error) =>
      error.reason === "supersede_target_mismatch"));
    assert.deepEqual(stale.submissionHandle, held);
    assert.equal(store.listEntries("coverage-stale").length, entriesBefore);
  });

  it("a supersede whose acceptance items do not change is rejected", async () => {
    const { handle } = await start("coverage-same-items");
    const first = contract("Slice A");
    const r2 = await mgr.advance(handle, "", continuing(first));
    const held = r2.submissionHandle!;

    const same = await mgr.advance(held, "", continuing({
      ...first,
      work_item: "Renamed",
      supersedes: { contract_id: deriveContractId("coverage-same-items", first) },
    }));

    assert.equal(same.submissionError?.code, "contract_invalid");
    const details = same.submissionError?.details as {
      contract_errors?: Array<{ reason: string }>;
    };
    assert.ok(details.contract_errors?.some((error) =>
      error.reason === "supersede_without_change"));
    assert.deepEqual(same.submissionHandle, held);
  });

  it("stop and blocked rounds cannot leave a proposal", async () => {
    const { handle } = await start("coverage-on-stop");
    const stopped = await mgr.advance(handle, "", {
      outcome: "success",
      output_summary: "done",
      constraint_violations: [],
      should_continue: false,
      round_contract: contract(),
    });
    assert.equal(stopped.submissionError?.code, "contract_invalid");
    assert.match(String(stopped.stopDetail), /cannot leave a round_contract/,
      "a stop-refusal names the stop rule, not a malformed declaration");
    assert.ok((stopped.submissionError?.details as {
      contract_errors?: Array<{ reason: string }>;
    }).contract_errors?.some((error) => error.reason === "contract_on_stop"));

    const blocked = await mgr.advance(handle, "", {
      outcome: "blocked",
      output_summary: "blocked",
      constraint_violations: [],
      should_continue: false,
      blocker: "missing credentials",
      round_contract: contract(),
    });
    assert.equal(blocked.submissionError?.code, "contract_invalid");
    assert.ok((blocked.submissionError?.details as {
      contract_errors?: Array<{ reason: string }>;
    }).contract_errors?.some((error) => error.reason === "contract_on_stop"));
  });

  it("the final configured round rejects an unused successor, then stops without requiring one", async () => {
    const started = await mgr.create({
      task: "Task for final configured round",
      loopId: "coverage-final-round",
      maxRounds: 1,
    });
    const held = started.submissionHandle!;
    const entriesBefore = store.listEntries("coverage-final-round").length;

    const unusedSuccessor = await mgr.advance(held, "", continuing(contract()));
    assert.equal(unusedSuccessor.submissionError?.code, "contract_invalid");
    assert.ok((unusedSuccessor.submissionError?.details as {
      contract_errors?: Array<{ reason: string }>;
    }).contract_errors?.some((error) => error.reason === "contract_on_stop"));
    assert.deepEqual(unusedSuccessor.submissionHandle, held);
    assert.equal(store.listEntries("coverage-final-round").length, entriesBefore,
      "the invalid proposal has no durable effects");

    const final = await mgr.advance(held, "", continuing());
    assert.equal(final.stopReason, "max_rounds");
    assert.equal(final.prompt, null);
    assert.equal(final.round, 1);
  });

  it("without after-capable commands no contract is required and Current Task falls back", async () => {
    resetPolicy();
    assert.equal(getPolicy().evidence.commands.length, 0);
    const { started, handle } = await start("coverage-no-capability");
    const accepted = await mgr.advance(handle, "", continuing());

    assert.equal(accepted.round, 2);
    assert.ok(String(accepted.prompt).includes("Task for coverage-no-capability"));
    assert.equal(mgr.getActiveContract(started.sessionId), null);
  });

  it("a redo/empty branch at a non-1 round still requires a contract", () => {
    // The shared rule has no round input. Round 7 with no committed history
    // represents an empty branch after a rollback: the same coverage applies.
    const boundary = validateSubmission(
      new MemoryLoopStore(),
      { loopId: "coverage-empty-branch", currentRound: 7 },
      continuing(),
    );
    assert.equal(boundary.ok, false);
    if (boundary.ok) return;
    assert.equal(boundary.submissionError.code, "contract_invalid");
    const details = boundary.submissionError.details as {
      contract_errors?: Array<{ reason: string }>;
    };
    assert.ok(details.contract_errors?.some((error) =>
      error.reason === "contract_required"));
    assert.match(boundary.stopDetail, /must leave an active Round Contract/);
  });
});
