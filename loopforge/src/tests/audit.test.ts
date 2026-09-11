/** v2.12: Read-only end-of-loop audit — claims, gates, verdict, sequence. */
import { criterionClaims, installTestCommandProvider } from "./_helpers.js";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAudit } from "../audit.js";
import { FileLoopStore } from "../loop-store.js";
import type { VaultEntry } from "../loop-store.js";
import { deriveContractItemIds } from "../token-utils.js";

/** "verify" is the command installTestCommandProvider configures. */
const CONTRACT = {
  work_item: "Slice A",
  scope: ["src/a"],
  items: [{
    description: "works",
    criterion_refs: [],
    subgoal_refs: [],
    verify_with: ["verify"],
  }],
};

function commandObservation(status: "passed" | "failed"): Record<string, unknown> {
  return {
    schemaVersion: 1,
    providerId: "command:verify",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      commandId: "verify",
      argv: ["node", "-e", "verify"],
      cwd: ".",
      configHash: "0".repeat(64),
      required: false,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
    },
  };
}

function committedFeedback(
  round: number,
  evaluation: Record<string, unknown>,
  flags: Array<Record<string, unknown>> = [],
  action = "continue",
  afterEvidence: unknown[] = [],
): VaultEntry {
  return {
    id: `loop:audit-loop:r${round}:feedback`,
    task_id: `loop:audit-loop:r${round}:feedback`,
    task_type: "feedback",
    loop_id: "audit-loop",
    timestamp: new Date().toISOString(),
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: 2,
        round_id: `loop:audit-loop:round:${round}`,
        snapshot: {
          schemaVersion: 2,
          roundId: `loop:audit-loop:round:${round}`,
          loopId: "audit-loop",
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: [],
          afterEvidence,
          evaluation,
          result: { action, verificationFlags: flags },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        result: { action, verificationFlags: flags },
      },
    },
  };
}

function gateOpened(gateId: string, description: string): VaultEntry {
  return {
    id: `loop:audit-loop:gate:${gateId}`,
    task_id: `loop:audit-loop:gate:${gateId}`,
    task_type: "gate_opened",
    loop_id: "audit-loop",
    timestamp: new Date().toISOString(),
    gate_id: gateId,
    gate_action: description,
    loop_lineage: { round: 2, gate_id: gateId },
  };
}

function gateDecision(gateId: string, approved: boolean, at: string): VaultEntry {
  return {
    id: `loop:audit-loop:gate:${gateId}:decision`,
    task_id: `loop:audit-loop:gate:${gateId}:decision`,
    task_type: "gate_decision",
    loop_id: "audit-loop",
    timestamp: at,
    gate_id: gateId,
    approved,
    gate_decision: {
      gateId,
      kind: "user",
      approved,
      scope: ["prod"],
      note: "",
      decidedAt: at,
      actionHash: "abc123",
    },
    loop_lineage: { round: 2, gate_id: gateId, action_hash: "abc123" },
  };
}

describe("buildAudit", () => {
  it("returns passed for an empty loop with no store", () => {
    const audit = buildAudit("audit-loop", []);
    assert.equal(audit.verdict, "passed");
    assert.equal(audit.provenanceAvailable, false);
    assert.equal(audit.sequenceComplete, true);
  });

  it("aggregates rounds with outcomes and checks from committed snapshots", () => {
    const entries = [
      committedFeedback(1, { success: true, output_summary: "r1", constraint_violations: [], should_continue: true }),
      committedFeedback(2, { success: false, output_summary: "r2", constraint_violations: [], should_continue: true }, [
        { severity: "error", field: "success", check: "required_command_failed", detail: "npm test failed" },
      ]),
    ];
    const audit = buildAudit("audit-loop", entries);
    assert.equal(audit.rounds.length, 2);
    assert.equal(audit.rounds[0].outcome, "success");
    assert.equal(audit.rounds[1].outcome, "failed");
    assert.equal(audit.rounds[1].checks[0].verdict, "failed");
    assert.equal(audit.verdict, "contradicted");
  });

  it("reports criteria as evidenced only when claims are machine-verified", () => {
    const entries = [
      committedFeedback(1, {
        success: true,
        output_summary: "r1",
        constraint_violations: [],
        should_continue: false,
        execution_report: {
          files_changed: ["src/a.ts"],
          tests_reported: { passed: 2, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims(["tests pass"], []),
          progress_estimate: 1,
        },
      }),
    ];
    const audit = buildAudit("audit-loop", entries);
    assert.equal(audit.criteria.declared, 1);
    // No command snapshot observed → claims stay claimed → not evidenced.
    assert.equal(audit.criteria.evidenced, 0);
    assert.equal(audit.verdict, "incomplete");
  });

  it("v3.8: reports each round's executed contract and the contract's closure", () => {
    installTestCommandProvider();
    const itemId = deriveContractItemIds(CONTRACT.items)[0];
    const entries = [
      committedFeedback(1, {
        success: false, output_summary: "declared", constraint_violations: [], should_continue: true,
        round_contract: CONTRACT,
      }),
      committedFeedback(2, {
        success: true, output_summary: "verified", constraint_violations: [], should_continue: true,
        execution_report: {
          files_changed: [],
          criterion_claims: [],
          contract_item_claims: [{ item_id: itemId, outcome: "met" }],
        },
      }, [], "continue", [commandObservation("passed")]),
    ];
    const audit = buildAudit("audit-loop", entries);

    assert.equal(audit.rounds[0].contract, null,
      "the declaring round's proposal is for the NEXT round — it executed under nothing");
    assert.equal(audit.rounds[1].contract?.closure, "verified");
    assert.equal(audit.rounds[1].contract?.declared_at_round, 1);
    assert.deepEqual(audit.rounds[1].contract?.items.map((item) => item.status), ["verified"]);

    assert.equal(audit.contracts.contracts.length, 1);
    const contract = audit.contracts.contracts[0];
    assert.equal(contract.declared_at_round, 1);
    assert.equal(contract.first_active_round, 2);
    assert.equal(contract.last_active_round, 2);
    assert.equal(contract.closure, "verified");
    assert.equal(contract.closed_at_round, 2);
    assert.equal(audit.contracts.open, 0);
    assert.equal(audit.contracts.verifiedItems, 1);
    assert.equal(audit.verdict, "passed");
  });

  it("v3.8: an unbacked claim leaves the contract open and the audit incomplete", () => {
    installTestCommandProvider();
    const itemId = deriveContractItemIds(CONTRACT.items)[0];
    const audit = buildAudit("audit-loop", [
      committedFeedback(1, {
        success: false, output_summary: "declared", constraint_violations: [], should_continue: true,
        round_contract: CONTRACT,
      }),
      committedFeedback(2, {
        success: true, output_summary: "claimed", constraint_violations: [], should_continue: true,
        execution_report: {
          files_changed: [],
          criterion_claims: [],
          contract_item_claims: [{ item_id: itemId, outcome: "met" }],
        },
      }),
    ]);
    assert.equal(audit.rounds[1].contract?.items[0].status, "insufficient");
    assert.equal(audit.contracts.contracts[0].closure, "open");
    assert.equal(audit.contracts.open, 1);
    assert.equal(audit.contracts.insufficientItems, 1);
    assert.equal(audit.verdict, "incomplete",
      "an open contract is unfinished verification, whatever the claims say");
  });

  it("v3.8: a contradicted item flips the verdict even without an error flag", () => {
    installTestCommandProvider();
    const itemId = deriveContractItemIds(CONTRACT.items)[0];
    const audit = buildAudit("audit-loop", [
      committedFeedback(1, {
        success: false, output_summary: "declared", constraint_violations: [], should_continue: true,
        round_contract: CONTRACT,
      }),
      committedFeedback(2, {
        success: true, output_summary: "claimed", constraint_violations: [], should_continue: false,
        execution_report: {
          files_changed: [],
          criterion_claims: [],
          contract_item_claims: [{ item_id: itemId, outcome: "met" }],
        },
      }, [], "continue", [commandObservation("failed")]),
    ]);
    assert.equal(audit.contracts.contradictedItems, 1);
    assert.equal(audit.verdict, "contradicted",
      "the machine denied the claim — that is a contradiction, not a gap");
  });

  it("v3.8: declared and evidenced are comparable distinct-id counts", () => {
    const claim = (text: string) => ({
      success: false,
      output_summary: `r ${text}`,
      constraint_violations: [],
      should_continue: true,
      execution_report: {
        files_changed: ["src/a.ts"],
        criterion_claims: criterionClaims([text]),
      },
    });
    const audit = buildAudit("audit-loop", [
      committedFeedback(1, claim("tests pass")),
      committedFeedback(2, claim("tests pass")),
    ]);
    assert.equal(audit.criteria.declared, 1,
      "the same criterion claimed twice is ONE declared criterion");
    assert.equal(audit.criteria.evidenced, 0);
    assert.equal(audit.criteria.missing, 1);
  });

  it("keeps the latest gate decision and lists unresolved user gates", () => {
    const entries = [
      gateOpened("gate-abc", "Deploy to production"),
      gateDecision("gate-abc", true, "2026-08-01T00:00:00.000Z"),
      gateDecision("gate-abc", false, "2026-08-02T00:00:00.000Z"),
      gateOpened("gate-def", "Production database migration"),
    ];
    const audit = buildAudit("audit-loop", entries);
    assert.equal(audit.gates.length, 1);
    assert.equal(audit.gates[0].approved, false); // latest wins
    assert.equal(audit.unresolvedUserGates.length, 1);
    assert.ok(audit.unresolvedUserGates[0].includes("gate-def"));
  });

  it("treats benign blockers as agent gates (not unresolved user gates)", () => {
    const entries = [gateOpened("gate-123", "依赖版本冲突，需要升级内部库")];
    const audit = buildAudit("audit-loop", entries);
    assert.equal(audit.unresolvedUserGates.length, 0);
    assert.equal(audit.verdict, "passed");
  });

  it("reports sequence gaps via the store (recoverable)", () => {
    const dir = mkdtempSync(join(tmpdir(), "loopforge-audit-"));
    try {
      const store = new FileLoopStore(dir);
      for (const round of [1, 2, 3]) {
        store.appendEntry(committedFeedback(round, { success: true, output_summary: `r${round}`, constraint_violations: [], should_continue: true }));
      }
      // Simulate a manual file deletion: round 2's document disappears.
      const hash = createHash("sha256").update("audit-loop").digest("hex");
      rmSync(join(dir, "loops", hash, "rounds", "2.json"));
      const entries = store.listEntries();
      const audit = buildAudit("audit-loop", entries, store);
      assert.equal(audit.sequenceComplete, false);
      assert.equal(audit.provenanceAvailable, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is read-only: never mutates the entries array", () => {
    const entries = [
      committedFeedback(1, { success: true, output_summary: "r1", constraint_violations: [], should_continue: true }),
      gateOpened("gate-abc", "Deploy to production"),
    ];
    const before = JSON.stringify(entries);
    buildAudit("audit-loop", entries);
    assert.equal(JSON.stringify(entries), before);
  });

  it("excludes rolled-back rounds from the round list and verdict", () => {
    // Round 1 committed with action="backtrack" (rolled back) and carries
    // error-level flags; round 2 is a normal committed round.
    const entries = [
      committedFeedback(
        1,
        { success: true, output_summary: "stalled work", constraint_violations: [], should_continue: true },
        [{ severity: "error", check: "success_with_remaining_criteria", field: "success", detail: "stalled" }],
        "backtrack",
      ),
      committedFeedback(
        2,
        { success: true, output_summary: "clean round", constraint_violations: [], should_continue: true },
      ),
    ];
    const audit = buildAudit("audit-loop", entries);
    // v2.14: rolled-back rounds are not part of the final history — their
    // error flags must not flip the verdict either.
    assert.equal(audit.rounds.length, 1);
    assert.equal(audit.rounds[0].round, 2);
    assert.equal(audit.verdict, "passed");
  });
});
