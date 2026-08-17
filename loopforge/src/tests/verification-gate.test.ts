import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VaultEntry } from "../backends/interface.js";
import { normalizeRoundReport } from "../round-report.js";
import { parseTestOutput, verifiedClaimEvidenceMissing, verifyRoundEvaluation } from "../verification-gate.js";

function evaluation(status: "completed" | "in_progress" | "blocked" = "in_progress", phase: "executing" | "auditing" = "executing") {
  return normalizeRoundReport({ status, summary: "A factual round result." }, phase, phase === "auditing" ? null : "ps-one", []);
}

function priorViolation(round: number): VaultEntry {
  return {
    task_id: `loop:test:r${round}:feedback`,
    loop_id: "test",
    loop_lineage: { round },
    round_report: { status: "in_progress", summary: "prior", violations: ["c-api"] },
  };
}

describe("v3 verification gate", () => {
  it("trusts an honest in-progress report without fabricated evidence", () => {
    assert.equal(verifyRoundEvaluation(evaluation(), 1, []).verdict, "trusted");
  });

  it("rejects missing and invalid completion evidence", () => {
    const current = evaluation("completed");
    current.evidenceEnvelope.claims = [{ targetId: "ac-one", evidenceRefs: ["check:missing"] }];
    const result = verifyRoundEvaluation(current, 1, []);
    assert.equal(result.verdict, "contradicted");
    assert.ok(result.flags.some((flag) => flag.check === "claim_reference_invalid"));
  });

  it("detects a violation repeated across three accepted rounds", () => {
    const current = normalizeRoundReport({
      status: "in_progress",
      summary: "Still violating the API constraint.",
      violations: ["c-api"],
    }, "executing", "ps-one", []);
    const result = verifyRoundEvaluation(current, 3, [priorViolation(1), priorViolation(2)]);
    assert.ok(result.flags.some((flag) => flag.check === "recurring_violation"));
  });

  it("rejects final-audit claims backed only by Agent-claimed checks", () => {
    const audit = evaluation("completed", "auditing");
    audit.evidenceEnvelope.checks.value = [{ name: "test", status: "passed" }];
    audit.evidenceEnvelope.claims = [{ targetId: "cr-done", evidenceRefs: ["check:test"] }];
    const result = verifyRoundEvaluation(audit, 4, []);
    assert.ok(result.flags.some((flag) => flag.check === "audit_claim_not_verified"));
  });

  it("accepts a final audit whose claims have runtime-verified Git file evidence", () => {
    const audit = evaluation("completed", "auditing");
    audit.evidenceEnvelope.files = {
      value: ["src/change.ts"],
      confidence: "verified",
      source: "git",
    };
    audit.evidenceEnvelope.fileFingerprints = { "src/change.ts": "100644:abc" };
    audit.evidenceEnvelope.claims = [{ targetId: "cr-done", evidenceRefs: ["file:src/change.ts"] }];
    const result = verifyRoundEvaluation(audit, 4, []);
    assert.equal(result.verdict, "trusted");
    assert.equal(result.flags.length, 0);
  });

  it("detects skipped backtrack files reappearing in evidence", () => {
    const current = evaluation();
    current.evidenceEnvelope.files.value = ["src/old-branch.ts"];
    const result = verifyRoundEvaluation(current, 4, [], null, [], ["src/old-branch.ts"]);
    assert.ok(result.flags.some((flag) => flag.check === "backtrack_workspace_not_restored"));
  });

  it("reports required claim IDs that lack verified provenance", () => {
    const current = evaluation("completed");
    current.evidenceEnvelope.claims = [{ targetId: "ac-one", evidenceRefs: ["check:test"] }];
    current.evidenceEnvelope.checks.value = [{ name: "test", status: "passed" }];
    assert.deepEqual(verifiedClaimEvidenceMissing(current, ["ac-one", "er-two"]), ["ac-one", "er-two"]);
  });
});

describe("test output parsing", () => {
  it("parses Jest, Mocha, pytest, PHP, and Go summaries", () => {
    assert.deepEqual(parseTestOutput("Tests: 1 failed, 4 passed, 2 skipped, 7 total"), { passed: 4, failed: 1, skipped: 2 });
    assert.deepEqual(parseTestOutput("8 passing\n2 failing"), { passed: 8, failed: 2, skipped: 0 });
    assert.deepEqual(parseTestOutput("12 passed, 1 failed, 3 skipped"), { passed: 12, failed: 1, skipped: 3 });
    assert.deepEqual(parseTestOutput("OK (9 tests, 20 assertions)"), { passed: 9, failed: 0, skipped: 0 });
    assert.deepEqual(parseTestOutput("--- PASS: TestOne\n--- FAIL: TestTwo"), { passed: 1, failed: 1, skipped: 0 });
  });
});
