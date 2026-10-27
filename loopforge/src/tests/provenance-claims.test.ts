/** v2.12: Derived claim provenance — runtime's honest view of which
 *  agent-reported criteria completions are backed by machine evidence.
 */

import { describe, it } from "node:test";
import {
  criterionClaims,
  fixtureEvidencePosture,
} from "./_helpers.js";
import { ROUND_TRANSACTION_SCHEMA_VERSION } from "../round-transaction.js";
import assert from "node:assert/strict";
import { makeExecutionReport, makeSelfEvaluation } from "../protocol.js";
import type { SelfEvaluation, VerificationFlag } from "../protocol.js";
import {
  deriveClaimView,
  rederiveClaimViewWithFlags,
  resolveRoundFiles,
} from "../evidence-claims.js";
import { deriveCriterionId } from "../token-utils.js";
import type { VaultEntry } from "../loop-store.js";

function evalWithCriteria(
  overrides: Partial<SelfEvaluation> = {},
): SelfEvaluation {
  return makeSelfEvaluation({
    success: true,
    output_summary: "done",
    constraint_violations: [],
    should_continue: false,
    execution_report: makeExecutionReport({
      files_changed: ["src/a.ts"],
      tests_reported: { passed: 1, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims(["tests pass"], []),
    }),
    ...overrides,
  });
}

const verifiedIds = (...texts: string[]): Set<string> =>
  new Set(texts.map((text) => deriveCriterionId(text)));

describe("deriveClaimView — machine-verified ids only", () => {
  it("marks reported criteria as claimed by default", () => {
    const selfEval = evalWithCriteria({
      execution_report: makeExecutionReport({
        files_changed: ["src/a.ts"],
        tests_reported: null,
        criterion_claims: criterionClaims(["tests pass"], []),
      }),
    });
    const view = deriveClaimView(selfEval, new Set());
    assert.equal(view.claims.length, 1);
    assert.equal(view.claims[0].status, "claimed");
    assert.equal(view.claims[0].source, "agent");
    assert.equal(view.verifiedCount, 0);
    assert.equal(view.hasMachineEvidence, false);
  });

  it("upgrades ONLY when the criterion id is machine-verified", () => {
    const selfEval = evalWithCriteria();
    const view = deriveClaimView(selfEval, verifiedIds("tests pass"));
    assert.equal(view.verifiedCount, 1);
    assert.equal(view.claims[0].status, "verified");
    assert.equal(view.claims[0].source, "machine");
    assert.equal(view.claims[0].ref, `criterion:${deriveCriterionId("tests pass")}`);
  });

  it("does NOT upgrade from self-reported tests plus a passed command", () => {
    // v4.0.3: tests_reported and a passing command are not a criterion fact.
    const selfEval = evalWithCriteria();
    const view = deriveClaimView(selfEval, new Set());
    assert.equal(view.verifiedCount, 0,
      "Agent-reported test counts never upgrade a claim");
    assert.equal(view.claims[0].status, "claimed");
  });

  it("maps a plain-text target to its stable criterion id", () => {
    const selfEval = evalWithCriteria();
    const view = deriveClaimView(selfEval, verifiedIds("tests pass"));
    assert.equal(view.claims[0].status, "verified");
  });

  it("does not verify a different criterion that happens to share a command", () => {
    const selfEval = evalWithCriteria();
    const view = deriveClaimView(selfEval, verifiedIds("another criterion"));
    assert.equal(view.verifiedCount, 0);
    assert.equal(view.claims[0].status, "claimed");
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
    const view = rederiveClaimViewWithFlags(
      selfEval, verifiedIds("tests pass"), flags);
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
    const view = rederiveClaimViewWithFlags(
      selfEval, verifiedIds("tests pass"), flags);
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
        schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
        round_id: "loop:provenance-loop:round:1",
        snapshot: {
          schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
          kind: "evaluation",
          branchId: "loop:provenance-loop:branch:root",
          transactionId: "tx-provenance-loop-1-1",
          roundId: "loop:provenance-loop:round:1",
          loopId: "provenance-loop",
          round: 1,
          attempt: 1,
          phase: "committed",
          beforeEvidence: [{
            schemaVersion: 2,
            providerId: "git",
            kind: "git",
            phase: "before",
            startedAt: 0,
            finishedAt: 0,
            status: "observed",
            files: [],
            data: {
              dirty: [],
              fingerprints: {},
              head: "abc123",
              coverage: "tracked_and_non_ignored_untracked",
            },
          }],
          beforeCheckpointError: {
            code: "fixture_unavailable",
            detail: "test fixture",
            at: 0,
          },
          afterEvidence: [{
            schemaVersion: 2,
            providerId: "git",
            kind: "git",
            phase: "after",
            startedAt: 0,
            finishedAt: 0,
            status: "observed",
            files: ["src/a.ts", "src/b.ts"],
            data: {
              dirty: ["src/a.ts", "src/b.ts"],
              fingerprints: { "src/a.ts": "m:1", "src/b.ts": "m:1" },
              head: "abc123",
              coverage: "tracked_and_non_ignored_untracked",
            },
          }],
          operatorAcceptance: {
            task: "Provenance task",
            success_criteria: [],
            hard_constraints: [],
          },
          compiled: {
            task: "Provenance task",
            goalId: "provenance-loop:provenance-task",
            constraintsActive: [],
            constraintsRetired: [],
          },
          submittedFields: [
            "success", "output_summary", "constraint_violations", "should_continue",
          ],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        result: {
          action: "continue",
          verificationFlags: [],
          evidencePosture: fixtureEvidencePosture(1),
        },
      },
    },
  };

  it("returns the committed boundary change set", () => {
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
          schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
          round_id: "loop:provenance-loop:round:1",
          snapshot: {
            schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
            kind: "evaluation",
            branchId: "loop:provenance-loop:branch:root",
            transactionId: "tx-provenance-loop-1-1b",
            roundId: "loop:provenance-loop:round:1",
            loopId: "provenance-loop",
            round: 1,
            attempt: 1,
            phase: "committed",
            beforeEvidence: [],
            afterEvidence: [{
              schemaVersion: 1,
              providerId: "command:npm-test",
              kind: "command",
              phase: "after",
              startedAt: 0,
              finishedAt: 0,
              status: "passed",
              files: [],
              data: { commandId: "npm-test" },
            }],
            operatorAcceptance: {
              task: "Provenance task",
              success_criteria: [],
              hard_constraints: [],
            },
            compiled: {
              task: "Provenance task",
              goalId: "provenance-loop:provenance-task",
              constraintsActive: [],
              constraintsRetired: [],
            },
            submittedFields: [
              "success", "output_summary", "constraint_violations", "should_continue",
            ],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          result: {
          action: "continue",
          verificationFlags: [],
          evidencePosture: fixtureEvidencePosture(1),
        },
        },
      },
    };
    assert.equal(resolveRoundFiles([noGit], "provenance-loop", 1), null);
  });
});
