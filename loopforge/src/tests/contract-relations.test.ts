/** v3.9.4 — explicit contract relations are stable ids the prompt rendered. */

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateContractShape,
  type ContractValidationContext,
} from "../self-eval.js";
import { SessionManager } from "../mcp/session.js";
import {
  MemoryLoopStore,
  installTestCommandProvider,
  DEFAULT_SUCCESS_CRITERION,
} from "./_helpers.js";
import { resetPolicy } from "../policy.js";
import { deriveCriterionId } from "../token-utils.js";
import { deriveSubGoalId } from "../subgoal-state.js";

const CRITERION = "Auth works";
const CRITERION_ID = deriveCriterionId(CRITERION);
const OTHER_ID = deriveCriterionId("API works");
const SUBGOAL_ID = "sg-11111111";
const OTHER_SUBGOAL_ID = "sg-22222222";

function context(
  overrides: Partial<ContractValidationContext> = {},
): ContractValidationContext {
  return {
    activeItemIds: null,
    knownCriterionIds: new Set([CRITERION_ID]),
    displayedSubGoalIds: new Set([SUBGOAL_ID]),
    isConfiguredCommand: (name) => name === "verify",
    checkScopeEntry: () => null,
    ...overrides,
  };
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: "login works",
    criterion_refs: [CRITERION_ID],
    subgoal_refs: [SUBGOAL_ID],
    verify_with: ["verify"],
    ...overrides,
  };
}

function check(
  items: Array<Record<string, unknown>>,
  overrides: Partial<ContractValidationContext> = {},
) {
  return validateContractShape(
    { round_contract: { scope: [], items } },
    context(overrides),
  );
}

describe("v3.9.4 — strict contract references", () => {
  it("accepts a real active criterion id and a displayed sub-goal id", () => {
    assert.deepEqual(check([item()]), []);
  });

  it("rejects free text and unknown cr- ids", () => {
    const freeText = check([item({ criterion_refs: ["Auth works"] })]);
    assert.equal(freeText[0]?.reason, "invalid_criterion_ref");

    const unknown = check([item({ criterion_refs: [OTHER_ID] })]);
    assert.equal(unknown[0]?.reason, "unknown_criterion_ref");
  });

  it("rejects duplicate refs and duplicate item content", () => {
    const duplicateRef = check([item({
      criterion_refs: [CRITERION_ID, CRITERION_ID],
    })]);
    assert.equal(duplicateRef[0]?.reason, "duplicate_criterion_ref");

    const duplicateItem = check([item(), item({ description: "login   works" })]);
    assert.ok(duplicateItem.some((error) => error.reason === "duplicate_contract_item"));
  });

  it("rejects a sub-goal that is not displayed as active", () => {
    const unknown = check([item({ subgoal_refs: [OTHER_SUBGOAL_ID] })]);
    assert.equal(unknown[0]?.reason, "unknown_subgoal_ref");
  });

  it("fails open only when the reference spaces are unobservable", () => {
    assert.deepEqual(
      check([item({ criterion_refs: [OTHER_ID], subgoal_refs: [OTHER_SUBGOAL_ID] })], {
        knownCriterionIds: null,
        displayedSubGoalIds: null,
      }),
      [],
    );
  });
});

describe("v3.9.4 — a contract can cite a sub-goal only after it is committed", () => {
  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
  });

  it("rejects a same-round emerged sub-goal and accepts it next round", async () => {
    const mgr = new SessionManager(new MemoryLoopStore());
    try {
      const loopId = "contract-subgoal-order";
      const started = await mgr.create({ task: "Build auth", loopId });
      const subGoalId = deriveSubGoalId(loopId, 1, 0, "wire the login form");
      const contract = {
        work_item: "Login slice",
        scope: ["src/auth"],
        items: [{
          description: "login works",
          // Contract refs require a real displayed criterion id.
          criterion_refs: [deriveCriterionId(DEFAULT_SUCCESS_CRITERION)],
          subgoal_refs: [subGoalId],
          verify_with: ["verify"],
        }],
      };

      const sameRound = await mgr.advance(started.sessionId, "", {
        success: false,
        output_summary: "Declared both at once.",
        constraint_violations: [],
        should_continue: true,
        emerged_subtasks: ["wire the login form"],
        round_contract: contract,
      });
      assert.equal(sameRound.submissionError?.code, "contract_invalid",
        "a sub-goal created in this submission is not displayed yet");
      assert.equal(sameRound.round, 1, "a boundary refusal does not advance the round");

      const first = await mgr.advance(started.sessionId, "", {
        success: false,
        output_summary: "Declared the sub-goal.",
        constraint_violations: [],
        should_continue: true,
        emerged_subtasks: ["wire the login form"],
      });
      assert.equal(first.submissionError, undefined);
      assert.equal(first.round, 2);

      const second = await mgr.advance(started.sessionId, "", {
        success: false,
        output_summary: "Declared the contract.",
        constraint_violations: [],
        should_continue: true,
        round_contract: contract,
      });
      assert.equal(second.submissionError, undefined,
        "the committed sub-goal is displayed and referenceable");
      assert.equal(second.round, 3);
      assert.ok(String(second.prompt ?? "").includes("Login slice"),
        "the proposal became the next round's active contract");
    } finally {
      mgr.close();
    }
  });
});
