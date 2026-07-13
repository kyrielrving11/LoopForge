/** Shared round lifecycle used by Runtime and MCP adapters.
 *
 * The driver owns compile -> state projection -> before evidence and
 * after evidence -> transaction evaluation. Transport-specific concerns such
 * as heartbeats, executor deadlines, MCP leases, and response formatting stay
 * in their adapters.
 */

import type { VaultBackend } from "./backends/interface.js";
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
}

export interface CompleteRoundInput {
  snapshot: RoundTransactionSnapshot;
  loopId: string;
  task: string;
  maxRounds: number;
  selfEval: SelfEvaluation;
  extractionSucceeded: boolean;
  lastSelfEval?: SelfEvaluation;
  consecutiveRejections: number;
  successTrajectory: boolean[];
}

export interface CompletedRound {
  outcome: RoundTransactionOutcome;
  actualEvidence: ProviderSnapshot[];
}

export class RoundDriver {
  private readonly backend: VaultBackend;

  constructor(private readonly engine: LoopForgeEngine, backend?: VaultBackend) {
    this.backend = backend ?? engine.getBackend();
  }

  async prepare(
    request: LoopForgeRequest,
    loopId: string,
    round: number,
  ): Promise<PreparedRound | null> {
    const response = this.compile(request, loopId, true);
    if (!response) return null;
    const evidenceBaseline = await this.collectEvidence(loopId, "before");
    return this.finishPrepare(response, loopId, round, evidenceBaseline);
  }

  /** Synchronous fallback for legacy embedding APIs. Async evidence providers
   * are deliberately skipped by EvidenceCollector.collect(). */
  prepareSync(
    request: LoopForgeRequest,
    loopId: string,
    round: number,
  ): PreparedRound | null {
    const response = this.compile(request, loopId, true);
    if (!response) return null;
    const evidenceBaseline = EvidenceCollector.fromProviderNames(
      getPolicy().evidence.providers,
    ).collect({ loopId });
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
    };
  }

  async complete(input: CompleteRoundInput): Promise<CompletedRound> {
    const actualEvidence = await this.collectEvidence(input.loopId, "after");
    const transaction = new RoundTransactionCoordinator(
      this.engine,
      this.backend,
    );
    const outcome = transaction.process({
      snapshot: input.snapshot,
      task: input.task,
      maxRounds: input.maxRounds,
      selfEval: input.selfEval,
      extractionSucceeded: input.extractionSucceeded,
      lastSelfEval: input.lastSelfEval,
      consecutiveRejections: input.consecutiveRejections,
      successTrajectory: input.successTrajectory,
      actualEvidence,
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
    return EvidenceCollector.fromPolicy().collectAsync({ loopId, phase });
  }
}
