import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EvidenceCollector,
  diffSnapshotCollections,
  diffSnapshots,
} from "../evidence-provider.js";
import type { ProviderSnapshot } from "../evidence-provider.js";

function gitSnapshot(
  files: string[],
  fingerprints: Record<string, string>,
): ProviderSnapshot {
  return {
    provider: "git",
    timestamp: Date.now(),
    files,
    data: { tracked: files, staged: [], untracked: [], fingerprints },
  };
}

describe("EvidenceProvider round diffs", () => {
  it("detects a pre-existing dirty file modified again", () => {
    const before = [gitSnapshot(["src/dirty.ts"], { "src/dirty.ts": "v1" })];
    const after = [gitSnapshot(["src/dirty.ts"], { "src/dirty.ts": "v2" })];

    assert.deepEqual(diffSnapshots(before, after), ["src/dirty.ts"]);
    assert.deepEqual(
      diffSnapshotCollections(before, after)[0]?.files,
      ["src/dirty.ts"],
    );
  });

  it("detects a dirty file restored to its baseline", () => {
    const before = [gitSnapshot(["src/restored.ts"], { "src/restored.ts": "v1" })];
    const after = [gitSnapshot([], {})];
    assert.deepEqual(diffSnapshots(before, after), ["src/restored.ts"]);
  });

  it("honours an empty evidence provider policy", () => {
    assert.deepEqual(EvidenceCollector.fromProviderNames([]).collect(), []);
  });
});
