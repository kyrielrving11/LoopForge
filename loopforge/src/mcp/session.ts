/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 */

import { randomUUID } from "node:crypto";
import { LoopForgeEngine, extractSelfEvaluation, heuristicSelfEvaluation } from "../engine.js";
import { checkLoopHealth } from "../loop-compiler.js";
import { getPolicy } from "../policy.js";
import { Mode, makeLoopCompileRequest } from "../protocol.js";
import { ReplayBackend } from "../replay.js";
import type { VaultBackend, VaultEntry } from "../backends/interface.js";
import { FileLoopStore, LoopStoreBackend } from "../loop-store.js";
import type { LoopStore } from "../loop-store.js";
import type {
  LoopForgeRequest, SelfEvaluation, VerificationFlag,
  ExternalContextProvider, LoopTerminalEvent, LoopTerminalSink,
} from "../protocol.js";
import { EvidenceCollector } from "../evidence-provider.js";
import type { ProviderSnapshot } from "../evidence-provider.js";
import {
  parseRoundTransactionSnapshot,
  prepareRoundTransaction,
} from "../round-transaction.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import { RoundDriver } from "../round-driver.js";
import { logEvent } from "../observability.js";
import { policyMetrics } from "../policy-metrics.js";
import {
  SessionLeaseConflictError,
  VaultSessionStateStore,
} from "../storage.js";
import type { SessionStateStore } from "../storage.js";
import { createCognitiveCheckpoint } from "../interop.js";
import type { CognitiveCheckpointSink } from "../interop.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface McpSession {
  sessionId: string;
  loopId: string;
  task: string;
  engine: LoopForgeEngine;
  currentRound: number;
  maxRounds: number;
  successTrajectory: boolean[];
  status: "running" | "stopped" | "stalled" | "paused";
  createdAt: number;
  /** Previous round's validated SelfEvaluation — used by verification gate. */
  lastSelfEval?: SelfEvaluation;
  // v1.13: Enforcement gate state
  consecutiveRejections: number;
  /** Which enforcement check triggered the last rejection.
   *  Only same-check rejections accumulate toward the max. */
  lastRejectionCheck: string;
  /** Evidence baseline captured immediately before the agent receives a prompt. */
  evidenceBaseline?: ProviderSnapshot[];
  /** Schema-versioned transaction for the prompt currently held by the agent. */
  roundSnapshot?: RoundTransactionSnapshot;
  /** Persisted prompt prevents resume from compiling the same round twice. */
  currentPrompt?: string | null;
  currentLevel?: string;
}

export interface McpSessionSummary {
  sessionId: string;
  loopId: string;
  round: number;
  status: "running" | "stopped" | "stalled" | "paused";
}

export interface StartInput {
  task: string;
  loopId?: string;
  maxRounds?: number;
  domain?: string;
  planSource?: string;
  constraints?: string[];
}

export interface AdvanceResult {
  sessionId: string;
  round: number;
  /** Stable logical identity; unchanged when enforcement retries the round. */
  roundId?: string;
  prompt: string | null;
  stopReason?: string;
  level?: string;
  /** @deprecated Use roundSuccess instead. Derived: roundSuccess ? 5 : 1 */
  quality?: number;
  roundSuccess?: boolean;
  warnings?: string[];
  /** v1.13: Enforcement action for this round. accept/reject/terminate.
   *  When "reject", the prompt contains a rejection notice and the agent
   *  must redo the same round. Round counter does NOT increment. */
  enforcementAction?: "accept" | "reject" | "terminate";
  /** v1.13: When enforcementAction is "reject" or "terminate", the reason
   *  why the round was rejected or the loop was terminated. */
  enforcementReason?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildLoopRequest(
  session: McpSession,
  lastEval?: SelfEvaluation,
  _lastQuality?: number, // deprecated — kept for backward compat
  verificationFlags?: VerificationFlag[],
): Record<string, unknown> {
  const req: Record<string, unknown> = {
    task: session.task,
    mode: Mode.LOOP_COMPILE,
    feedback: null,
    skill_name: null,
    task_id: null,
    loop_id: session.loopId,
    round: session.currentRound,
    max_rounds: session.maxRounds,
    verification_flags: verificationFlags ?? [],
  };

  if (lastEval) {
    req.last_round_result = {
      round: session.currentRound - 1,
      success: lastEval.success,
      output_summary: lastEval.output_summary,
      constraint_violations: lastEval.constraint_violations,
      manual_fixes_needed: "",
      // P0–P2: Forward evolution fields to next compile
      // Merge sub-agent discovered constraints into the active set
      discovered_constraints: [
        ...new Set([
          ...(lastEval.discovered_constraints ?? []),
          ...(lastEval.worker_results ?? []).flatMap((w) => w.discoveredConstraints ?? []).filter((c) => c.length > 0),
        ]),
      ],
      objective_refinement: lastEval.objective_refinement ?? "",
      emerged_subtasks: lastEval.emerged_subtasks ?? [],
      // P4: Execution evidence
      execution_evidence: lastEval.execution_evidence ?? undefined,
      // P5: Self-correction
      retracted_constraints: lastEval.retracted_constraints ?? [],
      revised_success_criteria: lastEval.revised_success_criteria ?? [],
      wrong_assumptions: lastEval.wrong_assumptions ?? [],
      // Multi-agent: Forward delegation results to next compile
      worker_results: lastEval.worker_results ?? [],
      // v1.10: Checkpoint boundary
      compression_checkpoint: lastEval.compression_checkpoint ?? false,
      checkpoint_label: lastEval.checkpoint_label ?? "",
      // v1.16: Agent's declared next action
      next_action: lastEval.next_action,
    };
  }

  return req;
}

function parseWarnings(prompt: string | null): string[] {
  if (!prompt) return [];
  const warnings: string[] = [];
  const warnSection = prompt.match(/### Warnings\n([\s\S]*?)(?=\n###|\n\*\*|$)/);
  if (warnSection) {
    for (const line of warnSection[1].split("\n")) {
      const m = line.match(/- ⚠️\s*(.+)/);
      if (m) warnings.push(m[1]);
    }
  }
  return warnings;
}

// ── SessionManager ─────────────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, McpSession>();
  /** Serializes state transitions for each session. */
  private sessionQueues = new Map<string, Promise<void>>();
  private backend: VaultBackend | undefined;
  private sessionStore: SessionStateStore | undefined;
  private readonly ownerId = `${process.pid}:${randomUUID()}`;
  private readonly leaseMs: number;
  private readonly leaseRenewIntervalMs: number;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;
  private readonly checkpointSinks = new Set<CognitiveCheckpointSink>();
  /** Explicit context provider; never auto-discovered. */
  contextProvider?: ExternalContextProvider;
  private readonly terminalSinks = new Set<LoopTerminalSink>();

  constructor(
    storeOrBackend?: LoopStore | VaultBackend,
    sessionStore?: SessionStateStore,
  ) {
    const resolvedBackend = storeOrBackend
      ? "readSession" in storeOrBackend
        ? new LoopStoreBackend(storeOrBackend)
        : storeOrBackend
      : new LoopStoreBackend(new FileLoopStore(getPolicy().backend.root_dir));
    this.backend = resolvedBackend;
    this.sessionStore = sessionStore ?? new VaultSessionStateStore(resolvedBackend);
    const mcpPolicy = getPolicy().mcp;
    this.leaseMs = Math.max(1, mcpPolicy.session_lease_ms);
    this.leaseRenewIntervalMs = Math.max(
      1,
      Math.min(mcpPolicy.session_lease_renew_interval_ms, this.leaseMs),
    );
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

  /** Subscribe an external checkpointer; sink failures are isolated. */
  addCheckpointSink(sink: CognitiveCheckpointSink): () => void {
    this.checkpointSinks.add(sink);
    return () => this.checkpointSinks.delete(sink);
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

  async create(input: StartInput): Promise<AdvanceResult> {
    const sessionId = randomUUID();
    const loopId = input.loopId ?? randomUUID();
    const engine = new LoopForgeEngine(this.backend);
    const maxRounds = input.maxRounds ?? getPolicy().runtime.max_rounds;

    // Populate extra fields for the first round
    const request = buildLoopRequest({
      sessionId, loopId, task: input.task, engine, currentRound: 1,
      maxRounds, successTrajectory: [], status: "running", createdAt: Date.now(),
      consecutiveRejections: 0,
      lastRejectionCheck: "",
      evidenceBaseline: [],
    });
    request.domain = input.domain ?? "";
    request.plan_source = input.planSource ?? null;
    request.constraints_from_plan = input.constraints ?? [];

    // Explicit context is requested by the MCP embedding; no auto-discovery.
    if (this.contextProvider) {
      try {
        const ctx = {
          loopId,
          round: 1,
          task: input.task,
          domain: input.domain ?? "",
        };
        const rawContext = await this.contextProvider(ctx);
        if (rawContext?.trim()) {
          request.external_context = rawContext.trim();
          logEvent("external_context_loaded", {
            loopId, round: 1,
            contextLength: (request.external_context as string).length,
          });
        }
      } catch {
        // Provider failures are isolated from session creation.
        logEvent("context_provider_error", { loopId, round: 1 });
      }
    }

    const prepared = await new RoundDriver(engine, this.backend).prepare(
      request as unknown as LoopForgeRequest,
      loopId,
      1,
    );
    const initialPrompt = prepared?.prompt ?? null;
    const initialLevel = prepared?.level ?? "l2";
    const evidenceBaseline = prepared?.evidenceBaseline ?? [];
    const session: McpSession = {
      sessionId, loopId, task: input.task, engine,
      currentRound: 1, maxRounds, successTrajectory: [],
      status: "running", createdAt: Date.now(),
      // v1.13: Enforcement gate state
      consecutiveRejections: 0,
      lastRejectionCheck: "",
      evidenceBaseline,
      roundSnapshot: prepared?.snapshot ?? prepareRoundTransaction(loopId, 1, evidenceBaseline),
      currentPrompt: initialPrompt,
      currentLevel: initialLevel,
    };
    this.sessions.set(sessionId, session);
    policyMetrics.recordStrategy(loopId, initialLevel);

    // Persist to vault for cross-process recovery
    this.save(session);

    logEvent("session_start", {
      sessionId,
      loopId,
      task: input.task.slice(0, 80),
      maxRounds,
    });

    return {
      sessionId,
      round: 1,
      roundId: session.roundSnapshot?.roundId,
      prompt: initialPrompt,
      level: initialLevel,
      roundSuccess: false,
      quality: 0,
      warnings: parseWarnings(initialPrompt),
    };
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
    this.save(session); // Persist stopped status to vault so autoResumeAll won't resurrect
    void this.notifyTerminal(session, "cancelled");
    this.sessions.delete(sessionId);
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
    this.save(session);
    logEvent("session_paused", {
      sessionId,
      loopId: session.loopId,
      round: session.currentRound,
    });
    return { sessionId, round: session.currentRound, status: "paused" };
  }

  private restoredPromptResult(session: McpSession): AdvanceResult | null {
    if (!session.currentPrompt) return null;
    return {
      sessionId: session.sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot?.roundId,
      prompt: session.currentPrompt,
      level: session.currentLevel ?? "l2",
      quality: 0,
      roundSuccess: undefined,
      warnings: parseWarnings(session.currentPrompt),
    };
  }

  /** Reconcile the crash window where feedback committed but session_state
   *  still points at the old prompt. Returns null when no commit is pending. */
  private reconcileCommittedRound(session: McpSession): AdvanceResult | null {
    if (!session.roundSnapshot) return null;
    const recovered = new RoundDriver(
      session.engine,
      this.backend,
    ).recover(session.roundSnapshot);
    if (!recovered) return null;

    const pr = recovered.result;
    session.roundSnapshot = recovered.snapshot;
    // Replay the committed counter — but with per-rule tracking.
    if (pr.action === "reject" && pr.rejectionCheck) {
      session.consecutiveRejections =
        pr.rejectionCheck === session.lastRejectionCheck
          ? pr.newConsecutiveRejections
          : 1;
      session.lastRejectionCheck = pr.rejectionCheck;
    } else {
      session.consecutiveRejections = pr.newConsecutiveRejections;
      if (pr.action !== "reject") session.lastRejectionCheck = "";
    }
    if (pr.newLastSelfEval) session.lastSelfEval = pr.newLastSelfEval;
    if (
      pr.shouldPushSuccessTrajectory &&
      session.successTrajectory.length < session.currentRound
    ) {
      session.successTrajectory.push(pr.roundSuccess);
    }
    session.currentPrompt = null;

    if (pr.action === "stop" || pr.action === "terminate") {
      const reason = pr.action === "terminate"
        ? "enforcement_terminated"
        : pr.stopReason ?? "stalled";
      session.status = reason === "stalled" ? "stalled" : "stopped";
      this.save(session);
      void this.notifyTerminal(session, reason);
      return {
        sessionId: session.sessionId,
        round: session.currentRound,
        roundId: recovered.snapshot.roundId,
        prompt: null,
        stopReason: reason,
        roundSuccess: pr.roundSuccess,
        quality: pr.roundSuccess ? 5 : 1,
      };
    }

    if (pr.action !== "continue") return null;
    session.currentRound++;
    const request = buildLoopRequest(
      session,
      pr.newLastSelfEval,
      pr.roundSuccess ? 5 : 1,
      pr.verificationFlags,
    );
    const prepared = new RoundDriver(
      session.engine,
      this.backend,
    ).prepareSync(
      request as unknown as LoopForgeRequest,
      session.loopId,
      session.currentRound,
    );
    if (!prepared) {
      session.status = "stalled";
      this.save(session);
      return {
        sessionId: session.sessionId,
        round: session.currentRound,
        prompt: null,
        stopReason: "stalled",
      };
    }
    const prompt = prepared.prompt;
    session.evidenceBaseline = prepared.evidenceBaseline;
    session.roundSnapshot = prepared.snapshot;
    session.currentPrompt = prompt;
    session.currentLevel = prepared.level;
    policyMetrics.recordStrategy(
      session.loopId,
      session.currentLevel,
    );
    this.save(session);

    return {
      sessionId: session.sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot.roundId,
      prompt,
      level: session.currentLevel,
      roundSuccess: pr.roundSuccess,
      quality: pr.roundSuccess ? 5 : 1,
      warnings: parseWarnings(prompt),
    };
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

    const session = this.reconstructSession(sessionEntry, true);
    if (!session) return null;

    // Set to running so advance() works
    session.status = "running";
    this.sessions.set(session.sessionId, session);

    // Replace the sync-fallback evidence baseline with async evidence
    // so resumed sessions don't silently drop async provider data.
    try {
      const asyncEvidence = await EvidenceCollector.fromPolicy().collectAsync({
        loopId: session.loopId,
        phase: "before",
      });
      if (asyncEvidence.length > 0) {
        session.evidenceBaseline = asyncEvidence;
        if (!session.roundSnapshot?.beforeEvidence?.length) {
          session.roundSnapshot = prepareRoundTransaction(
            session.loopId,
            session.currentRound,
            asyncEvidence,
          );
        }
      }
    } catch {
      // Async evidence is best-effort; fall back to sync baseline.
    }

    const reconciled = this.reconcileCommittedRound(session);
    if (reconciled) return reconciled;
    const restored = this.restoredPromptResult(session);
    if (restored) {
      this.save(session);
      return restored;
    }

    // Compile the next prompt from the current round state
    const lcr = makeLoopCompileRequest({
      loop_id: session.loopId,
      round: session.currentRound,
      goal_id: "",
      task: session.task,
      domain: undefined,
      plan_source: null,
      constraints_from_plan: [],
      health_check_interval: 1,
    });
    const compileRequest = {
      task: session.task,
      mode: Mode.LOOP_COMPILE,
      feedback: null,
      skill_name: null,
      task_id: null,
      loop_id: lcr.loop_id,
      round: lcr.round,
      goal_id: lcr.goal_id,
      domain: lcr.domain ?? "",
      plan_source: lcr.plan_source ?? null,
      constraints_from_plan: lcr.constraints_from_plan ?? [],
      health_check_interval: lcr.health_check_interval,
      max_rounds: session.maxRounds,
    } as LoopForgeRequest;
    const prepared = await new RoundDriver(
      session.engine,
      this.backend,
    ).prepare(
      compileRequest,
      session.loopId,
      session.currentRound,
    );

    if (!prepared) {
      session.status = "stopped";
      this.save(session);
      void this.notifyTerminal(session, "stalled");
      return { sessionId: session.sessionId, round: session.currentRound, prompt: null, stopReason: "stalled" };
    }
    const prompt = prepared.prompt;
    const level = prepared.level;
    session.evidenceBaseline = prepared.evidenceBaseline;
    session.roundSnapshot = prepared.snapshot;
    session.currentPrompt = prompt;
    session.currentLevel = level;
    policyMetrics.recordStrategy(session.loopId, level);
    this.save(session);

    return {
      sessionId: session.sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot.roundId,
      prompt,
      level,
      quality: 0,
      roundSuccess: undefined,
      warnings: [],
    };
  }

  /** Persist session state to vault for cross-process recovery.
   *  The filtered vault and replacement entry are written once under the
   *  backend lock, so recovery never observes the old two-write gap. */
  save(session: McpSession): void {
    if (!this.sessionStore) return;
    const leaseActive = session.status === "running";
    const sessionEntry: VaultEntry = {
        task_id: `loop:${session.loopId}:session`,
        task_type: "session_state",
        timestamp: new Date().toISOString(),
        loop_id: session.loopId,
        task: session.task,
        loop_lineage: {
          session_id: session.sessionId,
          current_round: session.currentRound,
          max_rounds: session.maxRounds,
          success_trajectory: session.successTrajectory,
          status: session.status,
          created_at: session.createdAt,
          // v1.13: Enforcement gate state
          consecutive_rejections: session.consecutiveRejections,
          last_rejection_check: session.lastRejectionCheck,
          // v1.19: durable round transaction state
          round_snapshot: session.roundSnapshot ?? null,
          last_self_eval: session.lastSelfEval ?? null,
          current_prompt: session.currentPrompt ?? null,
          current_level: session.currentLevel ?? "",
          // v1.20: cross-process single-owner lease
          lease_owner: leaseActive ? this.ownerId : "",
          lease_expires_at: leaseActive ? Date.now() + this.leaseMs : 0,
        },
      };
    this.sessionStore.save(sessionEntry, {
      expectedLeaseOwner: this.ownerId,
    });
    if (this.checkpointSinks.size > 0) {
      const checkpoint = createCognitiveCheckpoint(
        session,
        sessionEntry.timestamp as string,
      );
      for (const sink of this.checkpointSinks) {
        try {
          const pending = sink.save(checkpoint);
          if (pending && typeof pending.then === "function") {
            void pending.catch(() => undefined);
          }
        } catch {
          // External adapters must not affect session durability.
        }
      }
    }
  }

  /** Reconstruct a McpSession from a vault session_state entry.
   *  Returns null if the entry is not "running" status.
   *  Shared by resume() and autoResumeAll(). */
  private reconstructSession(
    entry: VaultEntry,
    allowPaused = false,
  ): McpSession | null {
    const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
    const status = (lineage.status as string) ?? "running";
    if (status !== "running" && !(allowPaused && status === "paused")) {
      return null;
    }

    const loopId = entry.loop_id as string;
    const currentRound = (lineage.current_round as number) ?? 1;
    const successTrajectory =
      (lineage.success_trajectory as boolean[]) ?? (lineage.quality_trajectory as boolean[]) ?? [];
    const task = (entry.task as string) ?? "";
    const maxRounds =
      (lineage.max_rounds as number) ?? getPolicy().runtime.max_rounds;
    const roundSnapshot = parseRoundTransactionSnapshot(lineage.round_snapshot);
    const fallbackEvidence = EvidenceCollector.fromProviderNames(
      getPolicy().evidence.providers,
    ).collect();
    const persistedEval = lineage.last_self_eval;
    const lastSelfEval =
      persistedEval !== null &&
      typeof persistedEval === "object" &&
      !Array.isArray(persistedEval) &&
      typeof (persistedEval as Record<string, unknown>).success === "boolean" &&
      typeof (persistedEval as Record<string, unknown>).output_summary === "string"
        ? persistedEval as SelfEvaluation
        : undefined;

    const engine = new LoopForgeEngine(this.backend);
    return {
      sessionId: typeof lineage.session_id === "string" && lineage.session_id
        ? lineage.session_id
        : randomUUID(),
      loopId, task, engine,
      currentRound, maxRounds, successTrajectory,
      status: status as McpSession["status"],
      createdAt: (lineage.created_at as number) ?? Date.now(),
      consecutiveRejections: (lineage.consecutive_rejections as number) ?? 0,
      lastRejectionCheck: typeof lineage.last_rejection_check === "string"
        ? lineage.last_rejection_check
        : "",
      evidenceBaseline: roundSnapshot?.beforeEvidence ?? fallbackEvidence,
      roundSnapshot: roundSnapshot ?? prepareRoundTransaction(
        loopId,
        currentRound,
        fallbackEvidence,
      ),
      lastSelfEval,
      currentPrompt: typeof lineage.current_prompt === "string"
        ? lineage.current_prompt
        : null,
      currentLevel: typeof lineage.current_level === "string"
        ? lineage.current_level
        : undefined,
    };
  }

  /** Resume a loop from vault state.
   *  Reconstructs the session and compiles the prompt for the next round.
   *  Returns null if no session_state entry exists for this loopId. */
  resume(loopId: string): AdvanceResult | null {
    const persistedEntry = this.findSessionEntry(loopId);
    if (!persistedEntry) return null;
    const persistedLineage = (persistedEntry.loop_lineage ?? {}) as Record<string, unknown>;
    const persistedStatus = (persistedLineage.status as string) ?? "running";
    const sessionEntry = persistedStatus === "running"
      ? this.claimSessionEntry(loopId)
      : persistedEntry;
    if (!sessionEntry) return this.leaseConflictResult(loopId, persistedEntry);

    const session = this.reconstructSession(sessionEntry);
    if (!session) {
      // was not "running" — return stopped/stalled status
      const lineage = (sessionEntry.loop_lineage ?? {}) as Record<string, unknown>;
      const currentRound = (lineage.current_round as number) ?? 1;
      const status = (lineage.status as string) ?? "stopped";
      return {
        sessionId: "",
        round: currentRound,
        prompt: null,
        stopReason: status,
      };
    }

    this.sessions.set(session.sessionId, session);

    const reconciled = this.reconcileCommittedRound(session);
    if (reconciled) return reconciled;

    const restored = this.restoredPromptResult(session);
    if (restored) return restored;

    // Legacy session without a stored prompt: compile once, then persist it.
    const request = buildLoopRequest(session);
    const prepared = new RoundDriver(
      session.engine,
      this.backend,
    ).prepareSync(
      request as unknown as LoopForgeRequest,
      session.loopId,
      session.currentRound,
    );
    const prompt = prepared?.prompt ?? null;
    session.evidenceBaseline = prepared?.evidenceBaseline ?? [];
    session.roundSnapshot = prepared?.snapshot ?? prepareRoundTransaction(
      session.loopId,
      session.currentRound,
      [],
    );
    session.currentPrompt = prompt;
    session.currentLevel = prepared?.level ?? "l2";
    policyMetrics.recordStrategy(
      session.loopId,
      session.currentLevel,
    );
    this.save(session);

    return {
      sessionId: session.sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot.roundId,
      prompt,
      level: session.currentLevel,
      roundSuccess: false,
      quality: 0,
      warnings: parseWarnings(prompt),
    };
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
      if (status !== "running" && status !== "paused") continue;
      const claimedEntry = this.claimSessionEntry(lid);
      if (!claimedEntry) continue;

      const session = this.reconstructSession(claimedEntry, true);
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

  /** Get loop health for a loop (in-memory or vault).
   *  Computes goal alignment, constraint integrity, drift, strategy stability. */
  getHealth(loopId: string): Record<string, unknown> | null {
    // Find the task — check in-memory sessions first, then vault
    let task = "";
    let goalId = loopId;

    for (const s of this.sessions.values()) {
      if (s.loopId === loopId) {
        task = s.task;
        if (s.engine.state?.task_id) {
          goalId = s.engine.state.task_id;
        }
        break;
      }
    }

    // Fall back to vault for task
    if (!task) {
      const sessionEntry = this.findSessionEntry(loopId);
      if (sessionEntry) {
        task = (sessionEntry.task as string) ?? "";
      }
    }

    if (!task) return null;

    // Hydrate vault context
    const engine = new LoopForgeEngine(this.backend);
    const vaultContext = engine.hydrateLoopContext(loopId);

    // Build a minimal request for health check
    const request = makeLoopCompileRequest({
      task,
      loop_id: loopId,
      goal_id: goalId,
      round: 1, // round doesn't matter for health check
    });

    const health = checkLoopHealth(loopId, request, vaultContext);
    return {
      loopId,
      goal_alignment: health.goal_alignment,
      constraint_integrity: health.constraint_integrity,
      drift_detected: health.drift_detected,
      strategy_stability: health.strategy_stability,
      task_continuity: health.task_continuity,
      policy_metrics: policyMetrics.snapshot(loopId),
    };
  }

  /** Core cycle: extract self-eval → record feedback → check stop → compile next.
   *  @param preExtractedEval Optional pre-built SelfEvaluation from MCP tool parameter.
   *    When provided (MCP path with evaluation parameter), skips regex extraction.
   *    When undefined (runtime/CLI path), falls back to regex extraction from output. */
  async advance(
    sessionId: string,
    output: string,
    preExtractedEval?: SelfEvaluation,
  ): Promise<AdvanceResult> {
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
        return await this.advanceUnlocked(sessionId, output, preExtractedEval);
      } catch (error) {
        if (error instanceof SessionLeaseConflictError) {
          return this.leaseConflictResult(error.loopId, this.findSessionEntry(error.loopId));
        }
        throw error;
      }
    });
  }

  private async advanceUnlocked(
    sessionId: string,
    output: string,
    preExtractedEval?: SelfEvaluation,
  ): Promise<AdvanceResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, round: 0, prompt: null, stopReason: "session_not_found" };
    if (session.status !== "running") {
      return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status };
    }

    // 1. Extract self-evaluation (structured param preferred → regex → heuristic)
    let extractionFailed = false;
    let selfEval: SelfEvaluation | null;
    if (preExtractedEval) {
      selfEval = preExtractedEval;
      extractionFailed = false;
    } else {
      const structured = extractSelfEvaluation(output);
      extractionFailed = structured === null;
      selfEval = structured ?? heuristicSelfEvaluation(output);
    }

    // Guard: if both extraction methods returned null, stop
    if (!selfEval) {
      session.status = "stalled";
      this.save(session);
      void this.notifyTerminal(session, "stalled");
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: "stalled", round: session.currentRound });
      return { sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", roundSuccess: false, quality: 0 };
    }

    // 1.5. Unified transaction: before → evaluate → verify → commit/reject.
    const snapshot = session.roundSnapshot ?? prepareRoundTransaction(
      session.loopId,
      session.currentRound,
      session.evidenceBaseline ?? [],
    );
    const completed = await new RoundDriver(
      session.engine,
      this.backend,
    ).complete({
      snapshot,
      loopId: session.loopId,
      task: session.task,
      maxRounds: session.maxRounds,
      selfEval,
      extractionSucceeded: !extractionFailed,
      lastSelfEval: session.lastSelfEval,
      consecutiveRejections: session.consecutiveRejections,
      successTrajectory: session.successTrajectory,
    });
    const outcome = completed.outcome;
    const actualSnapshots = completed.actualEvidence;
    session.roundSnapshot = outcome.snapshot;
    const pr = outcome.result;
    policyMetrics.recordStrategyOutcome(
      session.loopId,
      session.currentLevel,
      pr,
      outcome.replayed,
    );

    const verificationFlags = pr.verificationFlags;
    // Track per-rule rejections: only same-check rejections
    // accumulate. A different rejection reason resets the counter.
    if (pr.action === "reject" && pr.rejectionCheck) {
      session.consecutiveRejections =
        pr.rejectionCheck === session.lastRejectionCheck
          ? pr.newConsecutiveRejections
          : 1;
      session.lastRejectionCheck = pr.rejectionCheck;
    } else {
      session.consecutiveRejections = pr.newConsecutiveRejections;
      if (pr.action !== "reject") session.lastRejectionCheck = "";
    }
    if (pr.newLastSelfEval) session.lastSelfEval = pr.newLastSelfEval;
    if (pr.shouldPushSuccessTrajectory) {
      session.successTrajectory.push(pr.roundSuccess);
    }

    // Handle enforcement actions
    if (pr.action === "reject") {
      const retryRequest = buildLoopRequest(
        session,
        undefined,
        undefined,
        verificationFlags,
      );
      const preparedRetry = await new RoundDriver(
        session.engine,
        this.backend,
      ).prepareRetry(
        retryRequest as LoopForgeRequest,
        session.roundSnapshot,
        pr.rejectionPrompt ?? "",
        session.consecutiveRejections,
      );
      if (!preparedRetry) {
        session.status = "stalled";
        session.currentPrompt = null;
        this.save(session);
        return {
          sessionId,
          round: session.currentRound,
          roundId: session.roundSnapshot.roundId,
          prompt: null,
          stopReason: "stalled",
        };
      }
      session.roundSnapshot = preparedRetry.snapshot;
      session.currentPrompt = preparedRetry.prompt;
      session.currentLevel = preparedRetry.level;
      this.save(session);
      return {
        sessionId,
        round: session.currentRound,
        roundId: session.roundSnapshot.roundId,
        prompt: preparedRetry.prompt,
        level: preparedRetry.level,
        enforcementAction: "reject",
        enforcementReason: pr.enforcementReason,
      };
    }

    // Accepted rounds advance the before-snapshot. Rejected rounds retain the
    // original baseline so their retry is still a zero-commit transaction.
    session.evidenceBaseline = actualSnapshots;

    if (pr.action === "terminate") {
      session.status = "stopped";
      session.currentPrompt = null;
      this.save(session);
      void this.notifyTerminal(session, "enforcement_terminated");
      logEvent("session_end", {
        sessionId, loopId: session.loopId,
        stopReason: "enforcement_terminated", round: session.currentRound,
      });
      return {
        sessionId,
        round: session.currentRound,
        roundId: session.roundSnapshot.roundId,
        prompt: null,
        stopReason: "enforcement_terminated",
        enforcementAction: "terminate",
        enforcementReason: pr.enforcementReason,
      };
    }

    if (pr.action === "stop") {
      const reason = pr.stopReason ?? "stalled";
      session.status = reason === "stalled" ? "stalled" : "stopped";
      session.currentPrompt = null;
      this.save(session);
      void this.notifyTerminal(session, reason);
      logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: reason, round: session.currentRound });
      return { sessionId, round: session.currentRound, roundId: session.roundSnapshot.roundId, prompt: null, stopReason: reason, roundSuccess: pr.roundSuccess, quality: pr.roundSuccess ? 5 : 1 };
    }

    const roundSuccess = pr.roundSuccess;

    // Feedback + decision metadata were committed by the transaction layer.

    // Build deprecated quality alias for backward compat
    const deprecatedQuality = roundSuccess ? 5 : 1;

    // 4. Compile next round after the accepted commit.
    session.currentRound++;
    session.currentPrompt = null;

    // v1.8: Memory injection for phases 2/3 — tier-aware
    let externalCtx = "";
    if (this.contextProvider) {
      try {
        externalCtx = (await this.contextProvider({
          loopId: session.loopId,
          round: session.currentRound,
          task: session.task,
          domain: "",
          lastEvaluation: selfEval,
        })).trim();
      } catch {
        logEvent("context_provider_error", {
          loopId: session.loopId,
          round: session.currentRound,
        });
      }
    }

    // pause()/delete() are intentionally synchronous for API compatibility.
    // They may run while the memory provider above is awaited.  Treat the
    // session map + status as a commit fence so an in-flight advance cannot
    // compile/save another round after a terminal lifecycle transition.
    if (this.sessions.get(sessionId) !== session || session.status !== "running") {
      return {
        sessionId,
        round: session.currentRound,
        prompt: null,
        stopReason: session.status,
        roundSuccess,
        quality: deprecatedQuality,
      };
    }

    const request = buildLoopRequest(session, selfEval, deprecatedQuality, verificationFlags);
    if (externalCtx) {
      request.external_context = externalCtx;
    }
    const prepared = await new RoundDriver(
      session.engine,
      this.backend,
    ).prepare(
      request as unknown as LoopForgeRequest,
      session.loopId,
      session.currentRound,
    );
    const nextPrompt = prepared?.prompt ?? null;
    const nextLevel = prepared?.level ?? "l2";
    const nextBaseline = prepared?.evidenceBaseline ?? actualSnapshots;
    session.evidenceBaseline = nextBaseline;
    session.roundSnapshot = prepared?.snapshot ?? prepareRoundTransaction(
      session.loopId,
      session.currentRound,
      nextBaseline,
    );
    session.currentPrompt = nextPrompt;
    session.currentLevel = nextLevel;
    policyMetrics.recordStrategy(session.loopId, nextLevel);

    this.save(session);

    return {
      sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot.roundId,
      prompt: nextPrompt,
      level: nextLevel,
      roundSuccess,
      quality: deprecatedQuality,
      warnings: parseWarnings(nextPrompt),
    };
  }

  /** Write back loop knowledge to long-term memory.
   *  Uses shared base builder from policy.ts. Called when a loop terminates. */
  private async notifyTerminal(
    session: McpSession,
    stopReason: string,
  ): Promise<void> {
    if (this.terminalSinks.size === 0) return;
    const event: LoopTerminalEvent = {
      loopId: session.loopId,
      task: session.task,
      success: stopReason === "completed",
      stopReason: stopReason as LoopTerminalEvent["stopReason"],
      roundsCompleted: session.currentRound,
      successTrajectory: [...session.successTrajectory],
      lastEvaluation: session.lastSelfEval,
    };
    await Promise.allSettled(
      [...this.terminalSinks].map((sink) => Promise.resolve(sink(event))),
    );
  }

  /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
  replayTimeline(sessionId: string): Record<string, unknown>[] | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const replay = new ReplayBackend(this.backend!);
    return replay.timeline(session.loopId);
  }
}
