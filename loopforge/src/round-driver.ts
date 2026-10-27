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
import type {
  WorkspaceCheckpointManifest,
} from "./protocol.js";
import type { BoundaryCapture } from "./git-boundary.js";
import { writeStateFile } from "./policy.js";
import { CompileFailureError } from "./errors.js";
import type {
  CompiledRoundFacts,
  LoopCompileRequest,
  LoopCompileResponse,
  OperatorAcceptance,
  PromptArtifact,
  SelfEvaluation,
  SubmissionDiagnostic,
} from "./protocol.js";
import type { CommittedHistory } from "./history.js";
import {
  prepareRejectedAttempt,
  prepareRoundTransaction,
  RoundTransactionCoordinator,
} from "./round-transaction.js";
import type {
  RoundTransactionOutcome,
  RoundTransactionSnapshot,
} from "./round-transaction.js";
import {
  buildCheckpointRef,
  CHECKPOINT_MAX_PATHS,
  FileWorkspaceCheckpointStore,
} from "./workspace-checkpoint.js";

/** A pre-collected before baseline, used by the post-restore redo path. The
 *  boundary is the same pass's Git boundary, so the redo's own before-image
 *  is exactly the verified restored state. */
export interface PreparedBaseline {
  observations: MachineObservation[];
  boundary?: BoundaryCapture;
}

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
  compileResponse?: LoopCompileResponse;
}

export interface CompleteRoundInput {
  snapshot: RoundTransactionSnapshot;
  loopId: string;
  task: string;
  maxRounds: number;
  /** v4.0.1: the pre-commit history the advance path already loaded. */
  history?: CommittedHistory;
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

  constructor(
    private readonly engine: LoopForgeEngine,
    store?: LoopStore,
    private readonly checkpointStore?: FileWorkspaceCheckpointStore,
  ) {
    this.store = store ?? engine.getStore();
  }

  async prepare(
    request: LoopCompileRequest,
    loopId: string,
    round: number,
    opts: {
      branchId?: string;
      operatorAcceptance?: OperatorAcceptance;
      /** Post-restore baseline: compile only, do not capture again. */
      baseline?: PreparedBaseline;
      /** Set on the redo transaction after a verified restore. */
      restore?: RoundTransactionSnapshot["restore"];
    } = {},
  ): Promise<PreparedRound> {
    let boundary: BoundaryCapture | undefined;
    let response: LoopCompileResponse;
    let evidenceBaseline: MachineObservation[];
    if (opts.baseline) {
      // v4.0.3: the redo compile carries the verified-restore fact so the
      // Recovery Brief never hard-codes `restore verified`.
      response = this.compile(
        opts.restore ? { ...request, restore_verified: true } : request,
        loopId,
        opts.operatorAcceptance,
      );
      evidenceBaseline = opts.baseline.observations;
      boundary = opts.baseline.boundary;
    } else {
      // v3.0.1: compile (CPU-bound) and before-evidence collection (external
      // process spawns) run concurrently — the git/command spawns were the
      // latency tail behind the old compile-first, evidence-second order.
      // v3.9.7: the Git provider materializes the checkpoint before-image in
      // the SAME boundary pass; no second hash.
      const [compiled, evidence] = await Promise.all([
        Promise.resolve().then(() =>
          this.compile(request, loopId, opts.operatorAcceptance)),
        this.collectEvidence(loopId, "before", this.checkpointStore
          ? {
              materializer: this.checkpointStore,
              boundarySink: (captured) => { boundary = captured; },
              maxPaths: CHECKPOINT_MAX_PATHS,
            }
          : undefined),
      ]);
      response = compiled;
      evidenceBaseline = evidence;
    }
    return this.finishPrepare(
      response,
      loopId,
      round,
      evidenceBaseline,
      opts,
      boundary,
    );
  }

  private compile(
    request: LoopCompileRequest,
    loopId: string,
    operatorAcceptance?: OperatorAcceptance,
  ): LoopCompileResponse {
    const response = this.engine.invokeLoopCompile(
      request,
      operatorAcceptance ? { operatorAcceptance } : {},
    );
    if (!response.prompt) {
      throw new CompileFailureError(
        response.error || "the compiler produced no prompt",
      );
    }
    writeStateFile(loopId, response.state_file_content);
    return response;
  }

  /** Compile a fresh prompt for a zero-commit enforcement retry. The logical
   * round ID and before-evidence snapshot remain stable; only attempt changes. */
  async prepareRetry(
    request: LoopCompileRequest,
    rejected: RoundTransactionSnapshot,
    rejectionNotice: string,
    consecutiveRejections: number,
  ): Promise<PreparedRound> {
    const retryRequest = {
      ...request,
      round: rejected.round,
      attempt: rejected.attempt + 1,
      consecutive_rejections: consecutiveRejections,
      rejection_notice: rejectionNotice,
      // v4.0.3: `force_level` was never consulted for attempt > 1 — the level
      // policy derives L0 (first retry) / L2 (repeated rejection) from facts.
    } as LoopCompileRequest;
    const response = this.compile(
      retryRequest,
      rejected.loopId,
      rejected.operatorAcceptance,
    );
    if (!response.prompt_artifact) {
      throw new CompileFailureError("the retry compiler produced no prompt artifact");
    }
    // v3.9.6: warnings live on the artifact; the session no longer mirrors
    // them, so a held prompt is self-contained across a restart. The
    // assembler owns `artifact.warnings`; the driver does not re-stamp it.
    const artifact: PromptArtifact = response.prompt_artifact;
    // v4.0.1: the compile response is the one source of the facts stamped at
    // commit. There is no second derivation from the objective or the rejected
    // attempt; a response missing them is a compile failure, not an input to
    // guess around.
    const compiled = response.compiled;
    const operatorAcceptance = response.operatorAcceptance;
    if (!compiled || !operatorAcceptance) {
      throw new CompileFailureError(
        "the retry compiler produced no compile facts or operator acceptance",
      );
    }
    const snapshot = prepareRejectedAttempt(
      rejected,
      artifact,
      compiled,
      operatorAcceptance,
    );
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
    response: LoopCompileResponse,
    loopId: string,
    round: number,
    evidenceBaseline: MachineObservation[],
    opts: {
      branchId?: string;
      operatorAcceptance?: OperatorAcceptance;
      baseline?: PreparedBaseline;
      restore?: RoundTransactionSnapshot["restore"];
    } = {},
    boundary?: BoundaryCapture,
  ): PreparedRound {
    const artifact: PromptArtifact | undefined = response.prompt_artifact;
    const observedGitBefore = evidenceBaseline.some(
      (observation) => observation.kind === "git" && observation.status === "observed",
    );
    let beforeCheckpointError:
      | { code: string; detail: string; at: number }
      | undefined;
    let manifest: WorkspaceCheckpointManifest | undefined;
    if (boundary?.materializationError) {
      beforeCheckpointError = {
        ...boundary.materializationError,
        at: Date.now(),
      };
    } else if (boundary &&
        Object.keys(boundary.fingerprints).length > CHECKPOINT_MAX_PATHS) {
      beforeCheckpointError = {
        code: "too_many_paths",
        detail: `boundary has more than ${CHECKPOINT_MAX_PATHS} paths`,
        at: Date.now(),
      };
    } else if (boundary && this.checkpointStore) {
      try {
        manifest = this.checkpointStore.persistManifest(round, "before", boundary);
      } catch (error) {
        beforeCheckpointError = {
          code: "checkpoint_write_failed",
          detail: String(error),
          at: Date.now(),
        };
      }
    } else if (observedGitBefore) {
      // A Git-observed transaction owes a before-image or an explicit error.
      beforeCheckpointError = {
        code: this.checkpointStore ? "boundary_unavailable" : "store_unavailable",
        detail: this.checkpointStore
          ? "the before-phase Git boundary was not materialized"
          : "no workspace checkpoint store is configured",
        at: Date.now(),
      };
    }
    // v4.0.1: compile facts and the operator surface come directly from the
    // compile response. The driver never re-derives either one.
    const compiled = response.compiled;
    const operatorAcceptance = response.operatorAcceptance;
    if (!compiled || !operatorAcceptance) {
      throw new CompileFailureError(
        "the compiler produced no compile facts or operator acceptance",
      );
    }
    const snapshot = prepareRoundTransaction(
      loopId,
      round,
      evidenceBaseline,
      artifact,
      {
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
        ...(operatorAcceptance ? { operatorAcceptance } : {}),
        compiled,
        ...(beforeCheckpointError ? { beforeCheckpointError } : {}),
      },
    );
    if (manifest) {
      snapshot.beforeCheckpoint = buildCheckpointRef(manifest, {
        transactionId: snapshot.transactionId,
        branchId: snapshot.branchId,
      });
      // prepareRoundTransaction records `store_unavailable` when no ref was
      // supplied at construction; the ref above supersedes that placeholder.
      delete snapshot.beforeCheckpointError;
    }
    if (opts.restore) snapshot.restore = opts.restore;
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

  /** The ONE coordinator construction for a write. The engine is not a write
   *  dependency. */
  private coordinator(): RoundTransactionCoordinator {
    return new RoundTransactionCoordinator(this.store);
  }

  async complete(input: CompleteRoundInput): Promise<CompletedRound> {
    const actualEvidence = await this.collectEvidence(input.loopId, "after");
    const transaction = this.coordinator();
    const outcome = transaction.process({
      snapshot: input.snapshot,
      task: input.task,
      maxRounds: input.maxRounds,
      ...(input.history ? { history: input.history } : {}),
      selfEval: input.selfEval,
      consecutiveRejections: input.consecutiveRejections,
      lastRejectionCheck: input.lastRejectionCheck,
      actualEvidence,
      entrypointTrust: input.entrypointTrust,
      normalizationDiagnostics: input.normalizationDiagnostics,
      submittedFields: input.submittedFields,
      ...(input.snapshot.beforeCheckpoint
        ? { beforeCheckpoint: input.snapshot.beforeCheckpoint }
        : {}),
      ...(this.checkpointStore
        ? {
            resolveCheckpointManifest: (ref: import("./protocol.js").CheckpointRef) =>
              this.checkpointStore!.readManifest(ref.checkpointId),
          }
        : {}),
    });
    return { outcome, actualEvidence };
  }

  /** v3.9.6: collect the abandoned round's after evidence, then commit the
   *  rollback directive. The Agent has already decided to abandon; this path
   *  never runs verification/enforcement on the abandoned work. */
  async completeRecovery(input: CompleteRecoveryInput): Promise<CompletedRound> {
    const actualEvidence = await this.collectEvidence(input.loopId, "after");
    const recovery = input.buildRecovery(actualEvidence);
    const outcome = this.coordinator().commitRecovery({
      snapshot: input.snapshot,
      loopId: input.loopId,
      recovery,
      actualEvidence,
    });
    return { outcome, actualEvidence };
  }

  recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null {
    return this.coordinator().recover(snapshot);
  }

  private collectEvidence(
    loopId: string,
    phase: "before" | "after",
    opts?: {
      materializer?: import("./git-boundary.js").BoundaryMaterializer;
      boundarySink?: (boundary: BoundaryCapture) => void;
      maxPaths?: number;
    },
  ): Promise<MachineObservation[]> {
    return EvidenceCollector.fromPolicy().collectAsync({
      loopId,
      phase,
      ...(opts?.materializer ? { materializer: opts.materializer } : {}),
      ...(opts?.boundarySink ? { boundarySink: opts.boundarySink } : {}),
      ...(opts?.maxPaths !== undefined ? { maxPaths: opts.maxPaths } : {}),
    });
  }
}
