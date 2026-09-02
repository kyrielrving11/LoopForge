/** Shared round lifecycle used by Runtime and MCP adapters.
 *
 * The driver owns compile -> state projection -> before evidence and
 * after evidence -> transaction evaluation. Transport-specific concerns such
 * as heartbeats, executor deadlines, MCP leases, and response formatting stay
 * in their adapters.
 */
import { EvidenceCollector } from "./evidence-provider.js";
import { getPolicy, writeStateFile } from "./policy.js";
import { prepareRejectedAttempt, prepareRoundTransaction, RoundTransactionCoordinator, } from "./round-transaction.js";
export class RoundDriver {
    engine;
    store;
    constructor(engine, store) {
        this.engine = engine;
        this.store = store ?? engine.getStore();
    }
    async prepare(request, loopId, round) {
        // v3.0.1: compile (CPU-bound) and before-evidence collection (external
        // process spawns) run concurrently — the git/command spawns were the
        // latency tail behind the old compile-first, evidence-second order.
        const [response, evidenceBaseline] = await Promise.all([
            Promise.resolve().then(() => this.compile(request, loopId, true)),
            this.collectEvidence(loopId, "before"),
        ]);
        if (!response)
            return null;
        return this.finishPrepare(response, loopId, round, evidenceBaseline);
    }
    /** Synchronous fallback for legacy embedding APIs. Async evidence providers
     * are deliberately skipped by EvidenceCollector.collect(). */
    prepareSync(request, loopId, round) {
        const response = this.compile(request, loopId, true);
        if (!response)
            return null;
        const evidenceBaseline = EvidenceCollector.fromProviderNames(getPolicy().evidence.providers).collect({ loopId });
        return this.finishPrepare(response, loopId, round, evidenceBaseline);
    }
    compile(request, loopId, persistLineage) {
        const compiled = this.engine.invokeLoopCompile(request, undefined, { persistLineage });
        const response = compiled.response;
        if (!response?.prompt)
            return null;
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
        const response = this.compile(retryRequest, rejected.loopId, false);
        if (!response?.prompt_artifact)
            return null;
        const snapshot = prepareRejectedAttempt(rejected, response.prompt_artifact);
        return {
            prompt: response.prompt,
            artifact: response.prompt_artifact,
            level: response.prompt_artifact.level,
            evidenceBaseline: rejected.beforeEvidence,
            snapshot,
            stateFileContent: response.state_file_content,
            warnings: response.warnings,
            compileResponse: response,
        };
    }
    finishPrepare(response, loopId, round, evidenceBaseline) {
        const artifact = response.prompt_artifact;
        const snapshot = prepareRoundTransaction(loopId, round, evidenceBaseline, artifact);
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
    async complete(input) {
        const actualEvidence = await this.collectEvidence(input.loopId, "after");
        const transaction = new RoundTransactionCoordinator(this.engine, this.store);
        const outcome = transaction.process({
            snapshot: input.snapshot,
            task: input.task,
            maxRounds: input.maxRounds,
            selfEval: input.selfEval,
            lastSelfEval: input.lastSelfEval,
            consecutiveRejections: input.consecutiveRejections,
            successTrajectory: input.successTrajectory,
            actualEvidence,
            driftClarificationStreak: input.driftClarificationStreak,
            backtrackSkippedFiles: input.backtrackSkippedFiles,
            backtrackTargetGitHead: input.backtrackTargetGitHead,
        });
        return { outcome, actualEvidence };
    }
    recover(snapshot) {
        return new RoundTransactionCoordinator(this.engine, this.store).recover(snapshot);
    }
    collectEvidence(loopId, phase) {
        return EvidenceCollector.fromPolicy().collectAsync({ loopId, phase });
    }
}
//# sourceMappingURL=round-driver.js.map