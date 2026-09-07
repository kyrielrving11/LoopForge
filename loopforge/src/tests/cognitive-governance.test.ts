/** v2.12: User/Agent gate classification and governance helpers. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeGateAction,
  gateActionHash,
  deriveStructuredGate,
  deriveGate,
  deriveGateId,
  deriveTodoId,
  auditOrder,
  preflightStructuredGate,
} from "../cognitive-governance.js";
import type { GateActionDescriptor } from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";

function descriptor(
  overrides: Partial<GateActionDescriptor> = {},
): GateActionDescriptor {
  return {
    description: "Deploy to production",
    scope: ["prod-api", "db"],
    effects: ["production"],
    reversibility: "irreversible",
    authorization: "user_required",
    ...overrides,
  };
}

describe("gate classification", () => {
  it("canonicalizes actions with sorted scope/effects (stable hash)", () => {
    const a = canonicalizeGateAction(descriptor({ scope: ["db", "prod-api"] }));
    const b = canonicalizeGateAction(descriptor({ scope: ["prod-api", "db"] }));
    assert.equal(a, b);
  });

  it("produces deterministic 16-hex action hashes", () => {
    const hash = gateActionHash(descriptor());
    assert.match(hash, /^[a-f0-9]{16}$/);
    assert.equal(gateActionHash(descriptor()), gateActionHash(descriptor()));
  });

  it("classifies production effects as a user gate", () => {
    const { gate } = deriveStructuredGate(descriptor());
    assert.equal(gate.kind, "user");
    assert.ok(gate.question?.includes("Deploy to production"));
  });

  it("classifies credentials/irreversible as user gates", () => {
    const credentials = deriveStructuredGate(descriptor({ effects: ["credentials"], reversibility: "reversible", authorization: "agent_allowed" }));
    assert.equal(credentials.gate.kind, "user");
    const irreversible = deriveStructuredGate(descriptor({ effects: ["workspace_write"], reversibility: "irreversible" }));
    assert.equal(irreversible.gate.kind, "user");
    const unknownAuth = deriveStructuredGate(descriptor({ effects: ["workspace_write"], reversibility: "reversible", authorization: "unknown" }));
    assert.equal(unknownAuth.gate.kind, "user");
  });

  it("classifies safe workspace actions as agent gates", () => {
    const { gate } = deriveStructuredGate(descriptor({
      description: "Refactor internal module",
      effects: ["workspace_write"],
      reversibility: "reversible",
      authorization: "agent_allowed",
    }));
    assert.equal(gate.kind, "agent");
    assert.ok(gate.suggestedResolution);
  });

  it("classifies Chinese high-risk text as a user gate", () => {
    const result = deriveGate("生产环境数据库迁移");
    assert.equal(result.gate.kind, "user");
  });

  it("classifies benign blocker text as an agent gate", () => {
    const result = deriveGate("依赖版本冲突，需要升级内部库");
    assert.equal(result.gate.kind, "agent");
  });

  it("gate id embeds the canonicalized text hash (changed text → new id)", () => {
    const a = deriveGate("Deploy to production");
    const b = deriveGate("Deploy to production and notify users");
    assert.notEqual(a.id, b.id);
    assert.equal(a.id, deriveGateId("Deploy to production"));
  });

  it("todo ids are stable and prefixed", () => {
    assert.match(deriveTodoId("audit cache layer"), /^todo-[a-f0-9]{8}$/);
    assert.equal(deriveTodoId("audit cache layer"), deriveTodoId("audit cache layer"));
  });
});

describe("auditOrder", () => {
  function entry(round: number, taskId: string, timestamp: string): VaultEntry {
    return {
      id: taskId,
      task_id: taskId,
      task_type: "lineage",
      loop_id: "x",
      timestamp,
      loop_lineage: { round },
    };
  }

  it("sorts by round first, then timestamp", () => {
    const entries = [
      entry(2, "loop:x:r2", "2026-08-01T00:00:00.000Z"),
      entry(1, "loop:x:r1", "2026-08-02T00:00:00.000Z"),
    ];
    const ordered = auditOrder(entries);
    assert.deepEqual(ordered.map((e) => e.task_id), ["loop:x:r1", "loop:x:r2"]);
  });

  it("keeps later decisions winning within a round by timestamp", () => {
    const entries = [
      entry(1, "loop:x:gate:g1:decision", "2026-08-01T00:00:00.000Z"),
      entry(1, "loop:x:gate:g1:decision", "2026-08-02T00:00:00.000Z"),
    ];
    const ordered = auditOrder(entries);
    assert.equal(ordered[ordered.length - 1].task_id, "loop:x:gate:g1:decision");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// v3.7.1 — structured preflight (risk / decision / reason codes)
// ═══════════════════════════════════════════════════════════════════════════

describe("preflightStructuredGate (v3.7.1)", () => {
  it("classifies a provably safe workspace action as agent_allowed / low", () => {
    const verdict = preflightStructuredGate(descriptor({
      description: "Refactor src/store.ts",
      scope: ["src/store.ts"],
      effects: ["workspace_write"],
      reversibility: "reversible",
      authorization: "agent_allowed",
    }));
    assert.equal(verdict.decision, "agent_allowed");
    assert.equal(verdict.risk, "low");
    assert.equal(verdict.kind, "agent");
    assert.deepEqual(verdict.reasonCodes, []);
    assert.ok(verdict.requiredEvidence?.includes("src/store.ts"));
  });

  it("classifies production / credentials / publish effects as user_required with reason codes", () => {
    const verdict = preflightStructuredGate(descriptor({
      description: "Ship the release",
      scope: ["prod"],
      effects: ["production", "publish"],
      reversibility: "recoverable",
      authorization: "unknown",
    }));
    assert.equal(verdict.decision, "user_required");
    assert.equal(verdict.risk, "high");
    assert.deepEqual(verdict.reasonCodes,
      ["effects:production", "effects:publish", "authorization:unknown"]);
    assert.ok(verdict.approvalQuestion?.includes("Ship the release"));
    assert.ok(verdict.blockedScope?.includes("prod"));
  });

  it("is conservative: unknown authorization / empty effects are user_required with risk unknown", () => {
    const unknownAuth = preflightStructuredGate(descriptor({
      effects: ["workspace_write"],
      reversibility: "reversible",
      authorization: "unknown",
    }));
    assert.equal(unknownAuth.decision, "user_required");
    assert.equal(unknownAuth.risk, "unknown");

    const emptyEffects = preflightStructuredGate(descriptor({
      effects: [],
      reversibility: "reversible",
      authorization: "agent_allowed",
    }));
    assert.equal(emptyEffects.decision, "user_required", "cannot prove safety without effects");
    assert.ok(emptyEffects.reasonCodes.includes("effects_empty"));
  });

  it("flags irreversible and explicit user_required authorization", () => {
    const irreversible = preflightStructuredGate(descriptor({
      effects: ["workspace_write"],
      reversibility: "irreversible",
      authorization: "agent_allowed",
    }));
    assert.equal(irreversible.decision, "user_required");
    assert.ok(irreversible.reasonCodes.includes("reversibility:irreversible"));

    const explicit = preflightStructuredGate(descriptor({
      effects: ["workspace_write"],
      reversibility: "reversible",
      authorization: "user_required",
    }));
    assert.equal(explicit.decision, "user_required");
    assert.ok(explicit.reasonCodes.includes("authorization:user_required"));
  });

  it("binds the gate id to the canonical action — any change expires approval", () => {
    const base = preflightStructuredGate(descriptor({
      scope: ["db", "prod-api"],
      authorization: "user_required",
    }));
    const reordered = preflightStructuredGate(descriptor({
      scope: ["prod-api", "db"],
      authorization: "user_required",
    }));
    assert.equal(base.gateId, reordered.gateId, "field order must not change the id");
    const edited = preflightStructuredGate(descriptor({
      scope: ["prod-api", "db", "cache"],
      authorization: "user_required",
    }));
    assert.notEqual(base.gateId, edited.gateId, "a changed action expires old approvals");
  });
});
