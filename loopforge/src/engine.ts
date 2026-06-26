/** LoopForge-loop_compile — Engine (outer loop manager).
 *
 * v1.0: 3-mode engine with vault-backed loop lineage persistence.
 * invokeLoopCompile (primary), invokeBuild (internal), invokeFeedback.
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
  type ExecutionFeedback,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type LoopForgeRequest,
  type SelfEvaluation,
  type SessionState,
} from "./protocol.js";
import { routeTechnique } from "./builder.js";
import { scoreQuality } from "./builder.js";
import { compileLoop } from "./loop-compiler.js";

// ═══════════════════════════════════════════════════════════════════════════
// Self-Evaluation extraction (v1.1 — autonomous loop feedback)
// ═══════════════════════════════════════════════════════════════════════════

/** Extract a structured SelfEvaluation from agent output text.
 *  Returns null if no valid self-evaluation block is found.
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

    return makeSelfEvaluation({
      success: raw.success,
      output_summary: raw.output_summary,
      constraint_violations: raw.constraint_violations,
      should_continue: raw.should_continue,
    });
  } catch {
    return null;
  }
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
          quality_score: (signal.quality_score as number) ?? 0,
          execution_feedback: JSON.stringify({
            status:
              ((signal.quality_score as number) ?? 0) >= 3
                ? "success"
                : "partial",
            quality_score: signal.quality_score ?? 0,
            constraint_compliance: {
              all_hard_constraints_met: !(signal.violations as unknown[]),
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
      }
    }

    if (entries.length > 0) {
      try {
        this.resolveBackend().appendEntries(entries);
      } catch {
        if (this.metrics) this.metrics.vaultWriteErrors += entries.length;
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
      quality_score: 0,
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
      quality_score: 0,
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
          quality_score: 0,
          output_summary: lastOutputSummary,
          constraint_violations: lastViolations,
        },
      );
    } catch {
      if (this.metrics) this.metrics.vaultWriteErrors++;
    }

    return vaultOk;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Hydrate loop context from vault
  // ═══════════════════════════════════════════════════════════════════════

  hydrateLoopContext(loopId: string): Record<string, unknown> | null {
    const prefix = `loop:${loopId}:r`;
    const results = this.resolveBackend().queryEntries({ prefix });

    // Merge feedback quality scores into lineage entries
    const fbEntries = this.resolveBackend().queryEntries({
      prefix,
      feedbackOnly: true,
    });
    const fbQuality = new Map<number, number>();
    for (const fe of fbEntries) {
      const tid = String(fe.task_id ?? "");
      const parts = tid.split(":r");
      if (parts.length >= 2) {
        const roundStr = parts[1].split(":")[0];
        const fbRound = parseInt(roundStr, 10);
        const fbScore = fe.quality_score ?? 0;
        if (!Number.isNaN(fbRound) && fbScore > 0) {
          fbQuality.set(fbRound, Math.max(fbQuality.get(fbRound) ?? 0, fbScore));
        }
      }
    }

    for (const entry of results) {
      const lineage = (entry.loop_lineage ?? entry.lineage ?? {}) as Record<
        string,
        unknown
      >;
      const rnd = lineage.round as number;
      if (rnd && fbQuality.has(rnd)) {
        lineage.quality_score = fbQuality.get(rnd);
        entry.quality_score = fbQuality.get(rnd);
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
  // Build (internal)
  // ═══════════════════════════════════════════════════════════════════════

  invokeBuild(
    request: LoopForgeRequest,
    _hydrateResults?: Record<string, unknown> | null,
  ): AgentLoopResult {
    this.ensureInit(request);
    this.lastTask = request.task;

    const analysis = routeTechnique(request.task);
    const technique = analysis.technique;
    const rationale = analysis.rationale;

    const promptSections = [
      "## LoopForge Build",
      `**Technique**: ${technique}`,
      `**Rationale**: ${rationale}`,
      "",
      "### Task",
      request.task,
      "",
      "### Instructions",
      `Apply the **${technique}** technique to complete the task above.`,
      "Respect all hard constraints and provide verifiable output.",
    ];

    return {
      status: AgentStatus.OK,
      response: {
        status: AgentStatus.OK,
        prompt: promptSections.join("\n"),
        analysis,
        error: null,
      },
    };
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

    const quality = scoreQuality({
      success,
      constraint_violations: violations,
      manual_fixes_needed: fixes,
    });

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
      quality_score: quality,
      skill_used: request.skill_name ?? "",
      violations,
      manual_fixes: fixes,
      loop_id: loopId,
      round: loopRound,
    };
    this.persistFeedbackToVault(signal);

    // Flush immediately so next compile cycle sees quality scores
    this.flushFeedbackBuffer();

    // Update state
    this.state!.call_count++;
    this.state!.quality_trend.push(quality);
    if (this.state!.quality_trend.length > 20) {
      this.state!.quality_trend = this.state!.quality_trend.slice(-20);
    }

    // Circuit breaker
    if (this.shouldBreak()) {
      this.state!.circuit_breaker_count++;
    } else {
      this.state!.circuit_breaker_count = 0;
    }

    return {
      status: AgentStatus.OK,
      response: {
        status: AgentStatus.OK,
        prompt: `## Feedback Recorded\n\nQuality Score: ${quality}/5\nSignals: 1`,
        analysis: makeAnalysis({
          technique: "feedback",
          rationale: `quality=${quality}`,
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
   *  Call this BEFORE invokeLoopCompile for the next round so that
   *  hydrateLoopContext picks up the latest quality scores. */
  autoFeedback(
    selfEval: SelfEvaluation,
    loopId: string,
    round: number,
    task: string,
  ): number {
    this.ensureInit({ task, mode: Mode.FEEDBACK, vault_config: makeVaultConfig(), feedback: null, skill_name: null, task_id: null });

    const fb: ExecutionFeedback = makeExecutionFeedback({
      output: selfEval.output_summary,
      success: selfEval.success,
      constraint_violations: selfEval.constraint_violations,
      manual_fixes_needed: "",
    });

    const quality = scoreQuality({
      success: fb.success,
      constraint_violations: fb.constraint_violations,
      manual_fixes_needed: fb.manual_fixes_needed,
    });

    const taskId = `loop:${loopId}:r${round}:feedback`;

    const signal: Record<string, unknown> = {
      task_id: taskId,
      task_type: task.slice(0, 80),
      quality_score: quality,
      skill_used: "",
      violations: selfEval.constraint_violations,
      manual_fixes: "",
      loop_id: loopId,
      round,
    };
    this.persistFeedbackToVault(signal);
    this.flushFeedbackBuffer();

    // Update state
    this.state!.call_count++;
    this.state!.quality_trend.push(quality);
    if (this.state!.quality_trend.length > 20) {
      this.state!.quality_trend = this.state!.quality_trend.slice(-20);
    }

    // Circuit breaker
    if (this.shouldBreak()) {
      this.state!.circuit_breaker_count++;
    } else {
      this.state!.circuit_breaker_count = 0;
    }

    return quality;
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
    });

    // Convert last_round_result if present
    const lastRR = extras.last_round_result;
    if (lastRR) {
      if (typeof lastRR === "object" && !Array.isArray(lastRR)) {
        const rr = lastRR as Record<string, unknown>;
        lcr.last_round_result = makeLoopRoundResult({
          round: (rr.round as number) ?? 0,
          success: (rr.success as boolean) ?? false,
          output_summary: (rr.output_summary as string) ?? "",
          constraint_violations:
            (rr.constraint_violations as string[]) ?? [],
          manual_fixes_needed: (rr.manual_fixes_needed as string) ?? "",
          quality_score: (rr.quality_score as number) ?? 0,
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
  // Review handler
  // ═══════════════════════════════════════════════════════════════════════

  handleReview(
    request: LoopForgeRequest,
    hydrateResults?: Record<string, unknown> | null,
  ): AgentLoopResult {
    if (!hydrateResults) {
      return {
        status: AgentStatus.ERROR,
        response: {
          status: AgentStatus.ERROR,
          prompt: null,
          analysis: null,
          error: "Review mode requires hydrate_results (prompt to review).",
        },
      };
    }

    const results = (hydrateResults.results as Record<string, unknown>[]) ?? [];
    if (!results.length) {
      return {
        status: AgentStatus.ERROR,
        response: {
          status: AgentStatus.ERROR,
          prompt: null,
          analysis: null,
          error: "No matching prompt found in vault to review.",
        },
      };
    }

    const promptData = results[0];
    const fullText = (promptData.full_prompt as string) ?? "";
    const issues: string[] = [];

    // Structural checks
    const requiredSections = [
      "角色", "任务", "输入", "输出格式", "硬约束", "生成要求",
    ];
    for (const section of requiredSections) {
      if (!fullText.includes(section)) {
        issues.push(`Missing section: ${section}`);
      }
    }

    // Constraint check
    const globalEntries =
      (hydrateResults.global_entries as Record<string, unknown>[]) ?? [];
    for (const entry of globalEntries) {
      for (const c of (entry.hard_constraints_added as string[]) ?? []) {
        if (!fullText.includes(c)) {
          issues.push(`GLOBAL constraint not reflected: ${c}`);
        }
      }
    }

    const reviewReport = issues.length
      ? issues.map((i) => `- ${i}`).join("\n")
      : "All checks passed.";

    return {
      status: AgentStatus.OK,
      response: {
        status: AgentStatus.OK,
        prompt: `## Review Report\n\n${reviewReport}\n\n---\n\n${fullText}`,
        analysis: null,
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

    if (this.state.quality_trend.length < maxCB) return false;

    const recent = this.state.quality_trend.slice(-maxCB);
    return recent.every(
      (val, i) => i === 0 || recent[i - 1] >= val,
    );
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
