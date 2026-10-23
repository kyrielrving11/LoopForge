/** LoopForge MCP — Round lifecycle.
 *
 * The round state machine split out of SessionManager: crash recovery,
 * transaction execution, disposition result building, and the advance
 * pipeline. SessionManager owns "who may touch a session" (registry, queue,
 * leases); this class owns "what happens to a session" (state machine,
 * recovery, result building).
 *
 * The lifecycle depends on a narrow registry and explicit stores/providers;
 * session ownership, queues, and leases remain in SessionManager.
 */

import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { LoopForgeEngine } from "../engine.js";
import { deriveGate } from "../cognitive-governance.js";
import {
  Mode,
  makeLoopCompileRequest,
} from "../protocol.js";
import type {
  CheckpointRef,
  ContractItemStatus,
  LoopForgeRequest,
  LoopForgeResponse,
  OperatorAcceptance,
  PromptArtifact,
  RecoveryDirective,
  RecoveryRequest,
  SelfEvaluation,
  SubmissionDiagnostic,
  SubmissionGuidance,
  SubmissionReceipt,
  SubGoal,
  VerificationFlag,
  LoopTerminalEvent,
  LoopTerminalSink,
  RoundVerificationStatus,
  StopReason,
  WorkspaceCheckpointManifest,
} from "../protocol.js";
import { captureEntrypointTrust, EvidenceCollector } from "../evidence-provider.js";
import type { MachineObservation } from "../protocol.js";
import {
  deriveRoundObservationDelta,
  deriveTransactionId,
  makeRoundId,
  parseRoundTransactionSnapshot,
  prepareRoundTransaction,
  rootBranchId,
} from "../round-transaction.js";
import { deriveActiveRoundContract, deriveRoundContractView } from "../round-contract.js";
import { deriveSubGoals } from "../subgoal-state.js";
import { declaresBlocked } from "../round-outcome.js";
import { deriveSubmissionReceipt } from "../submission-receipt.js";
import type { RoundTransactionSnapshot } from "../round-transaction.js";
import { RoundDriver } from "../round-driver.js";
import {
  deriveRecoveryDirective,
  findCheckpointRef,
  validateCheckpointManifest,
} from "../recovery.js";
import {
  executeRestore,
  preflightRestore,
  RestoreFailure,
} from "../workspace-restore.js";
import {
  buildCheckpointRef,
  FileWorkspaceCheckpointStore,
} from "../workspace-checkpoint.js";
import { resolveStateDirectory } from "../policy.js";
import { finalizeStopReason } from "../round-coordinator.js";
import type { RoundProcessResult } from "../round-coordinator.js";
import type { PreparedRound } from "../round-driver.js";
import { getPolicy } from "../policy.js";
import { checkRoundSequence, queryLoopEntries } from "../loop-store.js";
import {
  branchDirectives,
  branchRounds,
  derivationRounds,
  pendingRollbackDirective,
  readOnlyRounds,
  resolveBranch,
} from "../committed-round.js";
import { deriveSubmissionGuidance } from "../submission-guidance.js";
import { latestObjective } from "../loop-compiler.js";
import { activeContractOf } from "./submission-boundary.js";
import type { LoopStore, VaultEntry } from "../loop-store.js";
import { logEvent } from "../observability.js";
import { policyMetrics } from "../policy-metrics.js";
import type { SessionStateStore } from "../storage.js";
import { isRecord, normalizeText } from "../token-utils.js";
import { ProjectionCoverageError } from "../prompt-coverage.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** M3: parse a persisted skipped-file fingerprint map (string → string).
 *  Lenient by design — v3.8.3 reuses it for the entrypoint trust baseline,
 *  where a corrupt or absent entry must degrade to "no baseline for that
 *  file", never fail the round that would carry it. */
function parseFingerprintMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [file, fp] of Object.entries(value)) {
    if (typeof fp === "string") out[file] = fp;
  }
  return out;
}

/** Parse the session's operator-acceptance cursor leniently. A corrupt copy
 *  degrades to the committed root transaction; it never invents criteria. */
function parseOperatorAcceptance(value: unknown): OperatorAcceptance | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.task !== "string" ||
      !Array.isArray(value.success_criteria) ||
      !value.success_criteria.every((item) => typeof item === "string") ||
      !Array.isArray(value.hard_constraints) ||
      !value.hard_constraints.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value as unknown as OperatorAcceptance;
}

export interface McpSession {
  sessionId: string;
  loopId: string;
  task: string;
  engine: LoopForgeEngine;
  currentRound: number;
  maxRounds: number;
  status: "running" | "stopped" | "stalled" | "paused";
  createdAt: number;
  // v1.13: Enforcement gate state
  consecutiveRejections: number;
  /** Which enforcement check triggered the last rejection.
   *  Only same-check rejections accumulate toward the max. */
  lastRejectionCheck: string;
  /** v3.8.3: the trusted round-start fingerprint of every enabled command's
   *  entrypoint files, captured when the CURRENT in-flight round was prepared.
   *
   *  In-flight only: it never enters committed round history. It exists so the
   *  entrypoint check can be absolute (current content vs round-start content)
   *  rather than relative to a git delta that a gitignored entrypoint never
   *  appears in and a re-derived baseline could launder. Absent means the
   *  round runs without that arm — never a lost round. */
  entrypointTrust?: Record<string, string>;
  /** v3.9.7: operator-owned immutable acceptance, carried as a session cursor
   *  so a recovery that clears the held snapshot cannot lose it. The root
   *  committed round-1 transaction remains the authority. */
  operatorAcceptance?: OperatorAcceptance;
  /** Schema-versioned transaction for the prompt currently held by the agent. */
  roundSnapshot?: RoundTransactionSnapshot;
}

export interface McpSessionSummary {
  sessionId: string;
  loopId: string;
  round: number;
  status: "running" | "stopped" | "stalled" | "paused";
}

export interface StartInput {
  task: string;
  loopId?: string;
  maxRounds?: number;
  domain?: string;
  planSource?: string;
  constraints?: string[];
  /** v3.9.4: initial local requirements, each becoming a stable `cr-*` anchor
   *  in the objective. Omit to keep the default criterion. */
  criteria?: string[];
}

/** v3.9.4: a structural defect in the start criteria argument. The MCP
 *  handler maps this to `invalid_argument`; it is never a policy defect. */
export class StartCriteriaError extends Error {
  readonly code = "invalid_argument";
}

/** v3.9.4: normalize initial criteria at the start boundary.
 *
 *  - a non-array / non-string element is a structural defect (throws);
 *  - empty text is dropped with a warning;
 *  - duplicate normalized-exact text keeps the first spelling, with a
 *    warning (the stable id derivation would otherwise produce two entries
 *    with one `cr-*` id);
 *  - over `policy.evolution.max_start_criteria` is dropped from the tail with
 *    a warning;
 *  - an empty result is the caller's signal to keep the default criterion. */
export function normalizeStartCriteria(raw: unknown): {
  criteria: string[];
  warnings: string[];
} {
  if (raw === undefined) return { criteria: [], warnings: [] };
  if (!Array.isArray(raw)) {
    throw new StartCriteriaError("criteria must be an array of non-empty strings");
  }
  const values: string[] = [];
  let empty = 0;
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new StartCriteriaError("criteria entries must be strings");
    }
    const text = entry.trim();
    if (!text) {
      empty++;
      continue;
    }
    values.push(text);
  }
  const warnings: string[] = [];
  if (empty > 0) {
    warnings.push(`start_criteria_empty: dropped ${empty} empty criteria`);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  let duplicates = 0;
  for (const text of values) {
    const key = normalizeText(text);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(text);
  }
  if (duplicates > 0) {
    warnings.push(
      `start_criteria_duplicate: dropped ${duplicates} duplicate criteria`,
    );
  }
  const cap = Math.max(0, getPolicy().evolution.max_start_criteria);
  const criteria = unique.slice(0, cap);
  if (unique.length > criteria.length) {
    warnings.push(
      `start_criteria_capped: kept ${criteria.length} of ${unique.length} ` +
      `(max_start_criteria=${cap})`,
    );
  }
  return { criteria, warnings };
}

export interface AdvanceResult {
  sessionId: string;
  round: number;
  /** Stable logical identity; unchanged when enforcement retries the round. */
  roundId?: string;
  /** v3.9.7: the held transaction attempt. Required for next/checkpoint/
   *  recovery so a stale response can never be applied to a later attempt. */
  transactionId?: string;
  /** v3.9.7: the held transaction's before-image + mid savepoints. */
  checkpoints?: CheckpointRef[];
  /** v3.9.7: explicit fact when the automatic before-image failed. */
  beforeCheckpointError?: { code: string; detail: string };
  prompt: string | null;
  stopReason?: string;
  /** v2.0.1: Human-readable context for why the loop stopped.
   *  Provides facts the agent can use to decide its next action,
   *  without LoopForge prescribing a specific behavior. */
  stopDetail?: string;
  level?: string;
  roundSuccess?: boolean;
  warnings?: string[];
  /** v1.13: Enforcement action for this round. accept/reject/terminate.
   *  When "reject", the prompt contains a rejection notice and the agent
   *  must redo the same round. Round counter does NOT increment. */
  enforcementAction?: "accept" | "reject" | "terminate" | "backtrack" | "recovery";
  /** v3.8: The round-level verification posture — `trusted` when everything
   *  claimed this round is machine-backed, `insufficient` when claims are
   *  unbacked but nothing is denied, `contradicted` when a machine fact
   *  denies a claim. Never a verdict about the agent's work quality. */
  verificationStatus?: RoundVerificationStatus;
  /** v1.13: When enforcementAction is "reject" or "terminate", the reason
   *  why the round was rejected or the loop was terminated. */
  enforcementReason?: string;
  /** v3.9.7: the committed rollback directive facts and the verified restore
   *  that produced the redo prompt. The Agent does not restore the workspace;
   *  LoopForge already did. */
  recovery?: {
    origin: "agent" | "machine";
    reason: string;
    target_checkpoint_id: string;
    redo_round: number;
    restore: {
      status: "verified";
      head?: string;
      previous_head?: string;
      safety_ref?: string;
      files_written: number;
      files_deleted: number;
      verified_at: number;
    };
  };
  /** v3.8.1: set when the RUNTIME refused the submission before touching any
   *  state — the same `ToolErrorCode` as `stopReason`, plus the structured
   *  details a transport maps onto its error envelope. Produced by
   *  `validateSubmission` in submission-boundary.ts, which SessionManager
   *  runs before its queue and lease heartbeat. */
  submissionError?: {
    code:
      | "evaluation_invalid"
      | "contract_invalid"
      | "round_id_required"
      | "round_id_mismatch"
      | "recovery_invalid"
      | "recovery_disabled"
      | "recovery_unavailable"
      | "checkpoint_invalid"
      | "checkpoint_unavailable"
      | "checkpoint_failed"
      | "checkpoint_limit"
      | "restore_failed"
      | "restore_pending";
    details: Record<string, unknown>;
  };
  /** v3.9.4: a prompt-projection code defect. This is NOT a submission
   *  refusal (the round may already be committed); the next prompt was not
   *  delivered and the session is stalled. The MCP envelope maps it to the
   *  `projection_incomplete` error code. */
  projectionError?: {
    code: "projection_incomplete";
    details: Record<string, unknown>;
  };
  /** v3.9.1: current-fact submission guidance for the held/prepared round.
   *  Derived, never persisted; omitted on terminal results with no prompt. */
  submission_guidance?: SubmissionGuidance;
  /** v3.9.1: what this submission actually did. Returned by loopforge_next
   *  only; rebuilt from the transaction on a lost-response replay. */
  submission_receipt?: SubmissionReceipt;
}

/** v3.9.1: the facts every disposition builder needs to derive a receipt. */
interface ReceiptBase {
  snapshot: RoundTransactionSnapshot;
  selfEval: SelfEvaluation;
  pr: RoundProcessResult;
  actualEvidence: MachineObservation[];
  diagnostics: SubmissionDiagnostic[];
  submittedFields: string[];
  beforeContractId: string | null;
  beforeSubGoals: ReadonlyArray<SubGoal>;
  /** The directive that made this submission a redo checkpoint. Captured
   *  BEFORE the commit: once the child round commits it is no longer pending. */
  recoveryDirective: RecoveryDirective | null;
  replayed: boolean;
}

/** Narrow view of the session registry the lifecycle may touch. The owning
 *  SessionManager implements this over its private Map, so the lifecycle
 *  never holds or mutates registry state directly. */
export interface SessionRegistry {
  get(sessionId: string): McpSession | undefined;
  values(): Iterable<McpSession>;
  upsert(session: McpSession): void;
}

export interface RoundLifecycleDeps {
  store: LoopStore;
  sessionStore: SessionStateStore | undefined;
  registry: SessionRegistry;
  terminalSinks: Set<LoopTerminalSink>;
  /** Stable process-local owner token used for cross-process session leases. */
  ownerId: string;
  /** Session lease duration; stamped into saved session entries. */
  leaseMs: number;
  /** v3.9.7: per-loop checkpoint store. Absent disables automatic
   *  before-images (the round still runs with an explicit error fact). */
  checkpointStoreFor?: (loopId: string) => FileWorkspaceCheckpointStore | undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function buildLoopRequest(session: McpSession): LoopForgeRequest {
  // The request carries CURRENT-ROUND context only. Every previous-round
  // fact is read from the Vault's committed rounds by the compiler, so live,
  // resume, unpause and backtrack compiles cannot disagree about the same
  // history. `attempt` is restored only while the held snapshot belongs to
  // the current round; entering the next round resets it to 1.
  const heldAttempt =
    session.roundSnapshot?.round === session.currentRound
      ? session.roundSnapshot.attempt
      : 1;
  return {
    task: session.task,
    mode: Mode.LOOP_COMPILE,
    feedback: null,
    skill_name: null,
    task_id: null,
    loop_id: session.loopId,
    round: session.currentRound,
    max_rounds: session.maxRounds,
    attempt: heldAttempt,
    consecutive_rejections: session.consecutiveRejections,
  } as LoopForgeRequest;
}

// ── RoundLifecycle ─────────────────────────────────────────────────────────

export class RoundLifecycle {
  private readonly store: LoopStore;
  private readonly sessionStore: SessionStateStore | undefined;
  private readonly registry: SessionRegistry;
  private readonly terminalSinks: Set<LoopTerminalSink>;
  private readonly ownerId: string;
  private readonly leaseMs: number;
  private readonly checkpointStoreFor:
    | ((loopId: string) => FileWorkspaceCheckpointStore | undefined)
    | undefined;

  constructor(deps: RoundLifecycleDeps) {
    this.checkpointStoreFor = deps.checkpointStoreFor;
    this.store = deps.store;
    this.sessionStore = deps.sessionStore;
    this.registry = deps.registry;
    this.terminalSinks = deps.terminalSinks;
    this.ownerId = deps.ownerId;
    this.leaseMs = deps.leaseMs;
  }

  /** v3.9.1: the submission-guidance projection for a session's held round.
   *  One history window (`derivationRounds`, the compile window), no writes.
   *  Findings from a rejected/retried attempt are supplied by the caller. */
  guidanceFor(
    session: McpSession,
    extras: {
      verificationFlags?: ReadonlyArray<VerificationFlag>;
      recovery?: {
        pending: boolean;
        redo_round: number;
        checkpoint_id: string;
        restore_verified: boolean;
        origin?: "agent" | "machine";
        reason?: string;
      } | null;
    } = {},
  ): SubmissionGuidance {
    const prefix = `loop:${session.loopId}:`;
    const entries: VaultEntry[] = [
      ...queryLoopEntries(this.store, session.loopId, { prefix }),
      ...queryLoopEntries(this.store, session.loopId, { prefix, feedbackOnly: true }),
    ];
    const criteria = this.objectiveCriteriaFor(session, entries);
    return deriveSubmissionGuidance(session, {
      rounds: derivationRounds(entries, session.currentRound),
      ...(criteria ? { objective: { success_criteria: criteria } } : {}),
      ...extras,
    });
  }

  /** The operator criteria the held prompt's reference space was built from.
   *  The held acceptance wins; committed objective lineage is the fallback for
   *  a session whose snapshot predates the acceptance field. Null when neither
   *  is observable — callers fail open. */
  private objectiveCriteriaFor(
    session: McpSession,
    entries: ReadonlyArray<VaultEntry>,
  ): ReadonlyArray<string> | null {
    const acceptance =
      session.operatorAcceptance ?? session.roundSnapshot?.operatorAcceptance;
    if (acceptance) return acceptance.success_criteria;
    const attempt = session.roundSnapshot?.round === session.currentRound
      ? session.roundSnapshot.attempt
      : 1;
    return latestObjective(
      session.loopId,
      { results: entries },
      session.currentRound,
      session.currentRound === 1 && attempt > 1,
    )?.success_criteria ?? null;
  }

  /** v3.9.1: the before facts of the round being submitted, from the SAME
   *  history window the compile uses. Works on a replay too: rounds below the
   *  logical round exclude the round itself. */
  private beforeFactsFor(session: McpSession): {
    contractId: string | null;
    subGoals: SubGoal[];
    recoveryDirective: RecoveryDirective | null;
  } {
    const prefix = `loop:${session.loopId}:`;
    const entries: VaultEntry[] = [
      ...queryLoopEntries(this.store, session.loopId, { prefix }),
      ...queryLoopEntries(this.store, session.loopId, { prefix, feedbackOnly: true }),
    ];
    const rounds = derivationRounds(entries, session.currentRound);
    return {
      contractId: deriveActiveRoundContract(
        rounds,
        getPolicy().evidence.commands ?? [],
      )?.id ?? null,
      subGoals: deriveSubGoals({
        loopId: session.loopId,
        currentRound: session.currentRound,
        rounds,
      }),
      // Captured before the transaction commits. A redo commit consumes the
      // pending directive, so reading it afterwards would lose the fact.
      recoveryDirective: pendingRollbackDirective(
        entries,
        session.currentRound,
      )?.recovery ?? null,
    };
  }

  /** v3.9.1: derive this submission's receipt from the transaction and the
   *  shared read model. Never writes and never invents an applied effect. */
  private buildReceipt(
    base: ReceiptBase,
    opts: {
      disposition: SubmissionReceipt["disposition"];
      nextArtifact?: PromptArtifact | null;
      afterSubGoals?: ReadonlyArray<SubGoal> | null;
      constraintsActiveAfter?: string[] | null;
      constraintsRetiredAfter?: string[] | null;
      contractAfterId?: string | null;
    },
  ): SubmissionReceipt {
    const prefix = `loop:${base.snapshot.loopId}:`;
    const entries: VaultEntry[] = [
      ...queryLoopEntries(this.store, base.snapshot.loopId, { prefix }),
      ...queryLoopEntries(this.store, base.snapshot.loopId, {
        prefix,
        feedbackOnly: true,
      }),
    ];
    const committed =
      opts.disposition === "accepted" || opts.disposition === "stopped";
    const rounds = derivationRounds(
      entries,
      committed ? base.snapshot.round + 1 : base.snapshot.round,
    );
    const commands = getPolicy().evidence.commands ?? [];
    const roundDeltas = deriveRoundObservationDelta(
      base.snapshot.beforeEvidence,
      base.actualEvidence,
    );
    const contractView = deriveRoundContractView({
      rounds,
      round: base.snapshot.round,
      report: base.selfEval.execution_report ?? null,
      deltas: roundDeltas,
      blocked: declaresBlocked(base.selfEval),
      commands,
    });
    const contractAfterId = opts.contractAfterId !== undefined
      ? opts.contractAfterId
      : committed
        ? deriveActiveRoundContract(rounds, commands)?.id ?? null
        : base.beforeContractId;
    const afterSubGoals = opts.afterSubGoals !== undefined
      ? opts.afterSubGoals
      : committed
        ? deriveSubGoals({
            loopId: base.snapshot.loopId,
            currentRound: base.snapshot.round + 1,
            rounds,
          })
        : base.beforeSubGoals;
    // The pre-commit capture is authoritative. The committed-directive
    // fallback covers a replayed transaction whose pending directive was
    // consumed by a commit this process never observed.
    const recoveryDirective = base.recoveryDirective ??
      (base.snapshot.kind === "rollback"
        ? null
        : [...branchDirectives(entries)].reverse().find((item) =>
            item.recovery !== null && item.recovery !== undefined &&
            item.recovery.target.redo_round === base.snapshot.round &&
            item.recovery.transaction_id === base.snapshot.branchId,
          )?.recovery ?? null);
    return deriveSubmissionReceipt({
      snapshot: base.snapshot,
      selfEval: base.selfEval,
      pr: base.pr,
      disposition: opts.disposition,
      diagnostics: base.diagnostics,
      submittedFields: base.submittedFields,
      recoveryDirective,
      facts: {
        contractBefore: base.beforeContractId,
        contractAfter: contractAfterId,
        subGoalsBefore: base.beforeSubGoals,
        subGoalsAfter: afterSubGoals,
        constraintsActiveAfter: opts.constraintsActiveAfter ?? null,
        constraintsRetiredAfter: opts.constraintsRetiredAfter ?? null,
      },
      nextArtifact: opts.nextArtifact ?? null,
      contractItems: contractView.statuses.items.map((item) => ({
        item_id: item.itemId,
        status: item.status as ContractItemStatus,
      })),
      evidenceDeltas: roundDeltas,
    });
  }

  /** Persist session state to vault for cross-process recovery.
   *  The filtered vault and replacement entry are written once under the
   *  backend lock, so recovery never observes the old two-write gap. */
  save(session: McpSession): void {
    if (!this.sessionStore) return;
    const leaseActive = session.status === "running";
    const sessionEntry: VaultEntry = {
        task_id: `loop:${session.loopId}:session`,
        task_type: "session_state",
        timestamp: new Date().toISOString(),
        loop_id: session.loopId,
        task: session.task,
        loop_lineage: {
          session_id: session.sessionId,
          current_round: session.currentRound,
          max_rounds: session.maxRounds,
          status: session.status,
          created_at: session.createdAt,
          // v1.13: Enforcement gate state
          consecutive_rejections: session.consecutiveRejections,
          last_rejection_check: session.lastRejectionCheck,
          // v3.8.3: the in-flight entrypoint trust baseline. Read back
          // leniently (parseFingerprintMap) so a corrupt or absent value
          // degrades to "no absolute arm" instead of costing the round.
          entrypoint_trust: session.entrypointTrust ?? null,
          // v3.9.7: the operator-owned immutable acceptance cursor. The root
          // committed round-1 transaction remains the authority.
          operator_acceptance: session.operatorAcceptance ?? null,
          // v1.19: durable round transaction state
          round_snapshot: session.roundSnapshot ?? null,
          // v1.20: cross-process single-owner lease
          lease_owner: leaseActive ? this.ownerId : "",
          lease_expires_at: leaseActive ? Date.now() + this.leaseMs : 0,
        },
      };
    this.sessionStore.save(sessionEntry, {
      expectedLeaseOwner: this.ownerId,
    });
  }

  /** Reconstruct a McpSession from a vault session_state entry.
   *  Returns null if the entry is not "running" status.
   *  Shared by resume() and autoResumeAll(). */
  reconstructSession(
    entry: VaultEntry,
    allowPaused = false,
  ): McpSession | null {
    const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
    const status = (lineage.status as string) ?? "running";
    // v3.9.7: a persisted `stalled` recovery state MUST be resumable. It is
    // how a committed directive with an unfinished restore survives a
    // process restart; refusing it would strand the loop forever.
    if (status !== "running" && status !== "stalled" &&
        !(allowPaused && status === "paused")) {
      return null;
    }

    const loopId = entry.loop_id as string;
    // v2.14: load-time gap detection — a runtime loop whose round sequence
    // has holes (deleted/tampered round documents) must not be resumed
    // silently. Legacy loops without stamps are exempt; gaps and corruption
    // surface as StorageCorruptionError. Previously checkRoundSequence was
    // only reachable through the read-only audit.
    checkRoundSequence(this.store, loopId);
    const currentRound = (lineage.current_round as number) ?? 1;
    const task = (entry.task as string) ?? "";
    const maxRounds =
      (lineage.max_rounds as number) ?? getPolicy().engine.max_rounds;
    const parsedSnapshot = parseRoundTransactionSnapshot(lineage.round_snapshot);
    // v3.7: the synchronous evidence fallback was removed (async providers
    // could never be collected synchronously — they were skipped and logged
    // as failures). Every path that needs evidence re-collects asynchronously
    // through prepare()/unpause(); a missing snapshot starts with no baseline.
    const fallbackEvidence: MachineObservation[] = [];
    const entries = [
      ...queryLoopEntries(this.store, loopId, { prefix: `loop:${loopId}:` }),
      ...queryLoopEntries(this.store, loopId, { prefix: `loop:${loopId}:`, feedbackOnly: true }),
    ];
    const branch = resolveBranch(entries);
    const pending = pendingRollbackDirective(entries);
    // The session cursor is the primary copy; the held snapshot and the
    // visible root transaction are fallbacks. Losing the operator surface
    // during a restore/restart would be unrecoverable.
    const operatorAcceptance =
      parseOperatorAcceptance(lineage.operator_acceptance) ??
      parsedSnapshot?.operatorAcceptance ??
      branch.rounds.find((view) => view.operatorAcceptance !== null)?.operatorAcceptance ??
      undefined;
    const effectiveBranchId =
      parsedSnapshot?.branchId ?? branch.branchId ?? rootBranchId(loopId);
    // When a rollback directive is pending, do NOT synthesize an empty
    // beforeEvidence snapshot: it would be mistaken for a held evaluation.
    // Resume must run the pending restore first.
    const roundSnapshot = parsedSnapshot ?? (pending ? undefined : prepareRoundTransaction(
      loopId,
      currentRound,
      fallbackEvidence,
      undefined,
      { branchId: effectiveBranchId },
    ));

    const engine = new LoopForgeEngine(this.store);
    return {
      sessionId: typeof lineage.session_id === "string" && lineage.session_id
        ? lineage.session_id
        : randomUUID(),
      loopId, task, engine,
      currentRound, maxRounds,
      status: status as McpSession["status"],
      createdAt: (lineage.created_at as number) ?? Date.now(),
      consecutiveRejections: (lineage.consecutive_rejections as number) ?? 0,
      lastRejectionCheck: typeof lineage.last_rejection_check === "string"
        ? lineage.last_rejection_check
        : "",
      entrypointTrust: parseFingerprintMap(lineage.entrypoint_trust),
      ...(operatorAcceptance ? { operatorAcceptance } : {}),
      roundSnapshot,
    };
  }

  /** Apply a prepared round to the session, persist, and build the result.
   *  Shared by reconcileCommittedRound, resume, and unpause — the three
   *  compile-then-persist tails were previously copy-pasted. */
  /** Apply a processed round's counters to the session.
   *
   *  v3.8.1: per-rule rejection tracking — same-check rejections accumulate,
   *  and a DIFFERENT rejection reason resets the counter to 1, so an agent
   *  that fixes what it was told to fix is not punished by an unrelated
   *  earlier rejection. This rule ran as two byte-identical copies (the live
   *  advance path and the crash replay); one rule, one implementation, so the
   *  two paths cannot drift.
   *
   *  `newConsecutiveRejections` comes from the enforcement gate and already
   *  counts the round; it is only honoured when the check is unchanged. */
  private applyRoundCounters(session: McpSession, pr: RoundProcessResult): void {
    if (pr.action === "reject" && pr.rejectionCheck) {
      session.consecutiveRejections =
        pr.rejectionCheck === session.lastRejectionCheck
          ? pr.newConsecutiveRejections
          : 1;
      session.lastRejectionCheck = pr.rejectionCheck;
    } else {
      session.consecutiveRejections = pr.newConsecutiveRejections;
      if (pr.action !== "reject") session.lastRejectionCheck = "";
    }
  }

  /** v3.8.3: capture the trusted entrypoint baseline for the round about to be
   *  prepared.
   *
   *  Called wherever a NEW round is installed and NEVER for a same-round
   *  retry: a retry must keep measuring against the state the round started
   *  in, or the first rejection would silently re-baseline itself. What is
   *  captured here is therefore the round's own start, taken before the agent
   *  receives the prompt.
   *
   *  Best-effort: an unreadable policy or an unresolvable command must leave
   *  the round without the absolute arm, not fail the preparation. */
  private seedEntrypointTrust(session: McpSession): void {
    try {
      session.entrypointTrust = captureEntrypointTrust(getPolicy());
    } catch {
      session.entrypointTrust = undefined;
    }
  }

  /** v3.9.7: operator acceptance and branch identity travel with the session
   *  cursor (not only the held snapshot). Every prepare carries them forward;
   *  a recovery that clears the held snapshot must not reset the branch to
   *  root or lose the operator's acceptance surface. */
  private prepareOptions(
    session: McpSession,
    branchId?: string,
  ): { branchId?: string; operatorAcceptance?: OperatorAcceptance } {
    const acceptance = session.operatorAcceptance ?? session.roundSnapshot?.operatorAcceptance;
    const effectiveBranchId = branchId ?? session.roundSnapshot?.branchId;
    return {
      ...(effectiveBranchId ? { branchId: effectiveBranchId } : {}),
      ...(acceptance ? { operatorAcceptance: acceptance } : {}),
    };
  }

  private persistPrepared(
    session: McpSession,
    prepared: {
      prompt: string | null;
      level: string;
      baseline: MachineObservation[];
      snapshot: RoundTransactionSnapshot;
      warnings: string[];
      compileResponse?: LoopForgeResponse | null;
    },
    roundSuccess: boolean | undefined,
    warningsOverride?: string[],
  ): AdvanceResult {
    session.roundSnapshot = prepared.snapshot;
    this.seedEntrypointTrust(session);
    policyMetrics.recordStrategy(session.loopId, prepared.level);
    this.save(session);

    return {
      sessionId: session.sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot.roundId,
      ...this.transactionFacts(session),
      prompt: prepared.prompt,
      level: prepared.level,
      roundSuccess,
      // v3.8: the posture of the round that just committed — read from the
      // transaction's committed result, not recomputed here.
      verificationStatus: session.roundSnapshot?.result?.verificationStatus,
      warnings: warningsOverride ??
        session.roundSnapshot?.promptArtifact?.warnings ??
        prepared.warnings ?? [],
      submission_guidance: this.guidanceFor(session),
    };
  }

  /** v3.9.7: execution metadata attached to every held/prepared prompt. These
   *  are transport facts, never prompt governance content. */
  private transactionFacts(
    session: McpSession,
  ): Pick<AdvanceResult, "transactionId" | "checkpoints" | "beforeCheckpointError"> {
    const snapshot = session.roundSnapshot;
    if (!snapshot) return {};
    const checkpoints = [
      ...(snapshot.beforeCheckpoint ? [snapshot.beforeCheckpoint] : []),
      ...(snapshot.checkpoints ?? []),
    ];
    return {
      transactionId: snapshot.transactionId,
      ...(checkpoints.length > 0 ? { checkpoints } : {}),
      ...(snapshot.beforeCheckpointError
        ? {
            beforeCheckpointError: {
              code: snapshot.beforeCheckpointError.code,
              detail: snapshot.beforeCheckpointError.detail,
            },
          }
        : {}),
    };
  }

  private restoredPromptResult(session: McpSession): AdvanceResult | null {
    const artifact = session.roundSnapshot?.promptArtifact;
    if (!artifact) return null;
    const expectedRoundId = makeRoundId(session.loopId, session.currentRound);
    if (artifact.roundId !== expectedRoundId) return null;
    return {
      sessionId: session.sessionId,
      round: session.currentRound,
      roundId: artifact.roundId,
      ...this.transactionFacts(session),
      prompt: artifact.renderedPrompt,
      level: artifact.level,
      roundSuccess: undefined,
      warnings: artifact.warnings ?? [],
      submission_guidance: this.guidanceFor(session),
    };
  }

  /** Reconcile the crash window where feedback committed but session_state
   *  still points at the old prompt. Returns null when no commit is pending.
   *  v3.7: async — the continue-after-crash branch compiles through
   *  RoundDriver.prepare (the sync prepareSync fallback was removed). */
  private async reconcileCommittedRound(session: McpSession): Promise<AdvanceResult | null> {
    if (!session.roundSnapshot) return null;
    const recovered = new RoundDriver(
      session.engine,
      this.store,
    ).recover(session.roundSnapshot);
    if (!recovered) return null;

    const pr = recovered.result;
    session.roundSnapshot = recovered.snapshot;
    this.applyRoundCounters(session, pr);

    if (pr.action === "stop" || pr.action === "terminate") {
      // v3.8.3: a replayed termination carries the gate's own reason for the
      // same reason the live path does (see buildTerminationResult) — the
      // crash-recovery path must report the fact it replayed, not a generic
      // substitute. Only a stop without a named reason falls back.
      const reason = pr.stopReason
        ?? (pr.action === "terminate" ? "enforcement_terminated" : "stalled");
      session.status = reason === "stalled" ? "stalled" : "stopped";
      this.save(session);
      void this.notifyTerminal(session, reason);
      return {
        sessionId: session.sessionId,
        round: session.currentRound,
        roundId: recovered.snapshot.roundId,
        prompt: null,
        stopReason: reason,
        stopDetail: reason === "completed"
          ? "Task completed successfully — the agent declared should_continue=false with success=true."
          : reason === "blocked"
            ? "Agent cannot proceed under current constraints. The task may need revised constraints or human intervention."
            : reason === "failed"
              ? "Agent declared should_continue=false with success=false — the task was not achieved."
              : `Loop stopped: ${reason}.`,
        roundSuccess: pr.roundSuccess,
      };
    }

    if (pr.action === "backtrack" || pr.action === "recovery") {
      // Backtrack/directive committed but the redo prompt was not delivered
      // (crash window). The pending-directive-first path in resume/unpause
      // performs the restore; here we only align the cursor.
      session.currentRound = pr.recovery?.target.redo_round ?? session.currentRound;
      session.consecutiveRejections = 0;
      session.lastRejectionCheck = "";
      this.save(session);
      // Return null — caller (resume/unpause) will restore/recompile.
      return null;
    }

    if (pr.action !== "continue") return null;
    // v2.14: only advance when the persisted counter has not already moved
    // past the committed round. The pause/delete race leaves currentRound
    // incremented (the commit fence returns before compiling, and pause()
    // persisted the incremented value) — replaying must compile the NEXT
    // round, not skip it by incrementing again.
    if (session.currentRound <= recovered.snapshot.round) {
      session.currentRound = recovered.snapshot.round + 1;
    }
    const request = buildLoopRequest(session);
    const prepared = await new RoundDriver(
      session.engine,
      this.store,
    ).prepare(
      request,
      session.loopId,
      session.currentRound,
      this.prepareOptions(session),
    );
    if (!prepared) {
      session.status = "stalled";
      this.save(session);
      return {
        sessionId: session.sessionId,
        round: session.currentRound,
        prompt: null,
        stopReason: "stalled",
        stopDetail: "RoundDriver.prepare returned null — prompt compilation failed during crash recovery. The session state may be inconsistent.",
      };
    }
    return this.persistPrepared(
      session,
      {
        prompt: prepared.prompt,
        level: prepared.level,
        baseline: prepared.evidenceBaseline,
        snapshot: prepared.snapshot,
        warnings: prepared?.warnings ?? [],
      },
      pr.roundSuccess,
    );
  }

  /** v3.9.7: a committed directive with no verified redo snapshot must be
   *  completed BEFORE any ordinary compile/held-prompt path. The restore and
   *  redo prepare are idempotent; a verified held redo prompt is returned
   *  without re-checking the workspace (the Agent may already have worked). */
  private async completePendingRecovery(
    session: McpSession,
  ): Promise<AdvanceResult | null> {
    const prefix = `loop:${session.loopId}:`;
    const entries: VaultEntry[] = [
      ...queryLoopEntries(this.store, session.loopId, { prefix }),
      ...queryLoopEntries(this.store, session.loopId, { prefix, feedbackOnly: true }),
    ];
    const pending = pendingRollbackDirective(entries);
    if (!pending?.recovery) return null;
    const directive = pending.recovery;
    const verified =
      session.roundSnapshot?.restore?.directiveTransactionId ===
        directive.transaction_id &&
      session.roundSnapshot.round === directive.target.redo_round;
    if (verified) {
      return this.restoredPromptResult(session);
    }
    session.currentRound = directive.target.redo_round;
    session.roundSnapshot = undefined;
    session.status = "running";
    const pr: RoundProcessResult = {
      action: directive.origin === "agent" ? "recovery" : "backtrack",
      origin: directive.origin,
      reason: directive.reason,
      recovery: directive,
      verificationFlags: [],
      roundSuccess: false,
      gateContradicted: false,
      verificationStatus: "not_applicable",
      newConsecutiveRejections: 0,
      shouldPushSuccessTrajectory: false,
    };
    const snapshot = prepareRoundTransaction(
      session.loopId,
      directive.target.redo_round,
      [],
    );
    const beforeFacts = this.beforeFactsFor(session);
    return this.buildBacktrackResult(session.sessionId, session, pr, {
      snapshot,
      selfEval: {
        success: false,
        output_summary: "",
        constraint_violations: [],
        should_continue: true,
      },
      pr,
      actualEvidence: [],
      diagnostics: [],
      submittedFields: [],
      beforeContractId: beforeFacts.contractId,
      beforeSubGoals: beforeFacts.subGoals,
      recoveryDirective: directive,
      replayed: true,
    });
  }

  /** Resume tail: the session has been reconstructed and registered. Reconcile
   *  a committed-but-undelivered round, restore the held prompt, or recover a
   *  missing prompt from current round state. v3.7: async — compilation runs
   *  through RoundDriver.prepare like unpause (the prepareSync fallback was
   *  removed); a failed compile now degrades to the same stalled terminal
   *  result unpause returns instead of persisting a null prompt. */
  async resume(session: McpSession): Promise<AdvanceResult> {
    const pendingRecovery = await this.completePendingRecovery(session);
    if (pendingRecovery) return pendingRecovery;

    const reconciled = await this.reconcileCommittedRound(session);
    if (reconciled) return reconciled;

    const restored = this.restoredPromptResult(session);
    if (restored) return restored;

    // Missing held prompt: compile (async) once, then persist it.
    const request = buildLoopRequest(session);
    const prepared = await new RoundDriver(
      session.engine,
      this.store,
    ).prepare(
      request,
      session.loopId,
      session.currentRound,
      this.prepareOptions(session),
    );
    if (!prepared) {
      session.status = "stopped";
      this.save(session);
      void this.notifyTerminal(session, "stalled");
      return {
        sessionId: session.sessionId,
        round: session.currentRound,
        prompt: null,
        stopReason: "stalled",
        stopDetail: "RoundDriver.prepare returned null during resume — the compiler could not produce a prompt.",
      };
    }
    return this.persistPrepared(
      session,
      {
        prompt: prepared.prompt,
        level: prepared.level,
        baseline: prepared.evidenceBaseline,
        snapshot: prepared.snapshot,
        warnings: prepared?.warnings ?? [],
      },
      false,
    );
  }

  /** Unpause tail: the session has been reconstructed and registered with
   *  status "running". Refresh async evidence, reconcile a committed round,
   *  restore the held prompt, or compile the next prompt. */
  async unpause(session: McpSession): Promise<AdvanceResult> {
    const pendingRecovery = await this.completePendingRecovery(session);
    if (pendingRecovery) return pendingRecovery;
    // Replace the sync-fallback evidence baseline with async evidence
    // so resumed sessions don't silently drop async provider data.
    try {
      const asyncEvidence = await EvidenceCollector.fromPolicy().collectAsync({
        loopId: session.loopId,
        phase: "before",
      });
      if (asyncEvidence.length > 0) {
        if (!session.roundSnapshot?.beforeEvidence?.length) {
          session.roundSnapshot = prepareRoundTransaction(
            session.loopId,
            session.currentRound,
            asyncEvidence,
          );
        }
      }
    } catch {
      // Async evidence is best-effort; fall back to sync baseline.
    }

    const reconciled = await this.reconcileCommittedRound(session);
    if (reconciled) return reconciled;
    const restored = this.restoredPromptResult(session);
    if (restored) {
      this.save(session);
      return restored;
    }

    // Compile the next prompt from the current round state
    const lcr = makeLoopCompileRequest({
      loop_id: session.loopId,
      round: session.currentRound,
      goal_id: "",
      task: session.task,
      domain: undefined,
      plan_source: null,
      constraints_from_plan: [],
    });
    const compileRequest = {
      task: session.task,
      mode: Mode.LOOP_COMPILE,
      feedback: null,
      skill_name: null,
      task_id: null,
      loop_id: lcr.loop_id,
      round: lcr.round,
      goal_id: lcr.goal_id,
      domain: lcr.domain ?? "",
      plan_source: lcr.plan_source ?? null,
      constraints_from_plan: lcr.constraints_from_plan ?? [],
      max_rounds: session.maxRounds,
      // Preserve an in-flight retry's attempt; a next-round compile resets
      // it because the held snapshot belongs to the previous round.
      attempt: session.roundSnapshot?.round === session.currentRound
        ? session.roundSnapshot.attempt
        : 1,
      consecutive_rejections: session.consecutiveRejections,
    } as LoopForgeRequest;
    const prepared = await new RoundDriver(
      session.engine,
      this.store,
    ).prepare(
      compileRequest,
      session.loopId,
      session.currentRound,
      this.prepareOptions(session),
    );

    if (!prepared) {
      session.status = "stopped";
      this.save(session);
      void this.notifyTerminal(session, "stalled");
      return { sessionId: session.sessionId, round: session.currentRound, prompt: null, stopReason: "stalled", stopDetail: "RoundDriver.prepare returned null during unpause — the compiler could not produce a prompt." };
    }
    return this.persistPrepared(
      session,
      {
        prompt: prepared.prompt,
        level: prepared.level,
        baseline: prepared.evidenceBaseline,
        snapshot: prepared.snapshot,
        warnings: prepared?.warnings ?? [],
      },
      undefined,
      // Historical contract: unpause returns an empty warnings array even
      // though the session carries the compiled warnings.
      [],
    );
  }

  /** Record a gate_opened entry when an accepted round reports a high-risk
   *  blocker (USER_RISK hit). Idempotent per gate. The gate is a record
   *  layer — it never blocks the round decision flow. */
  private recordGateFromBlocked(session: McpSession, blocker: string): void {
    if (!getPolicy().gate.enabled) return;
    const { id, gate } = deriveGate(blocker);
    if (gate.kind !== "user") return;
    const taskId = `loop:${session.loopId}:gate:${id}`;
    const existing = queryLoopEntries(this.store, session.loopId, { prefix: taskId })
      .some((entry) => entry.task_id === taskId);
    if (existing) return;
    const entry: VaultEntry = {
      id: randomUUID(),
      task_id: taskId,
      task_type: "gate_opened",
      loop_id: session.loopId,
      timestamp: new Date().toISOString(),
      gate_id: id,
      gate_action: blocker,
      loop_lineage: {
        round: session.currentRound,
        gate_id: id,
      },
    };
    this.store.appendEntry(entry);
    logEvent("gate_opened", { loopId: session.loopId, gateId: id, round: session.currentRound });
  }

  /** Undecided user gate descriptions for a loop (recorded but unresolved). */
  listOpenGateDescriptions(loopId: string): string[] {
    const entries = queryLoopEntries(this.store, loopId, { prefix: `loop:${loopId}:gate:` });
    const decided = new Set(
      entries.filter((entry) => entry.task_type === "gate_decision")
        .map((entry) => String(entry.gate_id ?? "")),
    );
    return entries
      .filter((entry) => entry.task_type === "gate_opened" &&
        !decided.has(String(entry.gate_id ?? "")))
      .map((entry) => typeof entry.gate_action === "string"
        ? entry.gate_action
        : String(entry.gate_id ?? ""));
  }

  /** The boundary supplies the typed evaluation. Free-text parsing is
   *  deliberately not part of the round state machine. */
  private extractEvaluation(
    _output: string,
    preExtractedEval?: SelfEvaluation,
  ): SelfEvaluation | null {
    return preExtractedEval ?? null;
  }

  /** Execute the round transaction and apply per-rule rejection tracking.
   *  MUTATES: session.roundSnapshot, session.consecutiveRejections,
   *           session.lastRejectionCheck */
  private async executeRoundTransaction(
    session: McpSession,
    selfEval: SelfEvaluation,
    normalizationDiagnostics?: SubmissionDiagnostic[],
    submittedFields?: string[],
  ): Promise<{
    pr: RoundProcessResult;
    verificationFlags: VerificationFlag[];
    actualEvidence: MachineObservation[];
    replayed: boolean;
  }> {
    const snapshot = session.roundSnapshot ?? prepareRoundTransaction(
      session.loopId,
      session.currentRound,
      [],
    );
    const completed = await new RoundDriver(
      session.engine,
      this.store,
    ).complete({
      snapshot,
      loopId: session.loopId,
      task: session.task,
      maxRounds: session.maxRounds,
      selfEval,
      consecutiveRejections: session.consecutiveRejections,
      lastRejectionCheck: session.lastRejectionCheck,
      entrypointTrust: session.entrypointTrust,
      normalizationDiagnostics,
      submittedFields,
    });
    const outcome = completed.outcome;
    const actualEvidence = completed.actualEvidence;
    session.roundSnapshot = outcome.snapshot;
    const pr = outcome.result;

    this.applyRoundCounters(session, pr);

    return {
      pr,
      verificationFlags: pr.verificationFlags,
      actualEvidence,
      replayed: completed.outcome.replayed,
    };
  }

  /** Build a rejection result: compile a retry prompt, persist, return.
   *  MUTATES: session.roundSnapshot, session.currentPrompt, session.currentLevel */
  private async buildRejectionResult(
    sessionId: string,
    session: McpSession,
    pr: RoundProcessResult,
    verificationFlags: VerificationFlag[],
    receiptBase: ReceiptBase,
  ): Promise<AdvanceResult> {
    // In-flight attempt findings are authority for THIS attempt, not
    // committed history: write them explicitly on the retry request.
    const retryRequest = buildLoopRequest(session);
    retryRequest.verification_flags = verificationFlags;
    const preparedRetry = await new RoundDriver(
      session.engine,
      this.store,
    ).prepareRetry(
      retryRequest,
      session.roundSnapshot!,
      pr.rejectionPrompt ?? "",
      session.consecutiveRejections,
    );
    if (!preparedRetry) {
      session.status = "stalled";
      this.save(session);
      return {
        sessionId,
        round: session.currentRound,
        roundId: session.roundSnapshot?.roundId,
        prompt: null,
        stopReason: "stalled",
        stopDetail: "RoundDriver.prepareRetry returned null — the retry prompt could not be compiled.",
      };
    }
    session.roundSnapshot = preparedRetry.snapshot;
    this.save(session);
    return {
      sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot.roundId,
      prompt: preparedRetry.prompt,
      level: preparedRetry.level,
      enforcementAction: "reject",
      verificationStatus: pr.verificationStatus,
      enforcementReason: pr.enforcementReason,
      submission_guidance: this.guidanceFor(session, {
        verificationFlags: pr.verificationFlags,
      }),
      submission_receipt: this.buildReceipt(receiptBase, {
        disposition: "rejected",
        nextArtifact: preparedRetry.artifact ??
          preparedRetry.compileResponse?.prompt_artifact ?? null,
        afterSubGoals: null,
        constraintsActiveAfter: null,
        contractAfterId: receiptBase.beforeContractId,
      }),
    };
  }

  /** v2.10: Build a backtrack result — roll back to last clean round.
   *  Resets the round counter to the restore target + 1, merges preserved
   *  discoveries, compiles from the restored state, and injects the
   *  backtrack prompt at the top.
   *  MUTATES: session.currentRound, session.roundSnapshot,
   *           session.consecutiveRejections, session.lastRejectionCheck */
  private async buildBacktrackResult(
    sessionId: string,
    session: McpSession,
    pr: RoundProcessResult,
    receiptBase: ReceiptBase,
  ): Promise<AdvanceResult> {
    // v3.8: LoopForge never mutates the working tree. The backtrack prompt
    // carries the restore facts (files, fingerprints, target HEAD) and the
    // verification gate enforces the check on the redo submission; the agent
    // executes the restore itself. The former `backtrack_auto_restore` policy
    // and its git stash/reset implementation were deleted.
    const directive = pr.recovery;
    const restoreTarget = directive?.target ?? (session.currentRound - 1);
    const newRound = restoreTarget + 1;
    const branchId = directive?.transaction_id ?? session.roundSnapshot?.branchId;

    logEvent("session_recovery", {
      sessionId,
      loopId: session.loopId,
      fromRound: session.currentRound,
      toRound: newRound,
      origin: directive?.origin ?? "machine",
      triggerRule: directive?.trigger_rule ?? "",
      skippedDiscoveries: (directive?.skipped_discoveries ?? []).length,
    });

    // Reset session to the restored round. Recovery facts themselves are
    // never copied into the session; the committed directive is the source.
    session.currentRound = newRound;
    session.consecutiveRejections = 0;
    session.lastRejectionCheck = "";

    // Compile the restored prompt — use a fresh request with the restored
    // round. Preserved discoveries are read by the compiler from the committed
    // rollback directive; they are never injected through a transient request
    // field.
    const request: LoopForgeRequest = {
      task: session.task,
      mode: Mode.LOOP_COMPILE,
      feedback: null,
      skill_name: null,
      task_id: null,
      loop_id: session.loopId,
      round: newRound,
      max_rounds: session.maxRounds,
      verification_flags: pr.verificationFlags,
    };

    const prepared = await new RoundDriver(
      session.engine,
      this.store,
    ).prepare(
      request,
      session.loopId,
      newRound,
      this.prepareOptions(session, branchId),
    );

    if (!prepared || !prepared.prompt) {
      session.status = "stalled";
      this.save(session);
      return {
        sessionId,
        round: newRound,
        prompt: null,
        stopReason: "stalled",
        stopDetail: "Recovery failed: RoundDriver.prepare returned null — could not compile from restore point.",
        enforcementAction: directive?.origin === "agent" ? "recovery" : "backtrack",
        verificationStatus: pr.verificationStatus,
        enforcementReason: pr.reason ?? pr.enforcementReason,
        ...(directive
          ? {
              recovery: {
                origin: directive.origin,
                target_round: directive.target,
                reason: directive.reason,
                ...(directive.target_head ? { target_head: directive.target_head } : {}),
                restore_required: true,
              },
            }
          : {}),
      };
    }

    // v3.9.4: the recovery facts are a protected section INSIDE the compiled
    // artifact. Never rewrite the prompt after compilation: the delivered
    // prompt must equal `prompt_artifact.renderedPrompt` and its hash.
    session.roundSnapshot = prepared.snapshot;
    // v3.8.3: the rollback redo is a NEW round — `prepare` collected a fresh
    // before capture above — so its entrypoint baseline is the workspace as it
    // stands after the rollback, which is what lets a round that stalled on a
    // rewritten entrypoint proceed once the entrypoint is in place.
    this.seedEntrypointTrust(session);
    this.save(session);

    return {
      sessionId,
      round: newRound,
      roundId: session.roundSnapshot?.roundId,
      prompt: prepared.prompt,
      level: prepared.level,
      enforcementAction: directive?.origin === "agent" ? "recovery" : "backtrack",
      verificationStatus: pr.verificationStatus,
      enforcementReason: pr.reason ?? pr.enforcementReason,
      ...(directive
        ? {
            recovery: {
              origin: directive.origin,
              target_round: directive.target,
              reason: directive.reason,
              ...(directive.target_head ? { target_head: directive.target_head } : {}),
              restore_required: true,
            },
          }
        : {}),
      warnings: prepared?.warnings ?? [],
      submission_guidance: this.guidanceFor(session, {
        verificationFlags: pr.verificationFlags,
        recovery: {
          required: true,
          restore_point: directive?.target ?? Math.max(1, newRound - 1),
          ...(directive?.target_head ? { target_head: directive.target_head } : {}),
          ...(directive
            ? { origin: directive.origin, reason: directive.reason }
            : {}),
        },
      }),
      submission_receipt: this.buildReceipt(receiptBase, {
        disposition: "backtracked",
        nextArtifact: prepared.artifact ??
          prepared.compileResponse?.prompt_artifact ?? null,
        afterSubGoals: null,
        constraintsActiveAfter: null,
        contractAfterId: receiptBase.beforeContractId,
      }),
    };
  }

  /** Build a termination result: persist stopped status, notify sinks.
   *  MUTATES: session.status, session.currentPrompt
   *
   *  v3.8.3: the enforcement gate may NAME its own stop reason (the
   *  contract-debt row terminates as `incomplete`). This used to hard-code
   *  `enforcement_terminated`, so the specific reason reached observability
   *  and the client as a generic one — the fact was computed and then thrown
   *  away. Pass it through, falling back only when the gate named nothing. */
  private buildTerminationResult(
    sessionId: string,
    session: McpSession,
    pr: RoundProcessResult,
    /** v3.8.3: see buildStopResult. */
    guardedReason: StopReason | undefined,
    receiptBase: ReceiptBase,
  ): AdvanceResult {
    const reason = guardedReason ?? pr.stopReason ?? "enforcement_terminated";
    session.status = "stopped";
    // v3.8.3: no round is in flight once the loop stops — the in-flight trust
    // baseline goes with it, so a later resume cannot compare against a state
    // from a previous life.
    session.entrypointTrust = undefined;
    this.save(session);
    void this.notifyTerminal(session, reason);
    logEvent("session_end", {
      sessionId, loopId: session.loopId,
      stopReason: reason, round: session.currentRound,
    });
    return {
      sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot?.roundId,
      prompt: null,
      stopReason: reason,
      stopDetail: pr.enforcementReason ?? "The enforcement gate terminated the loop.",
      enforcementAction: "terminate",
      verificationStatus: pr.verificationStatus,
      enforcementReason: pr.enforcementReason,
      submission_receipt: this.buildReceipt(receiptBase, {
        disposition: "terminated",
        nextArtifact: null,
        afterSubGoals: null,
        constraintsActiveAfter: null,
        contractAfterId: receiptBase.beforeContractId,
      }),
    };
  }

  /** Build a stop result: persist stopped/stalled status, notify sinks.
   *  MUTATES: session.status, session.currentPrompt */
  private buildStopResult(
    sessionId: string,
    session: McpSession,
    pr: RoundProcessResult,
    /** v3.8.3: the reason AFTER the completion-truth guard (advanceUnlocked).
     *  Absent on the replay paths, which then read `pr.stopReason` directly. */
    guardedReason: StopReason | undefined,
    receiptBase: ReceiptBase,
  ): AdvanceResult {
    const reason = guardedReason ?? pr.stopReason ?? "stalled";
    session.status = reason === "stalled" ? "stalled" : "stopped";
    // v3.8.3: see buildTerminationResult — the in-flight trust baseline dies
    // with the in-flight round.
    session.entrypointTrust = undefined;
    this.save(session);
    void this.notifyTerminal(session, reason);
    logEvent("session_end", { sessionId, loopId: session.loopId, stopReason: reason, round: session.currentRound });
    return {
      sessionId, round: session.currentRound,
      roundId: session.roundSnapshot?.roundId,
      prompt: null, stopReason: reason,
      stopDetail: pr.stopReason === "max_rounds"
          ? "The configured maximum number of rounds has been reached."
          : `Loop stopped: ${reason}.`,
      roundSuccess: pr.roundSuccess,
      submission_receipt: this.buildReceipt(receiptBase, {
        disposition: "stopped",
        nextArtifact: null,
        constraintsActiveAfter: null,
      }),
    };
  }

  /** Compile the next round's prompt and advance the session.
   *  Includes the commit fence (pause/delete race guard) and context provider.
   *  MUTATES: session.currentRound, session.currentPrompt, session.currentLevel,
   *           session.evidenceBaseline, session.roundSnapshot */
  private async advanceToNextRound(
    sessionId: string,
    session: McpSession,
    selfEval: SelfEvaluation,
    pr: RoundProcessResult,
    actualEvidence: MachineObservation[],
    receiptBase: ReceiptBase,
  ): Promise<AdvanceResult> {
    const roundSuccess = pr.roundSuccess;
    // M4 (v3.7.x): replay guard. The counter may already point past the
    // committed round when this continue is a REPLAY — after a crash or an
    // in-process exception between the round's commit and this compile, the
    // previous attempt already incremented currentRound but never compiled
    // the next round. An unconditional ++ would silently skip that round's
    // prompt and poison the vault sequence (see reconcileCommittedRound's
    // v2.14 counter guard — the live path must use the same judgement).
    if (!session.roundSnapshot || session.currentRound <= session.roundSnapshot.round) {
      session.currentRound++;
    }
    // Commit fence: pause()/delete() may run while prepare is awaited.
    if (this.registry.get(sessionId) !== session || session.status !== "running") {
      return {
        sessionId,
        round: session.currentRound,
        prompt: null,
        stopReason: session.status,
        stopDetail: `Session is no longer running (status: ${session.status}). It was paused or deleted while the next prompt was being prepared.`,
        roundSuccess,
      };
    }

    const request = buildLoopRequest(session);
    let prepared: PreparedRound | null;
    try {
      prepared = await new RoundDriver(
        session.engine,
        this.store,
      ).prepare(
        request,
        session.loopId,
        session.currentRound,
        this.prepareOptions(session),
      );
    } catch (error) {
      // M4: a post-commit compile exception must not silently strand the
      // session between rounds. The round above already committed — turn the
      // session into the same stalled state the crash-recovery siblings use,
      // so the agent gets a retryable result instead of a raw -32603 with a
      // mutated, unsaved session (which let a replay skip the next round).
      logEvent("compile_failed", {
        loopId: session.loopId,
        round: session.currentRound,
        error: String(error),
      });
      if (error instanceof ProjectionCoverageError) {
        // v3.9.4: the failure is a projection code defect, not a work-quality
        // verdict. Keep the committed round held and surface the stable code.
        return this.stalledAfterCommit(
          sessionId,
          session,
          roundSuccess,
          error.message,
          { code: "projection_incomplete", details: { coverage: error.coverage } },
        );
      }
      return this.stalledAfterCommit(
        sessionId,
        session,
        roundSuccess,
        `RoundDriver.prepare threw after the round committed: ${String(error).slice(0, 300)}. ` +
        `The session is stalled with the committed round still held — resume or ` +
        `resubmit the same roundId to recompile the next prompt.`,
      );
    }
    if (!prepared) {
      // M4: align with the sibling paths (resume / unpause / reject /
      // backtrack / crash recovery) that treat a null preparation as a
      // stalled session — previously this silently returned prompt:null
      // without a stopReason while the session kept running.
      return this.stalledAfterCommit(
        sessionId,
        session,
        roundSuccess,
        "RoundDriver.prepare returned null after the round committed — the " +
        "next prompt could not be compiled. Resume or resubmit the same " +
        "roundId to retry.",
      );
    }
    // Commit fence after the async prepare: pause()/delete() may have run
    // while the compile/evidence collection was in flight. Do not install a
    // prompt into a session that is no longer running.
    if (this.registry.get(sessionId) !== session || session.status !== "running") {
      return {
        sessionId,
        round: session.currentRound,
        prompt: null,
        stopReason: session.status,
        stopDetail: `Session is no longer running (status: ${session.status}). It was paused or deleted while the next prompt was being prepared.`,
        roundSuccess,
      };
    }
    const nextPrompt = prepared.prompt;
    const nextLevel = prepared.level;
    session.roundSnapshot = prepared.snapshot;
    // v3.8.3: the round that just committed is history; the trust baseline
    // moves to the round being prepared now.
    this.seedEntrypointTrust(session);
    policyMetrics.recordStrategy(session.loopId, nextLevel);
    try {
      this.save(session);
    } catch (error) {
      // The compiled prompt still lives in memory; surface it as a stalled
      // result so a resume returns the held prompt rather than re-running
      // the committed round.
      logEvent("session_save_failed", {
        loopId: session.loopId,
        round: session.currentRound,
        error: String(error),
      });
      return this.stalledAfterCommit(
        sessionId,
        session,
        roundSuccess,
        `The round committed but the session state could not be persisted: ${String(error).slice(0, 300)}. ` +
        `Resume the loop to recover the held prompt.`,
      );
    }

    const compiled = prepared.compileResponse as
      | (LoopForgeResponse & {
          sub_goals?: SubGoal[];
          constraints_active?: string[];
          constraints_retired?: string[];
        })
      | null
      | undefined;
    return {
      sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot.roundId,
      ...this.transactionFacts(session),
      prompt: nextPrompt,
      level: nextLevel,
      roundSuccess,
      warnings: prepared.warnings ?? [],
      submission_guidance: this.guidanceFor(session),
      submission_receipt: this.buildReceipt(receiptBase, {
        disposition: "accepted",
        nextArtifact: prepared.artifact ?? compiled?.prompt_artifact ?? null,
        afterSubGoals: compiled?.sub_goals ?? null,
        constraintsActiveAfter: compiled?.constraints_active ?? null,
        constraintsRetiredAfter: compiled?.constraints_retired ?? null,
      }),
    };
  }

  /** M4: mark a session stalled after its round committed but the next
   *  prompt could not be prepared/persisted — mirrors the crash-recovery
   *  siblings (reconcileCommittedRound / resume / reject paths). The
   *  committed round stays held (roundSnapshot untouched) so a resubmission
   *  with the same roundId replays it and recompiles the next round. */
  private stalledAfterCommit(
    sessionId: string,
    session: McpSession,
    roundSuccess: boolean,
    detail: string,
    projectionError?: AdvanceResult["projectionError"],
  ): AdvanceResult {
    session.status = "stalled";
    try {
      this.save(session);
    } catch (error) {
      logEvent("session_save_failed", {
        loopId: session.loopId,
        round: session.currentRound,
        error: String(error),
      });
    }
    return {
      sessionId,
      round: session.currentRound,
      roundId: session.roundSnapshot?.roundId,
      prompt: null,
      stopReason: "stalled",
      stopDetail: detail,
      roundSuccess,
      ...(projectionError ? { projectionError } : {}),
    };
  }

  private async advanceUnlocked(
    sessionId: string,
    output: string,
    preExtractedEval?: SelfEvaluation,
    roundId?: string,
    normalizationDiagnostics?: SubmissionDiagnostic[],
    submittedFields?: string[],
    transactionId?: string,
  ): Promise<AdvanceResult> {
    // ── 1. Validate session ──────────────────────────────────────────────
    const session = this.registry.get(sessionId);
    if (!session) return { sessionId, round: 0, prompt: null, stopReason: "session_not_found", stopDetail: "No session exists with this ID. It may have expired, been deleted, or never existed." };
    if (session.status !== "running" && session.status !== "stalled") {
      return { sessionId, round: session.currentRound, prompt: null, stopReason: session.status, stopDetail: `Session is ${session.status}. Use loopforge_resume to restart a paused session, or loopforge_start for a new task.` };
    }
    // v3.9.7: a pending rollback directive with no verified redo snapshot
    // means the workspace is (or may be) mid-restore. Ordinary work must not
    // be evaluated against it. Resume completes the restore first.
    const pendingPrefix = `loop:${session.loopId}:`;
    const pendingEntries = [
      ...queryLoopEntries(this.store, session.loopId, { prefix: pendingPrefix }),
      ...queryLoopEntries(this.store, session.loopId, {
        prefix: pendingPrefix,
        feedbackOnly: true,
      }),
    ];
    const pending = pendingRollbackDirective(pendingEntries);
    if (pending?.recovery &&
        session.roundSnapshot?.restore?.directiveTransactionId !==
          pending.recovery.transaction_id) {
      return {
        sessionId,
        round: session.currentRound,
        roundId: session.roundSnapshot?.roundId,
        prompt: null,
        stopReason: "stalled",
        submissionError: {
          code: "restore_pending",
          details: {
            loopId: session.loopId,
            directive_transaction_id: pending.recovery.transaction_id,
            redo_round: pending.recovery.target.redo_round,
            detail:
              "A pending restore must be completed by loopforge_resume before work can be submitted.",
          },
        },
      };
    }
    // A stalled compiler preparation is retryable against the same held
    // round. Format errors never set this status; they return before advance.
    if (session.status === "stalled") {
      session.status = "running";
    }

    // ── 1.5 Anchor the submission to the round it reports on ─────────────
    // v3.0.1: a submission whose roundId no longer matches the current round
    // is stale — the round it reported on already committed (lost response,
    // duplicate call). Never process it against the current round; return the
    // held prompt so the agent recovers the response it missed. The reject
    // path keeps the same roundId (prepareRejectedAttempt), so retries of a
    // rejected round match normally.
    const expectedRoundId = session.roundSnapshot?.roundId
      ?? makeRoundId(session.loopId, session.currentRound);
    if (roundId !== undefined && roundId !== expectedRoundId) {
      logEvent("stale_round_id", {
        sessionId,
        loopId: session.loopId,
        submitted: roundId,
        expected: expectedRoundId,
      });
      const restored = this.restoredPromptResult(session);
      if (restored) {
        return {
          ...restored,
          warnings: [
            ...(restored.warnings ?? []),
            `Submitted roundId ${roundId} does not match the current round (${expectedRoundId}) — the round it reported on has already committed. Reusing the held prompt for round ${session.currentRound}; resubmit with its roundId when the work is done.`,
          ],
        };
      }
      return {
        sessionId,
        round: session.currentRound,
        roundId: expectedRoundId,
        prompt: null,
        stopReason: "stale_round_id",
        stopDetail: `Submitted roundId ${roundId} does not match the current round ${expectedRoundId}, and no prompt is currently held. Call loopforge_status or loopforge_resume to re-anchor.`,
      };
    }

    // v3.9.7: transaction identity. roundId anchors the logical round; the
    // transactionId anchors the exact attempt. A stale response from a
    // rejected/abandoned attempt at the SAME round must not be applied to the
    // retry. Mismatch returns the held prompt, never evaluates.
    if (transactionId !== undefined && session.roundSnapshot &&
        transactionId !== session.roundSnapshot.transactionId) {
      const restored = this.restoredPromptResult(session);
      if (restored) {
        return {
          ...restored,
          warnings: [
            ...(restored.warnings ?? []),
            `Submitted transactionId ${transactionId} does not match the current attempt (${session.roundSnapshot.transactionId}) — the held prompt is returned. Resubmit with the transactionId returned alongside it.`,
          ],
        };
      }
      return {
        sessionId,
        round: session.currentRound,
        roundId: expectedRoundId,
        prompt: null,
        stopReason: "round_id_mismatch",
        submissionError: {
          code: "round_id_mismatch",
          details: {
            reason_code: "transaction_id_mismatch",
            submitted: transactionId,
            expected: session.roundSnapshot.transactionId,
            detail: "Use the roundId and transactionId returned alongside the held prompt.",
          },
        },
      };
    }

    // ── 2. Extract self-evaluation ───────────────────────────────────────
    const extracted = this.extractEvaluation(output, preExtractedEval);
    if (!extracted) {
      return {
        sessionId,
        round: session.currentRound,
        roundId: session.roundSnapshot?.roundId
          ?? makeRoundId(session.loopId, session.currentRound),
        prompt: null,
        stopReason: "evaluation_invalid",
        stopDetail: "A structured evaluation object is required. Resubmit the same roundId with success, output_summary, constraint_violations, and should_continue.",
      };
    }
    const selfEval = extracted;

    // ── 3. Execute round transaction ─────────────────────────────────────
    // Capture the before facts from the shared compile window BEFORE the
    // transaction commits (a replay sees the same window: rounds < R).
    const beforeFacts = this.beforeFactsFor(session);
    const tx = await this.executeRoundTransaction(
      session,
      selfEval,
      normalizationDiagnostics,
      submittedFields,
    );
    const receiptSnapshot = session.roundSnapshot ?? prepareRoundTransaction(
      session.loopId,
      session.currentRound,
      [],
    );
    const receiptBase: ReceiptBase = {
      snapshot: receiptSnapshot,
      selfEval,
      pr: tx.pr,
      actualEvidence: tx.actualEvidence,
      diagnostics: receiptSnapshot.normalizationDiagnostics ??
        normalizationDiagnostics ?? [],
      submittedFields: receiptSnapshot.submittedFields ?? submittedFields ?? [],
      beforeContractId: beforeFacts.contractId,
      beforeSubGoals: beforeFacts.subGoals,
      recoveryDirective: beforeFacts.recoveryDirective,
      replayed: tx.replayed,
    };

    // v2.12: Record a user gate when an accepted round reports a high-risk
    // blocker. Record layer only — never blocks the round decision flow.
    if (tx.pr.action !== "reject" && tx.pr.action !== "terminate" &&
        declaresBlocked(selfEval) && typeof selfEval.blocker === "string") {
      this.recordGateFromBlocked(session, selfEval.blocker);
    }

    // ── 4. Route disposition ─────────────────────────────────────────────
    if (tx.pr.action === "reject") {
      return this.buildRejectionResult(
        sessionId, session, tx.pr, tx.verificationFlags, receiptBase);
    }

    // ── v2.10/v3.9.6: recovery directive (machine or agent) ───────────────
    if (tx.pr.action === "backtrack" || tx.pr.action === "recovery") {
      return this.buildBacktrackResult(sessionId, session, tx.pr, receiptBase);
    }

    // Accepted rounds advance the before-snapshot baseline. Rejected rounds
    // retain the original baseline so their retry remains zero-commit.

    // v3.8.3: completion truth — the second line, at the point the disposition
    // becomes the reported stop reason. The coordinator already guards the
    // reason it COMMITS (the round document carries result.stopReason), so
    // this guards what the client and the terminal notification see. A
    // violation can only be a code defect: it degrades to the honest reason
    // and leaves an observability record instead of throwing mid-lifecycle.
    const finalized = finalizeStopReason(tx.pr.stopReason, selfEval);
    if (finalized.reason !== tx.pr.stopReason) {
      logEvent("completion_truth_downgraded", {
        loopId: session.loopId,
        round: session.currentRound,
        from: tx.pr.stopReason ?? "",
        to: finalized.reason ?? "",
      });
    }

    if (tx.pr.action === "terminate") {
      return this.buildTerminationResult(
        sessionId, session, tx.pr, finalized.reason, receiptBase);
    }
    if (tx.pr.action === "stop") {
      return this.buildStopResult(
        sessionId, session, tx.pr, finalized.reason, receiptBase);
    }

    // ── 5. Continue — compile next round ─────────────────────────────────
    return this.advanceToNextRound(
      sessionId, session, selfEval, tx.pr,
      tx.actualEvidence, receiptBase,
    );
  }

  /** v3.9.6: Agent-initiated recovery. The Agent selects the target; this
   *  method only validates it against committed facts, records the rollback
   *  directive and compiles the redo. It never runs ordinary verification or
   *  enforcement on the abandoned work. */
  async recover(
    sessionId: string,
    recovery: RecoveryRequest,
    roundId?: string,
  ): Promise<AdvanceResult> {
    const session = this.registry.get(sessionId);
    if (!session) {
      return {
        sessionId,
        round: 0,
        prompt: null,
        stopReason: "session_not_found",
        stopDetail: "No session exists with this ID.",
      };
    }
    if (session.status !== "running" && session.status !== "stalled") {
      return {
        sessionId,
        round: session.currentRound,
        prompt: null,
        stopReason: session.status,
        stopDetail: `Session is ${session.status}.`,
      };
    }
    if (!getPolicy().engine.agent_recovery_enabled) {
      return {
        sessionId,
        round: session.currentRound,
        prompt: null,
        submissionError: {
          code: "recovery_disabled",
          details: { policy: "engine.agent_recovery_enabled" },
        },
      };
    }
    const expectedRoundId = session.roundSnapshot?.roundId
      ?? makeRoundId(session.loopId, session.currentRound);
    if (typeof roundId !== "string" || roundId.trim().length === 0) {
      return {
        sessionId,
        round: session.currentRound,
        roundId: expectedRoundId,
        prompt: null,
        submissionError: {
          code: "round_id_required",
          details: { detail: "recovery requires the roundId from the held prompt" },
        },
      };
    }
    if (roundId !== expectedRoundId) {
      const restored = this.restoredPromptResult(session);
      if (restored) {
        return {
          ...restored,
          warnings: [
            ...(restored.warnings ?? []),
            `Submitted roundId ${roundId} does not match the current round (${expectedRoundId}); the held prompt is returned.`,
          ],
        };
      }
      return {
        sessionId,
        round: session.currentRound,
        roundId: expectedRoundId,
        prompt: null,
        stopReason: "round_id_mismatch",
        stopDetail: `Submitted roundId ${roundId} does not match the current round ${expectedRoundId}.`,
      };
    }
    const held = session.roundSnapshot;
    if (held?.kind !== "evaluation" || held.round !== session.currentRound) {
      return {
        sessionId,
        round: session.currentRound,
        prompt: null,
        submissionError: {
          code: "recovery_invalid",
          details: {
            reason_code: "no_held_evaluation",
            detail: "recovery requires a held evaluation prompt for the current round",
          },
        },
      };
    }

    const prefix = `loop:${session.loopId}:`;
    const entries: VaultEntry[] = [
      ...queryLoopEntries(this.store, session.loopId, { prefix }),
      ...queryLoopEntries(this.store, session.loopId, { prefix, feedbackOnly: true }),
    ];
    if (pendingRollbackDirective(entries, session.currentRound)) {
      const restored = this.restoredPromptResult(session);
      if (restored) {
        return {
          ...restored,
          warnings: [
            ...(restored.warnings ?? []),
            "A recovery checkpoint is already pending for this redo; restore the workspace and submit it before starting another recovery.",
          ],
        };
      }
    }

    const resolved = resolveRecoveryTarget(
      entries,
      session.currentRound,
      recovery.target_round,
    );
    if (!resolved.ok) {
      return {
        sessionId,
        round: session.currentRound,
        roundId: held.roundId,
        prompt: null,
        submissionError: {
          code: resolved.code,
          details: {
            target_round: recovery.target_round,
            reason_code: resolved.reason,
            detail: resolved.detail,
            current_round: session.currentRound,
          },
        },
      };
    }

    const transactionId = deriveTransactionId({
      kind: "rollback",
      branchId: held.branchId ?? rootBranchId(session.loopId),
      roundId: held.roundId,
      attempt: 1,
      promptHash: held.promptArtifact?.promptHash,
      recovery: {
        target: resolved.target.view.round,
        reason: recovery.reason,
        target_transaction_id: resolved.target.view.transactionId ??
          resolved.target.view.roundId,
      },
    });
    const abandoned = branchRounds(entries).filter((view) =>
      view.round > resolved.target.view.round &&
      view.round < session.currentRound,
    );
    const beforeFacts = this.beforeFactsFor(session);
    const beforeSnapshot = held;
    const completed = await new RoundDriver(
      session.engine,
      this.store,
    ).completeRecovery({
      snapshot: beforeSnapshot,
      loopId: session.loopId,
      buildRecovery: (actualEvidence) => deriveRecoveryDirective({
        origin: "agent",
        reason: recovery.reason,
        transactionId,
        target: resolved.target,
        abandonedRounds: abandoned,
        currentRound: session.currentRound,
        beforeEvidence: beforeSnapshot.beforeEvidence,
        afterEvidence: actualEvidence,
      }),
    });
    const pr = completed.outcome.result;
    const receiptBase: ReceiptBase = {
      snapshot: completed.outcome.snapshot,
      // Receipt-only placeholder: the directive has no evaluation and the
      // receipt's `record` is rollback_directive / entered_history:false.
      selfEval: {
        success: false,
        output_summary: "",
        constraint_violations: [],
        should_continue: true,
      },
      pr,
      actualEvidence: completed.actualEvidence,
      diagnostics: [],
      submittedFields: [],
      beforeContractId: beforeFacts.contractId,
      beforeSubGoals: beforeFacts.subGoals,
      // This receipt reports the directive itself, never a redo checkpoint.
      recoveryDirective: null,
      replayed: completed.outcome.replayed,
    };
    return this.buildBacktrackResult(sessionId, session, pr, receiptBase);
  }

  /** Core cycle entry used by SessionManager.advance after the queue + lease
   *  dance: validate → extract → execute transaction → route disposition
   *  → advance to next round (continue) or return terminal result.
   *  @param roundId v3.0.1: the roundId of the round this submission reports
   *    on (from the last start/next/resume response). Anchors the submission;
   *    a stale or duplicate submission returns the held prompt instead of
   *    being processed. Optional — when absent the anchor check is skipped. */
  async advance(
    sessionId: string,
    output: string,
    preExtractedEval?: SelfEvaluation,
    roundId?: string,
    normalizationDiagnostics?: SubmissionDiagnostic[],
    submittedFields?: string[],
    transactionId?: string,
  ): Promise<AdvanceResult> {
    return this.advanceUnlocked(
      sessionId,
      output,
      preExtractedEval,
      roundId,
      normalizationDiagnostics,
      submittedFields,
      transactionId,
    );
  }

  /** Write back loop knowledge to long-term memory.
   *  Uses shared base builder from policy.ts. Called when a loop terminates. */
  async notifyTerminal(
    session: McpSession,
    stopReason: string,
  ): Promise<void> {
    if (this.terminalSinks.size === 0) return;
    const prefix = `loop:${session.loopId}:`;
    const entries = [
      ...queryLoopEntries(this.store, session.loopId, { prefix }),
      ...queryLoopEntries(this.store, session.loopId, { prefix, feedbackOnly: true }),
    ];
    const views = readOnlyRounds(entries);
    const successTrajectory = views
      .filter((view) => view.result?.shouldPushSuccessTrajectory === true)
      .map((view) => view.success);
    const lastEvaluation = views.length > 0
      ? views[views.length - 1]!.evaluation ?? undefined
      : undefined;
    const event: LoopTerminalEvent = {
      loopId: session.loopId,
      task: session.task,
      success: stopReason === "completed",
      stopReason: stopReason as LoopTerminalEvent["stopReason"],
      roundsCompleted: session.currentRound,
      successTrajectory,
      lastEvaluation,
    };
    await Promise.allSettled(
      [...this.terminalSinks].map((sink) => Promise.resolve(sink(event))),
    );
  }
}
