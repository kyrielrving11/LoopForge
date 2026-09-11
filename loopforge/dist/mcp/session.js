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
import { makeGateDecision, Mode } from "../protocol.js";
import { buildLoopProjection } from "../loop-projection.js";
import { deriveCognitiveFacts } from "../cognitive-facts.js";
import { NO_IN_FLIGHT_ROUND, deriveRoundFacts } from "../round-facts.js";
import { listVerifiedClaims } from "../evidence-claims.js";
import { buildAudit } from "../audit.js";
import { buildExplain } from "../explain.js";
import { CHECK_CONTRACT_ITEMS_UNVERIFIED } from "../verification-gate.js";
import { deriveEmergedItems, validateSubGoalUpdates } from "../subgoal-state.js";
import { derivationRounds } from "../committed-round.js";
import { deriveActiveRoundContract } from "../round-contract.js";
import { getPolicy, validateLoopId } from "../policy.js";
import { isRecord } from "../token-utils.js";
import { buildSelfEvaluation, validateCoreSelfEvaluation, } from "../self-eval.js";
import { ReplayBackend } from "../replay.js";
import { FileLoopStore, queryLoopEntries } from "../loop-store.js";
import { makeRoundId, prepareRoundTransaction } from "../round-transaction.js";
import { RoundDriver } from "../round-driver.js";
import { logEvent } from "../observability.js";
import { policyMetrics, derivePolicyMetrics, mergePolicyMetrics, } from "../policy-metrics.js";
import { SessionLeaseConflictError, VaultSessionStateStore, } from "../storage.js";
import { StorageCorruptionError } from "../loop-store.js";
import { RoundLifecycle, buildLoopRequest } from "./round-lifecycle.js";
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
    /** Explicit context provider; never auto-discovered. */
    contextProvider;
    terminalSinks = new Set();
    constructor(store, sessionStore) {
        this.loopStore = store ?? new FileLoopStore(getPolicy().backend.root_dir);
        this.sessionStore = sessionStore ?? new VaultSessionStateStore(this.loopStore);
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
            getContext: () => this.contextProvider,
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
            return {
                sessionId: "",
                round: existing.currentRound,
                prompt: null,
                stopReason: `loop_already_running:${loopId}`,
                stopDetail: `A session for loop "${loopId}" already exists in this process (session ${existing.sessionId}). Inspect or resume it instead of starting a duplicate.`,
            };
        }
        // v3.2.1: pre-flight the cross-process lease BEFORE compiling — the
        // compile persists round-1 lineage and the state file into the loop's
        // vault, which would corrupt another process's live loop (round-1
        // lineage replaced, metadata overwritten). Mirrors the save-time check
        // (VaultSessionStateStore.save: a non-empty lease_owner that is not ours
        // conflicts), so observable behavior is unchanged — only the side
        // effects are avoided. The save below remains the atomic final gate.
        const persistedSession = this.sessionStore?.load(loopId);
        const persistedLineage = persistedSession?.loop_lineage;
        const persistedOwner = persistedLineage && typeof persistedLineage === "object" && !Array.isArray(persistedLineage)
            ? persistedLineage.lease_owner
            : "";
        if (typeof persistedOwner === "string" && persistedOwner && persistedOwner !== this.ownerId) {
            throw new SessionLeaseConflictError(loopId);
        }
        const engine = new LoopForgeEngine(this.loopStore);
        const maxRounds = input.maxRounds ?? getPolicy().engine.max_rounds;
        // Populate extra fields for the first round
        const request = buildLoopRequest({
            sessionId, loopId, task: input.task, engine, currentRound: 1,
            maxRounds, successTrajectory: [], status: "running", createdAt: Date.now(),
            consecutiveRejections: 0,
            lastRejectionCheck: "",
            backtrackSkippedFiles: [],
            backtrackSkippedFingerprints: {},
            evidenceBaseline: [],
        });
        request.domain = input.domain ?? "";
        request.plan_source = input.planSource ?? null;
        request.constraints_from_plan = input.constraints ?? [];
        // Explicit context is requested by the MCP embedding; no auto-discovery.
        if (this.contextProvider) {
            try {
                const ctx = {
                    loopId,
                    round: 1,
                    task: input.task,
                    domain: input.domain ?? "",
                };
                const rawContext = await this.contextProvider(ctx);
                if (rawContext?.trim()) {
                    request.external_context = rawContext.trim();
                    logEvent("external_context_loaded", {
                        loopId, round: 1,
                        contextLength: request.external_context.length,
                    });
                }
            }
            catch {
                // Provider failures are isolated from session creation.
                logEvent("context_provider_error", { loopId, round: 1 });
            }
        }
        const prepared = await new RoundDriver(engine, this.loopStore).prepare(request, loopId, 1);
        const initialPrompt = prepared?.prompt ?? null;
        const initialLevel = prepared?.level ?? "l2";
        const evidenceBaseline = prepared?.evidenceBaseline ?? [];
        const session = {
            sessionId, loopId, task: input.task, engine,
            currentRound: 1, maxRounds, successTrajectory: [],
            status: "running", createdAt: Date.now(),
            // v1.13: Enforcement gate state
            consecutiveRejections: 0,
            lastRejectionCheck: "",
            backtrackSkippedFiles: [],
            backtrackSkippedFingerprints: {},
            evidenceBaseline,
            roundSnapshot: prepared?.snapshot ?? prepareRoundTransaction(loopId, 1, evidenceBaseline),
            currentPrompt: initialPrompt,
            currentLevel: initialLevel,
            currentWarnings: prepared?.warnings ?? [],
            lastCompileResponse: prepared?.compileResponse ?? null,
        };
        this.sessions.set(sessionId, session);
        policyMetrics.recordStrategy(loopId, initialLevel);
        // Persist to vault for cross-process recovery. The save is the atomic
        // lease gate — a TOCTOU window between the pre-flight check above and
        // this write can still lose the lease race to another process.
        try {
            this.lifecycle.save(session);
        }
        catch (error) {
            // v3.2.1: roll back the in-memory registration — a registered-but-
            // unsaved session would make every later create for this loopId
            // return loop_already_running until this process restarts.
            this.sessions.delete(sessionId);
            throw error;
        }
        logEvent("session_start", {
            sessionId,
            loopId,
            task: input.task.slice(0, 80),
            maxRounds,
        });
        return {
            sessionId,
            round: 1,
            roundId: session.roundSnapshot?.roundId,
            prompt: initialPrompt,
            level: initialLevel,
            roundSuccess: false,
            warnings: prepared?.warnings ?? [],
        };
    }
    get(sessionId) {
        return this.sessions.get(sessionId);
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
        const sessionEntry = persistedStatus === "running"
            ? this.claimSessionEntry(loopId)
            : persistedEntry;
        if (!sessionEntry)
            return this.leaseConflictResult(loopId, persistedEntry);
        const session = this.lifecycle.reconstructSession(sessionEntry);
        if (!session) {
            // was not "running" — return stopped/stalled status
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
            if (status !== "running" && status !== "paused")
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
    /** v3.7.1: structured gate preflight. The agent submits a
     *  GateActionDescriptor; the runtime classifies it (conservative:
     *  anything not provably safe is user_required with reason codes). A
     *  user_required verdict persists a gate_opened record bound to
     *  loop + round + actionHash; agent_allowed records nothing and returns
     *  the evidence suggestion instead. No action is executed and no round
     *  advances from this call. */
    checkGate(sessionId, roundId, action) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return {
                error: "session_not_found",
                errorMessage: `session not found: ${sessionId}`,
                sessionId,
            };
        }
        const expectedRoundId = session.roundSnapshot?.roundId
            ?? makeRoundId(session.loopId, session.currentRound);
        if (expectedRoundId !== roundId) {
            return {
                error: "round_id_mismatch",
                errorMessage: "roundId does not match the current round — re-run loopforge_gate_check " +
                    "with the roundId from the latest response",
                sessionId,
                roundId,
            };
        }
        const verdict = preflightStructuredGate(action);
        if (verdict.kind === "user") {
            this.recordOpenedGate(session.loopId, session.currentRound, verdict, canonicalizeGateAction(action));
        }
        return {
            sessionId,
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
            const prefix = `loop:${loopId}:gate:`;
            const opened = queryLoopEntries(this.loopStore, loopId, { prefix })
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
    /** Compile the current round context exactly once per derivation path.
     *  v3.0.1: prefer the round-boundary compile cached on the session (the
     *  artifact's deterministic roundId guards against stale reuse); fall
     *  back to a read-only compile (persistLineage: false) that never writes
     *  the vault. Single derivation — shared by the projection view and the
     *  subgoal_updates preflight so they can never disagree. */
    compileContext(session) {
        const cached = session.lastCompileResponse;
        const expectedRoundId = session.roundSnapshot?.roundId
            ?? makeRoundId(session.loopId, session.currentRound);
        if (cached?.prompt_artifact && cached.prompt_artifact.roundId === expectedRoundId) {
            return cached;
        }
        try {
            const request = {
                task: session.task,
                mode: Mode.LOOP_COMPILE,
                feedback: null,
                skill_name: null,
                task_id: null,
                loop_id: session.loopId,
                round: session.currentRound,
                max_rounds: session.maxRounds,
                verification_flags: [],
            };
            const compiled = session.engine.invokeLoopCompile(request, undefined, { persistLineage: false });
            return compiled.response ?? null;
        }
        catch {
            return null; // projection/preflight degrades gracefully
        }
    }
    /** v3.7.1: pre-advance referential check for subgoal_updates. The
     *  reference space is the SAME derivation the agent saw in its prompt
     *  (the compiled sub_goals of the current round) plus this payload's own
     *  emerged items (a sub-goal may be created and transitioned in one
     *  round). Unknown IDs, terminal references, and illegal migrations
     *  return evaluation_invalid before anything mutates. Compile failure
     *  fails open (the shape checks above stay strict). */
    preflightSubGoalUpdates(sessionId, roundId, updates, emerged) {
        if (updates.length === 0)
            return [];
        const session = this.sessions.get(sessionId);
        if (!session)
            return [];
        const expectedRoundId = session.roundSnapshot?.roundId
            ?? makeRoundId(session.loopId, session.currentRound);
        if (expectedRoundId !== roundId)
            return []; // stale/foreign submission — advance handles it
        const known = this.knownSubGoals(session, emerged);
        if (!known)
            return []; // fail open: cannot observe
        return validateSubGoalUpdates(known, updates).map((error) => ({
            field: "subgoal_updates",
            reason: error.reason,
            detail: `${error.reason.replace(/_/g, " ")}: ${error.id}`,
        }));
    }
    /** v3.8: The reference space for sub-goal ids, shared by `subgoal_updates`
     *  referential validation and contract-item `subgoal_refs` validation: the
     *  compiled sub_goals of the current round (exactly the set the prompt
     *  rendered) plus this payload's own emerged items, so a sub-goal may be
     *  created and referenced in one round. Null when the compile cannot be
     *  observed — callers fail open and keep their shape checks strict. */
    knownSubGoals(session, emerged) {
        const response = this.compileContext(session);
        if (!response?.sub_goals)
            return null;
        const known = [...response.sub_goals];
        for (const item of deriveEmergedItems(session.loopId, session.currentRound, emerged)) {
            if (!known.some((sg) => sg.id === item.id)) {
                known.push({
                    id: item.id,
                    description: item.description,
                    status: "pending",
                    declared_at_round: session.currentRound,
                    status_changed_at_round: session.currentRound,
                    priority: known.length,
                });
            }
        }
        return known;
    }
    /** v3.8: pre-advance referential check for contract `subgoal_refs`. The
     *  reference space is the SAME derived sub-goal set the agent saw in its
     *  prompt plus its own same-round `emerged_subtasks` — a declaration may not
     *  forge an `sg-` id that corresponds to nothing. Returns null when the
     *  compile cannot be observed (fail open — the shape checks stay strict). */
    preflightKnownSubGoalIds(sessionId, emerged) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        const known = this.knownSubGoals(session, emerged);
        return known ? new Set(known.map((subGoal) => subGoal.id)) : null;
    }
    /** v3.8: pre-advance referential check for contract_item_claims. The
     *  reference space is the SAME derived ACTIVE contract the agent saw in its
     *  prompt. Returns the active contract's item ids, or null when the
     *  contract cannot be observed (fail open — the shape checks stay strict). */
    preflightContractItems(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        const active = this.getActiveContract(sessionId);
        if (!active)
            return new Set();
        return new Set(active.items.map((item) => item.id));
    }
    /** Typed cognitive state projection for an active session. Derived on
     *  demand — zero persistence. Null when nothing meaningful exists yet. */
    getProjection(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        const prefix = `loop:${session.loopId}:`;
        const entries = [
            ...queryLoopEntries(this.loopStore, session.loopId, { prefix }),
            ...queryLoopEntries(this.loopStore, session.loopId, { prefix, feedbackOnly: true }),
        ];
        const compileResponse = this.compileContext(session);
        const openGates = this.lifecycle.listOpenGateDescriptions(session.loopId);
        // v3.8: the projection reads the WHOLE committed history. The old
        // `beforeRound: session.currentRound` bound is only correct while the loop
        // is running, where currentRound is always one past the last committed
        // round; a stop / terminate / max_rounds leaves currentRound ON the round
        // it just committed, so the bound silently dropped the loop's final round
        // and the projection disagreed with audit and explain about it.
        // v3.8.1: one window, one decode, one derivation. The contract facts come
        // from the same `deriveRoundFacts` the compile path calls, so the prompt
        // and the projection cannot tell different stories about what the machine
        // verified.
        const rounds = derivationRounds(entries);
        const projection = buildLoopProjection(deriveCognitiveFacts({
            compileResponse,
            rounds,
            facts: deriveRoundFacts({
                rounds,
                currentRound: (rounds[rounds.length - 1]?.round ?? 0) + 1,
                inFlight: NO_IN_FLIGHT_ROUND,
                subGoals: compileResponse?.sub_goals ?? [],
                commands: getPolicy().evidence.commands ?? [],
            }),
            verifiedClaims: listVerifiedClaims(entries, session.loopId),
            openGates,
        }));
        return projection ? { ...projection } : null;
    }
    /** v3.8: Read-only per-round "why" view over committed facts. Never
     *  rebuilds history and never writes. */
    getExplain(loopId, round) {
        validateLoopId(loopId);
        const prefix = `loop:${loopId}:`;
        const entries = [
            ...queryLoopEntries(this.loopStore, loopId, { prefix }),
            ...queryLoopEntries(this.loopStore, loopId, { prefix, feedbackOnly: true }),
        ];
        return buildExplain(loopId, entries, round);
    }
    /** Read-only end-of-loop audit (verification view). Never writes. */
    getAudit(loopId) {
        validateLoopId(loopId);
        // v3.3.1: audit judges COMMITTED decisions, which live on :feedback
        // entries — but queryLoopEntries excludes feedback by default, so the
        // audit view structurally never saw a committed round (it always
        // reported "passed" on empty history). Merge both result sets like the
        // round coordinator does.
        const prefix = `loop:${loopId}:`;
        const entries = [
            ...queryLoopEntries(this.loopStore, loopId, { prefix }),
            ...queryLoopEntries(this.loopStore, loopId, { prefix, feedbackOnly: true }),
        ];
        // Zero committed decisions → nothing to audit. Returning null lets the
        // tools layer report "no audit data" instead of the external auditor
        // solemnly passing a loop that never ran (or a mistyped loopId).
        const hasCommittedDecision = derivationRounds(entries).length > 0;
        if (!hasCommittedDecision)
            return null;
        const audit = buildAudit(loopId, entries, this.loopStore);
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
        const prefix = `loop:${session.loopId}:`;
        const entries = [
            ...queryLoopEntries(this.loopStore, session.loopId, { prefix }),
            ...queryLoopEntries(this.loopStore, session.loopId, { prefix, feedbackOnly: true }),
        ];
        return deriveActiveRoundContract(derivationRounds(entries, session.currentRound));
    }
    /** v2.12: Policy metrics that survive restarts — vault-derived round
     *  statistics (A4 port) folded with this process's live observations.
     *  Non-durable fields (evidence, vault errors) come from live only. */
    getPolicyMetrics(loopId) {
        // v3.3.1: derived metrics judge committed decisions on :feedback entries,
        // which queryLoopEntries excludes by default — merge both result sets so
        // restart-surviving metrics actually see the committed rounds (before,
        // derived.committedRounds was structurally 0 and the merge fell back to
        // the live-only snapshot every time).
        const prefix = `loop:${loopId}:`;
        const entries = [
            ...queryLoopEntries(this.loopStore, loopId, { prefix }),
            ...queryLoopEntries(this.loopStore, loopId, { prefix, feedbackOnly: true }),
        ];
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
        const engine = new LoopForgeEngine(this.loopStore);
        const context = engine.hydrateLoopContext(loopId);
        // No hydratable context at all → unknown loop. A started-but-uncommitted
        // loop DOES have a context (the compile persists a lineage entry), so it
        // still gets a view — with zeros — exactly as it did before.
        if (!context)
            return null;
        const entries = Array.isArray(context.results) ? context.results : [];
        const views = derivationRounds(entries);
        const roundsWithUnverifiedItems = views.filter((view) => view.verificationFlags.some((flag) => flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED)).length;
        return {
            loopId,
            committed_rounds: views.length,
            rounds_with_unverified_items: roundsWithUnverifiedItems,
            // The policy value the enforcement gate escalates on. The streak itself
            // is derived in the gate — re-deriving it here would be a second
            // implementation of the same rule, which is what this release removes.
            unverified_streak_limit: getPolicy().engine.unverified_claim_streak_limit,
            policy_metrics: this.getPolicyMetrics(loopId),
        };
    }
    /** Core cycle: extract self-eval → record feedback → check stop → compile next.
     *  The lease + per-session queue wrap the RoundLifecycle state machine.
     *  @param preExtractedEval Structured SelfEvaluation supplied by the caller.
     *    An absent value is returned as evaluation_invalid without mutating state.
     *  @param roundId v3.0.1: The roundId of the round this submission reports on
     *    (from the last start/next/resume response). Anchors the submission so a
     *    stale or duplicate submission is not processed against a later round.
     *    Optional for library callers — when absent the anchor check is skipped. */
    async advance(sessionId, output, preExtractedEval, roundId) {
        const current = this.sessions.get(sessionId);
        if (current && (current.status === "running" || current.status === "stalled")) {
            const rawEvaluation = preExtractedEval;
            if (!isRecord(rawEvaluation)) {
                return {
                    sessionId,
                    round: current.currentRound,
                    roundId: current.roundSnapshot?.roundId
                        ?? makeRoundId(current.loopId, current.currentRound),
                    prompt: null,
                    stopReason: "evaluation_invalid",
                    stopDetail: "A structured evaluation object is required. Resubmit the same roundId with success, output_summary, constraint_violations, and should_continue.",
                };
            }
            const validation = validateCoreSelfEvaluation(rawEvaluation);
            if (validation.missing.length > 0 || validation.invalid.length > 0) {
                return {
                    sessionId,
                    round: current.currentRound,
                    roundId: current.roundSnapshot?.roundId
                        ?? makeRoundId(current.loopId, current.currentRound),
                    prompt: null,
                    stopReason: "evaluation_invalid",
                    stopDetail: "The structured evaluation has missing or invalid core fields. Correct it and resubmit the same roundId.",
                };
            }
            preExtractedEval = buildSelfEvaluation(rawEvaluation);
        }
        return this.withSessionQueue(sessionId, async () => {
            const session = this.sessions.get(sessionId);
            if (session?.status === "running" &&
                !this.renewSessionLease(session.loopId)) {
                return this.leaseConflictResult(session.loopId, this.findSessionEntry(session.loopId));
            }
            try {
                return await this.lifecycle.advance(sessionId, output, preExtractedEval, roundId);
            }
            catch (error) {
                if (error instanceof SessionLeaseConflictError) {
                    return this.leaseConflictResult(error.loopId, this.findSessionEntry(error.loopId));
                }
                throw error;
            }
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
}
//# sourceMappingURL=session.js.map