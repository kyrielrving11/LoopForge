import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveCognitiveFacts } from "../cognitive-facts.js";
import { buildLoopProjection } from "../loop-projection.js";
import type { CommittedRoundView } from "../committed-round.js";
import { makeLoopCompileResponse, makeSelfEvaluation } from "../protocol.js";

function round(number: number, overrides: Record<string, unknown> = {}): CommittedRoundView {
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
    executionEvidence: evaluation.execution_evidence ?? null,
    verificationFlags: [],
    result: null,
    action: "continue",
    success: evaluation.success,
    outcome: evaluation.outcome ?? (evaluation.success ? "success" : "failed"),
    contractProposal: null,
    beforeEvidence: [],
    afterEvidence: [],
    roundEvidence: [],
  };
}

describe("cognitive facts and projection", () => {
  it("returns null for an empty fact set", () => {
    const facts = deriveCognitiveFacts({ compileResponse: null, rounds: [] });
    assert.equal(buildLoopProjection(facts), null);
  });

  it("derives focus and agent intent from committed rounds", () => {
    const facts = deriveCognitiveFacts({
      compileResponse: null,
      rounds: [round(1, { outcome: "partial", output_summary: "implemented parser", next_action: "run tests" })],
    });
    const projection = buildLoopProjection(facts)!;
    assert.equal(projection.focus?.what, "implemented parser");
    assert.equal(projection.focus?.since_round, 1);
    assert.ok(projection.todo.some((item) => item.item === "run tests"));
  });

  it("deduplicates and prioritizes todo facts", () => {
    const response = makeLoopCompileResponse({
      sub_goals: [
        { id: "sg-a", description: "fix parser", status: "pending", priority: 2 },
        { id: "sg-b", description: "repair build", status: "blocked", priority: 1 },
      ] as never,
    });
    const facts = deriveCognitiveFacts({
      compileResponse: response,
      rounds: [round(1, { next_action: "fix parser" })],
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
    const facts = deriveCognitiveFacts({
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

  it("does not collapse a verified-only or risk-only handoff", () => {
    const verified = deriveCognitiveFacts({
      compileResponse: null,
      rounds: [],
      verifiedClaims: ["cr-12345678"],
    });
    assert.ok(buildLoopProjection(verified));
    const risks = deriveCognitiveFacts({
      compileResponse: null,
      rounds: [],
      openGates: ["needs approval"],
    });
    assert.ok(buildLoopProjection(risks));
  });
});
