/** v4.0.3 — read-surface consistency.
 *
 *  Replay, explain, audit and metrics all read the SAME persisted posture and
 *  the SAME Git union selector. Agent claims are named as claims; truncated
 *  fields carry explicit metadata; legacy envelope positions stay in the
 *  replay window.
 */

import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ReplayBackend } from "../replay.js";
import { buildExplain } from "../explain.js";
import { buildAudit } from "../audit.js";
import { derivePolicyMetrics } from "../policy-metrics.js";
import type { VaultEntry } from "../loop-store.js";
import type {
  CheckpointRef,
  CommandObservation,
  EvidencePosture,
  GitObservation,
  RoundContractProposal,
} from "../protocol.js";
import {
  deriveContractId,
  deriveContractItemIds,
  deriveCriterionId,
} from "../token-utils.js";
import {
  MemoryLoopStore,
  committedFeedbackRound,
  fixtureEvidencePosture,
} from "./_helpers.js";

function checkpoint(
  loopId: string,
  round: number,
  role: "before" | "mid",
  transactionId: string,
): CheckpointRef {
  return {
    checkpointId: `ck-${createHash("sha256")
      .update(`${loopId}:${round}:${role}`).digest("hex").slice(0, 24)}`,
    contentHash: createHash("sha256")
      .update(`${loopId}:${round}:${role}:content`).digest("hex"),
    role,
    round,
    roundId: `loop:${loopId}:round:${round}`,
    transactionId,
    branchId: `loop:${loopId}:branch:root`,
    redoRound: round,
    createdAt: 1,
  };
}

function commandObservation(
  commandId: string,
  status: CommandObservation["status"],
): CommandObservation {
  return {
    schemaVersion: 1,
    providerId: `command:${commandId}`,
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status,
    files: [],
    data: {
      commandId,
      argv: ["node", "verify.js"],
      cwd: ".",
      configHash: "declared-hash",
      required: true,
      exitCode: status === "passed" ? 0 : 1,
      signal: null,
      durationMs: 1,
      stdoutSha256: "0".repeat(64),
      stderrSha256: "0".repeat(64),
      stdoutExcerpt: "Tests: 3 passed, 3 total",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: ["scripts/verify.js"],
    },
  };
}

function gitObservation(
  providerId: string,
  head: string,
  files: string[],
  fingerprints: Record<string, string>,
  phase: "before" | "after",
): GitObservation {
  return {
    schemaVersion: 2,
    providerId,
    kind: "git",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files,
    data: {
      dirty: files,
      fingerprints,
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

describe("v4.0.3 — replay surfaces", () => {
  it("reads the persisted posture, command statuses and checkpoints", () => {
    const loopId = "replay-surface";
    const transactionId = `tx-${loopId}-1-1`;
    const before = checkpoint(loopId, 1, "before", transactionId);
    const mid = checkpoint(loopId, 1, "mid", transactionId);
    const entry = committedFeedbackRound(1, {
      loopId,
      success: true,
      outcome: "success",
      outputSummary: "x".repeat(4200),
      wrongAssumptions: ["old belief"],
      openQuestions: ["still open?"],
      blocker: "needs input",
      noChangeReason: "no code change needed",
      subtaskBoundary: true,
      subtaskBoundaryLabel: "parser complete",
      workerResults: [{
        agentId: "w1",
        subTask: "scan",
        resultSummary: "found the seam",
        outcome: "success",
      }],
      retroactiveClaims: [{ round: 1, claim: "earlier work" }],
      gateIds: ["gate-1"],
      subgoalUpdates: [{ id: "sg-1", status: "done", note: "finished" }],
      contractTransition: {
        kind: "supersede",
        contract_id: "rc-12345678",
        reason: "route changed",
      },
      roundEvidence: [commandObservation("verify", "passed")],
      beforeCheckpoint: before,
      checkpoints: [mid],
      restore: {
        directiveTransactionId: `loop:${loopId}:branch:root`,
        redoRound: 1,
        verifiedAt: 2,
      },
      evidencePosture: fixtureEvidencePosture(1, {
        status: "verified",
        machineBackedSuccess: true,
        verificationConfigured: true,
        commands: [{ commandId: "verify", status: "passed", required: true }],
      }),
    });
    const store = new MemoryLoopStore();
    store.appendEntry(entry);
    const [row] = new ReplayBackend(store).timeline(loopId);
    assert.ok(row);
    assert.equal(row.agent_success_claim, true);
    assert.equal(row.agent_outcome, "success");
    assert.equal(row.machine_backed_success, true);
    assert.equal((row.evidence_posture as EvidencePosture).status, "verified");
    assert.deepEqual(row.command_statuses, [
      { command_id: "verify", status: "passed" },
    ]);
    assert.deepEqual(row.checkpoints, [
      { checkpoint_id: before.checkpointId, role: "before", round: 1, content_hash: before.contentHash },
      { checkpoint_id: mid.checkpointId, role: "mid", round: 1, content_hash: mid.contentHash },
    ]);
    assert.equal(row.restore_verified, true);
    assert.equal((row.truncation as Record<string, boolean>).output_summary, true);
    const report = row.report as Record<string, unknown>;
    assert.equal(report.no_change_reason, "no code change needed");
    assert.equal(report.subtask_boundary_label, "parser complete");
    assert.deepEqual(report.gate_ids, ["gate-1"]);
    assert.equal((report.worker_results as unknown[]).length, 1);
    assert.equal((report.retroactive_claims as unknown[]).length, 1);
    assert.deepEqual(report.subgoal_updates, [
      { id: "sg-1", status: "done", status_note: "finished" },
    ]);
  });

  it("unions every Git provider and reports a head only when all agree", () => {
    const loopId = "git-union";
    const entry = committedFeedbackRound(1, {
      loopId,
      beforeEvidence: [
        gitObservation("git", "aaa", [], {}, "before"),
        gitObservation("git-aux", "bbb", [], {}, "before"),
      ],
      roundEvidence: [
        gitObservation("git", "ccc", ["a.ts"], { "a.ts": "m:1" }, "after"),
        gitObservation("git-aux", "ddd", ["b.ts"], { "b.ts": "m:1" }, "after"),
      ],
    });
    const store = new MemoryLoopStore();
    store.appendEntry(entry);
    const [row] = new ReplayBackend(store).timeline(loopId);
    assert.equal(row.git_change_state, "observed");
    assert.deepEqual(
      [...(row.files_changed as string[])].sort(),
      ["a.ts", "b.ts"],
      "the change set is the union of every Git provider",
    );
    assert.equal(row.head_before, null,
      "disagreeing provider heads are unknown, not the first provider");
    assert.equal(row.head_after, null);
  });

  it("keeps legacy round positions in the replay window", () => {
    const loopId = "legacy-window";
    const store = new MemoryLoopStore();
    const legacy = committedFeedbackRound(1, { loopId });
    const transaction = (legacy.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    transaction.schema_version = 6;
    (transaction.snapshot as Record<string, unknown>).schemaVersion = 6;
    store.appendEntry(legacy);
    store.appendEntry(committedFeedbackRound(2, { loopId }));
    const page = new ReplayBackend(store).page(loopId);
    assert.equal(page.window.totalRounds, 2, "legacy positions are counted");
    assert.equal(page.window.start, 1);
    assert.equal(page.window.end, 2);
    assert.ok(page.timeline.some((row) => row.legacy === true));
  });
});

describe("v4.0.3 — explain surfaces", () => {
  it("exposes full before/after observations and the persisted posture", () => {
    const loopId = "explain-surface";
    const entry = committedFeedbackRound(1, {
      loopId,
      success: true,
      outputSummary: "done",
      noChangeReason: "docs only",
      subtaskBoundaryLabel: "slice done",
      workerResults: [{
        agentId: "w1", subTask: "scan", resultSummary: "ok", outcome: "success",
      }],
      retroactiveClaims: [{ round: 1, claim: "earlier" }],
      gateIds: ["gate-1"],
      subgoalUpdates: [{ id: "sg-1", status: "done", note: "note" }],
      beforeEvidence: [commandObservation("verify", "passed")],
      roundEvidence: [commandObservation("verify", "passed")],
      evidencePosture: fixtureEvidencePosture(1, {
        status: "verified",
        machineBackedSuccess: true,
      }),
    });
    const result = buildExplain(loopId, [entry]);
    const round = result.rounds[0]!;
    assert.equal(round.agentSuccessClaim, true);
    assert.equal(round.machineBackedSuccess, true);
    assert.equal(round.evidencePosture?.status, "verified");
    assert.equal(round.observations.before.length, 1);
    assert.equal(round.observations.after.length, 1);
    const data = round.observations.after[0]!.data;
    assert.equal(data.commandId, "verify");
    assert.deepEqual(data.argv, ["node", "verify.js"]);
    assert.equal(data.stdoutExcerpt, "Tests: 3 passed, 3 total");
    assert.equal(round.report?.no_change_reason, "docs only");
    assert.equal(round.report?.subtask_boundary_label, "slice done");
    assert.equal(round.report?.worker_results.length, 1);
    assert.equal(round.report?.retroactive_claims.length, 1);
    assert.deepEqual(round.report?.gate_ids, ["gate-1"]);
    assert.deepEqual(round.report?.subgoal_updates, [
      { id: "sg-1", status: "done", status_note: "note" },
    ]);
  });
});

describe("v4.0.3 — audit surfaces", () => {
  const CRITERION = "tests pass";
  const CRITERION_ID = deriveCriterionId(CRITERION);
  const CONTRACT: RoundContractProposal = {
    work_item: "verified slice",
    scope: [],
    items: [{
      description: "the command verifies it",
      criterion_refs: [CRITERION_ID],
      verify_with: ["verify"],
    }],
  };
  const ITEM_ID = deriveContractItemIds(CONTRACT.items)[0]!;
  const BINDING = {
    rc_id: deriveContractId("audit-surface", CONTRACT),
    item_ids: [ITEM_ID],
    config_hash_by_command: { verify: "declared-hash" },
  };

  it("declares criteria from the objective and evidences only machine facts", () => {
    const loopId = "audit-surface";
    const verifiedEntry = committedFeedbackRound(2, {
      loopId,
      criteria: [CRITERION],
      contractItemClaims: [{ item_id: ITEM_ID, outcome: "met" }],
      roundEvidence: [commandObservation("verify", "passed")],
      evidencePosture: fixtureEvidencePosture(2, {
        status: "verified",
        machineBackedSuccess: true,
        verificationConfigured: true,
      }),
    });
    const entries = [
      committedFeedbackRound(1, {
        loopId,
        criteria: [CRITERION],
        contract: CONTRACT,
        contractBinding: BINDING,
        evidencePosture: fixtureEvidencePosture(1),
      }),
      verifiedEntry,
    ];
    const audit = buildAudit(loopId, entries);
    assert.equal(audit.criteria.declared, 1, "declared comes from the objective");
    assert.equal(audit.criteria.evidenced, 1);
    assert.equal(audit.criteria.missing, 0);
    assert.equal(audit.evidenceVerdict, "verified");
    assert.equal(audit.verdict, "passed");
    assert.deepEqual(audit.rounds[1].claims, []);
  });

  it("reports an unbacked success as incomplete, never passed", () => {
    const loopId = "audit-unbacked";
    const entries = [
      committedFeedbackRound(1, {
        loopId,
        criteria: [CRITERION],
        success: true,
        met: [CRITERION],
        evidencePosture: fixtureEvidencePosture(1, {
          status: "insufficient",
          verificationConfigured: true,
        }),
      }),
    ];
    const audit = buildAudit(loopId, entries);
    assert.equal(audit.evidenceVerdict, "insufficient");
    assert.equal(audit.verdict, "incomplete");
    assert.equal(audit.criteria.declared, 1);
    assert.equal(audit.criteria.evidenced, 0);
  });

  it("filters another loop's rounds and gates out of the audit", () => {
    const loopId = "audit-filter";
    const entries = [
      committedFeedbackRound(1, { loopId }),
      committedFeedbackRound(1, { loopId: "other-loop" }),
      {
        task_id: `loop:other-loop:gate:g1`,
        task_type: "gate_opened",
        loop_id: "other-loop",
        gate_id: "g1",
        gate_action: "Deploy to production",
        loop_lineage: { round: 1 },
      } as VaultEntry,
    ];
    const audit = buildAudit(loopId, entries);
    assert.equal(audit.rounds.length, 1);
    assert.equal(audit.gates.length, 0);
    assert.deepEqual(audit.unresolvedUserGates, []);
  });
});

describe("v4.0.3 — metrics separate claims from machine facts", () => {
  it("counts agent-claimed success and machine-backed success separately", () => {
    const loopId = "metrics-surface";
    const entries = [
      committedFeedbackRound(1, {
        loopId,
        success: true,
        outcome: "success",
        evidencePosture: fixtureEvidencePosture(1, {
          status: "verified",
          machineBackedSuccess: true,
        }),
      }),
      committedFeedbackRound(2, {
        loopId,
        success: true,
        outcome: "partial",
        evidencePosture: fixtureEvidencePosture(2, {
          status: "insufficient",
          machineBackedSuccess: false,
        }),
      }),
    ];
    const metrics = derivePolicyMetrics(loopId, entries);
    assert.equal(metrics.agentClaimedSuccessRounds, 1);
    assert.equal(metrics.machineBackedSuccessRounds, 1);
    assert.equal(metrics.evidenceStatusCounts.verified, 1);
    assert.equal(metrics.evidenceStatusCounts.insufficient, 1);
  });

  it("uses one Git provider set for files and head movement", () => {
    const loopId = "metrics-git";
    const entry = committedFeedbackRound(1, {
      loopId,
      beforeEvidence: [
        gitObservation("git", "aaa", [], {}, "before"),
        gitObservation("git-aux", "aaa", [], {}, "before"),
      ],
      roundEvidence: [
        gitObservation("git", "bbb", ["a.ts"], { "a.ts": "m:1" }, "after"),
        gitObservation("git-aux", "bbb", ["b.ts"], { "b.ts": "m:1" }, "after"),
      ],
    });
    const metrics = derivePolicyMetrics(loopId, [entry]);
    assert.equal(metrics.filesChangedRounds, 1);
    assert.equal(metrics.filesChangedTotal, 2);
    assert.equal(metrics.headMoveRounds, 1);
  });
});
