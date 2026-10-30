/** v4.0.4 — ONE runtime round/context guidance source, and its pointer-only
 *  skill. These tests prevent the skill and the runtime from growing two
 *  different rule sets.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONTEXT_CONTINUITY_RULES,
  ROUND_BOUNDARY_NON_BOUNDARIES,
  ROUND_BOUNDARY_PRINCIPLE,
  ROUND_BOUNDARY_SIZING,
  ROUND_BOUNDARY_SUBMISSION,
  formatContextBoundaryLabel,
  renderRoundGuidance,
} from "../round-guidance.js";
import { promptContextPairIssue } from "../context-boundary.js";
import { SERVER_INSTRUCTIONS } from "../mcp/server.js";
import { fieldGuideDescription } from "../submission-guidance.js";

const SKILL_DIR = resolve(process.cwd(), "skills", "forge");

function skillFile(relative: string): string {
  return readFileSync(resolve(SKILL_DIR, relative), "utf-8");
}

describe("v4.0.4 — runtime round guidance", () => {
  it("renders every boundary rule from the shared constants", () => {
    const prompt = renderRoundGuidance("prompt", "fresh_invocation");
    for (const sentence of [
      ROUND_BOUNDARY_PRINCIPLE,
      ROUND_BOUNDARY_SIZING,
      ROUND_BOUNDARY_SUBMISSION,
      ROUND_BOUNDARY_NON_BOUNDARIES,
    ]) {
      assert.ok(prompt.includes(sentence), "prompt guidance must use the shared constant");
    }
    // The L0 footer has a hard policy ceiling; keep the fresh body compact.
    assert.ok(prompt.length <= 480,
      `fresh prompt guidance must stay <= 480 chars, got ${prompt.length}`);
    assert.ok(!prompt.includes(CONTEXT_CONTINUITY_RULES),
      "the host-only continuity contract is not repeated in the prompt");
  });

  it("renders the short retry form only for an in-context retry", () => {
    const retry = renderRoundGuidance("prompt", "same_round_retry");
    assert.ok(retry.includes(ROUND_BOUNDARY_SUBMISSION));
    assert.ok(retry.includes(ROUND_BOUNDARY_NON_BOUNDARIES));
    assert.ok(!retry.includes(ROUND_BOUNDARY_PRINCIPLE));
    assert.ok(!retry.includes(ROUND_BOUNDARY_SIZING));
  });

  it("the server instructions carry the boundary rules and the host contract", () => {
    for (const sentence of [
      ROUND_BOUNDARY_PRINCIPLE,
      ROUND_BOUNDARY_SIZING,
      ROUND_BOUNDARY_SUBMISSION,
      ROUND_BOUNDARY_NON_BOUNDARIES,
      CONTEXT_CONTINUITY_RULES,
    ]) {
      assert.ok(SERVER_INSTRUCTIONS.includes(sentence),
        "server instructions must use the shared guidance");
    }
    assert.ok(SERVER_INSTRUCTIONS.includes(renderRoundGuidance("server")));
    assert.ok(!SERVER_INSTRUCTIONS.includes("agent-process boundary"));
    assert.ok(!SERVER_INSTRUCTIONS.includes("outer agent rounds"));
  });

  it("maps every legal context tuple to a strategy label and never prints the old enum", () => {
    const labels = [
      formatContextBoundaryLabel("fresh_invocation", "first_round"),
      formatContextBoundaryLabel("fresh_invocation", "next_round"),
      formatContextBoundaryLabel("fresh_invocation", "recovery_redo"),
      formatContextBoundaryLabel("fresh_invocation", "enforcement_retry"),
      formatContextBoundaryLabel("fresh_invocation", "enforcement_retry", {
        recoveryBoundary: true,
      }),
      formatContextBoundaryLabel("fresh_invocation", "rejection_escalation"),
      formatContextBoundaryLabel("fresh_invocation", "rejection_escalation", {
        recoveryBoundary: true,
      }),
      formatContextBoundaryLabel("same_round_retry", "enforcement_retry"),
    ];
    assert.deepEqual(labels, [
      "clean context — first round (fresh_invocation)",
      "clean context — next round (fresh_invocation; workspace continues)",
      "clean context after restore (fresh_invocation; recovery_redo; lessons carried)",
      "clean context repair (fresh_invocation; enforcement_retry; same logical round; lessons carried)",
      "clean context repair + recovery retry (fresh_invocation; enforcement_retry; recovery lessons carried)",
      "clean context repair (fresh_invocation; rejection_escalation; same logical round; rejected posture is attempt-time only)",
      "clean context repair + recovery retry (fresh_invocation; rejection_escalation; recovery lessons carried)",
      "in-context repair (same_round_retry; enforcement_retry; continue original invocation if alive; lessons injected)",
    ]);
    for (const label of labels) {
      assert.ok(!label.includes("fresh_round"));
    }
  });
});

describe("v4.0.4 — context pair legality is fail-closed", () => {
  it("allows same_round_retry at any prompt level", () => {
    assert.equal(promptContextPairIssue({
      level: "l2",
      mode: "same_round_retry",
      reason: "enforcement_retry",
      attempt: 2,
      round: 3,
    }), null);
  });

  it("same_round_retry requires attempt>1 and enforcement_retry", () => {
    assert.ok(promptContextPairIssue({
      level: "l0", mode: "same_round_retry", reason: "enforcement_retry",
      attempt: 1, round: 3,
    }));
    assert.ok(promptContextPairIssue({
      level: "l0", mode: "same_round_retry", reason: "next_round",
      attempt: 2, round: 3,
    }));
    assert.equal(promptContextPairIssue({
      level: "l0", mode: "same_round_retry", reason: "enforcement_retry",
      attempt: 2, round: 3,
    }), null);
  });

  it("rejection escalation requires a retry attempt and starts clean", () => {
    assert.ok(promptContextPairIssue({
      level: "l2", mode: "fresh_invocation", reason: "rejection_escalation",
      attempt: 1, round: 3,
    }));
    assert.equal(promptContextPairIssue({
      level: "l0", mode: "fresh_invocation", reason: "rejection_escalation",
      attempt: 3, round: 3,
    }), null);
  });

  it("fresh retry and first-round pairs require matching attempt/round", () => {
    assert.ok(promptContextPairIssue({
      level: "l2", mode: "fresh_invocation", reason: "enforcement_retry",
      attempt: 2, round: 3,
    }));
    assert.ok(promptContextPairIssue({
      level: "l2", mode: "fresh_invocation", reason: "first_round",
      attempt: 1, round: 2,
    }));
    assert.equal(promptContextPairIssue({
      level: "l2", mode: "fresh_invocation", reason: "first_round",
      attempt: 1, round: 1,
    }), null);
    // L2 on a normal next round is legal and clean.
    assert.equal(promptContextPairIssue({
      level: "l2", mode: "fresh_invocation", reason: "next_round",
      attempt: 1, round: 4,
    }), null);
  });
});

describe("v4.0.4 — the skill points at the runtime rules", () => {
  it("states the definition and pointer without restating executable sizing rules", () => {
    const skill = skillFile("SKILL.md");
    assert.ok(skill.includes("## Round Boundary"),
      "the skill must point at the prompt's runtime Round Boundary section");
    assert.ok(skill.includes("MCP server instructions"),
      "the skill must point at the server instructions");
    for (const removed of [
      "Before choosing the slice",
      "Make a round larger when",
      "Before each agent-process boundary",
      "outer agent rounds",
      "fresh_round",
    ]) {
      assert.ok(!skill.includes(removed), `skill must not restate: ${removed}`);
    }
  });

  it("the skill's context examples are legal under the current boundary contract", () => {
    const skill = skillFile("SKILL.md");
    const examples = skill.split("\n").filter((line) => line.startsWith("Context: "));
    assert.ok(examples.length >= 4, "the advertised strategies must be exercised");
    for (const example of examples) {
      const fields = example.slice(example.indexOf("(") + 1).split(";");
      const mode = fields[0]!.trim() as Parameters<typeof promptContextPairIssue>[0]["mode"];
      const reason = fields[1]!.trim().replace(")", "") as Parameters<typeof promptContextPairIssue>[0]["reason"];
      assert.equal(promptContextPairIssue({
        level: "l2", mode, reason, round: 3,
        attempt: reason === "enforcement_retry" || reason === "rejection_escalation" ? 2 : 1,
      }), null, `advertised strategy is illegal: ${example}`);
    }
    assert.ok(skill.includes(formatContextBoundaryLabel(
      "fresh_invocation", "rejection_escalation",
    )), "the clean retry example must name rejection escalation");
  });

  it("calls subtask_boundary a subtask boundary, never a workspace checkpoint", () => {
    const description = fieldGuideDescription("subtask_boundary");
    assert.ok(description.includes("subtask boundary"));
    assert.ok(!description.toLowerCase().includes("checkpoint"));
  });

  it("the references do not define a second context/L0 rule set", () => {
    const reference = skillFile("references/recovery-and-views.md");
    assert.ok(reference.includes("Round Boundary"));
    assert.ok(!reference.includes("fresh_round"));
    assert.ok(!reference.includes("L0 is a same-round retry"));
    const evidence = skillFile("references/evidence-and-contracts.md");
    assert.ok(!evidence.includes("`stop_reason`"));
    assert.ok(evidence.includes("agent_stop_reason"));
  });
});
