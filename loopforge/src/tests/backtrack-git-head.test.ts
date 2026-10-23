/** v2.12: Backtrack git HEAD — restore point capture, verification check,
 *  and enforcement rule R9.
 */

import { describe, it } from "node:test";
import { criterionClaims, deltasFrom } from "./_helpers.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  makeVerificationResult, makeExecutionReport, makeSelfEvaluation } from "../protocol.js";
import type { SelfEvaluation, VerificationFlag } from "../protocol.js";
import type { GitObservation, MachineObservation } from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";
import {
  findBacktrackTargetSnapshot,
  enforceRound,
} from "../enforcement-gate.js";
import { verifySelfEvaluation } from "../verification-gate.js";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const OTHER_HEAD = "123456abcdef7890abcdef1234567890abcdef12";

function gitSnapshot(head: string | undefined, dirtyFiles: string[] = []): GitObservation {
  return {
    schemaVersion: 2,
    providerId: "git",
    kind: "git",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files: ["src/a.ts"],
    data: {
      dirty: dirtyFiles,
      fingerprints: {},
      head,
      coverage: "tracked_and_non_ignored_untracked",
    },
  };
}

function committedFeedback(
  round: number,
  snapshots: MachineObservation[],
  preferAfter = true,
): VaultEntry {
  const snapshot = {
    schemaVersion: 5,
    kind: "evaluation" as const,
    branchId: "loop:git-loop:branch:root",
    transactionId: `tx-git-loop-${round}-1`,
    roundId: `loop:git-loop:round:${round}`,
    loopId: "git-loop",
    round,
    attempt: 1,
    phase: "committed" as const,
    beforeEvidence: preferAfter ? [] : snapshots,
    ...(preferAfter
      ? {}
      : {
          beforeCheckpointError: {
            code: "fixture_unavailable",
            detail: "test fixture",
            at: 0,
          },
        }),
    afterEvidence: preferAfter ? snapshots : [],
    submittedFields: [
      "success", "output_summary", "constraint_violations", "should_continue",
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return {
    id: `loop:git-loop:r${round}:feedback`,
    task_id: `loop:git-loop:r${round}:feedback`,
    task_type: "feedback",
    loop_id: "git-loop",
    timestamp: new Date().toISOString(),
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: 5,
        round_id: `loop:git-loop:round:${round}`,
        snapshot,
        result: { action: "continue", verificationFlags: [] },
      },
    },
  };
}

function se(overrides: Partial<SelfEvaluation> = {}): SelfEvaluation {
  return makeSelfEvaluation({
    success: false,
    output_summary: "working",
    constraint_violations: [],
    should_continue: true,
    execution_report: makeExecutionReport({
      files_changed: ["src/a.ts"],
      tests_reported: null,
      criterion_claims: criterionClaims([], []),
    }),
    ...overrides,
  });
}

describe("findBacktrackTargetSnapshot", () => {
  it("reads the git head and the restore point's own dirty files", () => {
    const entries = [committedFeedback(3, [gitSnapshot(HEAD, ["docs/notes.md"])])];
    assert.deepEqual(findBacktrackTargetSnapshot(3, entries), {
      head: HEAD,
      dirtyFiles: ["docs/notes.md"],
      fingerprints: {},
    });
  });

  it("falls back to before evidence when after evidence lacks git", () => {
    const entries = [committedFeedback(3, [gitSnapshot(HEAD)], false)];
    assert.equal(findBacktrackTargetSnapshot(3, entries)?.head, HEAD);
  });

  it("returns null when the restore round has no committed feedback", () => {
    assert.equal(findBacktrackTargetSnapshot(3, []), null);
  });

  it("returns null when the snapshot has no git provider", () => {
    const entries = [committedFeedback(3, [{
      schemaVersion: 1,
      providerId: "command:npm-test",
      kind: "command",
      phase: "after",
      startedAt: 0,
      finishedAt: 0,
      status: "passed",
      files: [],
      data: {
        commandId: "npm-test",
        argv: ["npm", "test"],
        cwd: ".",
        configHash: "0".repeat(64),
        required: false,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        stdoutSha256: "0".repeat(64),
        stderrSha256: "0".repeat(64),
        stdoutExcerpt: "",
        stderrExcerpt: "",
        truncated: false,
        entrypointFiles: [],
      },
    }])];
    assert.equal(findBacktrackTargetSnapshot(3, entries), null);
  });

  it("returns null when git head is empty", () => {
    const entries = [committedFeedback(3, [gitSnapshot("")])];
    assert.equal(findBacktrackTargetSnapshot(3, entries), null);
  });
});
