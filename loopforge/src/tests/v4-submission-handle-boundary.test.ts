import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../mcp/session.js";
import { TOOL_HANDLERS } from "../mcp/tools.js";
import { VaultSessionStateStore } from "../storage.js";
import type { SessionSaveOptions } from "../storage.js";
import type { VaultEntry } from "../loop-store.js";
import { makeSelfEvaluation } from "../protocol.js";
import type { GateActionDescriptor } from "../protocol.js";
import {
  DEFAULT_POLICY,
  resetPolicy,
  setPolicyForTest,
} from "../policy.js";
import {
  DEFAULT_SUCCESS_CRITERION,
  MemoryLoopStore,
  criterionClaims,
  installTestCommandProvider,
} from "./_helpers.js";

class CountingSessionStore extends VaultSessionStateStore {
  saves = 0;
  renews = 0;
  renewResult: boolean | undefined;

  override save(entry: VaultEntry, options?: SessionSaveOptions): void {
    this.saves += 1;
    super.save(entry, options);
  }

  override renewLease(
    loopId: string,
    ownerId: string,
    leaseMs: number,
    now?: number,
  ): boolean {
    this.renews += 1;
    if (this.renewResult === false) return false;
    return super.renewLease(loopId, ownerId, leaseMs, now);
  }
}

const partialEval = () => makeSelfEvaluation({
  success: false,
  output_summary: "partial",
  should_continue: true,
});

describe("v4.0.0 submission-handle boundary", () => {
  let store: MemoryLoopStore;
  let sessionStore: CountingSessionStore;
  let mgr: SessionManager;

  beforeEach(() => {
    resetPolicy();
    installTestCommandProvider();
    store = new MemoryLoopStore();
    sessionStore = new CountingSessionStore(store);
    mgr = new SessionManager(store, sessionStore);
  });

  afterEach(() => {
    mgr.close();
    resetPolicy();
  });

  it("a stale next returns the held prompt with zero durable effects", async () => {
    const started = await mgr.create({ task: "Stale next", loopId: "stale-next" });
    const sessionId = started.sessionId;
    const current = started.submissionHandle!;
    assert.ok(current);
    sessionStore.saves = 0;
    sessionStore.renews = 0;
    const entriesBefore = store.listEntries().length;

    const stale = await mgr.advance(
      { ...current, transactionId: "tx-stale-attempt" },
      "",
      partialEval(),
    );

    assert.equal(typeof stale.prompt, "string", "the held prompt is returned");
    assert.deepEqual(stale.submissionHandle, current);
    assert.ok(
      (stale.warnings ?? []).some((warning) => warning.includes("submissionHandle")),
      "the stale response is warned",
    );
    assert.equal(sessionStore.saves, 0, "no session save");
    assert.equal(sessionStore.renews, 0, "no lease renewal");
    assert.equal(store.listEntries().length, entriesBefore, "no vault entry");
    assert.equal(mgr.get(sessionId)?.currentRound, 1, "no round was consumed");
  });

  it("a stale checkpoint returns the mismatch without capturing or saving", async () => {
    const started = await mgr.create({ task: "Stale checkpoint", loopId: "stale-checkpoint" });
    const sessionId = started.sessionId;
    const current = started.submissionHandle!;
    sessionStore.saves = 0;
    sessionStore.renews = 0;
    const checkpointsBefore = mgr.get(sessionId)?.roundSnapshot?.checkpoints?.length ?? 0;

    const result = await mgr.checkpoint({
      ...current,
      roundId: "loop:stale-checkpoint:round:99",
    });

    assert.equal(result.error, "submission_handle_mismatch");
    assert.deepEqual(result.submissionHandle, current);
    assert.equal(
      mgr.get(sessionId)?.roundSnapshot?.checkpoints?.length ?? 0,
      checkpointsBefore,
      "no checkpoint ref is attached",
    );
    assert.equal(sessionStore.saves, 0);
    assert.equal(sessionStore.renews, 0);
  });

  it("a stale gate check writes no gate_opened record", async () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const started = await mgr.create({ task: "Stale gate", loopId: "stale-gate" });
    const current = started.submissionHandle!;
    const openedBefore = store.listEntries().filter((entry) =>
      entry.task_type === "gate_opened").length;
    const action: GateActionDescriptor = {
      description: "Deploy the release to production",
      scope: ["prod"],
      effects: ["production"],
      reversibility: "irreversible",
      authorization: "user_required",
    };

    const result = await mgr.checkGate(
      { ...current, transactionId: "tx-stale-gate" },
      action,
    );

    assert.equal(result.error, "submission_handle_mismatch");
    assert.deepEqual(result.submissionHandle, current);
    assert.equal(
      store.listEntries().filter((entry) => entry.task_type === "gate_opened").length,
      openedBefore,
      "a stale handle must not open a gate",
    );
  });

  it("a paused session cannot open a gate with its formerly held handle", async () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const started = await mgr.create({ task: "Paused gate", loopId: "paused-gate" });
    const handle = started.submissionHandle!;
    assert.equal(mgr.pause(started.sessionId).status, "paused");
    sessionStore.saves = 0;
    sessionStore.renews = 0;
    const openedBefore = store.listEntries().filter((entry) =>
      entry.task_type === "gate_opened").length;

    const result = await mgr.checkGate(handle, {
      description: "Deploy the release to production",
      scope: ["prod"],
      effects: ["production"],
      reversibility: "irreversible",
      authorization: "user_required",
    });

    assert.equal(result.error, "gate_invalid");
    assert.equal(sessionStore.saves, 0);
    assert.equal(sessionStore.renews, 0);
    assert.equal(
      store.listEntries().filter((entry) => entry.task_type === "gate_opened").length,
      openedBefore,
    );
  });

  it("a gate check whose process no longer owns the lease writes no gate", async () => {
    setPolicyForTest({ ...DEFAULT_POLICY, gate: { enabled: true } });
    const started = await mgr.create({ task: "Fenced gate", loopId: "fenced-gate" });
    const handle = started.submissionHandle!;
    sessionStore.renews = 0;
    sessionStore.renewResult = false;
    const openedBefore = store.listEntries().filter((entry) =>
      entry.task_type === "gate_opened").length;

    const result = await mgr.checkGate(handle, {
      description: "Deploy the release to production",
      scope: ["prod"],
      effects: ["production"],
      reversibility: "irreversible",
      authorization: "user_required",
    });

    assert.equal(result.error, "lease_conflict");
    assert.equal(sessionStore.renews, 1);
    assert.equal(
      store.listEntries().filter((entry) => entry.task_type === "gate_opened").length,
      openedBefore,
    );

    const readOnlyResult = await mgr.checkGate(handle, {
      description: "Format a local source file",
      scope: ["src/example.ts"],
      effects: ["workspace_write"],
      reversibility: "reversible",
      authorization: "agent_allowed",
    });
    assert.equal(readOnlyResult.error, "lease_conflict");
    assert.equal(sessionStore.renews, 2);
  });

  it("returns no top-level round/transaction anchors and persists no handle", async () => {
    const started = await mgr.create({ task: "Shape", loopId: "handle-shape" });
    const sessionId = started.sessionId;
    const handle = started.submissionHandle!;
    assert.ok("submissionHandle" in started);
    assert.ok(!("roundId" in started));
    assert.ok(!("transactionId" in started));
    assert.ok(!String(started.prompt ?? "").includes(handle.transactionId),
      "the prompt must not embed the handle value");

    const status = await TOOL_HANDLERS.loopforge_status(mgr, { sessionId });
    assert.ok("submissionHandle" in status);
    assert.ok(!("roundId" in status));
    assert.ok(!("transactionId" in status));
    assert.ok(status.submissionHandle);

    const guidance = mgr.getSubmissionGuidance(sessionId)!;
    assert.ok(!("round_id" in guidance));

    // The prompt text mentions the field by name; the test is about a persisted
    // KEY, which would be a second source of the anchor.
    const persisted = JSON.stringify(store.readSession("handle-shape"));
    assert.ok(!persisted.includes('"submissionHandle"'),
      "the handle is a transport projection, not persisted state");
  });

  it("status by loopId re-anchors a lost handle with zero durable effects", async () => {
    const started = await mgr.create({
      task: "Status re-anchor",
      loopId: "status-reanchor",
    });
    const lost = started.submissionHandle!;
    sessionStore.saves = 0;
    sessionStore.renews = 0;
    const entriesBefore = store.listEntries().length;

    const status = await TOOL_HANDLERS.loopforge_status(mgr, {
      loopId: "status-reanchor",
    });

    assert.equal(status.error, undefined);
    assert.deepEqual(status.submissionHandle, lost);
    assert.ok(status.submission_guidance, "status exposes current guidance");
    assert.ok(!("prompt" in status), "status never returns the held prompt");
    assert.equal(sessionStore.saves, 0, "no session save");
    assert.equal(sessionStore.renews, 0, "no lease renewal");
    assert.equal(store.listEntries().length, entriesBefore, "no vault entry");
    assert.equal(mgr.get(started.sessionId)?.currentRound, 1, "no round advance");

    const advanced = await mgr.advance(status.submissionHandle, "", partialEval());
    assert.equal(advanced.round, 2, "the re-anchored handle submits normally");
    assert.ok(advanced.submissionHandle);
  });

  it("a rejection rotates the handle; the old handle only returns the retry prompt", async () => {
    const started = await mgr.create({ task: "Rejection rotation", loopId: "handle-reject" });
    const current = started.submissionHandle!;
    const rejected = await mgr.advance(current, "", {
      success: true,
      output_summary: "Claimed success while admitting a violation.",
      constraint_violations: ["Do not break the public API"],
      should_continue: true,
      execution_report: {
        files_changed: [],
        tests_reported: { passed: 0, failed: 0, skipped: 0 },
        criterion_claims: criterionClaims([], [DEFAULT_SUCCESS_CRITERION]),
      },
    });

    assert.equal(rejected.enforcementAction, "reject");
    const next = rejected.submissionHandle!;
    assert.equal(next.roundId, current.roundId, "the logical round is unchanged");
    assert.notEqual(next.transactionId, current.transactionId, "the attempt is rebound");

    sessionStore.saves = 0;
    sessionStore.renews = 0;
    const stale = await mgr.advance(current, "", partialEval());
    assert.equal(typeof stale.prompt, "string");
    assert.deepEqual(stale.submissionHandle, next);
    assert.ok(
      (stale.warnings ?? []).some((warning) => warning.includes("submissionHandle")),
    );
    assert.equal(sessionStore.saves, 0);
    assert.equal(sessionStore.renews, 0);
  });
});
