/** Shared round lifecycle used by Runtime and MCP adapters.
 *
 * The driver owns compile -> state projection -> before evidence and
 * after evidence -> transaction evaluation. Transport-specific concerns such
 * as heartbeats, executor deadlines, MCP leases, and response formatting stay
 * in their adapters.
 */

import type { VaultBackend } from "./backends/interface.js";
import { LoopForgeEngine } from "./engine.js";
import { diffSnapshotCollections, EvidenceCollector } from "./evidence-provider.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import { getPolicy, writeStateFile } from "./policy.js";
import type {
  LoopForgeRequest,
  LoopForgeResponse,
  NormalizedRoundEvaluation,
  PromptArtifact,
} from "./protocol.js";
import {
  prepareRejectedAttempt,
  prepareRoundTransaction,
  RoundTransactionCoordinator,
} from "./round-transaction.js";
import { mergeRuntimeEvidence } from "./round-report.js";
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
}

export interface CompleteRoundInput {
  snapshot: RoundTransactionSnapshot;
  loopId: string;
  task: string;
  maxRounds: number;
  evaluation: NormalizedRoundEvaluation;
  previousEvaluation?: NormalizedRoundEvaluation;
  consecutiveRejections: number;
  successTrajectory: boolean[];
  /** Files from skipped backtrack rounds for restore verification. */
  backtrackSkippedFiles?: string[];
}

export interface CompletedRound {
  outcome: RoundTransactionOutcome;
  actualEvidence: ProviderSnapshot[];
}

export class RoundDriver {
  private readonly backend: VaultBackend;

  constructor(private readonly engine: LoopForgeEngine, backend?: VaultBackend, private readonly workspaceRoot?: string) {
    this.backend = backend ?? engine.getBackend();
  }

  async prepare(
    request: LoopForgeRequest,
    loopId: string,
    round: number,
    executionEpoch = 0,
  ): Promise<PreparedRound | null> {
    const response = this.compile(request, loopId, true);
    if (!response) return null;
    const evidenceBaseline = await this.collectEvidence(loopId, "before");
    return this.finishPrepare(response, loopId, round, evidenceBaseline, executionEpoch);
  }

  /** Synchronous recovery path. Async evidence providers are deliberately
   * skipped while reconstructing a persisted prompt. */
  prepareSync(
    request: LoopForgeRequest,
    loopId: string,
    round: number,
    executionEpoch = 0,
  ): PreparedRound | null {
    const response = this.compile(request, loopId, true);
    if (!response) return null;
    const evidenceBaseline = EvidenceCollector.fromProviderNames(
      getPolicy().evidence.providers,
    ).collect({ loopId });
    return this.finishPrepare(response, loopId, round, evidenceBaseline, executionEpoch);
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
    writeStateFile(loopId, response.state_file_content, this.workspaceRoot);
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
    };
  }

  private finishPrepare(
    response: LoopForgeResponse,
    loopId: string,
    round: number,
    evidenceBaseline: ProviderSnapshot[],
    executionEpoch: number,
  ): PreparedRound {
    const artifact = response.prompt_artifact;
    const snapshot = prepareRoundTransaction(
      loopId,
      round,
      evidenceBaseline,
      artifact,
      executionEpoch,
    );
    return {
      prompt: response.prompt!,
      artifact,
      level: artifact?.level ?? "l2",
      evidenceBaseline,
      snapshot,
      stateFileContent: response.state_file_content,
      warnings: response.warnings,
    };
  }

  async complete(input: CompleteRoundInput): Promise<CompletedRound> {
    const actualEvidence = await this.collectEvidence(input.loopId, "after");
    mergeRuntimeEvidence(
      input.evaluation,
      diffSnapshotCollections(input.snapshot.beforeEvidence, actualEvidence),
      input.previousEvaluation,
    );
    const transaction = new RoundTransactionCoordinator(
      this.engine,
      this.backend,
    );
    const outcome = transaction.process({
      snapshot: input.snapshot,
      task: input.task,
      maxRounds: input.maxRounds,
      evaluation: input.evaluation,
      previousEvaluation: input.previousEvaluation,
      consecutiveRejections: input.consecutiveRejections,
      successTrajectory: input.successTrajectory,
      actualEvidence,
      backtrackSkippedFiles: input.backtrackSkippedFiles,
    });
    return { outcome, actualEvidence };
  }

  recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null {
    return new RoundTransactionCoordinator(
      this.engine,
      this.backend,
    ).recover(snapshot);
  }

  private collectEvidence(
    loopId: string,
    phase: "before" | "after",
  ): Promise<ProviderSnapshot[]> {
    return EvidenceCollector.fromPolicy(this.workspaceRoot).collectAsync({ loopId, phase, workspaceRoot: this.workspaceRoot });
  }
}
