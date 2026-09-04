/** LoopForge MCP — Round lifecycle.
 *
 * The round state machine split out of SessionManager: crash recovery,
 * transaction execution, disposition result building, and the advance
 * pipeline. SessionManager owns "who may touch a session" (registry, queue,
 * leases); this class owns "what happens to a session" (state machine,
 * recovery, result building).
 *
 * The lifecycle depends on a narrow registry and explicit stores/providers;
 * session ownership, queues, and leases remain in SessionManager.
 */

import { randomUUID } from "node:crypto";
import { LoopForgeEngine } from "../engine.js";
import { deriveGate } from "../cognitive-governance.js";
import {
  Mode,
  makeLoopCompileRequest,
  makeLoopRoundResult,
} from "../protocol.js";
import type {
  LoopForgeRequest,
  LoopForgeResponse,
  SelfEvaluation,
  VerificationFlag,
  ExternalContextProvider,
  LoopTerminalEvent,
  LoopTerminalSink,
} from "../protocol.js";
import { EvidenceCollector, runBacktrackAutoRestore } from "../evidence-provider.js";
import type { ProviderSnapshot } from "../evidence-provider.js";
import {
  makeRoundId,
  parseRoundTransactionSnapshot,
  prepareRoundTransaction,
} from "../round-transaction.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import { RoundDriver } from "../round-driver.js";
import type { RoundProcessResult } from "../round-coordinator.js";
import { getPolicy } from "../policy.js";
import { checkRoundSequence, queryLoopEntries } from "../loop-store.js";
import type { LoopStore, VaultEntry } from "../loop-store.js";
import { logEvent } from "../observability.js";
import { policyMetrics } from "../policy-metrics.js";
import type { SessionStateStore } from "../storage.js";

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
  /** v2.12: Consecutive rounds where the agent used drift_clarification
   *  to waive R7 rejection. Reset to 0 when a round has no intent_drift.
   *  Terminates the loop when exceeding policy.drift_clarification_max_streak. */
  driftClarificationStreak: number;
  /** v2.13: Files changed in skipped rounds during the last backtrack.
   *  The next round's verification gate checks that the agent did not
   *  continue working on stale files without restoring the workspace.
   *  Cleared after the first successful post-backtrack round. */
  backtrackSkippedFiles: string[];
  /** v2.12: Git HEAD of the last backtrack restore point. The verification
   *  gate checks the workspace returns to this commit before accepting.
   *  Cleared after the first successful post-backtrack round. */
  backtrackTargetGitHead?: string;
  /** Evidence baseline captured immediately before the agent receives a prompt. */
  evidenceBaseline?: ProviderSnapshot[];
  /** Schema-versioned transaction for the prompt currently held by the agent. */
  roundSnapshot?: RoundTransactionSnapshot;
  /** Persisted prompt prevents resume from compiling the same round twice. */
  currentPrompt?: string | null;
  currentLevel?: string;
  /** Structured warnings from the most recent compile — preferred over regex parsing. */
  currentWarnings?: string[];
  /** v3.0.1: The full compile response of the current round, cached so the
   *  typed projection (getProjection) derives from it instead of recompiling
   *  the whole vault. Freshness is checked via loop_id + round; rebuilt by
   *  every compile path. Not persisted — cold sessions fall back to compiling. */
  lastCompileResponse?: LoopForgeResponse | null;
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
  /** v2.0.1: Human-readable context for why the loop stopped.
   *  Provides facts the agent can use to decide its next action,
   *  without LoopForge prescribing a specific behavior. */
  stopDetail?: string;
  level?: string;
  roundSuccess?: boolean;
  warnings?: string[];
  /** v1.13: Enforcement action for this round. accept/reject/terminate.
   *  When "reject", the prompt contains a rejection notice and the agent
   *  must redo the same round. Round counter does NOT increment. */
  enforcementAction?: "accept" | "reject" | "terminate" | "backtrack";
  /** v1.13: When enforcementAction is "reject" or "terminate", the reason
   *  why the round was rejected or the loop was terminated. */
  enforcementReason?: string;
}

/** Narrow view of the session registry the lifecycle may touch. The owning
 *  SessionManager implements this over its private Map, so the lifecycle
 *  never holds or mutates registry state directly. */
export interface SessionRegistry {
  get(sessionId: string): McpSession | undefined;
  values(): Iterable<McpSession>;
  upsert(session: McpSession): void;
}

export interface RoundLifecycleDeps {
  store: LoopStore;
  sessionStore: SessionStateStore | undefined;
  registry: SessionRegistry;
  terminalSinks: Set<LoopTerminalSink>;
  /** Stable process-local owner token used for cross-process session leases. */
  ownerId: string;
  /** Session lease duration; stamped into saved session entries. */
  leaseMs: number;
  /** Live accessor for the mutable contextProvider field on SessionManager. */
  getContext: () => ExternalContextProvider | undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function buildLoopRequest(
  session: McpSession,
  lastEval?: SelfEvaluation,
  verificationFlags?: VerificationFlag[],
): LoopForgeRequest {
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
    req.last_round_result = makeLoopRoundResult({
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
      // v2.2: Sub-goal lifecycle
      completed_subtasks: lastEval.completed_subtasks ?? [],
      blocked_subtasks: lastEval.blocked_subtasks ?? [],
      canceled_subtasks: lastEval.canceled_subtasks ?? [],
      // v2.8: Drift clarification
      drift_clarification: lastEval.drift_clarification,
      // v2.9: Model's information needs for the next prompt
      prompt_requests: lastEval.prompt_requests,
      // v2.12: Tri-state outcome + blocker + retroactive claims
      outcome: lastEval.outcome,
      blocker: lastEval.blocker,
      retroactiveClaims: lastEval.retroactiveClaims ?? [],
      // v3.3: round_contract was carried here so it could drive the next
      // round's Current Task. v3.4: intentionally NOT forwarded — the
      // submission's round_contract is a PROPOSAL for the next round, and
      // the ACTIVE contract is derived from committed rounds at compile time
      // (loop-compiler.deriveActiveContract), which also keeps it correct on
      // retry / resume / unpause / backtrack compiles that have no
      // last_round_result. Reading this field again would reintroduce the
      // second source of truth the derivation replaced.
    });
  }

  return req as LoopForgeRequest;
}

// ── RoundLifecycle ─────────────────────────────────────────────────────────

export class RoundLifecycle {
  private readonly store: LoopStore;
  private readonly sessionStore: SessionStateStore | undefined;
  private readonly registry: SessionRegistry;
  private readonly terminalSinks: Set<LoopTerminalSink>;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly getContext: () => ExternalContextProvider | undefined;

  constructor(deps: RoundLifecycleDeps) {
    this.store = deps.store;
    this.sessionStore = deps.sessionStore;
    this.registry = deps.registry;
    this.terminalSinks = deps.terminalSinks;
    this.ownerId = deps.ownerId;
    this.leaseMs = deps.leaseMs;
    this.getContext = deps.getContext;
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
          // v2.12: Clarification streak
          drift_clarification_streak: session.driftClarificationStreak,
          // v2.13: Backtrack skipped files for workspace restore check
          backtrack_skipped_files: session.backtrackSkippedFiles,
          // v2.12: Backtrack restore-point git HEAD (crash recovery)
          backtrack_target_git_head: session.backtrackTargetGitHead ?? null,
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
  }

  /** Reconstruct a McpSession from a vault session_state entry.
   *  Returns null if the entry is not "running" status.
   *  Shared by resume() and autoResumeAll(). */
  reconstructSession(
    entry: VaultEntry,
    allowPaused = false,
  ): McpSession | null {
    const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
    const status = (lineage.status as string) ?? "running";
    if (status !== "running" && !(allowPaused && status === "paused")) {
      return null;
    }

    const loopId = entry.loop_id as string;
    // v2.14: load-time gap detection — a runtime loop whose round sequence
    // has holes (deleted/tampered round documents) must not be resumed
    // silently. Legacy loops without stamps are exempt; gaps and corruption
    // surface as StorageCorruptionError. Previously checkRoundSequence was
    // only reachable through the read-only audit.
    checkRoundSequence(this.store, loopId);
    const currentRound = (lineage.current_round as number) ?? 1;
    const successTrajectory = Array.isArray(lineage.success_trajectory)
      ? lineage.success_trajectory.filter((value): value is boolean => typeof value === "boolean")
      : [];
    const task = (entry.task as string) ?? "";
    const maxRounds =
      (lineage.max_rounds as number) ?? getPolicy().engine.max_rounds;
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

    const engine = new LoopForgeEngine(this.store);
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
      driftClarificationStreak:
        (lineage.drift_clarification_streak as number) ?? 0,
      backtrackSkippedFiles:
        (lineage.backtrack_skipped_files as string[]) ?? [],
      backtrackTargetGitHead:
        typeof lineage.backtrack_target_git_head === "string" &&
        lineage.backtrack_target_git_head.length > 0
          ? lineage.backtrack_target_git_head
          : undefined,
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

  /** Apply a prepared round to the session, persist, and build the result.
   *  Shared by reconcileCommittedRound, resume, and unpause — the three
   *  compile-then-persist tails were previously copy-pasted. */
  private persistPrepared(
    session: McpSession,
    prepared: {
      prompt: string | null;
      level: string;
      baseline: ProviderSnapshot[];
      snapshot: RoundTransactionSnapshot;
      warnings: string[];
      compileResponse?: LoopForgeResponse | null;
    },
    roundSuccess: boolean | undefined,
    warningsOverride?: string[],
  ): AdvanceResult {
    session.evidenceBaseline = prepared.baseline;
    session.roundSnapshot = prepared.snapshot;
    session.currentPrompt = prepared.prompt;
    session.currentLevel = prepared.level;
    session.currentWarnings = prepared.warnings;
    session.lastCompileResponse = prepared.compileResponse ?? null;
    policyMetrics.recordStrategy(session.loopId, prepared.level);
    this.save(session);

    return {
      sessionId: session.sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot.roundId,
      prompt: prepared.prompt,
      level: prepared.level,
      roundSuccess,
      warnings: warningsOverride ?? session.currentWarnings ?? [],
    };
  }

  private restoredPromptResult(session: McpSession): AdvanceResult | null {
    if (!session.currentPrompt) return null;
    return {
      sessionId: session.sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot?.roundId,
      prompt: session.currentPrompt,
      level: session.currentLevel ?? "l2",
      roundSuccess: undefined,
      warnings: (session.currentWarnings ?? []),
    };
  }

  /** Reconcile the crash window where feedback committed but session_state
   *  still points at the old prompt. Returns null when no commit is pending. */
  private reconcileCommittedRound(session: McpSession): AdvanceResult | null {
    if (!session.roundSnapshot) return null;
    const recovered = new RoundDriver(
      session.engine,
      this.store,
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
        stopDetail: reason === "completed"
          ? "Task completed successfully — the agent declared should_continue=false with success=true."
          : reason === "blocked"
            ? "Agent cannot proceed under current constraints. The task may need revised constraints or human intervention."
            : reason === "failed"
              ? "Agent declared should_continue=false with success=false — the task was not achieved."
              : `Loop stopped: ${reason}.`,
        roundSuccess: pr.roundSuccess,
      };
    }

    if (pr.action === "backtrack") {
      // Backtrack committed but prompt not delivered (crash window).
      // Reset round counter to the restore target + 1 so the next
      // resume / unpause compiles from the correct restored state.
      const restoreTarget = pr.backtrackTarget ?? (session.currentRound - 1);
      session.currentRound = restoreTarget + 1;
      session.consecutiveRejections = 0;
      session.lastRejectionCheck = "";
      session.driftClarificationStreak = 0;
      session.lastSelfEval = undefined;
      session.currentPrompt = null;
      this.save(session);
      // Return null — caller (resume/unpause) will recompile normally
      return null;
    }

    if (pr.action !== "continue") return null;
    // v2.14: only advance when the persisted counter has not already moved
    // past the committed round. The pause/delete race leaves currentRound
    // incremented (the commit fence returns before compiling, and pause()
    // persisted the incremented value) — replaying must compile the NEXT
    // round, not skip it by incrementing again.
    if (session.currentRound <= recovered.snapshot.round) {
      session.currentRound = recovered.snapshot.round + 1;
    }
    const request = buildLoopRequest(
      session,
      pr.newLastSelfEval,
      pr.verificationFlags,
    );
    const prepared = new RoundDriver(
      session.engine,
      this.store,
    ).prepareSync(
      request,
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
        stopDetail: "RoundDriver.prepareSync returned null — prompt compilation failed during crash recovery. The session state may be inconsistent.",
      };
    }
    return this.persistPrepared(
      session,
      {
        prompt: prepared.prompt,
        level: prepared.level,
        baseline: prepared.evidenceBaseline,
        snapshot: prepared.snapshot,
        warnings: prepared?.warnings ?? [],
      },
      pr.roundSuccess,
    );
  }

  /** Resume tail: the session has been reconstructed and registered. Reconcile
   *  a committed-but-undelivered round, restore the held prompt, or recover a
   *  missing prompt from current round state. */
  resume(session: McpSession): AdvanceResult {
    const reconciled = this.reconcileCommittedRound(session);
    if (reconciled) return reconciled;

    const restored = this.restoredPromptResult(session);
    if (restored) return restored;

    // Missing held prompt: compile once, then persist it.
    const request = buildLoopRequest(session);
    const prepared = new RoundDriver(
      session.engine,
      this.store,
    ).prepareSync(
      request,
      session.loopId,
      session.currentRound,
    );
    const prompt = prepared?.prompt ?? null;
    const baseline = prepared?.evidenceBaseline ?? [];
    const snapshot = prepared?.snapshot ?? prepareRoundTransaction(
      session.loopId,
      session.currentRound,
      [],
    );
    return this.persistPrepared(
      session,
      {
        prompt,
        level: prepared?.level ?? "l2",
        baseline,
        snapshot,
        warnings: prepared?.warnings ?? [],
      },
      false,
    );
  }

  /** Unpause tail: the session has been reconstructed and registered with
   *  status "running". Refresh async evidence, reconcile a committed round,
   *  restore the held prompt, or compile the next prompt. */
  async unpause(session: McpSession): Promise<AdvanceResult> {
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
      this.store,
    ).prepare(
      compileRequest,
      session.loopId,
      session.currentRound,
    );

    if (!prepared) {
      session.status = "stopped";
      this.save(session);
      void this.notifyTerminal(session, "stalled");
      return { sessionId: session.sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", stopDetail: "RoundDriver.prepare returned null during unpause — the compiler could not produce a prompt." };
    }
    return this.persistPrepared(
      session,
      {
        prompt: prepared.prompt,
        level: prepared.level,
        baseline: prepared.evidenceBaseline,
        snapshot: prepared.snapshot,
        warnings: prepared?.warnings ?? [],
      },
      undefined,
      // Historical contract: unpause returns an empty warnings array even
      // though the session carries the compiled warnings.
      [],
    );
  }

  /** Record a gate_opened entry when an accepted round reports a high-risk
   *  blocker (USER_RISK hit). Idempotent per gate. The gate is a record
   *  layer — it never blocks the round decision flow. */
  private recordGateFromBlocked(session: McpSession, blocker: string): void {
    if (!getPolicy().gate.enabled) return;
    const { id, gate } = deriveGate(blocker);
    if (gate.kind !== "user") return;
    const taskId = `loop:${session.loopId}:gate:${id}`;
    const existing = queryLoopEntries(this.store, session.loopId, { prefix: taskId })
      .some((entry) => entry.task_id === taskId);
    if (existing) return;
    const entry: VaultEntry = {
      id: randomUUID(),
      task_id: taskId,
      task_type: "gate_opened",
      loop_id: session.loopId,
      timestamp: new Date().toISOString(),
      gate_id: id,
      gate_action: blocker,
      loop_lineage: {
        round: session.currentRound,
        gate_id: id,
      },
    };
    this.store.appendEntry(entry);
    logEvent("gate_opened", { loopId: session.loopId, gateId: id, round: session.currentRound });
  }

  /** Undecided user gate descriptions for a loop (recorded but unresolved). */
  listOpenGateDescriptions(loopId: string): string[] {
    const entries = queryLoopEntries(this.store, loopId, { prefix: `loop:${loopId}:gate:` });
    const decided = new Set(
      entries.filter((entry) => entry.task_type === "gate_decision")
        .map((entry) => String(entry.gate_id ?? "")),
    );
    return entries
      .filter((entry) => entry.task_type === "gate_opened" &&
        !decided.has(String(entry.gate_id ?? "")))
      .map((entry) => typeof entry.gate_action === "string"
        ? entry.gate_action
        : String(entry.gate_id ?? ""));
  }

  /** The boundary supplies the typed evaluation. Free-text parsing is
   *  deliberately not part of the round state machine. */
  private extractEvaluation(
    _output: string,
    preExtractedEval?: SelfEvaluation,
  ): SelfEvaluation | null {
    return preExtractedEval ?? null;
  }

  /** Execute the round transaction and apply per-rule rejection tracking.
   *  MUTATES: session.roundSnapshot, session.consecutiveRejections,
   *           session.lastRejectionCheck, session.lastSelfEval,
   *           session.successTrajectory, session.driftClarificationStreak */
  private async executeRoundTransaction(
    session: McpSession,
    selfEval: SelfEvaluation,
  ): Promise<{ pr: RoundProcessResult; verificationFlags: VerificationFlag[]; actualEvidence: ProviderSnapshot[] }> {
    const snapshot = session.roundSnapshot ?? prepareRoundTransaction(
      session.loopId,
      session.currentRound,
      session.evidenceBaseline ?? [],
    );
    const completed = await new RoundDriver(
      session.engine,
      this.store,
    ).complete({
      snapshot,
      loopId: session.loopId,
      task: session.task,
      maxRounds: session.maxRounds,
      selfEval,
      lastSelfEval: session.lastSelfEval,
      consecutiveRejections: session.consecutiveRejections,
      successTrajectory: session.successTrajectory,
      driftClarificationStreak: session.driftClarificationStreak,
      backtrackSkippedFiles: session.backtrackSkippedFiles,
      backtrackTargetGitHead: session.backtrackTargetGitHead,
    });
    const outcome = completed.outcome;
    const actualEvidence = completed.actualEvidence;
    session.roundSnapshot = outcome.snapshot;
    const pr = outcome.result;
    // v2.12: Clarification streak tracking — independent of rejection tracking.
    // Reset on rounds without intent_drift; track substantive vs weak clarifications.
    this.updateClarificationStreak(session, pr);

    // Per-rule rejection tracking: same-check rejections accumulate;
    // a different rejection reason resets the counter.
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

    return { pr, verificationFlags: pr.verificationFlags, actualEvidence };
  }

  /** v2.12: Update the clarification streak based on the round result.
   *  - Substantive clarification (anchors present): keep streak — genuine pivot.
   *  - No intent_drift this round: reset streak to 0.
   *  - Weak clarification rejected by R7: streak was already consumed by
   *    enforceIntentDrift to decide reject vs terminate; staleness is handled
   *    on the enforcement side. We sync the persisted counter for crash recovery.
   *  v3.2.1: when a HIGHER-PRIORITY rule (R1–R6/R8/R9/R-EVID) rejected the
   *  round, R7 never participated — clarificationAccepted is undefined (it
   *  is only set on the continue path). Touching the streak there would
   *  pollute it with rejections unrelated to drift and terminate the loop
   *  one weak clarification early.
   *  MUTATES: session.driftClarificationStreak */
  private updateClarificationStreak(
    session: McpSession,
    pr: RoundProcessResult,
  ): void {
    const hasIntentDrift = pr.verificationFlags.some(
      (f) => f.check === "intent_drift",
    );

    if (!hasIntentDrift) {
      // No drift this round — reset streak
      session.driftClarificationStreak = 0;
      return;
    }

    // R7 did not participate in this round's decision (a higher-priority
    // rule rejected/accepted first) — leave the streak untouched.
    if (pr.clarificationAccepted === undefined) return;

    // v2.12: Clarification accepted with anchors → substantive pivot.
    // Keep streak as-is (don't increment for genuine explanations).
    if (pr.clarificationAccepted) {
      return;
    }

    // R7 rejected (weak or no clarification). The enforcement gate
    // already used the streak to decide reject vs terminate.
    // Increment the persisted counter so crash recovery sees it.
    session.driftClarificationStreak += 1;
  }

  /** Build a rejection result: compile a retry prompt, persist, return.
   *  MUTATES: session.roundSnapshot, session.currentPrompt, session.currentLevel */
  private async buildRejectionResult(
    sessionId: string,
    session: McpSession,
    pr: RoundProcessResult,
    verificationFlags: VerificationFlag[],
  ): Promise<AdvanceResult> {
    const retryRequest = buildLoopRequest(session, undefined, verificationFlags);
    const preparedRetry = await new RoundDriver(
      session.engine,
      this.store,
    ).prepareRetry(
      retryRequest,
      session.roundSnapshot!,
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
        roundId: session.roundSnapshot?.roundId,
        prompt: null,
        stopReason: "stalled",
        stopDetail: "RoundDriver.prepareRetry returned null — the retry prompt could not be compiled.",
      };
    }
    session.roundSnapshot = preparedRetry.snapshot;
    session.currentPrompt = preparedRetry.prompt;
    session.currentLevel = preparedRetry.level;
    session.currentWarnings = preparedRetry.warnings ?? [];
    session.lastCompileResponse = preparedRetry.compileResponse ?? null;
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

  /** v2.10: Build a backtrack result — roll back to last clean round.
   *  Resets the round counter to the restore target + 1, merges preserved
   *  discoveries, compiles from the restored state, and injects the
   *  backtrack prompt at the top.
   *  MUTATES: session.currentRound, session.roundSnapshot,
   *           session.currentPrompt, session.currentLevel,
   *           session.consecutiveRejections, session.lastSelfEval */
  private async buildBacktrackResult(
    sessionId: string,
    session: McpSession,
    pr: RoundProcessResult,
  ): Promise<AdvanceResult> {
    // v3.3.1: wire up engine.backtrack_auto_restore — the v2.13 policy
    // switch promised automatic workspace recovery and never had an
    // implementation (the flag had zero consumers, so setting it changed
    // nothing). When enabled: stash every uncommitted change (tracked +
    // untracked — nothing destroyed) and hard-reset to the restore point
    // commit so the failed rounds' state is gone before the agent redoes
    // the round. DANGEROUS by design and off by default; when off, the
    // prompt instructs manual restore and the verification gate enforces it.
    if (getPolicy().engine.backtrack_auto_restore) {
      const outcome = await runBacktrackAutoRestore(
        pr.backtrackTargetGitHead,
        session.currentRound,
      );
      logEvent("backtrack_auto_restore", {
        sessionId,
        loopId: session.loopId,
        fromRound: session.currentRound,
        ok: outcome.ok,
        detail: outcome.detail,
      });
    }

    const restoreTarget = pr.backtrackTarget ?? (session.currentRound - 1);
    const newRound = restoreTarget + 1;

    logEvent("session_backtrack", {
      sessionId,
      loopId: session.loopId,
      fromRound: session.currentRound,
      toRound: newRound,
      triggerRule: pr.backtrackTriggerRule ?? "",
      skippedDiscoveries: (pr.backtrackSkippedDiscoveries ?? []).length,
    });

    // Reset session to the restored round
    session.currentRound = newRound;
    session.consecutiveRejections = 0;
    session.lastRejectionCheck = "";
    session.driftClarificationStreak = 0;
    session.backtrackSkippedFiles = pr.backtrackSkippedFiles ?? [];
    // v2.12: Remember the restore point's git HEAD — the next round's
    // verification gate confirms the workspace returned to this commit.
    session.backtrackTargetGitHead = pr.backtrackTargetGitHead;
    session.lastSelfEval = undefined; // force L2 recompile from vault state
    session.currentPrompt = null;

    // Preserve discoveries from skipped rounds as constraints_from_plan
    // so they survive the compilation and re-enter active constraints.
    const preservedDiscoveries = pr.backtrackSkippedDiscoveries ?? [];

    // Compile the restored prompt — use a fresh request with the restored round
    const request: LoopForgeRequest = {
      task: session.task,
      mode: Mode.LOOP_COMPILE,
      feedback: null,
      skill_name: null,
      task_id: null,
      loop_id: session.loopId,
      round: newRound,
      max_rounds: session.maxRounds,
      verification_flags: pr.verificationFlags,
      constraints_from_plan: preservedDiscoveries,
    };

    const prepared = await new RoundDriver(
      session.engine,
      this.store,
    ).prepare(
      request,
      session.loopId,
      newRound,
    );

    if (!prepared || !prepared.prompt) {
      session.status = "stalled";
      session.currentPrompt = null;
      this.save(session);
      return {
        sessionId,
        round: newRound,
        prompt: null,
        stopReason: "stalled",
        stopDetail: "Backtrack failed: RoundDriver.prepare returned null — could not compile from restore point.",
        enforcementAction: "backtrack",
        enforcementReason: pr.enforcementReason,
      };
    }

    // Inject backtrack prompt at the top of the compiled prompt
    const backtrackHeader = pr.backtrackPrompt ?? "";
    const fullPrompt = backtrackHeader
      ? backtrackHeader + "\n" + (prepared.prompt ?? "")
      : prepared.prompt ?? "";

    session.evidenceBaseline = prepared.evidenceBaseline;
    session.roundSnapshot = prepared.snapshot;
    session.currentPrompt = fullPrompt;
    session.currentLevel = prepared.level;
    session.currentWarnings = prepared?.warnings ?? [];
    session.lastCompileResponse = prepared?.compileResponse ?? null;
    this.save(session);

    return {
      sessionId,
      round: newRound,
      roundId: session.roundSnapshot?.roundId,
      prompt: fullPrompt,
      level: prepared.level,
      enforcementAction: "backtrack",
      enforcementReason: pr.enforcementReason,
      warnings: prepared?.warnings ?? [],
    };
  }

  /** Build a termination result: persist stopped status, notify sinks.
   *  MUTATES: session.status, session.currentPrompt */
  private buildTerminationResult(
    sessionId: string,
    session: McpSession,
    pr: RoundProcessResult,
  ): AdvanceResult {
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
      roundId: session.roundSnapshot?.roundId,
      prompt: null,
      stopReason: "enforcement_terminated",
      stopDetail: pr.enforcementReason ?? "The enforcement gate terminated the loop.",
      enforcementAction: "terminate",
      enforcementReason: pr.enforcementReason,
    };
  }

  /** Build a stop result: persist stopped/stalled status, notify sinks.
   *  MUTATES: session.status, session.currentPrompt */
  private buildStopResult(
    sessionId: string,
    session: McpSession,
    pr: RoundProcessResult,
  ): AdvanceResult {
    const reason = pr.stopReason ?? "stalled";
    session.status = reason === "stalled" ? "stalled" : "stopped";
    session.currentPrompt = null;
    this.save(session);
    void this.notifyTerminal(session, reason);
    logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: reason, round: session.currentRound });
    return {
      sessionId, round: session.currentRound,
      roundId: session.roundSnapshot?.roundId,
      prompt: null, stopReason: reason,
      stopDetail: pr.stopReason === "max_rounds"
          ? "The configured maximum number of rounds has been reached."
          : `Loop stopped: ${reason}.`,
      roundSuccess: pr.roundSuccess,
    };
  }

  /** Compile the next round's prompt and advance the session.
   *  Includes the commit fence (pause/delete race guard) and context provider.
   *  MUTATES: session.currentRound, session.currentPrompt, session.currentLevel,
   *           session.evidenceBaseline, session.roundSnapshot */
  private async advanceToNextRound(
    sessionId: string,
    session: McpSession,
    selfEval: SelfEvaluation,
    pr: RoundProcessResult,
    verificationFlags: VerificationFlag[],
    actualEvidence: ProviderSnapshot[],
  ): Promise<AdvanceResult> {
    const roundSuccess = pr.roundSuccess;
    session.currentRound++;
    session.currentPrompt = null;
    // v2.13: Clear backtrack skipped files after advancing past the restore round
    session.backtrackSkippedFiles = [];
    // v2.12: The restore-point git HEAD check only applies to the first
    // post-backtrack round — clear it once we advance past it.
    session.backtrackTargetGitHead = undefined;

    // v1.8: Memory injection — tier-aware external context.
    const contextProvider = this.getContext();
    let externalCtx = "";
    if (contextProvider) {
      try {
        externalCtx = (await contextProvider({
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

    // Commit fence: pause()/delete() may have run while the context provider
    // was awaited. Do not compile if the session is no longer running.
    if (this.registry.get(sessionId) !== session || session.status !== "running") {
      return {
        sessionId,
        round: session.currentRound,
        prompt: null,
        stopReason: session.status,
        stopDetail: `Session is no longer running (status: ${session.status}). It was paused or deleted while the context provider was running.`,
        roundSuccess,
      };
    }

    const request = buildLoopRequest(session, selfEval, verificationFlags);
    if (externalCtx) {
      request.external_context = externalCtx;
    }
    const prepared = await new RoundDriver(
      session.engine,
      this.store,
    ).prepare(
      request,
      session.loopId,
      session.currentRound,
    );
    const nextPrompt = prepared?.prompt ?? null;
    const nextLevel = prepared?.level ?? "l2";
    const nextBaseline = prepared?.evidenceBaseline ?? actualEvidence;
    session.evidenceBaseline = nextBaseline;
    session.roundSnapshot = prepared?.snapshot ?? prepareRoundTransaction(
      session.loopId,
      session.currentRound,
      nextBaseline,
    );
    session.currentPrompt = nextPrompt;
    session.currentLevel = nextLevel;
    session.currentWarnings = prepared?.warnings ?? [];
    session.lastCompileResponse = prepared?.compileResponse ?? null;
    policyMetrics.recordStrategy(session.loopId, nextLevel);
    this.save(session);

    return {
      sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot.roundId,
      prompt: nextPrompt,
      level: nextLevel,
      roundSuccess,
      warnings: prepared?.warnings ?? [],
    };
  }

  private async advanceUnlocked(
    sessionId: string,
    output: string,
    preExtractedEval?: SelfEvaluation,
    roundId?: string,
  ): Promise<AdvanceResult> {
    // ── 1. Validate session ──────────────────────────────────────────────
    const session = this.registry.get(sessionId);
    if (!session) return { sessionId, round: 0, prompt: null, stopReason: "session_not_found", stopDetail: "No session exists with this ID. It may have expired, been deleted, or never existed." };
    if (session.status !== "running" && session.status !== "stalled") {
      return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status, stopDetail: `Session is ${session.status}. Use loopforge_resume to restart a paused session, or loopforge_start for a new task.` };
    }
    // A stalled compiler preparation is retryable against the same held
    // round. Format errors never set this status; they return before advance.
    if (session.status === "stalled") {
      session.status = "running";
    }

    // ── 1.5 Anchor the submission to the round it reports on ─────────────
    // v3.0.1: a submission whose roundId no longer matches the current round
    // is stale — the round it reported on already committed (lost response,
    // duplicate call). Never process it against the current round; return the
    // held prompt so the agent recovers the response it missed. The reject
    // path keeps the same roundId (prepareRejectedAttempt), so retries of a
    // rejected round match normally.
    const expectedRoundId = session.roundSnapshot?.roundId
      ?? makeRoundId(session.loopId, session.currentRound);
    if (roundId !== undefined && roundId !== expectedRoundId) {
      logEvent("stale_round_id", {
        sessionId,
        loopId: session.loopId,
        submitted: roundId,
        expected: expectedRoundId,
      });
      const restored = this.restoredPromptResult(session);
      if (restored) {
        return {
          ...restored,
          warnings: [
            ...(restored.warnings ?? []),
            `Submitted roundId ${roundId} does not match the current round (${expectedRoundId}) — the round it reported on has already committed. Reusing the held prompt for round ${session.currentRound}; resubmit with its roundId when the work is done.`,
          ],
        };
      }
      return {
        sessionId,
        round: session.currentRound,
        roundId: expectedRoundId,
        prompt: null,
        stopReason: "stale_round_id",
        stopDetail: `Submitted roundId ${roundId} does not match the current round ${expectedRoundId}, and no prompt is currently held. Call loopforge_status or loopforge_resume to re-anchor.`,
      };
    }

    // ── 2. Extract self-evaluation ───────────────────────────────────────
    const extracted = this.extractEvaluation(output, preExtractedEval);
    if (!extracted) {
      return {
        sessionId,
        round: session.currentRound,
        roundId: session.roundSnapshot?.roundId
          ?? makeRoundId(session.loopId, session.currentRound),
        prompt: null,
        stopReason: "evaluation_invalid",
        stopDetail: "A structured evaluation object is required. Resubmit the same roundId with success, output_summary, constraint_violations, and should_continue.",
      };
    }
    const selfEval = extracted;

    // ── 3. Execute round transaction ─────────────────────────────────────
    const tx = await this.executeRoundTransaction(session, selfEval);

    // v2.12: Record a user gate when an accepted round reports a high-risk
    // blocker. Record layer only — never blocks the round decision flow.
    if (tx.pr.action !== "reject" && tx.pr.action !== "terminate" &&
        selfEval.outcome === "blocked" && typeof selfEval.blocker === "string") {
      this.recordGateFromBlocked(session, selfEval.blocker);
    }

    // ── 4. Route disposition ─────────────────────────────────────────────
    if (tx.pr.action === "reject") {
      return this.buildRejectionResult(sessionId, session, tx.pr, tx.verificationFlags);
    }

    // ── v2.10: Backtrack — roll back to last clean round ──────────────────
    if (tx.pr.action === "backtrack") {
      return this.buildBacktrackResult(sessionId, session, tx.pr);
    }

    // Accepted rounds advance the before-snapshot baseline. Rejected rounds
    // retain the original baseline so their retry remains zero-commit.
    session.evidenceBaseline = tx.actualEvidence;

    if (tx.pr.action === "terminate") {
      return this.buildTerminationResult(sessionId, session, tx.pr);
    }
    if (tx.pr.action === "stop") {
      return this.buildStopResult(sessionId, session, tx.pr);
    }

    // ── 5. Continue — compile next round ─────────────────────────────────
    return this.advanceToNextRound(
      sessionId, session, selfEval, tx.pr, tx.verificationFlags, tx.actualEvidence,
    );
  }

  /** Core cycle entry used by SessionManager.advance after the queue + lease
   *  dance: validate → extract → execute transaction → route disposition
   *  → advance to next round (continue) or return terminal result.
   *  @param roundId v3.0.1: the roundId of the round this submission reports
   *    on (from the last start/next/resume response). Anchors the submission;
   *    a stale or duplicate submission returns the held prompt instead of
   *    being processed. Optional — when absent the anchor check is skipped. */
  async advance(
    sessionId: string,
    output: string,
    preExtractedEval?: SelfEvaluation,
    roundId?: string,
  ): Promise<AdvanceResult> {
    return this.advanceUnlocked(sessionId, output, preExtractedEval, roundId);
  }

  /** Write back loop knowledge to long-term memory.
   *  Uses shared base builder from policy.ts. Called when a loop terminates. */
  async notifyTerminal(
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
}
