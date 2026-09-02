/** v2.12: Typed cognitive state projection — pure derivation tests. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildLoopProjection } from "../loop-projection.js";
import type { LoopForgeResponse } from "../protocol.js";
import { makeLoopProjection, AgentStatus } from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";

function lineageEntry(
  round: number,
  overrides: Record<string, unknown> = {},
): VaultEntry {
  return {
    id: `loop:proj-loop:r${round}`,
    task_id: `loop:proj-loop:r${round}`,
    task_type: "loop_lineage",
    loop_id: "proj-loop",
    timestamp: new Date().toISOString(),
    loop_lineage: { round },
    ...overrides,
  };
}

function compileResponse(overrides: Partial<LoopForgeResponse> = {}): LoopForgeResponse {
  return {
    status: AgentStatus.OK,
    prompt: "prompt",
    error: null,
    ...overrides,
  };
}

describe("buildLoopProjection", () => {
  it("derives focus from the last non-failed round", () => {
    const entries = [
      lineageEntry(1, { output_summary: "round one", success: true }),
      lineageEntry(2, { output_summary: "round two failed", success: false }),
      lineageEntry(3, { output_summary: "round three", success: true }),
    ];
    const projection = buildLoopProjection({
      loopId: "proj-loop",
      currentRound: 4,
      compileResponse: compileResponse(),
      vaultEntries: entries,
    });
    assert.equal(projection?.focus?.what, "round three");
    assert.equal(projection?.focus?.since_round, 3);
  });

  it("returns null focus for an empty loop", () => {
    const projection = buildLoopProjection({
      loopId: "proj-loop",
      currentRound: 1,
      compileResponse: null,
      vaultEntries: [],
    });
    assert.equal(projection, null);
  });

  it("derives todo from pending/blocked sub-goals (derived) and next_action (agent intent)", () => {
    const response = compileResponse({
      sub_goals: [
        { id: "sg-a", description: "audit cache", status: "pending", declared_at_round: 1, status_changed_at_round: 1, priority: 3 },
        { id: "sg-b", description: "fix resume", status: "blocked", declared_at_round: 1, status_changed_at_round: 2, priority: 5 },
        { id: "sg-c", description: "done task", status: "done", declared_at_round: 1, status_changed_at_round: 2, priority: 5 },
      ],
    });
    const entries = [lineageEntry(2, { next_action: "verify migration" })];
    const projection = buildLoopProjection({
      loopId: "proj-loop",
      currentRound: 3,
      compileResponse: response,
      vaultEntries: entries,
    });
    const todo = projection!.todo;
    const derived = todo.filter((t) => t.source === "derived");
    const intent = todo.filter((t) => t.source === "agent_intent");
    assert.equal(derived.length, 2);
    assert.ok(derived.some((t) => t.item === "audit cache" && t.reason === "pending sub-goal"));
    assert.ok(derived.some((t) => t.item === "fix resume" && t.reason === "blocked sub-goal"));
    assert.equal(intent[0]?.item, "verify migration");
    assert.equal(intent[0]?.priority, 0);
    assert.ok(todo.every((t) => t.id.startsWith("todo-")));
  });

  it("derives phase boundaries from milestones", () => {
    const response = compileResponse({
      rolling_summary: {
        key_outcomes: [],
        recurring_issues: [],
        rounds_sampled: 5,
        generated_at_round: 5,
        milestones: [
          { label: "Analysis", round_range: { start: 1, end: 3 }, kind: "agent_declared", outcome: "ok", progress_at_boundary: 0.4, carried_constraints: [], resolved_constraints: [], generated_at_round: 3 },
          { label: "Implementation", round_range: { start: 4, end: 5 }, kind: "agent_declared", outcome: "ok", progress_at_boundary: 0.8, carried_constraints: [], resolved_constraints: [], generated_at_round: 5 },
        ],
      },
    });
    const projection = buildLoopProjection({
      loopId: "proj-loop",
      currentRound: 6,
      compileResponse: response,
      vaultEntries: [],
    });
    assert.equal(projection?.phase?.boundaries.length, 2);
    assert.equal(projection?.phase?.label, "Implementation");
  });

  it("derives delegation as a record view from delegation journals", () => {
    const journal: VaultEntry = {
      id: "loop:proj-loop:r2:delegations",
      task_id: "loop:proj-loop:r2:delegations",
      task_type: "delegation_journal",
      loop_id: "proj-loop",
      timestamp: new Date().toISOString(),
      loop_lineage: {
        round: 2,
        delegations: [
          { index: 1, agentId: "w1", subTask: "write tests", resultSummary: "done", success: true, outcome: "success" },
          { index: 2, agentId: "w2", subTask: "refactor", resultSummary: "blocked", success: false, outcome: "failed" },
        ],
      },
    };
    const projection = buildLoopProjection({
      loopId: "proj-loop",
      currentRound: 3,
      compileResponse: compileResponse(),
      vaultEntries: [journal],
    });
    assert.equal(projection?.delegation.pending, 1);
    assert.equal(projection?.delegation.last_results.length, 2);
    assert.equal(projection?.delegation.last_results[0].outcome, "success");
    assert.equal(projection?.delegation.last_results[0].round, 2);
  });

  it("passes verified cr-IDs and open gates into the handoff", () => {
    const response = compileResponse({
      rolling_summary: {
        key_outcomes: [],
        recurring_issues: ["flaky test"],
        rounds_sampled: 3,
        generated_at_round: 3,
        loop_synthesis: "task at 60%",
      },
    });
    const projection = buildLoopProjection({
      loopId: "proj-loop",
      currentRound: 4,
      compileResponse: response,
      vaultEntries: [],
      verifiedClaims: ["cr-abcdef12"],
      openGates: ["Deploy to production"],
    });
    assert.equal(projection?.handoff.summary, "task at 60%");
    assert.deepEqual(projection?.handoff.verified, ["cr-abcdef12"]);
    assert.ok(projection?.handoff.open_risks.includes("flaky test"));
    assert.ok(projection?.handoff.open_risks.some((r) => r.includes("Deploy to production")));
  });

  it("returns null when nothing meaningful can be derived", () => {
    const projection = buildLoopProjection({
      loopId: "proj-loop",
      currentRound: 1,
      compileResponse: compileResponse(),
      vaultEntries: [],
    });
    assert.equal(projection, null);
  });

  it("makeLoopProjection factory provides empty defaults", () => {
    const defaults = makeLoopProjection({});
    assert.deepEqual(defaults.delegation, { pending: 0, last_results: [] });
    assert.deepEqual(defaults.handoff, { summary: "", verified: [], open_risks: [] });
    assert.equal(defaults.focus, null);
    assert.deepEqual(defaults.todo, []);
  });
});
