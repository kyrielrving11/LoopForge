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
import { FileLoopStore } from "../loop-store.js";
import { prepareRoundTransaction } from "../round-transaction.js";
import type { PromptArtifact } from "../protocol.js";
import type { VaultEntry } from "../backends/interface.js";

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
});
