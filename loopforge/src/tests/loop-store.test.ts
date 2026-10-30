import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileLoopStore, StorageCorruptionError } from "../loop-store.js";
import { prepareRoundTransaction } from "../round-transaction.js";
import { committedFeedbackRound } from "./_helpers.js";
import type { PromptArtifact } from "../protocol.js";
import { PROMPT_ARTIFACT_SCHEMA_VERSION } from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "loopforge-store-"));
}

function entry(
  loopId: string,
  taskId: string,
  taskType: string,
  lineage: Record<string, unknown> = {},
): VaultEntry {
  return {
    id: taskId,
    task_id: taskId,
    task_type: taskType,
    loop_id: loopId,
    timestamp: new Date().toISOString(),
    loop_lineage: lineage,
  };
}

function allFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const name of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) result.push(...allFiles(path));
    else result.push(path);
  }
  return result;
}

describe("FileLoopStore", () => {
  it("persists one typed session and round document without Markdown", () => {
    const root = temporaryDirectory();
    try {
      const store = new FileLoopStore(root);
      const loopId = "typed-store";
      const artifact: PromptArtifact = {
        schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
        roundId: `loop:${loopId}:round:1`,
        round: 1,
        attempt: 1,
        level: "l2",
        contextMode: "fresh_invocation",
        contextReason: "first_round",
        renderedPrompt: "prompt",
        promptHash: "prompt-hash",
        stateHash: "state-hash",
        sections: ["objective"],
        droppedSections: [],
        protectedOverflow: false,
        budget: 18000,
        renderedChars: 6,
        coverage: { active: [], rendered: [], omitted: [], complete: true },
      };
      const snapshot = {
        ...prepareRoundTransaction(loopId, 1, [], artifact, {
          operatorAcceptance: {
            task: "Typed store",
            success_criteria: ["Task goal achieved with verifiable evidence"],
            hard_constraints: [],
          },
          compiled: {
            task: "Typed store",
            goalId: `${loopId}:test`,
            constraintsActive: [],
            constraintsRetired: [],
          },
        }),
        phase: "committed" as const,
        submittedFields: [
          "success", "output_summary", "constraint_violations", "should_continue",
        ],
      };
      store.appendEntry(entry(
        loopId,
        `loop:${loopId}:session`,
        "session_state",
        { status: "running" },
      ));
      store.appendEntry({
        ...entry(
          loopId,
          `loop:${loopId}:r1:feedback`,
          "feedback",
          {
            round: 1,
            round_id: snapshot.roundId,
            round_transaction: {
              schema_version: snapshot.schemaVersion,
              round_id: snapshot.roundId,
              snapshot,
              result: {
                action: "continue",
                verificationFlags: [],
                agentSuccessClaim: true,
              },
            },
          },
        ),
        success: true,
      });

      assert.equal(store.readSession(loopId)?.entry.task_type, "session_state");
      const round = store.readRound(loopId, 1);
      assert.equal(round?.feedback?.success, true);
      assert.equal(round?.transaction?.phase, "committed");
      assert.equal(round?.promptArtifact?.renderedPrompt, "prompt");
      // v3.9.1: the transaction lives ONCE, in the feedback entry. The round
      // document no longer persists a second copy (or a third prompt copy).
      const roundPath = allFiles(root).find(
        (path) => /[\\/]rounds[\\/]1\.json$/.test(path),
      );
      assert.ok(roundPath, "round document exists");
      const raw = JSON.parse(readFileSync(roundPath!, "utf8")) as Record<string, unknown>;
      assert.ok(!("transaction" in raw), "no duplicate transaction copy");
      assert.ok(!("promptArtifact" in raw), "no duplicate prompt artifact copy");
      assert.equal(allFiles(root).some((path) => path.endsWith(".md")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("isolates loop IDs by full hash rather than task-id prefix", () => {
    const root = temporaryDirectory();
    try {
      const store = new FileLoopStore(root);
      for (const loopId of ["alpha", "alpha-long"]) {
        store.appendEntry(committedFeedbackRound(1, { loopId }));
      }
      assert.deepEqual(store.listLoopIds(), ["alpha", "alpha-long"]);
      assert.equal(store.listEntries("alpha").length, 1);
      assert.equal(readdirSync(join(root, "loops")).length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces corrupt JSON as StorageCorruptionError instead of silently repairing", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      const loopId = "corrupt-loop";
      store.writeSession(loopId, {
        schemaVersion: 1,
        loopId,
        updatedAt: new Date().toISOString(),
        entry: entry(loopId, `loop:${loopId}:session`, "session_state"),
      });
      const sessionPath = allFiles(dir).find((p) => p.endsWith("session.json"));
      assert.ok(sessionPath, "session.json should exist");
      writeFileSync(sessionPath, "{ corrupted json", "utf8");

      // v2.14: corrupt JSON surfaces — it is never treated as "missing"
      assert.throws(
        () => store.readSession(loopId),
        (error: unknown) =>
          error instanceof StorageCorruptionError && error.kind === "invalid_json",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to silently overwrite a corrupted round document", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      const loopId = "corrupt-round";
      // Commit a round so rounds/1.json exists
      store.appendEntry(committedFeedbackRound(1, { loopId }));
      const roundPath = allFiles(dir).find((p) => p.endsWith("1.json"));
      assert.ok(roundPath, "rounds/1.json should exist");
      writeFileSync(roundPath, "{ corrupted json", "utf8");

      // A later write for the same round must refuse — not overwrite the
      // corrupted document with a fresh empty one (the pre-v2.14 behavior).
      assert.throws(
        () => store.appendEntry(committedFeedbackRound(1, { loopId })),
        (error: unknown) =>
          error instanceof StorageCorruptionError && error.kind === "invalid_json",
      );
      assert.equal(
        readFileSync(roundPath, "utf8"),
        "{ corrupted json",
        "corrupted document must remain untouched",
      );

      // A valid-JSON document with the wrong shape is invalid_format, not "missing"
      writeFileSync(roundPath, JSON.stringify({ schemaVersion: 1, loopId: "other", round: 99 }), "utf8");
      assert.throws(
        () => store.readRound(loopId, 1),
        (error: unknown) =>
          error instanceof StorageCorruptionError && error.kind === "invalid_format",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers a session-only loop (no committed rounds) and orphaned dirs", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      const loopId = "session-only";
      store.writeSession(loopId, {
        schemaVersion: 1,
        loopId,
        updatedAt: new Date().toISOString(),
        entry: entry(loopId, `loop:${loopId}:session`, "session_state"),
      });
      // No rounds committed yet — the session alone must make the loop
      // visible (previously listLoopIds required metadata.json, which was
      // only written by the round path, orphaning created-but-uncommitted
      // loops from list / auto-resume).
      assert.deepEqual(store.listLoopIds(), [loopId]);

      // Pre-v2.14 orphan: metadata.json missing (crash between writes) —
      // listLoopIds recovers the loopId from the session document itself.
      const metadataPath = allFiles(dir).find((p) => p.endsWith("metadata.json"));
      assert.ok(metadataPath, "writeSession must stamp metadata.json");
      rmSync(metadataPath);
      assert.deepEqual(store.listLoopIds(), [loopId]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat malformed metadata as a missing loop directory", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      const loopId = "malformed-metadata";
      store.writeSession(loopId, {
        schemaVersion: 1,
        loopId,
        updatedAt: new Date().toISOString(),
        entry: entry(loopId, `loop:${loopId}:session`, "session_state"),
      });
      const metadataPath = allFiles(dir).find((p) => p.endsWith("metadata.json"));
      assert.ok(metadataPath, "metadata.json should exist");
      writeFileSync(metadataPath, "null", "utf8");

      assert.throws(
        () => store.listLoopIds(),
        (error: unknown) =>
          error instanceof StorageCorruptionError && error.kind === "invalid_format",
      );
      assert.throws(
        () => store.writeSession(loopId, {
          schemaVersion: 1,
          loopId,
          updatedAt: new Date().toISOString(),
          entry: entry(loopId, `loop:${loopId}:session`, "session_state"),
        }),
        (error: unknown) =>
          error instanceof StorageCorruptionError && error.kind === "invalid_format",
      );
      assert.equal(readFileSync(metadataPath, "utf8"), "null",
        "a direct write must not replace corrupt metadata");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unreadable transaction envelope instead of persisting it", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      const loopId = "unreadable-commit";
      const feedback = committedFeedbackRound(1, { loopId });
      const transaction = (feedback.loop_lineage as Record<string, unknown>)
        .round_transaction as Record<string, unknown>;
      (transaction.snapshot as Record<string, unknown>).schemaVersion = 1;
      assert.throws(
        () => store.appendEntry(feedback),
        /unreadable round transaction/,
      );
      assert.equal(store.readRound(loopId, 1), null,
        "the rejected write leaves no round document");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a committed transaction whose snapshot belongs to another loop", () => {
    const dir = temporaryDirectory();
    try {
      const store = new FileLoopStore(dir);
      const feedback = committedFeedbackRound(1, { loopId: "identity-target" });
      const transaction = feedback.loop_lineage!.round_transaction as Record<string, unknown>;
      const snapshot = transaction.snapshot as Record<string, unknown>;
      snapshot.loopId = "identity-source";
      snapshot.roundId = "loop:identity-source:round:1";
      transaction.round_id = snapshot.roundId;

      assert.throws(
        () => store.appendEntry(feedback),
        (error: unknown) =>
          error instanceof StorageCorruptionError && error.kind === "invalid_format",
      );
      assert.equal(store.readRound("identity-target", 1), null,
        "an invalid transaction must not create a round document");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
