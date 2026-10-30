/** v4.0.3 — retry and recovery continuity.
 *
 *  A rejected attempt's notice/findings/posture/attempt survive a restart and
 *  a failed retry compile; recovery digests keep machine and Agent facts
 *  separate; the Recovery Brief states the REAL restore marker; a resumed
 *  round never launders a missing entrypoint baseline.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_POLICY,
  getPolicy,
  resetPolicy,
  setPolicyForTest,
} from "../policy.js";
import {
  makeExecutionReport,
  makeSelfEvaluation,
  makeVerificationFlag,
  type CheckpointRef,
  type SelfEvaluation,
  type WorkspaceCheckpointManifest,
} from "../protocol.js";
import {
  deriveTransactionId,
  prepareRoundTransaction,
} from "../round-transaction.js";
import { buildLoopRequest } from "../mcp/round-lifecycle.js";
import type { McpSession } from "../mcp/round-lifecycle.js";
import { SessionManager } from "../mcp/session.js";
import {
  MemoryLoopStore,
  committedBacktrackRound,
  committedFeedbackRound,
  criterionClaims,
  fixtureEvidencePosture,
  installTestCommandProvider,
  advanceWithHeld,
} from "./_helpers.js";
import { derivationRounds } from "../committed-round.js";
import { deriveRecoveryDirective } from "../recovery.js";
import { findSafeRestorePoint } from "../enforcement-gate.js";
import { compileLoop } from "../loop-compiler.js";
import { makeLoopCompileRequest } from "../protocol.js";
import { derivePolicyMetrics } from "../policy-metrics.js";
import { deriveRoundObservationDelta } from "../round-transaction.js";
import { deriveRoundProgress } from "../progress.js";

afterEach(() => resetPolicy());

function rejectedEvaluation(): SelfEvaluation {
  return makeSelfEvaluation({
    success: true,
    output_summary: "claimed completion",
    constraint_violations: [],
    should_continue: true,
    execution_report: makeExecutionReport({
      files_changed: [],
      tests_reported: null,
      criterion_claims: criterionClaims(
        [], ["Task goal achieved with verifiable evidence"]),
    }),
  });
}

function continuingEvaluation(): SelfEvaluation {
  return makeSelfEvaluation({
    success: false,
    output_summary: "partial progress",
    constraint_violations: [],
    should_continue: true,
    execution_report: makeExecutionReport({
      files_changed: [],
      tests_reported: null,
      criterion_claims: criterionClaims(
        [], ["Task goal achieved with verifiable evidence"]),
    }),
  });
}

describe("v4.0.3 — RetryContext survives resume", () => {
  it("keeps attempt, notice, findings and posture across a restart", async () => {
    resetPolicy();
    installTestCommandProvider();
    const store = new MemoryLoopStore();
    const mgr = new SessionManager(store);
    const started = await mgr.create({
      task: "Retry continuity",
      loopId: "retry-continuity",
    });
    const sessionId = started.sessionId;

    const rejected = await advanceWithHeld(
      mgr, sessionId, "", rejectedEvaluation(),
    );
    assert.equal(rejected.enforcementAction, "reject");
    const rejectedSession = mgr.get(sessionId)!;
    const retry = rejectedSession.roundSnapshot?.retryContext;
    assert.ok(retry);
    assert.equal(retry!.attempt, 2);
    assert.equal(retry!.rejectedAttempt, 1);
    assert.match(retry!.rejectionNotice, /REJECTED/);
    assert.ok(retry!.verificationFlags.length > 0);
    assert.equal(retry!.evidencePosture.kind, "evaluation");
    assert.equal(
      store.listEntries("retry-continuity")
        .filter((entry) => entry.task_type === "feedback").length,
      0,
      "a rejected attempt never enters the Vault",
    );

    mgr.close();
    const restarted = new SessionManager(store);
    const resumed = await restarted.resume("retry-continuity");
    assert.ok(resumed?.prompt);
    assert.equal(resumed!.contextMode, "same_round_retry");
    const resumedSession = restarted.getByLoopId("retry-continuity")!;
    assert.equal(resumedSession.roundSnapshot?.retryContext?.attempt, 2);
    const guidance = restarted.getSubmissionGuidance(resumedSession.sessionId);
    assert.ok(guidance?.findings.some(
      (finding) => finding.check === "success_with_remaining_criteria"),
      "the retry's own findings are the guidance basis",
    );

    const accepted = await advanceWithHeld(
      restarted,
      resumedSession.sessionId,
      "",
      continuingEvaluation(),
      resumed!.submissionHandle,
    );
    assert.equal(accepted.round, 2);
    const committed = store.listEntries("retry-continuity")
      .find((entry) => entry.task_type === "feedback")!;
    const transaction = (committed.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    const snapshot = transaction.snapshot as Record<string, unknown>;
    assert.equal(snapshot.retryContext, undefined,
      "the retry commit clears transient evidence");
    assert.equal(
      restarted.getByLoopId("retry-continuity")?.roundSnapshot?.retryContext,
      undefined,
    );
  });

  it("rejection escalation starts clean context and labels posture as attempt-time", async () => {
    resetPolicy();
    installTestCommandProvider();
    const store = new MemoryLoopStore();
    const mgr = new SessionManager(store);
    const started = await mgr.create({
      task: "L2 retry",
      loopId: "retry-l2",
    });
    const first = await advanceWithHeld(
      mgr, started.sessionId, "", rejectedEvaluation(),
    );
    assert.equal(first.enforcementAction, "reject");
    assert.equal(first.contextMode, "same_round_retry");
    const second = await advanceWithHeld(
      mgr,
      started.sessionId,
      "",
      rejectedEvaluation(),
      first.submissionHandle,
    );
    assert.equal(second.enforcementAction, "reject");
    assert.equal(second.level, "l2");
    assert.equal(second.contextMode, "fresh_invocation");
    assert.equal(second.contextReason, "rejection_escalation");
    assert.match(second.prompt ?? "", /Machine Evidence — rejected attempt \(not committed\)/);
    assert.match(second.prompt ?? "", /not committed history/);
    assert.match(second.prompt ?? "", /not a current workspace snapshot/);
    assert.match(second.prompt ?? "", /Inspect the current workspace before acting/);
    assert.equal(
      store.listEntries("retry-l2")
        .filter((entry) => entry.task_type === "feedback").length,
      0,
    );
    mgr.close();
  });

  it("buildLoopRequest restores the retry context from a held snapshot", () => {
    const loopId = "retry-request";
    const retryContext = {
      attempt: 2,
      rejectedAttempt: 1,
      rejectionNotice: "redo it",
      verificationFlags: [makeVerificationFlag({
        severity: "error",
        field: "success",
        check: "success_with_remaining_criteria",
        detail: "remaining",
      })],
      evidencePosture: fixtureEvidencePosture(1, {
        status: "insufficient",
        verificationConfigured: true,
      }),
      rejectedAt: 1,
    };
    const snapshot = {
      ...prepareRoundTransaction(loopId, 1, []),
      phase: "prompted" as const,
      attempt: 2,
      retryContext,
    };
    const session = {
      sessionId: "s",
      loopId,
      task: "task",
      engine: {} as never,
      currentRound: 1,
      maxRounds: 10,
      status: "running" as const,
      createdAt: 1,
      consecutiveRejections: 1,
      lastRejectionCheck: "success_with_remaining_criteria",
      roundSnapshot: snapshot,
    } satisfies McpSession;
    const request = buildLoopRequest(session);
    assert.equal(request.attempt, 2);
    assert.equal(request.rejection_notice, "redo it");
    assert.equal(request.verification_flags?.length, 1);
    assert.equal(request.retry_evidence_posture?.status, "insufficient");
  });
});

describe("v4.0.3 — recovery digest provenance", () => {
  const loopId = "digest";
  const checkpointId = `ck-${"a".repeat(24)}`;
  const targetRef: CheckpointRef = {
    checkpointId,
    contentHash: "b".repeat(64),
    role: "before",
    round: 1,
    roundId: `loop:${loopId}:round:1`,
    transactionId: "tx-1",
    branchId: `loop:${loopId}:branch:root`,
    redoRound: 1,
    createdAt: 1,
  };
  const manifest: WorkspaceCheckpointManifest = {
    schemaVersion: 1,
    checkpointId,
    loopId,
    round: 1,
    role: "before",
    createdAt: 1,
    dirty: [],
    fingerprints: {},
    contents: [],
    coverage: "tracked_and_non_ignored_untracked",
    contentHash: "b".repeat(64),
  };
  const abandoned = () => derivationRounds([
    committedFeedbackRound(1, {
      loopId,
      outputSummary: "approach one",
      files: ["src/a.ts"],
      verificationFlags: [makeVerificationFlag({
        severity: "error",
        field: "round",
        check: "stall",
        detail: "flat",
      })],
    }),
    committedFeedbackRound(2, {
      loopId,
      outputSummary: "approach two",
      files: ["src/b.ts"],
    }),
  ], 3);
  const directive = (origin: "agent" | "machine") => deriveRecoveryDirective({
    origin,
    reason: "stall",
    transactionId: "tx-rollback",
    targetRef,
    targetManifest: manifest,
    abandonedRounds: abandoned(),
    currentAfterEvidence: [],
    triggerRound: 2,
    triggerEvaluation: makeSelfEvaluation({
      success: false,
      output_summary: "trigger",
      constraint_violations: [],
      should_continue: true,
    }),
    triggerFindings: [makeVerificationFlag({
      severity: "error",
      field: "round",
      check: "stall",
      detail: "flat",
    })],
  });

  it("splits observed/reported files and never treats a report as a failure", () => {
    const machine = directive("machine");
    assert.deepEqual(machine.abandoned_rounds, [1, 2]);
    assert.deepEqual(machine.failed_rounds, [1, 2],
      "machine-detected failures include the error round and the trigger");
    assert.deepEqual(machine.reported_skipped_files, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(machine.observed_skipped_files, []);
    assert.equal(machine.trigger_findings?.length, 1);
    assert.deepEqual(machine.approaches, ["approach one", "approach two", "trigger"]);

    const agent = directive("agent");
    assert.deepEqual(agent.failed_rounds, [],
      "an agent-origin abandonment is not a machine failure");
    assert.deepEqual(agent.abandoned_rounds, [1, 2]);
  });

  it("derives a different transaction id when directive facts differ", () => {
    const target = directive("machine").target;
    const first = deriveTransactionId({
      kind: "rollback",
      branchId: "loop:digest:branch:root",
      roundId: "loop:digest:round:2",
      attempt: 1,
      recovery: {
        target,
        reason: "stall",
        abandonedRounds: [2],
        reportedSkippedFiles: ["src/b.ts"],
      },
    });
    const second = deriveTransactionId({
      kind: "rollback",
      branchId: "loop:digest:branch:root",
      roundId: "loop:digest:round:2",
      attempt: 1,
      recovery: {
        target,
        reason: "stall",
        abandonedRounds: [1, 2],
        reportedSkippedFiles: ["src/a.ts", "src/b.ts"],
      },
    });
    assert.notEqual(first, second);
  });
});

describe("v4.0.3 — Recovery Brief uses the real restore marker", () => {
  it("states NOT verified when the compile has no verified restore", () => {
    const loopId = "brief-marker";
    const directive = committedBacktrackRound(2, loopId, 1);
    const base = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 2,
      task: "redo",
    }), { results: [directive] });
    assert.match(base.prompt, /Recovery Brief/);
    assert.match(base.prompt, /restore NOT verified/);

    const verified = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 2,
      task: "redo",
      restore_verified: true,
    }), { results: [directive] });
    assert.match(verified.prompt, /machine-verified by LoopForge/);
    assert.doesNotMatch(verified.prompt, /restore NOT verified/);
  });
});

describe("v4.0.3 — entrypoint trust window", () => {
  it("seeds the round-1 baseline before the first prompt", async () => {
    resetPolicy();
    installTestCommandProvider();
    const store = new MemoryLoopStore();
    const mgr = new SessionManager(store);
    const started = await mgr.create({ task: "Trust", loopId: "trust-round1" });
    assert.notEqual(
      mgr.get(started.sessionId)?.entrypointTrust,
      undefined,
      "round 1 carries a trusted baseline",
    );
    mgr.close();
  });

  it("does not re-seed a missing baseline on resume and warns instead", async () => {
    resetPolicy();
    installTestCommandProvider();
    const store = new MemoryLoopStore();
    const mgr = new SessionManager(store);
    const started = await mgr.create({
      task: "Trust resume",
      loopId: "trust-resume",
    });
    const doc = store.readSession("trust-resume")!;
    const lineage = doc.entry.loop_lineage as Record<string, unknown>;
    store.writeSession("trust-resume", {
      ...doc,
      entry: {
        ...doc.entry,
        loop_lineage: {
          ...lineage,
          // Simulate a restart that lost the held prompt AND the baseline.
          round_snapshot: null,
          entrypoint_trust: null,
        },
      },
    });
    mgr.close();

    const restarted = new SessionManager(store);
    const resumed = await restarted.resume("trust-resume");
    assert.ok(resumed?.prompt);
    assert.ok(resumed!.warnings?.some((warning) =>
      warning.startsWith("entrypoint_trust_missing")));
    assert.equal(
      restarted.getByLoopId("trust-resume")?.entrypointTrust,
      undefined,
      "the workspace is never re-captured as a trusted baseline",
    );
    restarted.close();
  });
});

describe("v4.0.3 — a restore is not progress", () => {
  it("does not create a file delta or a head move", () => {
    const loopId = "restore-progress";
    const git = (phase: "before" | "after", head: string) => ({
      schemaVersion: 2,
      providerId: "git",
      kind: "git",
      phase,
      startedAt: 0,
      finishedAt: 0,
      status: "observed",
      files: [],
      data: {
        dirty: [],
        fingerprints: { "src/a.ts": "m:same" },
        head,
        coverage: "tracked_and_non_ignored_untracked",
      },
    });
    const before = [git("before", "aaa")];
    const after = [git("after", "aaa")];
    const entry = committedFeedbackRound(1, {
      loopId,
      beforeEvidence: before,
      roundEvidence: after,
      restore: {
        directiveTransactionId: `loop:${loopId}:branch:root`,
        redoRound: 1,
        verifiedAt: 1,
      },
      evidencePosture: fixtureEvidencePosture(1, {
        workspace: { status: "observed", changedPathCount: 0 },
      }),
    });
    const views = derivationRounds([entry]);
    assert.equal(
      deriveRoundProgress(views[0]!.observationDelta).state,
      "unchanged",
      "a restore with an identical boundary adds no motion",
    );
    // The same committed observation collection through the delta helper.
    assert.deepEqual(
      deriveRoundObservationDelta(before as never, after as never)[0]!.changedFiles,
      [],
    );
    const metrics = derivePolicyMetrics(loopId, [entry]);
    assert.equal(metrics.filesChangedRounds, 0);
    assert.equal(metrics.headMoveRounds, 0);
  });
});

describe("v4.0.3 — machine-clean restore points", () => {
  it("never treats an evidence-incomplete round as clean", () => {
    const loopId = "clean";
    const incomplete = committedFeedbackRound(1, {
      loopId,
      verificationFlags: [],
    });
    const complete = committedFeedbackRound(2, {
      loopId,
      verificationFlags: [],
      roundEvidence: [{
        schemaVersion: 1,
        providerId: "probe",
        kind: "custom",
        phase: "after",
        startedAt: 0,
        finishedAt: 0,
        status: "observed",
        files: [],
        data: {},
      }],
    });
    assert.equal(
      findSafeRestorePoint(2, [incomplete], 1),
      null,
      "no after evidence is not a machine-clean restore point",
    );
    const found = findSafeRestorePoint(3, [incomplete, complete], 2);
    assert.equal(found?.round, 2);
  });
});
