/** v3.9.9 — explicit contract redirection (contract_transition). */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  makeExecutionReport,
  makeSelfEvaluation,
  makeVerificationResult,
  type CommandObservation,
  type ContractTransition,
  type RoundContractProposal,
  type SelfEvaluation,
} from "../protocol.js";
import type { CommandEvidencePolicy } from "../policy.js";
import {
  parseContractTransition,
  validateContractTransition,
} from "../self-eval.js";
import {
  canonicalContractItemText,
  deriveContractId,
  deriveContractItemIds,
} from "../token-utils.js";
import { decodeCommittedRound } from "../committed-round.js";
import {
  committedRoundFacts,
  deriveActiveRoundContract,
  deriveRoundContractView,
} from "../round-contract.js";
import { finalizeStopReason } from "../round-coordinator.js";
import { buildExplain } from "../explain.js";
import type { ExplainResult } from "../explain.js";
import type { AuditResult } from "../audit.js";
import { committedFeedbackRound } from "./_helpers.js";

const COMMANDS: ReadonlyArray<CommandEvidencePolicy> = [{
  name: "verify",
  enabled: true,
  executable: "node",
  args: ["-e", "0"],
  phase: "after",
  required: false,
  timeout_ms: 1000,
  max_output_chars: 100,
  success_exit_codes: [0],
}];

const CONTRACT: RoundContractProposal = {
  work_item: "Slice A",
  scope: ["src"],
  items: [{
    description: "A is done",
    criterion_refs: [],
    verify_with: ["verify"],
  }],
};

const SUCCESSOR: RoundContractProposal = {
  work_item: "Slice B",
  items: [{
    description: "B is done",
    criterion_refs: [],
    verify_with: ["verify"],
  }],
};

function commandObservation(): CommandObservation {
  return {
    schemaVersion: 1,
    providerId: "command:verify",
    kind: "command",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "passed",
    files: [],
    data: {
      commandId: "verify",
      argv: [],
      cwd: ".",
      configHash: "hash",
      required: false,
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdoutSha256: "",
      stderrSha256: "",
      stdoutExcerpt: "",
      stderrExcerpt: "",
      truncated: false,
      entrypointFiles: [],
    },
  };
}

const CONTRACT_ID = deriveContractId("ct", CONTRACT);
const SUCCESSOR_ID = deriveContractId("ct", SUCCESSOR);
const ITEM_ID = deriveContractItemIds(CONTRACT.items)[0]!;
const TRANSITION: ContractTransition = {
  kind: "supersede",
  contract_id: CONTRACT_ID,
  reason: "A depends on the shared store",
};

function declaringRound(loopId = "ct") {
  return decodeCommittedRound(committedFeedbackRound(1, {
    loopId,
    contract: CONTRACT,
    contractBinding: {
      rc_id: CONTRACT_ID,
      item_ids: [ITEM_ID],
      config_hash_by_command: {},
    },
  }))!;
}

function redirectRound(input: {
  loopId?: string;
  transition?: ContractTransition;
  contract?: RoundContractProposal;
  claimsMet?: boolean;
  withCommand?: boolean;
}) {
  const loopId = input.loopId ?? "ct";
  return decodeCommittedRound(committedFeedbackRound(2, {
    loopId,
    contract: input.contract ?? SUCCESSOR,
    contractTransition: input.transition ?? TRANSITION,
    contractItemClaims: input.claimsMet
      ? [{ item_id: ITEM_ID, outcome: "met" }]
      : [],
    roundEvidence: input.withCommand ? [commandObservation()] : [],
  }))!;
}

// ═══════════════════════════════════════════════════════════════════════════
// Parsing and strict boundary
// ═══════════════════════════════════════════════════════════════════════════

describe("contract_transition — parsing", () => {
  it("keeps a well-formed transition and drops malformed ones with diagnostics", () => {
    assert.deepEqual(
      parseContractTransition({
        kind: "supersede",
        contract_id: CONTRACT_ID,
        reason: "route changed",
      }),
      { kind: "supersede", contract_id: CONTRACT_ID, reason: "route changed" },
    );
    const diagnostics: Array<{ path: string; code: string }> = [];
    assert.equal(parseContractTransition({ kind: "nope" }, {
      push: (path, code) => diagnostics.push({ path, code }),
    }), undefined);
    assert.ok(diagnostics.some((entry) =>
      entry.path === "contract_transition" && entry.code === "invalid_enum"));
  });
});

describe("contract_transition — strict boundary", () => {
  const itemIdentity = canonicalContractItemText(CONTRACT.items[0]!);
  const context = {
    observed: true,
    activeContractId: CONTRACT_ID,
    activeItemIdentities: new Set([itemIdentity]),
  };
  const valid = {
    should_continue: true,
    contract_transition: { kind: "supersede", contract_id: CONTRACT_ID },
    round_contract: SUCCESSOR,
  };

  it("accepts a targeted transition with a changed successor", () => {
    assert.deepEqual(validateContractTransition(valid, context), []);
  });

  it("rejects structural defects", () => {
    const cases: Array<{ raw: Record<string, unknown>; reason: string }> = [
      {
        raw: { ...valid, contract_transition: { kind: "other", contract_id: CONTRACT_ID } },
        reason: "invalid_kind",
      },
      {
        raw: { ...valid, contract_transition: { kind: "supersede", contract_id: "nope" } },
        reason: "invalid_contract_id",
      },
      {
        raw: { ...valid, contract_transition: { ...TRANSITION, extra: true } },
        reason: "unknown_field",
      },
      {
        raw: { ...valid, contract_transition: { ...TRANSITION, reason: "x".repeat(501) } },
        reason: "invalid_reason",
      },
      {
        raw: { ...valid, round_contract: undefined },
        reason: "transition_without_successor",
      },
      {
        raw: { ...valid, outcome: "blocked" },
        reason: "transition_conflicts_with_blocked",
      },
      {
        raw: { ...valid, stop_reason: "needs_human_input" },
        reason: "transition_conflicts_with_blocked",
      },
      {
        raw: { ...valid, should_continue: false },
        reason: "transition_on_stop",
      },
      {
        raw: { ...valid, contract_transition: { ...TRANSITION, contract_id: "rc-99999999" } },
        reason: "transition_target_mismatch",
      },
      {
        raw: {
          ...valid,
          round_contract: { ...CONTRACT, work_item: "Renamed", scope: ["src/other"] },
        },
        reason: "transition_without_change",
      },
    ];
    for (const { raw, reason } of cases) {
      const errors = validateContractTransition(raw, context);
      assert.ok(errors.some((error) => error.reason === reason),
        `${reason}: ${JSON.stringify(errors)}`);
    }
  });

  it("reports no_active_contract when the loop has no active contract", () => {
    const errors = validateContractTransition(valid, {
      observed: true,
      activeContractId: null,
      activeItemIdentities: null,
    });
    assert.ok(errors.some((error) => error.reason === "no_active_contract"));
  });

  it("fails open on target/content checks when the session is unobservable", () => {
    const errors = validateContractTransition({
      ...valid,
      contract_transition: { kind: "supersede", contract_id: "rc-99999999" },
    }, {
      observed: false,
      activeContractId: null,
      activeItemIdentities: null,
    });
    assert.deepEqual(errors, [], "structure only when the active contract is unobservable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Closure and the active-contract walker
// ═══════════════════════════════════════════════════════════════════════════

describe("contract_transition — superseded closure", () => {
  it("outranks verified and keeps the old items visible", () => {
    const declaring = declaringRound();
    const redirect = redirectRound({ claimsMet: true, withCommand: true });
    const { contract, statuses } = deriveRoundContractView({
      rounds: [declaring, redirect],
      round: 2,
      current: committedRoundFacts(redirect),
      commands: COMMANDS,
    });
    assert.equal(contract?.id, CONTRACT_ID);
    assert.equal(statuses.closure, "superseded",
      "an explicit redirect outranks a fully verified old slice");
    assert.equal(statuses.closed_at_round, 2);
    assert.equal(statuses.items[0]?.status, "verified",
      "item statuses remain machine facts");
    assert.equal(statuses.verifiedCount, 1);
  });

  it("activates the successor next round", () => {
    const declaring = declaringRound();
    const redirect = redirectRound({});
    const active = deriveActiveRoundContract(
      [declaring, redirect], COMMANDS);
    assert.equal(active?.id, SUCCESSOR_ID);
    assert.equal(active?.work_item, "Slice B");
  });

  it("ignores an abnormal target and keeps the original contract", () => {
    const declaring = declaringRound();
    const redirect = redirectRound({
      transition: { kind: "supersede", contract_id: "rc-99999999" },
    });
    const { statuses } = deriveRoundContractView({
      rounds: [declaring, redirect],
      round: 2,
      current: committedRoundFacts(redirect),
      commands: COMMANDS,
    });
    assert.equal(statuses.closure, "open",
      "an inert transition cannot close a contract");
    assert.equal(deriveActiveRoundContract([declaring, redirect], COMMANDS)?.id,
      CONTRACT_ID);
  });

  it("read views treat stop_reason=blocked as a blocked closure", () => {
    // The live coordinator always saw both blocked declarations; read views
    // used to pass only `outcome`, so a `stop_reason: "blocked"` round could
    // look open there. The shared fact bundle removes that second judgment.
    const declaring = committedFeedbackRound(1, {
      loopId: "ct",
      contract: CONTRACT,
      contractBinding: {
        rc_id: CONTRACT_ID,
        item_ids: [ITEM_ID],
        config_hash_by_command: {},
      },
    });
    const blocked = committedFeedbackRound(2, { loopId: "ct" });
    const envelope = (blocked.loop_lineage as Record<string, unknown>)
      .round_transaction as Record<string, unknown>;
    ((envelope.snapshot as Record<string, unknown>)
      .evaluation as Record<string, unknown>).stop_reason = "blocked";

    const explain = buildExplain("ct", [declaring, blocked]);
    const explained = explain.rounds.find((round) => round.round === 2);
    assert.equal(explained?.contract?.closure, "blocked");
  });

  it("never lets a redirect round be reported as completed", () => {
    const finalized = finalizeStopReason(
      "completed",
      makeSelfEvaluation({
        success: true,
        output_summary: "redirect",
        constraint_violations: [],
        should_continue: false,
        contract_transition: TRANSITION,
      }),
      undefined,
      TRANSITION,
    );
    assert.equal(finalized.reason, "incomplete");
    assert.equal(finalized.flags[0]?.check, "completion_truth_downgraded");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Verification debt across a redirect
// ═══════════════════════════════════════════════════════════════════════════

import { verifySelfEvaluation, CHECK_CONTRACT_ITEMS_UNVERIFIED } from "../verification-gate.js";
import { resetPolicy, setPolicyForTest, DEFAULT_POLICY } from "../policy.js";

describe("contract_transition — verification debt", () => {
  beforeEach(() => resetPolicy());

  function redirectEvaluation(claimsMet: boolean): SelfEvaluation {
    return makeSelfEvaluation({
      success: false,
      output_summary: "redirect",
      constraint_violations: [],
      should_continue: true,
      contract_transition: TRANSITION,
      execution_report: makeExecutionReport({
        contract_item_claims: claimsMet
          ? [{ item_id: ITEM_ID, outcome: "met" }]
          : [],
      }),
    });
  }

  it("retires debt for an honest abandonment with no met claim", () => {
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: { ...DEFAULT_POLICY.evidence, providers: [], commands: [...COMMANDS] },
    });
    const result = verifySelfEvaluation(
      redirectEvaluation(false), 2, [committedFeedbackRound(1, {
        loopId: "ct",
        contract: CONTRACT,
        contractBinding: {
          rc_id: CONTRACT_ID,
          item_ids: [ITEM_ID],
          config_hash_by_command: {},
        },
      })],
    );
    assert.ok(!result.flags.some((flag) =>
      flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED));
  });

  it("keeps debt when the redirect round still claims an old item met", () => {
    setPolicyForTest({
      ...DEFAULT_POLICY,
      evidence: { ...DEFAULT_POLICY.evidence, providers: [], commands: [...COMMANDS] },
    });
    const result = verifySelfEvaluation(
      redirectEvaluation(true), 2, [committedFeedbackRound(1, {
        loopId: "ct",
        contract: CONTRACT,
        contractBinding: {
          rc_id: CONTRACT_ID,
          item_ids: [ITEM_ID],
          config_hash_by_command: {},
        },
      })],
    );
    assert.ok(result.flags.some((flag) =>
      flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED),
      "a redirect cannot wash away an unverified completion claim");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP end-to-end: declare → supersede → successor active → audit
// ═══════════════════════════════════════════════════════════════════════════

import { MemoryLoopStore, installTestCommandProvider, toolNext } from "./_helpers.js";
import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";

describe("contract_transition — MCP end-to-end", () => {
  let store: MemoryLoopStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
    store = new MemoryLoopStore();
    mgr = new SessionManager(store);
  });

  it("declares, rejects a stale target without side effects, then supersedes", async () => {
    const e2eContractId = deriveContractId("transition-e2e", CONTRACT);
    const e2eSuccessorId = deriveContractId("transition-e2e", SUCCESSOR);
    const started = await TOOL_HANDLERS.loopforge_start(mgr, {
      task: "Build the shared store first",
      loopId: "transition-e2e",
    });
    const sessionId = String(started.sessionId);
    const heldRound1 = mgr.get(sessionId)!.roundSnapshot!;

    const declaration = {
      success: false,
      output_summary: "Sliced the work",
      constraint_violations: [],
      should_continue: true,
      round_contract: CONTRACT,
    };
    const afterDeclaration = await toolNext(mgr, {
      sessionId,
      roundId: heldRound1.roundId,
      output: "",
      evaluation: declaration,
    });
    assert.equal(afterDeclaration.prompt !== null, true);
    const active = mgr.getActiveContract(sessionId);
    assert.equal(active?.id, e2eContractId, "the declared slice is active");

    const heldRound2 = mgr.get(sessionId)!.roundSnapshot!;
    const successorEvaluation = {
      success: false,
      output_summary: "The auth slice is not the route",
      constraint_violations: [],
      should_continue: true,
      contract_transition: {
        kind: "supersede",
        contract_id: "rc-99999999",
        reason: "stale target",
      },
      round_contract: SUCCESSOR,
    };
    const stale = await toolNext(mgr, {
      sessionId,
      roundId: heldRound2.roundId,
      output: "",
      evaluation: successorEvaluation,
    });
    assert.equal(stale.error, "contract_invalid");
    const details = stale.details as { contract_errors?: Array<{ reason: string }> };
    assert.ok(details.contract_errors?.some((error) =>
      error.reason === "transition_target_mismatch"));

    // The invalid attempt wrote nothing and the same anchors still work.
    const stillHeld = mgr.get(sessionId)!.roundSnapshot!;
    assert.equal(stillHeld.roundId, heldRound2.roundId);
    assert.equal(stillHeld.transactionId, heldRound2.transactionId);

    const redirect = await toolNext(mgr, {
      sessionId,
      roundId: heldRound2.roundId,
      output: "",
      evaluation: {
        ...successorEvaluation,
        contract_transition: {
          kind: "supersede",
          contract_id: e2eContractId,
          reason: TRANSITION.reason,
        },
      },
    });
    assert.equal(redirect.error, undefined);
    assert.equal(redirect.prompt !== null, true);
    const receipt = redirect.submission_receipt as {
      effects: { contract: { superseded?: boolean; transition_reason?: string; before_id: string; after_id: string } };
    };
    assert.equal(receipt.effects.contract.superseded, true);
    assert.equal(receipt.effects.contract.transition_reason, TRANSITION.reason);
    assert.equal(receipt.effects.contract.before_id, e2eContractId);
    assert.equal(receipt.effects.contract.after_id, e2eSuccessorId);

    // The successor is now the ACTIVE contract for round 3.
    const successor = mgr.getActiveContract(sessionId);
    assert.equal(successor?.id, e2eSuccessorId);
    assert.equal(successor?.work_item, "Slice B");

    // Read views agree with the committed transition.
    const explain = mgr.getExplain("transition-e2e") as unknown as ExplainResult;
    const explained = explain.rounds.find((round) => round.round === 2);
    assert.equal(explained?.contract?.closure, "superseded");
    assert.equal(explained?.contractRedirect?.contract_id, e2eContractId);
    assert.equal(explained?.contractRedirect?.reason, TRANSITION.reason);

    const replay = mgr.replayTimeline(sessionId) ?? [];
    const replayed = replay.find((entry) => entry.round === 2) as Record<string, unknown>;
    assert.deepEqual(replayed.contract_redirect, {
      kind: "supersede",
      contract_id: e2eContractId,
      reason: TRANSITION.reason,
    });

    const audit = mgr.getAudit("transition-e2e") as unknown as AuditResult | null;
    assert.ok(audit);
    assert.equal(audit!.verdict, "incomplete",
      "a loop that stopped after a redirect did not pass");
    assert.ok((audit!.contracts.superseded ?? 0) >= 1);
    const oldContract = audit!.contracts.contracts.find(
      (contract) => contract.contract_id === e2eContractId);
    assert.equal(oldContract?.closure, "superseded");
    assert.equal(oldContract?.items[0]?.status, "pending",
      "the abandoned item stays visible in the audit record");
  });
});
