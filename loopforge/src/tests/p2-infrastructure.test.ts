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
} from "../evidence-provider.js";
import type { MachineObservation } from "../protocol.js";
import {
  getPolicyMetrics,
  PolicyMetricsCollector,
  resetPolicyMetrics,
} from "../policy-metrics.js";
import type { RoundProcessResult } from "../round-coordinator.js";
import {
  logEvent,
} from "../observability.js";
import {
  SessionLeaseConflictError,
  VaultRoundCommitStore,
  VaultSessionStateStore,
} from "../storage.js";
import type { SessionStateStore } from "../storage.js";
import type { VaultEntry } from "../loop-store.js";
import { LOOP_STORE_SCHEMA_VERSION } from "../loop-store.js";
import { SessionManager } from "../mcp/session.js";
import { MemoryLoopStore } from "./_helpers.js";

function snapshot(provider: string): MachineObservation {
  return {
    schemaVersion: 1,
    providerId: provider,
    kind: "custom",
    phase: "after",
    startedAt: 0,
    finishedAt: 0,
    status: "observed",
    files: [`${provider}.txt`],
    data: { ok: true },
  };
}

afterEach(() => {
  unregisterEvidenceProvider("async-test");
  resetPolicyMetrics();
});

describe("P2 async evidence", () => {
  it("collects async providers and isolates failures", async () => {
    const providers: EvidenceProvider[] = [
      { name: "sync", kind: "custom", capture: () => snapshot("sync") },
      {
        name: "async",
        kind: "custom",
        capture: async () => {
          await Promise.resolve();
          return snapshot("async");
        },
      },
      { name: "broken", kind: "custom", capture: async () => { throw new Error("boom"); } },
    ];
    const result = await new EvidenceCollector(providers).collectAsync({
      timeoutMs: 100,
      loopId: "evidence-isolation",
    });

    // v3.8: a throwing provider now yields an explicit `error` observation —
    // the gap is recorded, never filtered away.
    assert.deepEqual(result.map((item) => item.providerId), ["sync", "async", "broken"]);
    assert.equal(result[2].status, "error");
    const metrics = getPolicyMetrics("evidence-isolation");
    assert.equal(metrics.evidenceAvailable, 2);
    assert.equal(metrics.evidenceFailures, 1);
  });

  it("times out one provider without delaying the others", async () => {
    let signal: AbortSignal | undefined;
    const hanging: EvidenceProvider = {
      name: "hanging",
      kind: "custom",
      capture: (context?: EvidenceCaptureContext) => {
        signal = context?.signal;
        return new Promise<MachineObservation | null>(() => undefined);
      },
    };
    const started = Date.now();
    const result = await new EvidenceCollector([
      hanging,
      { name: "ready", kind: "custom", capture: () => snapshot("ready") },
    ]).collectAsync({ timeoutMs: 20, loopId: "evidence-timeout" });

    // v3.8: the timed-out provider yields an explicit `timeout` observation.
    assert.deepEqual(result.map((item) => item.providerId), ["hanging", "ready"]);
    assert.equal(result[0].status, "timeout");
    assert.equal(signal?.aborted, true);
    assert.ok(Date.now() - started < 500);
    assert.equal(getPolicyMetrics("evidence-timeout").evidenceTimeouts, 1);
  });

  it("resolves custom providers named by policy", async () => {
    registerEvidenceProvider("async-test", () => ({
      name: "async-test",
      kind: "custom",
      capture: async () => snapshot("async-test"),
    }));
    const result = await EvidenceCollector.fromProviderNames([
      "unknown",
      "async-test",
    ]).collectAsync({ timeoutMs: 100 });
    // v3.8: an unregistered name is NOT dropped. Configuring a provider claims
    // it observes something, so the gap itself must be a recorded fact —
    // otherwise "provider is configured but nothing was recorded" is silent.
    assert.deepEqual(result.map((item) => item.providerId), ["unknown", "async-test"]);
    assert.equal(result[0].status, "unavailable");
    assert.match(String((result[0].data as { detail?: string }).detail ?? ""), /not registered/);
    assert.equal(result[1].status, "observed");
  });
});

// v2.6: span tracing removed.

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
    const loopStore = new MemoryLoopStore();
    const store = new MemorySessionStore();
    const manager = new SessionManager(loopStore, store);
    const created = await manager.create({
      task: "verify custom session storage",
      loopId: "custom-session-store",
      maxRounds: 2,
    });

    assert.ok(created.sessionId);
    assert.ok(store.load("custom-session-store"));
    assert.equal(
      loopStore.entries.some((entry) => entry.task_type === "session_state"),
      false,
    );
    const restarted = new SessionManager(loopStore, store);
    assert.equal(restarted.autoResumeAll(), 1);
  });

  it("provides vault adapters for session and round commit lookups", () => {
    const store = new MemoryLoopStore();
    const sessions = new VaultSessionStateStore(store);
    sessions.save({
      task_id: "loop:adapter:session",
      task_type: "session_state",
      loop_id: "adapter",
      loop_lineage: { status: "running" },
    });
    store.appendEntry({
      task_id: "loop:adapter:r1:feedback",
      task_type: "feedback",
      loop_id: "adapter",
    });

    assert.equal(sessions.load("adapter")?.loop_id, "adapter");
    assert.equal(sessions.list().length, 1);
    assert.equal(new VaultRoundCommitStore(store).find("adapter", 1).length, 1);
  });

  it("derives bare loop IDs from typed round documents", () => {
    const store = new MemoryLoopStore();
    store.rounds.set("adapter:1", {
      schemaVersion: LOOP_STORE_SCHEMA_VERSION,
      loopId: "adapter",
      round: 1,
      updatedAt: "",
      events: [],
    });
    store.rounds.set("adapter:10", {
      schemaVersion: LOOP_STORE_SCHEMA_VERSION,
      loopId: "adapter",
      round: 10,
      updatedAt: "",
      events: [],
    });
    assert.deepEqual(store.listLoopIds(), ["adapter"]);
  });
});

describe("P3 cross-process leases", () => {
  it("atomically fences a second session owner until expiry", () => {
    const loopStore = new MemoryLoopStore();
    const store = new VaultSessionStateStore(loopStore);
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
    const loopStore = new MemoryLoopStore();
    const first = new SessionManager(loopStore);
    await first.create({ task: "lease ownership", loopId: "lease-manager" });
    const second = new SessionManager(loopStore);
    assert.equal(second.autoResumeAll(), 0);
    first.close();
    assert.equal(second.autoResumeAll(), 1);
    second.close();
  });

  // v2.6: checkpoint bridge (interop.ts) removed.
});
