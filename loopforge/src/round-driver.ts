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
import type { MachineObservation } from "./protocol.js";
import { writeStateFile } from "./policy.js";
import type {
  LoopForgeRequest,
  LoopForgeResponse,
  OperatorAcceptance,
  PromptArtifact,
  SelfEvaluation,
  SubmissionDiagnostic,
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
  evidenceBaseline: MachineObservation[];
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
  consecutiveRejections: number;
  /** L4 (v3.7.x): previous round's rejection check (own-streak basis). */
  lastRejectionCheck?: string;
  /** v3.8.3: trusted round-start entrypoint fingerprints (see RoundProcessInput). */
  entrypointTrust?: Record<string, string>;
  /** v3.9.1: normalization diagnostics and the submitted-field manifest. */
  normalizationDiagnostics?: SubmissionDiagnostic[];
  submittedFields?: string[];
}

export interface CompletedRound {
  outcome: RoundTransactionOutcome;
  actualEvidence: MachineObservation[];
}

export interface CompleteRecoveryInput {
  snapshot: RoundTransactionSnapshot;
  loopId: string;
  /** Built after the after-phase evidence has been collected, because the
   *  directive's skipped-file facts depend on it. */
  buildRecovery: (
    actualEvidence: MachineObservation[],
  ) => import("./protocol.js").RecoveryDirective;
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
    opts: { branchId?: string; operatorAcceptance?: OperatorAcceptance } = {},
  ): Promise<PreparedRound | null> {
    // v3.0.1: compile (CPU-bound) and before-evidence collection (external
    // process spawns) run concurrently — the git/command spawns were the
    // latency tail behind the old compile-first, evidence-second order.
    const [response, evidenceBaseline] = await Promise.all([
      Promise.resolve().then(() => this.compile(request, loopId, true)),
      this.collectEvidence(loopId, "before"),
    ]);
    if (!response) return null;
    return this.finishPrepare(response, loopId, round, evidenceBaseline, opts);
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
    // v3.9.6: warnings live on the artifact; the session no longer mirrors
    // them, so a held prompt is self-contained across a restart.
    const artifact: PromptArtifact = {
      ...response.prompt_artifact,
      warnings: [...(response.warnings ?? [])],
    };
    const snapshot = prepareRejectedAttempt(rejected, artifact);
    return {
      prompt: response.prompt!,
      artifact,
      level: artifact.level,
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
    evidenceBaseline: MachineObservation[],
    opts: { branchId?: string; operatorAcceptance?: OperatorAcceptance } = {},
  ): PreparedRound {
    const rawArtifact = response.prompt_artifact;
    const artifact: PromptArtifact | undefined = rawArtifact
      ? { ...rawArtifact, warnings: [...(response.warnings ?? [])] }
      : undefined;
    const snapshot = prepareRoundTransaction(
      loopId,
      round,
      evidenceBaseline,
      artifact,
      {
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
        ...(opts.operatorAcceptance
          ? { operatorAcceptance: opts.operatorAcceptance }
          : {}),
      },
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
      consecutiveRejections: input.consecutiveRejections,
      lastRejectionCheck: input.lastRejectionCheck,
      actualEvidence,
      entrypointTrust: input.entrypointTrust,
      normalizationDiagnostics: input.normalizationDiagnostics,
      submittedFields: input.submittedFields,
    });
    return { outcome, actualEvidence };
  }

  /** v3.9.6: collect the abandoned round's after evidence, then commit the
   *  rollback directive. The Agent has already decided to abandon; this path
   *  never runs verification/enforcement on the abandoned work. */
  async completeRecovery(input: CompleteRecoveryInput): Promise<CompletedRound> {
    const actualEvidence = await this.collectEvidence(input.loopId, "after");
    const recovery = input.buildRecovery(actualEvidence);
    const outcome = new RoundTransactionCoordinator(
      this.engine,
      this.store,
    ).commitRecovery({
      snapshot: input.snapshot,
      loopId: input.loopId,
      recovery,
      actualEvidence,
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
  ): Promise<MachineObservation[]> {
    return EvidenceCollector.fromPolicy().collectAsync({ loopId, phase });
  }
}
