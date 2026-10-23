/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 *
 * Since v2.14 the round state machine lives in RoundLifecycle
 * (round-lifecycle.ts). SessionManager owns "who may touch a session":
 * the in-memory registry, per-session serialization queue, and cross-process
 * lease fencing. RoundLifecycle owns "what happens to a session": crash
 * recovery, transaction execution, disposition result building, and the
 * advance pipeline. All round processing still goes through the
 * SessionManager → RoundDriver → RoundCoordinator path.
 */

import { randomUUID } from "node:crypto";
import { LoopForgeEngine } from "../engine.js";
import {
  canonicalizeGateAction,
  deriveGate,
  preflightStructuredGate,
  type StructuredGateVerdict,
} from "../cognitive-governance.js";
import { makeGateDecision, makeLoopObjective } from "../protocol.js";
import type { GateActionDescriptor } from "../protocol.js";
import type {
  LoopForgeResponse,
  LoopTerminalSink,
  SubmissionGuidance,
  SubmissionReceipt,
} from "../protocol.js";
import { NO_IN_FLIGHT_ROUND, deriveRoundFacts } from "../round-facts.js";
import { listVerifiedClaims } from "../evidence-claims.js";
import { buildAudit } from "../audit.js";
import { buildExplain } from "../explain.js";
import { CHECK_CONTRACT_ITEMS_UNVERIFIED } from "../verification-gate.js";
import { readOnlyRollbacks, readOnlyRounds } from "../committed-round.js";
import { deriveCommittedSubmissionView } from "../submission-receipt.js";
import type { ActiveContractView } from "../round-contract.js";
import { getPolicy, validateLoopId } from "../policy.js";
import { isRecord, unique } from "../token-utils.js";
import { ReplayBackend } from "../replay.js";
import { FileLoopStore, queryLoopEntries } from "../loop-store.js";
import type { LoopStore, VaultEntry } from "../loop-store.js";
import {
  makeRoundId,
  MAX_MID_CHECKPOINTS_PER_TRANSACTION,
  prepareRoundTransaction,
} from "../round-transaction.js";
import { findCheckpointRef } from "../recovery.js";
import { pendingRollbackDirective } from "../committed-round.js";
import {
  buildCheckpointRef,
  CheckpointError,
  FileWorkspaceCheckpointStore,
} from "../workspace-checkpoint.js";
import { resolveStateDirectory } from "../policy.js";
import { resolve, sep } from "node:path";
import { RoundDriver } from "../round-driver.js";
import { logEvent } from "../observability.js";
import {
  policyMetrics,
  derivePolicyMetrics,
  mergePolicyMetrics,
} from "../policy-metrics.js";
import type { PolicyMetricsSnapshot } from "../policy-metrics.js";
import {
  SessionLeaseConflictError,
  VaultSessionStateStore,
} from "../storage.js";
import type { SessionStateStore } from "../storage.js";
import { StorageCorruptionError } from "../loop-store.js";
import {
  RoundLifecycle,
  buildLoopRequest,
  normalizeStartCriteria,
} from "./round-lifecycle.js";
import type {
  McpSession,
  McpSessionSummary,
  StartInput,
  AdvanceResult,
  SessionRegistry,
} from "./round-lifecycle.js";
import {
  activeContractOf,
  validateSubmission,
} from "./submission-boundary.js";

// Public type surface preserved from before the v2.14 decomposition.
export type {
  McpSession,
  McpSessionSummary,
  StartInput,
  AdvanceResult,
} from "./round-lifecycle.js";

// ── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager implements SessionRegistry {
  private sessions = new Map<string, McpSession>();
  /** Serializes state transitions for each session. */
  private sessionQueues = new Map<string, Promise<void>>();
  private readonly loopStore: LoopStore;
  private sessionStore: SessionStateStore | undefined;
  private readonly ownerId = `${process.pid}:${randomUUID()}`;
  private readonly leaseMs: number;
  private readonly leaseRenewIntervalMs: number;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lifecycle: RoundLifecycle;
  private readonly terminalSinks = new Set<LoopTerminalSink>();
  private readonly checkpointStoreFor:
    | ((loopId: string) => FileWorkspaceCheckpointStore | undefined)
    | undefined;

  constructor(
    store?: LoopStore,
    sessionStore?: SessionStateStore,
    checkpointStoreFor?: (loopId: string) => FileWorkspaceCheckpointStore | undefined,
  ) {
    this.loopStore = store ?? new FileLoopStore(getPolicy().backend.root_dir);
    this.sessionStore = sessionStore ?? new VaultSessionStateStore(this.loopStore);
    const stores = new Map<string, FileWorkspaceCheckpointStore>();
    const fileStore = this.loopStore instanceof FileLoopStore ? this.loopStore : undefined;
    this.checkpointStoreFor = checkpointStoreFor ?? (
      fileStore
        ? (loopId: string): FileWorkspaceCheckpointStore => {
            let storeForLoop = stores.get(loopId);
            if (!storeForLoop) {
              storeForLoop = new FileWorkspaceCheckpointStore(
                fileStore.loopDir(loopId),
                loopId,
              );
              stores.set(loopId, storeForLoop);
            }
            return storeForLoop;
          }
        : undefined
    );
    const mcpPolicy = getPolicy().mcp;
    this.leaseMs = Math.max(1, mcpPolicy.session_lease_ms);
    this.leaseRenewIntervalMs = Math.max(
      1,
      Math.min(mcpPolicy.session_lease_renew_interval_ms, this.leaseMs),
    );
    this.lifecycle = new RoundLifecycle({
      store: this.loopStore,
      sessionStore: this.sessionStore,
      registry: this,
      terminalSinks: this.terminalSinks,
      ownerId: this.ownerId,
      leaseMs: this.leaseMs,
      ...(this.checkpointStoreFor
        ? { checkpointStoreFor: this.checkpointStoreFor }
        : {}),
    });
    if (this.sessionStore?.renewLease) {
      this.leaseTimer = setInterval(
        () => this.renewOwnedLeases(),
        this.leaseRenewIntervalMs,
      );
      this.leaseTimer.unref?.();
    }
  }

  /** Stable process-local owner token used for cross-process session leases. */
  getOwnerId(): string {
    return this.ownerId;
  }

  addTerminalSink(sink: LoopTerminalSink): () => void {
    this.terminalSinks.add(sink);
    return () => this.terminalSinks.delete(sink);
  }

  /** Release owned sessions and stop lease maintenance. */
  close(): void {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    for (const session of this.sessions.values()) {
      this.sessionStore?.releaseLease?.(session.loopId, this.ownerId);
    }
  }

  // ── SessionRegistry (view for RoundLifecycle) ────────────────────────────

  values(): Iterable<McpSession> {
    return this.sessions.values();
  }

  /** Register (or replace) a session in the in-memory registry. */
  upsert(session: McpSession): void {
    this.sessions.set(session.sessionId, session);
  }

  // ── Lease helpers ────────────────────────────────────────────────────────

  private findSessionEntry(loopId: string): VaultEntry | undefined {
    return this.sessionStore?.load(loopId);
  }

  private claimSessionEntry(loopId: string): VaultEntry | undefined {
    if (this.sessionStore?.acquireLease) {
      return this.sessionStore.acquireLease(
        loopId,
        this.ownerId,
        this.leaseMs,
      );
    }
    return this.findSessionEntry(loopId);
  }

  private renewSessionLease(loopId: string): boolean {
    if (!this.sessionStore?.renewLease) return true;
    try {
      return this.sessionStore.renewLease(loopId, this.ownerId, this.leaseMs);
    } catch {
      return false;
    }
  }

  private renewOwnedLeases(): void {
    for (const session of this.sessions.values()) {
      if (session.status === "running") this.renewSessionLease(session.loopId);
    }
  }

  private leaseConflictResult(
    loopId: string,
    entry?: VaultEntry,
  ): AdvanceResult {
    const lineage = (entry?.loop_lineage ?? {}) as Record<string, unknown>;
    return {
      sessionId: "",
      round: typeof lineage.current_round === "number" ? lineage.current_round : 0,
      prompt: null,
      stopReason: `session_owned_elsewhere:${loopId}`,
      stopDetail: `Another process (PID ${entry?.loop_lineage ? (entry.loop_lineage as Record<string,unknown>).lease_owner ?? "unknown" : "unknown"}) holds the lease for loop "${loopId}". Wait for the lease to expire or stop the other process.`,
    };
  }

  private async withSessionQueue<T>(
    sessionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.sessionQueues.set(sessionId, tail);

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.sessionQueues.get(sessionId) === tail) {
        this.sessionQueues.delete(sessionId);
      }
    }
  }

  // ── Lifecycle entry points ───────────────────────────────────────────────

  async create(input: StartInput): Promise<AdvanceResult> {
    const sessionId = randomUUID();
    const loopId = input.loopId ?? randomUUID();

    // v2.14: same-process duplicate guard. Cross-process duplicates are
    // fenced by the lease (SessionLeaseConflictError on save); within one
    // process the lease owner is identical, so a second create for the
    // same loopId would silently overwrite the first session's persisted
    // state and leave two in-memory sessions pointing at one loop.
    const existing = [...this.sessions.values()].find((s) => s.loopId === loopId);
    if (existing) {
      return {
        sessionId: "",
        round: existing.currentRound,
        prompt: null,
        stopReason: `loop_already_running:${loopId}`,
        stopDetail: `A session for loop "${loopId}" already exists in this process (session ${existing.sessionId}). Inspect or resume it instead of starting a duplicate.`,
      };
    }
    // v3.2.1: pre-flight the cross-process lease BEFORE compiling — the
    // compile persists round-1 lineage and the state file into the loop's
    // vault, which would corrupt another process's live loop (round-1
    // lineage replaced, metadata overwritten). Mirrors the save-time check
    // (VaultSessionStateStore.save: a non-empty lease_owner that is not ours
    // conflicts), so observable behavior is unchanged — only the side
    // effects are avoided. The save below remains the atomic final gate.
    const persistedSession = this.sessionStore?.load(loopId);
    const persistedLineage = persistedSession?.loop_lineage;
    const persistedOwner =
      persistedLineage && typeof persistedLineage === "object" && !Array.isArray(persistedLineage)
        ? (persistedLineage as Record<string, unknown>).lease_owner
        : "";
    if (typeof persistedOwner === "string" && persistedOwner && persistedOwner !== this.ownerId) {
      throw new SessionLeaseConflictError(loopId);
    }

    // v3.9.4: normalize initial criteria before any runtime object is created.
    // A structural defect throws StartCriteriaError (mapped to
    // invalid_argument); empty/duplicate/over-cap entries produce warnings.
    const startCriteria = normalizeStartCriteria(input.criteria);

    const engine = new LoopForgeEngine(this.loopStore);
    const maxRounds = input.maxRounds ?? getPolicy().engine.max_rounds;

    // Populate extra fields for the first round
    const request = buildLoopRequest({
      sessionId, loopId, task: input.task, engine, currentRound: 1,
      maxRounds, status: "running", createdAt: Date.now(),
      consecutiveRejections: 0,
      lastRejectionCheck: "",
    });
    request.domain = input.domain ?? "";
    request.plan_source = input.planSource ?? null;
    request.constraints_from_plan = input.constraints ?? [];
    // The initial criteria are real objective criteria, not a second ledger.
    // Supplying the objective here means the first compile persists these
    // texts (and therefore their cr- ids) through the existing lineage.
    if (startCriteria.criteria.length > 0) {
      request.loop_objective = makeLoopObjective({
        objective: input.task,
        success_criteria: startCriteria.criteria,
        hard_constraints: unique(input.constraints ?? []),
        created_at_round: 1,
        loop_id: loopId,
      });
    }

    const operatorAcceptance = {
      task: input.task,
      success_criteria: startCriteria.criteria.length > 0
        ? [...startCriteria.criteria]
        : ["Task goal achieved with verifiable evidence"],
      hard_constraints: unique(input.constraints ?? []),
    };
    const prepared = await new RoundDriver(
      engine,
      this.loopStore,
      this.checkpointStoreFor?.(loopId),
    ).prepare(
      request,
      loopId,
      1,
      { operatorAcceptance },
    );
    const initialPrompt = prepared?.prompt ?? null;
    const initialLevel = prepared?.level ?? "l2";
    const evidenceBaseline = prepared?.evidenceBaseline ?? [];
    const session: McpSession = {
      sessionId, loopId, task: input.task, engine,
      currentRound: 1, maxRounds,
      status: "running", createdAt: Date.now(),
      // v1.13: Enforcement gate state
      consecutiveRejections: 0,
      lastRejectionCheck: "",
      operatorAcceptance,
      roundSnapshot: prepared?.snapshot ?? prepareRoundTransaction(loopId, 1, evidenceBaseline),
    };
    this.sessions.set(sessionId, session);
    policyMetrics.recordStrategy(loopId, initialLevel);

    // Persist to vault for cross-process recovery. The save is the atomic
    // lease gate — a TOCTOU window between the pre-flight check above and
    // this write can still lose the lease race to another process.
    try {
      this.lifecycle.save(session);
    } catch (error) {
      // v3.2.1: roll back the in-memory registration — a registered-but-
      // unsaved session would make every later create for this loopId
      // return loop_already_running until this process restarts.
      this.sessions.delete(sessionId);
      throw error;
    }

    logEvent("session_start", {
      sessionId,
      loopId,
      task: input.task.slice(0, 80),
      maxRounds,
    });

    const snapshot = session.roundSnapshot;
    return {
      sessionId,
      round: 1,
      roundId: snapshot?.roundId,
      ...(snapshot?.transactionId ? { transactionId: snapshot.transactionId } : {}),
      ...(snapshot?.beforeCheckpoint
        ? { checkpoints: [snapshot.beforeCheckpoint] }
        : {}),
      ...(snapshot?.beforeCheckpointError
        ? {
            beforeCheckpointError: {
              code: snapshot.beforeCheckpointError.code,
              detail: snapshot.beforeCheckpointError.detail,
            },
          }
        : {}),
      prompt: initialPrompt,
      level: initialLevel,
      roundSuccess: false,
      warnings: [...startCriteria.warnings, ...(prepared?.warnings ?? [])],
      submission_guidance: this.lifecycle.guidanceFor(session),
    };
  }

  /** v3.9.1: current-fact submission guidance for the session's held round.
   *  Read-only projection; null when the session is unknown. */
  getSubmissionGuidance(sessionId: string): SubmissionGuidance | null {
    const session = this.sessions.get(sessionId);
    return session ? this.lifecycle.guidanceFor(session) : null;
  }

  /** v3.9.1: the most recent committed round's receipt, rebuilt from the
   *  transaction + shared read model. Rejected/terminated attempts are not in
   *  history; their receipt exists only on their own response. */
  getLastSubmissionReceipt(sessionId: string): SubmissionReceipt | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const prefix = `loop:${session.loopId}:r`;
    const entries: VaultEntry[] = [
      ...queryLoopEntries(this.loopStore, session.loopId, { prefix }),
      ...queryLoopEntries(this.loopStore, session.loopId, {
        prefix,
        feedbackOnly: true,
      }),
    ];
    const views = readOnlyRounds(entries);
    const rollbacks = readOnlyRollbacks(entries);
    const latestRound = views[views.length - 1];
    const latestRollback = rollbacks[rollbacks.length - 1];
    if (latestRollback &&
        (!latestRound || latestRollback.round > latestRound.round)) {
      return deriveCommittedSubmissionView(latestRollback, views, rollbacks);
    }
    return latestRound
      ? deriveCommittedSubmissionView(latestRound, views, rollbacks)
      : null;
  }

  /** v3.9.6: the success trajectory is a projection of committed branch
   *  rounds, not a session counter. */
  getSuccessTrajectory(loopId: string): boolean[] {
    const prefix = `loop:${loopId}:`;
    const entries = [
      ...queryLoopEntries(this.loopStore, loopId, { prefix }),
      ...queryLoopEntries(this.loopStore, loopId, { prefix, feedbackOnly: true }),
    ];
    return readOnlyRounds(entries)
      .filter((view) => view.result?.shouldPushSuccessTrajectory === true)
      .map((view) => view.success);
  }

  get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId);
  }

  getLeaseStatus(loopId: string): Record<string, unknown> | null {
    const entry = this.findSessionEntry(loopId);
    if (!entry) return null;
    const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
    const owner = typeof lineage.lease_owner === "string"
      ? lineage.lease_owner
      : "";
    const ownerPid = owner.match(/^(\d+):/)?.[1];
    return {
      ownedByThisProcess: owner === this.ownerId,
      ownerPid: ownerPid ? Number(ownerPid) : null,
      expiresAt: typeof lineage.lease_expires_at === "number"
        ? new Date(lineage.lease_expires_at).toISOString()
        : null,
      epoch: typeof lineage.lease_epoch === "number"
        ? lineage.lease_epoch
        : 0,
    };
  }

  delete(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.status = "stopped";
    this.lifecycle.save(session);
    void this.lifecycle.notifyTerminal(session, "cancelled");
    this.sessions.delete(sessionId);
    this.sessionQueues.delete(sessionId);
    logEvent("session_end", {
      sessionId,
      loopId: session.loopId,
      stopReason: "cancelled",
      roundsCompleted: session.currentRound,
    });
    return true;
  }

  /** v1.18: Pause a running session. The session state is persisted to
   *  vault so it survives process restarts. Returns the session status.
   *  Paused sessions cannot be advanced — they must be resumed first. */
  pause(sessionId: string): { sessionId: string; round: number; status: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, round: 0, status: "not_found" };
    if (session.status !== "running") {
      return { sessionId, round: session.currentRound, status: session.status };
    }
    session.status = "paused";
    this.lifecycle.save(session);
    logEvent("session_paused", {
      sessionId,
      loopId: session.loopId,
      round: session.currentRound,
    });
    return { sessionId, round: session.currentRound, status: "paused" };
  }

  /** Persist session state to vault for cross-process recovery. Delegates to
   *  the round lifecycle, which owns the durable session document shape. */
  save(session: McpSession): void {
    this.lifecycle.save(session);
  }

  /** Resume a loop from vault state.
   *  Reconstructs the session and compiles the prompt for the next round
   *  (async — compilation collects evidence through RoundDriver.prepare).
   *  Returns null if no session_state entry exists for this loopId. */
  async resume(loopId: string): Promise<AdvanceResult | null> {
    const persistedEntry = this.findSessionEntry(loopId);
    if (!persistedEntry) return null;
    const persistedLineage = (persistedEntry.loop_lineage ?? {}) as Record<string, unknown>;
    const persistedStatus = (persistedLineage.status as string) ?? "running";
    // v3.9.7: stalled is a RESUMABLE recovery state. It is how a committed
    // directive with an unfinished restore survives a restart.
    const sessionEntry = persistedStatus === "running" || persistedStatus === "stalled"
      ? this.claimSessionEntry(loopId)
      : persistedEntry;
    if (!sessionEntry) return this.leaseConflictResult(loopId, persistedEntry);

    const session = this.lifecycle.reconstructSession(sessionEntry);
    if (!session) {
      // was not "running"/"stalled" — return stopped/paused status
      const lineage = (sessionEntry.loop_lineage ?? {}) as Record<string, unknown>;
      const currentRound = (lineage.current_round as number) ?? 1;
      const status = (lineage.status as string) ?? "stopped";
      return {
        sessionId: "",
        round: currentRound,
        prompt: null,
        stopReason: status,
        stopDetail: `Loop is not running (status: ${status}). It may have already completed or been stopped.`,
      };
    }

    // Resume is a recovery attempt: set running so the lease is renewed while
    // the (possibly long) restore executes. A failure saves stalled again.
    if (session.status === "stalled") session.status = "running";
    this.sessions.set(session.sessionId, session);

    return this.lifecycle.resume(session);
  }

  /** v1.18: Resume a paused session. Reconstructs from vault state and
   *  compiles the next prompt. Returns null if no paused session exists
   *  for this loopId. */
  async unpause(loopId: string): Promise<AdvanceResult | null> {
    const persistedEntry = this.findSessionEntry(loopId);
    if (!persistedEntry) return null;

    const lineage = (persistedEntry.loop_lineage ?? {}) as Record<string, unknown>;
    const status = (lineage.status as string) ?? "running";
    if (status !== "paused") return null;
    const sessionEntry = this.claimSessionEntry(loopId);
    if (!sessionEntry) return this.leaseConflictResult(loopId, persistedEntry);

    const session = this.lifecycle.reconstructSession(sessionEntry, true);
    if (!session) return null;

    // Set to running so advance() works
    session.status = "running";
    this.sessions.set(session.sessionId, session);

    return this.lifecycle.unpause(session);
  }

  /** Auto-resume all "running" sessions from vault on server startup.
   *  Scans vault for session_state entries, reconstructs each as an in-memory
   *  McpSession (without compiling — the next loopforge_next will do that).
   *  Returns the number of sessions resumed. */
  autoResumeAll(): number {
    if (!this.sessionStore) return 0;
    const entries = this.sessionStore.list();

    // Build set of already-active loopIds
    const activeLoopIds = new Set<string>();
    for (const s of this.sessions.values()) {
      activeLoopIds.add(s.loopId);
    }

    let count = 0;
    for (const entry of entries) {
      if (entry.task_type !== "session_state") continue;
      const lid = entry.loop_id;
      if (!lid || activeLoopIds.has(lid)) continue;
      const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
      const status = (lineage.status as string) ?? "running";
      if (status !== "running" && status !== "paused" && status !== "stalled") continue;
      const claimedEntry = this.claimSessionEntry(lid);
      if (!claimedEntry) continue;

      // v2.14: a bulk startup scan must not die on one corrupt loop —
      // recoverable gaps are recorded and skipped; corrupted storage
      // (invalid JSON/format/sequence) still surfaces to the caller.
      let session: McpSession | null = null;
      try {
        session = this.lifecycle.reconstructSession(claimedEntry, true);
      } catch (error) {
        if (error instanceof StorageCorruptionError && error.recoverable) {
          logEvent("session_skip_gap", { loopId: lid, error: error.message });
          continue;
        }
        throw error;
      }
      if (session) {
        this.sessions.set(session.sessionId, session);
        activeLoopIds.add(lid);
        count++;
      }
    }

    return count;
  }

  list(): McpSessionSummary[] {
    const seen = new Set<string>();
    const result: McpSessionSummary[] = [];

    // In-memory sessions first (take priority)
    for (const s of this.sessions.values()) {
      seen.add(s.loopId);
      result.push({
        sessionId: s.sessionId,
        loopId: s.loopId,
        round: s.currentRound,
        status: s.status,
      });
    }

    // Merge persisted sessions not already in memory
    if (this.sessionStore) {
      const entries = this.sessionStore.list();
      for (const e of entries) {
        if (e.task_type !== "session_state") continue;
        const lid = e.loop_id ?? "";
        if (!lid || seen.has(lid)) continue;
        seen.add(lid);
        const lineage = (e.loop_lineage ?? {}) as Record<string, unknown>;
        result.push({
          sessionId: "",
          loopId: lid,
          round: (lineage.current_round as number) ?? 1,
          status: ((lineage.status as string) || "running") as McpSession["status"],
        });
      }
    }

    return result;
  }

  // ── v2.12: User/Agent gates ────────────────────────────────────────────

  /** Persist a gate_opened record for a structured preflight. Only
   *  user_required actions are recorded — agent_allowed needs no human
   *  authorization and opens no record. */
  private recordOpenedGate(
    loopId: string,
    round: number,
    verdict: StructuredGateVerdict,
    canonicalAction: string,
  ): void {
    this.loopStore.appendEntry({
      id: randomUUID(),
      task_id: `loop:${loopId}:gate:${verdict.gateId}`,
      task_type: "gate_opened",
      loop_id: loopId,
      timestamp: new Date().toISOString(),
      gate_id: verdict.gateId,
      gate_action: canonicalAction,
      gate_kind: "user",
      gate_structured: true,
      loop_lineage: {
        round,
        gate_id: verdict.gateId,
        action_hash: verdict.actionHash,
      },
    });
  }

  /** v3.7.1: structured gate preflight. The agent submits a
   *  GateActionDescriptor; the runtime classifies it (conservative:
   *  anything not provably safe is user_required with reason codes). A
   *  user_required verdict persists a gate_opened record bound to
   *  loop + round + actionHash; agent_allowed records nothing and returns
   *  the evidence suggestion instead. No action is executed and no round
   *  advances from this call. */
  checkGate(
    sessionId: string,
    roundId: string,
    action: GateActionDescriptor,
  ): Record<string, unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        error: "session_not_found",
        errorMessage: `session not found: ${sessionId}`,
        sessionId,
      };
    }
    const expectedRoundId = session.roundSnapshot?.roundId
      ?? makeRoundId(session.loopId, session.currentRound);
    if (expectedRoundId !== roundId) {
      return {
        error: "round_id_mismatch",
        errorMessage: "roundId does not match the current round — re-run loopforge_gate_check " +
          "with the roundId from the latest response",
        sessionId,
        roundId,
      };
    }
    const verdict = preflightStructuredGate(action);
    if (verdict.kind === "user") {
      this.recordOpenedGate(session.loopId, session.currentRound, verdict,
        canonicalizeGateAction(action));
    }
    return {
      sessionId,
      gateId: verdict.gateId,
      risk: verdict.risk,
      decision: verdict.decision,
      reasonCodes: verdict.reasonCodes,
      ...(verdict.kind === "user"
        ? {
            blockedScope: verdict.blockedScope,
            allowedBeforeApproval: verdict.allowedBeforeApproval,
            requiredEvidence: [],
            approvalQuestion: verdict.approvalQuestion,
          }
        : {
            blockedScope: [],
            allowedBeforeApproval: [],
            requiredEvidence: verdict.requiredEvidence,
          }),
    };
  }

  /** Record a user decision for a recorded gate. The gateId embeds the
   *  canonicalized action hash — if the action changed, the match fails and
   *  the old approval expires automatically. */
  resolveGate(
    sessionId: string,
    gateId: string,
    approved: boolean,
    note?: string,
  ): Record<string, unknown> {
    const session = this.sessions.get(sessionId);
    let loopId = session?.loopId;
    let currentRound = session?.currentRound ?? 0;
    let temporaryLease = false;

    // A gate is durable independently of the process that opened it. On a
    // cold process, locate the owning session by its persisted session_id and
    // claim a short lease for the decision write; no in-memory reconstruction
    // is needed for this read/append operation.
    let persistedEntry: VaultEntry | undefined;
    if (!session) {
      persistedEntry = this.sessionStore?.list().find((entry) => {
        if (entry.task_type !== "session_state") return false;
        const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : {};
        return lineage.session_id === sessionId;
      });
      loopId = persistedEntry?.loop_id;
      if (!loopId) {
        return {
          error: "session_not_found",
          errorMessage: `session not found: ${sessionId}`,
          sessionId,
        };
      }
      const claimed = this.claimSessionEntry(loopId);
      if (!claimed) {
        return { ...this.leaseConflictResult(loopId, persistedEntry) };
      }
      temporaryLease = true;
      const lineage = isRecord(claimed.loop_lineage) ? claimed.loop_lineage : {};
      currentRound = typeof lineage.current_round === "number"
        ? lineage.current_round
        : 0;
    }

    if (!loopId) {
      return {
        error: "session_not_found",
        errorMessage: `session not found: ${sessionId}`,
        sessionId,
      };
    }
    try {
      const prefix = `loop:${loopId}:gate:`;
      const opened = queryLoopEntries(this.loopStore, loopId, { prefix })
        .find((entry) => entry.task_type === "gate_opened" && entry.gate_id === gateId);
      if (!opened) {
        return {
          error: "state_unavailable",
          errorMessage: `no gate_opened record for gate ${gateId} — the gate may have ` +
            "expired or was never recorded",
        };
      }
      const actionText = typeof opened.gate_action === "string" ? opened.gate_action : "";
      const openedLineage = isRecord(opened.loop_lineage) ? opened.loop_lineage : {};
      const gateRound = typeof openedLineage.round === "number"
        ? openedLineage.round
        : currentRound;
      // v3.7.1: structured records re-derive their id through the structured
      // classifier over the stored canonical action; flat records (blocked-
      // round auto-records) keep the flat classifier. Either way the id
      // embeds the action — a changed action no longer matches and the old
      // approval expires.
      let matchedId: string;
      let userKind: boolean;
      let userScope: string[] = [];
      let actionHash: string | undefined = typeof openedLineage.action_hash === "string"
        ? openedLineage.action_hash
        : undefined;
      if (opened.gate_structured === true) {
        let descriptor: GateActionDescriptor;
        try {
          descriptor = JSON.parse(actionText) as GateActionDescriptor;
        } catch {
          return {
            error: "state_unavailable",
            errorMessage: `gate ${gateId} has a corrupted structured action — ` +
              "re-run loopforge_gate_check",
          };
        }
        const verdict = preflightStructuredGate(descriptor);
        matchedId = verdict.gateId;
        userKind = verdict.kind === "user";
        userScope = verdict.blockedScope ?? [];
        actionHash = actionHash ?? verdict.actionHash;
      } else {
        const derived = deriveGate(actionText);
        matchedId = derived.id;
        userKind = derived.gate.kind === "user";
        userScope = derived.gate.blockedScope ?? [];
      }
      if (matchedId !== gateId) {
        return {
          error: "invalid_argument",
          errorMessage: "gateId does not match the recorded action — the action changed, " +
            "old approvals expire",
        };
      }
      if (!userKind) {
        return {
          error: "invalid_argument",
          errorMessage: "agent gates are resolved by submitting the required evidence, " +
            "not by user approval",
        };
      }
      const decision = makeGateDecision({
        gateId,
        kind: "user",
        approved: approved === true,
        scope: userScope,
        note: typeof note === "string" ? note : "",
        decidedAt: new Date().toISOString(),
        actionHash: actionHash ?? "",
      });
      const entry: VaultEntry = {
        id: randomUUID(),
        task_id: `loop:${loopId}:gate:${gateId}:decision`,
        task_type: "gate_decision",
        loop_id: loopId,
        timestamp: new Date().toISOString(),
        gate_id: gateId,
        approved: decision.approved,
        decision_note: decision.note,
        gate_decision: decision,
        loop_lineage: {
          round: gateRound,
          gate_id: gateId,
          action_hash: actionHash,
        },
      };
      this.loopStore.appendEntry(entry);
      return { sessionId, loopId, gateId, approved: decision.approved };
    } finally {
      if (temporaryLease) this.sessionStore?.releaseLease?.(loopId, this.ownerId);
    }
  }

  // ── v2.12: Typed projection + audit ────────────────────────────────────

  /** The compile context for this round.
   *
   *  v3.8.1: delegates to the SHARED implementation in round-lifecycle.ts —
   *  the runtime's submission boundary reads the same context (the sub-goal
   *  reference space is exactly the compiled set the prompt carried), and two
   *  copies would let the projection and the boundary disagree about it. */

  /** v3.8: Read-only per-round "why" view over committed facts. Never
   *  rebuilds history and never writes. */
  getExplain(loopId: string, round?: number): Record<string, unknown> {
    validateLoopId(loopId);
    const prefix = `loop:${loopId}:`;
    const entries = [
      ...queryLoopEntries(this.loopStore, loopId, { prefix }),
      ...queryLoopEntries(this.loopStore, loopId, { prefix, feedbackOnly: true }),
    ];
    return buildExplain(loopId, entries, round) as unknown as Record<string, unknown>;
  }

  /** Read-only end-of-loop audit (verification view). Never writes. */
  getAudit(loopId: string): Record<string, unknown> | null {
    validateLoopId(loopId);
    // v3.3.1: audit judges COMMITTED decisions, which live on :feedback
    // entries — but queryLoopEntries excludes feedback by default, so the
    // audit view structurally never saw a committed round (it always
    // reported "passed" on empty history). Merge both result sets like the
    // round coordinator does.
    const prefix = `loop:${loopId}:`;
    const entries = [
      ...queryLoopEntries(this.loopStore, loopId, { prefix }),
      ...queryLoopEntries(this.loopStore, loopId, { prefix, feedbackOnly: true }),
    ];
    // Zero committed decisions → nothing to audit. Returning null lets the
    // tools layer report "no audit data" instead of the external auditor
    // solemnly passing a loop that never ran (or a mistyped loopId).
    const hasCommittedDecision = readOnlyRounds(entries).length > 0;
    if (!hasCommittedDecision) return null;
    const audit = buildAudit(loopId, entries, this.loopStore);
    return { ...audit };
  }

  /** v3.5: The ACTIVE Round Contract governing the session's next round —
   *  derived from the committed :feedback evals (the SAME adapter + walker
   *  the verification gate uses; display-only, zero persistence). Null when
   *  nothing is active (whole-task round). */
  getActiveContract(sessionId: string): ActiveContractView | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // One derivation, shared with the submission boundary.
    return activeContractOf(this.loopStore, session);
  }

  /** v2.12: Policy metrics that survive restarts — vault-derived round
   *  statistics (A4 port) folded with this process's live observations.
   *  Non-durable fields (evidence, vault errors) come from live only. */
  getPolicyMetrics(loopId: string): PolicyMetricsSnapshot {
    // v3.3.1: derived metrics judge committed decisions on :feedback entries,
    // which queryLoopEntries excludes by default — merge both result sets so
    // restart-surviving metrics actually see the committed rounds (before,
    // derived.committedRounds was structurally 0 and the merge fell back to
    // the live-only snapshot every time).
    const prefix = `loop:${loopId}:`;
    const entries = [
      ...queryLoopEntries(this.loopStore, loopId, { prefix }),
      ...queryLoopEntries(this.loopStore, loopId, { prefix, feedbackOnly: true }),
    ];
    const derived = derivePolicyMetrics(loopId, entries);
    const live = policyMetrics.snapshot(loopId);
    if (derived.committedRounds === 0) return live;
    return mergePolicyMetrics(derived, live);
  }

  /** Get machine facts about a loop (in-memory or vault).
   *
   *  v3.8.1: this view used to report `goal_alignment`, `drift_detected`,
   *  `strategy_stability` and `task_continuity`. Every one was a
   *  text-similarity verdict rather than a fact, and two were degenerate in
   *  THIS method specifically: `task_continuity` was pinned to 1.0 because the
   *  request was built with `round: 1`, so `getPreviousRound(loopId, 0)`
   *  returned null and the code took its hardcoded `?? 1` branch; and
   *  `strategy_stability` was a literal `true`. What remains is counted
   *  directly from committed round flags. */
  getHealth(loopId: string): Record<string, unknown> | null {
    const engine = new LoopForgeEngine(this.loopStore);
    const context = engine.hydrateLoopContext(loopId);
    // No hydratable context at all → unknown loop. A started-but-uncommitted
    // loop DOES have a context (the compile persists a lineage entry), so it
    // still gets a view — with zeros — exactly as it did before.
    if (!context) return null;
    const entries = Array.isArray(context.results) ? context.results : [];
    const views = readOnlyRounds(entries);
    const roundsWithUnverifiedItems = views.filter((view) =>
      view.verificationFlags.some(
        (flag) => flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED,
      ),
    ).length;
    return {
      loopId,
      committed_rounds: views.length,
      rounds_with_unverified_items: roundsWithUnverifiedItems,
      // The policy value the enforcement gate escalates on. The streak itself
      // is derived in the gate — re-deriving it here would be a second
      // implementation of the same rule, which is what this release removes.
      unverified_streak_limit: getPolicy().engine.unverified_claim_streak_limit,
      policy_metrics: this.getPolicyMetrics(loopId),
    };
  }

  /** Core cycle: extract self-eval → record feedback → check stop → compile next.
   *  The lease + per-session queue wrap the RoundLifecycle state machine.
   *  @param preExtractedEval Structured SelfEvaluation supplied by the caller.
   *    An absent value is returned as evaluation_invalid without mutating state.
   *  @param roundId v3.0.1: The roundId of the round this submission reports on
   *    (from the last start/next/resume response). Anchors the submission so a
   *    stale or duplicate submission is not processed against a later round.
   *    Optional for library callers — when absent the anchor check is skipped. */
  /** \`submission\` is the RAW evaluation payload, not a built one.
   *
   *  v3.8.1: this method used to carry a partial copy of the submission
   *  boundary (an object check plus core-field validation) while the MCP tool
   *  handler carried the rest — one rule, three copies, across two layers.
   *  The boundary now lives entirely in the runtime
   *  (`RoundLifecycle.submissionBoundary`), so every caller — this manager, a
   *  library user, a future CLI command — gets the same strictness. */
  /** \`submission\` is the RAW evaluation payload, not a built one.
   *
   *  v3.8.1: this method used to carry a partial copy of the submission
   *  boundary (an object check plus core-field validation) while the MCP tool
   *  handler carried the rest — one rule, three copies, across two layers.
   *  The whole boundary now runs HERE, before the queue and before the lease
   *  heartbeat, so every caller of the public API gets it and a rejected
   *  payload leaves nothing durable behind. */
  async advance(
    sessionId: string,
    output: string,
    submission?: unknown,
    roundId?: string,
    transactionId?: string,
  ): Promise<AdvanceResult> {
    // Judged before the session is even resolved: a malformed evaluation is a
    // payload defect whatever the session's state. See submission-boundary.ts.
    const boundary = validateSubmission(
      this.loopStore,
      this.sessions.get(sessionId),
      submission,
    );
    if (!boundary.ok) {
      return {
        sessionId,
        round: this.sessions.get(sessionId)?.currentRound ?? 0,
        ...(roundId !== undefined ? { roundId } : {}),
        prompt: null,
        stopReason: boundary.submissionError.code,
        stopDetail: boundary.stopDetail,
        submissionError: boundary.submissionError,
      };
    }

    return this.withSessionQueue(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (
        session?.status === "running" &&
        !this.renewSessionLease(session.loopId)
      ) {
        return this.leaseConflictResult(
          session.loopId,
          this.findSessionEntry(session.loopId),
        );
      }
      try {
        return await this.lifecycle.advance(
          sessionId,
          output,
          boundary.evaluation,
          roundId,
          boundary.diagnostics,
          boundary.submittedFields,
          transactionId,
        );
      } catch (error) {
        if (error instanceof SessionLeaseConflictError) {
          return this.leaseConflictResult(error.loopId, this.findSessionEntry(error.loopId));
        }
        throw error;
      }
    });
  }

  /** v3.9.7: submit an Agent-initiated recovery. Shape validation happens
   *  before the session queue/lease; target referential validation happens in
   *  the lifecycle against committed facts. */
  async recover(
    sessionId: string,
    recovery: unknown,
    roundId?: string,
    transactionId?: string,
  ): Promise<AdvanceResult> {
    if (typeof roundId !== "string" || roundId.trim().length === 0) {
      return {
        sessionId,
        round: this.sessions.get(sessionId)?.currentRound ?? 0,
        prompt: null,
        submissionError: {
          code: "round_id_required" as const,
          details: { detail: "recovery requires the roundId from the held prompt" },
        },
      };
    }
    const invalid = (detail: string): AdvanceResult => ({
      sessionId,
      round: this.sessions.get(sessionId)?.currentRound ?? 0,
      prompt: null,
      submissionError: {
        code: "recovery_invalid",
        details: { reason_code: "invalid_shape", detail },
      },
    });
    if (!isRecord(recovery)) return invalid("recovery must be an object");
    const keys = Object.keys(recovery);
    if (keys.some((key) => key !== "target_checkpoint_id" && key !== "reason")) {
      return invalid("recovery accepts only target_checkpoint_id and reason");
    }
    if (typeof recovery.target_checkpoint_id !== "string" ||
        recovery.target_checkpoint_id.trim().length === 0) {
      return invalid("target_checkpoint_id must be a non-empty string");
    }
    if (typeof recovery.reason !== "string" ||
        recovery.reason.trim().length === 0 ||
        recovery.reason.length > 500) {
      return invalid("reason must be a non-empty string of at most 500 characters");
    }
    // Cheap referential validation before the queue/lease: an id that is not
    // visible on the current branch is a payload defect and must not write
    // session state. Deep manifest/blob/HEAD validation happens in the
    // lifecycle after the lease and before the directive commit.
    const heldSession = this.sessions.get(sessionId);
    if (heldSession) {
      const expectedRoundId = heldSession.roundSnapshot?.roundId
        ?? makeRoundId(heldSession.loopId, heldSession.currentRound);
      const held = heldSession.roundSnapshot;
      if (roundId === expectedRoundId &&
          held?.kind === "evaluation" &&
          held.round === heldSession.currentRound) {
        const prefix = `loop:${heldSession.loopId}:`;
        const entries = [
          ...queryLoopEntries(this.loopStore, heldSession.loopId, { prefix }),
          ...queryLoopEntries(this.loopStore, heldSession.loopId, {
            prefix,
            feedbackOnly: true,
          }),
        ];
        // A pending directive outranks target validation; the lifecycle
        // retries the same restore and never commits a second directive.
        if (!pendingRollbackDirective(entries)) {
          const resolved = findCheckpointRef({
            entries,
            held,
            checkpointId: recovery.target_checkpoint_id as string,
          });
          if (!resolved.ok) {
            return {
              sessionId,
              round: heldSession.currentRound,
              roundId: held.roundId,
              prompt: null,
              submissionError: {
                code: resolved.code,
                details: {
                  target_checkpoint_id: recovery.target_checkpoint_id,
                  reason_code: resolved.reason,
                  detail: resolved.detail,
                  current_round: heldSession.currentRound,
                },
              },
            };
          }
        }
      }
    }
    return this.withSessionQueue(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      if (
        session?.status === "running" &&
        !this.renewSessionLease(session.loopId)
      ) {
        return this.leaseConflictResult(
          session.loopId,
          this.findSessionEntry(session.loopId),
        );
      }
      try {
        return await this.lifecycle.recover(
          sessionId,
          {
            target_checkpoint_id: recovery.target_checkpoint_id as string,
            reason: recovery.reason as string,
          },
          roundId,
          transactionId,
        );
      } catch (error) {
        if (error instanceof SessionLeaseConflictError) {
          return this.leaseConflictResult(error.loopId, this.findSessionEntry(error.loopId));
        }
        throw error;
      }
    });
  }

  /** v3.9.7: Agent-created mid-round savepoint. It does not touch the round
   *  counter, progress, or any governance projection. The capture runs under
   *  the session queue/lease but outside the store lock; the session save is
   *  the only store mutation. */
  async checkpoint(
    sessionId: string,
    roundId?: string,
    transactionId?: string,
  ): Promise<Record<string, unknown>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        error: "session_not_found",
        errorMessage: "No session exists with this ID.",
        sessionId,
      };
    }
    if (session.status !== "running") {
      return {
        error: "checkpoint_invalid",
        errorMessage: `Session is ${session.status}; a checkpoint requires a running held evaluation.`,
        sessionId,
        roundId: session.roundSnapshot?.roundId,
        details: { reason_code: "session_not_running" },
      };
    }
    return this.withSessionQueue(sessionId, async () => {
      if (!this.renewSessionLease(session.loopId)) {
        const conflict = this.leaseConflictResult(
          session.loopId,
          this.findSessionEntry(session.loopId),
        );
        return {
          error: conflict.stopReason ?? "lease_conflict",
          errorMessage: conflict.stopDetail ?? "Another process owns this loop.",
          sessionId,
          roundId: conflict.roundId,
          details: { reason_code: "lease_conflict" },
        };
      }
      const held = session.roundSnapshot;
      const expectedRoundId = held?.roundId ?? makeRoundId(session.loopId, session.currentRound);
      if (!held || held.kind !== "evaluation" || held.round !== session.currentRound ||
          typeof roundId !== "string" || roundId !== expectedRoundId ||
          typeof transactionId !== "string" || transactionId !== held.transactionId) {
        return {
          error: "checkpoint_invalid",
          errorMessage:
            "checkpoint requires the roundId and transactionId from the currently held prompt.",
          sessionId,
          roundId: expectedRoundId,
          details: {
            reason_code: "identity_mismatch",
            expected_round_id: expectedRoundId,
            expected_transaction_id: held?.transactionId ?? null,
          },
        };
      }
      const prefix = `loop:${session.loopId}:`;
      const entries = [
        ...queryLoopEntries(this.loopStore, session.loopId, { prefix }),
        ...queryLoopEntries(this.loopStore, session.loopId, {
          prefix,
          feedbackOnly: true,
        }),
      ];
      if (pendingRollbackDirective(entries)) {
        return {
          error: "restore_pending",
          errorMessage:
            "A pending restore must be completed by loopforge_resume before creating a checkpoint.",
          sessionId,
          roundId: expectedRoundId,
          details: { reason_code: "restore_pending" },
        };
      }
      const store = this.checkpointStoreFor?.(session.loopId);
      if (!store) {
        return {
          error: "checkpoint_unavailable",
          errorMessage: "No workspace checkpoint store is configured for this loop.",
          sessionId,
          roundId: expectedRoundId,
          details: { reason_code: "store_unavailable" },
        };
      }
      let stateDir: string | undefined;
      try {
        stateDir = resolveStateDirectory(process.cwd(), getPolicy().backend.root_dir);
      } catch {
        stateDir = undefined;
      }
      const exclude = stateDir
        ? (path: string): boolean => {
            const abs = resolve(path);
            const prefixAbs = stateDir!.endsWith(sep) ? stateDir! : `${stateDir!}${sep}`;
            return abs === stateDir || abs.startsWith(prefixAbs);
          }
        : undefined;
      let manifest;
      try {
        manifest = await store.capture({
          round: held.round,
          role: "mid",
          cwd: process.cwd(),
          ...(exclude ? { exclude } : {}),
          timeoutMs: Math.max(60_000, getPolicy().evidence.timeout_ms),
        });
      } catch (error) {
        if (error instanceof CheckpointError) {
          return {
            error: error.code,
            errorMessage: error.message,
            sessionId,
            roundId: expectedRoundId,
            details: { reason_code: error.reasonCode },
          };
        }
        return {
          error: "checkpoint_failed",
          errorMessage: String(error),
          sessionId,
          roundId: expectedRoundId,
          details: { reason_code: "capture_error" },
        };
      }
      // The capture yielded to the event loop; a concurrent advance/pause may
      // have invalidated the held transaction. Never attach an orphan
      // checkpoint to a different attempt.
      if (this.sessions.get(sessionId) !== session ||
          session.roundSnapshot?.transactionId !== held.transactionId) {
        return {
          error: "checkpoint_invalid",
          errorMessage: "The held attempt changed while the checkpoint was captured.",
          sessionId,
          details: { reason_code: "identity_changed" },
        };
      }
      const ref = buildCheckpointRef(manifest, {
        transactionId: held.transactionId,
        branchId: held.branchId,
      });
      const previous = held.checkpoints ?? [];
      const duplicate = previous.find(
        (item) => item.checkpointId === ref.checkpointId,
      );
      // The cap counts DISTINCT savepoints. Re-capturing an already visible
      // state is idempotent and must still return the existing ref at the cap.
      if (!duplicate &&
          previous.length >= MAX_MID_CHECKPOINTS_PER_TRANSACTION) {
        return {
          error: "checkpoint_limit",
          errorMessage: `This attempt already has ${MAX_MID_CHECKPOINTS_PER_TRANSACTION} mid-round checkpoints.`,
          sessionId,
          roundId: expectedRoundId,
          details: { reason_code: "mid_checkpoint_cap" },
        };
      }
      if (!duplicate) {
        held.checkpoints = [...previous, ref];
        try {
          this.lifecycle.save(session);
        } catch (error) {
          held.checkpoints = previous;
          return {
            error: "checkpoint_failed",
            errorMessage: `The checkpoint manifest was written but the session could not be saved: ${String(error)}. Retry returns the same id.`,
            sessionId,
            roundId: expectedRoundId,
            details: { reason_code: "session_save_failed" },
          };
        }
      }
      return {
        checkpointId: manifest.checkpointId,
        transactionId: held.transactionId,
        roundId: held.roundId,
        round: held.round,
        role: "mid",
        redoRound: manifest.round,
        createdAt: (duplicate ?? ref).createdAt,
        ...(manifest.head ? { head: manifest.head } : {}),
        fileCount: Object.keys(manifest.fingerprints).length,
        contentCount: manifest.contents.length,
        contentHash: manifest.contentHash,
      };
    });
  }

  /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
  replayTimeline(sessionId: string): Record<string, unknown>[] | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return this.replayByLoop(session.loopId);
  }

  /** v3.3.1: Replay a loop straight from the vault — no in-memory session
   *  needed. Time travel over committed rounds is a property of the store
   *  (ReplayBackend reads round documents), so a process restart must not
   *  revoke it: the session registry was an artificial prerequisite that
   *  made every vault loop unreplayable after restart.
   *  Returns null when the loop has no committed rounds. */
  replayByLoop(loopId: string): Record<string, unknown>[] | null {
    validateLoopId(loopId);
    const replay = new ReplayBackend(this.loopStore);
    const timeline = replay.timeline(loopId);
    return timeline.length > 0 ? timeline : null;
  }

  /** v3.9.6: committed rollback directives for the replay view. They are
   *  events, not normal rounds; the timeline stays a normal-round projection. */
  replayRollbacks(loopId: string): Record<string, unknown>[] {
    validateLoopId(loopId);
    const entries = queryLoopEntries(this.loopStore, loopId, {
      prefix: `loop:${loopId}:`,
    });
    return readOnlyRollbacks(entries).map((view) => ({
      round: view.round,
      roundId: view.roundId,
      transactionId: view.transactionId ?? view.roundId,
      branchId: view.branchId ?? null,
      origin: view.origin === "agent" ? "agent" : "machine",
      redoRound: view.recovery?.target.redo_round ?? 0,
      targetCheckpointId: view.recovery?.target.checkpoint_id ?? "",
      reason: view.recovery?.reason ?? "",
      skippedFiles: [...(view.recovery?.skipped_files ?? [])],
      preservedDiscoveries: [...(view.recovery?.skipped_discoveries ?? [])],
    }));
  }

  /** v3.9.1: unsupported envelope versions for a loop, reported explicitly
   *  rather than silently dropped from replay/audit. */
  replayLegacyRounds(loopId: string): Array<{
    round: number;
    schemaVersion: number;
    envelope: string;
  }> {
    validateLoopId(loopId);
    return new ReplayBackend(this.loopStore).legacyRounds(loopId);
  }
}
