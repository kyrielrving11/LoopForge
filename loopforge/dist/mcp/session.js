/** LoopForge MCP — Session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * the advance() cycle: extract → feedback → check stop → compile next.
 *
 * Since v2.14 the round state machine lives in RoundLifecycle
 * (round-lifecycle.ts). SessionManager owns "who may touch a session":
 * the in-memory registry, per-session serialization queue, and cross-process
 * lease fencing. RoundLifecycle owns "what happens to a session": crash
 * recovery, transaction execution, disposition result building, and the
 * advance pipeline. All round processing still goes through the
 * SessionManager → RoundDriver → RoundCoordinator path.
 */
import { randomUUID } from "node:crypto";
import { LoopForgeEngine } from "../engine.js";
import { canonicalizeGateAction, deriveGate, preflightStructuredGate, } from "../cognitive-governance.js";
import { makeGateDecision, makeLoopObjective } from "../protocol.js";
import { loadCommittedHistory } from "../history.js";
import { buildAudit } from "../audit.js";
import { buildExplain } from "../explain.js";
import { CHECK_CONTRACT_ITEMS_UNVERIFIED } from "../verification-gate.js";
import { deriveCommittedSubmissionView } from "../submission-receipt.js";
import { getPolicy, validateLoopId } from "../policy.js";
import { isRecord, unique } from "../token-utils.js";
import { ReplayBackend } from "../replay.js";
import { FileLoopStore } from "../loop-store.js";
import { MAX_MID_CHECKPOINTS_PER_TRANSACTION, } from "../round-transaction.js";
import { findCheckpointRef } from "../recovery.js";
import { buildCheckpointRef, CheckpointError, FileWorkspaceCheckpointStore, } from "../workspace-checkpoint.js";
import { resolveStateDirectory } from "../policy.js";
import { resolve, sep } from "node:path";
import { RoundDriver } from "../round-driver.js";
import { logEvent } from "../observability.js";
import { CompileFailureError, LegacyHistoryError, LoopExistsError, StartFailureError, } from "../errors.js";
import { policyMetrics, derivePolicyMetrics, mergePolicyMetrics, } from "../policy-metrics.js";
import { SessionLeaseConflictError, VaultSessionStateStore, } from "../storage.js";
import { StorageCorruptionError } from "../loop-store.js";
import { LOST_HANDLE_ROUTING } from "../recovery-guidance.js";
import { RoundLifecycle, buildLoopRequest, normalizeStartCriteria, } from "./round-lifecycle.js";
import { activeContractOf, validateSubmission, } from "./submission-boundary.js";
import { makeSubmissionHandle, parseSubmissionHandle, staleHandleWarning, validateSubmissionHandle, } from "./submission-handle.js";
// ── SessionManager ─────────────────────────────────────────────────────────
export class SessionManager {
    sessions = new Map();
    /** Serializes state transitions for each session. */
    sessionQueues = new Map();
    loopStore;
    sessionStore;
    ownerId = `${process.pid}:${randomUUID()}`;
    leaseMs;
    leaseRenewIntervalMs;
    leaseTimer = null;
    lifecycle;
    terminalSinks = new Set();
    checkpointStoreFor;
    constructor(store, sessionStore, checkpointStoreFor) {
        this.loopStore = store ?? new FileLoopStore(getPolicy().backend.root_dir);
        this.sessionStore = sessionStore ?? new VaultSessionStateStore(this.loopStore);
        const stores = new Map();
        const fileStore = this.loopStore instanceof FileLoopStore ? this.loopStore : undefined;
        this.checkpointStoreFor = checkpointStoreFor ?? (fileStore
            ? (loopId) => {
                let storeForLoop = stores.get(loopId);
                if (!storeForLoop) {
                    storeForLoop = new FileWorkspaceCheckpointStore(fileStore.loopDir(loopId), loopId);
                    stores.set(loopId, storeForLoop);
                }
                return storeForLoop;
            }
            : undefined);
        const mcpPolicy = getPolicy().mcp;
        this.leaseMs = Math.max(1, mcpPolicy.session_lease_ms);
        this.leaseRenewIntervalMs = Math.max(1, Math.min(mcpPolicy.session_lease_renew_interval_ms, this.leaseMs));
        this.lifecycle = new RoundLifecycle({
            store: this.loopStore,
            sessionStore: this.sessionStore,
            registry: this,
            terminalSinks: this.terminalSinks,
            ownerId: this.ownerId,
            leaseMs: this.leaseMs,
            ...(this.checkpointStoreFor
                ? { checkpointStoreFor: this.checkpointStoreFor }
                : {}),
        });
        if (this.sessionStore?.renewLease) {
            this.leaseTimer = setInterval(() => this.renewOwnedLeases(), this.leaseRenewIntervalMs);
            this.leaseTimer.unref?.();
        }
    }
    /** Stable process-local owner token used for cross-process session leases. */
    getOwnerId() {
        return this.ownerId;
    }
    addTerminalSink(sink) {
        this.terminalSinks.add(sink);
        return () => this.terminalSinks.delete(sink);
    }
    /** Release owned sessions and stop lease maintenance. */
    close() {
        if (this.leaseTimer)
            clearInterval(this.leaseTimer);
        this.leaseTimer = null;
        for (const session of this.sessions.values()) {
            this.sessionStore?.releaseLease?.(session.loopId, this.ownerId);
        }
    }
    // ── SessionRegistry (view for RoundLifecycle) ────────────────────────────
    values() {
        return this.sessions.values();
    }
    /** Register (or replace) a session in the in-memory registry. */
    upsert(session) {
        this.sessions.set(session.sessionId, session);
    }
    // ── Lease helpers ────────────────────────────────────────────────────────
    findSessionEntry(loopId) {
        return this.sessionStore?.load(loopId);
    }
    /** Whether the loop already has durable round history. A lineage-only round
     *  document from a failed start is NOT history and must remain retryable;
     *  only a committed feedback envelope counts. */
    hasCommittedRounds(loopId) {
        const history = loadCommittedHistory(this.loopStore, loopId);
        return history.rounds.length > 0 ||
            history.directives.length > 0 ||
            history.legacyRounds.length > 0;
    }
    claimSessionEntry(loopId) {
        if (this.sessionStore?.acquireLease) {
            return this.sessionStore.acquireLease(loopId, this.ownerId, this.leaseMs);
        }
        return this.findSessionEntry(loopId);
    }
    renewSessionLease(loopId) {
        if (!this.sessionStore?.renewLease)
            return true;
        try {
            return this.sessionStore.renewLease(loopId, this.ownerId, this.leaseMs);
        }
        catch {
            return false;
        }
    }
    renewOwnedLeases() {
        for (const session of this.sessions.values()) {
            if (session.status === "running")
                this.renewSessionLease(session.loopId);
        }
    }
    leaseConflictResult(loopId, entry) {
        const lineage = (entry?.loop_lineage ?? {});
        return {
            sessionId: "",
            round: typeof lineage.current_round === "number" ? lineage.current_round : 0,
            prompt: null,
            stopReason: `session_owned_elsewhere:${loopId}`,
            stopDetail: `Another process (PID ${entry?.loop_lineage ? entry.loop_lineage.lease_owner ?? "unknown" : "unknown"}) holds the lease for loop "${loopId}". Wait for the lease to expire or stop the other process.`,
        };
    }
    async withSessionQueue(sessionId, work) {
        const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        this.sessionQueues.set(sessionId, tail);
        await previous;
        try {
            return await work();
        }
        finally {
            release();
            if (this.sessionQueues.get(sessionId) === tail) {
                this.sessionQueues.delete(sessionId);
            }
        }
    }
    // ── Lifecycle entry points ───────────────────────────────────────────────
    async create(input) {
        const sessionId = randomUUID();
        const loopId = input.loopId ?? randomUUID();
        // v2.14: same-process duplicate guard. Cross-process duplicates are
        // fenced by the lease (SessionLeaseConflictError on save); within one
        // process the lease owner is identical, so a second create for the
        // same loopId would silently overwrite the first session's persisted
        // state and leave two in-memory sessions pointing at one loop.
        const existing = [...this.sessions.values()].find((s) => s.loopId === loopId);
        if (existing) {
            throw new LoopExistsError(loopId, "active");
        }
        // v3.2.1: pre-flight the cross-process lease BEFORE compiling. A compile
        // no longer writes round history, but it still writes the derived state
        // file and would waste evidence work against another process's loop.
        // The save below remains the atomic final gate.
        const persistedSession = this.sessionStore?.load(loopId);
        const persistedLineage = persistedSession?.loop_lineage;
        const persistedOwner = persistedLineage && typeof persistedLineage === "object" && !Array.isArray(persistedLineage)
            ? persistedLineage.lease_owner
            : "";
        if (typeof persistedOwner === "string" && persistedOwner && persistedOwner !== this.ownerId) {
            throw new SessionLeaseConflictError(loopId);
        }
        // A persisted session in ANY status, or any committed round document,
        // means this loopId already names durable history. Starting a new round 1
        // would overwrite it. The atomic `expectAbsent` save below is the final
        // gate; this preflight avoids compiling and collecting evidence first.
        if (persistedSession) {
            const persistedStatus = isRecord(persistedLineage)
                ? persistedLineage.status
                : undefined;
            throw new LoopExistsError(loopId, persistedStatus === "stopped" ? "stopped" : "session");
        }
        if (this.hasCommittedRounds(loopId)) {
            throw new LoopExistsError(loopId, "rounds");
        }
        // v3.9.4: normalize initial criteria before any runtime object is created.
        // A structural defect throws StartCriteriaError (mapped to
        // invalid_argument); empty/duplicate/over-cap entries produce warnings.
        const startCriteria = normalizeStartCriteria(input.criteria);
        const engine = new LoopForgeEngine(this.loopStore);
        const maxRounds = input.maxRounds ?? getPolicy().engine.max_rounds;
        const operatorAcceptance = {
            task: input.task,
            success_criteria: startCriteria.criteria.length > 0
                ? [...startCriteria.criteria]
                : ["Task goal achieved with verifiable evidence"],
            hard_constraints: unique(input.constraints ?? []),
        };
        // Populate the typed request for the first round. The operator surface is
        // the one acceptance object; the objective is derived from it.
        const request = buildLoopRequest({
            sessionId, loopId, task: input.task, engine, currentRound: 1,
            maxRounds, status: "running", createdAt: Date.now(),
            consecutiveRejections: 0,
            lastRejectionCheck: "",
        });
        request.plan_source = input.planSource ?? null;
        request.constraints_from_plan = input.constraints ?? [];
        request.loop_objective = makeLoopObjective({
            objective: operatorAcceptance.task,
            success_criteria: [...operatorAcceptance.success_criteria],
            hard_constraints: [...operatorAcceptance.hard_constraints],
            created_at_round: 1,
            loop_id: loopId,
        });
        let prepared;
        try {
            prepared = await new RoundDriver(engine, this.loopStore, this.checkpointStoreFor?.(loopId)).prepare(request, loopId, 1, { operatorAcceptance });
        }
        catch (error) {
            if (error instanceof CompileFailureError) {
                throw new StartFailureError(error.message);
            }
            throw error;
        }
        const initialPrompt = prepared.prompt;
        const initialLevel = prepared.level;
        const session = {
            sessionId, loopId, task: input.task, engine,
            currentRound: 1, maxRounds,
            status: "running", createdAt: Date.now(),
            // v1.13: Enforcement gate state
            consecutiveRejections: 0,
            lastRejectionCheck: "",
            operatorAcceptance,
            roundSnapshot: prepared.snapshot,
        };
        // v4.0.3: seed the round-1 trust baseline BEFORE the first prompt is
        // delivered, so the first round already has the absolute entrypoint arm.
        this.lifecycle.seedEntrypointTrust(session);
        this.sessions.set(sessionId, session);
        policyMetrics.recordStrategy(loopId, initialLevel);
        // Persist to vault for cross-process recovery. The save is the atomic
        // lease/existence gate — a TOCTOU window between the pre-flight checks
        // above and this write can still lose the race to another process.
        try {
            this.lifecycle.save(session, { expectAbsent: true });
        }
        catch (error) {
            // Roll back the in-memory registration: a registered-but-unsaved
            // session would make every later create for this loopId fail until
            // this process restarts.
            this.sessions.delete(sessionId);
            throw error;
        }
        logEvent("session_start", {
            sessionId,
            loopId,
            task: input.task.slice(0, 80),
            maxRounds,
        });
        const snapshot = session.roundSnapshot;
        const handle = makeSubmissionHandle(session);
        return {
            sessionId,
            loopId,
            round: 1,
            ...(handle ? { submissionHandle: handle } : {}),
            // v4.0.2: start is a prompt-bearing result like next/resume; the
            // boundary is projected from the same compiled artifact.
            ...(snapshot?.promptArtifact
                ? {
                    contextMode: snapshot.promptArtifact.contextMode,
                    contextReason: snapshot.promptArtifact.contextReason,
                }
                : {}),
            ...(snapshot?.beforeCheckpoint
                ? { checkpoints: [snapshot.beforeCheckpoint] }
                : {}),
            ...(snapshot?.beforeCheckpointError
                ? {
                    beforeCheckpointError: {
                        code: snapshot.beforeCheckpointError.code,
                        detail: snapshot.beforeCheckpointError.detail,
                    },
                }
                : {}),
            prompt: initialPrompt,
            level: initialLevel,
            agentSuccessClaim: false,
            agentOutcome: null,
            warnings: [...startCriteria.warnings, ...(prepared.warnings ?? [])],
            submission_guidance: this.lifecycle.guidanceFor(session),
        };
    }
    /** v3.9.1: current-fact submission guidance for the session's held round.
     *  Read-only projection; null when the session is unknown. */
    getSubmissionGuidance(sessionId) {
        const session = this.sessions.get(sessionId);
        return session ? this.lifecycle.guidanceFor(session) : null;
    }
    /** v4.0.0: the current held handle, derived on demand. A read-only
     *  projection; never persisted. */
    getSubmissionHandle(sessionId) {
        return makeSubmissionHandle(this.sessions.get(sessionId));
    }
    /** v3.9.1: the most recent committed round's receipt for a loop, rebuilt
     *  from committed history. Rejected/terminated attempts are not history;
     *  their receipt exists only on their own response. This intentionally takes
     *  the durable loopId: it never reads live-session state. */
    getLastSubmissionReceiptByLoopId(loopId) {
        if (!loopId)
            return null;
        const history = loadCommittedHistory(this.loopStore, loopId);
        const views = history.rounds;
        const rollbacks = history.directives;
        const latestRound = views[views.length - 1];
        const latestRollback = rollbacks[rollbacks.length - 1];
        if (latestRollback &&
            (!latestRound || latestRollback.round > latestRound.round)) {
            return deriveCommittedSubmissionView(latestRollback, views, rollbacks);
        }
        return latestRound
            ? deriveCommittedSubmissionView(latestRound, views, rollbacks)
            : null;
    }
    /** v4.0.3: the machine-backed success trajectory is a projection of
     *  committed branch rounds, not a session counter. Unbacked claims never
     *  enter it. */
    getMachineBackedSuccessTrajectory(loopId) {
        return loadCommittedHistory(this.loopStore, loopId).rounds
            .filter((view) => view.result?.shouldPushSuccessTrajectory === true &&
            view.result?.evidencePosture?.machineBackedSuccess === true)
            .map((view) => view.agentSuccessClaim);
    }
    get(sessionId) {
        return this.sessions.get(sessionId);
    }
    /** Resolve a live session by its durable loop identity. `create` rejects a
     *  second live session for the same loop, so the scan is unambiguous. A
     *  persisted-only loop has no live session: call `resume` to rebuild it. */
    getByLoopId(loopId) {
        if (!loopId)
            return undefined;
        for (const session of this.sessions.values()) {
            if (session.loopId === loopId)
                return session;
        }
        return undefined;
    }
    getLeaseStatus(loopId) {
        const entry = this.findSessionEntry(loopId);
        if (!entry)
            return null;
        const lineage = (entry.loop_lineage ?? {});
        const owner = typeof lineage.lease_owner === "string"
            ? lineage.lease_owner
            : "";
        const ownerPid = owner.match(/^(\d+):/)?.[1];
        return {
            ownedByThisProcess: owner === this.ownerId,
            ownerPid: ownerPid ? Number(ownerPid) : null,
            expiresAt: typeof lineage.lease_expires_at === "number"
                ? new Date(lineage.lease_expires_at).toISOString()
                : null,
            epoch: typeof lineage.lease_epoch === "number"
                ? lineage.lease_epoch
                : 0,
        };
    }
    delete(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return false;
        session.status = "stopped";
        this.lifecycle.save(session);
        void this.lifecycle.notifyTerminal(session, "cancelled");
        this.sessions.delete(sessionId);
        this.sessionQueues.delete(sessionId);
        logEvent("session_end", {
            sessionId,
            loopId: session.loopId,
            stopReason: "cancelled",
            roundsCompleted: session.currentRound,
        });
        return true;
    }
    /** v1.18: Pause a running session. The session state is persisted to
     *  vault so it survives process restarts. Returns the session status.
     *  Paused sessions cannot be advanced — they must be resumed first. */
    pause(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return { sessionId, round: 0, status: "not_found" };
        if (session.status !== "running") {
            return { sessionId, round: session.currentRound, status: session.status };
        }
        session.status = "paused";
        this.lifecycle.save(session);
        logEvent("session_paused", {
            sessionId,
            loopId: session.loopId,
            round: session.currentRound,
        });
        return { sessionId, round: session.currentRound, status: "paused" };
    }
    /** Persist session state to vault for cross-process recovery. Delegates to
     *  the round lifecycle, which owns the durable session document shape. */
    save(session) {
        this.lifecycle.save(session);
    }
    /** Resume a loop from vault state.
     *  Reconstructs the session and compiles the prompt for the next round
     *  (async — compilation collects evidence through RoundDriver.prepare).
     *  Returns null if no session_state entry exists for this loopId. */
    async resume(loopId) {
        const persistedEntry = this.findSessionEntry(loopId);
        if (!persistedEntry)
            return null;
        const persistedLineage = (persistedEntry.loop_lineage ?? {});
        const persistedStatus = persistedLineage.status ?? "running";
        // v3.9.7: stalled is a RESUMABLE recovery state. It is how a committed
        // directive with an unfinished restore survives a restart.
        const sessionEntry = persistedStatus === "running" || persistedStatus === "stalled"
            ? this.claimSessionEntry(loopId)
            : persistedEntry;
        if (!sessionEntry)
            return this.leaseConflictResult(loopId, persistedEntry);
        const session = this.lifecycle.reconstructSession(sessionEntry);
        if (!session) {
            // was not "running"/"stalled" — return stopped/paused status
            const lineage = (sessionEntry.loop_lineage ?? {});
            const currentRound = lineage.current_round ?? 1;
            const status = lineage.status ?? "stopped";
            return {
                sessionId: "",
                round: currentRound,
                prompt: null,
                stopReason: status,
                stopDetail: `Loop is not running (status: ${status}). It may have already completed or been stopped.`,
            };
        }
        // Resume is a recovery attempt: set running so the lease is renewed while
        // the (possibly long) restore executes. A failure saves stalled again.
        if (session.status === "stalled")
            session.status = "running";
        this.sessions.set(session.sessionId, session);
        return this.lifecycle.resume(session);
    }
    /** v1.18: Resume a paused session. Reconstructs from vault state and
     *  compiles the next prompt. Returns null if no paused session exists
     *  for this loopId. */
    async unpause(loopId) {
        const persistedEntry = this.findSessionEntry(loopId);
        if (!persistedEntry)
            return null;
        const lineage = (persistedEntry.loop_lineage ?? {});
        const status = lineage.status ?? "running";
        if (status !== "paused")
            return null;
        const sessionEntry = this.claimSessionEntry(loopId);
        if (!sessionEntry)
            return this.leaseConflictResult(loopId, persistedEntry);
        const session = this.lifecycle.reconstructSession(sessionEntry, true);
        if (!session)
            return null;
        // Set to running so advance() works
        session.status = "running";
        this.sessions.set(session.sessionId, session);
        return this.lifecycle.unpause(session);
    }
    /** Auto-resume all "running" sessions from vault on server startup.
     *  Scans vault for session_state entries, reconstructs each as an in-memory
     *  McpSession (without compiling — the next loopforge_next will do that).
     *  Returns the number of sessions resumed. */
    autoResumeAll() {
        if (!this.sessionStore)
            return 0;
        const entries = this.sessionStore.list();
        // Build set of already-active loopIds
        const activeLoopIds = new Set();
        for (const s of this.sessions.values()) {
            activeLoopIds.add(s.loopId);
        }
        let count = 0;
        for (const entry of entries) {
            if (entry.task_type !== "session_state")
                continue;
            const lid = entry.loop_id;
            if (!lid || activeLoopIds.has(lid))
                continue;
            const lineage = (entry.loop_lineage ?? {});
            const status = lineage.status ?? "running";
            if (status !== "running" && status !== "paused" && status !== "stalled")
                continue;
            const claimedEntry = this.claimSessionEntry(lid);
            if (!claimedEntry)
                continue;
            // v2.14: a bulk startup scan must not die on one corrupt loop —
            // recoverable gaps are recorded and skipped; corrupted storage
            // (invalid JSON/format/sequence) still surfaces to the caller.
            let session = null;
            try {
                session = this.lifecycle.reconstructSession(claimedEntry, true);
            }
            catch (error) {
                if (error instanceof LegacyHistoryError) {
                    // A bulk startup scan must not rewrite history it cannot decode.
                    logEvent("session_skip_legacy", { loopId: lid, error: error.message });
                    continue;
                }
                if (error instanceof StorageCorruptionError && error.recoverable) {
                    logEvent("session_skip_gap", { loopId: lid, error: error.message });
                    continue;
                }
                throw error;
            }
            if (session) {
                this.sessions.set(session.sessionId, session);
                activeLoopIds.add(lid);
                count++;
            }
        }
        return count;
    }
    list() {
        const seen = new Set();
        const result = [];
        // In-memory sessions first (take priority)
        for (const s of this.sessions.values()) {
            seen.add(s.loopId);
            result.push({
                sessionId: s.sessionId,
                loopId: s.loopId,
                round: s.currentRound,
                status: s.status,
            });
        }
        // Merge persisted sessions not already in memory
        if (this.sessionStore) {
            const entries = this.sessionStore.list();
            for (const e of entries) {
                if (e.task_type !== "session_state")
                    continue;
                const lid = e.loop_id ?? "";
                if (!lid || seen.has(lid))
                    continue;
                seen.add(lid);
                const lineage = (e.loop_lineage ?? {});
                result.push({
                    sessionId: "",
                    loopId: lid,
                    round: lineage.current_round ?? 1,
                    status: (lineage.status || "running"),
                });
            }
        }
        return result;
    }
    // ── v2.12: User/Agent gates ────────────────────────────────────────────
    /** Persist a gate_opened record for a structured preflight. Only
     *  user_required actions are recorded — agent_allowed needs no human
     *  authorization and opens no record. */
    recordOpenedGate(loopId, round, verdict, canonicalAction) {
        this.loopStore.appendEntry({
            id: randomUUID(),
            task_id: `loop:${loopId}:gate:${verdict.gateId}`,
            task_type: "gate_opened",
            loop_id: loopId,
            timestamp: new Date().toISOString(),
            gate_id: verdict.gateId,
            gate_action: canonicalAction,
            gate_kind: "user",
            gate_structured: true,
            loop_lineage: {
                round,
                gate_id: verdict.gateId,
                action_hash: verdict.actionHash,
            },
        });
    }
    gateInvalidResult(session) {
        const handle = makeSubmissionHandle(session);
        return {
            error: "gate_invalid",
            errorMessage: `Session is ${session.status}; a gate check requires a running held evaluation.`,
            sessionId: session.sessionId,
            ...(handle ? { submissionHandle: handle } : {}),
            details: { reason_code: "session_not_running" },
        };
    }
    gateLeaseConflictResult(session) {
        const conflict = this.leaseConflictResult(session.loopId, this.findSessionEntry(session.loopId));
        return {
            error: "lease_conflict",
            errorMessage: conflict.stopDetail ?? "Another process owns this loop.",
            sessionId: session.sessionId,
            details: { reason_code: "lease_conflict" },
        };
    }
    /** v3.7.1: structured gate preflight. The agent submits a
     *  GateActionDescriptor; the runtime classifies it (conservative:
     *  anything not provably safe is user_required with reason codes). A
     *  user_required verdict persists a gate_opened record bound to
     *  loop + round + actionHash; agent_allowed records nothing and returns
     *  the evidence suggestion instead. No action is executed and no round
     *  advances from this call. */
    async checkGate(handle, action) {
        const parsed = parseSubmissionHandle(handle);
        if (!parsed) {
            const detail = "submissionHandle must be an object with exactly sessionId, roundId, " +
                "and transactionId as non-empty strings.";
            return {
                error: "submission_handle_required",
                errorMessage: `${detail} Copy it from the latest LoopForge response. ${LOST_HANDLE_ROUTING}`,
                details: { reason_code: "shape", detail },
            };
        }
        const session = this.sessions.get(parsed.sessionId);
        if (!session) {
            return {
                error: "session_not_found",
                errorMessage: `session not found: ${parsed.sessionId}`,
                sessionId: parsed.sessionId,
            };
        }
        if (session.status !== "running") {
            return this.gateInvalidResult(session);
        }
        const check = validateSubmissionHandle(parsed, session);
        if (!check.ok)
            return this.checkpointMismatchResult(check, session);
        return this.withSessionQueue(session.sessionId, async () => {
            const current = this.sessions.get(session.sessionId);
            if (!current)
                return { ...this.sessionNotFoundResult(session.sessionId) };
            if (current.status !== "running") {
                return this.gateInvalidResult(current);
            }
            // The authoritative re-check is inside the queue. A gate record must
            // never be opened for a handle that lost the held attempt while this
            // call was waiting behind another session mutation.
            const inside = validateSubmissionHandle(parsed, current);
            if (!inside.ok)
                return this.checkpointMismatchResult(inside, current);
            if (!this.renewSessionLease(current.loopId)) {
                return this.gateLeaseConflictResult(current);
            }
            const verdict = preflightStructuredGate(action);
            if (verdict.kind === "user") {
                this.recordOpenedGate(current.loopId, current.currentRound, verdict, canonicalizeGateAction(action));
            }
            return {
                submissionHandle: inside.handle,
                gateId: verdict.gateId,
                risk: verdict.risk,
                decision: verdict.decision,
                reasonCodes: verdict.reasonCodes,
                ...(verdict.kind === "user"
                    ? {
                        blockedScope: verdict.blockedScope,
                        allowedBeforeApproval: verdict.allowedBeforeApproval,
                        requiredEvidence: [],
                        approvalQuestion: verdict.approvalQuestion,
                    }
                    : {
                        blockedScope: [],
                        allowedBeforeApproval: [],
                        requiredEvidence: verdict.requiredEvidence,
                    }),
            };
        });
    }
    /** Record a user decision for a recorded gate. The gateId embeds the
     *  canonicalized action hash — if the action changed, the match fails and
     *  the old approval expires automatically. */
    resolveGate(sessionId, gateId, approved, note) {
        const session = this.sessions.get(sessionId);
        let loopId = session?.loopId;
        let currentRound = session?.currentRound ?? 0;
        let temporaryLease = false;
        // A gate is durable independently of the process that opened it. On a
        // cold process, locate the owning session by its persisted session_id and
        // claim a short lease for the decision write; no in-memory reconstruction
        // is needed for this read/append operation.
        let persistedEntry;
        if (!session) {
            persistedEntry = this.sessionStore?.list().find((entry) => {
                if (entry.task_type !== "session_state")
                    return false;
                const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : {};
                return lineage.session_id === sessionId;
            });
            loopId = persistedEntry?.loop_id;
            if (!loopId) {
                return {
                    error: "session_not_found",
                    errorMessage: `session not found: ${sessionId}`,
                    sessionId,
                };
            }
            const claimed = this.claimSessionEntry(loopId);
            if (!claimed) {
                return { ...this.leaseConflictResult(loopId, persistedEntry) };
            }
            temporaryLease = true;
            const lineage = isRecord(claimed.loop_lineage) ? claimed.loop_lineage : {};
            currentRound = typeof lineage.current_round === "number"
                ? lineage.current_round
                : 0;
        }
        if (!loopId) {
            return {
                error: "session_not_found",
                errorMessage: `session not found: ${sessionId}`,
                sessionId,
            };
        }
        try {
            const gatePrefix = `loop:${loopId}:gate:`;
            const opened = loadCommittedHistory(this.loopStore, loopId).entries
                .filter((entry) => String(entry.task_id ?? "").startsWith(gatePrefix))
                .find((entry) => entry.task_type === "gate_opened" && entry.gate_id === gateId);
            if (!opened) {
                return {
                    error: "state_unavailable",
                    errorMessage: `no gate_opened record for gate ${gateId} — the gate may have ` +
                        "expired or was never recorded",
                };
            }
            const actionText = typeof opened.gate_action === "string" ? opened.gate_action : "";
            const openedLineage = isRecord(opened.loop_lineage) ? opened.loop_lineage : {};
            const gateRound = typeof openedLineage.round === "number"
                ? openedLineage.round
                : currentRound;
            // v3.7.1: structured records re-derive their id through the structured
            // classifier over the stored canonical action; flat records (blocked-
            // round auto-records) keep the flat classifier. Either way the id
            // embeds the action — a changed action no longer matches and the old
            // approval expires.
            let matchedId;
            let userKind;
            let userScope = [];
            let actionHash = typeof openedLineage.action_hash === "string"
                ? openedLineage.action_hash
                : undefined;
            if (opened.gate_structured === true) {
                let descriptor;
                try {
                    descriptor = JSON.parse(actionText);
                }
                catch {
                    return {
                        error: "state_unavailable",
                        errorMessage: `gate ${gateId} has a corrupted structured action — ` +
                            "re-run loopforge_gate_check",
                    };
                }
                const verdict = preflightStructuredGate(descriptor);
                matchedId = verdict.gateId;
                userKind = verdict.kind === "user";
                userScope = verdict.blockedScope ?? [];
                actionHash = actionHash ?? verdict.actionHash;
            }
            else {
                const derived = deriveGate(actionText);
                matchedId = derived.id;
                userKind = derived.gate.kind === "user";
                userScope = derived.gate.blockedScope ?? [];
            }
            if (matchedId !== gateId) {
                return {
                    error: "invalid_argument",
                    errorMessage: "gateId does not match the recorded action — the action changed, " +
                        "old approvals expire",
                };
            }
            if (!userKind) {
                return {
                    error: "invalid_argument",
                    errorMessage: "agent gates are resolved by submitting the required evidence, " +
                        "not by user approval",
                };
            }
            const decision = makeGateDecision({
                gateId,
                kind: "user",
                approved: approved === true,
                scope: userScope,
                note: typeof note === "string" ? note : "",
                decidedAt: new Date().toISOString(),
                actionHash: actionHash ?? "",
            });
            const entry = {
                id: randomUUID(),
                task_id: `loop:${loopId}:gate:${gateId}:decision`,
                task_type: "gate_decision",
                loop_id: loopId,
                timestamp: new Date().toISOString(),
                gate_id: gateId,
                approved: decision.approved,
                decision_note: decision.note,
                gate_decision: decision,
                loop_lineage: {
                    round: gateRound,
                    gate_id: gateId,
                    action_hash: actionHash,
                },
            };
            this.loopStore.appendEntry(entry);
            return { sessionId, loopId, gateId, approved: decision.approved };
        }
        finally {
            if (temporaryLease)
                this.sessionStore?.releaseLease?.(loopId, this.ownerId);
        }
    }
    // ── v2.12: Typed projection + audit ────────────────────────────────────
    /** The compile context for this round.
     *
     *  v3.8.1: delegates to the SHARED implementation in round-lifecycle.ts —
     *  the runtime's submission boundary reads the same context (the sub-goal
     *  reference space is exactly the compiled set the prompt carried), and two
     *  copies would let the projection and the boundary disagree about it. */
    /** v3.8: Read-only per-round "why" view over committed facts. Never
     *  rebuilds history and never writes. */
    getExplain(loopId, round) {
        validateLoopId(loopId);
        const entries = loadCommittedHistory(this.loopStore, loopId).entries;
        return buildExplain(loopId, entries, round);
    }
    /** Read-only end-of-loop audit (verification view). Never writes. */
    getAudit(loopId) {
        validateLoopId(loopId);
        // Audit judges COMMITTED decisions. The shared history loader returns the
        // flat entry view and the decoded branch; there is no second query pair.
        const history = loadCommittedHistory(this.loopStore, loopId);
        // No committed decision and no legacy envelope → nothing to audit.
        // Returning null lets the tools layer report "no audit data" instead of
        // the external auditor solemnly passing a loop that never ran (or a
        // mistyped loopId). Legacy-only loops still get a report so the gap is
        // explicit, never silently empty.
        if (history.rounds.length === 0 && history.directives.length === 0 &&
            history.legacyRounds.length === 0) {
            return null;
        }
        const audit = buildAudit(loopId, history.entries, this.loopStore);
        return { ...audit };
    }
    /** v3.5: The ACTIVE Round Contract governing the session's next round —
     *  derived from the committed :feedback evals (the SAME adapter + walker
     *  the verification gate uses; display-only, zero persistence). Null when
     *  nothing is active (whole-task round). */
    getActiveContract(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        // One derivation, shared with the submission boundary.
        return activeContractOf(this.loopStore, session);
    }
    /** v2.12: Policy metrics that survive restarts — vault-derived round
     *  statistics (A4 port) folded with this process's live observations.
     *  Non-durable fields (evidence, vault errors) come from live only. */
    getPolicyMetrics(loopId) {
        // Derived metrics judge committed decisions through the same history
        // loader as every other read path. Live-only counters are folded in
        // afterwards; they never become the source of round facts.
        const entries = loadCommittedHistory(this.loopStore, loopId).entries;
        const derived = derivePolicyMetrics(loopId, entries);
        const live = policyMetrics.snapshot(loopId);
        if (derived.committedRounds === 0)
            return live;
        return mergePolicyMetrics(derived, live);
    }
    /** Get machine facts about a loop (in-memory or vault).
     *
     *  v3.8.1: this view used to report `goal_alignment`, `drift_detected`,
     *  `strategy_stability` and `task_continuity`. Every one was a
     *  text-similarity verdict rather than a fact, and two were degenerate in
     *  THIS method specifically: `task_continuity` was pinned to 1.0 because the
     *  request was built with `round: 1`, so `getPreviousRound(loopId, 0)`
     *  returned null and the code took its hardcoded `?? 1` branch; and
     *  `strategy_stability` was a literal `true`. What remains is counted
     *  directly from committed round flags. */
    getHealth(loopId) {
        const history = loadCommittedHistory(this.loopStore, loopId);
        // No stored session or round at all → unknown loop. A started-but-
        // uncommitted loop has a session entry, so it still gets a zeroed view.
        if (history.entries.length === 0)
            return null;
        const views = history.rounds;
        const roundsWithUnverifiedItems = views.filter((view) => view.verificationFlags.some((flag) => flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED)).length;
        // v4.0.3: the ONE persisted posture is the source of this distribution.
        const roundsByEvidenceStatus = {
            verified: 0,
            insufficient: 0,
            contradicted: 0,
            unknown: 0,
            not_applicable: 0,
        };
        for (const view of views) {
            if (view.evidencePosture) {
                roundsByEvidenceStatus[view.evidencePosture.status]++;
            }
        }
        return {
            loopId,
            committed_rounds: views.length,
            legacy_rounds: history.legacyRounds.length,
            rounds_with_unverified_items: roundsWithUnverifiedItems,
            rounds_by_evidence_status: roundsByEvidenceStatus,
            // The policy value the enforcement gate escalates on. The streak itself
            // is derived in the gate — re-deriving it here would be a second
            // implementation of the same rule, which is what this release removes.
            unverified_streak_limit: getPolicy().engine.unverified_claim_streak_limit,
            policy_metrics: this.getPolicyMetrics(loopId),
        };
    }
    /** v4.0.0: the stable result for a missing/malformed handle. */
    handleRequiredResult() {
        const detail = "submissionHandle must be an object with exactly sessionId, roundId, " +
            "and transactionId as non-empty strings.";
        return {
            sessionId: "",
            round: 0,
            prompt: null,
            stopReason: "submission_handle_required",
            stopDetail: `${detail} Copy it from the latest LoopForge response. ` +
                LOST_HANDLE_ROUTING,
            submissionError: {
                code: "submission_handle_required",
                details: { reason_code: "shape", detail },
            },
        };
    }
    sessionNotFoundResult(sessionId) {
        return {
            sessionId,
            round: 0,
            prompt: null,
            stopReason: "session_not_found",
            stopDetail: "No session exists with this ID. It may have expired, been deleted, " +
                "or never existed. Call loopforge_status with view=\"all\" to find the " +
                "loopId; if the held prompt is still in context, call loopforge_status " +
                "with that loopId to fetch the current handle; otherwise call " +
                "loopforge_resume with it.",
            submissionError: {
                code: "session_not_found",
                details: { sessionId },
            },
        };
    }
    sessionStateResult(session) {
        const handle = makeSubmissionHandle(session);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            ...(handle ? { submissionHandle: handle } : {}),
            prompt: null,
            stopReason: session.status,
            stopDetail: `Session is ${session.status}. Use loopforge_resume to restart a ` +
                "paused session, or loopforge_start for a new task.",
        };
    }
    /** v4.0.0: one stored-prompt re-delivery for next/recover. A held prompt is
     *  returned with the current handle and a warning; without one, the stable
     *  mismatch error carries the current handle when it exists. */
    handleMismatchResult(check, session) {
        if (check.reason !== "no_held_prompt") {
            const held = this.lifecycle.heldPromptResult(session, staleHandleWarning());
            if (held)
                return held;
        }
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            ...(check.current ? { submissionHandle: check.current } : {}),
            prompt: null,
            stopReason: "submission_handle_mismatch",
            stopDetail: check.detail,
            submissionError: {
                code: "submission_handle_mismatch",
                details: {
                    reason_code: check.reason,
                    ...(check.mismatched.length > 0 ? { mismatched: [...check.mismatched] } : {}),
                },
            },
        };
    }
    /** v4.0.0: the checkpoint variant: never re-deliver a prompt, never create a
     *  checkpoint. The current handle rides the error for re-anchoring. */
    checkpointMismatchResult(check, session) {
        return {
            error: "submission_handle_mismatch",
            errorMessage: check.detail,
            sessionId: session.sessionId,
            ...(check.current ? { submissionHandle: check.current } : {}),
            details: {
                reason_code: check.reason,
                ...(check.mismatched.length > 0 ? { mismatched: [...check.mismatched] } : {}),
            },
        };
    }
    /** v3.9.7: a pending rollback directive whose restore is not yet verified.
     *  Read-only; used before the queue/lease so a stale handle cannot mask the
     *  "call resume" recovery UX. */
    restorePendingResult(session) {
        const pending = loadCommittedHistory(this.loopStore, session.loopId)
            .pendingDirective;
        if (!pending?.recovery)
            return null;
        if (session.roundSnapshot?.restore?.directiveTransactionId ===
            pending.recovery.transaction_id &&
            session.roundSnapshot?.round === pending.recovery.target.redo_round) {
            return null;
        }
        const handle = makeSubmissionHandle(session);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            ...(handle ? { submissionHandle: handle } : {}),
            prompt: null,
            stopReason: "stalled",
            submissionError: {
                code: "restore_pending",
                details: {
                    loopId: session.loopId,
                    directive_transaction_id: pending.recovery.transaction_id,
                    redo_round: pending.recovery.target.redo_round,
                    detail: "A pending restore must be completed by loopforge_resume before work can be submitted.",
                },
            },
        };
    }
    /** Core cycle: extract self-eval → record feedback → check stop → compile next.
     *
     *  v4.0.0: the caller supplies the ONE `submissionHandle`; identity is
     *  checked before the payload boundary and before the queue/lease heartbeat.
     *  `submission` is the RAW evaluation payload. The whole payload boundary
     *  still runs here, so every public caller gets the same strictness. */
    async advance(handle, output, submission) {
        const parsed = parseSubmissionHandle(handle);
        if (!parsed)
            return this.handleRequiredResult();
        const session = this.sessions.get(parsed.sessionId);
        if (!session)
            return this.sessionNotFoundResult(parsed.sessionId);
        if (session.status !== "running" && session.status !== "stalled") {
            return this.sessionStateResult(session);
        }
        const pending = this.restorePendingResult(session);
        if (pending)
            return pending;
        const check = validateSubmissionHandle(parsed, session);
        if (!check.ok)
            return this.handleMismatchResult(check, session);
        // Identity is established for the attempt named by the handle. Only now
        // does the payload boundary judge the submission against that attempt's
        // reference space.
        const boundary = validateSubmission(this.loopStore, session, submission);
        if (!boundary.ok) {
            const current = makeSubmissionHandle(session);
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                ...(current ? { submissionHandle: current } : {}),
                prompt: null,
                stopReason: boundary.submissionError.code,
                stopDetail: boundary.stopDetail,
                submissionError: boundary.submissionError,
            };
        }
        return this.withSessionQueue(session.sessionId, async () => {
            const current = this.sessions.get(session.sessionId);
            if (!current)
                return this.sessionNotFoundResult(session.sessionId);
            if (current.status !== "running" && current.status !== "stalled") {
                return this.sessionStateResult(current);
            }
            const pendingInside = this.restorePendingResult(current);
            if (pendingInside)
                return pendingInside;
            // The authoritative re-check. It runs AFTER the queue is acquired but
            // BEFORE the lease heartbeat, so a concurrent commit cannot make this
            // call renew a lease for a handle it is about to reject.
            const inside = validateSubmissionHandle(parsed, current);
            if (!inside.ok)
                return this.handleMismatchResult(inside, current);
            if (current.status === "running" &&
                !this.renewSessionLease(current.loopId)) {
                return this.leaseConflictResult(current.loopId, this.findSessionEntry(current.loopId));
            }
            try {
                return await this.lifecycle.advance(current.sessionId, output, boundary.evaluation, boundary.diagnostics, boundary.submittedFields);
            }
            catch (error) {
                if (error instanceof SessionLeaseConflictError) {
                    return this.leaseConflictResult(error.loopId, this.findSessionEntry(error.loopId));
                }
                throw error;
            }
        });
    }
    /** v3.9.7: submit an Agent-initiated recovery. v4.0.0: the handle is the
     *  only anchor; shape and target visibility are checked before the
     *  queue/lease, and the exact handle is re-checked before lease renewal. */
    async recover(handle, recovery) {
        const parsed = parseSubmissionHandle(handle);
        if (!parsed)
            return this.handleRequiredResult();
        const session = this.sessions.get(parsed.sessionId);
        if (!session)
            return this.sessionNotFoundResult(parsed.sessionId);
        if (session.status !== "running" && session.status !== "stalled") {
            return this.sessionStateResult(session);
        }
        const pending = this.restorePendingResult(session);
        if (pending)
            return pending;
        const check = validateSubmissionHandle(parsed, session);
        if (!check.ok)
            return this.handleMismatchResult(check, session);
        if (!getPolicy().engine.agent_recovery_enabled) {
            return this.recoveryDisabledResult(check.handle, session);
        }
        const invalid = (detail) => ({
            sessionId: session.sessionId,
            round: session.currentRound,
            submissionHandle: check.handle,
            prompt: null,
            submissionError: {
                code: "recovery_invalid",
                details: { reason_code: "invalid_shape", detail },
            },
        });
        if (!isRecord(recovery))
            return invalid("recovery must be an object");
        const keys = Object.keys(recovery);
        if (keys.some((key) => key !== "target_checkpoint_id" && key !== "reason")) {
            return invalid("recovery accepts only target_checkpoint_id and reason");
        }
        if (typeof recovery.target_checkpoint_id !== "string" ||
            recovery.target_checkpoint_id.trim().length === 0) {
            return invalid("target_checkpoint_id must be a non-empty string");
        }
        if (typeof recovery.reason !== "string" ||
            recovery.reason.trim().length === 0 ||
            recovery.reason.length > 500) {
            return invalid("reason must be a non-empty string of at most 500 characters");
        }
        const targetCheckpointId = recovery.target_checkpoint_id;
        const reason = recovery.reason;
        // Read-only visibility check against the exact held snapshot. An invalid
        // target must not cause a lease renewal or a directive.
        const history = loadCommittedHistory(this.loopStore, session.loopId);
        const entries = history.entries;
        // A pending directive outranks target validation; the lifecycle retries
        // the same restore and never commits a second directive.
        if (!history.pendingDirective) {
            const resolved = findCheckpointRef({
                entries,
                held: check.snapshot,
                checkpointId: targetCheckpointId,
            });
            if (!resolved.ok) {
                return {
                    sessionId: session.sessionId,
                    round: session.currentRound,
                    submissionHandle: check.handle,
                    prompt: null,
                    submissionError: {
                        code: resolved.code,
                        details: {
                            target_checkpoint_id: targetCheckpointId,
                            reason_code: resolved.reason,
                            detail: resolved.detail,
                            current_round: session.currentRound,
                        },
                    },
                };
            }
        }
        const validatedRecovery = {
            target_checkpoint_id: targetCheckpointId,
            reason,
        };
        return this.withSessionQueue(session.sessionId, async () => {
            const current = this.sessions.get(session.sessionId);
            if (!current)
                return this.sessionNotFoundResult(session.sessionId);
            if (current.status !== "running" && current.status !== "stalled") {
                return this.sessionStateResult(current);
            }
            const pendingInside = this.restorePendingResult(current);
            if (pendingInside)
                return pendingInside;
            const inside = validateSubmissionHandle(parsed, current);
            if (!inside.ok)
                return this.handleMismatchResult(inside, current);
            if (!getPolicy().engine.agent_recovery_enabled) {
                return this.recoveryDisabledResult(inside.handle, current);
            }
            if (current.status === "running" &&
                !this.renewSessionLease(current.loopId)) {
                return this.leaseConflictResult(current.loopId, this.findSessionEntry(current.loopId));
            }
            try {
                return await this.lifecycle.recover(current.sessionId, validatedRecovery);
            }
            catch (error) {
                if (error instanceof SessionLeaseConflictError) {
                    return this.leaseConflictResult(error.loopId, this.findSessionEntry(error.loopId));
                }
                throw error;
            }
        });
    }
    recoveryDisabledResult(handle, session) {
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            submissionHandle: handle,
            prompt: null,
            submissionError: {
                code: "recovery_disabled",
                details: { policy: "engine.agent_recovery_enabled" },
            },
        };
    }
    /** v3.9.7: Agent-created mid-round savepoint. v4.0.0: handle identity is
     *  checked before the queue and again before lease renewal; capture/save
     *  happen only after both. A checkpoint never changes the handle. */
    async checkpoint(handle) {
        const parsed = parseSubmissionHandle(handle);
        if (!parsed) {
            const detail = "submissionHandle must be an object with exactly sessionId, roundId, " +
                "and transactionId as non-empty strings.";
            return {
                error: "submission_handle_required",
                errorMessage: `${detail} Copy it from the latest LoopForge response. ${LOST_HANDLE_ROUTING}`,
                details: { reason_code: "shape", detail },
            };
        }
        const session = this.sessions.get(parsed.sessionId);
        if (!session) {
            return {
                error: "session_not_found",
                errorMessage: "No session exists with this ID.",
                sessionId: parsed.sessionId,
            };
        }
        if (session.status !== "running") {
            const current = makeSubmissionHandle(session);
            return {
                error: "checkpoint_invalid",
                errorMessage: `Session is ${session.status}; a checkpoint requires a running held evaluation.`,
                sessionId: session.sessionId,
                ...(current ? { submissionHandle: current } : {}),
                details: { reason_code: "session_not_running" },
            };
        }
        const check = validateSubmissionHandle(parsed, session);
        if (!check.ok)
            return this.checkpointMismatchResult(check, session);
        return this.withSessionQueue(session.sessionId, async () => {
            const current = this.sessions.get(session.sessionId);
            if (!current) {
                return {
                    error: "session_not_found",
                    errorMessage: "No session exists with this ID.",
                    sessionId: session.sessionId,
                };
            }
            if (current.status !== "running") {
                const currentHandle = makeSubmissionHandle(current);
                return {
                    error: "checkpoint_invalid",
                    errorMessage: `Session is ${current.status}; a checkpoint requires a running held evaluation.`,
                    sessionId: current.sessionId,
                    ...(currentHandle ? { submissionHandle: currentHandle } : {}),
                    details: { reason_code: "session_not_running" },
                };
            }
            // Authoritative re-check: after the queue is acquired, before the lease
            // heartbeat. A checkpoint must never capture or save for a stale handle.
            const inside = validateSubmissionHandle(parsed, current);
            if (!inside.ok)
                return this.checkpointMismatchResult(inside, current);
            const pending = this.restorePendingResult(current);
            if (pending) {
                return {
                    error: "restore_pending",
                    errorMessage: "A pending restore must be completed by loopforge_resume before creating a checkpoint.",
                    sessionId: current.sessionId,
                    submissionHandle: inside.handle,
                    details: { reason_code: "restore_pending" },
                };
            }
            if (!this.renewSessionLease(current.loopId)) {
                const conflict = this.leaseConflictResult(current.loopId, this.findSessionEntry(current.loopId));
                return {
                    error: conflict.stopReason ?? "lease_conflict",
                    errorMessage: conflict.stopDetail ?? "Another process owns this loop.",
                    sessionId: current.sessionId,
                    details: { reason_code: "lease_conflict" },
                };
            }
            const held = inside.snapshot;
            const store = this.checkpointStoreFor?.(current.loopId);
            if (!store) {
                return {
                    error: "checkpoint_unavailable",
                    errorMessage: "No workspace checkpoint store is configured for this loop.",
                    sessionId: current.sessionId,
                    submissionHandle: inside.handle,
                    details: { reason_code: "store_unavailable" },
                };
            }
            let stateDir;
            try {
                stateDir = resolveStateDirectory(process.cwd(), getPolicy().backend.root_dir);
            }
            catch (error) {
                return {
                    error: "checkpoint_unavailable",
                    errorMessage: `The runtime state directory could not be resolved: ${String(error)}`,
                    sessionId: current.sessionId,
                    submissionHandle: inside.handle,
                    details: { reason_code: "state_directory_invalid" },
                };
            }
            const exclude = (path) => {
                const abs = resolve(path);
                const prefixAbs = stateDir.endsWith(sep) ? stateDir : `${stateDir}${sep}`;
                return abs === stateDir || abs.startsWith(prefixAbs);
            };
            let manifest;
            try {
                manifest = await store.capture({
                    round: held.round,
                    role: "mid",
                    cwd: process.cwd(),
                    exclude,
                    timeoutMs: Math.max(60_000, getPolicy().evidence.timeout_ms),
                });
            }
            catch (error) {
                if (error instanceof CheckpointError) {
                    return {
                        error: error.code,
                        errorMessage: error.message,
                        sessionId: current.sessionId,
                        submissionHandle: inside.handle,
                        details: { reason_code: error.reasonCode },
                    };
                }
                return {
                    error: "checkpoint_failed",
                    errorMessage: String(error),
                    sessionId: current.sessionId,
                    submissionHandle: inside.handle,
                    details: { reason_code: "capture_error" },
                };
            }
            // The capture yielded to the event loop; a concurrent advance/pause may
            // have invalidated the held transaction. Never attach an orphan
            // checkpoint to a different attempt.
            const after = validateSubmissionHandle(parsed, this.sessions.get(session.sessionId) ?? current);
            if (!after.ok) {
                return {
                    error: "checkpoint_invalid",
                    errorMessage: "The held attempt changed while the checkpoint was captured.",
                    sessionId: current.sessionId,
                    ...(after.current ? { submissionHandle: after.current } : {}),
                    details: { reason_code: "identity_changed" },
                };
            }
            const ref = buildCheckpointRef(manifest, {
                transactionId: held.transactionId,
                branchId: held.branchId,
            });
            const previous = held.checkpoints ?? [];
            const duplicate = previous.find((item) => item.checkpointId === ref.checkpointId);
            // The cap counts DISTINCT savepoints. Re-capturing an already visible
            // state is idempotent and must still return the existing ref at the cap.
            if (!duplicate &&
                previous.length >= MAX_MID_CHECKPOINTS_PER_TRANSACTION) {
                return {
                    error: "checkpoint_limit",
                    errorMessage: `This attempt already has ${MAX_MID_CHECKPOINTS_PER_TRANSACTION} mid-round checkpoints.`,
                    sessionId: current.sessionId,
                    submissionHandle: after.handle,
                    details: { reason_code: "mid_checkpoint_cap" },
                };
            }
            if (!duplicate) {
                held.checkpoints = [...previous, ref];
                try {
                    this.lifecycle.save(current);
                }
                catch (error) {
                    held.checkpoints = previous;
                    return {
                        error: "checkpoint_failed",
                        errorMessage: `The checkpoint manifest was written but the session could not be saved: ${String(error)}. Retry returns the same id.`,
                        sessionId: current.sessionId,
                        submissionHandle: after.handle,
                        details: { reason_code: "session_save_failed" },
                    };
                }
            }
            return {
                sessionId: current.sessionId,
                submissionHandle: after.handle,
                checkpointId: manifest.checkpointId,
                round: held.round,
                role: "mid",
                redoRound: manifest.round,
                createdAt: (duplicate ?? ref).createdAt,
                ...(manifest.head ? { head: manifest.head } : {}),
                fileCount: Object.keys(manifest.fingerprints).length,
                contentCount: manifest.contents.length,
                contentHash: manifest.contentHash,
            };
        });
    }
    /** Replay timeline for a session — creates ReplayBackend from the stored backend. */
    replayTimeline(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        return this.replayByLoop(session.loopId);
    }
    /** v3.3.1: Replay a loop straight from the vault — no in-memory session
     *  needed. Time travel over committed rounds is a property of the store
     *  (ReplayBackend reads round documents), so a process restart must not
     *  revoke it: the session registry was an artificial prerequisite that
     *  made every vault loop unreplayable after restart.
     *  Returns null when the loop has no committed rounds. */
    replayByLoop(loopId) {
        validateLoopId(loopId);
        const replay = new ReplayBackend(this.loopStore);
        const timeline = replay.timeline(loopId);
        return timeline.length > 0 ? timeline : null;
    }
    /** v4.0.2: a bounded replay page with its window metadata. `null` only when
     *  the session does not exist; an empty loop returns an empty page. */
    replayPage(sessionId, opts) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        return this.replayPageByLoop(session.loopId, opts);
    }
    replayPageByLoop(loopId, opts) {
        validateLoopId(loopId);
        return new ReplayBackend(this.loopStore).page(loopId, opts);
    }
    /** v3.9.6: committed rollback directives for the replay view. They are
     *  events, not normal rounds; the timeline stays a normal-round projection. */
    replayRollbacks(loopId) {
        validateLoopId(loopId);
        return loadCommittedHistory(this.loopStore, loopId).directives.map((view) => ({
            round: view.round,
            roundId: view.roundId,
            transactionId: view.transactionId ?? view.roundId,
            branchId: view.branchId ?? null,
            origin: view.origin === "agent" ? "agent" : "machine",
            redoRound: view.recovery?.target.redo_round ?? 0,
            targetCheckpointId: view.recovery?.target.checkpoint_id ?? "",
            reason: view.recovery?.reason ?? "",
            observedSkippedFiles: [...(view.recovery?.observed_skipped_files ??
                    view.recovery?.skipped_files ?? [])],
            reportedSkippedFiles: [...(view.recovery?.reported_skipped_files ?? [])],
            skippedFiles: [...(view.recovery?.skipped_files ?? [])],
            abandonedRounds: [...(view.recovery?.abandoned_rounds ?? [])],
            triggerFindings: [...(view.recovery?.trigger_findings ?? [])],
            preservedDiscoveries: [...(view.recovery?.skipped_discoveries ?? [])],
            // v4.0.2: the committed abandoned-path facts, same display caps as
            // Working Memory / replay.
            failedRounds: [...(view.recovery?.failed_rounds ?? [])],
            approaches: [...(view.recovery?.approaches ?? [])].map((value) => value.slice(0, 200)),
            wrongAssumptions: [...(view.recovery?.wrong_assumptions ?? [])].map((value) => value.slice(0, 500)),
        }));
    }
    /** v3.9.1: unsupported envelope versions for a loop, reported explicitly
     *  rather than silently dropped from replay/audit. */
    replayLegacyRounds(loopId) {
        validateLoopId(loopId);
        return new ReplayBackend(this.loopStore).legacyRounds(loopId);
    }
}
//# sourceMappingURL=session.js.map