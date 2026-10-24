import { isRecord } from "./token-utils.js";
/** Validate that a stored transaction belongs to its containing Vault entry. */
export function transactionIdentityIssue(entry, expected) {
    if (!isRecord(entry) || !isRecord(entry.loop_lineage) ||
        !isRecord(entry.loop_lineage.round_transaction)) {
        return "round transaction envelope is missing";
    }
    const lineage = entry.loop_lineage;
    const envelope = lineage.round_transaction;
    if (!isRecord(envelope))
        return "round transaction envelope is malformed";
    const snapshot = envelope.snapshot;
    if (!isRecord(snapshot))
        return "round transaction snapshot is missing";
    if (typeof snapshot.loopId !== "string" ||
        !Number.isInteger(snapshot.round) ||
        typeof snapshot.roundId !== "string" ||
        typeof snapshot.transactionId !== "string" ||
        (snapshot.kind !== "evaluation" && snapshot.kind !== "rollback")) {
        return "round transaction snapshot identity is malformed";
    }
    const loopId = snapshot.loopId;
    const round = snapshot.round;
    const roundId = `loop:${loopId}:round:${round}`;
    if (round < 1 || snapshot.roundId !== roundId) {
        return "round transaction snapshot round identity is inconsistent";
    }
    if (envelope.schema_version !== snapshot.schemaVersion ||
        envelope.round_id !== snapshot.roundId) {
        return "round transaction envelope identity does not match its snapshot";
    }
    if (typeof entry.loop_id !== "string" || entry.loop_id !== loopId) {
        return "Vault entry loop_id does not match its transaction snapshot";
    }
    if (lineage.round !== round ||
        (lineage.round_id !== undefined && lineage.round_id !== roundId)) {
        return "Vault entry round lineage does not match its transaction snapshot";
    }
    const expectedTaskType = snapshot.kind === "evaluation"
        ? "feedback"
        : "rollback_directive";
    const expectedTaskId = snapshot.kind === "evaluation"
        ? `loop:${loopId}:r${round}:feedback`
        : `loop:${loopId}:r${round}:rollback:${snapshot.transactionId}`;
    if (entry.task_type !== expectedTaskType ||
        entry.task_id !== expectedTaskId) {
        return "Vault entry task identity does not match its transaction snapshot";
    }
    if (snapshot.kind === "rollback" &&
        (!isRecord(snapshot.recovery) ||
            snapshot.recovery.transaction_id !== snapshot.transactionId)) {
        return "rollback directive identity does not match its transaction snapshot";
    }
    if (expected) {
        if (loopId !== expected.loopId || round !== expected.round) {
            return "transaction snapshot does not match its target loop and round";
        }
        if (expected.schemaVersion !== undefined &&
            snapshot.schemaVersion !== expected.schemaVersion) {
            return "transaction snapshot schema does not match the active schema";
        }
        if (expected.transactionId !== undefined &&
            snapshot.transactionId !== expected.transactionId) {
            return "transaction snapshot does not match its target transaction";
        }
    }
    return null;
}
//# sourceMappingURL=transaction-identity.js.map