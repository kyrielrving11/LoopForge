/** Persistence adapters for session state and committed round lookup. */
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
    backend;
    constructor(backend) {
        this.backend = backend;
    }
    load(loopId) {
        return this.backend.queryEntries({ prefix: `loop:${loopId}:session` }).find((entry) => entry.task_type === "session_state" &&
            entry.loop_id === loopId &&
            entry.task_id === `loop:${loopId}:session`);
    }
    list() {
        return this.backend.queryEntries().filter((entry) => entry.task_type === "session_state");
    }
    save(entry, options = {}) {
        const loopId = entry.loop_id;
        if (typeof loopId !== "string" || !loopId) {
            throw new Error("Session state entry requires loop_id");
        }
        const write = () => {
            const vault = this.backend.readVault();
            const entries = Array.isArray(vault.entries)
                ? vault.entries
                : [];
            const existing = entries.find((item) => item.task_type === "session_state" && item.loop_id === loopId);
            if (existing && options.expectedLeaseOwner) {
                const lineage = this.lineage(existing);
                const owner = typeof lineage.lease_owner === "string"
                    ? lineage.lease_owner
                    : "";
                if (owner && owner !== options.expectedLeaseOwner) {
                    throw new SessionLeaseConflictError(loopId);
                }
            }
            vault.entries = [
                ...entries.filter((item) => !(item.task_type === "session_state" && item.loop_id === loopId)),
                entry,
            ];
            this.backend.writeVault(vault);
        };
        if (typeof this.backend.withLock === "function") {
            this.backend.withLock(write);
        }
        else {
            write();
        }
    }
    acquireLease(loopId, ownerId, leaseMs, now = Date.now()) {
        let claimed;
        const write = () => {
            const vault = this.backend.readVault();
            const entries = Array.isArray(vault.entries)
                ? vault.entries
                : [];
            const index = entries.findIndex((entry) => entry.task_type === "session_state" && entry.loop_id === loopId);
            if (index < 0)
                return;
            const entry = entries[index];
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
            entries[index] = updated;
            vault.entries = entries;
            this.backend.writeVault(vault);
            claimed = updated;
        };
        if (typeof this.backend.withLock === "function")
            this.backend.withLock(write);
        else
            write();
        return claimed;
    }
    renewLease(loopId, ownerId, leaseMs, now = Date.now()) {
        let renewed = false;
        const write = () => {
            const vault = this.backend.readVault();
            const entries = Array.isArray(vault.entries)
                ? vault.entries
                : [];
            const index = entries.findIndex((entry) => entry.task_type === "session_state" && entry.loop_id === loopId);
            if (index < 0)
                return;
            const entry = entries[index];
            const lineage = this.lineage(entry);
            if (lineage.lease_owner !== ownerId)
                return;
            entries[index] = {
                ...entry,
                loop_lineage: {
                    ...lineage,
                    lease_expires_at: now + Math.max(1, leaseMs),
                },
            };
            vault.entries = entries;
            this.backend.writeVault(vault);
            renewed = true;
        };
        if (typeof this.backend.withLock === "function")
            this.backend.withLock(write);
        else
            write();
        return renewed;
    }
    releaseLease(loopId, ownerId) {
        let released = false;
        const write = () => {
            const vault = this.backend.readVault();
            const entries = Array.isArray(vault.entries)
                ? vault.entries
                : [];
            const index = entries.findIndex((entry) => entry.task_type === "session_state" && entry.loop_id === loopId);
            if (index < 0)
                return;
            const entry = entries[index];
            const lineage = this.lineage(entry);
            if (lineage.lease_owner !== ownerId)
                return;
            entries[index] = {
                ...entry,
                loop_lineage: {
                    ...lineage,
                    lease_owner: "",
                    lease_expires_at: 0,
                },
            };
            vault.entries = entries;
            this.backend.writeVault(vault);
            released = true;
        };
        if (typeof this.backend.withLock === "function")
            this.backend.withLock(write);
        else
            write();
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