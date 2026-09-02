/** v2.12: Derived claim provenance — runtime's honest view of which
 *  agent-reported criteria completions are backed by machine evidence.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeExecutionEvidence, makeSelfEvaluation } from "../protocol.js";
import type { SelfEvaluation, VerificationFlag } from "../protocol.js";
import type { ProviderSnapshot } from "../evidence-provider.js";
import {
  deriveClaimView,
  rederiveClaimViewWithFlags,
  resolveRoundFiles,
  listVerifiedClaims,
} from "../evidence-claims.js";
import type { VaultEntry } from "../loop-store.js";

function evalWithCriteria(
  overrides: Partial<SelfEvaluation> = {},
): SelfEvaluation {
  return makeSelfEvaluation({
    success: true,
    output_summary: "done",
    constraint_violations: [],
    should_continue: false,
    execution_evidence: makeExecutionEvidence({
      files_changed: ["src/a.ts"],
      test_results: { passed: 1, failed: 0, skipped: 0 },
      success_criteria_met: ["tests pass"],
      success_criteria_remaining: [],
      progress_estimate: 1,
    }),
    ...overrides,
  });
}

function commandSnapshot(
  status: "passed" | "failed",
  required = false,
): ProviderSnapshot {
  return {
    provider: "command:npm-test",
    timestamp: Date.now(),
    files: [],
    data: {
      kind: "command",
      commandName: "npm-test",
      required,
      phase: "after",
      status,
      exitCode: status === "passed" ? 0 : 1,
      stdout: status === "passed" ? "all tests passed" : "FAIL 1",
    },
  };
}

describe("deriveClaimView", () => {
  it("marks all reported criteria as claimed by default (no machine evidence)", () => {
    const selfEval = evalWithCriteria({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: null,
        success_criteria_met: ["tests pass"],
        success_criteria_remaining: [],
        progress_estimate: 0.5,
      }),
    });
    const view = deriveClaimView(selfEval, []);
    assert.equal(view.claims.length, 1);
    assert.equal(view.claims[0].status, "claimed");
    assert.equal(view.claims[0].source, "agent");
    assert.equal(view.verifiedCount, 0);
    assert.equal(view.hasMachineEvidence, false);
  });

  it("upgrades to verified only with passing test results AND passed after-command", () => {
    const selfEval = evalWithCriteria();
    const view = deriveClaimView(selfEval, [commandSnapshot("passed")]);
    assert.equal(view.verifiedCount, 1);
    assert.equal(view.claims[0].status, "verified");
    assert.equal(view.claims[0].source, "command");
  });

  it("stays claimed when tests pass but no command snapshot observed", () => {
    const selfEval = evalWithCriteria();
    const view = deriveClaimView(selfEval, []);
    assert.equal(view.verifiedCount, 0);
    assert.equal(view.claims[0].status, "claimed");
  });

  it("v3.3: self-reported passing tests without a passed command are NOT machine evidence", () => {
    // The attack the tightening closes: fabricated test_results alone used
    // to satisfy hasMachineEvidence (which gates R8 and the criteria check).
    const selfEval = evalWithCriteria();
    const view = deriveClaimView(selfEval, []);
    assert.equal(view.hasMachineEvidence, false,
      "self-reported test results alone must not count as machine evidence");
    const withCommand = deriveClaimView(selfEval, [commandSnapshot("passed")]);
    assert.equal(withCommand.hasMachineEvidence, true,
      "a passed after-phase command upgrades the claim to machine evidence");
  });

  it("stays claimed when command passed but test results are null", () => {
    const selfEval = evalWithCriteria({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: null,
        success_criteria_met: ["tests pass"],
        success_criteria_remaining: [],
        progress_estimate: 0.5,
      }),
    });
    const view = deriveClaimView(selfEval, [commandSnapshot("passed")]);
    assert.equal(view.verifiedCount, 0);
  });

  it("stays claimed when test results have failures", () => {
    const selfEval = evalWithCriteria({
      execution_evidence: makeExecutionEvidence({
        files_changed: ["src/a.ts"],
        test_results: { passed: 3, failed: 1, skipped: 0 },
        success_criteria_met: ["tests pass"],
        success_criteria_remaining: [],
        progress_estimate: 0.5,
      }),
    });
    const view = deriveClaimView(selfEval, [commandSnapshot("passed")]);
    assert.equal(view.verifiedCount, 0);
  });
});

describe("rederiveClaimViewWithFlags", () => {
  it("downgrades all claims to contradicted on error-level contradicting flags", () => {
    const selfEval = evalWithCriteria();
    const flags: VerificationFlag[] = [{
      severity: "error",
      field: "success",
      check: "required_command_failed",
      detail: "npm-test failed",
    }];
    const view = rederiveClaimViewWithFlags(selfEval, [commandSnapshot("passed")], flags);
    assert.equal(view.claims[0].status, "contradicted");
    assert.equal(view.claims[0].source, "verification");
    assert.equal(view.verifiedCount, 0);
    assert.equal(view.contradictedCount, 1);
  });

  it("keeps verified claims when flags are only warn-level", () => {
    const selfEval = evalWithCriteria();
    const flags: VerificationFlag[] = [{
      severity: "warn",
      field: "files",
      check: "evidence_integrity",
      detail: "ghost file",
    }];
    const view = rederiveClaimViewWithFlags(selfEval, [commandSnapshot("passed")], flags);
    assert.equal(view.claims[0].status, "verified");
  });
});

describe("resolveRoundFiles", () => {
  const feedback: VaultEntry = {
    id: "loop:provenance-loop:r1:feedback",
    task_id: "loop:provenance-loop:r1:feedback",
    task_type: "feedback",
    loop_id: "provenance-loop",
    timestamp: new Date().toISOString(),
    loop_lineage: {
      round: 1,
      round_transaction: {
        schema_version: 1,
        round_id: "loop:provenance-loop:round:1",
        snapshot: {
          schemaVersion: 1,
          roundId: "loop:provenance-loop:round:1",
          loopId: "provenance-loop",
          round: 1,
          attempt: 1,
          phase: "committed",
          beforeEvidence: [],
          afterEvidence: [{
            provider: "git",
            timestamp: Date.now(),
            files: ["src/a.ts", "src/b.ts"],
            data: { head: "abc123" },
          }],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        result: { action: "continue", verificationFlags: [] },
      },
    },
  };

  it("returns git files from the committed after evidence", () => {
    const files = resolveRoundFiles([feedback], "provenance-loop", 1);
    assert.deepEqual(files, ["src/a.ts", "src/b.ts"]);
  });

  it("returns null when the round has no feedback entry", () => {
    assert.equal(resolveRoundFiles([], "provenance-loop", 1), null);
  });

  it("returns null when the loop has no git snapshot", () => {
    const noGit: VaultEntry = {
      ...feedback,
      loop_lineage: {
        round: 1,
        round_transaction: {
          schema_version: 1,
          round_id: "loop:provenance-loop:round:1",
          snapshot: {
            schemaVersion: 1,
            roundId: "loop:provenance-loop:round:1",
            loopId: "provenance-loop",
            round: 1,
            attempt: 1,
            phase: "committed",
            beforeEvidence: [],
            afterEvidence: [{
              provider: "command:npm-test",
              timestamp: Date.now(),
              files: [],
              data: { kind: "command", phase: "after", status: "passed" },
            }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          result: { action: "continue", verificationFlags: [] },
        },
      },
    };
    assert.equal(resolveRoundFiles([noGit], "provenance-loop", 1), null);
  });
});

describe("listVerifiedClaims", () => {
  function committedFeedback(
    round: number,
    evaluation: SelfEvaluation,
    flags: VerificationFlag[],
    snapshots: ProviderSnapshot[],
  ): VaultEntry {
    return {
      id: `loop:provenance-loop:r${round}:feedback`,
      task_id: `loop:provenance-loop:r${round}:feedback`,
      task_type: "feedback",
      loop_id: "provenance-loop",
      timestamp: new Date().toISOString(),
      loop_lineage: {
        round,
        round_transaction: {
          schema_version: 1,
          round_id: `loop:provenance-loop:round:${round}`,
          snapshot: {
            schemaVersion: 1,
            roundId: `loop:provenance-loop:round:${round}`,
            loopId: "provenance-loop",
            round,
            attempt: 1,
            phase: "committed",
            beforeEvidence: [],
            afterEvidence: snapshots,
            evaluation,
            result: { action: "continue", verificationFlags: flags },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          result: { action: "continue", verificationFlags: flags },
        },
      },
    };
  }

  it("collects verified claim targets across committed rounds", () => {
    const entries = [
      committedFeedback(1, evalWithCriteria(), [], [commandSnapshot("passed")]),
      committedFeedback(
        2,
        evalWithCriteria({
          execution_evidence: makeExecutionEvidence({
            files_changed: ["src/b.ts"],
            test_results: null,
            success_criteria_met: ["docs updated"],
            success_criteria_remaining: [],
            progress_estimate: 0.6,
          }),
        }),
        [],
        [],
      ),
    ];
    const verified = listVerifiedClaims(entries, "provenance-loop");
    assert.deepEqual(verified, ["tests pass"]);
  });

  it("excludes claims contradicted by error flags", () => {
    const entries = [
      committedFeedback(
        1,
        evalWithCriteria(),
        [{
          severity: "error",
          field: "success",
          check: "required_command_failed",
          detail: "failed",
        }],
        [commandSnapshot("passed")],
      ),
    ];
    assert.deepEqual(listVerifiedClaims(entries, "provenance-loop"), []);
  });
});
