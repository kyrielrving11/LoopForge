import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveCognitiveFacts } from "../cognitive-facts.js";
import { buildLoopProjection } from "../loop-projection.js";
import type { CommittedRoundView } from "../committed-round.js";
import { makeLoopCompileResponse, makeSelfEvaluation } from "../protocol.js";
import { installTestCommandProvider } from "./_helpers.js";
import { deriveContractItemIds } from "../token-utils.js";
import { NO_IN_FLIGHT_ROUND, deriveRoundFacts } from "../round-facts.js";
import { getPolicy } from "../policy.js";

function round(
  number: number,
  overrides: Record<string, unknown> = {},
  view: Partial<CommittedRoundView> = {},
): CommittedRoundView {
  const evaluation = makeSelfEvaluation({
    success: false,
    output_summary: `round ${number}`,
    constraint_violations: [],
    should_continue: true,
    ...overrides,
  });
  return {
    source: "feedback",
    sourceEntry: {},
    loopId: "projection",
    round: number,
    roundId: `loop:projection:round:${number}`,
    attempt: 1,
    promptArtifact: null,
    evaluation,
    executionReport: evaluation.execution_report ?? null,
    verificationFlags: [],
    result: null,
    action: "continue",
    success: evaluation.success,
    outcome: evaluation.outcome ?? (evaluation.success ? "success" : "failed"),
    contractProposal: null,
    contractBinding: null,
    beforeEvidence: [],
    afterEvidence: [],
    observationDelta: [],
    evidenceIncomplete: true,
    ...view,
    // A Partial spread can carry `backtrack: undefined`; the view contract is
    // record-or-null.
    backtrack: view.backtrack ?? null,
  };
}

/** "verify" is the command installTestCommandProvider configures. */
const CONTRACT = {
  work_item: "Slice A",
  scope: ["src/a"],
  items: [{
    description: "works",
    criterion_refs: [],
    subgoal_refs: ["sg-11111111"],
    verify_with: ["verify"],
  }],
};

const commandObservation = () => ({
  schemaVersion: 1 as const,
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

/** The committed rounds that declare the contract and then machine-verify it. */
function verifiedHistory(): CommittedRoundView[] {
  return [
    round(1, {}, { contractProposal: { ...CONTRACT } }),
    round(2, {}, {
      executionReport: {
        contract_item_claims: [{ item_id: deriveContractItemIds(CONTRACT.items)[0], outcome: "met" }],
      },
      observationDelta: [commandObservation()],
      outcome: "success",
    }),
  ];
}

const subGoalResponse = () => makeLoopCompileResponse({
  sub_goals: [{
    id: "sg-11111111",
    description: "login works",
    status: "done",
    declared_at_round: 1,
    status_changed_at_round: 2,
    priority: 0,
  }] as never,
});

/** v3.8.1: `deriveCognitiveFacts` now takes the contract facts instead of
 *  re-deriving them internally (one fact, one derivation). This wrapper builds
 *  them from exactly the inputs the old internal derivation used, so every test
 *  below still asserts the same facts — only the derivation moved outward. */
function cognitiveFacts(
  input: Omit<Parameters<typeof deriveCognitiveFacts>[0], "facts">,
): ReturnType<typeof deriveCognitiveFacts> {
  return deriveCognitiveFacts({
    ...input,
    facts: deriveRoundFacts({
      rounds: input.rounds,
      currentRound: (input.rounds[input.rounds.length - 1]?.round ?? 0) + 1,
      inFlight: NO_IN_FLIGHT_ROUND,
      subGoals: input.compileResponse?.sub_goals ?? [],
      commands: getPolicy().evidence.commands ?? [],
    }),
  });
}

describe("cognitive facts and projection", () => {
  it("returns null for an empty fact set", () => {
    const facts = cognitiveFacts({ compileResponse: null, rounds: [] });
    assert.equal(buildLoopProjection(facts), null);
  });

  it("derives focus from committed rounds", () => {
    const facts = cognitiveFacts({
      compileResponse: null,
      rounds: [round(1, { outcome: "partial", output_summary: "implemented parser" })],
    });
    const projection = buildLoopProjection(facts)!;
    assert.equal(projection.focus?.what, "implemented parser");
    assert.equal(projection.focus?.since_round, 1);
    // v3.8: the agent's own next_action is no longer a projection input.
    assert.deepEqual(projection.todo, []);
  });

  it("deduplicates and prioritizes todo facts", () => {
    const response = makeLoopCompileResponse({
      sub_goals: [
        { id: "sg-a", description: "fix parser", status: "pending", priority: 2 },
        { id: "sg-b", description: "repair build", status: "blocked", priority: 1 },
      ] as never,
    });
    const facts = cognitiveFacts({
      compileResponse: response,
      rounds: [round(1)],
    });
    assert.equal(facts.todo.filter((item) => item.item === "fix parser").length, 1);
    assert.equal(facts.todo[0]?.item, "repair build");
  });

  it("derives phase, delegation, and handoff from shared facts", () => {
    const response = makeLoopCompileResponse({
      loop_objective: {
        objective: "finish parser",
        success_criteria: ["parser passes"],
        hard_constraints: [],
        created_at_round: 1,
        loop_id: "projection",
      },
      criterion_statuses: [{
        id: "cr-12345678",
        text: "parser passes",
        status: "remaining",
        related_subgoal_ids: [],
      }],
      rolling_summary: {
        key_outcomes: ["latest outcome"],
        recurring_issues: ["risk"],
        milestones: [{ label: "foundation", round_range: { start: 1, end: 2 } }],
      } as never,
    });
    const facts = cognitiveFacts({
      compileResponse: response,
      rounds: [round(2, {
        worker_results: [{
          agentId: "worker-1",
          subAgentType: "general-purpose",
          subTask: "inspect",
          resultSummary: "needs follow-up",
          outcome: "partial",
          discoveredConstraints: [],
        }],
      })],
      verifiedClaims: ["cr-12345678"],
      openGates: ["publish package"],
    });
    const projection = buildLoopProjection(facts)!;
    assert.equal(projection.phase?.current, "foundation");
    assert.equal(projection.delegation.pending, 1);
    assert.match(projection.handoff.summary, /Current task: finish parser/);
    assert.match(projection.handoff.summary, /Latest outcome: latest outcome/);
    assert.match(projection.handoff.summary, /Remaining criteria: parser passes/);
    assert.deepEqual(projection.handoff.verified, ["cr-12345678"]);
    assert.ok(projection.handoff.open_risks.some((risk) => risk.includes("publish package")));
  });

  it("v3.8: exposes verified_subgoals on the projection", () => {
    installTestCommandProvider();
    const projection = buildLoopProjection(cognitiveFacts({
      compileResponse: subGoalResponse(),
      rounds: verifiedHistory(),
    }))!;
    assert.equal(projection.verified_subgoals.length, 1);
    assert.equal(projection.verified_subgoals[0].subgoal_id, "sg-11111111");
    assert.deepEqual(
      projection.verified_subgoals[0].contract_item_ids,
      deriveContractItemIds(CONTRACT.items),
    );
    assert.equal(projection.verified_subgoals[0].verified_at_round, 2);
    // The machine fact and the debt view are consistent: a verified sub-goal
    // is never reported as unverified.
    assert.ok(
      !projection.handoff.open_risks.some((risk) => risk.includes("sg-11111111")),
      "a machine-verified sub-goal carries no verification debt",
    );
  });

  it("v3.8: reports no verified_subgoals while the item is unverified", () => {
    installTestCommandProvider();
    const projection = buildLoopProjection(cognitiveFacts({
      compileResponse: subGoalResponse(),
      rounds: [round(1, {}, { contractProposal: { ...CONTRACT } })],
    }))!;
    assert.deepEqual(projection.verified_subgoals, []);
    assert.ok(projection.handoff.open_risks.some((risk) => risk.includes("sg-11111111")));
  });

  it("does not collapse a verified-only or risk-only handoff", () => {
    const verified = cognitiveFacts({
      compileResponse: null,
      rounds: [],
      verifiedClaims: ["cr-12345678"],
    });
    assert.ok(buildLoopProjection(verified));
    const risks = cognitiveFacts({
      compileResponse: null,
      rounds: [],
      openGates: ["needs approval"],
    });
    assert.ok(buildLoopProjection(risks));
  });
});
