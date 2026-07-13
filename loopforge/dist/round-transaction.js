/** Schema-versioned round transaction shared by Runtime and MCP.
 *
 * A logical round has one deterministic roundId. Rejected attempts keep the
 * same identity and before snapshot; only accepted decisions are committed to
 * feedback storage. The committed feedback embeds the decision so replay after
 * a process crash is idempotent.
 */
import { diffSnapshotCollections, extractFilesFromSnapshots, } from "./evidence-provider.js";
import { RoundCoordinator, } from "./round-coordinator.js";
import { logEvent, startSpan } from "./observability.js";
import { policyMetrics } from "./policy-metrics.js";
import { VaultRoundCommitStore } from "./storage.js";
export const ROUND_TRANSACTION_SCHEMA_VERSION = 1;
export function makeRoundId(loopId, round) {
    if (!Number.isInteger(round) || round < 1) {
        throw new Error(`Invalid round number: ${round}`);
    }
    return `loop:${loopId}:round:${round}`;
}
export function prepareRoundTransaction(loopId, round, beforeEvidence, promptArtifact) {
    const now = Date.now();
    return {
        schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
        roundId: makeRoundId(loopId, round),
        loopId,
        round,
        attempt: 1,
        phase: promptArtifact ? "prompted" : "prepared",
        beforeEvidence,
        createdAt: now,
        updatedAt: now,
        promptArtifact,
    };
}
/** Attach the next prompt attempt to a rejected logical round without changing
 * its identity or evidence baseline. Evaluation fields belong to the previous
 * attempt and are cleared before the Agent receives the retry prompt. */
export function prepareRejectedAttempt(rejected, promptArtifact) {
    if (rejected.phase !== "rejected") {
        throw new Error(`Cannot retry transaction in phase ${rejected.phase}`);
    }
    if (promptArtifact.roundId !== rejected.roundId) {
        throw new Error(`Retry prompt identity mismatch: ${promptArtifact.roundId} !== ${rejected.roundId}`);
    }
    if (promptArtifact.attempt !== rejected.attempt + 1) {
        throw new Error(`Retry prompt attempt mismatch: ${promptArtifact.attempt} !== ${rejected.attempt + 1}`);
    }
    return {
        ...rejected,
        attempt: promptArtifact.attempt,
        phase: "prompted",
        afterEvidence: undefined,
        roundEvidence: undefined,
        evaluation: undefined,
        result: undefined,
        promptArtifact,
        updatedAt: Date.now(),
    };
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isProcessResult(value) {
    if (!isRecord(value))
        return false;
    return ["continue", "stop", "reject", "terminate"].includes(String(value.action)) && Array.isArray(value.verificationFlags);
}
function parseProviderSnapshots(value) {
    if (!Array.isArray(value))
        return null;
    const snapshots = [];
    for (const item of value) {
        if (!isRecord(item))
            return null;
        if (typeof item.provider !== "string" ||
            typeof item.timestamp !== "number" ||
            !Array.isArray(item.files) ||
            !item.files.every((file) => typeof file === "string") ||
            !isRecord(item.data))
            return null;
        snapshots.push(item);
    }
    return snapshots;
}
/** Parse a persisted snapshot without trusting arbitrary vault data. */
export function parseRoundTransactionSnapshot(value) {
    if (!isRecord(value))
        return null;
    if (value.schemaVersion !== ROUND_TRANSACTION_SCHEMA_VERSION)
        return null;
    if (typeof value.roundId !== "string" || typeof value.loopId !== "string") {
        return null;
    }
    if (!Number.isInteger(value.round) || value.round < 1)
        return null;
    if (!Number.isInteger(value.attempt) || value.attempt < 1)
        return null;
    if (!["prepared", "prompted", "evaluated", "rejected", "committed", "terminated"]
        .includes(String(value.phase)))
        return null;
    const beforeEvidence = parseProviderSnapshots(value.beforeEvidence);
    if (!beforeEvidence)
        return null;
    const afterEvidence = value.afterEvidence === undefined
        ? undefined
        : parseProviderSnapshots(value.afterEvidence);
    if (value.afterEvidence !== undefined && !afterEvidence)
        return null;
    const roundEvidence = value.roundEvidence === undefined
        ? undefined
        : parseProviderSnapshots(value.roundEvidence);
    if (value.roundEvidence !== undefined && !roundEvidence)
        return null;
    if (value.result !== undefined && !isProcessResult(value.result))
        return null;
    if (value.promptArtifact !== undefined) {
        if (!isRecord(value.promptArtifact))
            return null;
        const artifact = value.promptArtifact;
        if (artifact.schemaVersion !== 1 ||
            typeof artifact.roundId !== "string" ||
            typeof artifact.renderedPrompt !== "string" ||
            typeof artifact.promptHash !== "string" ||
            typeof artifact.stateHash !== "string" ||
            !["l0", "l1", "l2"].includes(String(artifact.level)))
            return null;
    }
    const snapshot = {
        ...value,
        beforeEvidence,
        afterEvidence,
        roundEvidence,
    };
    if (snapshot.roundId !== makeRoundId(snapshot.loopId, snapshot.round)) {
        return null;
    }
    return snapshot;
}
export class RoundTransactionCoordinator {
    engine;
    backend;
    commitStore;
    constructor(engine, backend, commitStore) {
        this.engine = engine;
        this.backend = backend ?? engine.getBackend();
        this.commitStore = commitStore ?? new VaultRoundCommitStore(this.backend);
    }
    process(input) {
        const { snapshot } = input;
        const span = startSpan("round.transaction", {
            loopId: snapshot.loopId,
            round: snapshot.round,
            roundId: snapshot.roundId,
            attempt: snapshot.attempt,
        });
        const finish = (outcome) => {
            policyMetrics.recordRound(snapshot.loopId, outcome.result, outcome.replayed);
            span.end("ok", {
                action: outcome.result.action,
                replayed: outcome.replayed,
                phase: outcome.snapshot.phase,
            });
            return outcome;
        };
        try {
            const expectedRoundId = makeRoundId(snapshot.loopId, snapshot.round);
            if (snapshot.roundId !== expectedRoundId) {
                throw new Error(`Round snapshot identity mismatch: ${snapshot.roundId} !== ${expectedRoundId}`);
            }
            const committed = this.readCommitted(snapshot);
            if (committed) {
                logEvent("round_transaction_replay", {
                    loopId: snapshot.loopId,
                    round: snapshot.round,
                    roundId: snapshot.roundId,
                });
                return finish(committed);
            }
            const attempt = snapshot.phase === "rejected"
                ? snapshot.attempt + 1
                : snapshot.attempt;
            const roundEvidence = diffSnapshotCollections(snapshot.beforeEvidence, input.actualEvidence);
            const coordinator = new RoundCoordinator(this.backend);
            const result = coordinator.processRound({
                loopId: snapshot.loopId,
                task: input.task,
                currentRound: snapshot.round,
                maxRounds: input.maxRounds,
                selfEval: input.selfEval,
                extractionSucceeded: input.extractionSucceeded,
                lastSelfEval: input.lastSelfEval,
                consecutiveRejections: input.consecutiveRejections,
                runtimeFilesChanged: extractFilesFromSnapshots(roundEvidence),
                evidenceSnapshots: roundEvidence,
                successTrajectory: input.successTrajectory,
            });
            const evaluated = {
                ...snapshot,
                attempt,
                phase: "evaluated",
                afterEvidence: input.actualEvidence,
                roundEvidence,
                evaluation: input.selfEval,
                result,
                updatedAt: Date.now(),
            };
            if (result.action === "reject" || result.action === "terminate") {
                const terminalPhase = result.action === "reject" ? "rejected" : "terminated";
                return finish({
                    snapshot: { ...evaluated, phase: terminalPhase, updatedAt: Date.now() },
                    result,
                    replayed: false,
                });
            }
            const committedSnapshot = {
                ...evaluated,
                phase: "committed",
                updatedAt: Date.now(),
            };
            const metadata = {
                schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
                round_id: snapshot.roundId,
                snapshot: committedSnapshot,
                result,
            };
            this.engine.autoFeedback(input.selfEval, snapshot.loopId, snapshot.round, input.task, metadata);
            const persisted = this.readCommitted(committedSnapshot);
            if (!persisted) {
                throw new Error(`Round transaction commit failed: ${snapshot.roundId}`);
            }
            logEvent("round_transaction_commit", {
                loopId: snapshot.loopId,
                round: snapshot.round,
                roundId: snapshot.roundId,
                action: result.action,
            });
            return finish({ snapshot: committedSnapshot, result, replayed: false });
        }
        catch (error) {
            span.end("error", { error: String(error) });
            throw error;
        }
    }
    /** Recover an already committed decision without evaluating or writing. */
    recover(snapshot) {
        const span = startSpan("round.transaction.recover", {
            loopId: snapshot.loopId,
            round: snapshot.round,
            roundId: snapshot.roundId,
        });
        try {
            const outcome = this.readCommitted(snapshot);
            if (outcome) {
                policyMetrics.recordRound(snapshot.loopId, outcome.result, true);
            }
            span.end("ok", { recovered: outcome !== null });
            return outcome;
        }
        catch (error) {
            span.end("error", { error: String(error) });
            throw error;
        }
    }
    readCommitted(expected) {
        const taskId = `loop:${expected.loopId}:r${expected.round}:feedback`;
        const entries = this.commitStore.find(expected.loopId, expected.round);
        for (const entry of entries) {
            if (entry.task_id !== taskId)
                continue;
            const outcome = this.outcomeFromEntry(entry, expected.roundId);
            if (outcome)
                return outcome;
        }
        return null;
    }
    outcomeFromEntry(entry, expectedRoundId) {
        const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
        const transaction = lineage && isRecord(lineage.round_transaction)
            ? lineage.round_transaction
            : null;
        if (!transaction || transaction.round_id !== expectedRoundId)
            return null;
        const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
        const result = transaction.result;
        if (!snapshot || !isProcessResult(result))
            return null;
        return { snapshot, result, replayed: true };
    }
}
//# sourceMappingURL=round-transaction.js.map