/** LoopForge-loop_compile — Engine (outer loop manager).
 *
 * 2-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeFeedback.
 * Circuit breaker prevents infinite stall loops.
 * EngineMetrics tracks silent-failure counters for observability.
 */

import { randomUUID } from "node:crypto";
import { getPolicy } from "./policy.js";
import { FSBackend, readLineageMd } from "./backends/fs.js";
import type { VaultBackend, VaultEntry } from "./backends/interface.js";
import {
  AgentStatus,
  Mode,
  makeAnalysis,
  makeExecutionEvidence,
  makeExecutionFeedback,
  makeLoopCompileRequest,
  makeLoopObjective,
  makeLoopRoundResult,
  makeSelfEvaluation,
  makeSessionState,
  makeTaskId,
  makeVaultConfig,
  SELF_EVAL_REGEX,
  type AgentLoopResult,
  type CriterionRevision,
  type ExecutionEvidence,
  type ExecutionFeedback,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type LoopForgeRequest,
  type SelfEvaluation,
  type SessionState,
} from "./protocol.js";
import { compileLoop } from "./loop-compiler.js";
import { logEvent } from "./observability.js";

// ═══════════════════════════════════════════════════════════════════════════
// Self-Evaluation extraction (v1.1 — autonomous loop feedback)
// ═══════════════════════════════════════════════════════════════════════════

/** Extract a structured SelfEvaluation from agent output text.
 *  Returns null if no valid self-eval block is found.
 *  The agent is instructed to output JSON between the delimiters. */
export function extractSelfEvaluation(text: string): SelfEvaluation | null {
  const match = text.match(SELF_EVAL_REGEX);
  if (!match) return null;

  try {
    const raw = JSON.parse(match[1]);
    // Validate required fields
    if (typeof raw.success !== "boolean") return null;
    if (typeof raw.output_summary !== "string") return null;
    if (!Array.isArray(raw.constraint_violations)) return null;
    if (typeof raw.should_continue !== "boolean") return null;
    return buildSelfEvaluation(raw);
  } catch {
    return null;
  }
}

/** Build a SelfEvaluation from a parsed JSON object.
 *  Lenient parsing: missing optional fields get sensible defaults.
 *  Used by extractSelfEvaluation() (regex path) and MCP tool handler
 *  (structured evaluation parameter path). */
export function buildSelfEvaluation(
  raw: Record<string, unknown>,
): SelfEvaluation {
  // P4: Parse execution evidence from raw JSON
  let executionEvidence: ExecutionEvidence | undefined;
  const rawEvidence = raw.execution_evidence as Record<string, unknown> | undefined;
  if (rawEvidence && typeof rawEvidence === "object") {
    const testResults = rawEvidence.test_results as Record<string, unknown> | undefined;
    executionEvidence = makeExecutionEvidence({
      files_changed: Array.isArray(rawEvidence.files_changed)
        ? rawEvidence.files_changed.filter((v: unknown) => typeof v === "string")
        : [],
      test_results: testResults && typeof testResults.passed === "number"
        ? {
            passed: testResults.passed as number,
            failed: (testResults.failed as number) ?? 0,
            skipped: (testResults.skipped as number) ?? 0,
          }
        : null,
      success_criteria_met: Array.isArray(rawEvidence.success_criteria_met)
        ? rawEvidence.success_criteria_met.filter((v: unknown) => typeof v === "string")
        : [],
      success_criteria_remaining: Array.isArray(rawEvidence.success_criteria_remaining)
        ? rawEvidence.success_criteria_remaining.filter((v: unknown) => typeof v === "string")
        : [],
      progress_estimate: typeof rawEvidence.progress_estimate === "number"
        ? Math.max(0, Math.min(1, rawEvidence.progress_estimate))
        : 0.0,
    });
  }

  // P5: Parse corrections
  const retractedConstraints: string[] = Array.isArray(raw.retracted_constraints)
    ? raw.retracted_constraints.filter((v: unknown) => typeof v === "string")
    : [];
  const revisedCriteria: CriterionRevision[] = Array.isArray(raw.revised_success_criteria)
    ? raw.revised_success_criteria
        .filter((v: unknown) =>
          typeof v === "object" && v !== null &&
          typeof (v as Record<string, unknown>).old === "string" &&
          typeof (v as Record<string, unknown>).new === "string")
        .map((v: unknown) => {
          const r = v as Record<string, unknown>;
          return { old: r.old as string, new: r.new as string };
        })
    : [];
  const wrongAssumptions: string[] = Array.isArray(raw.wrong_assumptions)
    ? raw.wrong_assumptions.filter((v: unknown) => typeof v === "string")
    : [];

  // Multi-agent: Parse worker delegation results
  const workerResults: import("./protocol.js").WorkerResult[] = Array.isArray(raw.worker_results)
    ? raw.worker_results
        .filter((v: unknown) =>
          typeof v === "object" && v !== null &&
          typeof (v as Record<string, unknown>).agentId === "string" &&
          typeof (v as Record<string, unknown>).subTask === "string" &&
          typeof (v as Record<string, unknown>).resultSummary === "string")
        .map((v: unknown) => {
          const w = v as Record<string, unknown>;
          return {
            agentId: w.agentId as string,
            subAgentType: typeof w.subAgentType === "string" ? w.subAgentType : "general-purpose",
            subTask: w.subTask as string,
            resultSummary: w.resultSummary as string,
            success: typeof w.success === "boolean" ? w.success : false,
            discoveredConstraints: Array.isArray(w.discoveredConstraints)
              ? w.discoveredConstraints.filter((c: unknown) => typeof c === "string")
              : [],
          };
        })
    : [];

  return makeSelfEvaluation({
    success: typeof raw.success === "boolean" ? raw.success : false,
    output_summary: typeof raw.output_summary === "string" ? raw.output_summary : "",
    constraint_violations: Array.isArray(raw.constraint_violations)
      ? raw.constraint_violations.filter((v: unknown) => typeof v === "string")
      : [],
    should_continue: typeof raw.should_continue === "boolean" ? raw.should_continue : true,
    // P0–P2: Optional evolution fields
    discovered_constraints: Array.isArray(raw.discovered_constraints)
      ? raw.discovered_constraints.filter((v: unknown) => typeof v === "string")
      : [],
    objective_refinement: typeof raw.objective_refinement === "string"
      ? raw.objective_refinement
      : "",
    emerged_subtasks: Array.isArray(raw.emerged_subtasks)
      ? raw.emerged_subtasks.filter((v: unknown) => typeof v === "string")
      : [],
    // P4: Execution evidence
    execution_evidence: executionEvidence,
    // P5: Self-correction
    retracted_constraints: retractedConstraints,
    revised_success_criteria: revisedCriteria,
    wrong_assumptions: wrongAssumptions,
    // Multi-agent: Worker delegation results
    worker_results: workerResults,
    // v1.10: Checkpoint compression
    compression_checkpoint:
      typeof raw.compression_checkpoint === "boolean" ? raw.compression_checkpoint : false,
    checkpoint_label:
      typeof raw.checkpoint_label === "string" ? raw.checkpoint_label : "",
  });
}

/** Fallback heuristic when structured self-eval extraction fails.
 *  Scans agent output for completion and error signals.
 *  Returns a low-confidence SelfEvaluation — the autonomous runner
 *  may choose to warn the user or continue cautiously. */
export function heuristicSelfEvaluation(text: string): SelfEvaluation | null {
  const lower = text.toLowerCase();
  const hasError =
    /error|failed|exception|cannot|unable|失败|错误|异常/.test(lower);
  const hasCompletion =
    /done|complete|finished|完成|成功/.test(lower);
  const hasRemaining =
    /remaining|continue|still need|next|todo|剩余|继续|下一步/.test(lower);

  // Extract a reasonable summary from the last meaningful paragraph
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 30);
  const summary = paragraphs.length > 0
    ? paragraphs[paragraphs.length - 1].trim().slice(0, 300)
    : text.trim().slice(0, 300);

  return makeSelfEvaluation({
    success: !hasError && (hasCompletion || !hasRemaining),
    output_summary: summary || "[heuristic fallback — could not parse structured self-eval]",
    constraint_violations: [],
    should_continue: hasRemaining && !hasError,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Engine Metrics
// ═══════════════════════════════════════════════════════════════════════════

/** A single sub-agent delegation record (v1.9 — AgentTool mode). */
export interface DelegationEntry {
  index: number;
  agentId: string;
  subAgentType: string;
  subTask: string;
  resultSummary: string;
  success: boolean;
  discoveredConstraints: string[];
}

export interface EngineMetrics {
  vaultWriteErrors: number;
  vaultWriteTimeouts: number;
  vaultWriteBytes: number;
  silentAnalysisErrors: number;
  hydrateCacheMisses: number;
  feedbackBufferFlushes: number;
  feedbackBufferMaxSize: number;
  sessionStart: number;
}

function makeEngineMetrics(): EngineMetrics {
  return {
    vaultWriteErrors: 0,
    vaultWriteTimeouts: 0,
    vaultWriteBytes: 0,
    silentAnalysisErrors: 0,
    hydrateCacheMisses: 0,
    feedbackBufferFlushes: 0,
    feedbackBufferMaxSize: 0,
    sessionStart: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LoopForgeEngine
// ═══════════════════════════════════════════════════════════════════════════

export class LoopForgeEngine {
  skillsDir: string;
  state: SessionState | null = null;
  private backend: VaultBackend | null = null;
  private metrics: EngineMetrics | null = null;
  private feedbackWriteBuffer: VaultEntry[] = [];
  lastTask: string | null = null;
  private seenConstraints = new Set<string>();

  constructor(skillsDir = "skills", backend?: VaultBackend) {
    this.skillsDir = skillsDir;
    if (backend) this.backend = backend;
  }

  private resolveBackend(): VaultBackend {
    if (this.backend === null) {
      this.backend = new FSBackend();
    }
    return this.backend;
  }

  /** Public accessor for the vault backend — used by runtime/verification gate. */
  getBackend(): VaultBackend {
    return this.resolveBackend();
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

  private persistFeedbackToVault(signal: Record<string, unknown>): void {
    if (this.metrics === null) {
      this.metrics = makeEngineMetrics();
    }

    this.feedbackWriteBuffer.push(signal as VaultEntry);

    const bufLen = this.feedbackWriteBuffer.length;
    if (bufLen > this.metrics.feedbackBufferMaxSize) {
      this.metrics.feedbackBufferMaxSize = bufLen;
    }

    const policy = getPolicy();
    if (bufLen >= policy.engine.feedback_flush_interval) {
      this.flushFeedbackBuffer();
    }
  }

  flushFeedbackBuffer(): number {
    if (!this.feedbackWriteBuffer.length) return 0;

    const records = this.feedbackWriteBuffer.splice(0);
    if (this.metrics) this.metrics.feedbackBufferFlushes++;

    const now = new Date().toISOString().replace(/\.\d+Z$/, "");
    const entries: VaultEntry[] = [];

    for (const signal of records) {
      try {
        const entry: VaultEntry = {
          id: randomUUID(),
          task_id: (signal.task_id as string) ?? "feedback",
          version_tag: "v1",
          is_active: true,
          timestamp: now,
          user_intent: String(signal.task_type ?? "").slice(0, 200),
          success: (signal.success as boolean) ?? false,
          execution_feedback: JSON.stringify({
            success: signal.success ?? false,
            status:
              (signal.success as boolean)
                ? "success"
                : "partial",
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
        };
        entries.push(entry);
      } catch {
        if (this.metrics) this.metrics.vaultWriteErrors++;
        logEvent("vault_write_error", { error: "feedback_entry_build" });
      }
    }

    if (entries.length > 0) {
      try {
        this.resolveBackend().appendEntries(entries);
      } catch {
        if (this.metrics) this.metrics.vaultWriteErrors += entries.length;
        logEvent("vault_write_error", { error: "feedback_append_entries", count: entries.length });
        return 0;
      }
    }

    return entries.length;
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
      technique_used: response.technique_used,
    };

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
      skill_used: response.technique_used,
      technique_used: response.technique_used,
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
      this.resolveBackend().appendEntry(entry);
      vaultOk = true;
    } catch {
      if (this.metrics) this.metrics.vaultWriteErrors++;
      logEvent("vault_write_error", { error: "persist_lineage_json" });
    }

    // 2. Markdown write (secondary, non-blocking)
    try {
      this.resolveBackend().writeLineageMd(
        response.loop_id,
        response.round,
        response.prompt || "",
        {
          goal_id: response.goal_id,
          goal_text_hash: response.goal_text_hash,
          recompile_level: response.recompile_level,
          constraints_active: response.constraints_active,
          task: request.task,
          technique_used: response.technique_used,
          loop_objective: loopObjDict,
          success: true,
          output_summary: lastOutputSummary,
          constraint_violations: lastViolations,
        },
      );
    } catch {
      if (this.metrics) this.metrics.vaultWriteErrors++;
      logEvent("vault_write_error", { error: "persist_lineage_md" });
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
    const entry: VaultEntry = {
      id: randomUUID(),
      task_id: `loop:${loopId}:r${round}:delegations`,
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
          success: e.success,
          discoveredConstraints: e.discoveredConstraints,
        })),
      },
    };
    try {
      this.resolveBackend().appendEntry(entry);
    } catch {
      if (this.metrics) this.metrics.vaultWriteErrors++;
      logEvent("vault_write_error", { error: "record_delegation" });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Hydrate loop context from vault
  // ═══════════════════════════════════════════════════════════════════════

  hydrateLoopContext(loopId: string): Record<string, unknown> | null {
    const prefix = `loop:${loopId}:r`;
    const results = this.resolveBackend().queryEntries({ prefix });

    // Merge feedback success flags into lineage entries
    const fbEntries = this.resolveBackend().queryEntries({
      prefix,
      feedbackOnly: true,
    });
    const fbSuccess = new Map<number, boolean>();
    for (const fe of fbEntries) {
      const tid = String(fe.task_id ?? "");
      const parts = tid.split(":r");
      if (parts.length >= 2) {
        const roundStr = parts[1].split(":")[0];
        const fbRound = parseInt(roundStr, 10);
        if (!Number.isNaN(fbRound) && fe.success !== undefined) {
          fbSuccess.set(fbRound, fe.success as boolean);
        }
      }
    }

    for (const entry of results) {
      const lineage = (entry.loop_lineage ?? entry.lineage ?? {}) as Record<
        string,
        unknown
      >;
      const rnd = lineage.round as number;
      if (rnd && fbSuccess.has(rnd)) {
        (lineage as Record<string, unknown>).success = fbSuccess.get(rnd);
        entry.success = fbSuccess.get(rnd);
      }
    }

    // Fallback: scan Markdown files if JSON vault had no matches
    let finalResults = results;
    if (!finalResults.length) {
      const mdResults = this.resolveBackend().scanLineageMd(loopId);
      if (mdResults.length) finalResults = mdResults;
    }

    // Normalize technique_used field
    for (const entry of finalResults) {
      if (!entry.technique_used) {
        entry.technique_used = entry.skill_used;
      }
      const lineage = (entry.loop_lineage ?? entry.lineage ?? {}) as Record<
        string,
        unknown
      >;
      if (!entry.output_summary) {
        entry.output_summary = (lineage.output_summary as string) ?? "";
      }
      if (!entry.constraint_violations) {
        entry.constraint_violations =
          (lineage.constraint_violations as string[]) ?? [];
      }
    }

    // Enrich: attach full prompt text from Markdown for L0 cache reuse
    for (const entry of finalResults) {
      if (entry.full_prompt) continue;
      const lineage = (entry.loop_lineage ?? entry.lineage ?? {}) as Record<
        string,
        unknown
      >;
      const roundNum = lineage.round as number;
      if (roundNum) {
        const mdEntry = readLineageMd(loopId, roundNum);
        if (mdEntry?.full_prompt) {
          entry.full_prompt = mdEntry.full_prompt;
        }
      }
    }

    if (!finalResults.length) return null;

    return { results: finalResults, global_entries: [] };
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
          analysis: null,
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
    let taskId: string;
    if (loopId && loopRound !== undefined) {
      taskId = `loop:${loopId}:r${loopRound}:feedback`;
    } else {
      taskId = request.task_id ?? request.task.slice(0, 60);
    }

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
    this.persistFeedbackToVault(signal);

    // Flush immediately so next compile cycle sees success flags
    this.flushFeedbackBuffer();

    // Update state
    this.state!.call_count++;
    this.state!.success_trend.push(success);
    if (this.state!.success_trend.length > 20) {
      this.state!.success_trend = this.state!.success_trend.slice(-20);
    }

    // Circuit breaker
    if (this.shouldBreak()) {
      this.state!.circuit_breaker_count++;
    } else {
      this.state!.circuit_breaker_count = 0;
    }

    logEvent("round_complete", {
      technique: "feedback",
      success,
      loopId: loopId ?? "unknown",
      round: loopRound ?? this.state!.call_count,
    });

    return {
      status: AgentStatus.OK,
      response: {
        status: AgentStatus.OK,
        prompt: `## Feedback Recorded\n\nSuccess: ${success}\nSignals: 1`,
        analysis: makeAnalysis({
          technique: "feedback",
          rationale: `success=${success}`,
          independence: "n/a",
          cognitive_load: "low",
        }),
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
  ): boolean {
    this.ensureInit({ task, mode: Mode.FEEDBACK, vault_config: makeVaultConfig(), feedback: null, skill_name: null, task_id: null });

    const fb: ExecutionFeedback = makeExecutionFeedback({
      output: selfEval.output_summary,
      success: selfEval.success,
      constraint_violations: selfEval.constraint_violations,
      manual_fixes_needed: "",
    });

    const taskId = `loop:${loopId}:r${round}:feedback`;

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
      // P4: Execution evidence
      execution_evidence: selfEval.execution_evidence ?? null,
      // P5: Self-correction
      retracted_constraints: selfEval.retracted_constraints ?? [],
      revised_success_criteria: selfEval.revised_success_criteria ?? [],
      wrong_assumptions: selfEval.wrong_assumptions ?? [],
      // Multi-agent: Worker delegation results
      worker_results: selfEval.worker_results ?? [],
    };
    this.persistFeedbackToVault(signal);
    this.flushFeedbackBuffer();

    // Multi-agent: Auto-record delegation journal from worker_results
    if (selfEval.worker_results && selfEval.worker_results.length > 0) {
      const entries = selfEval.worker_results.map((w, i) => ({
        index: i + 1,
        agentId: w.agentId,
        subAgentType: w.subAgentType,
        subTask: w.subTask,
        resultSummary: w.resultSummary,
        success: w.success,
        discoveredConstraints: w.discoveredConstraints ?? [],
      }));
      this.recordDelegation(loopId, round, entries);
    }

    // Update state
    this.state!.call_count++;
    this.state!.success_trend.push(fb.success);
    if (this.state!.success_trend.length > 20) {
      this.state!.success_trend = this.state!.success_trend.slice(-20);
    }

    // Circuit breaker
    if (this.shouldBreak()) {
      this.state!.circuit_breaker_count++;
    } else {
      this.state!.circuit_breaker_count = 0;
    }

    logEvent("round_complete", {
      loopId,
      round,
      success: fb.success,
      technique: this.state?.last_technique ?? "feedback",
    });

    return fb.success;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Loop Compile (public, primary)
  // ═══════════════════════════════════════════════════════════════════════

  invokeLoopCompile(
    request: LoopForgeRequest,
    hydrateResults?: Record<string, unknown> | null,
  ): AgentLoopResult {
    this.ensureInit(request);
    this.lastTask = request.task;

    // Build LoopCompileRequest from LoopForgeRequest extras
    const extras = request as Record<string, unknown>;
    const lcr = makeLoopCompileRequest({
      loop_id:
        (extras.loop_id as string) ?? request.task_id ?? "",
      round: (extras.round as number) ?? 1,
      goal_id: (extras.goal_id as string) ?? "",
      task: request.task,
      domain: (extras.domain as string) ?? "",
      next_task_proposal: (extras.next_task_proposal as string) ?? "",
      plan_source: (extras.plan_source as string) ?? null,
      constraints_from_plan:
        (extras.constraints_from_plan as string[]) ?? [],
      new_since_last_round: (extras.new_since_last_round as string) ?? "",
      force_level: (extras.force_level as string) ?? "auto",
      health_check_interval:
        (extras.health_check_interval as number) ?? 1,
      external_context: (extras.external_context as string) ?? "",
    });

    // Convert last_round_result if present
    const lastRR = extras.last_round_result;
    if (lastRR) {
      if (typeof lastRR === "object" && !Array.isArray(lastRR)) {
        const rr = lastRR as Record<string, unknown>;
        // Parse P4 execution evidence
        let executionEvidence: ExecutionEvidence | undefined;
        const rawEvidence = rr.execution_evidence as Record<string, unknown> | undefined;
        if (rawEvidence && typeof rawEvidence === "object") {
          const testResults = rawEvidence.test_results as Record<string, unknown> | undefined;
          executionEvidence = makeExecutionEvidence({
            files_changed: Array.isArray(rawEvidence.files_changed)
              ? rawEvidence.files_changed.filter((v: unknown) => typeof v === "string")
              : [],
            test_results: testResults && typeof testResults.passed === "number"
              ? {
                  passed: testResults.passed as number,
                  failed: (testResults.failed as number) ?? 0,
                  skipped: (testResults.skipped as number) ?? 0,
                }
              : null,
            success_criteria_met: Array.isArray(rawEvidence.success_criteria_met)
              ? rawEvidence.success_criteria_met.filter((v: unknown) => typeof v === "string")
              : [],
            success_criteria_remaining: Array.isArray(rawEvidence.success_criteria_remaining)
              ? rawEvidence.success_criteria_remaining.filter((v: unknown) => typeof v === "string")
              : [],
            progress_estimate: typeof rawEvidence.progress_estimate === "number"
              ? Math.max(0, Math.min(1, rawEvidence.progress_estimate))
              : 0.0,
          });
        }
        // Parse P5 revised_success_criteria
        const revisedCriteria: CriterionRevision[] = Array.isArray(rr.revised_success_criteria)
          ? (rr.revised_success_criteria as Array<Record<string, unknown>>)
              .filter((v) =>
                typeof v === "object" && v !== null &&
                typeof v.old === "string" && typeof v.new === "string")
              .map((v) => ({ old: v.old as string, new: v.new as string }))
          : [];
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
          // Multi-agent: Worker delegation results
          worker_results: Array.isArray(rr.worker_results)
            ? (rr.worker_results as Array<Record<string, unknown>>)
                .filter((v) => typeof v?.agentId === "string" && typeof v?.subTask === "string")
                .map((v) => ({
                  agentId: v.agentId as string,
                  subAgentType: typeof v.subAgentType === "string" ? v.subAgentType : "general-purpose",
                  subTask: v.subTask as string,
                  resultSummary: typeof v.resultSummary === "string" ? v.resultSummary : "",
                  success: typeof v.success === "boolean" ? v.success : false,
                  discoveredConstraints: Array.isArray(v.discoveredConstraints)
                    ? (v.discoveredConstraints as string[])
                    : [],
                }))
            : [],
        });
      }
    }

    // Convert loop_objective if present
    const lo = extras.loop_objective;
    if (lo && typeof lo === "object" && !Array.isArray(lo)) {
      const obj = lo as Record<string, unknown>;
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
      context = this.hydrateLoopContext(lcr.loop_id);
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
          analysis: null,
          error: `loop_compile failed: ${exc}`,
        },
      };
    }

    // Build prompt text from response
    const promptLines: string[] = [
      `## LoopForge Loop Compile — Round ${response.round}`,
      `**Recompile Level**: ${response.recompile_level.toUpperCase()}`,
      `**Loop ID**: ${response.loop_id}`,
      `**Goal ID**: ${response.goal_id}`,
      "",
      response.prompt,
    ];

    if (response.warnings.length) {
      promptLines.push("");
      promptLines.push("### Warnings");
      for (const w of response.warnings) {
        promptLines.push(`- ⚠️ ${w}`);
      }
    }

    // Verification gate flags (v1.6) — injected after compiler warnings
    const verificationFlags = (extras.verification_flags as Array<Record<string, unknown>>) ?? [];
    if (verificationFlags.length) {
      promptLines.push("");
      promptLines.push("### Verification Gate");
      for (const f of verificationFlags) {
        const icon = f.severity === "error" ? "🚫" : "⚠️";
        promptLines.push(`- ${icon} [${f.check}] ${f.detail}`);
      }
      const hasError = verificationFlags.some((f) => f.severity === "error");
      if (hasError) {
        promptLines.push("");
        promptLines.push(
          "**Gate Verdict: CONTRADICTED** — this round's success flag has been excluded " +
          "from the success trend. Address each 🚫 flag explicitly in your next response.",
        );
      }
    }

    if (response.loop_health) {
      const h = response.loop_health;
      promptLines.push("");
      promptLines.push("### Loop Health");
      promptLines.push(`- Goal Alignment: ${h.goal_alignment.toFixed(2)}`);
      promptLines.push(
        `- Constraint Integrity: ${h.constraint_integrity.toFixed(2)}`,
      );
      promptLines.push(`- Task Continuity: ${h.task_continuity.toFixed(2)}`);
      promptLines.push(`- Drift Detected: ${h.drift_detected}`);
      promptLines.push(`- Strategy Stability: ${h.strategy_stability}`);
    }

    if (
      response.task_alignment &&
      response.task_alignment.escalation !== "none"
    ) {
      promptLines.push("");
      promptLines.push("### Task Alignment Advisory");
      promptLines.push(
        `- Score: ${response.task_alignment.alignment_score.toFixed(2)}`,
      );
      promptLines.push(
        `- Escalation: ${response.task_alignment.escalation}`,
      );
      promptLines.push(`- ${response.task_alignment.warning}`);
    }

    if (response.suggested_next_task) {
      promptLines.push("");
      promptLines.push(
        `### Suggested Next Task\n${response.suggested_next_task}`,
      );
    }

    // Persist lineage to vault
    this.persistLoopLineage(response, lcr);

    // Track technique for status queries
    if (this.state) {
      this.state.last_technique = response.technique_used;
    }

    return {
      status: AgentStatus.OK,
      response: {
        status: AgentStatus.OK,
        prompt: promptLines.join("\n"),
        analysis: makeAnalysis({
          technique: response.technique_used,
          rationale: `Recompile level: ${response.recompile_level}`,
          independence: "n/a",
          cognitive_load:
            response.recompile_level === "l0"
              ? "low"
              : response.recompile_level === "l1"
                ? "medium"
                : "high",
          reference_file: response.reference_file,
        }),
        error: null,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Circuit breaker
  // ═══════════════════════════════════════════════════════════════════════

  shouldBreak(): boolean {
    if (!this.state) return false;
    const policy = getPolicy();
    const maxCB = policy.engine.max_circuit_breaker;

    if (this.state.success_trend.length < maxCB) return false;

    const recent = this.state.success_trend.slice(-maxCB);
    // Trip only when all recent rounds are failures (no false-positives on all-success)
    const allFailed = recent.every((v) => v === false);
    if (allFailed) {
      logEvent("circuit_breaker", {
        trend: recent,
        totalRounds: this.state.success_trend.length,
      });
    }
    return allFailed;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════

export function createEngine(
  skillsDir = "skills",
  backend?: VaultBackend,
): LoopForgeEngine {
  return new LoopForgeEngine(skillsDir, backend);
}
