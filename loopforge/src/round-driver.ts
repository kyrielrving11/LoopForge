/** Shared round lifecycle used by Runtime and MCP adapters.
 *
 * The driver owns compile -> state projection -> before evidence and
 * after evidence -> transaction evaluation. Transport-specific concerns such
 * as heartbeats, executor deadlines, MCP leases, and response formatting stay
 * in their adapters.
 */

import type { LoopStore } from "./loop-store.js";
import { LoopForgeEngine } from "./engine.js";
import { EvidenceCollector } from "./evidence-provider.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import { getPolicy, writeStateFile } from "./policy.js";
import type {
  LoopForgeRequest,
  LoopForgeResponse,
  PromptArtifact,
  SelfEvaluation,
} from "./protocol.js";
import {
  prepareRejectedAttempt,
  prepareRoundTransaction,
  RoundTransactionCoordinator,
} from "./round-transaction.js";
import type {
  RoundTransactionOutcome,
  RoundTransactionSnapshot,
} from "./round-transaction.js";

export interface PreparedRound {
  prompt: string;
  artifact?: PromptArtifact;
  level: "l0" | "l1" | "l2";
  evidenceBaseline: ProviderSnapshot[];
  snapshot: RoundTransactionSnapshot;
  stateFileContent?: string;
  warnings?: string[];
  /** v3.0.1: The full compile response. Callers may cache it (e.g. for the
   *  typed projection) instead of recompiling for derived views. */
  compileResponse?: LoopForgeResponse;
}

export interface CompleteRoundInput {
  snapshot: RoundTransactionSnapshot;
  loopId: string;
  task: string;
  maxRounds: number;
  selfEval: SelfEvaluation;
  lastSelfEval?: SelfEvaluation;
  consecutiveRejections: number;
  /** L4 (v3.7.x): previous round's rejection check (own-streak basis). */
  lastRejectionCheck?: string;
  successTrajectory: boolean[];
  /** v2.12: Current clarification streak for R7 escalation. */
  driftClarificationStreak?: number;
  /** v2.13: Files from skipped backtrack rounds for restore check. */
  backtrackSkippedFiles?: string[];
  /** M3 (v3.7.x): skipped-file git fingerprints at their failed rounds. */
  backtrackSkippedFingerprints?: Record<string, string>;
  /** v2.12: Git HEAD of the backtrack restore point (workspace restore check). */
  backtrackTargetGitHead?: string;
}

export interface CompletedRound {
  outcome: RoundTransactionOutcome;
  actualEvidence: ProviderSnapshot[];
}

export class RoundDriver {
  private readonly store: LoopStore;

  constructor(private readonly engine: LoopForgeEngine, store?: LoopStore) {
    this.store = store ?? engine.getStore();
  }

  async prepare(
    request: LoopForgeRequest,
    loopId: string,
    round: number,
  ): Promise<PreparedRound | null> {
    // v3.0.1: compile (CPU-bound) and before-evidence collection (external
    // process spawns) run concurrently — the git/command spawns were the
    // latency tail behind the old compile-first, evidence-second order.
    const [response, evidenceBaseline] = await Promise.all([
      Promise.resolve().then(() => this.compile(request, loopId, true)),
      this.collectEvidence(loopId, "before"),
    ]);
    if (!response) return null;
    return this.finishPrepare(response, loopId, round, evidenceBaseline);
  }

  private compile(
    request: LoopForgeRequest,
    loopId: string,
    persistLineage: boolean,
  ): LoopForgeResponse | null {
    const compiled = this.engine.invokeLoopCompile(
      request,
      undefined,
      { persistLineage },
    );
    const response = compiled.response;
    if (!response?.prompt) return null;
    writeStateFile(loopId, response.state_file_content);
    return response;
  }

  /** Compile a fresh prompt for a zero-commit enforcement retry. The logical
   * round ID and before-evidence snapshot remain stable; only attempt changes. */
  async prepareRetry(
    request: LoopForgeRequest,
    rejected: RoundTransactionSnapshot,
    rejectionNotice: string,
    consecutiveRejections: number,
  ): Promise<PreparedRound | null> {
    const retryRequest = {
      ...request,
      round: rejected.round,
      attempt: rejected.attempt + 1,
      consecutive_rejections: consecutiveRejections,
      rejection_notice: rejectionNotice,
      force_level: consecutiveRejections >= 2 ? "l2" : "l0",
    } as LoopForgeRequest;
    const response = this.compile(retryRequest, rejected.loopId, false);
    if (!response?.prompt_artifact) return null;
    const snapshot = prepareRejectedAttempt(rejected, response.prompt_artifact);
    return {
      prompt: response.prompt!,
      artifact: response.prompt_artifact,
      level: response.prompt_artifact.level,
      evidenceBaseline: rejected.beforeEvidence,
      snapshot,
      stateFileContent: response.state_file_content,
      warnings: response.warnings,
      compileResponse: response,
    };
  }

  private finishPrepare(
    response: LoopForgeResponse,
    loopId: string,
    round: number,
    evidenceBaseline: ProviderSnapshot[],
  ): PreparedRound {
    const artifact = response.prompt_artifact;
    const snapshot = prepareRoundTransaction(
      loopId,
      round,
      evidenceBaseline,
      artifact,
    );
    return {
      prompt: response.prompt!,
      artifact,
      level: artifact?.level ?? "l2",
      evidenceBaseline,
      snapshot,
      stateFileContent: response.state_file_content,
      warnings: response.warnings,
      compileResponse: response,
    };
  }

  async complete(input: CompleteRoundInput): Promise<CompletedRound> {
    const actualEvidence = await this.collectEvidence(input.loopId, "after");
    const transaction = new RoundTransactionCoordinator(
      this.engine,
      this.store,
    );
    const outcome = transaction.process({
      snapshot: input.snapshot,
      task: input.task,
      maxRounds: input.maxRounds,
      selfEval: input.selfEval,
      lastSelfEval: input.lastSelfEval,
      consecutiveRejections: input.consecutiveRejections,
      lastRejectionCheck: input.lastRejectionCheck,
      successTrajectory: input.successTrajectory,
      actualEvidence,
      driftClarificationStreak: input.driftClarificationStreak,
      backtrackSkippedFiles: input.backtrackSkippedFiles,
      backtrackSkippedFingerprints: input.backtrackSkippedFingerprints,
      backtrackTargetGitHead: input.backtrackTargetGitHead,
    });
    return { outcome, actualEvidence };
  }

  recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null {
    return new RoundTransactionCoordinator(
      this.engine,
      this.store,
    ).recover(snapshot);
  }

  private collectEvidence(
    loopId: string,
    phase: "before" | "after",
  ): Promise<ProviderSnapshot[]> {
    return EvidenceCollector.fromPolicy().collectAsync({ loopId, phase });
  }
}
