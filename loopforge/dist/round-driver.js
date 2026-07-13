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
    backend;
    constructor(engine, backend) {
        this.engine = engine;
        this.backend = backend ?? engine.getBackend();
    }
    async prepare(request, loopId, round) {
        const response = this.compile(request, loopId, true);
        if (!response)
            return null;
        const evidenceBaseline = await this.collectEvidence(loopId, "before");
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
        };
    }
    async complete(input) {
        const actualEvidence = await this.collectEvidence(input.loopId, "after");
        const transaction = new RoundTransactionCoordinator(this.engine, this.backend);
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
    recover(snapshot) {
        return new RoundTransactionCoordinator(this.engine, this.backend).recover(snapshot);
    }
    collectEvidence(loopId, phase) {
        return EvidenceCollector.fromPolicy().collectAsync({ loopId, phase });
    }
}
//# sourceMappingURL=round-driver.js.map