/** v4.0.4 — the ONE result-facts presentation: Agent report, LoopForge
 *  decision, Machine evidence. The three kinds never collapse into one
 *  verdict, and `completed` never implies machine-backed success.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderResultFacts, type ResultFacts } from "../result-facts.js";
import { fixtureEvidencePosture } from "./_helpers.js";

function facts(overrides: Partial<ResultFacts> = {}): ResultFacts {
  return {
    agent: {
      successClaim: true,
      outcome: "success",
      outcomeDeclared: null,
      shouldContinue: false,
      agentStopReason: null,
    },
    loopforge: {
      action: "stop",
      loopStopReason: "completed",
      enforcementReason: null,
    },
    machine: {
      posture: fixtureEvidencePosture(1, {
        status: "insufficient",
        machineBackedSuccess: false,
      }),
      committed: true,
    },
    ...overrides,
  };
}

function text(value: ResultFacts): string {
  return renderResultFacts(value, "terminal").join("\n");
}

describe("v4.0.4 — result facts stay separate", () => {
  it("renders the three blocks in the fixed order", () => {
    const rendered = renderResultFacts(facts(), "explain").join("\n");
    const agent = rendered.indexOf("Agent report");
    const decision = rendered.indexOf("LoopForge decision");
    const machine = rendered.indexOf("Machine evidence");
    assert.ok(agent >= 0 && decision > agent && machine > decision);
    assert.ok(rendered.includes("  success_claim: true"));
    assert.ok(rendered.includes("  action: stop"));
    assert.ok(rendered.includes("  loop_stop_reason: completed"));
    assert.ok(rendered.includes("evidence coverage, not task success"));
  });

  it("completed never implies machine-backed success", () => {
    const rendered = text(facts());
    assert.ok(rendered.includes("  loop_stop_reason: completed"));
    assert.ok(rendered.includes("machine_backed_success: false"));
    assert.ok(!rendered.includes("successfully"));
    assert.ok(!rendered.includes("Task completed"));
  });

  it("distinguishes a derived outcome from a declared one", () => {
    const derived = text(facts({
      agent: {
        successClaim: false,
        outcome: "failed",
        outcomeDeclared: null,
        shouldContinue: false,
        agentStopReason: "blocked",
      },
      loopforge: { action: "stop", loopStopReason: "failed", enforcementReason: null },
    }));
    assert.ok(derived.includes("outcome: failed (derived; declared: none)"));
    assert.ok(derived.includes("agent_stop_reason: blocked"));

    const declared = text(facts({
      agent: {
        successClaim: false,
        outcome: "partial",
        outcomeDeclared: "partial",
        shouldContinue: true,
        agentStopReason: null,
      },
    }));
    assert.ok(declared.includes("outcome: partial (declared)"));
    assert.ok(declared.includes("agent_stop_reason: none"));
  });

  it("a rollback directive has no Agent report", () => {
    const rendered = text(facts({
      agent: null,
      loopforge: { action: "backtrack", loopStopReason: null, enforcementReason: null },
    }));
    assert.ok(rendered.includes("none (rollback directive)"));
  });

  it("a present but uncommitted posture is labelled transient", () => {
    const rendered = text(facts({
      machine: {
        posture: fixtureEvidencePosture(1, { status: "contradicted" }),
        committed: false,
      },
    }));
    assert.ok(rendered.includes("Machine evidence (transient; not committed)"));
    assert.ok(rendered.includes("- status: contradicted (evidence coverage, not task success)"));
  });

  it("a missing posture is 'not available', never a false machine denial", () => {
    const rendered = text(facts({
      machine: { posture: null, committed: false },
    }));
    assert.ok(rendered.includes("Machine evidence (transient; not committed)"));
    assert.ok(rendered.includes("not available in this projection"));
    assert.ok(!rendered.includes("machine_backed_success: false"));
  });

  it("never emits a derived conflict/verdict/success boolean", () => {
    const rendered = text(facts());
    assert.ok(!/\bconflict\b/i.test(rendered));
    assert.ok(!/\bverdict\b/i.test(rendered));
    assert.ok(!/^  success:/m.test(rendered));
  });

  it("explain density uses the full shared posture renderer", () => {
    const rendered = renderResultFacts(facts(), "explain").join("\n");
    assert.ok(rendered.includes("- status: insufficient (evidence coverage, not task success)"));
    assert.ok(rendered.includes("- machine_backed_success: false"));
  });
});
