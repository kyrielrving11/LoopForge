/** v3.8 — `explain`: the read-only per-round "why" view. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildExplain, renderExplain } from "../explain.js";
import { committedFeedbackRound, installTestCommandProvider } from "./_helpers.js";
import { criterionClaims } from "./_helpers.js";
import { makeExecutionReport } from "../protocol.js";
import { deriveContractId, deriveContractItemIds } from "../token-utils.js";

describe("v3.8 — explain view", () => {
  const gitObservation = (files: string[]) => ({
    schemaVersion: 1,
    providerId: "git",
    kind: "git" as const,
    phase: "after" as const,
    startedAt: 0,
    finishedAt: 0,
    status: "observed" as const,
    files,
    data: { tracked: files, staged: [], untracked: [], fingerprints: {} },
  });

  const entry = (round: number, opts: Parameters<typeof committedFeedbackRound>[1] = {}) =>
    committedFeedbackRound(round, { loopId: "explain-loop", ...opts });

  /** "verify" is the command installTestCommandProvider configures. */
  const contractFixture = () => ({
    work_item: "Slice A",
    scope: ["src/a"],
    items: [{ description: "works", criterion_refs: [], subgoal_refs: [], verify_with: ["verify"] }],
  });

  const commandObservation = () => ({
    schemaVersion: 1,
    providerId: "command:verify",
    kind: "command" as const,
    phase: "after" as const,
    startedAt: 0,
    finishedAt: 0,
    status: "passed" as const,
    files: [],
    data: {
      commandId: "verify",
      argv: ["node", "-e", "verify"],
      cwd: ".",
      configHash: "0".repeat(64),
      required: false,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
    },
  });

  it("reports each committed round with its report, observations, and flags", () => {
    const result = buildExplain("explain-loop", [
      entry(1, {
        roundEvidence: [gitObservation(["src/a.ts"])],
        verificationFlags: [{
          check: "evidence_integrity", field: "files_changed", severity: "warn", detail: "mismatch",
        }],
      }),
    ]);
    assert.equal(result.rounds.length, 1);
    const round = result.rounds[0];
    assert.equal(round.round, 1);
    assert.equal(round.action, "continue");
    assert.equal(round.observations.length, 1);
    assert.equal(round.observations[0].providerId, "git");
    assert.deepEqual(round.observationDelta[0].files, ["src/a.ts"]);
    assert.equal(round.flags[0].check, "evidence_integrity");
  });

  it("marks a round without after-phase observations as evidence-incomplete", () => {
    const result = buildExplain("explain-loop", [entry(1)]);
    assert.equal(result.rounds[0].evidenceIncomplete, true);
  });

  it("filters to a single round when asked", () => {
    const result = buildExplain("explain-loop", [entry(1), entry(2)], 2);
    assert.deepEqual(result.rounds.map((round) => round.round), [2]);
  });

  it("surfaces the agent's claims and the contract's derived item statuses", () => {
    const claims = criterionClaims(["cr-11111111"]);
    const contract = {
      work_item: "Slice A",
      scope: ["src/a"],
      items: [{ description: "works", criterion_refs: [], subgoal_refs: [], verify_with: ["verify"] }],
    };
    const result = buildExplain("explain-loop", [
      entry(1, { contract }),
      entry(2, { contractItemClaims: [{ item_id: "rci-00000000", outcome: "met" }] }),
    ]);
    const first = result.rounds[0];
    assert.ok(first.report, "the agent's own report is quoted back");
    assert.equal(first.contract, null,
      "round 1 declared the proposal — it executed under no contract");
    assert.equal(result.rounds[1].contract?.closure, "open");
    void claims;
  });

  it("v3.8: a closing round reports the contract it EXECUTED, not its successor", () => {
    // Regression: the walker used to be fed rounds `<= view.round`, so the
    // round that CLOSED the active contract was reported with the successor
    // contract (or none) instead of the one it actually ran under.
    installTestCommandProvider();
    const contract = contractFixture();
    const itemId = deriveContractItemIds(contract.items)[0];
    const result = buildExplain("explain-loop", [
      entry(1, { contract }),
      entry(2, {
        contractItemClaims: [{ item_id: itemId, outcome: "met" }],
        roundEvidence: [commandObservation()],
      }),
    ]);
    const closing = result.rounds[1];
    assert.equal(closing.contract?.id, deriveContractId("explain-loop", contract));
    assert.equal(closing.contract?.declared_at_round, 1);
    assert.equal(closing.contract?.closure, "verified");
    assert.equal(closing.contract?.items[0].status, "verified");
  });

  it("v3.8: a round that closes the contract by blocking reports a blocked closure", () => {
    installTestCommandProvider();
    const result = buildExplain("explain-loop", [
      entry(1, { contract: contractFixture() }),
      entry(2, { outcome: "blocked" }),
    ]);
    assert.equal(result.rounds[1].contract?.closure, "blocked");
    assert.equal(result.rounds[1].contract?.declared_at_round, 1);
  });

  it("renders a human-readable timeline without inventing facts", () => {
    const text = renderExplain(buildExplain("explain-loop", [entry(1)]));
    assert.match(text, /Loop explain-loop/);
    assert.match(text, /Round 1/);
    assert.match(text, /INCOMPLETE/);
  });

  it("is pure — explaining twice yields the same view", () => {
    const entries = [entry(1)];
    assert.deepEqual(buildExplain("explain-loop", entries), buildExplain("explain-loop", entries));
  });

  it("does not expose prompt text", () => {
    const result = buildExplain("explain-loop", [entry(1)]);
    assert.ok(!JSON.stringify(result).includes("renderedPrompt"));
  });

  it("keeps the machine report out of the agent's claim fields", () => {
    const report = makeExecutionReport({ criterion_claims: criterionClaims(["cr-11111111"]) });
    assert.equal(report.contract_item_claims?.length, 0);
  });
});
