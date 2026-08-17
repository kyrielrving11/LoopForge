/** LoopForge MCP session manager.
 *
 * Each McpSession = one complete multi-round loop.
 * SessionManager holds Map<sessionId, McpSession> and drives
 * The advance cycle validates a report, executes the transaction, and compiles the next prompt.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LoopForgeEngine } from "../engine.js";
import { deriveGoalId } from "../loop-compiler.js";
import { bindPolicyWorkspace, getPolicy, writeWorkflowStateFile } from "../policy.js";
import { Mode, makeLoopObjective, makeRoundHistoryEntry } from "../protocol.js";
import { ReplayBackend } from "../replay.js";
import { FileLoopStore, LoopStoreBackend, VaultBackendLoopStore } from "../loop-store.js";
import { isApprovalPolicy } from "../protocol.js";
import { LOOPFORGE_VERSION } from "../version.js";
import { buildPlanningPrompt, buildPlanChangePrompt, buildRefinementPrompt, createWorkflowState, computeWorkflowProgress, assessPlanChange, deriveRefinementLinks, makeApprovalId, planRequiresApproval, selectActiveStep, validatePlan, validatePlanReplacement, validatePlanReplacementDiagnostics, } from "../plan.js";
import { EvidenceCollector, workspaceCommandsAuthorized } from "../evidence-provider.js";
import { makeRoundId, parseRoundTransactionSnapshot, prepareRoundTransaction, } from "../round-transaction.js";
import { RoundDriver } from "../round-driver.js";
import { logEvent } from "../observability.js";
import { policyMetrics } from "../policy-metrics.js";
import { SessionLeaseConflictError, VaultSessionStateStore, } from "../storage.js";
import { isRecord, unique } from "../token-utils.js";
import { resolveStoreRoot, storeId as workspaceStoreId } from "../workspace-runtime.js";
import { auditClaimTargets, normalizeRoundReport, stepClaimTargets, validateRoundReport, } from "../round-report.js";
import { createWorkflowEvent, workflowEventEntry, parseWorkflowEventEntry, } from "../workflow-events.js";
import { buildGraphSlice, summarizeGovernanceGraph } from "../governance-graph.js";
import { deriveRegressionObligations, regressionSummary } from "../regression-obligations.js";
// Helpers
function buildLoopRequest(session, lastEval, verificationFlags, options = {}) {
    const req = {
        task: session.task,
        mode: Mode.LOOP_COMPILE,
        loop_id: session.loopId,
        goal_id: deriveGoalId(session.loopId, session.task),
        round: session.currentRound,
        round_id: makeRoundId(session.loopId, session.currentRound, session.executionEpoch),
        max_rounds: session.maxRounds,
        verification_flags: verificationFlags ?? [],
    };
    const plan = session.workflow.plan;
    const activeStep = plan?.steps.find((step) => step.id === session.workflow.activeStepId);
    if (session.workflow.baselineConstraints.length > 0) {
        req.constraints_from_plan = session.workflow.baselineConstraints;
    }
    if (plan) {
        const reportTargets = session.workflow.phase === "auditing"
            ? auditClaimTargets(plan).map((item) => ({ ...item, kind: "success_criterion" }))
            : activeStep ? stepClaimTargets(activeStep) : [];
        const obligationTargets = (options.regressionObligations ?? []).map((item) => ({
            id: item.id,
            text: `${item.checkName} must remain passing (${item.claimId})`,
            kind: "regression_obligation",
        }));
        const allReportTargets = [...reportTargets, ...obligationTargets];
        const previousClaims = new Set(lastEval?.evidenceEnvelope.claims.map((claim) => claim.targetId) ?? []);
        const evidenceGaps = allReportTargets.filter((target) => !previousClaims.has(target.id));
        const failedChecks = lastEval?.evidenceEnvelope.checks.value
            .filter((check) => check.status !== "passed") ?? [];
        const reportMode = session.workflow.phase === "auditing"
            ? "audit"
            : options.planBoundary || !lastEval || lastEval.activeStepId !== session.workflow.activeStepId
                ? "step_start"
                : "step_continue";
        const constraints = unique([
            ...session.workflow.baselineConstraints,
            ...plan.constraints,
            ...(options.preservedDiscoveries ?? []),
        ]);
        req.constraints_from_plan = constraints;
        req.loop_objective = makeLoopObjective({
            objective: plan.objective,
            success_criteria: plan.successCriteria,
            hard_constraints: constraints,
            created_at_round: 1,
            loop_id: session.loopId,
            version: session.workflow.planVersion ?? 1,
        });
        req.compilation_context = {
            planVersion: session.workflow.planVersion,
            promptMode: reportMode,
            activeStep,
            objective: plan.objective,
            successCriteria: plan.successCriteria,
            claimTargets: allReportTargets,
            evidenceGaps,
            failedChecks,
            instruction: session.workflow.phase === "auditing"
                ? "Perform the final evidence audit. Do not implement additional scope unless the audit finds a concrete defect."
                : "Execute only the assigned active step and its direct verification closure.",
        };
        req.report_contract = "round_report_v1";
        req.report_mode = reportMode;
        req.report_claim_targets = allReportTargets;
        req.plan_boundary = options.planBoundary ?? false;
        if (getPolicy().prompt.graph_slice_enabled) {
            req.graph_slice = { ...buildGraphSlice(session.workflow, lastEval), regressionGapIds: (options.regressionObligations ?? []).filter((item) => item.lastStatus !== "verified").map((item) => item.id).sort() };
        }
    }
    if (options.backtrackDiagnosis?.trim()) {
        req.external_context = options.backtrackDiagnosis.trim();
    }
    if (lastEval) {
        req.last_evaluation = makeRoundHistoryEntry({
            round: session.currentRound - 1,
            status: lastEval.report.status,
            summary: lastEval.report.summary,
            violations: lastEval.report.violations ?? [],
            evidenceEnvelope: lastEval.evidenceEnvelope,
            // P0-P2: forward evolution fields to the next compile.
            // Merge sub-agent discovered constraints into the active set
            discoveries: lastEval.report.discoveries,
            delegations: lastEval.report.delegations,
            contextRequest: lastEval.report.contextRequest,
        });
    }
    return req;
}
function completionEvidenceProblem(evaluation, requiredClaimIds) {
    if (evaluation.report.status !== "completed")
        return "completed workflow transition requires report.status=completed";
    const claimed = new Set(evaluation.evidenceEnvelope.claims.map((claim) => claim.targetId));
    const missing = requiredClaimIds.filter((id) => !claimed.has(id));
    if (missing.length)
        return `completed report does not prove claims: ${missing.join(", ")}`;
    const failed = evaluation.evidenceEnvelope.checks.value.filter((check) => check.status === "failed");
    if (failed.length)
        return `completed report contains failed checks: ${failed.map((check) => check.name).join(", ")}`;
    if (evaluation.evidenceEnvelope.contradictions.length)
        return "completed report contains contradicted evidence";
    return null;
}
function regressionEvidenceProblem(evaluation, obligations, allowAuditImplicit = false) {
    if (!obligations.length || evaluation.report.status !== "completed")
        return null;
    if (!evaluation.evidenceEnvelope.checks.value.some((check) => check.status === "passed")) {
        return "final audit requires at least one passing verification check";
    }
    const claims = new Map(evaluation.evidenceEnvelope.claims.map((claim) => [claim.targetId, claim]));
    const missing = obligations.filter((item) => !claims.has(item.id)).map((item) => item.id);
    if (missing.length && !allowAuditImplicit)
        return `regression obligations missing: ${missing.join(", ")}`;
    if (missing.length && allowAuditImplicit) {
        const unavailable = obligations.filter((item) => {
            const check = evaluation.evidenceEnvelope.checks.value.find((candidate) => candidate.name === item.checkName);
            return !check || check.status !== "passed";
        });
        if (unavailable.length)
            return `regression obligations are not verified: ${unavailable.map((item) => item.id).join(", ")}`;
        return null;
    }
    const failed = obligations.filter((item) => {
        const claim = claims.get(item.id);
        const check = evaluation.evidenceEnvelope.checks.value.find((candidate) => candidate.name === item.checkName);
        return !check || check.status !== "passed" ||
            !claim.evidenceRefs.includes(`check:${item.checkName}`);
    }).map((item) => item.id);
    return failed.length ? `regression obligations are not verified: ${failed.join(", ")}` : null;
}
function readNormalizedEvaluation(value) {
    if (!isRecord(value) || value.reportVersion !== 1 ||
        !["executing", "auditing"].includes(String(value.phase)) ||
        !isRecord(value.report) || !isRecord(value.evidenceEnvelope))
        return undefined;
    const report = value.report;
    const envelope = value.evidenceEnvelope;
    if (!["completed", "blocked", "in_progress"].includes(String(report.status)) ||
        typeof report.summary !== "string" || !isRecord(envelope.files) ||
        !isRecord(envelope.checks) || !Array.isArray(envelope.claims) ||
        !Array.isArray(envelope.contradictions))
        return undefined;
    return value;
}
function readWorkflowState(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const workflow = value;
        if (["planning", "awaiting_approval", "executing", "auditing", "terminal"].includes(String(workflow.phase))) {
            // Sessions written before the approval policy existed default to the
            // safe risk-only behavior; an explicitly invalid value is unsupported.
            const approvalPolicy = workflow.approvalPolicy === undefined
                ? "risk_only"
                : isApprovalPolicy(workflow.approvalPolicy) ? workflow.approvalPolicy : null;
            if (!approvalPolicy)
                throw new Error("session_version_unsupported: invalid approvalPolicy");
            return {
                phase: workflow.phase,
                approvalPolicy,
                planningProfile: workflow.planningProfile === "full" ? "full" : "minimal",
                planVersion: typeof workflow.planVersion === "number" ? workflow.planVersion : null,
                plan: workflow.plan ?? null,
                revisions: Array.isArray(workflow.revisions) ? workflow.revisions : [],
                approvalId: typeof workflow.approvalId === "string" ? workflow.approvalId : null,
                approvalHistory: Array.isArray(workflow.approvalHistory) ? workflow.approvalHistory : [],
                activeStepId: typeof workflow.activeStepId === "string" ? workflow.activeStepId : null,
                planningPrompt: typeof workflow.planningPrompt === "string" ? workflow.planningPrompt : null,
                planSource: typeof workflow.planSource === "string" ? workflow.planSource : null,
                baselineConstraints: Array.isArray(workflow.baselineConstraints)
                    ? workflow.baselineConstraints.filter((item) => typeof item === "string")
                    : [],
                pendingPlanChange: workflow.pendingPlanChange ?? null,
                queuedPlanChange: workflow.queuedPlanChange ?? null,
                auditVerifiedCriteria: Array.isArray(workflow.auditVerifiedCriteria)
                    ? workflow.auditVerifiedCriteria.filter((item) => typeof item === "string")
                    : [],
                blockingGate: workflow.blockingGate ?? null,
                advancementHistory: Array.isArray(workflow.advancementHistory)
                    ? workflow.advancementHistory
                    : [],
            };
        }
    }
    throw new Error("session_version_unsupported");
}
// SessionManager
export class SessionManager {
    sessions = new Map();
    /** Serializes state transitions for each session. */
    sessionQueues = new Map();
    backend;
    sessionStore;
    loopStore;
    ownerId = `${process.pid}:${randomUUID()}`;
    leaseMs;
    leaseRenewIntervalMs;
    leaseTimer = null;
    /** Explicit context provider; never auto-discovered. */
    contextProvider;
    terminalSinks = new Set();
    runtime;
    constructor(storeOrBackend, sessionStore, runtime) {
        this.runtime = runtime;
        if (runtime?.currentBinding)
            bindPolicyWorkspace(runtime.currentBinding.workspaceRoot);
        const isLoopStore = (v) => "readSession" in v && typeof v.readSession === "function";
        const store = storeOrBackend
            ? isLoopStore(storeOrBackend)
                ? storeOrBackend
                : new VaultBackendLoopStore(storeOrBackend)
            : runtime?.isBound
                ? new FileLoopStore(runtime.currentBinding.storeRoot)
                : runtime
                    ? undefined
                    : new FileLoopStore(getPolicy().backend.root_dir);
        this.backend = storeOrBackend && !isLoopStore(storeOrBackend)
            ? storeOrBackend
            : store
                ? new LoopStoreBackend(store)
                : undefined;
        this.loopStore = store;
        this.sessionStore = sessionStore ?? (store ? new VaultSessionStateStore(store) : undefined);
        const mcpPolicy = getPolicy().mcp;
        this.leaseMs = Math.max(1, mcpPolicy.session_lease_ms);
        this.leaseRenewIntervalMs = Math.max(1, Math.min(mcpPolicy.session_lease_renew_interval_ms, this.leaseMs));
        if (this.sessionStore?.renewLease) {
            this.leaseTimer = setInterval(() => this.renewOwnedLeases(), this.leaseRenewIntervalMs);
            this.leaseTimer.unref?.();
        }
    }
    /** Runtime summary is intentionally compact for unbound MCP processes. */
    getRuntimeSummary() {
        return this.runtime?.summary() ?? null;
    }
    getCapabilityPreflight(sessionId) {
        const policy = getPolicy();
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        const gitEnabled = policy.evidence.providers.includes("git");
        const gitAvailable = session?.evidenceBaseline?.some((item) => item.provider === "git") ?? false;
        const commandsConfigured = policy.evidence.commands.some((command) => command.enabled);
        const commandsAuthorized = workspaceCommandsAuthorized();
        const warnings = [...(this.runtime?.warnings ?? [])];
        if (gitEnabled && !gitAvailable)
            warnings.push("Git evidence is configured but was unavailable for the current round.");
        if (commandsConfigured && !commandsAuthorized) {
            warnings.push("Workspace command evidence is configured but blocked until the host sets LOOPFORGE_ALLOW_WORKSPACE_COMMANDS=1.");
        }
        return {
            serverVersion: LOOPFORGE_VERSION,
            reportContract: "round_report_v1",
            toolCount: 12,
            workspaceBound: this.runtime?.isBound ?? true,
            storeWritable: Boolean(this.sessionStore),
            gitEvidence: !gitEnabled ? "disabled" : gitAvailable ? "available" : "unavailable",
            commandEvidence: !commandsConfigured ? "disabled" : commandsAuthorized ? "configured" : "blocked",
            warnings: [...new Set(warnings)],
        };
    }
    getRegressionSummary(sessionId) {
        const session = this.sessions.get(sessionId);
        return session ? regressionSummary(this.regressionObligations(session)) : null;
    }
    /** Bind the process and install a store only after path validation succeeds. */
    bindWorkspace(workspaceRoot, storeDir) {
        if (!this.runtime)
            return;
        if (this.runtime.isBound && !workspaceRoot && !storeDir)
            return;
        const targetWorkspace = workspaceRoot ?? this.runtime.currentBinding?.workspaceRoot;
        if (!targetWorkspace) {
            throw new Error("workspace_not_bound: workspaceRoot is required on an unbound MCP process");
        }
        const resolved = this.runtime.resolve(targetWorkspace, storeDir);
        if (!storeDir) {
            resolved.storeRoot = resolveStoreRoot(resolved.workspace.root, getPolicy(resolve(resolved.workspace.root, "loop_policy.json")).backend.root_dir);
        }
        const workspacePolicy = bindPolicyWorkspace(resolved.workspace.root);
        const binding = this.runtime.bindResolved(resolved);
        const store = new FileLoopStore(binding.storeRoot);
        this.loopStore = store;
        this.backend = new LoopStoreBackend(store);
        this.sessionStore = new VaultSessionStateStore(store);
        this.leaseMs = Math.max(1, workspacePolicy.mcp.session_lease_ms);
        this.leaseRenewIntervalMs = Math.max(1, Math.min(workspacePolicy.mcp.session_lease_renew_interval_ms, this.leaseMs));
        if (this.leaseTimer)
            clearInterval(this.leaseTimer);
        this.leaseTimer = setInterval(() => this.renewOwnedLeases(), this.leaseRenewIntervalMs);
        this.leaseTimer.unref?.();
    }
    ensureWorkspaceForStart(input) {
        if (!this.runtime)
            return;
        if (!this.runtime.isBound && !input.workspaceRoot) {
            throw new Error("workspace_not_bound: loopforge_start requires workspaceRoot on an unbound MCP process");
        }
        this.bindWorkspace(input.workspaceRoot, input.storeDir);
    }
    sessionBinding(entry) {
        const value = entry.loop_lineage?.workspace_binding;
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
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
    async withRunningSessionMutation(sessionId, work) {
        return this.withSessionQueue(sessionId, async () => {
            const session = this.sessions.get(sessionId);
            if (!session) {
                return this.present({ sessionId, round: 0, prompt: null, stopReason: "session_not_found" });
            }
            if (session.status !== "running") {
                return this.present({
                    sessionId,
                    round: session.currentRound,
                    prompt: null,
                    stopReason: session.status,
                    stopDetail: `Session is ${session.status}; resume it before changing workflow state.`,
                });
            }
            if (!this.renewSessionLease(session.loopId)) {
                return this.present(this.leaseConflictResult(session.loopId, this.findSessionEntry(session.loopId)), sessionId);
            }
            try {
                return await work(session);
            }
            catch (error) {
                if (error instanceof SessionLeaseConflictError) {
                    return this.present(this.leaseConflictResult(error.loopId, this.findSessionEntry(error.loopId)), sessionId);
                }
                throw error;
            }
        });
    }
    /** Add the uniform v3 workflow envelope to every advancing response. */
    present(result, sessionId = result.sessionId) {
        const session = this.sessions.get(sessionId);
        const phase = session?.workflow.phase ?? (result.stopReason ? "terminal" : "planning");
        let requiredAction = "none";
        if (!result.stopReason && result.prompt) {
            if (result.enforcementAction === "reject")
                requiredAction = "resubmit_round";
            else if (result.enforcementAction === "backtrack")
                requiredAction = "restore_workspace";
            else if (phase === "planning") {
                requiredAction = session?.workflow.plan ? "refine_plan" : "submit_plan";
            }
            else if (phase === "awaiting_approval")
                requiredAction = "approve_plan";
            else if (phase === "auditing")
                requiredAction = "execute_audit";
            else
                requiredAction = "execute_prompt";
        }
        return {
            ...result,
            phase: result.stopReason ? "terminal" : phase,
            requiredAction,
            terminal: Boolean(result.stopReason) || phase === "terminal",
            planVersion: session?.workflow.planVersion ?? null,
            activeStepId: session?.workflow.activeStepId ?? null,
            approvalId: session?.workflow.approvalId ?? null,
            approvalPolicy: session?.workflow.approvalPolicy,
            planningProfile: session?.workflow.planningProfile,
            runtime: this.runtime?.summary() ?? null,
            regressionSummary: session ? regressionSummary(this.regressionObligations(session)) : undefined,
            warnings: [...new Set([...(result.warnings ?? []), ...(this.runtime?.warnings ?? [])])],
            roundId: result.roundId ?? session?.roundSnapshot?.roundId,
        };
    }
    recordWorkflowEvent(session, eventType, payload) {
        const event = createWorkflowEvent(session.loopId, session.currentRound, session.workflow.phase, session.workflow.planVersion, session.workflow.activeStepId, { eventType, payload });
        const entry = workflowEventEntry(event, session.task);
        const taskId = String(entry.task_id);
        if (this.backend?.queryEntries({ prefix: taskId }).some((entry) => entry.task_id === taskId))
            return;
        this.backend?.appendEntry(entry);
    }
    regressionObligations(session) {
        const entries = this.backend?.queryEntries({ prefix: `loop:${session.loopId}:r` }) ?? [];
        return deriveRegressionObligations(entries);
    }
    applyAcceptedWorkflowStep(session, evaluation) {
        if (session.workflow.phase !== "executing") {
            return "none";
        }
        const plan = session.workflow.plan;
        const stepId = session.workflow.activeStepId;
        const step = plan?.steps.find((candidate) => candidate.id === stepId);
        if (!step || !stepId)
            return "none";
        const report = evaluation.report;
        if (report?.discoveries) {
            this.recordWorkflowEvent(session, "work_discovered", {
                step_id: stepId,
                discoveries: report.discoveries,
            });
        }
        if (report?.planChangeRequest?.timing === "next_boundary") {
            session.workflow.queuedPlanChange = report.planChangeRequest;
        }
        if (report?.planChangeRequest?.timing === "before_continue") {
            session.workflow.pendingPlanChange = report.planChangeRequest;
            session.workflow.queuedPlanChange = null;
            session.workflow.phase = "planning";
            session.workflow.activeStepId = null;
            step.status = "ready";
            session.workflow.planningPrompt = buildPlanChangePrompt(plan, report.planChangeRequest, [
                ...(report.discoveries?.newConstraints ?? []),
                ...(report.discoveries?.emergedWork ?? []),
                ...(report.discoveries?.facts ?? []),
            ]);
            this.recordWorkflowEvent(session, "plan_change_requested", {
                step_id: stepId,
                request: report.planChangeRequest,
            });
            session.currentRound++;
            session.currentPrompt = null;
            session.roundSnapshot = undefined;
            return "planning";
        }
        if (report.status === "in_progress")
            return "none";
        step.status = report.status === "completed" ? "done" : "blocked";
        this.recordWorkflowEvent(session, "step_result", {
            step_id: stepId,
            step_status: report.status,
            round_id: session.roundSnapshot?.roundId ?? null,
            attempt: session.roundSnapshot?.attempt ?? 1,
            evidence: evaluation.evidenceEnvelope,
            summary: report.summary,
        });
        session.currentRound++;
        session.currentPrompt = null;
        session.roundSnapshot = undefined;
        session.workflow.activeStepId = null;
        if (session.workflow.queuedPlanChange) {
            session.workflow.pendingPlanChange = session.workflow.queuedPlanChange;
            session.workflow.queuedPlanChange = null;
            session.workflow.phase = "planning";
            session.workflow.planningPrompt = buildPlanChangePrompt(plan, session.workflow.pendingPlanChange);
            return "planning";
        }
        const unresolvedBlocked = plan?.steps.some((candidate) => candidate.status === "blocked") ?? false;
        const hasRemaining = plan?.steps.some((candidate) => !["done", "canceled", "blocked"].includes(candidate.status)) ?? false;
        if (!hasRemaining && unresolvedBlocked) {
            session.status = "stopped";
            session.workflow.phase = "terminal";
            return "blocked";
        }
        return "advance";
    }
    blockOnExternalGate(session, step) {
        step.status = "blocked";
        session.status = "stopped";
        session.workflow.phase = "terminal";
        session.workflow.blockingGate = {
            stepId: step.id,
            planVersion: session.workflow.planVersion ?? 0,
            evidenceRequirements: [...step.evidenceRequirements],
            blockedAt: new Date().toISOString(),
        };
        this.recordWorkflowEvent(session, "step_result", {
            step_id: step.id,
            step_status: "blocked",
            round_id: session.roundSnapshot?.roundId ?? null,
            attempt: session.roundSnapshot?.attempt ?? 1,
            evidence_requirements: step.evidenceRequirements,
            reason: "External gate requires evidence or action outside the Agent execution boundary.",
        });
        this.save(session);
        return this.present({
            sessionId: session.sessionId,
            round: session.currentRound,
            prompt: null,
            stopReason: "blocked",
            stopDetail: `External gate ${step.id} (${step.title}) requires external evidence or human action: ${step.evidenceRequirements.join("; ")}`,
        });
    }
    prepareWorkflowRoundSync(session, planBoundary = false) {
        const selected = this.selectWorkflowPreparation(session, planBoundary);
        if (selected.kind === "planning")
            return this.planningResult(session, selected.prompt);
        if (selected.kind === "blocked")
            return selected.result;
        const prepared = new RoundDriver(session.engine, this.backend, this.runtime?.currentBinding?.workspaceRoot).prepareSync(selected.request, session.loopId, session.currentRound, session.executionEpoch);
        if (!prepared) {
            session.status = "stalled";
            return this.present({ sessionId: session.sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", stopDetail: "Could not compile the workflow prompt during recovery." });
        }
        return this.finishPreparedWorkflowRound(session, prepared);
    }
    selectWorkflowPreparation(session, planBoundary, compileContext = {}) {
        const plan = session.workflow.plan;
        if (!plan)
            return { kind: "planning", prompt: buildPlanningPrompt(session.task, session.workflow.baselineConstraints) };
        if (session.workflow.phase === "auditing") {
            session.workflow.activeStepId = "audit-final";
            const request = buildLoopRequest(session, undefined, compileContext.verificationFlags, { planBoundary, ...compileContext, regressionObligations: this.regressionObligations(session) });
            return { kind: "compile", request };
        }
        const step = selectActiveStep(plan);
        if (!step) {
            session.workflow.phase = "auditing";
            return this.selectWorkflowPreparation(session, true, compileContext);
        }
        session.workflow.activeStepId = step.id;
        if (step.kind === "external_gate")
            return { kind: "blocked", result: this.blockOnExternalGate(session, step) };
        if (step.kind === "outline" || step.refinement === "outline") {
            session.workflow.phase = "planning";
            session.workflow.planningPrompt = buildRefinementPrompt(plan, step);
            return { kind: "planning", prompt: session.workflow.planningPrompt };
        }
        session.workflow.phase = "executing";
        step.status = "active";
        return { kind: "compile", request: buildLoopRequest(session, undefined, compileContext.verificationFlags, { planBoundary, ...compileContext, regressionObligations: this.regressionObligations(session) }) };
    }
    finishPreparedWorkflowRound(session, prepared) {
        session.evidenceBaseline = prepared.evidenceBaseline;
        session.roundSnapshot = prepared.snapshot;
        session.currentPrompt = prepared.prompt;
        session.currentLevel = prepared.level;
        session.currentWarnings = prepared.warnings ?? [];
        policyMetrics.recordStrategy(session.loopId, prepared.level);
        this.save(session);
        return this.present({ sessionId: session.sessionId, round: session.currentRound, roundId: prepared.snapshot.roundId, prompt: prepared.prompt, level: prepared.level, warnings: prepared.warnings ?? [] });
    }
    planningResult(session, prompt) {
        session.currentPrompt = prompt;
        session.currentLevel = "planning";
        session.currentWarnings = [];
        session.roundSnapshot = undefined;
        session.evidenceBaseline = [];
        this.save(session);
        return this.present({
            sessionId: session.sessionId,
            round: session.currentRound,
            prompt,
            level: "planning",
            warnings: [],
        });
    }
    async prepareWorkflowRound(session, planBoundary = false, compileContext = {}) {
        const selected = this.selectWorkflowPreparation(session, planBoundary, compileContext);
        if (selected.kind === "planning")
            return this.planningResult(session, selected.prompt);
        if (selected.kind === "blocked")
            return selected.result;
        const prepared = await new RoundDriver(session.engine, this.backend, this.runtime?.currentBinding?.workspaceRoot).prepare(selected.request, session.loopId, session.currentRound, session.executionEpoch);
        if (!prepared) {
            session.status = "stalled";
            return this.present({ sessionId: session.sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", stopDetail: "Could not compile the workflow prompt." });
        }
        return this.finishPreparedWorkflowRound(session, prepared);
    }
    async create(input) {
        if (!input.task.trim())
            throw new Error("task is required and must be non-empty");
        // Validate a caller-provided override before binding an unbound runtime;
        // rejected input must not commit process-level workspace identity.
        if (input.approvalPolicy !== undefined && !isApprovalPolicy(input.approvalPolicy)) {
            throw new Error("invalid approvalPolicy: expected \"risk_only\" or \"every_revision\"");
        }
        if (this.runtime && !this.runtime.isBound && input.loopId) {
            if (!input.workspaceRoot) {
                throw new Error("workspace_not_bound: loopforge_start requires workspaceRoot on an unbound MCP process");
            }
            const candidate = this.runtime.resolve(input.workspaceRoot, input.storeDir);
            if (!input.storeDir) {
                candidate.storeRoot = resolveStoreRoot(candidate.workspace.root, getPolicy(resolve(candidate.workspace.root, "loop_policy.json")).backend.root_dir);
            }
            const existing = new FileLoopStore(candidate.storeRoot).readSession(input.loopId);
            const existingBinding = existing ? this.sessionBinding(existing.entry) : null;
            if (existingBinding && existingBinding.workspaceId !== candidate.workspace.id) {
                throw new Error(`workspace_mismatch: loop "${input.loopId}" belongs to ${existingBinding.workspaceRoot}`);
            }
            if (existing) {
                throw new Error(`loop_conflict: saved session already exists for loop "${input.loopId}"`);
            }
        }
        this.ensureWorkspaceForStart(input);
        if (!this.backend || !this.sessionStore) {
            throw new Error("workspace_not_bound: bind a workspace before starting a session");
        }
        const sessionId = randomUUID();
        const loopId = input.loopId ?? randomUUID();
        const engine = new LoopForgeEngine(this.backend);
        const maxRounds = input.maxRounds ?? getPolicy().engine.max_rounds;
        const approvalPolicy = input.approvalPolicy ?? getPolicy().workflow.approval_policy;
        if (!isApprovalPolicy(approvalPolicy)) {
            throw new Error("invalid approvalPolicy: expected \"risk_only\" or \"every_revision\"");
        }
        const planningProfile = input.planningProfile ?? "minimal";
        if (planningProfile !== "minimal" && planningProfile !== "full") {
            throw new Error("invalid planningProfile: expected \"minimal\" or \"full\"");
        }
        const workflow = createWorkflowState(input.planSource, input.constraints ?? [], approvalPolicy, planningProfile);
        const session = {
            sessionId, loopId, task: input.task, engine,
            currentRound: 1, maxRounds, successTrajectory: [],
            executionEpoch: 0,
            status: "running", createdAt: Date.now(),
            consecutiveRejections: 0,
            lastRejectionCheck: "",
            backtrackSkippedFiles: [],
            evidenceBaseline: [],
            currentWarnings: [],
            workflow,
        };
        workflow.planningPrompt = buildPlanningPrompt(input.task, input.constraints ?? [], planningProfile);
        const persistInitialSession = () => {
            if (this.getByLoopId(loopId) || this.sessionStore?.load(loopId)) {
                throw new Error(`loop_conflict: saved or active session already exists for loop "${loopId}"`);
            }
            this.sessions.set(sessionId, session);
            try {
                this.save(session);
            }
            catch (error) {
                this.sessions.delete(sessionId);
                throw error;
            }
        };
        if (this.loopStore)
            this.loopStore.withLock(persistInitialSession);
        else
            persistInitialSession();
        this.recordWorkflowEvent(session, "planning_started", { plan_source: input.planSource ?? null });
        if (input.plan)
            return this.submitPlan(sessionId, input.plan, "start", "Plan supplied to loopforge_start", []);
        return this.planningResult(session, workflow.planningPrompt);
    }
    async submitPlan(sessionId, plan, reason = "initial plan", changeSummary = "Initial structured plan", evidenceReferences = []) {
        return this.withRunningSessionMutation(sessionId, async (session) => {
            if (session.workflow.phase !== "planning") {
                return this.present({ sessionId, round: session.currentRound, prompt: session.currentPrompt ?? null, stopDetail: "Plans can only be submitted during the planning phase." });
            }
            if (session.workflow.planVersion !== null) {
                return this.present({ sessionId, round: session.currentRound, prompt: session.currentPrompt ?? null, stopDetail: "A plan already exists; use loopforge_plan_update." });
            }
            return this.acceptPlanRevision(session, plan, null, reason, changeSummary, evidenceReferences, false);
        });
    }
    async updatePlan(sessionId, baseVersion, plan, reason, changeSummary, evidenceReferences) {
        return this.withRunningSessionMutation(sessionId, async (session) => {
            if (session.workflow.planVersion !== baseVersion || !session.workflow.plan) {
                return this.present({ sessionId, round: session.currentRound, prompt: session.currentPrompt ?? null, stopDetail: `Stale plan baseVersion ${baseVersion}; current version is ${session.workflow.planVersion}.`, planDiagnostics: [{
                            code: "stale_plan_version", severity: "error", path: "baseVersion", message: `Expected current plan version ${session.workflow.planVersion}, received ${baseVersion}.`,
                            repairHint: "Reload status and submit the complete replacement against the current planVersion.",
                        }] });
            }
            if (session.workflow.phase !== "planning") {
                return this.present({ sessionId, round: session.currentRound, prompt: session.currentPrompt ?? null, stopDetail: "Plans can only be updated at a planning or refinement boundary." });
            }
            const replacementErrors = validatePlanReplacement(session.workflow.plan, plan);
            if (replacementErrors.length) {
                const planDiagnostics = validatePlanReplacementDiagnostics(session.workflow.plan, plan);
                const diagnosticPrompt = `${buildRefinementPrompt(session.workflow.plan, selectActiveStep(session.workflow.plan) ?? session.workflow.plan.steps[0])}\n\nPlan diagnostics to repair:\n${planDiagnostics.map((item) => `- [${item.code}] ${item.path}: ${item.message} Hint: ${item.repairHint}`).join("\n")}`;
                return this.present({ sessionId, round: session.currentRound, prompt: diagnosticPrompt, stopDetail: replacementErrors.join("; "), planDiagnostics });
            }
            return this.acceptPlanRevision(session, plan, baseVersion, reason, changeSummary, evidenceReferences);
        });
    }
    async acceptPlanRevision(session, plan, baseVersion, reason, changeSummary, evidenceReferences, forceApproval = false) {
        const validation = validatePlan(plan, {
            maxSteps: getPolicy().workflow.max_plan_steps,
            executableHorizon: getPolicy().workflow.executable_horizon,
            allowHistoricalStatuses: baseVersion !== null,
            requiredConstraints: session.workflow.baselineConstraints,
            planningProfile: session.workflow.planningProfile,
        });
        if (!validation.valid) {
            const prompt = `${buildPlanningPrompt(session.task, plan.constraints, session.workflow.planningProfile, validation.diagnostics)}\n\nPlan validation failed:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`;
            session.workflow.phase = "planning";
            session.workflow.planningPrompt = prompt;
            return this.present({ ...this.planningResult(session, prompt), planDiagnostics: validation.diagnostics });
        }
        const assessment = assessPlanChange(session.workflow.plan, plan);
        const version = (session.workflow.planVersion ?? 0) + 1;
        session.workflow.plan = structuredClone(plan);
        session.workflow.planVersion = version;
        session.workflow.pendingPlanChange = null;
        session.workflow.queuedPlanChange = null;
        session.workflow.revisions.push({
            version, baseVersion, reason, changeSummary, evidenceReferences,
            submittedAt: new Date().toISOString(), effectiveRound: session.currentRound,
            plan: structuredClone(plan),
            refinementLinks: deriveRefinementLinks(plan),
            changeImpact: assessment.impact,
            changedPaths: assessment.changedPaths,
        });
        session.workflow.activeStepId = null;
        const requiresApproval = forceApproval ||
            assessment.impact === "contract" || assessment.impact === "risk" ||
            planRequiresApproval(plan) ||
            session.workflow.approvalPolicy === "every_revision";
        session.workflow.approvalId = requiresApproval ? makeApprovalId(version, plan) : null;
        this.recordWorkflowEvent(session, baseVersion === null ? "plan_submitted" : "plan_updated", {
            base_version: baseVersion,
            reason,
            change_summary: changeSummary,
            evidence_references: evidenceReferences,
            validation_warnings: validation.warnings,
            plan,
            effective_round: session.currentRound,
            refinement_links: deriveRefinementLinks(plan),
            change_impact: assessment.impact,
            changed_paths: assessment.changedPaths,
        });
        if (requiresApproval) {
            session.workflow.phase = "awaiting_approval";
            const prompt = [
                "# LoopForge Plan Approval Required", "",
                `Approval ID: ${session.workflow.approvalId}`,
                `Plan version: ${version}`,
                `Risk tags: ${validation.riskTags.join(", ") || "critical plan revision"}`,
                "Present the plan, risks, and expected impact to the user. Call loopforge_plan_approve only after the user decides.",
            ].join("\n");
            session.currentPrompt = prompt;
            session.currentLevel = "planning";
            this.save(session);
            return this.present({ sessionId: session.sessionId, round: session.currentRound, prompt, level: "planning", warnings: validation.warnings, planChangeAssessment: assessment });
        }
        return this.prepareWorkflowRound(session, true).then((result) => this.present({ ...result, planChangeAssessment: assessment }));
    }
    async approvePlan(sessionId, approvalId, planVersion, decision, reason) {
        return this.withRunningSessionMutation(sessionId, async (session) => {
            if (session.workflow.phase !== "awaiting_approval" ||
                session.workflow.approvalId !== approvalId ||
                session.workflow.planVersion !== planVersion) {
                return this.present({ sessionId, round: session.currentRound, prompt: session.currentPrompt ?? null, stopDetail: "Approval ID or planVersion is stale or does not match the pending approval." });
            }
            const record = {
                approvalId, planVersion, decision, reason, decidedAt: new Date().toISOString(),
            };
            session.workflow.approvalHistory.push(record);
            session.workflow.approvalId = null;
            this.recordWorkflowEvent(session, "plan_approval", {
                approval_id: record.approvalId,
                plan_version: record.planVersion,
                decision: record.decision,
                reason: record.reason,
                decided_at: record.decidedAt,
            });
            if (decision === "rejected") {
                session.workflow.phase = "planning";
                const prompt = `${buildPlanningPrompt(session.task, session.workflow.plan?.constraints ?? [])}\n\nThe user rejected plan version ${planVersion}: ${reason}`;
                session.workflow.planningPrompt = prompt;
                return this.planningResult(session, prompt);
            }
            return this.prepareWorkflowRound(session);
        });
    }
    get(sessionId) {
        return this.sessions.get(sessionId);
    }
    getByLoopId(loopId) {
        for (const session of this.sessions.values())
            if (session.loopId === loopId)
                return session;
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
        this.save(session);
        void this.notifyTerminal(session, "cancelled");
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
     * Paused sessions cannot advance until they are resumed. */
    pause(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return { sessionId, round: 0, status: "not_found" };
        if (session.status !== "running") {
            return { sessionId, round: session.currentRound, status: session.status };
        }
        session.status = "paused";
        this.save(session);
        logEvent("session_paused", {
            sessionId,
            loopId: session.loopId,
            round: session.currentRound,
        });
        return { sessionId, round: session.currentRound, status: "paused" };
    }
    restoredPromptResult(session) {
        if (!session.currentPrompt)
            return null;
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: session.currentPrompt,
            level: session.currentLevel ?? "l2",
            roundSuccess: undefined,
            warnings: (session.currentWarnings ?? []),
        };
    }
    /** Reconcile the crash window where feedback committed but session_state
     *  still points at the old prompt. Returns null when no commit is pending. */
    reconcileCommittedRound(session) {
        if (!session.roundSnapshot)
            return null;
        const recovered = new RoundDriver(session.engine, this.backend, this.runtime?.currentBinding?.workspaceRoot).recover(session.roundSnapshot);
        if (!recovered)
            return null;
        const pr = recovered.result;
        session.roundSnapshot = recovered.snapshot;
        // Replay the committed counter with per-rule tracking.
        if (pr.action === "reject" && pr.rejectionCheck) {
            session.consecutiveRejections =
                pr.rejectionCheck === session.lastRejectionCheck
                    ? pr.newConsecutiveRejections
                    : 1;
            session.lastRejectionCheck = pr.rejectionCheck;
        }
        else {
            session.consecutiveRejections = pr.newConsecutiveRejections;
            if (pr.action !== "reject")
                session.lastRejectionCheck = "";
        }
        if (pr.newLastEvaluation)
            session.lastEvaluation = pr.newLastEvaluation;
        if (pr.shouldPushSuccessTrajectory &&
            session.successTrajectory.length < session.currentRound) {
            session.successTrajectory.push(pr.roundSuccess);
        }
        session.currentPrompt = null;
        if (pr.action === "stop" || pr.action === "terminate") {
            const reason = pr.action === "terminate"
                ? "enforcement_terminated"
                : pr.stopReason ?? "stalled";
            session.status = reason === "stalled" ? "stalled" : "stopped";
            session.workflow.phase = "terminal";
            this.save(session);
            void this.notifyTerminal(session, reason);
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                roundId: recovered.snapshot.roundId,
                prompt: null,
                stopReason: reason,
                stopDetail: reason === "completed"
                    ? "The final audit report was accepted with complete success-criterion evidence."
                    : reason === "blocked"
                        ? "Agent cannot proceed under current constraints. The task may need revised constraints or human intervention."
                        : reason === "failed"
                            ? "The accepted report ended the workflow without satisfying completion requirements."
                            : `Loop stopped: ${reason}.`,
                roundSuccess: pr.roundSuccess,
            };
        }
        if (pr.action === "backtrack") {
            // Backtrack committed but prompt not delivered (crash window).
            // Reset round counter to the restore target + 1 so the next
            // resume / unpause compiles from the correct restored state.
            const restoreTarget = pr.backtrackTarget ?? (session.currentRound - 1);
            this.restoreWorkflowToRound(session, restoreTarget);
            session.currentRound = restoreTarget + 1;
            session.consecutiveRejections = 0;
            session.lastRejectionCheck = "";
            session.lastEvaluation = undefined;
            session.currentPrompt = null;
            this.save(session);
            // The caller recompiles normally during resume or unpause.
            return null;
        }
        if (pr.action !== "continue")
            return null;
        const recoveredEval = recovered.snapshot.roundEvaluation ?? pr.newLastEvaluation;
        if (recoveredEval) {
            const workflowOutcome = this.applyAcceptedWorkflowStep(session, recoveredEval);
            if (workflowOutcome === "blocked") {
                this.save(session);
                return this.present({
                    sessionId: session.sessionId,
                    round: session.currentRound - 1,
                    prompt: null,
                    stopReason: "blocked",
                    stopDetail: "One or more plan steps are blocked and no executable step remains.",
                });
            }
            if (workflowOutcome === "advance") {
                return this.prepareWorkflowRoundSync(session, true);
            }
            if (workflowOutcome === "planning") {
                this.save(session);
                return this.planningResult(session, session.workflow.planningPrompt ?? buildPlanningPrompt(session.task, session.workflow.baselineConstraints));
            }
        }
        session.currentRound++;
        const request = buildLoopRequest(session, pr.newLastEvaluation, pr.verificationFlags, { regressionObligations: this.regressionObligations(session) });
        const prepared = new RoundDriver(session.engine, this.backend, this.runtime?.currentBinding?.workspaceRoot).prepareSync(request, session.loopId, session.currentRound, session.executionEpoch);
        if (!prepared) {
            session.status = "stalled";
            this.save(session);
            return {
                sessionId: session.sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "RoundDriver.prepareSync returned null; prompt compilation failed during crash recovery. The session state may be inconsistent.",
            };
        }
        const prompt = prepared.prompt;
        session.evidenceBaseline = prepared.evidenceBaseline;
        session.roundSnapshot = prepared.snapshot;
        session.currentPrompt = prompt;
        session.currentLevel = prepared.level;
        session.currentWarnings = prepared?.warnings ?? [];
        policyMetrics.recordStrategy(session.loopId, session.currentLevel);
        this.save(session);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt,
            level: session.currentLevel,
            roundSuccess: pr.roundSuccess,
            warnings: (session.currentWarnings ?? []),
        };
    }
    /** v1.18: Resume a paused session. Reconstructs from vault state and
     *  compiles the next prompt. Returns null if no paused session exists
     *  for this loopId. */
    async unpause(loopId) {
        const persistedEntry = this.findSessionEntry(loopId);
        if (!persistedEntry) {
            const integrity = this.loopStore?.inspectLoop?.(loopId);
            if (integrity?.code === "session_version_unsupported") {
                throw new Error(`session_version_unsupported: loop ${loopId} uses schema ${integrity.foundSchemaVersion ?? "unknown"}; schema 3 is required. Create a new loop.`);
            }
            return null;
        }
        const lineage = (persistedEntry.loop_lineage ?? {});
        const status = lineage.status ?? "running";
        if (status !== "paused")
            return null;
        const sessionEntry = this.claimSessionEntry(loopId);
        if (!sessionEntry)
            return this.leaseConflictResult(loopId, persistedEntry);
        const session = this.reconstructSession(sessionEntry, true);
        if (!session)
            return null;
        // Set to running so advance() works
        session.status = "running";
        this.sessions.set(session.sessionId, session);
        // Replace the sync-fallback evidence baseline with async evidence
        // so resumed sessions don't silently drop async provider data.
        try {
            const workspaceRoot = this.runtime?.currentBinding?.workspaceRoot;
            const asyncEvidence = await EvidenceCollector.fromPolicy(workspaceRoot).collectAsync({
                loopId: session.loopId,
                phase: "before",
                workspaceRoot,
            });
            if (asyncEvidence.length > 0) {
                session.evidenceBaseline = asyncEvidence;
                if (!session.roundSnapshot?.beforeEvidence?.length) {
                    session.roundSnapshot = prepareRoundTransaction(session.loopId, session.currentRound, asyncEvidence, undefined, session.executionEpoch);
                }
            }
        }
        catch {
            // Async evidence is best-effort; fall back to sync baseline.
        }
        const reconciled = this.reconcileCommittedRound(session);
        if (reconciled)
            return reconciled;
        const restored = this.restoredPromptResult(session);
        if (restored) {
            this.save(session);
            return restored;
        }
        const selected = this.selectWorkflowPreparation(session, false);
        if (selected.kind === "planning") {
            this.save(session);
            return this.planningResult(session, selected.prompt);
        }
        if (selected.kind === "blocked")
            return selected.result;
        const prepared = await new RoundDriver(session.engine, this.backend, this.runtime?.currentBinding?.workspaceRoot).prepare(selected.request, session.loopId, session.currentRound, session.executionEpoch);
        if (!prepared) {
            session.status = "stopped";
            this.save(session);
            void this.notifyTerminal(session, "stalled");
            return { sessionId: session.sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", stopDetail: "RoundDriver.prepare returned null during unpause; the compiler could not produce a prompt." };
        }
        const prompt = prepared.prompt;
        const level = prepared.level;
        session.evidenceBaseline = prepared.evidenceBaseline;
        session.roundSnapshot = prepared.snapshot;
        session.currentPrompt = prompt;
        session.currentLevel = level;
        session.currentWarnings = prepared?.warnings ?? [];
        policyMetrics.recordStrategy(session.loopId, level);
        this.save(session);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt,
            level,
            roundSuccess: undefined,
            warnings: [],
        };
    }
    /** Persist session state to vault for cross-process recovery.
     *  The filtered vault and replacement entry are written once under the
     *  backend lock, so recovery never observes the old two-write gap. */
    save(session) {
        if (!this.sessionStore)
            return;
        const leaseActive = session.status === "running";
        const sessionEntry = {
            task_id: `loop:${session.loopId}:session`,
            task_type: "session_state",
            timestamp: new Date().toISOString(),
            loop_id: session.loopId,
            task: session.task,
            loop_lineage: {
                session_schema_version: 3,
                session_id: session.sessionId,
                current_round: session.currentRound,
                execution_epoch: session.executionEpoch,
                max_rounds: session.maxRounds,
                success_trajectory: session.successTrajectory,
                status: session.status,
                created_at: session.createdAt,
                // v1.13: Enforcement gate state
                consecutive_rejections: session.consecutiveRejections,
                last_rejection_check: session.lastRejectionCheck,
                // v2.13: Backtrack skipped files for workspace restore check
                backtrack_skipped_files: session.backtrackSkippedFiles,
                // v1.19: durable round transaction state
                round_snapshot: session.roundSnapshot ?? null,
                last_evaluation: session.lastEvaluation ?? null,
                current_prompt: session.currentPrompt ?? null,
                current_level: session.currentLevel ?? "",
                workflow: session.workflow,
                workspace_binding: this.runtime?.currentBinding ?? null,
                // v1.20: cross-process single-owner lease
                lease_owner: leaseActive ? this.ownerId : "",
                lease_expires_at: leaseActive ? Date.now() + this.leaseMs : 0,
            },
        };
        this.sessionStore.save(sessionEntry, {
            expectedLeaseOwner: this.ownerId,
        });
        const graphSummary = this.backend
            ? summarizeGovernanceGraph(new ReplayBackend(this.backend).graph(session.loopId))
            : undefined;
        writeWorkflowStateFile(session.loopId, session.workflow, this.runtime?.currentBinding?.workspaceRoot, graphSummary, session ? regressionSummary(this.regressionObligations(session)) : undefined);
    }
    /** Reconstruct a McpSession from a vault session_state entry.
     *  Returns null if the entry is not "running" status.
     *  Shared by resume() and autoResumeAll(). */
    reconstructSession(entry, allowPaused = false, allowTerminalGate = false) {
        const lineage = (entry.loop_lineage ?? {});
        if (lineage.session_schema_version !== 3)
            throw new Error("session_version_unsupported");
        const status = lineage.status ?? "running";
        if (status !== "running" && !(allowPaused && status === "paused") &&
            !(allowTerminalGate && status === "stopped")) {
            return null;
        }
        const loopId = entry.loop_id;
        const currentRound = lineage.current_round ?? 1;
        const successTrajectory = Array.isArray(lineage.success_trajectory)
            ? lineage.success_trajectory.filter((item) => typeof item === "boolean") : [];
        const task = entry.task ?? "";
        const maxRounds = lineage.max_rounds ?? getPolicy().engine.max_rounds;
        const roundSnapshot = parseRoundTransactionSnapshot(lineage.round_snapshot);
        const fallbackEvidence = EvidenceCollector.fromProviderNames(getPolicy().evidence.providers).collect();
        const lastEvaluation = readNormalizedEvaluation(lineage.last_evaluation);
        const engine = new LoopForgeEngine(this.backend);
        return {
            sessionId: typeof lineage.session_id === "string" && lineage.session_id
                ? lineage.session_id
                : randomUUID(),
            loopId, task, engine,
            currentRound, maxRounds, successTrajectory,
            executionEpoch: typeof lineage.execution_epoch === "number" && Number.isInteger(lineage.execution_epoch)
                ? Math.max(0, lineage.execution_epoch) : 0,
            status: status,
            createdAt: lineage.created_at ?? Date.now(),
            consecutiveRejections: lineage.consecutive_rejections ?? 0,
            lastRejectionCheck: typeof lineage.last_rejection_check === "string"
                ? lineage.last_rejection_check
                : "",
            backtrackSkippedFiles: lineage.backtrack_skipped_files ?? [],
            evidenceBaseline: roundSnapshot?.beforeEvidence ?? fallbackEvidence,
            roundSnapshot: roundSnapshot ?? prepareRoundTransaction(loopId, currentRound, fallbackEvidence, undefined, typeof lineage.execution_epoch === "number" && Number.isInteger(lineage.execution_epoch)
                ? Math.max(0, lineage.execution_epoch) : 0),
            lastEvaluation,
            currentPrompt: typeof lineage.current_prompt === "string"
                ? lineage.current_prompt
                : null,
            currentLevel: typeof lineage.current_level === "string"
                ? lineage.current_level
                : undefined,
            workflow: readWorkflowState(lineage.workflow),
        };
    }
    /** Resume a loop from vault state.
     *  Reconstructs the session and compiles the prompt for the next round.
     *  Returns null if no session_state entry exists for this loopId. */
    resumeWithWorkspace(loopId, workspaceRoot, storeDir, gateResolution) {
        if (!this.runtime || this.runtime.isBound) {
            if (workspaceRoot || storeDir)
                this.bindWorkspace(workspaceRoot, storeDir);
            if (gateResolution)
                return this.resolveExternalGate(loopId, gateResolution);
            const result = this.resume(loopId);
            if (!result && this.runtime?.currentBinding) {
                const binding = this.runtime.currentBinding;
                const matches = this.runtime.locator.candidates(binding.workspaceId).flatMap((item) => {
                    if (item.storeId === binding.storeId)
                        return [];
                    try {
                        return new FileLoopStore(item.storeRoot).readSession(loopId) ? [{ storeRoot: item.storeRoot, loopId, workspaceId: item.workspaceId }] : [];
                    }
                    catch {
                        return [];
                    }
                });
                if (matches.length) {
                    const diagnostic = this.runtime.diagnostic(matches.length > 1 ? "ambiguous_loop" : "session_not_found", ["The MCP process is already bound and cannot switch Store."], matches);
                    if (matches.length === 1) {
                        const args = ["mcp", "--workspace", binding.workspaceRoot, "--store-dir", matches[0].storeRoot];
                        diagnostic.recommendation = { action: "restart_mcp", command: { executable: "loopforge", args, display: `loopforge ${args.join(" ")}` } };
                    }
                    throw new Error(JSON.stringify(diagnostic));
                }
            }
            return result;
        }
        if (!workspaceRoot)
            throw new Error("workspace_not_bound: loopforge_resume requires workspaceRoot");
        const resolved = this.runtime.resolve(workspaceRoot, storeDir);
        if (!storeDir) {
            resolved.storeRoot = resolveStoreRoot(resolved.workspace.root, getPolicy(resolve(resolved.workspace.root, "loop_policy.json")).backend.root_dir);
        }
        const candidate = new FileLoopStore(resolved.storeRoot);
        const candidateState = new VaultSessionStateStore(candidate);
        const integrity = candidate.inspectLoop(loopId);
        if (integrity.code === "session_version_unsupported") {
            const diagnostic = this.runtime.diagnostic("session_version_unsupported", [
                `Loop ${loopId} uses store schema ${integrity.foundSchemaVersion ?? "unknown"}; this release requires schema 3.`,
                "Pre-release sessions are intentionally not migrated. Create a new loop to continue.",
            ]);
            diagnostic.matches.push({ storeRoot: resolved.storeRoot, loopId, workspaceId: resolved.workspace.id });
            diagnostic.recommendation = { action: "start_new_loop" };
            throw new Error(JSON.stringify(diagnostic));
        }
        if (integrity.code === "session_corrupt" || integrity.code === "store_incomplete" || integrity.code === "store_unreadable") {
            const diagnostic = this.runtime.diagnostic(integrity.code, [
                `Missing rounds: ${integrity.missingRounds.join(", ") || "none"}`,
                `Corrupt rounds: ${integrity.corruptRounds.join(", ") || "none"}`,
            ]);
            diagnostic.searchedStores.push({ storeRoot: resolved.storeRoot, storeId: workspaceStoreId(resolved.storeRoot), exists: true });
            diagnostic.recommendation = { action: integrity.code === "session_corrupt" ? "restore_json" : "inspect_store" };
            throw new Error(JSON.stringify(diagnostic));
        }
        const entry = candidateState.load(loopId);
        if (!entry) {
            const locations = this.runtime.locator.candidates(resolved.workspace.id);
            const matches = locations.flatMap((item) => {
                try {
                    const store = new FileLoopStore(item.storeRoot);
                    return store.readSession(loopId) ? [{ storeRoot: item.storeRoot, loopId, workspaceId: item.workspaceId }] : [];
                }
                catch {
                    return [];
                }
            });
            const code = matches.length > 1 ? "ambiguous_loop" : "session_not_found";
            const markdown = resolve(resolved.workspace.root, getPolicy().state_file.directory, `${loopId}-state.md`);
            const orphan = existsSync(markdown);
            const detail = this.runtime.diagnostic(code, [
                `No saved session found in ${resolved.storeRoot}`,
                ...locations.map((item) => `Known store: ${item.storeRoot}`),
            ], matches);
            detail.searchedStores.push({ storeRoot: resolved.storeRoot, storeId: workspaceStoreId(resolved.storeRoot), exists: true });
            detail.searchedStores.push(...locations.map((item) => ({ storeRoot: item.storeRoot, storeId: item.storeId, exists: existsSync(item.storeRoot), stale: !existsSync(item.storeRoot) })));
            if (orphan) {
                detail.code = "orphan_markdown";
                detail.orphanMarkdownPaths = [markdown];
                detail.recommendation = { action: "restore_json" };
                detail.warnings.push("Markdown is a derived view and cannot be used to reconstruct typed session truth.");
            }
            if (!orphan && matches.length === 1) {
                detail.recommendation = { action: "retry_resume", toolCall: { name: "loopforge_resume", arguments: { loopId, workspaceRoot: resolved.workspace.root, storeDir: matches[0].storeRoot } } };
            }
            throw new Error(JSON.stringify(detail));
        }
        const storedBinding = this.sessionBinding(entry);
        if (storedBinding && storedBinding.workspaceId !== resolved.workspace.id) {
            throw new Error(JSON.stringify(this.runtime.diagnostic("workspace_mismatch", [
                `Session belongs to workspace ${storedBinding.workspaceRoot}`,
            ], [{ storeRoot: resolved.storeRoot, loopId, workspaceId: storedBinding.workspaceId }])));
        }
        if (storedBinding && storedBinding.workspaceFingerprint !== resolved.workspace.fingerprint) {
            this.runtime.warn("Workspace fingerprint changed since the session was last saved; verify repository identity before continuing.");
        }
        if (gateResolution) {
            const problem = this.gateResolutionProblem(entry, gateResolution);
            if (problem)
                throw new Error(`invalid_gate_resolution: ${problem}`);
        }
        const claimed = candidateState.acquireLease?.(loopId, this.ownerId, this.leaseMs);
        if (!claimed)
            return this.leaseConflictResult(loopId, entry);
        // Commit process binding only after the session exists and its lease is held.
        this.bindWorkspace(workspaceRoot, storeDir);
        if (storedBinding)
            this.runtime.recordRelocation(storedBinding.storeRoot);
        if (gateResolution)
            return this.resolveExternalGate(loopId, gateResolution);
        return this.resume(loopId);
    }
    gateResolutionProblem(entry, resolution) {
        if (!Number.isInteger(resolution.planVersion) || resolution.planVersion < 1)
            return "planVersion must be a positive integer";
        if (!resolution.stepId.trim())
            return "stepId is required";
        if (!resolution.summary.trim())
            return "summary is required";
        if (resolution.evidenceReferences.length === 0 || resolution.evidenceReferences.some((item) => !item.trim())) {
            return "evidenceReferences must contain at least one non-empty reference";
        }
        const lineage = (entry.loop_lineage ?? {});
        if (lineage.status !== "stopped")
            return "only a stopped external-gate session can be resumed this way";
        const workflow = readWorkflowState(lineage.workflow);
        const gate = workflow.blockingGate;
        if (workflow.phase !== "terminal" || !gate)
            return "session is not blocked on an external gate";
        if (workflow.planVersion !== resolution.planVersion || gate.planVersion !== resolution.planVersion) {
            return `planVersion mismatch: expected ${gate.planVersion}`;
        }
        if (gate.stepId !== resolution.stepId)
            return `stepId mismatch: expected ${gate.stepId}`;
        const step = workflow.plan?.steps.find((candidate) => candidate.id === gate.stepId);
        if (!step || step.kind !== "external_gate" || step.status !== "blocked") {
            return "persisted external gate state is inconsistent";
        }
        return null;
    }
    resolveExternalGate(loopId, resolution) {
        const entry = this.findSessionEntry(loopId);
        if (!entry)
            return null;
        const problem = this.gateResolutionProblem(entry, resolution);
        if (problem)
            throw new Error(`invalid_gate_resolution: ${problem}`);
        const claimed = this.claimSessionEntry(loopId);
        if (!claimed)
            return this.leaseConflictResult(loopId, entry);
        const session = this.reconstructSession(claimed, false, true);
        if (!session)
            return null;
        const gate = session.workflow.blockingGate;
        const step = session.workflow.plan.steps.find((candidate) => candidate.id === gate.stepId);
        step.status = "done";
        session.status = "running";
        session.workflow.phase = "executing";
        session.workflow.activeStepId = null;
        session.workflow.blockingGate = null;
        session.currentPrompt = null;
        session.roundSnapshot = undefined;
        this.sessions.set(session.sessionId, session);
        this.recordWorkflowEvent(session, "external_gate_resolved", {
            plan_version: resolution.planVersion,
            step_id: resolution.stepId,
            summary: resolution.summary,
            evidence_references: resolution.evidenceReferences,
        });
        this.save(session);
        return this.prepareWorkflowRoundSync(session);
    }
    resume(loopId) {
        if (this.runtime && !this.runtime.isBound) {
            throw new Error("workspace_not_bound: loopforge_resume requires workspaceRoot on an unbound MCP process");
        }
        const integrity = this.loopStore?.inspectLoop?.(loopId);
        if (integrity?.code === "session_version_unsupported") {
            throw new Error(`session_version_unsupported: loop ${loopId} uses schema ${integrity.foundSchemaVersion ?? "unknown"}; ` +
                "schema 3 is required. Create a new loop.");
        }
        const persistedEntry = this.findSessionEntry(loopId);
        if (!persistedEntry)
            return null;
        const persistedBinding = this.sessionBinding(persistedEntry);
        if (this.runtime && persistedBinding && !this.runtime.assertCompatible(persistedBinding)) {
            return this.present({ sessionId: "", round: 0, prompt: null, stopReason: "workspace_mismatch", stopDetail: `Session belongs to ${persistedBinding.workspaceRoot}` });
        }
        const persistedLineage = (persistedEntry.loop_lineage ?? {});
        const persistedStatus = persistedLineage.status ?? "running";
        const sessionEntry = persistedStatus === "running"
            ? this.claimSessionEntry(loopId)
            : persistedEntry;
        if (!sessionEntry)
            return this.leaseConflictResult(loopId, persistedEntry);
        const session = this.reconstructSession(sessionEntry);
        if (!session) {
            // Return the persisted stopped or stalled status.
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
        // Persist workspace relocation metadata without touching round history.
        const activeBinding = this.runtime?.currentBinding;
        if (activeBinding && (!persistedBinding || persistedBinding.storeRoot !== activeBinding.storeRoot || persistedBinding.workspaceFingerprint !== activeBinding.workspaceFingerprint)) {
            this.save(session);
        }
        const reconciled = this.reconcileCommittedRound(session);
        if (reconciled)
            return reconciled;
        const restored = this.restoredPromptResult(session);
        if (restored)
            return restored;
        // A valid session without a stored prompt is recompiled once and persisted.
        const request = buildLoopRequest(session, undefined, undefined, { regressionObligations: this.regressionObligations(session) });
        const prepared = new RoundDriver(session.engine, this.backend, this.runtime?.currentBinding?.workspaceRoot).prepareSync(request, session.loopId, session.currentRound, session.executionEpoch);
        const prompt = prepared?.prompt ?? null;
        session.evidenceBaseline = prepared?.evidenceBaseline ?? [];
        session.roundSnapshot = prepared?.snapshot ?? prepareRoundTransaction(session.loopId, session.currentRound, [], undefined, session.executionEpoch);
        session.currentPrompt = prompt;
        session.currentLevel = prepared?.level ?? "l2";
        session.currentWarnings = prepared?.warnings ?? [];
        policyMetrics.recordStrategy(session.loopId, session.currentLevel);
        this.save(session);
        return {
            sessionId: session.sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt,
            level: session.currentLevel,
            roundSuccess: false,
            warnings: (session.currentWarnings ?? []),
        };
    }
    /** Auto-resume all "running" sessions from vault on server startup.
     *  Scans vault for session_state entries, reconstructs each as an in-memory
     * McpSession without compiling; the next loopforge_next call does that.
     *  Returns the number of sessions resumed. */
    autoResumeAll() {
        if (this.runtime && !this.runtime.isBound)
            return 0;
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
            if (this.runtime && !this.runtime.assertCompatible(lineage.workspace_binding))
                continue;
            const status = lineage.status ?? "running";
            if (status !== "running" && status !== "paused")
                continue;
            const claimedEntry = this.claimSessionEntry(lid);
            if (!claimedEntry)
                continue;
            const session = this.reconstructSession(claimedEntry, true);
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
                phase: s.workflow.phase,
                planVersion: s.workflow.planVersion,
                activeStepId: s.workflow.activeStepId,
                progress: computeWorkflowProgress(s.workflow),
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
                if (this.runtime && !this.runtime.assertCompatible(lineage.workspace_binding))
                    continue;
                result.push({
                    sessionId: "",
                    loopId: lid,
                    round: lineage.current_round ?? 1,
                    status: (lineage.status || "running"),
                    phase: readWorkflowState(lineage.workflow).phase,
                    planVersion: readWorkflowState(lineage.workflow).planVersion,
                    activeStepId: readWorkflowState(lineage.workflow).activeStepId,
                    progress: computeWorkflowProgress(readWorkflowState(lineage.workflow)),
                });
            }
        }
        return result;
    }
    listIncompatibleSessions() {
        if (!this.loopStore)
            return [];
        return this.loopStore.listLoopIds().flatMap((loopId) => {
            const integrity = this.loopStore.inspectLoop?.(loopId);
            return integrity?.code === "session_version_unsupported"
                ? [{ loopId, foundSchemaVersion: integrity.foundSchemaVersion, requiredSchemaVersion: 3 }]
                : [];
        });
    }
    /** Derive workflow health from the approved plan and normalized evidence. */
    getHealth(loopId) {
        const inMemory = [...this.sessions.values()].find((session) => session.loopId === loopId);
        const persisted = inMemory ? null : this.findSessionEntry(loopId);
        if (!inMemory && !persisted)
            return null;
        const workflow = inMemory
            ? inMemory.workflow
            : readWorkflowState(persisted.loop_lineage?.workflow);
        const lastEvaluation = inMemory
            ? inMemory.lastEvaluation
            : readNormalizedEvaluation(persisted.loop_lineage?.last_evaluation);
        const activeStepExists = workflow.activeStepId === null ||
            workflow.activeStepId === "audit-final" ||
            Boolean(workflow.plan?.steps.some((step) => step.id === workflow.activeStepId));
        const violations = lastEvaluation?.report.violations ?? [];
        const contradictions = lastEvaluation?.evidenceEnvelope.contradictions ?? [];
        const activeHistory = [...workflow.advancementHistory].reverse();
        const activeStepId = workflow.activeStepId;
        let consecutiveFlatRounds = 0;
        for (const item of activeHistory) {
            if (item.stepId !== activeStepId || item.material)
                break;
            consecutiveFlatRounds++;
        }
        const progress = computeWorkflowProgress(workflow);
        const graph = this.backend ? new ReplayBackend(this.backend).graph(loopId) : null;
        return {
            loopId,
            workflow_alignment: {
                status: activeStepExists ? "aligned" : "misaligned",
                phase: workflow.phase,
                planVersion: workflow.planVersion,
                activeStepId,
            },
            constraint_integrity: {
                status: violations.length ? "violated" : "intact",
                violations,
            },
            evidence_integrity: {
                status: contradictions.length ? "contradicted" : lastEvaluation ? "available" : "unavailable",
                contradictions,
                filesConfidence: lastEvaluation?.evidenceEnvelope.files.confidence ?? "unavailable",
                checksConfidence: lastEvaluation?.evidenceEnvelope.checks.confidence ?? "unavailable",
            },
            stall_risk: {
                level: consecutiveFlatRounds >= 2 ? "high" : consecutiveFlatRounds === 1 ? "medium" : "low",
                consecutiveFlatRounds,
            },
            readiness: progress.readiness,
            progress,
            graphSummary: graph ? summarizeGovernanceGraph(graph) : undefined,
            graphDiagnostics: graph?.diagnostics ?? [],
            policy_metrics: policyMetrics.snapshot(loopId),
        };
    }
    /** v3 P1 compact-report entry point. Validation and round fencing run inside
     * the per-session queue so concurrent/stale Agent results cannot cross steps. */
    async advanceReport(sessionId, roundId, report) {
        return this.withSessionQueue(sessionId, async () => {
            const session = this.sessions.get(sessionId);
            if (!session) {
                return this.present({ sessionId, round: 0, prompt: null, stopReason: "session_not_found" });
            }
            if (session.status !== "running") {
                return this.present({
                    sessionId,
                    round: session.currentRound,
                    prompt: null,
                    stopReason: session.status,
                    stopDetail: `Session is ${session.status}; resume it before submitting a report.`,
                });
            }
            if (!this.renewSessionLease(session.loopId)) {
                return this.present(this.leaseConflictResult(session.loopId, this.findSessionEntry(session.loopId)), sessionId);
            }
            const expectedRoundId = session.roundSnapshot?.roundId;
            if (!expectedRoundId || roundId !== expectedRoundId) {
                return this.present({
                    sessionId,
                    round: session.currentRound,
                    roundId: expectedRoundId,
                    prompt: session.currentPrompt ?? null,
                    enforcementAction: "reject",
                    enforcementReason: `stale roundId: expected ${expectedRoundId ?? "none"}, received ${roundId}`,
                });
            }
            if (session.workflow.phase === "planning" || session.workflow.phase === "awaiting_approval") {
                return this.present({
                    sessionId,
                    round: session.currentRound,
                    roundId: expectedRoundId,
                    prompt: session.currentPrompt ?? session.workflow.planningPrompt,
                    enforcementAction: "reject",
                    enforcementReason: `round reports are not accepted during ${session.workflow.phase}`,
                });
            }
            const activeStep = session.workflow.plan?.steps.find((step) => step.id === session.workflow.activeStepId) ?? null;
            const obligations = this.regressionObligations(session);
            const obligationTargets = obligations.map((item) => ({
                id: item.id,
                text: `${item.checkName} must remain passing (${item.claimId})`,
                kind: "regression_obligation",
            }));
            const errors = validateRoundReport(report, session.workflow.phase, activeStep, session.workflow.plan);
            if (errors.length > 0) {
                return this.present({
                    sessionId,
                    round: session.currentRound,
                    roundId: expectedRoundId,
                    prompt: session.currentPrompt ?? null,
                    enforcementAction: "reject",
                    enforcementReason: errors.join("; "),
                });
            }
            const requiredClaimIds = session.workflow.phase === "auditing"
                ? [...auditClaimTargets(session.workflow.plan).map((item) => item.id), ...obligations.map((item) => item.id)]
                : activeStep ? [...stepClaimTargets(activeStep).map((item) => item.id), ...obligations.map((item) => item.id)] : [];
            const normalized = normalizeRoundReport(report, session.workflow.phase, session.workflow.activeStepId, requiredClaimIds);
            normalized.requiredRegressionObligationIds = obligations.map((item) => item.id);
            // Audit reports from a provider may prove the same checks as the source
            // steps without repeating every derived ro-* identifier. Materialize the
            // missing claim server-side with its exact check reference. Runtime
            // normalization must still verify that check; claimed-only checks remain
            // insufficient for a final audit.
            if (session.workflow.phase === "auditing" && report.status === "completed" && report.evidence) {
                const existing = new Set(normalized.evidenceEnvelope.claims.map((claim) => claim.targetId));
                for (const obligation of obligations) {
                    if (existing.has(obligation.id))
                        continue;
                    normalized.evidenceEnvelope.claims.push({ targetId: obligation.id, evidenceRefs: [`check:${obligation.checkName}`] });
                }
            }
            try {
                return await this.advanceEvaluationUnlocked(sessionId, normalized);
            }
            catch (error) {
                if (error instanceof SessionLeaseConflictError) {
                    return this.leaseConflictResult(error.loopId, this.findSessionEntry(error.loopId));
                }
                throw error;
            }
        });
    }
    // advanceUnlocked pipeline
    //
    // The method is split into focused private helpers so each phase of the
    // round-boundary decision loop is independently readable and testable.
    //
    // Pipeline: validate -> normalize -> transact -> route disposition
    //           -> compile the next round or return a terminal result.
    /** Execute a validated normalized report through the transaction and gates. */
    async executeRoundTransaction(session, evaluation) {
        const snapshot = session.roundSnapshot ?? prepareRoundTransaction(session.loopId, session.currentRound, session.evidenceBaseline ?? [], undefined, session.executionEpoch);
        const completed = await new RoundDriver(session.engine, this.backend, this.runtime?.currentBinding?.workspaceRoot).complete({
            snapshot,
            loopId: session.loopId,
            task: session.task,
            maxRounds: session.maxRounds,
            evaluation,
            previousEvaluation: session.lastEvaluation,
            consecutiveRejections: session.consecutiveRejections,
            successTrajectory: session.successTrajectory,
            backtrackSkippedFiles: session.backtrackSkippedFiles,
        });
        const outcome = completed.outcome;
        const actualEvidence = completed.actualEvidence;
        session.roundSnapshot = outcome.snapshot;
        const pr = outcome.result;
        policyMetrics.recordStrategyOutcome(session.loopId, session.currentLevel, pr, outcome.replayed);
        // Per-rule rejection tracking: same-check rejections accumulate;
        // a different rejection reason resets the counter.
        if (pr.action === "reject" && pr.rejectionCheck) {
            session.consecutiveRejections =
                pr.rejectionCheck === session.lastRejectionCheck
                    ? pr.newConsecutiveRejections
                    : 1;
            session.lastRejectionCheck = pr.rejectionCheck;
        }
        else {
            session.consecutiveRejections = pr.newConsecutiveRejections;
            if (pr.action !== "reject")
                session.lastRejectionCheck = "";
        }
        if (pr.newLastEvaluation)
            session.lastEvaluation = pr.newLastEvaluation;
        if (pr.shouldPushSuccessTrajectory) {
            session.successTrajectory.push(pr.roundSuccess);
        }
        return { pr, verificationFlags: pr.verificationFlags, actualEvidence };
    }
    recordAcceptedAdvancement(session, evaluation) {
        if (!evaluation.materialAdvancement)
            return;
        session.workflow.advancementHistory.push({
            round: session.currentRound,
            stepId: session.workflow.activeStepId,
            planVersion: session.workflow.planVersion,
            material: evaluation.materialAdvancement.material,
            signals: evaluation.materialAdvancement.signals,
        });
        if (session.workflow.advancementHistory.length > 100) {
            session.workflow.advancementHistory = session.workflow.advancementHistory.slice(-100);
        }
    }
    /** Build a rejection result: compile a retry prompt, persist, return.
     *  MUTATES: session.roundSnapshot, session.currentPrompt, session.currentLevel */
    async buildRejectionResult(sessionId, session, pr, verificationFlags) {
        this.recordWorkflowEvent(session, "round_rejected", {
            step_id: session.workflow.activeStepId,
            round_id: session.roundSnapshot.roundId,
            attempt: session.roundSnapshot.attempt,
            reason: pr.enforcementReason ?? "round rejected",
        });
        const retryRequest = buildLoopRequest(session, undefined, verificationFlags, { regressionObligations: this.regressionObligations(session) });
        const preparedRetry = await new RoundDriver(session.engine, this.backend, this.runtime?.currentBinding?.workspaceRoot).prepareRetry(retryRequest, session.roundSnapshot, pr.rejectionPrompt ?? "", session.consecutiveRejections);
        if (!preparedRetry) {
            session.status = "stalled";
            session.currentPrompt = null;
            this.save(session);
            return {
                sessionId,
                round: session.currentRound,
                roundId: session.roundSnapshot?.roundId,
                prompt: null,
                stopReason: "stalled",
                stopDetail: "RoundDriver.prepareRetry returned null; the retry prompt could not be compiled.",
            };
        }
        session.roundSnapshot = preparedRetry.snapshot;
        session.currentPrompt = preparedRetry.prompt;
        session.currentLevel = preparedRetry.level;
        session.currentWarnings = preparedRetry.warnings ?? [];
        this.save(session);
        return {
            sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt: preparedRetry.prompt,
            level: preparedRetry.level,
            enforcementAction: "reject",
            enforcementReason: pr.enforcementReason,
        };
    }
    /** Build a backtrack result by restoring the last clean round.
     *  Resets the round counter to the restore target + 1, merges preserved
     *  discoveries, compiles from the restored state, and injects the
     *  backtrack prompt at the top.
     *  MUTATES: session.currentRound, session.roundSnapshot,
     *           session.currentPrompt, session.currentLevel,
     *           session.consecutiveRejections, session.lastEvaluation */
    async buildBacktrackResult(sessionId, session, pr) {
        const restoreTarget = pr.backtrackTarget ?? (session.currentRound - 1);
        const newRound = restoreTarget + 1;
        const fromRound = session.currentRound;
        this.restoreWorkflowToRound(session, restoreTarget);
        logEvent("session_backtrack", {
            sessionId,
            loopId: session.loopId,
            fromRound,
            toRound: newRound,
            triggerRule: pr.backtrackTriggerRule ?? "",
            skippedDiscoveries: (pr.backtrackSkippedDiscoveries ?? []).length,
        });
        // A new execution epoch prevents the restored logical round from replaying
        // a commit made by the abandoned branch.
        session.currentRound = newRound;
        session.executionEpoch++;
        this.recordWorkflowEvent(session, "backtrack_restored", {
            from_round: fromRound,
            to_round: newRound,
            execution_epoch: session.executionEpoch,
            trigger_rule: pr.backtrackTriggerRule ?? "",
        });
        session.consecutiveRejections = 0;
        session.lastRejectionCheck = "";
        session.backtrackSkippedFiles = pr.backtrackSkippedFiles ?? [];
        session.lastEvaluation = undefined; // force L2 recompile from vault state
        session.currentPrompt = null;
        const preservedDiscoveries = pr.backtrackSkippedDiscoveries ?? [];
        const prepared = await this.prepareWorkflowRound(session, true, {
            backtrackDiagnosis: pr.backtrackPrompt ?? pr.enforcementReason,
            preservedDiscoveries,
            verificationFlags: pr.verificationFlags,
        });
        return {
            ...prepared,
            enforcementAction: "backtrack",
            enforcementReason: pr.enforcementReason,
        };
    }
    /** Build a termination result: persist stopped status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt */
    buildTerminationResult(sessionId, session, pr) {
        session.workflow.phase = "terminal";
        session.status = "stopped";
        session.currentPrompt = null;
        this.save(session);
        void this.notifyTerminal(session, "enforcement_terminated");
        logEvent("session_end", {
            sessionId, loopId: session.loopId,
            stopReason: "enforcement_terminated", round: session.currentRound,
        });
        return {
            sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: null,
            stopReason: "enforcement_terminated",
            stopDetail: pr.enforcementReason ?? "The enforcement gate terminated the loop.",
            enforcementAction: "terminate",
            enforcementReason: pr.enforcementReason,
        };
    }
    /** Build a stop result: persist stopped/stalled status, notify sinks.
     *  MUTATES: session.status, session.currentPrompt */
    buildStopResult(sessionId, session, pr) {
        const reason = pr.stopReason ?? "stalled";
        session.status = reason === "stalled" ? "stalled" : "stopped";
        session.workflow.phase = "terminal";
        session.currentPrompt = null;
        this.save(session);
        void this.notifyTerminal(session, reason);
        logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: reason, round: session.currentRound });
        return {
            sessionId, round: session.currentRound,
            roundId: session.roundSnapshot?.roundId,
            prompt: null, stopReason: reason,
            stopDetail: pr.stopReason === "circuit_breaker"
                ? `${pr.roundSuccess ? "No" : "All"} recent rounds failed, triggering the circuit breaker.`
                : pr.stopReason === "max_rounds"
                    ? "The configured maximum number of rounds has been reached."
                    : `Loop stopped: ${reason}.`,
            roundSuccess: pr.roundSuccess,
        };
    }
    /** Compile the next round's prompt and advance the session.
     *  Includes the commit fence (pause/delete race guard) and context provider.
     *  MUTATES: session.currentRound, session.currentPrompt, session.currentLevel,
     *           session.evidenceBaseline, session.roundSnapshot */
    async advanceToNextRound(sessionId, session, evaluation, pr, verificationFlags, actualEvidence) {
        const roundSuccess = pr.roundSuccess;
        session.currentRound++;
        session.currentPrompt = null;
        // v2.13: Clear backtrack skipped files after advancing past the restore round
        session.backtrackSkippedFiles = [];
        // Tier-aware external context injection.
        let externalCtx = "";
        if (this.contextProvider) {
            try {
                externalCtx = (await this.contextProvider({
                    loopId: session.loopId,
                    round: session.currentRound,
                    task: session.task,
                    domain: "",
                    lastEvaluation: evaluation,
                })).trim();
            }
            catch {
                logEvent("context_provider_error", {
                    loopId: session.loopId,
                    round: session.currentRound,
                });
            }
        }
        // Commit fence: pause()/delete() may have run while the context provider
        // was awaited. Do not compile if the session is no longer running.
        if (this.sessions.get(sessionId) !== session || session.status !== "running") {
            return {
                sessionId,
                round: session.currentRound,
                prompt: null,
                stopReason: session.status,
                stopDetail: `Session is no longer running (status: ${session.status}). It was paused or deleted while the context provider was running.`,
                roundSuccess,
            };
        }
        const request = buildLoopRequest(session, evaluation, verificationFlags, { regressionObligations: this.regressionObligations(session) });
        if (externalCtx) {
            request.external_context = externalCtx;
        }
        const prepared = await new RoundDriver(session.engine, this.backend, this.runtime?.currentBinding?.workspaceRoot).prepare(request, session.loopId, session.currentRound, session.executionEpoch);
        const nextPrompt = prepared?.prompt ?? null;
        const nextLevel = prepared?.level ?? "l2";
        const nextBaseline = prepared?.evidenceBaseline ?? actualEvidence;
        session.evidenceBaseline = nextBaseline;
        session.roundSnapshot = prepared?.snapshot ?? prepareRoundTransaction(session.loopId, session.currentRound, nextBaseline, undefined, session.executionEpoch);
        session.currentPrompt = nextPrompt;
        session.currentLevel = nextLevel;
        session.currentWarnings = prepared?.warnings ?? [];
        policyMetrics.recordStrategy(session.loopId, nextLevel);
        this.save(session);
        return {
            sessionId,
            round: session.currentRound,
            roundId: session.roundSnapshot.roundId,
            prompt: nextPrompt,
            level: nextLevel,
            roundSuccess,
            warnings: prepared?.warnings ?? [],
        };
    }
    async advanceEvaluationUnlocked(sessionId, evaluation) {
        // 1. Validate session
        const session = this.sessions.get(sessionId);
        if (!session)
            return { sessionId, round: 0, prompt: null, stopReason: "session_not_found", stopDetail: "No session exists with this ID. It may have expired, been deleted, or never existed." };
        if (session.status !== "running") {
            return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status, stopDetail: `Session is ${session.status}. Use loopforge_resume to restart a paused session, or loopforge_start for a new task.` };
        }
        if (session.workflow.phase === "planning" || session.workflow.phase === "awaiting_approval") {
            return this.present({
                sessionId,
                round: session.currentRound,
                prompt: session.currentPrompt ?? session.workflow.planningPrompt,
                stopDetail: session.workflow.phase === "planning"
                    ? "Submit or refine the structured plan before calling loopforge_next."
                    : "The exact pending plan version requires user approval before execution.",
            });
        }
        // 2. Validate the normalized round report against workflow state
        if (session.workflow.phase === "executing" || session.workflow.phase === "auditing") {
            const expected = session.workflow.activeStepId;
            if (evaluation.activeStepId !== expected) {
                return this.present({
                    sessionId,
                    round: session.currentRound,
                    roundId: session.roundSnapshot?.roundId,
                    prompt: session.currentPrompt ?? null,
                    enforcementAction: "reject",
                    enforcementReason: `active step mismatch: expected ${expected}, received ${evaluation.activeStepId}`,
                });
            }
            if (session.workflow.phase === "auditing") {
                const auditCriteria = session.workflow.plan
                    ? auditClaimTargets(session.workflow.plan).map((item) => item.id) : [];
                const evidenceProblem = completionEvidenceProblem(evaluation, auditCriteria);
                // Regression obligations are checked after runtime evidence is merged
                // by the verification gate. Preflight cannot see provider results yet.
                const roProblem = null;
                if (evidenceProblem || roProblem || (evaluation.report.violations?.length ?? 0) > 0) {
                    return this.present({
                        sessionId,
                        round: session.currentRound,
                        roundId: session.roundSnapshot?.roundId,
                        prompt: session.currentPrompt ?? null,
                        enforcementAction: "reject",
                        enforcementReason: `Final audit is incomplete: ${evidenceProblem ?? roProblem ?? "constraint violations remain"}.`,
                    });
                }
            }
            else {
                if (evaluation.report.status === "completed") {
                    const activeStep = session.workflow.plan?.steps.find((step) => step.id === session.workflow.activeStepId);
                    const completionCriteria = activeStep ? stepClaimTargets(activeStep).map((item) => item.id) : [];
                    const evidenceProblem = completionEvidenceProblem(evaluation, completionCriteria);
                    const roProblem = regressionEvidenceProblem(evaluation, this.regressionObligations(session));
                    if (evidenceProblem || roProblem) {
                        return this.present({
                            sessionId,
                            round: session.currentRound,
                            roundId: session.roundSnapshot?.roundId,
                            prompt: session.currentPrompt ?? null,
                            enforcementAction: "reject",
                            enforcementReason: `Plan step cannot be completed: ${evidenceProblem ?? roProblem}.`,
                        });
                    }
                }
            }
        }
        // 3. Execute round transaction
        const tx = await this.executeRoundTransaction(session, evaluation);
        // 4. Route disposition
        if (tx.pr.action === "reject") {
            return this.buildRejectionResult(sessionId, session, tx.pr, tx.verificationFlags);
        }
        // Backtrack to the last clean round.
        if (tx.pr.action === "backtrack") {
            return this.buildBacktrackResult(sessionId, session, tx.pr);
        }
        if (tx.pr.action !== "terminate") {
            this.recordAcceptedAdvancement(session, evaluation);
        }
        // Accepted rounds advance the before-snapshot baseline. Rejected rounds
        // retain the original baseline so their retry remains zero-commit.
        session.evidenceBaseline = tx.actualEvidence;
        if (tx.pr.action === "terminate") {
            return this.buildTerminationResult(sessionId, session, tx.pr);
        }
        if (tx.pr.action === "stop") {
            if (session.workflow.phase === "auditing" && tx.pr.stopReason === "completed") {
                session.workflow.auditVerifiedCriteria = evaluation.evidenceEnvelope.claims.map((claim) => claim.targetId);
            }
            return this.buildStopResult(sessionId, session, tx.pr);
        }
        const workflowOutcome = this.applyAcceptedWorkflowStep(session, evaluation);
        if (workflowOutcome === "blocked") {
            this.save(session);
            return this.present({ sessionId, round: session.currentRound - 1, prompt: null, stopReason: "blocked", stopDetail: "One or more plan steps are blocked and no executable step remains." });
        }
        if (workflowOutcome === "advance") {
            return this.prepareWorkflowRound(session, true);
        }
        if (workflowOutcome === "planning") {
            this.save(session);
            return this.planningResult(session, session.workflow.planningPrompt ?? buildPlanningPrompt(session.task, session.workflow.baselineConstraints));
        }
        // 5. Compile the next round
        return this.advanceToNextRound(sessionId, session, evaluation, tx.pr, tx.verificationFlags, tx.actualEvidence);
    }
    restoreWorkflowToRound(session, targetRound) {
        if (session.workflow.revisions.length === 0)
            return;
        const revision = [...session.workflow.revisions]
            .filter((candidate) => candidate.effectiveRound <= targetRound)
            .sort((a, b) => b.version - a.version)[0];
        if (!revision)
            return;
        session.workflow.planVersion = revision.version;
        session.workflow.plan = structuredClone(revision.plan);
        const events = this.backend?.queryEntries({ prefix: `loop:${session.loopId}:r` }) ?? [];
        for (const event of events) {
            if (event.task_type !== "workflow_step_result")
                continue;
            const parsed = parseWorkflowEventEntry(event);
            if (!parsed || parsed.eventType !== "step_result" || parsed.round > targetRound)
                continue;
            const stepId = parsed.payload.step_id;
            const step = session.workflow.plan.steps.find((candidate) => candidate.id === stepId);
            if (!step)
                continue;
            step.status = parsed.payload.step_status === "completed" ? "done" : parsed.payload.step_status === "blocked" ? "blocked" : step.status;
        }
        session.workflow.approvalHistory = session.workflow.approvalHistory.filter((approval) => approval.planVersion <= revision.version);
        session.workflow.approvalId = null;
        session.workflow.activeStepId = null;
        session.workflow.phase = "executing";
    }
    /** Write back loop knowledge to long-term memory.
     *  Uses shared base builder from policy.ts. Called when a loop terminates. */
    async notifyTerminal(session, stopReason) {
        if (this.terminalSinks.size === 0)
            return;
        const event = {
            loopId: session.loopId,
            task: session.task,
            success: stopReason === "completed",
            stopReason: stopReason,
            roundsCompleted: session.currentRound,
            successTrajectory: [...session.successTrajectory],
            lastEvaluation: session.lastEvaluation,
        };
        await Promise.allSettled([...this.terminalSinks].map((sink) => Promise.resolve(sink(event))));
    }
    /** Build the read-only replay timeline from the stored backend. */
    replayTimeline(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session)
            return null;
        const replay = new ReplayBackend(this.backend);
        return replay.timeline(session.loopId);
    }
    governanceGraph(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || !this.backend)
            return null;
        return new ReplayBackend(this.backend).graph(session.loopId);
    }
}
//# sourceMappingURL=session.js.map