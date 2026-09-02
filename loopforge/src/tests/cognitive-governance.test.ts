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
