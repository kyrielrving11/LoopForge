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
import type { PromptArtifact } from "../protocol.js";
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
        schemaVersion: 1,
        roundId: `loop:${loopId}:round:1`,
        attempt: 1,
        level: "l2",
        levelReasons: ["first_round"],
        renderedPrompt: "prompt",
        promptHash: "prompt-hash",
        stateHash: "state-hash",
        basePromptVersion: "2.0.0",
        includedSections: ["objective"],
        budgetChars: 100,
        charCount: 6,
        budgetExceeded: false,
        generatedAt: Date.now(),
      };
      const snapshot = {
        ...prepareRoundTransaction(loopId, 1, [], artifact),
        phase: "committed" as const,
      };
      store.appendEntry(entry(
        loopId,
        `loop:${loopId}:session`,
        "session_state",
        { status: "running" },
      ));
      store.appendEntry(entry(
        loopId,
        `loop:${loopId}:r1`,
        "loop_lineage",
        { round: 1, task: "work" },
      ));
      store.appendEntry({
        ...entry(
          loopId,
          `loop:${loopId}:r1:feedback`,
          "loop_feedback",
          { round: 1, round_transaction: { snapshot } },
        ),
        success: true,
      });

      assert.equal(store.readSession(loopId)?.entry.task_type, "session_state");
      const round = store.readRound(loopId, 1);
      assert.equal(round?.lineage?.task_id, `loop:${loopId}:r1`);
      assert.equal(round?.feedback?.success, true);
      assert.equal(round?.transaction?.phase, "committed");
      assert.equal(round?.promptArtifact?.renderedPrompt, "prompt");
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
        store.appendEntry(entry(
          loopId,
          `loop:${loopId}:r1`,
          "loop_lineage",
          { round: 1 },
        ));
      }
      assert.deepEqual(store.listLoopIds(), ["alpha", "alpha-long"]);
      assert.equal(store.listEntries("alpha").length, 1);
      assert.equal(readdirSync(join(root, "loops")).length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports a legacy vault once without deleting the source", () => {
    const root = temporaryDirectory();
    try {
      const legacy = join(root, "legacy.json");
      const storeRoot = join(root, "new-store");
      const legacyEntry = entry(
        "migrated",
        "loop:migrated:r1",
        "loop_lineage",
        { round: 1 },
      );
      writeFileSync(legacy, JSON.stringify({ entries: [legacyEntry] }), "utf8");
      const store = new FileLoopStore(storeRoot);

      assert.deepEqual(store.migrateLegacyVault(legacy), {
        source: legacy,
        imported: 1,
        skipped: 0,
        alreadyMigrated: false,
      });
      assert.equal(store.listEntries("migrated").length, 1);
      assert.equal(JSON.parse(readFileSync(legacy, "utf8")).entries.length, 1);
      assert.equal(store.migrateLegacyVault(legacy).alreadyMigrated, true);
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
      store.appendEntry(entry(loopId, `loop:${loopId}:r1`, "loop_lineage", { round: 1 }));
      const roundPath = allFiles(dir).find((p) => p.endsWith("1.json"));
      assert.ok(roundPath, "rounds/1.json should exist");
      writeFileSync(roundPath, "{ corrupted json", "utf8");

      // A later write for the same round must refuse — not overwrite the
      // corrupted document with a fresh empty one (the pre-v2.14 behavior).
      assert.throws(
        () => store.appendEntry(entry(loopId, `loop:${loopId}:r1`, "loop_lineage", { round: 1 })),
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
});
