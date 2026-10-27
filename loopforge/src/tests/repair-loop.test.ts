/** v3.9.4 — machine findings are the repair facts of the next prompt. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileLoop } from "../loop-compiler.js";
import {
  makeLoopCompileRequest,
  makeLoopObjective,
  makeSelfEvaluation,
  type VerificationFlag,
} from "../protocol.js";
import { committedFeedbackRound } from "./_helpers.js";
import { verifySelfEvaluation } from "../verification-gate.js";
import { deriveFilesReconciliation } from "../files-reconciliation.js";
import type { ObservationDelta } from "../evidence-provider.js";
import { deriveFindingId } from "../token-utils.js";

function gitDelta(changedFiles: string[] | null): ObservationDelta {
  return {
    providerId: "git",
    kind: "git",
    before: null,
    after: null,
    changedFiles,
    progress: null,
  };
}

function repairContext(loopId: string, entries: unknown[]) {
  return { results: entries } as Record<string, unknown>;
}

function request(loopId: string, round: number) {
  return makeLoopCompileRequest({
    loop_id: loopId,
    round,
    task: "Fix the auth boundary",
    force_level: "l0",
    loop_objective: makeLoopObjective({
      objective: "Fix the auth boundary",
      success_criteria: ["auth boundary is correct"],
      hard_constraints: [],
      created_at_round: 1,
      loop_id: loopId,
    }),
  });
}

describe("v3.9.4 — the machine finding is the next prompt's repair fact", () => {
  it("shows the exact file mismatch and then lets it disappear", () => {
    const loopId = "repair-files";
    const flag: VerificationFlag = {
      severity: "warn",
      field: "execution_report.files_changed",
      check: "evidence_integrity",
      detail: "Agent files_changed doesn't match evidence: unreported: [src/b.ts]; unconfirmed: [src/c.ts]",
    };
    const broken = compileLoop(
      request(loopId, 2),
      repairContext(loopId, [
        committedFeedbackRound(1, {
          loopId,
          success: true,
          verificationFlags: [flag],
        }),
      ]),
    );
    assert.equal(broken.prompt_artifact?.level, "l0");
    // v4.0.3: machine findings render in the protected Verification Gate, not
    // in Retry Requirements (which now carries only rejection/Agent issues).
    assert.match(broken.prompt, /Verification Gate/);
    assert.match(broken.prompt, /unreported: \[src\/b\.ts\]/);
    assert.match(broken.prompt, /unconfirmed: \[src\/c\.ts\]/);
    assert.equal(broken.prompt_artifact?.coverage.complete, true);
    assert.ok(broken.prompt_artifact?.coverage.active.some(
      (entry) => entry.id === deriveFindingId(flag) && entry.kind === "finding",
    ));

    const fixed = compileLoop(
      request(loopId, 3),
      repairContext(loopId, [
        committedFeedbackRound(1, {
          loopId,
          success: true,
          verificationFlags: [flag],
        }),
        committedFeedbackRound(2, { loopId, success: true }),
      ]),
    );
    assert.ok(!fixed.prompt.includes("unreported: [src/b.ts]"),
      "a finding from a committed previous round is not re-injected after a clean round");
    assert.ok(!fixed.prompt.includes("unconfirmed: [src/c.ts]"));
  });

  it("renders the finding's structured ref at L0", () => {
    const loopId = "repair-command";
    const flag: VerificationFlag = {
      severity: "warn",
      field: "tests_reported",
      check: "command_evidence_mismatch",
      detail: "Agent tests_reported don't match \"verify\" output: reported 2, command shows 1",
      ref: "verify",
    };
    const response = compileLoop(
      request(loopId, 2),
      repairContext(loopId, [
        committedFeedbackRound(1, { loopId, success: true, verificationFlags: [flag] }),
      ]),
    );
    assert.ok(response.prompt.includes("[ref: `verify`]"));
    assert.ok(response.prompt_artifact?.coverage.active.some(
      (entry) => entry.id === deriveFindingId(flag) && entry.kind === "finding",
    ));
  });

  it("uses the SAME reconciliation basis as the receipt", () => {
    const selfEval = makeSelfEvaluation({
      success: false,
      output_summary: "Did some work.",
      constraint_violations: [],
      should_continue: true,
      // execution_report omitted on purpose
    });
    const deltas = [gitDelta(["src/a.ts", "src/b.ts"])];
    const result = verifySelfEvaluation(
      selfEval,
      2,
      [],
      null,
      deltas,
      [],
      [],
      false, // the submittedFields manifest did not name files_changed
    );
    const flag = result.flags.find((entry) => entry.check === "evidence_integrity");
    const reconciliation = deriveFilesReconciliation(null, deltas, {
      attempted: false,
    });
    assert.equal(reconciliation.status, "mismatch");
    assert.deepEqual(reconciliation.unreported, ["src/a.ts", "src/b.ts"]);
    assert.ok(flag, "the gate reports the same mismatch the receipt reports");
    assert.match(flag!.detail, /unreported: \[src\/a\.ts, src\/b\.ts\]/);
  });
});
