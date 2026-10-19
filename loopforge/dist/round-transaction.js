/** Schema-versioned round transaction shared by Runtime and MCP.
 *
 * A logical round has one deterministic roundId. Rejected attempts keep the
 * same identity and before snapshot; only accepted decisions are committed to
 * feedback storage. The committed feedback embeds the decision so replay after
 * a process crash is idempotent.
 */
import { deriveObservationDeltas } from "./evidence-provider.js";
import { RoundCoordinator, } from "./round-coordinator.js";
import { logEvent } from "./observability.js";
import { deriveContractId, deriveContractItemIds, isRecord } from "./token-utils.js";
import { GIT_OBSERVATION_SCHEMA_VERSION, PROMPT_ARTIFACT_SCHEMA_VERSION, } from "./protocol.js";
import { commandConfigHash, getPolicy } from "./policy.js";
import { policyMetrics } from "./policy-metrics.js";
import { VaultRoundCommitStore } from "./storage.js";
/** v3.9.1: schema 3 embeds Git observation schema 2 (complete boundary
 *  fingerprints) and later adds optional diagnostics/manifest fields. */
export const ROUND_TRANSACTION_SCHEMA_VERSION = 3;
/** v3.8: the closed set of machine-observation statuses. */
const OBSERVATION_STATUSES = [
    "observed", "passed", "failed", "timeout", "unavailable", "error", "aborted",
];
/** v3.8/v3.9.1: The round's observation delta (before → after). Each entry
 *  carries raw before/after references; Git's `changedFiles` is the only
 *  file-change fact and is null when the pair cannot be compared. DERIVED,
 *  never persisted: the transaction stores only the two factual observation
 *  collections, and every reader (gates, metrics, git-motion series, replay,
 *  audit) consumes this one derivation. */
export function deriveRoundObservationDelta(before, after) {
    return deriveObservationDeltas(before, after);
}
/** v3.8: The schema version stamped on a persisted transaction envelope, or
 *  null when the value is not a transaction envelope at all. Used to surface
 *  legacy documents explicitly instead of letting them vanish from history. */
export function transactionSchemaVersionOf(value) {
    if (!isRecord(value))
        return null;
    return typeof value.schemaVersion === "number" ? value.schemaVersion : null;
}
/** v3.8: Resolve the machine binding a contract proposal carries at commit. */
function resolveContractBinding(proposal, loopId) {
    if (!proposal || !Array.isArray(proposal.items) || proposal.items.length === 0) {
        return undefined;
    }
    const commands = getPolicy().evidence.commands ?? [];
    const byName = new Map(commands.map((command) => [command.name, command]));
    const configHashByCommand = {};
    for (const item of proposal.items) {
        for (const commandId of item.verify_with ?? []) {
            const command = byName.get(commandId);
            if (command)
                configHashByCommand[commandId] = commandConfigHash(command);
        }
    }
    return {
        rc_id: deriveContractId(loopId, proposal),
        item_ids: deriveContractItemIds(proposal.items),
        config_hash_by_command: configHashByCommand,
    };
}
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
        evaluation: undefined,
        result: undefined,
        // The rejected attempt's diagnostics were returned in its receipt; the
        // retry has not submitted a new payload yet.
        normalizationDiagnostics: undefined,
        submittedFields: undefined,
        promptArtifact,
        updatedAt: Date.now(),
    };
}
/** v3.8: Shape check for a persisted contract binding. */
function isContractBinding(value) {
    if (!isRecord(value))
        return false;
    if (typeof value.rc_id !== "string" || !Array.isArray(value.item_ids))
        return false;
    if (!value.item_ids.every((id) => typeof id === "string"))
        return false;
    return isRecord(value.config_hash_by_command);
}
export function isProcessResult(value) {
    if (!isRecord(value))
        return false;
    return ["continue", "stop", "reject", "terminate", "backtrack"].includes(String(value.action)) && Array.isArray(value.verificationFlags);
}
function parseMachineObservations(value) {
    if (!Array.isArray(value))
        return null;
    const observations = [];
    for (const item of value) {
        if (!isRecord(item))
            return null;
        if (typeof item.providerId !== "string" ||
            (item.kind !== "git" && item.kind !== "command" && item.kind !== "custom") ||
            (item.phase !== "before" && item.phase !== "after") ||
            typeof item.startedAt !== "number" ||
            typeof item.finishedAt !== "number" ||
            !OBSERVATION_STATUSES.includes(String(item.status)) ||
            !Array.isArray(item.files) ||
            !item.files.every((file) => typeof file === "string") ||
            !isRecord(item.data))
            return null;
        // v3.9.1: Git observations moved to schema 2 (complete boundary
        // fingerprints); command/custom observations remain schema 1. A
        // mismatched Git observation is a hard break, reported by
        // legacyTransactionRounds as an "observation" envelope loss.
        const expectedVersion = item.kind === "git"
            ? GIT_OBSERVATION_SCHEMA_VERSION
            : 1;
        if (item.schemaVersion !== expectedVersion)
            return null;
        if (item.kind === "git" && item.status === "observed") {
            const data = item.data;
            if (!Array.isArray(data.dirty) ||
                !data.dirty.every((file) => typeof file === "string") ||
                !isRecord(data.fingerprints) ||
                !Object.values(data.fingerprints).every((fp) => typeof fp === "string") ||
                (data.head !== undefined && typeof data.head !== "string") ||
                data.coverage !== "tracked_and_non_ignored_untracked") {
                return null;
            }
        }
        observations.push(item);
    }
    return observations;
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
    const beforeEvidence = parseMachineObservations(value.beforeEvidence);
    if (!beforeEvidence)
        return null;
    const afterEvidence = value.afterEvidence === undefined
        ? undefined
        : parseMachineObservations(value.afterEvidence);
    if (value.afterEvidence !== undefined && !afterEvidence)
        return null;
    if (value.result !== undefined && !isProcessResult(value.result))
        return null;
    if (value.contractBinding !== undefined && !isContractBinding(value.contractBinding))
        return null;
    if (value.normalizationDiagnostics !== undefined) {
        if (!Array.isArray(value.normalizationDiagnostics) ||
            value.normalizationDiagnostics.length > 200)
            return null;
        for (const item of value.normalizationDiagnostics) {
            if (!isRecord(item) ||
                typeof item.path !== "string" ||
                typeof item.code !== "string" ||
                !["dropped", "truncated", "normalized", "rejected"]
                    .includes(String(item.handling)) ||
                typeof item.detail !== "string") {
                return null;
            }
        }
    }
    if (value.submittedFields !== undefined) {
        if (!Array.isArray(value.submittedFields) ||
            value.submittedFields.length > 100 ||
            !value.submittedFields.every((item) => typeof item === "string") ||
            new Set(value.submittedFields).size !== value.submittedFields.length) {
            return null;
        }
    }
    // A normalized/committed round always carries its attempted manifest. Its
    // absence is not a supported legacy shape.
    if ((value.phase === "evaluated" || value.phase === "committed") &&
        value.submittedFields === undefined) {
        return null;
    }
    if (value.promptArtifact !== undefined) {
        if (!isRecord(value.promptArtifact))
            return null;
        const artifact = value.promptArtifact;
        // v3.9.1: schema 3 adds prompt-request render effects. An unsupported
        // artifact version is a HARD break: a round whose envelope does not parse
        // is not committed history, and `legacyTransactionRounds` reports the
        // loss explicitly instead of the loop looking complete while rounds are
        // missing.
        // v3.9.4: schema 4 requires the ID-level coverage proof. A missing or
        // malformed coverage object is a hard break, never an empty projection.
        const coverage = artifact.coverage;
        const coverageValid = isRecord(coverage) &&
            Array.isArray(coverage.active) &&
            coverage.active.every((entry) => isRecord(entry) &&
                typeof entry.id === "string" &&
                typeof entry.kind === "string") &&
            Array.isArray(coverage.rendered) &&
            coverage.rendered.every((id) => typeof id === "string") &&
            Array.isArray(coverage.omitted) &&
            coverage.omitted.every((entry) => isRecord(entry) &&
                typeof entry.id === "string" &&
                typeof entry.reason === "string") &&
            typeof coverage.complete === "boolean";
        if (artifact.schemaVersion !== PROMPT_ARTIFACT_SCHEMA_VERSION ||
            typeof artifact.roundId !== "string" ||
            typeof artifact.renderedPrompt !== "string" ||
            typeof artifact.promptHash !== "string" ||
            typeof artifact.stateHash !== "string" ||
            !["l0", "l1", "l2"].includes(String(artifact.level)) ||
            !coverageValid)
            return null;
    }
    const snapshot = {
        ...value,
        beforeEvidence,
        afterEvidence,
    };
    if (snapshot.roundId !== makeRoundId(snapshot.loopId, snapshot.round)) {
        return null;
    }
    return snapshot;
}
export class RoundTransactionCoordinator {
    engine;
    store;
    commitStore;
    constructor(engine, store, commitStore) {
        this.engine = engine;
        this.store = store ?? engine.getStore();
        this.commitStore = commitStore ?? new VaultRoundCommitStore(this.store);
    }
    process(input) {
        const { snapshot } = input;
        const finish = (outcome) => {
            policyMetrics.recordRound(snapshot.loopId, outcome.result, outcome.replayed);
            return outcome;
        };
        const expectedRoundId = makeRoundId(snapshot.loopId, snapshot.round);
        if (snapshot.roundId !== expectedRoundId) {
            throw new Error(`Round snapshot identity mismatch: ${snapshot.roundId} !== ${expectedRoundId}`);
        }
        // v3.2.1: idempotency replay skips committed backtrack decisions — a
        // backtrack rolls the round back for a redo; the redo submission carries
        // the same roundId and must be evaluated, not replayed as the old
        // roll-back directive (which would discard the agent's fix forever).
        const committed = this.readCommitted(snapshot, { skipBacktrack: true });
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
        // v3.8: the round delta is DERIVED, never persisted — the transaction
        // stores the two factual observation collections and this pure function
        // is the single derivation every reader shares.
        const roundDeltas = deriveRoundObservationDelta(snapshot.beforeEvidence, input.actualEvidence);
        const coordinator = new RoundCoordinator(this.store);
        const result = coordinator.processRound({
            loopId: snapshot.loopId,
            task: input.task,
            currentRound: snapshot.round,
            maxRounds: input.maxRounds,
            selfEval: input.selfEval,
            lastSelfEval: input.lastSelfEval,
            consecutiveRejections: input.consecutiveRejections,
            lastRejectionCheck: input.lastRejectionCheck,
            evidenceDeltas: roundDeltas,
            beforeEvidence: snapshot.beforeEvidence,
            successTrajectory: input.successTrajectory,
            backtrackSkippedFiles: input.backtrackSkippedFiles,
            backtrackSkippedFingerprints: input.backtrackSkippedFingerprints,
            backtrackTargetGitHead: input.backtrackTargetGitHead,
            backtrackTargetDirty: input.backtrackTargetDirty,
            entrypointTrust: input.entrypointTrust,
            // v3.9.4: the SAME manifest the receipt reads.
            submittedFields: input.submittedFields ?? snapshot.submittedFields,
        });
        const evaluated = {
            ...snapshot,
            attempt,
            phase: "evaluated",
            afterEvidence: input.actualEvidence,
            evaluation: input.selfEval,
            result,
            ...(input.normalizationDiagnostics !== undefined
                ? { normalizationDiagnostics: input.normalizationDiagnostics }
                : {}),
            // Every evaluated/committed snapshot carries the attempted manifest.
            // The MCP boundary always supplies it; direct library callers that do
            // not are recorded with an empty manifest rather than an unsupported
            // missing key.
            submittedFields: input.submittedFields ?? [],
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
            // v3.8: the contract binding is resolved HERE, at commit time, because
            // the command configuration in force at declaration is not recoverable
            // from the Vault afterwards. Machine-recomputed — never agent-supplied.
            ...(() => {
                const binding = resolveContractBinding(input.selfEval.round_contract, snapshot.loopId);
                return binding ? { contractBinding: binding } : {};
            })(),
            updatedAt: Date.now(),
        };
        const metadata = {
            schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
            round_id: snapshot.roundId,
            snapshot: committedSnapshot,
            result,
        };
        this.engine.autoFeedback(input.selfEval, snapshot.loopId, snapshot.round, input.task, metadata);
        // v3.7.1: a backtrack decision commits as the CURRENT round, which the
        // incremental hydration cache never re-reads before the restore compile
        // (it targets the same round). Drop the cache so the rollback — and its
        // Recovery Brief facts — is visible to the very next compile.
        if (result.action === "backtrack") {
            this.engine.invalidateHydrationCache(snapshot.loopId);
        }
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
    /** Recover an already committed decision without evaluating or writing. */
    recover(snapshot) {
        const outcome = this.readCommitted(snapshot);
        if (outcome) {
            policyMetrics.recordRound(snapshot.loopId, outcome.result, true);
        }
        return outcome;
    }
    readCommitted(expected, opts) {
        const taskId = `loop:${expected.loopId}:r${expected.round}:feedback`;
        const entries = this.commitStore.find(expected.loopId, expected.round);
        for (const entry of entries) {
            if (entry.task_id !== taskId)
                continue;
            const outcome = this.outcomeFromEntry(entry, expected.roundId, opts?.skipBacktrack === true);
            if (outcome)
                return outcome;
        }
        return null;
    }
    outcomeFromEntry(entry, expectedRoundId, skipBacktrack = false) {
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
        // v3.2.1: a committed backtrack is a roll-back directive, not a terminal
        // decision. The restored round reuses the same roundId, so replaying it
        // would silently discard the agent's redo submission and re-emit the
        // backtrack prompt forever (the redo's work is never evaluated, and the
        // R4/R9 terminate guards never run because evaluation is short-circuited).
        // Crash recovery still replays backtracks (recover() → reconcileCommittedRound
        // resets the round counter from the committed decision); only the advance
        // path skips them so the redo is evaluated normally.
        if (skipBacktrack && result.action === "backtrack")
            return null;
        return { snapshot, result, replayed: true };
    }
}
//# sourceMappingURL=round-transaction.js.map