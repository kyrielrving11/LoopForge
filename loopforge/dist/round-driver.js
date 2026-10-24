/** Shared round lifecycle used by Runtime and MCP adapters.
 *
 * The driver owns compile -> state projection -> before evidence and
 * after evidence -> transaction evaluation. Transport-specific concerns such
 * as heartbeats, executor deadlines, MCP leases, and response formatting stay
 * in their adapters.
 */
import { EvidenceCollector } from "./evidence-provider.js";
import { writeStateFile } from "./policy.js";
import { CompileFailureError } from "./errors.js";
import { prepareRejectedAttempt, prepareRoundTransaction, RoundTransactionCoordinator, } from "./round-transaction.js";
import { buildCheckpointRef, CHECKPOINT_MAX_PATHS, } from "./workspace-checkpoint.js";
export class RoundDriver {
    engine;
    checkpointStore;
    store;
    constructor(engine, store, checkpointStore) {
        this.engine = engine;
        this.checkpointStore = checkpointStore;
        this.store = store ?? engine.getStore();
    }
    async prepare(request, loopId, round, opts = {}) {
        let boundary;
        let response;
        let evidenceBaseline;
        if (opts.baseline) {
            response = this.compile(request, loopId, opts.operatorAcceptance);
            evidenceBaseline = opts.baseline.observations;
            boundary = opts.baseline.boundary;
        }
        else {
            // v3.0.1: compile (CPU-bound) and before-evidence collection (external
            // process spawns) run concurrently — the git/command spawns were the
            // latency tail behind the old compile-first, evidence-second order.
            // v3.9.7: the Git provider materializes the checkpoint before-image in
            // the SAME boundary pass; no second hash.
            const [compiled, evidence] = await Promise.all([
                Promise.resolve().then(() => this.compile(request, loopId, opts.operatorAcceptance)),
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
        return this.finishPrepare(response, loopId, round, evidenceBaseline, opts, boundary);
    }
    compile(request, loopId, operatorAcceptance) {
        const response = this.engine.invokeLoopCompile(request, operatorAcceptance ? { operatorAcceptance } : {});
        if (!response.prompt) {
            throw new CompileFailureError(response.error || "the compiler produced no prompt");
        }
        writeStateFile(loopId, response.state_file_content);
        return response;
    }
    /** Compile a fresh prompt for a zero-commit enforcement retry. The logical
     * round ID and before-evidence snapshot remain stable; only attempt changes. */
    async prepareRetry(request, rejected, rejectionNotice, consecutiveRejections) {
        const retryRequest = {
            ...request,
            round: rejected.round,
            attempt: rejected.attempt + 1,
            consecutive_rejections: consecutiveRejections,
            rejection_notice: rejectionNotice,
            force_level: consecutiveRejections >= 2 ? "l2" : "l0",
        };
        const response = this.compile(retryRequest, rejected.loopId, rejected.operatorAcceptance);
        if (!response.prompt_artifact) {
            throw new CompileFailureError("the retry compiler produced no prompt artifact");
        }
        // v3.9.6: warnings live on the artifact; the session no longer mirrors
        // them, so a held prompt is self-contained across a restart.
        const artifact = {
            ...response.prompt_artifact,
            warnings: [...(response.warnings ?? [])],
        };
        // v4.0.1: the compile response is the one source of the facts stamped at
        // commit. There is no second derivation from the objective or the rejected
        // attempt; a response missing them is a compile failure, not an input to
        // guess around.
        const compiled = response.compiled;
        const operatorAcceptance = response.operatorAcceptance;
        if (!compiled || !operatorAcceptance) {
            throw new CompileFailureError("the retry compiler produced no compile facts or operator acceptance");
        }
        const snapshot = prepareRejectedAttempt(rejected, artifact, compiled, operatorAcceptance);
        return {
            prompt: response.prompt,
            artifact,
            level: artifact.level,
            evidenceBaseline: rejected.beforeEvidence,
            snapshot,
            stateFileContent: response.state_file_content,
            warnings: response.warnings,
            compileResponse: response,
        };
    }
    finishPrepare(response, loopId, round, evidenceBaseline, opts = {}, boundary) {
        const rawArtifact = response.prompt_artifact;
        const artifact = rawArtifact
            ? { ...rawArtifact, warnings: [...(response.warnings ?? [])] }
            : undefined;
        const observedGitBefore = evidenceBaseline.some((observation) => observation.kind === "git" && observation.status === "observed");
        let beforeCheckpointError;
        let manifest;
        if (boundary?.materializationError) {
            beforeCheckpointError = {
                ...boundary.materializationError,
                at: Date.now(),
            };
        }
        else if (boundary &&
            Object.keys(boundary.fingerprints).length > CHECKPOINT_MAX_PATHS) {
            beforeCheckpointError = {
                code: "too_many_paths",
                detail: `boundary has more than ${CHECKPOINT_MAX_PATHS} paths`,
                at: Date.now(),
            };
        }
        else if (boundary && this.checkpointStore) {
            try {
                manifest = this.checkpointStore.persistManifest(round, "before", boundary);
            }
            catch (error) {
                beforeCheckpointError = {
                    code: "checkpoint_write_failed",
                    detail: String(error),
                    at: Date.now(),
                };
            }
        }
        else if (observedGitBefore) {
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
            throw new CompileFailureError("the compiler produced no compile facts or operator acceptance");
        }
        const snapshot = prepareRoundTransaction(loopId, round, evidenceBaseline, artifact, {
            ...(opts.branchId ? { branchId: opts.branchId } : {}),
            ...(operatorAcceptance ? { operatorAcceptance } : {}),
            compiled,
            ...(beforeCheckpointError ? { beforeCheckpointError } : {}),
        });
        if (manifest) {
            snapshot.beforeCheckpoint = buildCheckpointRef(manifest, {
                transactionId: snapshot.transactionId,
                branchId: snapshot.branchId,
            });
            // prepareRoundTransaction records `store_unavailable` when no ref was
            // supplied at construction; the ref above supersedes that placeholder.
            delete snapshot.beforeCheckpointError;
        }
        if (opts.restore)
            snapshot.restore = opts.restore;
        return {
            prompt: response.prompt,
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
    coordinator() {
        return new RoundTransactionCoordinator(this.store);
    }
    async complete(input) {
        const actualEvidence = await this.collectEvidence(input.loopId, "after");
        const transaction = this.coordinator();
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
            ...(input.snapshot.beforeCheckpoint
                ? { beforeCheckpoint: input.snapshot.beforeCheckpoint }
                : {}),
            ...(this.checkpointStore
                ? {
                    resolveCheckpointManifest: (ref) => this.checkpointStore.readManifest(ref.checkpointId),
                }
                : {}),
        });
        return { outcome, actualEvidence };
    }
    /** v3.9.6: collect the abandoned round's after evidence, then commit the
     *  rollback directive. The Agent has already decided to abandon; this path
     *  never runs verification/enforcement on the abandoned work. */
    async completeRecovery(input) {
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
    recover(snapshot) {
        return this.coordinator().recover(snapshot);
    }
    collectEvidence(loopId, phase, opts) {
        return EvidenceCollector.fromPolicy().collectAsync({
            loopId,
            phase,
            ...(opts?.materializer ? { materializer: opts.materializer } : {}),
            ...(opts?.boundarySink ? { boundarySink: opts.boundarySink } : {}),
            ...(opts?.maxPaths !== undefined ? { maxPaths: opts.maxPaths } : {}),
        });
    }
}
//# sourceMappingURL=round-driver.js.map