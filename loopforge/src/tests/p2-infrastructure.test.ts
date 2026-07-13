import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EvidenceCollector,
  registerEvidenceProvider,
  unregisterEvidenceProvider,
} from "../evidence-provider.js";
import type {
  EvidenceCaptureContext,
  EvidenceProvider,
  ProviderSnapshot,
} from "../evidence-provider.js";
import {
  getPolicyMetrics,
  PolicyMetricsCollector,
  resetPolicyMetrics,
} from "../policy-metrics.js";
import type { RoundProcessResult } from "../round-coordinator.js";
import {
  logEvent,
  setTraceSink,
  startSpan,
} from "../observability.js";
import type { TraceRecord, TraceSink } from "../observability.js";
import {
  SessionLeaseConflictError,
  VaultRoundCommitStore,
  VaultSessionStateStore,
} from "../storage.js";
import type { SessionStateStore } from "../storage.js";
import type { VaultEntry } from "../backends/interface.js";
import { SessionManager } from "../mcp/session.js";
import { MemoryBackend } from "./_helpers.js";

function snapshot(provider: string): ProviderSnapshot {
  return {
    provider,
    timestamp: Date.now(),
    files: [`${provider}.txt`],
    data: { ok: true },
  };
}

afterEach(() => {
  unregisterEvidenceProvider("async-test");
  setTraceSink(null);
  resetPolicyMetrics();
});

describe("P2 async evidence", () => {
  it("collects async providers and isolates failures", async () => {
    const providers: EvidenceProvider[] = [
      { name: "sync", capture: () => snapshot("sync") },
      {
        name: "async",
        capture: async () => {
          await Promise.resolve();
          return snapshot("async");
        },
      },
      { name: "broken", capture: async () => { throw new Error("boom"); } },
    ];
    const result = await new EvidenceCollector(providers).collectAsync({
      timeoutMs: 100,
      loopId: "evidence-isolation",
    });

    assert.deepEqual(result.map((item) => item.provider), ["sync", "async"]);
    const metrics = getPolicyMetrics("evidence-isolation");
    assert.equal(metrics.evidenceAvailable, 2);
    assert.equal(metrics.evidenceFailures, 1);
  });

  it("times out one provider without delaying the others", async () => {
    let signal: AbortSignal | undefined;
    const hanging: EvidenceProvider = {
      name: "hanging",
      capture: (context?: EvidenceCaptureContext) => {
        signal = context?.signal;
        return new Promise<ProviderSnapshot | null>(() => undefined);
      },
    };
    const started = Date.now();
    const result = await new EvidenceCollector([
      hanging,
      { name: "ready", capture: () => snapshot("ready") },
    ]).collectAsync({ timeoutMs: 20, loopId: "evidence-timeout" });

    assert.deepEqual(result.map((item) => item.provider), ["ready"]);
    assert.equal(signal?.aborted, true);
    assert.ok(Date.now() - started < 500);
    assert.equal(getPolicyMetrics("evidence-timeout").evidenceTimeouts, 1);
  });

  it("resolves custom providers named by policy", async () => {
    registerEvidenceProvider("async-test", () => ({
      name: "async-test",
      capture: async () => snapshot("async-test"),
    }));
    const result = await EvidenceCollector.fromProviderNames([
      "unknown",
      "async-test",
    ]).collectAsync({ timeoutMs: 100 });
    assert.equal(result[0]?.provider, "async-test");
  });
});

describe("P2 tracing", () => {
  it("emits lifecycle events and idempotent span boundaries", () => {
    const records: TraceRecord[] = [];
    setTraceSink({ emit: (record) => { records.push(record); } });
    logEvent("custom.event", { value: 1 });
    const span = startSpan("custom.span", { phase: "test" });
    span.end("ok", { result: "done" });
    span.end("error");

    assert.equal(records.filter((record) => record.kind === "event").length, 1);
    assert.equal(records.filter((record) => record.kind === "span").length, 2);
    assert.equal(records[1]?.traceId, records[2]?.traceId);
  });

  it("never lets a failing sink affect callers", () => {
    const sink: TraceSink = { emit: () => { throw new Error("sink down"); } };
    setTraceSink(sink);
    assert.doesNotThrow(() => {
      logEvent("safe");
      startSpan("safe.span").end();
    });
  });
});

describe("P2 policy effectiveness metrics", () => {
  it("calculates success and rejection rates per strategy", () => {
    const metrics = new PolicyMetricsCollector();
    const accepted: RoundProcessResult = {
      action: "continue",
      verificationFlags: [],
      enforcementAction: "accept",
      roundSuccess: true,
      gateContradicted: false,
      newConsecutiveRejections: 0,
      shouldPushSuccessTrajectory: true,
    };
    const rejected: RoundProcessResult = {
      ...accepted,
      action: "reject",
      enforcementAction: "reject",
      roundSuccess: false,
      shouldPushSuccessTrajectory: false,
    };
    metrics.recordStrategyOutcome("strategy-loop", "l1", accepted);
    metrics.recordStrategyOutcome("strategy-loop", "l1", rejected);

    const effectiveness = metrics.snapshot("strategy-loop")
      .strategyEffectiveness.l1;
    assert.deepEqual(effectiveness, {
      attempts: 2,
      successes: 1,
      rejections: 1,
      successRate: 0.5,
    });
  });
});

class MemorySessionStore implements SessionStateStore {
  readonly entries = new Map<string, VaultEntry>();
  load(loopId: string): VaultEntry | undefined { return this.entries.get(loopId); }
  list(): VaultEntry[] { return [...this.entries.values()]; }
  save(entry: VaultEntry): void {
    this.entries.set(String(entry.loop_id), entry);
  }
}

describe("P2 pluggable storage", () => {
  it("uses an injected session store instead of vault session entries", async () => {
    const backend = new MemoryBackend();
    const store = new MemorySessionStore();
    const manager = new SessionManager(backend, store);
    const created = await manager.create({
      task: "verify custom session storage",
      loopId: "custom-session-store",
      maxRounds: 2,
    });

    assert.ok(created.sessionId);
    assert.ok(store.load("custom-session-store"));
    assert.equal(
      backend.entries.some((entry) => entry.task_type === "session_state"),
      false,
    );
    const restarted = new SessionManager(backend, store);
    assert.equal(restarted.autoResumeAll(), 1);
  });

  it("provides vault adapters for session and round commit lookups", () => {
    const backend = new MemoryBackend();
    const sessions = new VaultSessionStateStore(backend);
    sessions.save({
      task_id: "loop:adapter:session",
      task_type: "session_state",
      loop_id: "adapter",
      loop_lineage: { status: "running" },
    });
    backend.appendEntry({
      task_id: "loop:adapter:r1:feedback",
      task_type: "feedback",
      loop_id: "adapter",
    });

    assert.equal(sessions.load("adapter")?.loop_id, "adapter");
    assert.equal(sessions.list().length, 1);
    assert.equal(new VaultRoundCommitStore(backend).find("adapter", 1).length, 1);
  });
});

describe("P3 cross-process leases and checkpoint adapters", () => {
  it("atomically fences a second session owner until expiry", () => {
    const backend = new MemoryBackend();
    const store = new VaultSessionStateStore(backend);
    store.save({
      task_id: "loop:leased:session",
      task_type: "session_state",
      loop_id: "leased",
      loop_lineage: { status: "running" },
    });

    assert.equal(store.acquireLease("leased", "owner-a", 100, 1000)
      ?.loop_lineage?.lease_owner, "owner-a");
    assert.equal(store.acquireLease("leased", "owner-b", 100, 1050), undefined);
    assert.equal(store.renewLease("leased", "owner-b", 100, 1050), false);
    assert.throws(
      () => store.save({
        task_id: "loop:leased:session",
        task_type: "session_state",
        loop_id: "leased",
        loop_lineage: { status: "running", lease_owner: "owner-a" },
      }, { expectedLeaseOwner: "owner-b" }),
      SessionLeaseConflictError,
    );
    assert.equal(store.acquireLease("leased", "owner-b", 100, 1101)
      ?.loop_lineage?.lease_owner, "owner-b");
  });

  it("prevents two SessionManagers from auto-resuming the same loop", async () => {
    const backend = new MemoryBackend();
    const first = new SessionManager(backend);
    await first.create({ task: "lease ownership", loopId: "lease-manager" });
    const second = new SessionManager(backend);
    assert.equal(second.autoResumeAll(), 0);
    first.close();
    assert.equal(second.autoResumeAll(), 1);
    second.close();
  });

  it("emits portable cognitive checkpoints and isolates sink failures", async () => {
    const backend = new MemoryBackend();
    const manager = new SessionManager(backend);
    const checkpoints: Array<{ loopId: string; schemaVersion: number }> = [];
    manager.addCheckpointSink({
      save: (checkpoint) => { checkpoints.push(checkpoint); },
    });
    manager.addCheckpointSink({ save: () => { throw new Error("offline"); } });

    await manager.create({ task: "checkpoint bridge", loopId: "interop" });
    assert.equal(checkpoints.at(-1)?.loopId, "interop");
    assert.equal(checkpoints.at(-1)?.schemaVersion, 1);
    manager.close();
  });
});
