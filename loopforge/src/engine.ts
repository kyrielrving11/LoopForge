import { randomUUID } from "node:crypto";
import type { VaultBackend, VaultEntry } from "./backends/interface.js";
import { FileLoopStore, LoopStoreBackend } from "./loop-store.js";
import type { LoopStore } from "./loop-store.js";
import {
  AgentStatus,
  makeLoopCompileRequest,
  type AgentLoopResult,
  type LoopCompileRequest,
  type LoopCompileResponse,
  type LoopForgeRequest,
  type NormalizedRoundEvaluation,
} from "./protocol.js";
import { compileLoop } from "./loop-compiler.js";
import { policyMetrics } from "./policy-metrics.js";

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
  sessionStart: number;
}

export class LoopForgeEngine {
  private readonly backend: VaultBackend;
  private readonly metrics: EngineMetrics = { vaultWriteErrors: 0, sessionStart: Date.now() };

  constructor(storeOrBackend?: LoopStore | VaultBackend) {
    if (storeOrBackend && "queryEntries" in storeOrBackend) {
      this.backend = storeOrBackend;
    } else {
      this.backend = new LoopStoreBackend(storeOrBackend ?? new FileLoopStore());
    }
  }

  getBackend(): VaultBackend {
    return this.backend;
  }

  getMetrics(): EngineMetrics {
    return { ...this.metrics };
  }

  hydrateLoopContext(loopId: string): Record<string, unknown> | null {
    const results = [
      ...this.backend.queryEntries({ prefix: `loop:${loopId}:r` }),
      ...this.backend.queryEntries({ prefix: `loop:${loopId}:r`, feedbackOnly: true }),
    ];
    return results.length ? { results } : null;
  }

  private append(entry: VaultEntry): void {
    try {
      this.backend.appendEntry(entry);
    } catch {
      this.metrics.vaultWriteErrors++;
      policyMetrics.recordVaultWriteError("engine_append");
      throw new Error(`LoopForge durable write failed for ${entry.task_id}`);
    }
  }

  private persistLineage(response: LoopCompileResponse, request: LoopCompileRequest): void {
    this.append({
      id: randomUUID(),
      task_id: `loop:${response.loop_id}:r${response.round}`,
      version_tag: "v3",
      is_active: true,
      timestamp: new Date().toISOString(),
      user_intent: `compile round ${response.round}`,
      task_type: "loop_lineage",
      loop_id: response.loop_id,
      task: request.task,
      loop_objective: response.loop_objective as unknown as Record<string, unknown> | null,
      loop_lineage: {
        loop_id: response.loop_id,
        round: response.round,
        goal_id: response.goal_id,
        goal_text_hash: response.goal_text_hash,
        recompile_level: response.recompile_level,
        constraints_active: response.constraints_active,
      },
      tags: [response.loop_id, response.recompile_level, response.goal_id],
    });
  }

  recordDelegation(loopId: string, round: number, entries: DelegationEntry[]): void {
    if (!entries.length) return;
    this.append({
      id: randomUUID(),
      task_id: `loop:${loopId}:r${round}:delegations`,
      version_tag: "v3",
      is_active: true,
      timestamp: new Date().toISOString(),
      user_intent: "delegation journal",
      task_type: "delegation_journal",
      loop_id: loopId,
      loop_lineage: { round },
      delegations: entries,
    });
  }

  autoFeedback(
    evaluation: NormalizedRoundEvaluation,
    loopId: string,
    round: number,
    task: string,
    roundTransaction?: Record<string, unknown>,
  ): boolean {
    const taskId = `loop:${loopId}:r${round}:feedback`;
    const transactionId = typeof roundTransaction?.round_id === "string" ? roundTransaction.round_id : null;
    const alreadyCommitted = (): boolean => transactionId !== null && this.backend.queryEntries({
      prefix: taskId,
      feedbackOnly: true,
    }).some((entry) => {
      const transaction = entry.loop_lineage?.round_transaction;
      return transaction && typeof transaction === "object" && !Array.isArray(transaction) &&
        (transaction as Record<string, unknown>).round_id === transactionId;
    });

    if (!alreadyCommitted()) {
      this.append({
        id: randomUUID(),
        task_id: taskId,
        version_tag: "v3",
        is_active: true,
        timestamp: new Date().toISOString(),
        user_intent: task.slice(0, 200),
        task_type: "round_feedback",
        loop_id: loopId,
        round_report: evaluation.report,
        evidence_envelope: evaluation.evidenceEnvelope,
        material_advancement: evaluation.materialAdvancement ?? null,
        delegations: evaluation.report.delegations ?? [],
        loop_lineage: roundTransaction
          ? { round, round_id: roundTransaction.round_id, round_transaction: roundTransaction }
          : { round },
      });
      if (transactionId && !alreadyCommitted()) throw new Error(`Round feedback commit failed: ${transactionId}`);
    }

    const delegations = evaluation.report.delegations ?? [];
    if (delegations.length) {
      this.recordDelegation(loopId, round, delegations.map((item, index) => ({
        index: index + 1,
        agentId: item.agentId,
        subAgentType: item.subAgentType,
        subTask: item.subTask,
        resultSummary: item.resultSummary,
        success: item.success,
        discoveredConstraints: item.discoveredConstraints ?? [],
      })));
    }

    return evaluation.report.status === "completed";
  }

  invokeLoopCompile(
    request: LoopForgeRequest,
    hydrateResults?: Record<string, unknown> | null,
    options: { persistLineage?: boolean } = {},
  ): AgentLoopResult {
    const raw = request as Record<string, unknown>;
    const compiledRequest = makeLoopCompileRequest({
      loop_id: typeof raw.loop_id === "string" ? raw.loop_id : "",
      round: typeof raw.round === "number" ? raw.round : 1,
      round_id: typeof raw.round_id === "string" ? raw.round_id : undefined,
      goal_id: typeof raw.goal_id === "string" ? raw.goal_id : "",
      task: request.task,
      domain: typeof raw.domain === "string" ? raw.domain : "",
      loop_objective: raw.loop_objective && typeof raw.loop_objective === "object"
        ? raw.loop_objective as LoopCompileRequest["loop_objective"]
        : null,
      compilation_context: raw.compilation_context && typeof raw.compilation_context === "object" && !Array.isArray(raw.compilation_context)
        ? raw.compilation_context as LoopCompileRequest["compilation_context"]
        : null,
      plan_boundary: raw.plan_boundary === true,
      constraints_from_plan: Array.isArray(raw.constraints_from_plan)
        ? raw.constraints_from_plan.filter((item): item is string => typeof item === "string")
        : [],
      new_since_last_round: typeof raw.new_since_last_round === "string" ? raw.new_since_last_round : "",
      last_evaluation: raw.last_evaluation && typeof raw.last_evaluation === "object"
        ? raw.last_evaluation as LoopCompileRequest["last_evaluation"]
        : null,
      force_level: typeof raw.force_level === "string" ? raw.force_level : "auto",
      external_context: typeof raw.external_context === "string" ? raw.external_context : "",
      max_rounds: typeof raw.max_rounds === "number" ? raw.max_rounds : undefined,
      verification_flags: Array.isArray(raw.verification_flags)
        ? raw.verification_flags as LoopCompileRequest["verification_flags"]
        : [],
      attempt: typeof raw.attempt === "number" ? raw.attempt : 1,
      consecutive_rejections: typeof raw.consecutive_rejections === "number" ? raw.consecutive_rejections : 0,
      rejection_notice: typeof raw.rejection_notice === "string" ? raw.rejection_notice : "",
      report_contract: raw.report_contract === "round_report_v1" ? "round_report_v1" : undefined,
      report_mode: typeof raw.report_mode === "string"
        ? raw.report_mode as LoopCompileRequest["report_mode"]
        : undefined,
      report_claim_targets: Array.isArray(raw.report_claim_targets)
        ? raw.report_claim_targets as LoopCompileRequest["report_claim_targets"]
        : [],
      graph_slice: raw.graph_slice && typeof raw.graph_slice === "object" && !Array.isArray(raw.graph_slice)
        ? raw.graph_slice as LoopCompileRequest["graph_slice"]
        : undefined,
    });

    const context = hydrateResults ?? (compiledRequest.round > 1
      ? this.hydrateLoopContext(compiledRequest.loop_id)
      : null);
    try {
      const response = compileLoop(compiledRequest, context);
      if (options.persistLineage !== false) this.persistLineage(response, compiledRequest);
      return {
        status: AgentStatus.OK,
        response: {
          status: AgentStatus.OK,
          prompt: response.prompt,
          error: null,
          state_file_content: response.state_file_content,
          prompt_artifact: response.prompt_artifact,
          warnings: response.warnings,
        },
      };
    } catch (error) {
      return {
        status: AgentStatus.ERROR,
        response: {
          status: AgentStatus.ERROR,
          prompt: null,
          error: `loop_compile failed: ${String(error)}`,
        },
      };
    }
  }
}

export function createEngine(store?: LoopStore | VaultBackend): LoopForgeEngine {
  return new LoopForgeEngine(store);
}
