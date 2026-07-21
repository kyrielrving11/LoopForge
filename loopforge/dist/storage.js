/** Persistence adapters for session state and committed round lookup. */
import { LOOP_STORE_SCHEMA_VERSION } from "./loop-store.js";
function isLeaseOwnerAlive(ownerId) {
    const match = ownerId.match(/^(\d+):/);
    if (!match)
        return true;
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0)
        return true;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
export class SessionLeaseConflictError extends Error {
    loopId;
    constructor(loopId) {
        super(`Session lease is owned by another process: ${loopId}`);
        this.loopId = loopId;
        this.name = "SessionLeaseConflictError";
    }
}
export class VaultSessionStateStore {
    store;
    constructor(store) {
        this.store = store;
    }
    load(loopId) {
        const session = this.store.readSession(loopId);
        return session?.entry;
    }
    list() {
        const result = [];
        for (const loopId of this.store.listLoopIds()) {
            const session = this.store.readSession(loopId);
            if (session)
                result.push(session.entry);
        }
        return result;
    }
    save(entry, options = {}) {
        const loopId = entry.loop_id;
        if (typeof loopId !== "string" || !loopId) {
            throw new Error("Session state entry requires loop_id");
        }
        const write = () => {
            const existing = this.store.readSession(loopId);
            if (existing && options.expectedLeaseOwner) {
                const lineage = this.lineage(existing.entry);
                const owner = typeof lineage.lease_owner === "string"
                    ? lineage.lease_owner
                    : "";
                if (owner && owner !== options.expectedLeaseOwner) {
                    throw new SessionLeaseConflictError(loopId);
                }
            }
            const doc = {
                schemaVersion: LOOP_STORE_SCHEMA_VERSION,
                loopId,
                updatedAt: new Date().toISOString(),
                entry,
            };
            this.store.writeSession(loopId, doc);
        };
        this.store.withLock(write);
    }
    acquireLease(loopId, ownerId, leaseMs, now = Date.now()) {
        let claimed;
        const write = () => {
            const session = this.store.readSession(loopId);
            if (!session)
                return;
            const entry = session.entry;
            const lineage = this.lineage(entry);
            const owner = typeof lineage.lease_owner === "string"
                ? lineage.lease_owner
                : "";
            const expiresAt = typeof lineage.lease_expires_at === "number"
                ? lineage.lease_expires_at
                : 0;
            if (owner &&
                owner !== ownerId &&
                expiresAt > now &&
                isLeaseOwnerAlive(owner))
                return;
            const previousEpoch = typeof lineage.lease_epoch === "number"
                ? lineage.lease_epoch
                : 0;
            const updated = {
                ...entry,
                timestamp: new Date(now).toISOString(),
                loop_lineage: {
                    ...lineage,
                    lease_owner: ownerId,
                    lease_expires_at: now + Math.max(1, leaseMs),
                    lease_epoch: owner === ownerId ? previousEpoch : previousEpoch + 1,
                },
            };
            const doc = {
                schemaVersion: LOOP_STORE_SCHEMA_VERSION,
                loopId,
                updatedAt: new Date(now).toISOString(),
                entry: updated,
            };
            this.store.writeSession(loopId, doc);
            claimed = updated;
        };
        this.store.withLock(write);
        return claimed;
    }
    renewLease(loopId, ownerId, leaseMs, now = Date.now()) {
        let renewed = false;
        const write = () => {
            const session = this.store.readSession(loopId);
            if (!session)
                return;
            const entry = session.entry;
            const lineage = this.lineage(entry);
            if (lineage.lease_owner !== ownerId)
                return;
            const updated = {
                ...entry,
                loop_lineage: {
                    ...lineage,
                    lease_expires_at: now + Math.max(1, leaseMs),
                },
            };
            const doc = {
                schemaVersion: LOOP_STORE_SCHEMA_VERSION,
                loopId,
                updatedAt: new Date(now).toISOString(),
                entry: updated,
            };
            this.store.writeSession(loopId, doc);
            renewed = true;
        };
        this.store.withLock(write);
        return renewed;
    }
    releaseLease(loopId, ownerId) {
        let released = false;
        const write = () => {
            const session = this.store.readSession(loopId);
            if (!session)
                return;
            const entry = session.entry;
            const lineage = this.lineage(entry);
            if (lineage.lease_owner !== ownerId)
                return;
            const updated = {
                ...entry,
                loop_lineage: {
                    ...lineage,
                    lease_owner: "",
                    lease_expires_at: 0,
                },
            };
            const doc = {
                schemaVersion: LOOP_STORE_SCHEMA_VERSION,
                loopId,
                updatedAt: new Date().toISOString(),
                entry: updated,
            };
            this.store.writeSession(loopId, doc);
            released = true;
        };
        this.store.withLock(write);
        return released;
    }
    lineage(entry) {
        return entry.loop_lineage &&
            typeof entry.loop_lineage === "object" &&
            !Array.isArray(entry.loop_lineage)
            ? entry.loop_lineage
            : {};
    }
}
export class VaultRoundCommitStore {
    backend;
    constructor(backend) {
        this.backend = backend;
    }
    find(loopId, round) {
        return this.backend.queryEntries({
            prefix: `loop:${loopId}:r${round}:feedback`,
            feedbackOnly: true,
        });
    }
}
//# sourceMappingURL=storage.js.map