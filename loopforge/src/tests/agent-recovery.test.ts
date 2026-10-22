/** v3.9.6 — Agent-initiated recovery: target validation, directive commit,
 *  branch fencing and the restore checkpoint. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopForgeEngine } from "../engine.js";
import { MemoryLoopStore, committedFeedbackRound, deltaAfter } from "./_helpers.js";
import type { GitObservation } from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";
import {
  RoundTransactionCoordinator,
  deriveTransactionId,
  prepareRoundTransaction,
  rootBranchId,
} from "../round-transaction.js";
import {
  pendingRollbackDirective,
  readOnlyRollbacks,
  readOnlyRounds,
} from "../committed-round.js";
import {
  deriveRecoveryDirective,
  resolveRecoveryTarget,
  verifyRecoveryCheckpoint,
} from "../recovery.js";

const LOOP = "recovery-test";

function git(
  phase: "before" | "after",
  head: string,
  files: string[] = [],
): GitObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase,
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files,
    data: {
      dirty: files,
      fingerprints: Object.fromEntries(files.map((file) => [file, "m:1"])),
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

function targetRound(): VaultEntry {
  return committedFeedbackRound(1, {
    loopId: LOOP,
    success: true,
    roundEvidence: [git("after", "target-head", [])],
  });
}

function abandonedRound(): VaultEntry {
  return committedFeedbackRound(2, {
    loopId: LOOP,
    success: false,
    files: ["src/abandoned.ts"],
    roundEvidence: [git("after", "abandoned-head", ["src/abandoned.ts"])],
  });
}

describe("v3.9.6 — agent recovery", () => {
  it("resolves a committed target with an observed restore point", () => {
    const entries = [targetRound(), abandonedRound()];
    const resolved = resolveRecoveryTarget(entries, 3, 1);
    assert.ok(resolved.ok);
    assert.equal(resolved.target.head, "target-head");
    assert.deepEqual(resolved.target.dirty, []);
    assert.equal(resolved.target.view.transactionId, `tx-${LOOP}-1-1`);
  });

  it("rejects a future, rollback, or unobserved target without side effects", () => {
    const entries = [targetRound(), abandonedRound()];
    const future = resolveRecoveryTarget(entries, 3, 3);
    assert.equal(future.ok, false);
    if (!future.ok) assert.equal(future.reason, "target_out_of_range");

    const unobserved = committedFeedbackRound(2, {
      loopId: LOOP,
      success: true,
      roundEvidence: [],
    });
    const missing = resolveRecoveryTarget([targetRound(), unobserved], 3, 2);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "restore_point_unobserved");
  });

  it("commits a rollback event, fences the branch and stays idempotent", () => {
    const store = new MemoryLoopStore();
    const engine = new LoopForgeEngine(store);
    const entries = [targetRound(), abandonedRound()];
    for (const entry of entries) store.appendEntry(entry);

    const held = prepareRoundTransaction(
      LOOP,
      3,
      [],
      undefined,
      { branchId: rootBranchId(LOOP) },
    );
    const resolved = resolveRecoveryTarget(entries, 3, 1);
    assert.ok(resolved.ok);
    const transactionId = deriveTransactionId({
      kind: "rollback",
      branchId: rootBranchId(LOOP),
      roundId: held.roundId,
      attempt: 1,
      recovery: {
        target: 1,
        reason: "Try the other approach",
        target_transaction_id: resolved.target.view.transactionId ?? "",
      },
    });
    const after = [git("after", "abandoned-head", ["src/abandoned.ts"])];
    const recovery = deriveRecoveryDirective({
      origin: "agent",
      reason: "Try the other approach",
      transactionId,
      target: resolved.target,
      abandonedRounds: readOnlyRounds(entries).filter((view) =>
        view.round > resolved.target.view.round && view.round < 3),
      currentRound: 3,
      beforeEvidence: [],
      afterEvidence: after,
    });
    const coordinator = new RoundTransactionCoordinator(engine, store);
    const first = coordinator.commitRecovery({
      snapshot: held,
      loopId: LOOP,
      recovery,
      actualEvidence: after,
    });
    assert.equal(first.result.action, "recovery");
    assert.equal(first.result.origin, "agent");
    assert.equal(first.result.recovery?.target, 1);

    const committed = store.listEntries(LOOP);
    const events = readOnlyRollbacks(committed);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.origin, "agent");
    assert.equal(events[0]!.recovery?.reason, "Try the other approach");
    assert.deepEqual(readOnlyRounds(committed).map((view) => view.round), [1]);
    assert.equal(pendingRollbackDirective(committed, 2)?.round, 3);

    const second = coordinator.commitRecovery({
      snapshot: held,
      loopId: LOOP,
      recovery,
      actualEvidence: after,
    });
    assert.equal(second.replayed, true, "the same transactionId is idempotent");
  });

  it("fails the restore checkpoint closed on an unknown or unrestored boundary", () => {
    const directive = {
      origin: "agent" as const,
      reason: "abandon",
      target: 1,
      target_round_id: "loop:recovery-test:round:1",
      target_transaction_id: "tx-recovery-test-1-1",
      target_head: "target-head",
      target_dirty: [],
      skipped_files: ["src/abandoned.ts"],
      skipped_fingerprints: { "src/abandoned.ts": "m:1" },
      skipped_discoveries: [],
      failed_rounds: [2],
      approaches: [],
      wrong_assumptions: [],
      transaction_id: "tx-rollback",
    };
    assert.deepEqual(
      verifyRecoveryCheckpoint({
        directive,
        beforeEvidence: [],
        evidenceDeltas: [],
      }).ok,
      false,
      "unknown Git is not a pass",
    );

    const wrongHead = deltaAfter(git("after", "wrong-head", []), []);
    assert.equal(
      verifyRecoveryCheckpoint({
        directive,
        beforeEvidence: [],
        evidenceDeltas: [wrongHead],
      }).ok,
      false,
    );

    const restored = deltaAfter(git("after", "target-head", []), []);
    assert.deepEqual(
      verifyRecoveryCheckpoint({
        directive,
        beforeEvidence: [],
        evidenceDeltas: [restored],
      }),
      { ok: true },
    );
  });
});
