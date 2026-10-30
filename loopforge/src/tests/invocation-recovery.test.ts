/** v4.0.5 — invocation cold handoff and the invocation-level user instruction.
 *
 *  The cold handoff recompiles the SAME logical round/attempt as
 *  `fresh_invocation / invocation_recovery`; it never advances, collects
 *  before evidence or writes a Vault round. The current user instruction is
 *  invocation input: it reaches one prompt/artifact and never rewrites
 *  `session.task`, operator acceptance, goal identity or round state.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getPolicy,
  resetPolicy,
} from "../policy.js";
import {
  makeExecutionReport,
  makeSelfEvaluation,
  type SelfEvaluation,
} from "../protocol.js";
import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import {
  MemoryLoopStore,
  advanceWithHeld,
  committedFeedbackRound,
  criterionClaims,
  fixtureEvidencePosture,
  installTestCommandProvider,
  promptArtifact,
} from "./_helpers.js";
import { registerEvidenceProvider } from "../evidence-provider.js";
import { CompileFailureError } from "../errors.js";
import { compileLoop } from "../loop-compiler.js";
import { makeLoopCompileRequest } from "../protocol.js";
import {
  deriveTransactionId,
  parseRoundTransactionSnapshot,
  rebindHeldPrompt,
  type RoundTransactionSnapshot,
} from "../round-transaction.js";
import { legacyTransactionRounds } from "../committed-round.js";
import { buildExplain } from "../explain.js";
import { VaultSessionStateStore } from "../storage.js";
import type { SessionStateStore } from "../storage.js";
import type { VaultEntry } from "../loop-store.js";

type VaultEntryLike = Record<string, unknown>;

/** The committed transaction snapshot a fixture entry carries. */
function snapshotOf(entry: VaultEntryLike): VaultEntryLike {
  const lineage = entry.loop_lineage as Record<string, unknown>;
  return (lineage.round_transaction as Record<string, unknown>)
    .snapshot as VaultEntryLike;
}

afterEach(() => resetPolicy());

function rejectedEvaluation(): SelfEvaluation {
  return makeSelfEvaluation({
    success: true,
    output_summary: "claimed completion",
    constraint_violations: [],
    should_continue: true,
    execution_report: makeExecutionReport({
      files_changed: [],
      tests_reported: null,
      criterion_claims: criterionClaims(
        [], ["Task goal achieved with verifiable evidence"]),
    }),
  });
}

function continuingEvaluation(): SelfEvaluation {
  return makeSelfEvaluation({
    success: false,
    output_summary: "partial progress",
    constraint_violations: [],
    should_continue: true,
    execution_report: makeExecutionReport({
      files_changed: [],
      tests_reported: null,
      criterion_claims: criterionClaims(
        [], ["Task goal achieved with verifiable evidence"]),
    }),
  });
}

function countingProvider(): { name: string; reset: () => number } {
  let captures = 0;
  registerEvidenceProvider("cold-baseline", () => ({
    name: "cold-baseline",
    kind: "custom",
    capture: (context) => {
      assert.ok(context);
      return {
        schemaVersion: 1,
        providerId: "cold-baseline",
        kind: "custom",
        phase: context.phase,
        status: "observed",
        startedAt: 0,
        finishedAt: 0,
        files: [],
        data: { capture: ++captures },
      };
    },
  }));
  getPolicy().evidence.providers = ["cold-baseline"];
  getPolicy().state_file.enabled = false;
  installTestCommandProvider();
  return { name: "cold-baseline", reset: () => captures };
}

/** Drive a loop to round 2 and reject it once, leaving a held
 *  `same_round_retry` attempt 2 prompt. */
async function rejectRoundTwo(
  mgr: SessionManager,
  loopId: string,
  task: string,
): Promise<{ sessionId: string; capturesAfterRejection: number }> {
  const started = await mgr.create({ task, loopId });
  const accepted = await advanceWithHeld(
    mgr, started.sessionId, "", continuingEvaluation(), started.submissionHandle,
  );
  assert.ok(accepted.prompt, "round 1 must be accepted into round 2");
  const rejected = await advanceWithHeld(
    mgr, started.sessionId, "", rejectedEvaluation(),
  );
  assert.equal(rejected.enforcementAction, "reject");
  assert.equal(rejected.contextMode, "same_round_retry");
  assert.equal(rejected.level, "l0");
  return { sessionId: started.sessionId, capturesAfterRejection: 0 };
}

describe("v4.0.5 — invocation recovery across a restart", () => {
  it("recompiles the same round/attempt as a cold context", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "cold-handoff";
    const mgr = new SessionManager(store);
    const restarted = new SessionManager(store);
    try {
      const { sessionId } = await rejectRoundTwo(
        mgr, loopId, "Cold handoff task",
      );
      const session = mgr.get(sessionId)!;
      const held = session.roundSnapshot!;
      assert.equal(held.round, 2);
      assert.equal(held.attempt, 2);
      const baseline = structuredClone(held.beforeEvidence);
      const retryContext = structuredClone(held.retryContext);
      assert.ok(retryContext);
      const capturesAfterRejection = provider.reset();
      const oldHandle = mgr.getSubmissionHandle(sessionId)!;
      mgr.close();

      const resumed = await restarted.resume(loopId, { invocationLost: true });
      assert.ok(resumed?.prompt);
      assert.equal(resumed!.contextMode, "fresh_invocation");
      assert.equal(resumed!.contextReason, "invocation_recovery");
      assert.equal(resumed!.level, "l2");
      assert.match(resumed!.prompt!, /Working Memory \(Agent reports are claims\)/);
      assert.match(resumed!.prompt!, /Machine Evidence — previous committed round R1/);
      assert.match(resumed!.prompt!, /not committed/);
      assert.match(resumed!.prompt!, /Inspect the current workspace before acting/);
      assert.match(resumed!.prompt!, /clean context repair \+ invocation recovery/);

      const heldNow = restarted.getByLoopId(loopId)!.roundSnapshot!;
      assert.equal(heldNow.round, 2);
      assert.equal(heldNow.attempt, 2);
      assert.deepEqual(heldNow.beforeEvidence, baseline);
      assert.equal(provider.reset(), capturesAfterRejection,
        "a cold recompile must not capture evidence");
      assert.deepEqual(heldNow.retryContext, retryContext);
      assert.equal(heldNow.promptArtifact?.round, 2);
      assert.equal(heldNow.promptArtifact?.attempt, 2);
      assert.equal(heldNow.promptArtifact?.contextMode, "fresh_invocation");
      assert.equal(heldNow.promptArtifact?.contextReason, "invocation_recovery");
      assert.equal(heldNow.promptArtifact?.level, "l2");

      // Idempotent: a second declaration returns the SAME prompt and handle.
      const again = await restarted.resume(loopId, { invocationLost: true });
      assert.deepEqual(again?.submissionHandle, resumed!.submissionHandle);
      assert.equal(again?.prompt, resumed!.prompt);
      assert.equal(provider.reset(), capturesAfterRejection);

      // The old handle has zero side effects: the standard stale-handle
      // response re-delivers the CURRENT cold prompt, never the submitted
      // evaluation, and writes nothing.
      const entriesBeforeStale = store.listEntries(loopId).length;
      const stale = await restarted.advance(oldHandle, "", continuingEvaluation());
      assert.equal(stale.prompt, again?.prompt);
      assert.deepEqual(stale.submissionHandle, again?.submissionHandle);
      assert.equal(store.listEntries(loopId).length, entriesBeforeStale);

      // The new handle submits the SAME round/attempt.
      const accepted = await advanceWithHeld(
        restarted, resumed!.sessionId, "", continuingEvaluation(),
        resumed!.submissionHandle,
      );
      assert.equal(accepted.round, 3);
      const committed = snapshotOf(
        store.listEntries(loopId).find((entry) =>
          entry.task_id === `loop:${loopId}:r2:feedback`)!,
      );
      assert.equal(committed.round, 2);
      assert.equal(committed.attempt, 2);
      assert.deepEqual(committed.beforeEvidence, baseline);
      assert.equal(committed.retryContext, undefined);
    } finally {
      mgr.close();
      restarted.close();
    }
  });

  it("recompiles a rejected attempt whose retry prompt never compiled", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "failed-retry-cold";
    const mgr = new SessionManager(store);
    const restarted = new SessionManager(store);
    try {
      const started = await mgr.create({ task: "Cold retry compile", loopId });
      const session = mgr.get(started.sessionId)!;
      const baseline = structuredClone(session.roundSnapshot!.beforeEvidence);
      const original = session.engine.invokeLoopCompile;
      session.engine.invokeLoopCompile = () => {
        throw new CompileFailureError("injected retry compile failure");
      };
      const failed = await advanceWithHeld(
        mgr, started.sessionId, "", rejectedEvaluation(), started.submissionHandle,
      );
      session.engine.invokeLoopCompile = original;
      assert.equal(failed.stopReason, "stalled");
      assert.equal(session.roundSnapshot?.phase, "rejected");
      assert.equal(session.roundSnapshot?.retryContext?.attempt, 2);
      const capturesAfterRejection = provider.reset();
      mgr.close();

      const resumed = await restarted.resume(loopId, { invocationLost: true });
      assert.ok(resumed?.prompt);
      assert.equal(resumed!.contextMode, "fresh_invocation");
      assert.equal(resumed!.contextReason, "invocation_recovery");
      assert.equal(resumed!.level, "l2");
      assert.match(resumed!.prompt!, /REJECTED/);
      const held = restarted.getByLoopId(loopId)!.roundSnapshot!;
      assert.equal(held.round, 1);
      assert.equal(held.attempt, 2);
      assert.equal(held.phase, "prompted");
      assert.deepEqual(held.beforeEvidence, baseline);
      assert.equal(provider.reset(), capturesAfterRejection,
        "the retry compile must not recapture before evidence");
      assert.equal(held.promptArtifact?.contextReason, "invocation_recovery");

      const accepted = await advanceWithHeld(
        restarted, resumed!.sessionId, "", continuingEvaluation(),
        resumed!.submissionHandle,
      );
      assert.equal(accepted.round, 2);
    } finally {
      mgr.close();
      restarted.close();
    }
  });

  it("is an idempotent no-op when no retry material exists", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "no-retry-material";
    const mgr = new SessionManager(store);
    const restarted = new SessionManager(store);
    try {
      const started = await mgr.create({ task: "No retry material", loopId });
      const originalPrompt = started.prompt;
      const originalHandle = started.submissionHandle;
      const captures = provider.reset();
      mgr.close();

      const resumed = await restarted.resume(loopId, { invocationLost: true });
      assert.equal(resumed?.prompt, originalPrompt);
      assert.deepEqual(resumed?.submissionHandle, originalHandle);
      assert.equal(resumed?.contextReason, "first_round");
      assert.equal(provider.reset(), captures,
        "an ordinary held-prompt redelivery compiles nothing");
    } finally {
      mgr.close();
      restarted.close();
    }
  });

  it("an already escalated clean retry is an idempotent no-op", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "escalated-cold";
    const mgr = new SessionManager(store);
    const restarted = new SessionManager(store);
    try {
      const { sessionId } = await rejectRoundTwo(
        mgr, loopId, "Escalated cold retry",
      );
      const second = await advanceWithHeld(
        mgr, sessionId, "", rejectedEvaluation(),
      );
      assert.equal(second.enforcementAction, "reject");
      assert.equal(second.contextMode, "fresh_invocation");
      assert.equal(second.contextReason, "rejection_escalation");
      const prompt = second.prompt;
      const handle = second.submissionHandle;
      const captures = provider.reset();
      mgr.close();

      const resumed = await restarted.resume(loopId, { invocationLost: true });
      assert.equal(resumed?.prompt, prompt);
      assert.deepEqual(resumed?.submissionHandle, handle);
      assert.equal(resumed?.contextReason, "rejection_escalation");
      assert.equal(provider.reset(), captures);
    } finally {
      mgr.close();
      restarted.close();
    }
  });

  it("a stopped loop returns its terminal result and ignores inputs", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "stopped-instruction";
    const mgr = new SessionManager(store);
    try {
      const started = await mgr.create({ task: "Stopped task", loopId });
      await TOOL_HANDLERS.loopforge_stop(mgr, { sessionId: started.sessionId });
      const entriesBefore = store.listEntries(loopId).length;
      const resumed = await TOOL_HANDLERS.loopforge_resume(mgr, {
        loopId,
        currentUserInstruction: "Must not be stored",
      });
      assert.equal(resumed.prompt, null);
      assert.equal(resumed.sessionStatus, "stopped");
      assert.equal(store.listEntries(loopId).length, entriesBefore);
    } finally {
      mgr.close();
    }
  });

  it("paused sessions take the unpause path and still recompile", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "paused-cold";
    const mgr = new SessionManager(store);
    const restarted = new SessionManager(store);
    try {
      const { sessionId } = await rejectRoundTwo(
        mgr, loopId, "Paused cold retry",
      );
      mgr.pause(sessionId);
      provider.reset();
      mgr.close();

      const resumed = await TOOL_HANDLERS.loopforge_resume(restarted, {
        loopId,
        invocationLost: true,
      });
      assert.equal(resumed.error, undefined);
      assert.equal(resumed.contextMode, "fresh_invocation");
      assert.equal(resumed.contextReason, "invocation_recovery");
      assert.equal(resumed.level, "l2");
    } finally {
      mgr.close();
      restarted.close();
    }
  });

  it("refuses a held retry without retry context, with zero side effects", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "missing-retry-context";
    const mgr = new SessionManager(store);
    const restarted = new SessionManager(store);
    try {
      const { sessionId } = await rejectRoundTwo(
        mgr, loopId, "Missing retry context",
      );
      const session = mgr.get(sessionId)!;
      session.roundSnapshot!.retryContext = undefined;
      mgr.save(session);
      provider.reset();
      mgr.close();

      const entriesBefore = store.listEntries(loopId).length;
      const resumed = await restarted.resume(loopId, { invocationLost: true });
      assert.equal(resumed?.prompt, null);
      assert.equal(resumed?.submissionError?.code, "invalid_argument");
      assert.equal(
        (resumed?.submissionError?.details as Record<string, unknown>)
          .reason_code,
        "invocation_recovery_unavailable",
      );
      assert.equal(store.listEntries(loopId).length, entriesBefore,
        "the refusal writes nothing");
    } finally {
      mgr.close();
      restarted.close();
    }
  });
  it("resume with an instruction keeps invocation recovery and is idempotent", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "cold-instruction-resume";
    const mgr = new SessionManager(store);
    const restarted = new SessionManager(store);
    try {
      await rejectRoundTwo(mgr, loopId, "Cold instruction resume");
      provider.reset();
      mgr.close();
      const cold = await restarted.resume(loopId, { invocationLost: true });
      assert.equal(cold?.contextReason, "invocation_recovery");
      const withInstruction = await restarted.resume(loopId, {
        currentUserInstruction: "Late cold instruction",
      });
      assert.equal(withInstruction?.contextMode, "fresh_invocation");
      assert.equal(withInstruction?.contextReason, "invocation_recovery");
      assert.equal(withInstruction?.level, "l2");
      assert.match(withInstruction!.prompt!, /Late cold instruction/);
      const same = await restarted.resume(loopId, {
        currentUserInstruction: "Late cold instruction",
      });
      assert.deepEqual(same?.submissionHandle, withInstruction?.submissionHandle);
      assert.equal(same?.prompt, withInstruction?.prompt);
    } finally {
      mgr.close();
      restarted.close();
    }
  });
});

describe("v4.0.5 — current user instruction is invocation input", () => {
  it("without a contract the instruction is the Current Task, not a new objective", () => {
    resetPolicy();
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "instruction-compile",
      task: "Original task text",
      current_user_instruction: "Do the newest thing",
    }), null);
    assert.equal(
      response.prompt_artifact?.currentUserInstruction,
      "Do the newest thing",
    );
    assert.match(response.prompt, /### Current Task\nDo the newest thing/);
    assert.ok(!response.prompt.includes("Current User Instruction"),
      "the instruction is not duplicated when it IS the Current Task");
    assert.match(response.prompt, /### Objective\nOriginal task text/);
    assert.equal(response.compiled?.task, "Original task text");
    assert.equal(response.goal_id, "instruction-compile:original-task-text");
    assert.equal(response.prompt_artifact?.contextReason, "first_round");
  });

  it("with a contract it renders a protected section beside the contract", () => {
    resetPolicy();
    installTestCommandProvider();
    const loopId = "instruction-contract";
    const contract = {
      work_item: "Slice A",
      items: [{ description: "a one", criterion_refs: [], verify_with: ["verify"] }],
    };
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: loopId,
      round: 2,
      task: "Original task text",
      current_user_instruction: "Also check the parser edge case",
    }), {
      results: [committedFeedbackRound(1, { loopId, contract })],
    });
    assert.match(response.prompt, /\*\*Slice A\*\*/,
      "the contract remains the Current Task");
    assert.match(response.prompt,
      /### Current User Instruction\nAlso check the parser edge case/);
    assert.match(response.prompt,
      /does not rewrite the Objective, Success Criteria, hard constraints/);
    assert.equal(response.compiled?.task, "Original task text");
    assert.equal(response.prompt_artifact?.currentUserInstruction,
      "Also check the parser edge case");
  });

  it("de-duplicates only an exact (trimmed, case-sensitive) match", () => {
    resetPolicy();
    installTestCommandProvider();
    const loopId = "instruction-dedupe";
    const contract = {
      work_item: "Slice A",
      items: [{ description: "a one", criterion_refs: [], verify_with: ["verify"] }],
    };
    const context = {
      results: [committedFeedbackRound(1, { loopId, contract })],
    };
    // The committed acceptance task is "Test task"; an exact match with the
    // objective is not repeated.
    const exact = compileLoop(makeLoopCompileRequest({
      loop_id: loopId, round: 2, task: "Original task text",
      current_user_instruction: "Test task",
    }), context);
    assert.ok(!exact.prompt.includes("### Current User Instruction"));
    // A case-only difference is a NEW host spelling and renders.
    const cased = compileLoop(makeLoopCompileRequest({
      loop_id: loopId, round: 2, task: "Original task text",
      current_user_instruction: "test task",
    }), context);
    assert.match(cased.prompt,
      /### Current User Instruction\ntest task/);
  });

  it("states not provided explicitly and never infers the old task", () => {
    resetPolicy();
    const response = compileLoop(makeLoopCompileRequest({
      loop_id: "instruction-missing",
      task: "Original task text",
    }), null);
    assert.match(response.prompt,
      /Current user instruction: not provided for this invocation/);
    assert.match(response.prompt,
      /the Objective and Current Task remain operative/);
    assert.equal(response.prompt_artifact?.currentUserInstruction, undefined);
  });

  it("does not change acceptance, goal, level or context facts", () => {
    resetPolicy();
    const base = makeLoopCompileRequest({
      loop_id: "instruction-invariants",
      task: "Original task text",
    });
    const withInstruction = compileLoop(
      { ...base, current_user_instruction: "New instruction" }, null);
    const without = compileLoop(base, null);
    assert.equal(withInstruction.compiled?.task, without.compiled?.task);
    assert.equal(withInstruction.goal_id, without.goal_id);
    assert.equal(withInstruction.recompile_level, without.recompile_level);
    assert.equal(
      withInstruction.prompt_artifact?.contextReason,
      without.prompt_artifact?.contextReason,
    );
    assert.equal(withInstruction.operatorAcceptance?.task, "Original task text");
    // The instruction never feeds Working Memory, findings or a gate input.
    assert.deepEqual(
      withInstruction.prompt_artifact?.workingMemory,
      without.prompt_artifact?.workingMemory,
    );
    assert.deepEqual(
      withInstruction.criterion_statuses,
      without.criterion_statuses,
    );
    assert.deepEqual(
      withInstruction.constraints_active,
      without.constraints_active,
    );
  });
});

describe("v4.0.5 — loopforge_next instruction recompile mode", () => {
  it("recompiles the held prompt without submitting or advancing", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "next-instruction";
    const mgr = new SessionManager(store);
    try {
      const started = await mgr.create({
        task: "Instruction task",
        loopId,
      });
      const sessionId = started.sessionId;
      const session = mgr.get(sessionId)!;
      assert.equal(
        session.roundSnapshot?.promptArtifact?.currentUserInstruction,
        "Instruction task",
        "loopforge_start records the initial task as the round-1 instruction",
      );
      const baseline = structuredClone(session.roundSnapshot!.beforeEvidence);
      const captures = provider.reset();
      const beforeTask = session.task;
      const beforeAcceptance = structuredClone(session.operatorAcceptance);

      const recompiled = await TOOL_HANDLERS.loopforge_next(mgr, {
        submissionHandle: started.submissionHandle,
        currentUserInstruction: "A new host direction",
      });
      assert.equal(recompiled.error, undefined);
      assert.equal(recompiled.round, 1);
      assert.equal(recompiled.level, "l2");
      assert.equal(recompiled.contextMode, "fresh_invocation");
      assert.equal(recompiled.contextReason, "first_round");
      assert.match(String(recompiled.prompt), /A new host direction/);
      assert.notDeepEqual(
        recompiled.submissionHandle,
        started.submissionHandle,
        "a new prompt hash yields a new handle",
      );
      assert.equal(provider.reset(), captures, "no evidence capture");
      const held = mgr.get(sessionId)!.roundSnapshot!;
      assert.equal(held.attempt, 1);
      assert.deepEqual(held.beforeEvidence, baseline);
      assert.equal(held.promptArtifact?.currentUserInstruction,
        "A new host direction");
      assert.equal(mgr.get(sessionId)!.task, beforeTask);
      assert.deepEqual(mgr.get(sessionId)!.operatorAcceptance, beforeAcceptance);
      assert.equal(store.listEntries(loopId).filter(
        (entry) => entry.task_type === "feedback").length, 0,
      "instruction recompile writes no Vault round");

      // Same instruction is idempotent.
      const repeated = await TOOL_HANDLERS.loopforge_next(mgr, {
        submissionHandle: recompiled.submissionHandle,
        currentUserInstruction: "A new host direction",
      });
      assert.deepEqual(repeated.submissionHandle, recompiled.submissionHandle);
      assert.equal(repeated.prompt, recompiled.prompt);

      // A different instruction recompiles again with a new handle.
      const changed = await TOOL_HANDLERS.loopforge_next(mgr, {
        submissionHandle: recompiled.submissionHandle,
        currentUserInstruction: "A different direction",
      });
      assert.notDeepEqual(changed.submissionHandle, recompiled.submissionHandle);
      assert.match(String(changed.prompt), /A different direction/);

      // A stale handle has zero side effects.
      const entriesBefore = store.listEntries(loopId).length;
      const stale = await TOOL_HANDLERS.loopforge_next(mgr, {
        submissionHandle: started.submissionHandle,
        currentUserInstruction: "Should not apply",
      });
      assert.equal(stale.error, undefined);
      assert.equal(stale.prompt, changed.prompt,
        "the stale handle never applies its instruction");
      assert.ok(
        (stale.warnings as string[]).some((warning) =>
          warning.includes("does not match the current held attempt")),
        "the stale redelivery is labeled",
      );
      assert.equal(store.listEntries(loopId).length, entriesBefore);
    } finally {
      mgr.close();
    }
  });

  it("a failed held recompile stalls with the old snapshot and handle", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "instruction-recompile-failure";
    const mgr = new SessionManager(store);
    try {
      const started = await mgr.create({ task: "Recompile failure", loopId });
      const sessionId = started.sessionId;
      const session = mgr.get(sessionId)!;
      const beforeTransaction = session.roundSnapshot!.transactionId;
      const beforeHandle = mgr.getSubmissionHandle(sessionId)!;
      const captures = provider.reset();
      const original = session.engine.invokeLoopCompile;
      session.engine.invokeLoopCompile = () => {
        throw new CompileFailureError("injected recompile failure");
      };
      const result = await TOOL_HANDLERS.loopforge_next(mgr, {
        submissionHandle: beforeHandle,
        currentUserInstruction: "Does not compile",
      });
      session.engine.invokeLoopCompile = original;
      assert.equal(result.stopReason, "stalled");
      assert.equal(result.prompt, null);
      const after = mgr.get(sessionId)!;
      assert.equal(after.status, "stalled");
      assert.equal(after.roundSnapshot?.transactionId, beforeTransaction);
      assert.deepEqual(mgr.getSubmissionHandle(sessionId), beforeHandle);
      assert.equal(provider.reset(), captures, "no evidence is collected");
      assert.equal(store.listEntries(loopId).filter(
        (entry) => entry.task_type === "feedback").length, 0,
      "a failed recompile writes no Vault round");
    } finally {
      mgr.close();
    }
  });

  it("keeps the old snapshot and handle when the session save fails", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const inner = new VaultSessionStateStore(store);
    let failNext = false;
    const flaky: SessionStateStore = {
      load: (loopId) => inner.load(loopId),
      list: () => inner.list(),
      save: (entry: VaultEntry, opts) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected session save failure");
        }
        inner.save(entry, opts);
      },
      acquireLease: (loopId, ownerId, leaseMs, now) =>
        inner.acquireLease?.(loopId, ownerId, leaseMs, now),
      renewLease: (loopId, ownerId, leaseMs, now) =>
        inner.renewLease?.(loopId, ownerId, leaseMs, now),
      releaseLease: (loopId, ownerId) =>
        inner.releaseLease?.(loopId, ownerId),
    };
    const mgr = new SessionManager(store, flaky);
    try {
      const started = await mgr.create({
        task: "Save failure",
        loopId: "instruction-save-failure",
      });
      const sessionId = started.sessionId;
      const beforeHandle = mgr.getSubmissionHandle(sessionId)!;
      const beforeTransaction =
        mgr.get(sessionId)!.roundSnapshot!.transactionId;
      const captures = provider.reset();

      failNext = true;
      const result = await TOOL_HANDLERS.loopforge_next(mgr, {
        submissionHandle: beforeHandle,
        currentUserInstruction: "Will not persist",
      });
      assert.equal(result.stopReason, "stalled");
      assert.equal(result.prompt, null);
      const session = mgr.get(sessionId)!;
      assert.equal(session.status, "stalled");
      assert.equal(session.roundSnapshot?.transactionId, beforeTransaction,
        "the unpersisted prompt must not replace the held snapshot");
      assert.deepEqual(mgr.getSubmissionHandle(sessionId), beforeHandle,
        "no new handle is returned for a prompt that was never persisted");
      assert.equal(session.roundSnapshot?.promptArtifact?.currentUserInstruction,
        "Save failure", "the original round-1 instruction is still held");
      assert.equal(provider.reset(), captures);
    } finally {
      mgr.close();
    }
  });

  it("keeps an existing invocation recovery when a new instruction is added", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "next-instruction-cold";
    const mgr = new SessionManager(store);
    const restarted = new SessionManager(store);
    try {
      await rejectRoundTwo(mgr, loopId, "Cold instruction task");
      provider.reset();
      mgr.close();
      const resumed = await restarted.resume(loopId, { invocationLost: true });
      assert.equal(resumed?.contextReason, "invocation_recovery");
      const recompiled = await TOOL_HANDLERS.loopforge_next(restarted, {
        submissionHandle: resumed!.submissionHandle,
        currentUserInstruction: "Keep the cold context, add this",
      });
      assert.equal(recompiled.contextMode, "fresh_invocation");
      assert.equal(recompiled.contextReason, "invocation_recovery");
      assert.equal(recompiled.level, "l2");
      assert.match(String(recompiled.prompt), /Keep the cold context, add this/);
      assert.match(String(recompiled.prompt), /Working Memory \(Agent reports are claims\)/);
    } finally {
      mgr.close();
      restarted.close();
    }
  });
});

describe("v4.0.5 — instruction travels through submissions and resume", () => {
  it("accept carries it into the next round; reject inherits it into the retry", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "instruction-submit";
    const mgr = new SessionManager(store);
    try {
      const started = await mgr.create({ task: "Submission task", loopId });
      const accepted = await TOOL_HANDLERS.loopforge_next(mgr, {
        submissionHandle: started.submissionHandle,
        evaluation: continuingEvaluation(),
        currentUserInstruction: "Carry me to the next round",
      });
      assert.equal(accepted.error, undefined);
      assert.equal(accepted.round, 2);
      assert.match(String(accepted.prompt), /Carry me to the next round/);
      assert.equal(
        (accepted.submission_receipt as Record<string, unknown>)
          .prompt &&
          ((accepted.submission_receipt as Record<string, unknown>)
            .prompt as Record<string, unknown>).current_user_instruction,
        "Carry me to the next round",
        "the receipt projects the instruction from the next artifact",
      );
      const sessionId = started.sessionId;
      assert.equal(
        mgr.get(sessionId)!.roundSnapshot?.promptArtifact?.currentUserInstruction,
        "Carry me to the next round",
      );
      assert.equal(mgr.get(sessionId)!.task, "Submission task");

      const rejected = await TOOL_HANDLERS.loopforge_next(mgr, {
        submissionHandle: mgr.getSubmissionHandle(sessionId),
        evaluation: rejectedEvaluation(),
      });
      assert.equal(rejected.enforcementAction, "reject");
      assert.equal(rejected.level, "l0");
      assert.equal(
        mgr.get(sessionId)!.roundSnapshot?.promptArtifact?.currentUserInstruction,
        "Carry me to the next round",
        "a same-round retry inherits the submitted instruction",
      );
      assert.equal(mgr.get(sessionId)!.task, "Submission task");
    } finally {
      mgr.close();
    }
  });

  it("resume recompiles for a new instruction and is idempotent", async () => {
    const provider = countingProvider();
    const store = new MemoryLoopStore();
    const loopId = "resume-instruction";
    const mgr = new SessionManager(store);
    const restarted = new SessionManager(store);
    try {
      const { sessionId } = await rejectRoundTwo(
        mgr, loopId, "Resume instruction task",
      );
      const session = mgr.get(sessionId)!;
      const held = session.roundSnapshot!;
      const baseline = structuredClone(held.beforeEvidence);
      const attempt = held.attempt;
      const contextReason = held.promptArtifact!.contextReason;
      const captures = provider.reset();
      mgr.close();

      const first = await restarted.resume(loopId, {
        currentUserInstruction: "First resume direction",
      });
      assert.ok(first?.prompt);
      assert.equal(first!.contextMode, "same_round_retry");
      assert.equal(first!.contextReason, contextReason);
      const firstHeld = restarted.getByLoopId(loopId)!.roundSnapshot!;
      assert.equal(firstHeld.attempt, attempt);
      assert.deepEqual(firstHeld.beforeEvidence, baseline);
      assert.equal(firstHeld.promptArtifact?.currentUserInstruction,
        "First resume direction");
      assert.equal(provider.reset(), captures);

      const same = await restarted.resume(loopId, {
        currentUserInstruction: "First resume direction",
      });
      assert.deepEqual(same?.submissionHandle, first!.submissionHandle);
      assert.equal(same?.prompt, first!.prompt);

      const next = await restarted.resume(loopId, {
        currentUserInstruction: "Second resume direction",
      });
      assert.notDeepEqual(next?.submissionHandle, first!.submissionHandle);
      assert.match(next!.prompt!, /Second resume direction/);
      assert.equal(next?.contextReason, contextReason);
      assert.equal(restarted.getByLoopId(loopId)!.roundSnapshot?.attempt, attempt);
    } finally {
      mgr.close();
      restarted.close();
    }
  });
});

describe("v4.0.5 — read views and decoder", () => {
  it("projects the instruction from the committed artifact", async () => {
    const loopId = "read-view-instruction";
    const entry = committedFeedbackRound(1, {
      loopId,
      promptArtifact: {
        ...promptArtifact({
          roundId: `loop:${loopId}:round:1`,
          round: 1,
          renderedPrompt: "compiled",
        }),
        currentUserInstruction: "Committed host instruction",
      },
    });
    const store = new MemoryLoopStore();
    store.appendEntry(entry);
    const mgr = new SessionManager(store);
    try {
      const page = mgr.replayPageByLoop(loopId);
      assert.equal(
        (page.timeline[0] as Record<string, unknown>).current_user_instruction,
        "Committed host instruction",
      );
      const explanation = buildExplain(loopId, [entry]);
      assert.deepEqual(
        explanation.rounds[0].context,
        {
          mode: "fresh_invocation",
          reason: "next_round",
          userInstruction: "Committed host instruction",
        },
      );
    } finally {
      mgr.close();
    }
  });

  it("accepts the new reason and reports malformed instructions as legacy", async () => {
    const loopId = "decoder-instruction";
    const legal = committedFeedbackRound(1, {
      loopId,
      attempt: 2,
      promptArtifact: {
        ...promptArtifact({
          roundId: `loop:${loopId}:round:1`,
          round: 1,
          renderedPrompt: "cold",
          attempt: 2,
          level: "l2",
          contextMode: "fresh_invocation",
          contextReason: "invocation_recovery",
        }),
        currentUserInstruction: "allowed",
      },
    });
    const legalSnapshot = snapshotOf(legal as unknown as VaultEntryLike);
    assert.ok(parseRoundTransactionSnapshot(legalSnapshot));
    assert.deepEqual(legacyTransactionRounds([legal]), []);

    const illegalPair = committedFeedbackRound(1, {
      loopId,
      promptArtifact: {
        ...promptArtifact({
          roundId: `loop:${loopId}:round:1`,
          round: 1,
          renderedPrompt: "bad pair",
          level: "l2",
          contextMode: "fresh_invocation",
          contextReason: "invocation_recovery",
        }),
      },
    });
    assert.equal(parseRoundTransactionSnapshot(
      snapshotOf(illegalPair as unknown as VaultEntryLike)), null);
    assert.equal(legacyTransactionRounds([illegalPair])[0]?.envelope,
      "prompt_context");

    const malformed = committedFeedbackRound(1, {
      loopId,
      promptArtifact: {
        ...promptArtifact({
          roundId: `loop:${loopId}:round:1`,
          round: 1,
          renderedPrompt: "bad instruction",
        }),
        currentUserInstruction: "   ",
      },
    });
    assert.equal(parseRoundTransactionSnapshot(
      snapshotOf(malformed as unknown as VaultEntryLike)), null);
    assert.equal(legacyTransactionRounds([malformed])[0]?.envelope,
      "prompt_context");

    const nonString = committedFeedbackRound(1, {
      loopId,
      promptArtifact: {
        ...promptArtifact({
          roundId: `loop:${loopId}:round:1`,
          round: 1,
          renderedPrompt: "bad type",
        }),
        currentUserInstruction: 7,
      } as never,
    });
    assert.equal(parseRoundTransactionSnapshot(
      snapshotOf(nonString as unknown as VaultEntryLike)), null);

    // A 4.0.4 artifact without the optional field is still readable.
    const legacyFree = committedFeedbackRound(1, {
      loopId,
      promptArtifact: promptArtifact({
        roundId: `loop:${loopId}:round:1`,
        round: 1,
        renderedPrompt: "plain",
      }),
    });
    assert.ok(parseRoundTransactionSnapshot(
      snapshotOf(legacyFree as unknown as VaultEntryLike)));
  });
});

describe("v4.0.5 — rebindHeldPrompt keeps the retry identity", () => {
  const loopId = "rebind-identity";
  const roundId = `loop:${loopId}:round:2`;
  const branchId = `loop:${loopId}:branch:root`;

  function heldSnapshot(): RoundTransactionSnapshot {
    const posture = fixtureEvidencePosture(2);
    return {
      schemaVersion: 8,
      branchId,
      transactionId: "tx-old",
      kind: "evaluation",
      roundId,
      loopId,
      round: 2,
      attempt: 2,
      phase: "prompted",
      beforeEvidence: [],
      operatorAcceptance: {
        task: "Task",
        success_criteria: ["done"],
        hard_constraints: [],
      },
      compiled: {
        task: "Task",
        goalId: "goal",
        constraintsActive: [],
        constraintsRetired: [],
      },
      retryContext: {
        attempt: 2,
        rejectedAttempt: 1,
        rejectionNotice: "fix it",
        verificationFlags: [],
        evidencePosture: posture,
        rejectedAt: 1,
      },
      beforeCheckpoint: {
        checkpointId: `ck-${"a".repeat(24)}`,
        contentHash: "b".repeat(64),
        role: "before",
        round: 2,
        roundId,
        transactionId: "tx-old",
        branchId,
        redoRound: 2,
        createdAt: 1,
      },
      checkpoints: [{
        checkpointId: `ck-${"c".repeat(24)}`,
        contentHash: "d".repeat(64),
        role: "mid",
        round: 2,
        roundId,
        transactionId: "tx-old",
        branchId,
        redoRound: 2,
        createdAt: 2,
      }],
      restore: {
        directiveTransactionId: branchId,
        redoRound: 2,
        verifiedAt: 3,
      },
      createdAt: 1,
      updatedAt: 1,
      promptArtifact: promptArtifact({
        roundId,
        round: 2,
        attempt: 2,
        renderedPrompt: "old retry",
        level: "l0",
        contextMode: "same_round_retry",
        contextReason: "enforcement_retry",
      }),
    };
  }

  it("rebinds only the prompt-derived identity and clears the attempt result", () => {
    const held = heldSnapshot();
    const artifact = {
      ...promptArtifact({
        roundId,
        round: 2,
        attempt: 2,
        renderedPrompt: "cold retry",
        level: "l2",
        contextMode: "fresh_invocation",
        contextReason: "invocation_recovery",
      }),
      promptHash: "new-hash",
    };
    const next = rebindHeldPrompt(held, artifact, held.compiled, held.operatorAcceptance);
    assert.equal(next.transactionId, deriveTransactionId({
      kind: "evaluation",
      branchId,
      roundId,
      attempt: 2,
      promptHash: "new-hash",
    }));
    assert.notEqual(next.transactionId, held.transactionId);
    assert.equal(next.round, 2);
    assert.equal(next.attempt, 2);
    assert.equal(next.branchId, branchId);
    assert.equal(next.createdAt, 1);
    assert.equal(next.beforeEvidence, held.beforeEvidence,
      "the before-evidence array is reused, not recaptured");
    assert.deepEqual(next.retryContext, held.retryContext);
    assert.deepEqual(next.restore, held.restore);
    assert.deepEqual(next.beforeCheckpoint, {
      ...held.beforeCheckpoint,
      transactionId: next.transactionId,
    });
    assert.deepEqual(next.checkpoints, held.checkpoints!.map((item) => ({
      ...item,
      transactionId: next.transactionId,
    })));
    assert.equal(next.phase, "prompted");
    assert.equal(next.promptArtifact, artifact);
    assert.equal(next.afterEvidence, undefined);
    assert.equal(next.evaluation, undefined);
    assert.equal(next.result, undefined);
    assert.equal(next.normalizationDiagnostics, undefined);
    assert.equal(next.submittedFields, undefined);
  });

  it("refuses a changed identity or a context-boundary drift", () => {
    const held = heldSnapshot();
    assert.throws(() => rebindHeldPrompt(held, {
      ...held.promptArtifact!,
      attempt: 3,
    }));
    assert.throws(() => rebindHeldPrompt(held, {
      ...held.promptArtifact!,
      contextMode: "fresh_invocation",
      contextReason: "next_round",
    }));
    assert.throws(() => rebindHeldPrompt(held, {
      ...held.promptArtifact!,
      contextMode: "same_round_retry",
      contextReason: "invocation_recovery",
    }));
  });
});
