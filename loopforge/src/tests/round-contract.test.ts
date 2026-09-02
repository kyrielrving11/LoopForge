/** v3.4 — Round Contract lifecycle (proposal vs active) unit tests.
 *
 * Locks the pure derivation walker's edge table and the matcher parity
 * with criteriaMatch (loop-compiler) — the walker mirrors it without an
 * import cycle, so a drift would silently split completion detection
 * between the compile side and the verification side. */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { RoundContract } from "../protocol.js";
import {
  contractItemMatches,
  contractDoneWhenSatisfied,
  deriveActiveRoundContract,
  type CommittedRoundEvaluation,
} from "../round-contract.js";
import { criteriaMatch } from "../loop-compiler.js";
import { deriveItemId } from "../token-utils.js";
import { resetPolicy } from "../policy.js";

/** Contract factory: done_when items given, sensible defaults otherwise. */
function contract(overrides: Partial<RoundContract> = {}): RoundContract {
  return {
    work_item: "Implement login flow",
    done_when: ["cr-login-works"],
    verification_plan: ["verify"],
    scope: ["src/auth"],
    ...overrides,
  };
}

/** Committed-round record factory. */
function cr(
  round: number,
  overrides: Partial<CommittedRoundEvaluation> = {},
): CommittedRoundEvaluation {
  return {
    round,
    proposal: null,
    outcome: null,
    met: [],
    ...overrides,
  };
}

// Real cr-IDs — dash-separated pseudo-IDs ("cr-login-works") do not match
// the cr-XXXXXXXX shape and fuzzy-match each other via Jaccard (tokenize
// splits on dashes), which would make completion tests vacuous.
const idOf = (text: string): string => "cr-" + deriveItemId(text);
const A_DONE_1 = idOf("Login works");
const A_DONE_2 = idOf("Logout works");
const B_DONE = idOf("Session persistence works");

// ═══════════════════════════════════════════════════════════════════════════
// Matcher parity — contractItemMatches must behave exactly like criteriaMatch
// ═══════════════════════════════════════════════════════════════════════════

describe("contractItemMatches parity with criteriaMatch", () => {
  beforeEach(() => resetPolicy());

  const idA = "cr-" + deriveItemId("Login works");
  const idB = "cr-" + deriveItemId("Logout works");

  it("agrees with criteriaMatch over the corpus", () => {
    const pairs: Array<[string, string]> = [
      // exact cr-IDs
      [idA, idA],
      [idA, idB],
      // cr-ID vs text (and whitespace-padded text)
      [idA, "Login works"],
      [idA, "  Login   works  "],
      [idA, "Logout works"],
      // text near-duplicates above/below the Jaccard threshold
      ["Fix login bug", "fix login bug"],
      ["Fix login bug", "Add user profile page"],
      ["Implement login flow", "Implement login flow with redirect"],
      ["Implement login flow", "Build the auth module instead"],
      // empty / one-sided
      ["", "Login works"],
      ["cr-00000000", "cr-00000000"],
    ];
    for (const [a, b] of pairs) {
      assert.equal(
        contractItemMatches(a, b),
        criteriaMatch(a, b),
        `parity mismatch for (${JSON.stringify(a)}, ${JSON.stringify(b)})`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// contractDoneWhenSatisfied
// ═══════════════════════════════════════════════════════════════════════════

describe("contractDoneWhenSatisfied", () => {
  beforeEach(() => resetPolicy());

  it("requires every done_when item to match a met claim", () => {
    const c = contract({ done_when: [A_DONE_1, A_DONE_2] });
    assert.equal(contractDoneWhenSatisfied(c, [A_DONE_1]), false);
    assert.equal(
      contractDoneWhenSatisfied(c, [A_DONE_1, A_DONE_2]),
      true,
    );
    // free-text claims match cr-ID done_when items (derive + compare)
    assert.equal(contractDoneWhenSatisfied(c, ["Login works", A_DONE_2]), true);
  });

  it("is vacuously satisfied by an empty done_when list", () => {
    const c = contract({ done_when: [] });
    assert.equal(contractDoneWhenSatisfied(c, []), true);
    assert.equal(contractDoneWhenSatisfied(c, ["anything"]), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// deriveActiveRoundContract — walker edge table
// ═══════════════════════════════════════════════════════════════════════════

describe("deriveActiveRoundContract", () => {
  // A has TWO done_when items so partial restates are distinguishable from
  // full completion; B is a single-item follow-up contract.
  const A = contract({ work_item: "Item A", done_when: [A_DONE_1, A_DONE_2] });
  const B = contract({ work_item: "Item B", done_when: [B_DONE] });
  const fullMetA = [A_DONE_1, A_DONE_2];

  it("returns null for no committed rounds", () => {
    assert.equal(deriveActiveRoundContract([]), null);
  });

  it("activates a proposal only after its declaration round (d → active at d+1)", () => {
    // Round 1 declares A and (irrelevantly) claims ALL of A's done_when met —
    // declaration-round claims never satisfy its own proposal.
    const one = [cr(1, { proposal: A, met: fullMetA })];
    assert.equal(deriveActiveRoundContract(one), A);
    // Two rounds: d declares A, d+1 is a plain continue round → still A.
    const two = [
      cr(1, { proposal: A }),
      cr(2, { outcome: "partial", met: [] }),
    ];
    const active = deriveActiveRoundContract(two);
    assert.equal(active?.work_item, "Item A");
  });

  it("keeps the active contract through partial restates — full met closes", () => {
    // Restates with no claims, then a PARTIAL claim (one of two) → still A.
    const partial = [
      cr(1, { proposal: A }),
      cr(2, { outcome: "partial", met: [] }),
      cr(3, { outcome: "partial", met: [A_DONE_1] }),
    ];
    const stillActive = deriveActiveRoundContract(partial);
    assert.equal(stillActive?.work_item, "Item A");
    // FULL met closes A.
    const full = [
      cr(1, { proposal: A }),
      cr(2, { outcome: "partial", met: [] }),
      cr(3, { outcome: "partial", met: fullMetA }),
    ];
    assert.equal(deriveActiveRoundContract(full), null);
  });

  it("closes on full met and transitions to the closing eval's proposal", () => {
    const history = [
      cr(1, { proposal: A }),
      cr(2, { outcome: "partial", met: fullMetA, proposal: B }),
    ];
    const active = deriveActiveRoundContract(history);
    assert.equal(active?.work_item, "Item B");
  });

  it("closes on outcome=blocked even when nothing was met", () => {
    const history = [
      cr(1, { proposal: A }),
      cr(2, { outcome: "blocked", met: [], proposal: B }),
    ];
    const active = deriveActiveRoundContract(history);
    assert.equal(active?.work_item, "Item B");
  });

  it("blocked closes before a full-met claim would matter", () => {
    const history = [
      cr(1, { proposal: A }),
      // Blocked AND fully met — the block wins; the proposal B becomes active.
      cr(2, { outcome: "blocked", met: fullMetA, proposal: B }),
    ];
    const active = deriveActiveRoundContract(history);
    assert.equal(active?.work_item, "Item B");
  });

  it("success/partial/failed outcomes without full met keep the contract active", () => {
    for (const outcome of ["success", "partial", "failed"] as const) {
      const history = [
        cr(1, { proposal: A }),
        cr(2, { outcome, met: [] }),
      ];
      const active = deriveActiveRoundContract(history);
      assert.equal(active?.work_item, "Item A", `outcome ${outcome}`);
    }
  });

  it("ignores a premature replacement declared while the active contract is open", () => {
    const history = [
      cr(1, { proposal: A }),
      // Round 2 claims nothing met but proposes B ≠ A — ignored, A continues
      // into round 3.
      cr(2, { outcome: "partial", met: [], proposal: B }),
      cr(3, { outcome: "partial", met: [A_DONE_1] }),
    ];
    const active = deriveActiveRoundContract(history);
    assert.equal(active?.work_item, "Item A");
  });

  it("allows a fresh declaration after a contract closed without proposal", () => {
    const history = [
      cr(1, { proposal: A }),
      cr(2, { outcome: "partial", met: fullMetA }), // closes → none
      cr(3, { proposal: B }), // whole-task round re-proposes
    ];
    const active = deriveActiveRoundContract(history);
    assert.equal(active?.work_item, "Item B");
  });

  it("vacuously closes an empty-done_when contract at the first eval while active", () => {
    const empty = contract({ done_when: [] });
    const history = [
      cr(1, { proposal: empty }),
      cr(2, { outcome: "partial", met: [] }),
    ];
    assert.equal(deriveActiveRoundContract(history), null);
  });

  it("a restated-already-complete contract re-proposed by the closing eval stays active", () => {
    // Round 2 completes A but (mistakenly or by design) proposes A again.
    const history = [
      cr(1, { proposal: A }),
      cr(2, { outcome: "partial", met: fullMetA, proposal: A }),
    ];
    const active = deriveActiveRoundContract(history);
    assert.equal(active?.work_item, "Item A");
  });
});
