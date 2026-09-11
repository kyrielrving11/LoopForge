/** v2.12: Backtrack git HEAD — restore point capture, verification check,
 *  and enforcement rule R9.
 */

import { describe, it } from "node:test";
import { criterionClaims } from "./_helpers.js";
import assert from "node:assert/strict";
import { makeExecutionReport, makeSelfEvaluation } from "../protocol.js";
import type { SelfEvaluation, VerificationFlag } from "../protocol.js";
import type { GitObservation, MachineObservation } from "../protocol.js";
import type { VaultEntry } from "../loop-store.js";
import {
  findBacktrackTargetGitHead,
  buildBacktrackPrompt,
  enforceRound,
} from "../enforcement-gate.js";
import { verifySelfEvaluation } from "../verification-gate.js";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const OTHER_HEAD = "123456abcdef7890abcdef1234567890abcdef12";

function gitSnapshot(head: string | undefined): GitObservation {
  return {
    schemaVersion: 1,
    providerId: "git",
    kind: "git",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files: ["src/a.ts"],
    data: { tracked: [], staged: [], untracked: [], fingerprints: {}, head },
  };
}

function committedFeedback(
  round: number,
  snapshots: MachineObservation[],
  preferAfter = true,
): VaultEntry {
  const snapshot = {
    schemaVersion: 2,
    roundId: `loop:git-loop:round:${round}`,
    loopId: "git-loop",
    round,
    attempt: 1,
    phase: "committed" as const,
    beforeEvidence: preferAfter ? [] : snapshots,
    afterEvidence: preferAfter ? snapshots : [],
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
        schema_version: 2,
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
      progress_estimate: 0.3,
    }),
    ...overrides,
  });
}

describe("findBacktrackTargetGitHead", () => {
  it("reads the git head from the restore round's after evidence", () => {
    const entries = [committedFeedback(3, [gitSnapshot(HEAD)])];
    assert.equal(findBacktrackTargetGitHead(3, entries), HEAD);
  });

  it("falls back to before evidence when after evidence lacks git", () => {
    const entries = [committedFeedback(3, [gitSnapshot(HEAD)], false)];
    assert.equal(findBacktrackTargetGitHead(3, entries), HEAD);
  });

  it("returns null when the restore round has no committed feedback", () => {
    assert.equal(findBacktrackTargetGitHead(3, []), null);
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
    assert.equal(findBacktrackTargetGitHead(3, entries), null);
  });

  it("returns null when git head is empty", () => {
    const entries = [committedFeedback(3, [gitSnapshot("")])];
    assert.equal(findBacktrackTargetGitHead(3, entries), null);
  });
});

describe("verification gate — backtrack git head restore", () => {
  it("no flag when the workspace head matches the restore commit", () => {
    const result = verifySelfEvaluation(
      se(), 4, [], null, [gitSnapshot(HEAD)], [], {}, HEAD,
    );
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });

  it("error flag when the workspace head differs from the restore commit", () => {
    const result = verifySelfEvaluation(
      se(), 4, [], null, [gitSnapshot(OTHER_HEAD)], [], {}, HEAD,
    );
    assert.equal(result.verdict, "contradicted");
    const flag = result.flags.find(
      (f) => f.check === "backtrack_workspace_not_restored" && f.severity === "error");
    assert.ok(flag);
    assert.ok(flag.detail.includes("abcdef12"));
  });

  it("no flag when no target was set (normal rounds unaffected)", () => {
    const result = verifySelfEvaluation(se(), 4, [], null, [gitSnapshot(OTHER_HEAD)]);
    assert.equal(result.verdict, "trusted");
  });

  it("no flag when git is unavailable (fail-open)", () => {
    const result = verifySelfEvaluation(se(), 4, [], null, [], [], {}, HEAD);
    assert.equal(result.verdict, "trusted");
  });

  it("compares only the first 12 characters (short hash)", () => {
    const sameShort = HEAD.slice(0, 12) + "ffffffffffffffffffffffffffffffff";
    const result = verifySelfEvaluation(
      se(), 4, [], null, [gitSnapshot(sameShort)], [], {}, HEAD,
    );
    assert.equal(result.verdict, "trusted");
  });
});

describe("buildBacktrackPrompt — git head", () => {
  it("states the required HEAD as a restore fact when gitHead is provided", () => {
    const prompt = buildBacktrackPrompt(4, 3, "progress_stall", [], [], HEAD);
    assert.ok(prompt.includes(`HEAD must be at \`${HEAD.slice(0, 12)}\``));
    // v3.8: a FACT, never a command — the restore is the agent's action.
    for (const command of ["git stash", "git reset", "git checkout", "git clean"]) {
      assert.ok(!prompt.includes(command), `must not prescribe "${command}"`);
    }
  });

  it("omits the HEAD fact when gitHead is absent", () => {
    const prompt = buildBacktrackPrompt(4, 3, "progress_stall", [], []);
    assert.ok(!prompt.includes("HEAD must be at"));
    assert.ok(prompt.includes("Restoring the workspace is **your** responsibility"));
  });
});

describe("enforcement R9 — backtrack workspace not restored", () => {
  function verifyResult(flags: VerificationFlag[]) {
    return { verdict: "contradicted" as const, flags };
  }

  it("returns backtrack when the flag is error-level and backtrack is enabled", () => {
    const flags: VerificationFlag[] = [{
      severity: "error",
      field: "workspace",
      check: "backtrack_workspace_not_restored",
      detail: "HEAD mismatch",
    }];
    const result = enforceRound(se(), verifyResult(flags), 4, [], 0);
    assert.equal(result.action, "backtrack");
    assert.equal(result.check, "backtrack_workspace_not_restored");
  });

  it("ignores warn-level restore flags (accepts the round)", () => {
    const flags: VerificationFlag[] = [{
      severity: "warn",
      field: "files_changed",
      check: "backtrack_workspace_not_restored",
      detail: "minor overlap",
    }];
    const result = enforceRound(se(), verifyResult(flags), 4, [], 0);
    assert.equal(result.action, "accept");
  });
});
