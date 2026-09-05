/** v2.12: Lightweight round-sequence integrity — sequence stamps on round
 *  documents, write-time continuity, load-time gap detection, and
 *  severity-classified StorageCorruptionError.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkRoundSequence,
  FileLoopStore,
  StorageCorruptionError,
} from "../loop-store.js";
import type { VaultEntry } from "../loop-store.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "loopforge-seq-"));
}

function roundsDir(store: FileLoopStore, loopId: string): string {
  const hash = createHash("sha256").update(loopId).digest("hex");
  return join(store.root, "loops", hash, "rounds");
}

function entry(
  loopId: string,
  round: number,
  taskType: "loop_lineage" | "feedback",
): VaultEntry {
  const suffix = taskType === "feedback" ? ":feedback" : "";
  return {
    id: `loop:${loopId}:r${round}${suffix}`,
    task_id: `loop:${loopId}:r${round}${suffix}`,
    task_type: taskType,
    loop_id: loopId,
    timestamp: new Date().toISOString(),
    loop_lineage: { round },
  };
}

/** Write an unstamped round document directly (legacy simulation). */
function writeLegacyRound(store: FileLoopStore, loopId: string, round: number): void {
  const dir = roundsDir(store, loopId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${round}.json`),
    JSON.stringify({
      schemaVersion: 1,
      loopId,
      round,
      updatedAt: new Date().toISOString(),
      events: [],
    }),
    "utf8",
  );
}

/** Write a stamped round document directly (tamper simulation). */
function writeStampedRound(
  store: FileLoopStore,
  loopId: string,
  round: number,
  sequence: number,
): void {
  const dir = roundsDir(store, loopId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${round}.json`),
    JSON.stringify({
      schemaVersion: 1,
      loopId,
      round,
      sequence,
      updatedAt: new Date().toISOString(),
      events: [],
    }),
    "utf8",
  );
}

describe("loop-store sequence integrity", () => {
  it("stamps sequence on every round write and validates contiguity", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      for (const round of [1, 2, 3]) {
        store.appendEntry(entry("loop-a", round, "feedback"));
      }
      const doc = store.readRound("loop-a", 2);
      assert.equal(doc?.sequence, 2);
      assert.deepEqual(checkRoundSequence(store, "loop-a"), { complete: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws recoverable sequence_gap when a predecessor round is missing", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      store.appendEntry(entry("loop-a", 1, "feedback"));
      assert.throws(
        () => store.appendEntry(entry("loop-a", 3, "feedback")),
        (error: unknown) => {
          assert.ok(error instanceof StorageCorruptionError);
          assert.equal(error.kind, "sequence_gap");
          assert.equal(error.recoverable, true);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a deleted round file as recoverable gap at load time", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      for (const round of [1, 2, 3]) {
        store.appendEntry(entry("loop-a", round, "feedback"));
      }
      rmSync(join(roundsDir(store, "loop-a"), "2.json"));
      assert.throws(
        () => checkRoundSequence(store, "loop-a"),
        (error: unknown) => {
          assert.ok(error instanceof StorageCorruptionError);
          assert.equal(error.kind, "sequence_gap");
          assert.equal(error.recoverable, true);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws corrupted sequence_invalid for a round document without a stamp", () => {
    // v3.7: the legacy no-stamp exemption was removed — every round must be
    // stamped with sequence === round.
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      writeLegacyRound(store, "legacy-loop", 1);
      assert.throws(
        () => checkRoundSequence(store, "legacy-loop"),
        (error: unknown) => {
          assert.ok(error instanceof StorageCorruptionError);
          assert.equal(error.kind, "sequence_invalid");
          assert.equal(error.recoverable, false);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws corrupted sequence_invalid when stamping stops mid-loop", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      writeStampedRound(store, "loop-a", 1, 1);
      writeLegacyRound(store, "loop-a", 2); // stamped earlier, unstamped later
      assert.throws(
        () => checkRoundSequence(store, "loop-a"),
        (error: unknown) => {
          assert.ok(error instanceof StorageCorruptionError);
          assert.equal(error.kind, "sequence_invalid");
          assert.equal(error.recoverable, false);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unstamped legacy prefix before a stamped round", () => {
    // v3.7: the monotonic upgrade path was removed — an unstamped prefix is
    // corrupted, not upgradeable.
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      writeLegacyRound(store, "loop-a", 1);
      writeLegacyRound(store, "loop-a", 2);
      store.appendEntry(entry("loop-a", 3, "feedback")); // stamps round 3
      assert.throws(
        () => checkRoundSequence(store, "loop-a"),
        (error: unknown) => {
          assert.ok(error instanceof StorageCorruptionError);
          assert.equal(error.kind, "sequence_invalid");
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws corrupted sequence_invalid when a document stamp disagrees with its filename", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      writeStampedRound(store, "loop-a", 3, 5);
      assert.throws(
        () => store.readRound("loop-a", 3),
        (error: unknown) => {
          assert.ok(error instanceof StorageCorruptionError);
          assert.equal(error.kind, "sequence_invalid");
          assert.equal(error.recoverable, false);
          return true;
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("propagates the second failure when atomicWrite retries a broken target", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      // Make the target round document a directory: the tmp write succeeds,
      // but rename onto a directory fails twice (writeOnce + one retry).
      const rounds = roundsDir(store, "loop-a");
      mkdirSync(rounds, { recursive: true });
      mkdirSync(join(rounds, "1.json"));
      assert.throws(() => store.appendEntry(entry("loop-a", 1, "feedback")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a prefix gap as recoverable for every loop shape", () => {
    // v3.7: the import carve-out was removed with the migration API — a
    // loop starting at round 3 (missing rounds 1-2) is a recoverable gap
    // whether or not a runtime session document exists.
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      const loopId = "prefix-gap";
      // Rounds 3..5 stamped — rounds 1-2 are missing
      store.appendEntry(entry(loopId, 3, "loop_lineage"));
      store.appendEntry(entry(loopId, 4, "loop_lineage"));
      store.appendEntry(entry(loopId, 5, "loop_lineage"));
      assert.throws(
        () => checkRoundSequence(store, loopId),
        (error: unknown) =>
          error instanceof StorageCorruptionError &&
          error.kind === "sequence_gap" &&
          error.message.includes("at 1"),
      );

      // Same verdict for a loop with a session document.
      store.writeSession(loopId, {
        schemaVersion: 1,
        loopId,
        updatedAt: new Date().toISOString(),
        entry: {
          task_id: `loop:${loopId}:session`,
          task_type: "session_state",
          loop_id: loopId,
          loop_lineage: { status: "running", current_round: 6 },
        },
      });
      assert.throws(
        () => checkRoundSequence(store, loopId),
        (error: unknown) =>
          error instanceof StorageCorruptionError &&
          error.kind === "sequence_gap" &&
          error.message.includes("at 1"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
