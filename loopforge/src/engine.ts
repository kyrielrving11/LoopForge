/** LoopForge-loop_compile — Engine (outer loop manager).
 *
 * 2-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeFeedback.
 * Enforcement gates prevent infinite stall loops; EngineMetrics records
 * silent-failure counters for observability.
 */

import { randomUUID } from "node:crypto";
import { getPolicy } from "./policy.js";
import { FileLoopStore, queryLoopEntries } from "./loop-store.js";
import type { LoopStore, VaultEntry } from "./loop-store.js";
import {
  AgentStatus,
  Mode,
  makeExecutionFeedback,
  makeLoopCompileRequest,
  makeLoopObjective,
  makeLoopRoundResult,
  makeSessionState,
  makeTaskId,
  type AgentLoopResult,
  type ExecutionFeedback,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type LoopForgeRequest,
  type SelfEvaluation,
  type SessionState,
} from "./protocol.js";
import { compileLoop } from "./loop-compiler.js";
import { logEvent } from "./observability.js";
import { isRecord } from "./token-utils.js";
import { decodeCommittedRound } from "./committed-round.js";
import { policyMetrics } from "./policy-metrics.js";
import {
  parseExecutionEvidence,
  parseCriterionRevisions,
  parseSubGoalUpdates,
  parseWorkerResults,
  parsePromptRequests,
} from "./self-eval.js";
import { parseLoopExtras } from "./loop-extras-parser.js";

// ── Re-export self-evaluation utilities (moved to self-eval.ts) ──────────
export {
  parseExecutionEvidence,
  parseCriterionRevisions,
  parseWorkerResults,
  buildSelfEvaluation,
} from "./self-eval.js";

// ═══════════════════════════════════════════════════════════════════════════
// Engine Metrics
// ═══════════════════════════════════════════════════════════════════════════

/** A single sub-agent delegation record (v1.9 — AgentTool mode).
 *  v3.7.1: outcome is the single fact; success is deleted. */
export interface DelegationEntry {
  index: number;
  agentId: string;
  subAgentType: string;
  subTask: string;
  resultSummary: string;
  outcome: "success" | "partial" | "failed";
  discoveredConstraints: string[];
}

export interface EngineMetrics {
  vaultWriteErrors: number;
  sessionStart: number;
}

function makeEngineMetrics(): EngineMetrics {
  return {
    vaultWriteErrors: 0,
    sessionStart: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LoopForgeEngine
// ═══════════════════════════════════════════════════════════════════════════

export class LoopForgeEngine {
  state: SessionState | null = null;
  private store: LoopStore | null = null;
  private metrics: EngineMetrics | null = null;
  lastTask: string | null = null;

  constructor(store?: LoopStore) {
    this.store = store ?? null;
  }

  private resolveStore(): LoopStore {
    if (this.store === null) {
      this.store = new FileLoopStore(getPolicy().backend.root_dir);
    }
    return this.store;
  }

  /** Public accessor for the loop store — used by the round transaction
   *  coordinator and round driver. */
  getStore(): LoopStore {
    return this.resolveStore();
  }

  /** Expose engine health counters for observability (MCP status, logging). */
  getMetrics(): EngineMetrics {
    if (this.metrics === null) {
      this.metrics = makeEngineMetrics();
    }
    return this.metrics;
  }

  private ensureInit(request: LoopForgeRequest): void {
    if (this.state === null) {
      this.state = makeSessionState(
        request.task_id || makeTaskId(request.task),
      );
    }
    if (this.metrics === null) {
      this.metrics = makeEngineMetrics();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Feedback persistence
  // ═══════════════════════════════════════════════════════════════════════

  private persistFeedbackToVault(signal: Record<string, unknown>): boolean {
    if (this.metrics === null) {
      this.metrics = makeEngineMetrics();
    }
    // v2.6: write directly — the buffer was always flushed immediately
    // (autoFeedback calls persistFeedbackToVault then immediately flushFeedbackBuffer).
    const entry = this.buildFeedbackEntry(signal);
    if (!entry) return false;
    try {
      this.resolveStore().appendEntry(entry);
      // v3.3.1: a feedback write that replaces an already-cached round
      // (a backtrack redo reuses the same roundId, per the v3.2.1 replace
      // semantics) leaves the hydration cache holding the stale merged
      // entry — coveredRound has already passed that round, so the
      // incremental path never re-reads it and the compiler would keep
      // seeing the rolled-back decision (forced L2, stale state) for the
      // rest of the process. Invalidate so the next compile rehydrates.
      this.invalidateHydrationCacheForFeedback(String(entry.task_id ?? ""));
      return true;
    } catch (error) {
      if (this.metrics) this.metrics.vaultWriteErrors++;
      console.warn(`LoopForge: vault write failed (feedback_persist) — ${error}`);
      logEvent("vault_write_error", { error: "feedback_persist" });
      policyMetrics.recordVaultWriteError("feedback_persist");
      return false;
    }
  }

  private buildFeedbackEntry(signal: Record<string, unknown>): VaultEntry | null {
    try {
      return {
        id: randomUUID(),
        task_id: (signal.task_id as string) ?? "feedback",
        version_tag: "v1",
        is_active: true,
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, ""),
        user_intent: String(signal.task_type ?? "").slice(0, 200),
        success: (signal.success as boolean) ?? false,
        execution_feedback: JSON.stringify({
          success: signal.success ?? false,
          status: (signal.success as boolean) ? "success" : "partial",
          constraint_compliance: {
            all_hard_constraints_met: !Array.isArray(signal.violations) || (signal.violations as unknown[]).length === 0,
            violations: signal.violations ?? [],
          },
          output_summary: signal.task_type ?? "",
          improvement_notes: signal.manual_fixes ?? "",
        }),
        task_type: (signal.task_type as string) ?? "",
        tags: signal.skill_used ? [signal.skill_used as string] : [],
        skill_used: (signal.skill_used as string) ?? "",
        loop_id: signal.loop_id as string | undefined,
        loop_lineage: (signal.loop_lineage as Record<string, unknown>) ?? {},
        // Persist execution_evidence so the enforcement gate (R4/R5) can
        // read progress_estimate from vault entries across rounds.
        execution_evidence: signal.execution_evidence ?? null,
        discovered_constraints: signal.discovered_constraints ?? [],
        emerged_subtasks: signal.emerged_subtasks ?? [],
        // v3.7.1: explicit transitions persist on committed entries so the
        // compiler replays them in round order on every derivation.
        subgoal_updates: signal.subgoal_updates ?? [],
        retracted_constraints: signal.retracted_constraints ?? [],
        worker_results: signal.worker_results ?? [],
      };
    } catch {
      if (this.metrics) this.metrics.vaultWriteErrors++;
      logEvent("vault_write_error", { error: "feedback_entry_build" });
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Lineage persistence
  // ═══════════════════════════════════════════════════════════════════════

  private persistLoopLineage(
    response: LoopCompileResponse,
    request: LoopCompileRequest,
  ): boolean {
    if (this.metrics === null) this.metrics = makeEngineMetrics();

    const loopObjDict = response.loop_objective
      ? (response.loop_objective as unknown as Record<string, unknown>)
      : null;

    const structuredLineage: Record<string, unknown> = {
      loop_id: response.loop_id,
      round: response.round,
      goal_id: response.goal_id,
      goal_text_hash: response.goal_text_hash,
      recompile_level: response.recompile_level,
      constraints_active: response.constraints_active,
      task: request.task,
      success: true,
    };

    // v3.2: Persist what this round's prompt actually presented (L1 only —
    // L0/L2 compiles leave the artifact field undefined). The next L1 compile
    // reads these as its collapse diff baseline. Field extension of the
    // existing lineage entry — no new persistence format.
    const presented = response.prompt_artifact?.presentedState;
    if (presented) {
      structuredLineage.presented_constraint_ids = presented.constraintIds;
      structuredLineage.presented_subgoals = presented.subGoals;
      structuredLineage.presented_milestone_ranges = presented.milestoneRanges;
    }

    let lastOutputSummary = "";
    let lastViolations: string[] = [];
    if (request.last_round_result) {
      lastOutputSummary = request.last_round_result.output_summary || "";
      lastViolations = request.last_round_result.constraint_violations || [];
    }

    const entry: VaultEntry = {
      id: randomUUID(),
      task_id: `loop:${response.loop_id}:r${response.round}`,
      version_tag: "v1",
      is_active: true,
      timestamp: new Date().toISOString().replace(/\.\d+Z$/, ""),
      user_intent: `loop_compile round ${response.round} — ${response.goal_id}`,
      task_type: "loop_lineage",
      loop_id: response.loop_id,
      loop_lineage: structuredLineage,
      loop_objective: loopObjDict,
      task: request.task,
      output_summary: lastOutputSummary,
      constraint_violations: lastViolations,
      tags: [response.loop_id, response.recompile_level, response.goal_id],
    };

    // 1. JSON vault write (primary)
    let vaultOk = false;
    try {
      this.resolveStore().appendEntry(entry);
      vaultOk = true;
    } catch (error) {
      if (this.metrics) this.metrics.vaultWriteErrors++;
      console.warn(`LoopForge: vault write failed (lineage_persist) — ${error}`);
      logEvent("vault_write_error", { error: "persist_lineage_json" });
      policyMetrics.recordVaultWriteError("lineage_persist");
    }

    return vaultOk;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Delegation journal (v1.9 — AgentTool mode)
  // ═══════════════════════════════════════════════════════════════════════

  /** Record sub-agent delegations for this round into the vault.
   *  Written as a lightweight journal entry so the main agent's rolling
   *  summary can reference delegation history in subsequent rounds. */
  recordDelegation(
    loopId: string,
    round: number,
    entries: DelegationEntry[],
  ): void {
    if (!entries.length) return;
    const taskId = `loop:${loopId}:r${round}:delegations`;
    const existing = queryLoopEntries(this.resolveStore(), loopId, { prefix: taskId })
      .some((candidate) => candidate.task_id === taskId);
    if (existing) return;
    const entry: VaultEntry = {
      id: randomUUID(),
      task_id: taskId,
      version_tag: "v1",
      is_active: true,
      timestamp: new Date().toISOString().replace(/\.\d+Z$/, ""),
      user_intent: `Delegation journal — round ${round}`,
      task_type: "delegation_journal",
      loop_id: loopId,
      loop_lineage: {
        round,
        delegations: entries.map((e) => ({
          index: e.index,
          agentId: e.agentId,
          subAgentType: e.subAgentType,
          subTask: e.subTask,
          resultSummary: e.resultSummary,
          outcome: e.outcome,
          discoveredConstraints: e.discoveredConstraints,
        })),
      },
    };
    try {
      this.resolveStore().appendEntry(entry);
    } catch (error) {
      if (this.metrics) this.metrics.vaultWriteErrors++;
      console.warn(`LoopForge: vault write failed (delegation_persist) — ${error}`);
      logEvent("vault_write_error", { error: "record_delegation" });
      policyMetrics.recordVaultWriteError("delegation_persist");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Hydrate loop context from vault
  // ═══════════════════════════════════════════════════════════════════════

  /** Eval-owned fields merged from the committed round decision onto the
   *  lineage entry. These are the agent's report of what happened during the
   *  round; compile-time lineage fields (constraints_active, goal_text_hash,
   *  recompile_level, …) are left untouched. */
  private static readonly EVAL_MERGED_LINEAGE_FIELDS = [
    "execution_evidence",
    "compression_checkpoint",
    "checkpoint_label",
    "discovered_constraints",
    "emerged_subtasks",
    "subgoal_updates",
    "retracted_constraints",
    "wrong_assumptions",
    "next_action",
    "objective_refinement",
    "outcome",
    "blocker",
    "drift_clarification",
    "revised_success_criteria",
    "worker_results",
    "prompt_requests",
    "round_contract",
  ] as const;

  /** Merge the committed round decision (feedback entry) into the compile-time
   *  lineage entry so the compiler and projections see the full per-round
   *  truth: verification flags, round success, and the agent's own evaluation. */
  private mergeCommittedRound(
    entry: VaultEntry,
    lineage: Record<string, unknown>,
    fb: VaultEntry,
  ): void {
    const committed = decodeCommittedRound(fb);
    const result = committed?.result ?? null;
    const evaluation = committed?.evaluation ?? null;

    if (result) {
      if (
        Array.isArray(result.verificationFlags) &&
        result.verificationFlags.length > 0
      ) {
        entry.verification_flags = result.verificationFlags;
      }
      if (typeof result.roundSuccess === "boolean") {
        entry.success = result.roundSuccess;
        lineage.success = result.roundSuccess;
      }
      // The committed decision's action — lets the compiler detect a
      // post-backtrack recovery boundary (L2 rehydration) without a
      // second persistence format.
      lineage.committed_action = result.action;
      // v3.7.1: Recovery Brief facts stamped onto the merged lineage entry
      // (same derived-stamp pattern as attempt/round_evidence — in-memory
      // only, never persisted; a fresh hydration re-derives them from the
      // committed rollback decision). Compile-time views need them on the
      // merged row because raw feedback documents are never exposed.
      if (result.action === "backtrack") {
        if (typeof result.backtrackTarget === "number") {
          lineage.backtrackTarget = result.backtrackTarget;
        }
        if (typeof result.backtrackTriggerRule === "string") {
          lineage.backtrackTriggerRule = result.backtrackTriggerRule;
        }
        if (Array.isArray(result.backtrackFailedRounds)) {
          lineage.backtrackFailedRounds = result.backtrackFailedRounds;
        }
        if (Array.isArray(result.backtrackApproaches)) {
          lineage.backtrackApproaches = result.backtrackApproaches;
        }
        if (Array.isArray(result.backtrackWrongAssumptions)) {
          lineage.backtrackWrongAssumptions = result.backtrackWrongAssumptions;
        }
      }
    }
    if (committed) {
      // v3.5.1: compile-side display readers (Round Stats rejected attempts,
      // the Machine (git) dashboard row) never see raw :feedback entries —
      // only this merged view — so the machine-observed data they need is
      // stamped here. In-memory only (hydration cache; disk lineage entries
      // never carry the stamp — a fresh hydration re-derives it identically
      // from the feedback entry's transaction snapshot).
      lineage.attempt = committed.attempt;
      if (committed.roundEvidence.length > 0) {
        lineage.round_evidence = committed.roundEvidence;
      }
    }
    if (!evaluation) return;
    for (const key of LoopForgeEngine.EVAL_MERGED_LINEAGE_FIELDS) {
      const value = evaluation[key];
      if (value === undefined) continue;
      lineage[key] = value;
      entry[key] = value;
    }
    if (typeof evaluation.success === "boolean") {
      entry.success = evaluation.success;
      lineage.success = evaluation.success;
    }
    if (typeof evaluation.output_summary === "string" && evaluation.output_summary) {
      entry.output_summary = evaluation.output_summary;
    }
    if (Array.isArray(evaluation.constraint_violations)) {
      entry.constraint_violations = evaluation.constraint_violations;
    }
  }

  /** v3.0.1: Per-engine hydration cache. The vault is append-only per round —
   *  between two compiles of one loop only the newest round(s) changed. The
   *  cache holds the merged lineage entries (the exact shape the compiler
   *  consumes; feedback bodies are merged in, never returned), so a long-lived
   *  process compiles incrementally: one round document read per round
   *  boundary instead of the full history. Nothing is persisted; a fresh
   *  engine hydrates fully once. `coveredRound` is the highest CONTIGUOUS
   *  COMMITTED round (feedback merged) whose entries are in the cache — the
   *  compiler only reads rounds below the compile round, so
   *  `coveredRound >= round - 1` means the cache is complete for that compile.
   *  Lineage-only entries of not-yet-committed rounds may trail the cache but
   *  never advance coveredRound (a later read replaces them post-commit). */
  private hydrationCache: {
    loopId: string;
    coveredRound: number;
    entries: VaultEntry[];
  } | null = null;

  /** v3.7.1: Drop the hydration cache after a committed BACKTRACK decision.
   *  The rollback commits as the CURRENT round (cache.coveredRound + 1), so
   *  the normal incremental path never re-reads it before the restore
   *  compile — which targets the SAME round and must see the rollback
   *  immediately (recovery-boundary L2, Recovery Brief facts). One full
   *  rehydrate on the rare rollback path is the correct trade. */
  invalidateHydrationCache(loopId: string): void {
    if (this.hydrationCache?.loopId === loopId) this.hydrationCache = null;
  }

  /** v3.3.1: Drop the hydration cache when a feedback write targets a round
   *  the cache has already merged (coveredRound >= round). Cache entries are
   *  LINEAGE task_ids (loop:…:rN), so a task_id collision test could never
   *  fire for feedback writes (loop:…:rN:feedback) — the round number is the
   *  real collision signal. A backtrack redo reuses the roundId and REPLACES
   *  the round's committed feedback (v3.2.1 semantics); without this the
   *  fast path (coveredRound >= compileRound - 1) would serve the stale
   *  rolled-back entry for the rest of the process. A genuinely new round
   *  (round = coveredRound + 1) lands past the cache point and is merged by
   *  the next incremental read — no invalidation. Lineage writes never
   *  invalidate: they precede the commit by design. */
  private invalidateHydrationCacheForFeedback(taskId: string): void {
    const cache = this.hydrationCache;
    if (!cache) return;
    const round = LoopForgeEngine.feedbackRound(taskId);
    if (round !== null && cache.coveredRound >= round) {
      this.hydrationCache = null;
    }
  }

  /** The round a feedback entry belongs to, or null. */
  private static feedbackRound(taskId: string): number | null {
    const parts = taskId.split(":r");
    if (parts.length < 2) return null;
    const roundStr = parts[1].split(":")[0];
    const round = parseInt(roundStr, 10);
    return Number.isNaN(round) ? null : round;
  }

  /** Highest contiguous round (from 1) present in the given feedback entries. */
  private static contiguousCommittedRound(fbEntries: VaultEntry[]): number {
    const committed = new Set<number>();
    for (const fe of fbEntries) {
      const round = LoopForgeEngine.feedbackRound(String(fe.task_id ?? ""));
      if (round !== null) committed.add(round);
    }
    let covered = 0;
    while (committed.has(covered + 1)) covered++;
    return covered;
  }

  /** Merge committed feedback entries into lineage entries and apply the
   *  canonical output_summary / constraint_violations projection. Shared by the
   *  full and incremental hydration paths so both produce identical shapes.
   *
   *  The round commit entry (`loop:<id>:r<N>:feedback`) carries the full
   *  committed decision — verification flags, round success, and the agent's
   *  SelfEvaluation — which the compiler needs to derive milestones,
   *  constraint decay, sub-goal accumulation, and rolling summaries. Without
   *  this merge the cross-round features only see the 8 compile-time lineage
   *  fields. */
  private buildMergedEntries(
    fresh: VaultEntry[],
    fbFresh: VaultEntry[],
  ): VaultEntry[] {
    const fbByRound = new Map<number, VaultEntry>();
    for (const fe of fbFresh) {
      const fbRound = LoopForgeEngine.feedbackRound(String(fe.task_id ?? ""));
      if (fbRound !== null) fbByRound.set(fbRound, fe);
    }

    for (const entry of fresh) {
      // v3.7: the legacy top-level `lineage` alias was removed.
      // Only compile-lineage rows absorb the committed round's feedback.
      // Delegation journals (`loop:<id>:r<N>:delegations`) share the same
      // lineage.round and would otherwise decode as a SECOND round view —
      // double-counting violations/lessons for one committed round.
      if (entry.task_type !== "loop_lineage") continue;
      const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
      const rnd = lineage.round as number;
      const fb = rnd ? fbByRound.get(rnd) : undefined;
      if (fb) this.mergeCommittedRound(entry, lineage, fb);
      if (!entry.output_summary) {
        entry.output_summary = (lineage.output_summary as string) ?? "";
      }
      if (!entry.constraint_violations) {
        entry.constraint_violations =
          (lineage.constraint_violations as string[]) ?? [];
      }
    }
    return fresh;
  }

  hydrateLoopContext(loopId: string, round?: number): Record<string, unknown> | null {
    const store = this.resolveStore();
    const prefix = `loop:${loopId}:r`;

    // v3.0.1: cached hydration — fast path when the cache already covers the
    // requested round (same-round retries), incremental read of only the
    // rounds committed since the cache point otherwise.
    if (round !== undefined && this.hydrationCache?.loopId === loopId) {
      const cache = this.hydrationCache;
      if (cache.coveredRound >= round - 1) {
        return { results: cache.entries, global_entries: [] };
      }
      const sinceRound = cache.coveredRound + 1;
      const fresh = queryLoopEntries(store, loopId, { prefix, sinceRound });
      const freshFb = queryLoopEntries(store, loopId, {
        prefix,
        sinceRound,
        feedbackOnly: true,
      });
      const merged = this.buildMergedEntries(fresh, freshFb);
      for (const entry of merged) {
        const tid = String(entry.task_id ?? "");
        // Replace-by-task_id: a round read earlier as a lineage-only entry
        // (not yet committed) must be replaced by its post-commit merged
        // version — a stale unmerged entry would silently drop the round's
        // committed decision (verification flags, committed_action, eval).
        const index = cache.entries.findIndex((e) => String(e.task_id ?? "") === tid);
        if (index >= 0) cache.entries[index] = entry;
        else cache.entries.push(entry);
      }
      // Advance coveredRound only for rounds that actually committed since
      // the cache point — the fresh reads start at coveredRound + 1, so the
      // contiguous run extends from there.
      const freshCommitted = new Set<number>();
      for (const fe of freshFb) {
        const r = LoopForgeEngine.feedbackRound(String(fe.task_id ?? ""));
        if (r !== null) freshCommitted.add(r);
      }
      while (freshCommitted.has(cache.coveredRound + 1)) cache.coveredRound++;
      return { results: cache.entries, global_entries: [] };
    }

    // Full path — cold engine, different loop, or a round-less hydrate (e.g.
    // health checks). Merge all feedback entries, dedupe by task_id (round
    // documents hold the latest write per key), and cache the merged view.
    // coveredRound counts only contiguous COMMITTED rounds — lineage-only
    // entries of uncommitted rounds may trail the cache but must not make the
    // fast path serve unmerged state.
    const results = queryLoopEntries(store, loopId, { prefix });
    const fbEntries = queryLoopEntries(store, loopId, { prefix, feedbackOnly: true });
    const merged = this.buildMergedEntries(results, fbEntries);
    if (!merged.length) return null;
    const byTaskId = new Map<string, VaultEntry>();
    for (const entry of merged) byTaskId.set(String(entry.task_id ?? ""), entry);
    const entries = [...byTaskId.values()];
    this.hydrationCache = {
      loopId,
      coveredRound: LoopForgeEngine.contiguousCommittedRound(fbEntries),
      entries,
    };
    return { results: entries, global_entries: [] };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Feedback (public)
  // ═══════════════════════════════════════════════════════════════════════

  invokeFeedback(
    request: LoopForgeRequest,
    _hydrateResults?: Record<string, unknown> | null,
  ): AgentLoopResult {
    this.ensureInit(request);
    this.lastTask = request.task;

    const fb = request.feedback;
    if (!fb) {
      return {
        status: AgentStatus.ERROR,
        response: {
          status: AgentStatus.ERROR,
          prompt: null,
          error: "Feedback mode requires a feedback payload.",
        },
      };
    }

    const success = fb.success;
    const violations = fb.constraint_violations ?? [];
    const fixes = fb.manual_fixes_needed ?? "";

    // Loop-aware task_id for feedback→lineage backfill
    const loopId = (request as Record<string, unknown>).loop_id as
      | string
      | undefined;
    const loopRound = (request as Record<string, unknown>).round as
      | number
      | undefined;
    // v2.14: feedback entries are loop-scoped — a request without loop_id
    // and round can never be persisted. Fail loudly instead of reporting
    // "Feedback Recorded" for a write that was silently dropped.
    if (!loopId || loopRound === undefined) {
      return {
        status: AgentStatus.ERROR,
        response: {
          status: AgentStatus.ERROR,
          prompt: null,
          error: "Feedback requires loop_id and round — feedback entries are loop-scoped.",
        },
      };
    }
    const taskId = `loop:${loopId}:r${loopRound}:feedback`;

    const signal: Record<string, unknown> = {
      task_id: taskId,
      task_type: request.task.slice(0, 80),
      success,
      skill_used: request.skill_name ?? "",
      violations,
      manual_fixes: fixes,
      loop_id: loopId,
      round: loopRound,
    };
    const persisted = this.persistFeedbackToVault(signal);
    if (!persisted) {
      return {
        status: AgentStatus.ERROR,
        response: {
          status: AgentStatus.ERROR,
          prompt: null,
          error: "Feedback could not be persisted to the loop store — the round was not recorded.",
        },
      };
    }

    // Update state
    this.state!.call_count++;
    this.state!.success_trend.push(success);
    if (this.state!.success_trend.length > 20) {
      this.state!.success_trend = this.state!.success_trend.slice(-20);
    }

    logEvent("round_complete", {
      success,
      loopId: loopId ?? "unknown",
      round: loopRound ?? this.state!.call_count,
    });

    return {
      status: AgentStatus.OK,
      response: {
        status: AgentStatus.OK,
        prompt: `## Feedback Recorded\n\nSuccess: ${success}\nSignals: 1`,
        error: null,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Auto-Feedback (v1.1 — autonomous loop, no human in the loop)
  // ═══════════════════════════════════════════════════════════════════════

  /** Record self-evaluation from agent output without human intervention.
   *  Converts SelfEvaluation → ExecutionFeedback → vault persistence.
   *  P0–P2: Also persists discovered_constraints, objective_refinement,
   *  and emerged_subtasks for the compiler to consume next round.
   *  Call this BEFORE invokeLoopCompile for the next round so that
   *  hydrateLoopContext picks up the latest success flags. */
  autoFeedback(
    selfEval: SelfEvaluation,
    loopId: string,
    round: number,
    task: string,
    roundTransaction?: Record<string, unknown>,
  ): boolean {
    this.ensureInit({ task, mode: Mode.FEEDBACK, feedback: null, skill_name: null, task_id: null });

    const fb: ExecutionFeedback = makeExecutionFeedback({
      output: selfEval.output_summary,
      success: selfEval.success,
      constraint_violations: selfEval.constraint_violations,
      manual_fixes_needed: "",
    });

    const taskId = `loop:${loopId}:r${round}:feedback`;
    const transactionId = typeof roundTransaction?.round_id === "string"
      ? roundTransaction.round_id
      : null;
    const transactionPersisted = (
      filter?: (entry: VaultEntry) => boolean,
    ): boolean => {
      if (!transactionId) return false;
      return queryLoopEntries(this.resolveStore(), loopId, {
        prefix: taskId,
        feedbackOnly: true,
      }).some((entry) => {
        if (entry.task_id !== taskId) return false;
        if (filter && !filter(entry)) return false;
        const lineage = entry.loop_lineage;
        const transaction = lineage?.round_transaction;
        return transaction !== null &&
          typeof transaction === "object" &&
          !Array.isArray(transaction) &&
          (transaction as Record<string, unknown>).round_id === transactionId;
      });
    };
    // v3.2.1: a committed backtrack decision is a roll-back directive, not
    // the round's outcome. The redo submission reuses the same roundId and
    // must REPLACE the backtrack entry in the vault — otherwise the stale
    // entry keeps poisoning the R4/R5 progress window and the redo's work
    // never lands (it is replayed or its data is ignored forever).
    const alreadyCommitted = transactionPersisted((entry) => {
      const transaction = isRecord(entry.loop_lineage)
        ? entry.loop_lineage.round_transaction
        : null;
      const result = isRecord(transaction) ? transaction.result : null;
      return !(isRecord(result) && result.action === "backtrack");
    });

    // Multi-agent: Merge sub-agent discovered constraints into the main constraint flow
    const subDiscovered = (selfEval.worker_results ?? [])
      .flatMap((w) => w.discoveredConstraints ?? [])
      .filter((c) => c.length > 0);
    const mergedDiscovered = [
      ...new Set([...(selfEval.discovered_constraints ?? []), ...subDiscovered]),
    ];

    const signal: Record<string, unknown> = {
      task_id: taskId,
      task_type: task.slice(0, 80),
      success: fb.success,
      skill_used: "",
      violations: selfEval.constraint_violations,
      manual_fixes: "",
      loop_id: loopId,
      round,
      // P0–P2: Evolution fields
      discovered_constraints: mergedDiscovered,
      objective_refinement: selfEval.objective_refinement ?? "",
      emerged_subtasks: selfEval.emerged_subtasks ?? [],
      // v3.7.1: explicit transitions persist with the committed evaluation;
      // the compiler replays them in round order on every derivation.
      subgoal_updates: selfEval.subgoal_updates ?? [],
      // P4: Execution evidence
      execution_evidence: selfEval.execution_evidence ?? null,
      // P5: Self-correction
      retracted_constraints: selfEval.retracted_constraints ?? [],
      revised_success_criteria: selfEval.revised_success_criteria ?? [],
      wrong_assumptions: selfEval.wrong_assumptions ?? [],
      // Multi-agent: Worker delegation results
      worker_results: selfEval.worker_results ?? [],
      // v2.12: Tri-state outcome (audit data source)
      outcome: selfEval.outcome,
      loop_lineage: roundTransaction
        ? {
            round,
            round_id: roundTransaction.round_id,
            round_transaction: roundTransaction,
          }
        : {},
    };
    if (!alreadyCommitted) {
      this.persistFeedbackToVault(signal);
      if (transactionId && !transactionPersisted()) {
        throw new Error(`Round feedback commit failed: ${transactionId}`);
      }
    }

    // Multi-agent: Auto-record delegation journal from worker_results
    if (selfEval.worker_results && selfEval.worker_results.length > 0) {
      const entries = selfEval.worker_results.map((w, i) => ({
        index: i + 1,
        agentId: w.agentId,
        subAgentType: w.subAgentType ?? "general-purpose",
        subTask: w.subTask,
        resultSummary: w.resultSummary,
        outcome: w.outcome,
        discoveredConstraints: w.discoveredConstraints ?? [],
      }));
      this.recordDelegation(loopId, round, entries);
    }

    // Replaying a committed transaction may repair derived delegation data,
    // but must never apply the feedback to mutable engine state twice.
    if (alreadyCommitted) return fb.success;

    // Update state
    this.state!.call_count++;
    this.state!.success_trend.push(fb.success);
    if (this.state!.success_trend.length > 20) {
      this.state!.success_trend = this.state!.success_trend.slice(-20);
    }

    // v2.5: Old binary-success circuit breaker removed — stalled loops
    // are now detected by the enforcement gate (R4/R5) using
    // progress_estimate gradients rather than success=true/false count.

    logEvent("round_complete", {
      loopId,
      round,
      success: fb.success,
    });

    return fb.success;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Loop Compile (public, primary)
  // ═══════════════════════════════════════════════════════════════════════

  invokeLoopCompile(
    request: LoopForgeRequest,
    hydrateResults?: Record<string, unknown> | null,
    options: { persistLineage?: boolean } = {},
  ): AgentLoopResult {
    this.ensureInit(request);
    this.lastTask = request.task;

    // Parse extras via typed extraction pipeline (loop-extras-parser.ts).
    // Errors are collected but never thrown — the compiler always gets
    // best-effort defaults so a malformed request doesn't crash the engine.
    const extras = request as Record<string, unknown>;
    const { parsed, ctx } = parseLoopExtras(
      extras,
      request.task_id ?? "",
    );
    if (ctx.errors.length > 0) {
      logEvent("extras_parse_errors", {
        errors: ctx.errors.map((e) => `${e.field}: ${e.message}`),
      });
    }

    const lcr = makeLoopCompileRequest({
      loop_id: parsed.loop_id,
      round: parsed.round,
      goal_id: parsed.goal_id,
      task: request.task,
      domain: parsed.domain,
      next_task_proposal: parsed.next_task_proposal,
      plan_source: parsed.plan_source,
      constraints_from_plan: parsed.constraints_from_plan,
      new_since_last_round: parsed.new_since_last_round,
      force_level: parsed.force_level,
      health_check_interval: parsed.health_check_interval,
      external_context: parsed.external_context,
      max_rounds: parsed.max_rounds,
      verification_flags: parsed.verification_flags,
      attempt: parsed.attempt,
      consecutive_rejections: parsed.consecutive_rejections,
      rejection_notice: parsed.rejection_notice,
    });

    // Convert last_round_result if present (object already validated by parser)
    if (parsed.last_round_result) {
      const rr = parsed.last_round_result;
      // Parse P4 execution evidence (shared helper)
      const executionEvidence = parseExecutionEvidence(
        rr.execution_evidence as Record<string, unknown> | undefined,
      );
      // Parse P5 revised_success_criteria (shared parser)
      const revisedCriteria = parseCriterionRevisions(rr.revised_success_criteria);
      lcr.last_round_result = makeLoopRoundResult({
        round: (rr.round as number) ?? 0,
        success: (rr.success as boolean) ?? false,
        output_summary: (rr.output_summary as string) ?? "",
        constraint_violations:
          (rr.constraint_violations as string[]) ?? [],
        manual_fixes_needed: (rr.manual_fixes_needed as string) ?? "",
        // P0–P2: Cognitive evolution fields
        discovered_constraints: Array.isArray(rr.discovered_constraints)
          ? (rr.discovered_constraints as string[]).filter((v: unknown) => typeof v === "string")
          : [],
        objective_refinement: typeof rr.objective_refinement === "string"
          ? rr.objective_refinement
          : "",
        emerged_subtasks: Array.isArray(rr.emerged_subtasks)
          ? (rr.emerged_subtasks as string[]).filter((v: unknown) => typeof v === "string")
          : [],
        // P4: Execution evidence
        execution_evidence: executionEvidence,
        // P5: Self-correction
        retracted_constraints: Array.isArray(rr.retracted_constraints)
          ? (rr.retracted_constraints as string[]).filter((v: unknown) => typeof v === "string")
          : [],
        revised_success_criteria: revisedCriteria,
        wrong_assumptions: Array.isArray(rr.wrong_assumptions)
          ? (rr.wrong_assumptions as string[]).filter((v: unknown) => typeof v === "string")
          : [],
        // v1.10: Checkpoint boundary
        compression_checkpoint:
          typeof rr.compression_checkpoint === "boolean" ? rr.compression_checkpoint : false,
        checkpoint_label:
          typeof rr.checkpoint_label === "string" ? rr.checkpoint_label : "",
        // v3.7.1: Sub-goal lifecycle — explicit transitions (shared parser)
        subgoal_updates: parseSubGoalUpdates(rr.subgoal_updates),
        // v2.8: Drift clarification
        drift_clarification: typeof rr.drift_clarification === "string"
          ? rr.drift_clarification
          : undefined,
        // Multi-agent: Worker delegation results (shared parser)
        worker_results: parseWorkerResults(rr.worker_results),
        // v2.12: Tri-state outcome + blocker + retroactive claims
        outcome: rr.outcome === "success" || rr.outcome === "partial" ||
          rr.outcome === "failed" || rr.outcome === "blocked"
          ? rr.outcome
          : undefined,
        blocker: typeof rr.blocker === "string" && rr.blocker.trim().length > 0
          ? rr.blocker.slice(0, 500)
          : undefined,
        retroactiveClaims: Array.isArray(rr.retroactiveClaims)
          ? (rr.retroactiveClaims as Array<Record<string, unknown>>)
            .filter((item) => isRecord(item) &&
              typeof item.round === "number" && item.round >= 1 &&
              typeof item.claim === "string" && item.claim.length > 0)
            .map((item) => ({ round: item.round as number, claim: (item.claim as string).slice(0, 500) }))
            .slice(0, 20)
          : [],
        // v3.3.1: next_action + prompt_requests — this whitelist rebuild
        // previously dropped them, and since EVERY compile path (MCP
        // advance/retry/backtrack + Runtime) funnels through
        // invokeLoopCompile, the compiler never saw them on the production
        // path: "Next Action" never rendered, suggested_next_task stayed
        // empty, sub-goal Phase-3 auto in_progress never fired, and
        // prompt_requests (emphasize/confusion_points) were never
        // consumed. Unit tests fed compileLoop directly, so 783 greens
        // missed the gap. Shared lenient parsers mirror the other fields.
        next_action: typeof rr.next_action === "string" ? rr.next_action : undefined,
        prompt_requests: parsePromptRequests(rr.prompt_requests),
      });
    }

    // Convert loop_objective if present (object already validated by parser)
    if (parsed.loop_objective) {
      const obj = parsed.loop_objective;
      lcr.loop_objective = makeLoopObjective({
        objective: (obj.objective as string) ?? "",
        success_criteria: (obj.success_criteria as string[]) ?? [],
        hard_constraints: (obj.hard_constraints as string[]) ?? [],
        created_at_round: (obj.created_at_round as number) ?? 1,
        loop_id: (obj.loop_id as string) ?? "",
      });
    }

    // Hydrate vault context for cross-round memory
    let context = hydrateResults ?? null;
    if (context === null && lcr.loop_id && lcr.round > 1) {
      // v3.0.1: the compile round anchors the hydration cache — warm caches
      // skip the read entirely; otherwise only rounds committed since the
      // last hydration are read.
      context = this.hydrateLoopContext(lcr.loop_id, lcr.round);
    }

    // Delegate to pure-function compiler
    let response: LoopCompileResponse;
    try {
      response = compileLoop(lcr, context as Record<string, unknown> | null);
    } catch (exc) {
      return {
        status: AgentStatus.ERROR,
        response: {
          status: AgentStatus.ERROR,
          prompt: null,
          error: `loop_compile failed: ${exc}`,
        },
      };
    }

    // Persist lineage to vault
    if (options.persistLineage !== false) {
      this.persistLoopLineage(response, lcr);
    }

    return {
      status: AgentStatus.OK,
      response: {
        status: AgentStatus.OK,
        prompt: response.prompt,
        error: null,
        state_file_content: response.state_file_content,
        prompt_artifact: response.prompt_artifact,
        warnings: response.warnings,
        // v2.12: Pass the compiler's derived state through for typed
        // projections (consumed by getProjection without re-persisting).
        loop_objective: response.loop_objective,
        rolling_summary: response.rolling_summary,
        sub_goals: response.sub_goals,
        criterion_statuses: response.criterion_statuses,
        suggested_next_task: response.suggested_next_task,
      },
    };
  }

}

// ═══════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════

export function createEngine(
  store?: LoopStore,
): LoopForgeEngine {
  return new LoopForgeEngine(store);
}
