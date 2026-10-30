/** v3.8 — `explain`: the read-only per-round "why" view. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildExplain, renderExplain } from "../explain.js";
import {
  committedBacktrackRound,
  committedFeedbackRound,
  installTestCommandProvider,
  promptArtifact,
} from "./_helpers.js";
import { criterionClaims } from "./_helpers.js";
import { makeExecutionReport } from "../protocol.js";
import { deriveContractId, deriveContractItemIds } from "../token-utils.js";

describe("v3.8 — explain view", () => {
  const gitObservation = (files: string[]) => ({
    schemaVersion: 2 as const,
    providerId: "git",
    kind: "git" as const,
    phase: "after" as const,
    startedAt: 0,
    finishedAt: 0,
    status: "observed" as const,
    files,
    data: {
      dirty: files,
      fingerprints: Object.fromEntries(files.map((file) => [file, "m:1"])),
      coverage: "tracked_and_non_ignored_untracked" as const,
    },
  });

  const entry = (round: number, opts: Parameters<typeof committedFeedbackRound>[1] = {}) =>
    committedFeedbackRound(round, { loopId: "explain-loop", ...opts });

  /** "verify" is the command installTestCommandProvider configures. */
  const contractFixture = () => ({
    work_item: "Slice A",
    scope: ["src/a"],
    items: [{ description: "works", criterion_refs: [], verify_with: ["verify"] }],
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
        beforeEvidence: [gitObservation([])],
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
    assert.equal(round.observations.after.length, 1);
    assert.equal(round.observations.after[0].providerId, "git");
    assert.deepEqual(round.observationDelta[0].changedFiles, ["src/a.ts"]);
    assert.equal(round.flags[0].check, "evidence_integrity");
    // v3.9.1: explain reads the same receipt projection as status.
    assert.equal(round.submission.record, "committed");
    assert.equal(round.submission.entered_history, true);
    assert.equal(round.git_status, "observed");
    assert.deepEqual(round.files_changed, ["src/a.ts"]);
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
      items: [{ description: "works", criterion_refs: [], verify_with: ["verify"] }],
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

  it("v4.0.2: reports a committed evaluation even without an execution_report", () => {
    const result = buildExplain("explain-loop", [
      entry(1, {
        noExecutionReport: true,
        outputSummary: "no execution report but a real summary",
      }),
    ]);
    const round = result.rounds[0];
    assert.ok(round.report);
    assert.equal(round.report?.output_summary, "no execution report but a real summary");
    assert.deepEqual(round.report?.criterion_claims, []);
    assert.deepEqual(round.report?.contract_item_claims, []);
  });

  it("v4.0.2: exposes context, assumptions, questions and blocker", () => {
    const result = buildExplain("explain-loop", [
      entry(1, {
        promptArtifact: promptArtifact({
          roundId: "loop:explain-loop:round:1",
          round: 1,
          renderedPrompt: "held",
          contextMode: "fresh_invocation",
          contextReason: "first_round",
        }),
        wrongAssumptions: ["old belief"],
        retractedConstraints: ["old rule"],
        openQuestions: ["still open?"],
        blocker: "needs credentials",
      }),
    ]);
    const round = result.rounds[0];
    assert.deepEqual(round.context, {
      mode: "fresh_invocation",
      reason: "first_round",
      // v4.0.5: the artifact carried no host instruction.
      userInstruction: null,
    });
    assert.deepEqual(round.wrongAssumptions, ["old belief"]);
    assert.deepEqual(round.retractedConstraints, ["old rule"]);
    assert.deepEqual(round.openQuestions, ["still open?"]);
    assert.equal(round.blocker, "needs credentials");
  });

  it("v4.0.2: rollbacks carry abandoned-path facts", () => {
    const directive = committedBacktrackRound(2, "explain-loop", 1);
    const transaction = (directive.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    const recovery = (transaction.snapshot as Record<string, unknown>)
      .recovery as Record<string, unknown>;
    recovery.approaches = ["tried the parser rewrite"];
    recovery.wrong_assumptions = ["the old parser was reusable"];
    const result = buildExplain("explain-loop", [directive]);
    assert.deepEqual(result.rollbacks[0]?.failedRounds, [2]);
    assert.deepEqual(result.rollbacks[0]?.approaches, ["tried the parser rewrite"]);
    assert.deepEqual(result.rollbacks[0]?.wrongAssumptions, ["the old parser was reusable"]);
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

// ═══════════════════════════════════════════════════════════════════════════
// v4.0.4 — result facts, labels and legacy reporting
// ═══════════════════════════════════════════════════════════════════════════

describe("v4.0.4 — explain separates the three fact kinds", () => {
  const loopId = "explain-facts";
  const entryFor = (
    round: number,
    opts: Parameters<typeof committedFeedbackRound>[1] = {},
  ) => committedFeedbackRound(round, { loopId, ...opts });

  it("renders Agent report, LoopForge decision and Machine evidence once", () => {
    const result = buildExplain(loopId, [
      entryFor(1, {
        success: false,
        shouldContinue: false,
        agentStopReason: "gave_up",
        stopReason: "failed",
        outputSummary: "tried and failed",
        blocker: "missing credentials",
      }),
    ]);
    const round = result.rounds[0]!;
    assert.equal(round.loopStopReason, "failed");
    assert.equal(round.agentStopReason, "gave_up");
    assert.equal(round.agentShouldContinue, false);
    assert.equal(round.agentOutcomeDeclared, null);
    assert.ok(!("machineBackedSuccess" in round),
      "the posture owns machineBackedSuccess; explain must not repeat it");

    const text = renderExplain(result);
    assert.ok(text.includes("Agent report"));
    assert.ok(text.includes("LoopForge decision"));
    assert.ok(text.includes("Machine evidence"));
    assert.ok(text.includes("loop_stop_reason: failed"));
    assert.ok(text.includes("agent_stop_reason: gave_up"));
    assert.ok(text.includes("output_summary (Agent report): tried and failed"));
    assert.ok(text.includes("blocker (Agent report): missing credentials"));
    assert.ok(!/\n  stop_reason:/.test(text), "the old ambiguous label is gone");
    assert.ok(!/\n  evidence: /.test(text), "explain must not hand-render a second posture");
    assert.ok(!/\bconflict\b/i.test(text));
    assert.ok(!/\bverdict\b/i.test(text));
  });

  it("labels the commit snapshot and the derived contract status separately", () => {
    const contract = {
      work_item: "Slice A",
      scope: ["src/a"],
      items: [{ description: "works", criterion_refs: [], verify_with: ["verify"] }],
    };
    const itemId = deriveContractItemIds(contract.items)[0]!;
    const withPosture = buildExplain(loopId, [
      entryFor(1, { contract }),
      entryFor(2, {
        contractItemClaims: [{ item_id: itemId, outcome: "met" }],
        evidencePosture: {
          round: 2,
          kind: "evaluation",
          status: "verified",
          machineBackedSuccess: true,
          verificationConfigured: true,
          workspace: { status: "observed", changedPathCount: 1 },
          files: null,
          providers: [],
          commands: [{ commandId: "verify", status: "passed", required: true }],
          contract: {
            id: deriveContractId(loopId, contract),
            closure: "verified",
            items: [{
              id: itemId,
              status: "verified",
              criterionRefs: [],
              reasons: ["verified by verify"],
            }],
            verifiedCount: 1,
            insufficientCount: 0,
            contradictedCount: 0,
            pendingCount: 0,
          },
          findings: [],
          omitted: { providers: 0, commands: 0, contractItems: 0, findings: 0 },
        },
      }),
    ]);
    const text = renderExplain(withPosture);
    assert.ok(text.includes("Contract at commit (snapshot):"));
    assert.ok(text.includes("Contract status now (derived):"));
    assert.equal(withPosture.rounds.length, 2);
  });

  it("reports legacy rounds instead of silently showing an empty timeline", () => {
    const result = buildExplain(loopId, [], undefined, 2);
    assert.equal(result.legacyRounds, 2);
    assert.match(renderExplain(result), /2 4\.0\.3 legacy round\(s\) not decoded/);
  });

  it("Explain and its embedded receipt agree about the same committed facts", () => {
    const result = buildExplain(loopId, [
      entryFor(1, {
        success: false,
        outcome: "blocked",
        shouldContinue: false,
        agentStopReason: "needs_human_input",
        stopReason: "blocked",
        blocker: "needs a decision",
      }),
    ]);
    const round = result.rounds[0]!;
    assert.equal(round.submission.loop_stop_reason, round.loopStopReason);
    assert.equal(round.submission.agent_stop_reason, round.agentStopReason);
  });
});
