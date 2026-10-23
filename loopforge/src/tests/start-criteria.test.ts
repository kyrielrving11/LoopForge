/** v3.9.4 — initial success criteria are real `cr-*` anchors. */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import {
  StartCriteriaError,
  normalizeStartCriteria,
} from "../mcp/round-lifecycle.js";
import { MemoryLoopStore, DEFAULT_SUCCESS_CRITERION } from "./_helpers.js";
import { toolNext } from "./_helpers.js";
import { resetPolicy, getPolicy } from "../policy.js";
import { deriveCriterionId } from "../token-utils.js";
import { compileLoop } from "../loop-compiler.js";
import {
  makeLoopCompileRequest,
  makeLoopObjective,
  makeLoopRoundResult,
} from "../protocol.js";

const AUTH = "The login flow rejects bad credentials";
const API = "The API returns a typed error for every failure";
const AUTH_ID = deriveCriterionId(AUTH);
const API_ID = deriveCriterionId(API);

describe("v3.9.4 — start criteria normalization", () => {
  beforeEach(() => resetPolicy());

  it("drops empty and duplicate normalized text with warnings", () => {
    const result = normalizeStartCriteria([
      "  " + AUTH + " ",
      "",
      "  ",
      "the login flow   rejects bad credentials",
    ]);
    assert.deepEqual(result.criteria, [AUTH]);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.some((warning) => warning.includes("start_criteria_empty")));
    assert.ok(result.warnings.some((warning) => warning.includes("start_criteria_duplicate")));
  });

  it("rejects non-array and non-string entries structurally", () => {
    assert.throws(() => normalizeStartCriteria("nope"), StartCriteriaError);
    assert.throws(() => normalizeStartCriteria(["ok", 42]), StartCriteriaError);
  });

  it("caps the tail at max_start_criteria with a warning", () => {
    getPolicy().evolution.max_start_criteria = 1;
    const result = normalizeStartCriteria([AUTH, API]);
    assert.deepEqual(result.criteria, [AUTH]);
    assert.ok(result.warnings.some((warning) => warning.includes("start_criteria_capped")));
  });

  it("omitting the field keeps the existing default criterion", async () => {
    const mgr = new SessionManager(new MemoryLoopStore());
    try {
      const started = await TOOL_HANDLERS.loopforge_start(mgr, { task: "Audit the API" });
      const prompt = String(started.prompt ?? "");
      assert.ok(prompt.includes(deriveCriterionId(DEFAULT_SUCCESS_CRITERION)));
      assert.ok(prompt.includes(DEFAULT_SUCCESS_CRITERION));
    } finally {
      mgr.close();
    }
  });
});

describe("v3.9.4 — initial criteria become the objective's anchors", () => {
  beforeEach(() => resetPolicy());

  it("renders every supplied criterion with its stable cr-* id", async () => {
    const mgr = new SessionManager(new MemoryLoopStore());
    try {
      const started = await TOOL_HANDLERS.loopforge_start(mgr, {
        task: "Build the auth module",
        criteria: [AUTH, API],
      });
      const prompt = String(started.prompt ?? "");
      assert.ok(prompt.includes(AUTH_ID), "first criterion id renders");
      assert.ok(prompt.includes(API_ID), "second criterion id renders");
      assert.ok(prompt.includes(AUTH));
      assert.ok(prompt.includes(API));

      const session = mgr.get(String(started.sessionId));
      const acceptance = session?.roundSnapshot?.operatorAcceptance;
      assert.deepEqual(acceptance?.success_criteria, [AUTH, API]);
    } finally {
      mgr.close();
    }
  });

  it("keeps the initial criteria through a round-1 retry", async () => {
    const mgr = new SessionManager(new MemoryLoopStore());
    try {
      const started = await TOOL_HANDLERS.loopforge_start(mgr, {
        task: "Build the auth module",
        criteria: [AUTH],
      });
      const sessionId = String(started.sessionId);
      const roundId = String(started.roundId);
      const rejected = await toolNext(mgr, {
        sessionId,
        roundId,
        evaluation: {
          success: true,
          output_summary: "Claimed success with the criterion still open.",
          constraint_violations: [],
          should_continue: true,
          execution_report: {
            files_changed: [],
            tests_reported: { passed: 0, failed: 0, skipped: 0 },
            criterion_claims: [{ criterion_id: AUTH_ID, outcome: "remaining" }],
          },
        },
      });
      assert.equal(rejected.enforcementAction, "reject");
      const retryPrompt = String(rejected.prompt ?? "");
      assert.ok(retryPrompt.includes(AUTH_ID),
        "the retry prompt must keep the initial criterion id");
      assert.ok(retryPrompt.includes(AUTH));
    } finally {
      mgr.close();
    }
  });

  it("keeps operator criteria immutable", () => {
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "operator-criterion",
      round: 2,
      task: "Build auth",
      loop_objective: makeLoopObjective({
        objective: "Build auth",
        success_criteria: ["Old criterion"],
        hard_constraints: [],
        loop_id: "operator-criterion",
      }),
      constraints_from_plan: ["Old criterion"],
    }), null);
    assert.deepEqual(response.loop_objective?.success_criteria, ["Old criterion"]);
    assert.ok(response.constraints_active.includes("Old criterion"));
    assert.ok(response.criterion_statuses?.some((criterion) => criterion.text === "Old criterion"));
  });

  it("maps a bad criteria argument to invalid_argument at the tool boundary", async () => {
    const mgr = new SessionManager(new MemoryLoopStore());
    try {
      const notArray = await TOOL_HANDLERS.loopforge_start(mgr, {
        task: "Build the auth module",
        criteria: "not-an-array",
      });
      assert.equal(notArray.error, "invalid_argument");

      const notString = await TOOL_HANDLERS.loopforge_start(mgr, {
        task: "Build the auth module",
        criteria: ["ok", 42],
      });
      assert.equal(notString.error, "invalid_argument");
    } finally {
      mgr.close();
    }
  });
});
