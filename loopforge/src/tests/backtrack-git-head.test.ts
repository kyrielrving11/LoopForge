/** v2.12: Backtrack git HEAD — restore point capture, verification check,
 *  and enforcement rule R9.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeExecutionEvidence, makeSelfEvaluation } from "../protocol.js";
import type { SelfEvaluation, VerificationFlag } from "../protocol.js";
import type { ProviderSnapshot } from "../evidence-provider.js";
import type { VaultEntry } from "../loop-store.js";
import {
  findBacktrackTargetGitHead,
  buildBacktrackPrompt,
  enforceRound,
} from "../enforcement-gate.js";
import { verifySelfEvaluation } from "../verification-gate.js";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const OTHER_HEAD = "123456abcdef7890abcdef1234567890abcdef12";

function gitSnapshot(head: string | undefined): ProviderSnapshot {
  return {
    provider: "git",
    timestamp: Date.now(),
    files: ["src/a.ts"],
    data: { tracked: [], staged: [], untracked: [], head },
  };
}

function committedFeedback(
  round: number,
  snapshots: ProviderSnapshot[],
  preferAfter = true,
): VaultEntry {
  const snapshot = {
    schemaVersion: 1,
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
        schema_version: 1,
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
    execution_evidence: makeExecutionEvidence({
      files_changed: ["src/a.ts"],
      test_results: null,
      success_criteria_met: [],
      success_criteria_remaining: [],
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
      provider: "command:npm-test",
      timestamp: Date.now(),
      files: [],
      data: { kind: "command", phase: "after", status: "passed" },
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
      se(), 4, [], null, [gitSnapshot(HEAD)], [], HEAD,
    );
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });

  it("error flag when the workspace head differs from the restore commit", () => {
    const result = verifySelfEvaluation(
      se(), 4, [], null, [gitSnapshot(OTHER_HEAD)], [], HEAD,
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
    const result = verifySelfEvaluation(se(), 4, [], null, [], [], HEAD);
    assert.equal(result.verdict, "trusted");
  });

  it("compares only the first 12 characters (short hash)", () => {
    const sameShort = HEAD.slice(0, 12) + "ffffffffffffffffffffffffffffffff";
    const result = verifySelfEvaluation(
      se(), 4, [], null, [gitSnapshot(sameShort)], [], HEAD,
    );
    assert.equal(result.verdict, "trusted");
  });
});

describe("buildBacktrackPrompt — git head", () => {
  it("renders the restore commit line when gitHead is provided", () => {
    const prompt = buildBacktrackPrompt(4, 3, "progress_stall", [], [], HEAD);
    assert.ok(prompt.includes(`Restore to commit \`${HEAD.slice(0, 12)}\``));
  });

  it("omits the commit line when gitHead is absent", () => {
    const prompt = buildBacktrackPrompt(4, 3, "progress_stall", [], []);
    assert.ok(!prompt.includes("Restore to commit"));
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
    const result = enforceRound(se(), verifyResult(flags), 4, [], 0, 0);
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
    const result = enforceRound(se(), verifyResult(flags), 4, [], 0, 0);
    assert.equal(result.action, "accept");
  });
});
