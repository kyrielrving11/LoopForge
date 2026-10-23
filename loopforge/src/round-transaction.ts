/** Schema-versioned round transaction shared by Runtime and MCP.
 *
 * A logical round has one deterministic roundId. Rejected attempts keep the
 * same identity and before snapshot; only accepted decisions are committed to
 * feedback storage. The committed feedback embeds the decision so replay after
 * a process crash is idempotent.
 */

import { createHash } from "node:crypto";
import { queryLoopEntries } from "./loop-store.js";
import type { LoopStore, VaultEntry } from "./loop-store.js";
import { LoopForgeEngine } from "./engine.js";
import { deriveObservationDeltas } from "./evidence-provider.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type {
  CheckpointRef,
  ContractBinding,
  MachineObservation,
  OperatorAcceptance,
  PromptArtifact,
  RecoveryDirective,
  RecoveryTarget,
  RoundContractProposal,
  SelfEvaluation,
  SubmissionDiagnostic,
  WorkspaceCheckpointManifest,
} from "./protocol.js";
import {
  RoundCoordinator,
  type RoundProcessResult,
} from "./round-coordinator.js";
import { logEvent } from "./observability.js";
import { deriveContractId, deriveContractItemIds, isRecord } from "./token-utils.js";
import {
  GIT_OBSERVATION_SCHEMA_VERSION,
  PROMPT_ARTIFACT_SCHEMA_VERSION,
} from "./protocol.js";
import { commandConfigHash, getPolicy } from "./policy.js";
import { policyMetrics } from "./policy-metrics.js";
import { VaultRoundCommitStore } from "./storage.js";
import type { RoundCommitStore } from "./storage.js";

/** v3.9.7: schema 5 adds the transaction before-image, explicit mid-round
 *  checkpoints and the redo restore marker. Schema 4 is unsupported and is
 *  reported by `legacyTransactionRounds`; there is no compatibility migration. */
export const ROUND_TRANSACTION_SCHEMA_VERSION = 5 as const;

/** Maximum distinct mid-round checkpoints one transaction may reference. */
export const MAX_MID_CHECKPOINTS_PER_TRANSACTION = 32;

/** The root branch identity for every loop. */
export function rootBranchId(loopId: string): string {
  return `loop:${loopId}:branch:root`;
}

/** v3.9.6: deterministic transaction identity. The logical round identity is
 *  still `roundId`; this id prevents a deep redo from replaying an abandoned
 *  commit at the same numeric round. */
export function deriveTransactionId(input: {
  kind: "evaluation" | "rollback";
  branchId: string;
  roundId: string;
  attempt: number;
  promptHash?: string;
  recovery?: { target: RecoveryTarget; reason: string };
}): string {
  const payload = [
    input.kind,
    input.branchId,
    input.roundId,
    String(input.attempt),
    input.promptHash ?? "",
    input.kind === "rollback" && input.recovery
      ? [
          input.recovery.target.checkpoint_id,
          input.recovery.target.content_hash,
          String(input.recovery.target.redo_round),
          input.recovery.reason,
          input.recovery.target.transaction_id,
        ].join("\n")
      : "",
  ].join("\n");
  return `tx-${createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

/** v3.8: the closed set of machine-observation statuses. */
const OBSERVATION_STATUSES = [
  "observed", "passed", "failed", "timeout", "unavailable", "error", "aborted",
] as const;

export type RoundTransactionPhase =
  | "prepared"
  | "prompted"
  | "evaluated"
  | "rejected"
  | "committed"
  | "terminated";

export interface RoundTransactionSnapshot {
  schemaVersion: typeof ROUND_TRANSACTION_SCHEMA_VERSION;
  /** v3.9.6: the transaction's branch. The root branch is
   *  `loop:<loopId>:branch:root`; a rollback directive's transactionId names
   *  the child branch used by its redo and all later transactions. */
  branchId: string;
  /** v3.9.6: stable identity of this transaction. `roundId` remains the
   *  logical round; `transactionId` distinguishes a redo from an abandoned
   *  commit at the same numeric round. */
  transactionId: string;
  /** v3.9.6: evaluations are normal work rounds; rollbacks are directives
   *  that abandon a round without claiming work. */
  kind: "evaluation" | "rollback";
  roundId: string;
  loopId: string;
  round: number;
  attempt: number;
  phase: RoundTransactionPhase;
  beforeEvidence: MachineObservation[];
  afterEvidence?: MachineObservation[];
  evaluation?: SelfEvaluation;
  /** v3.9.6: operator acceptance, written once on the root branch's round 1
   *  evaluation transaction. Absent on every later transaction. */
  operatorAcceptance?: OperatorAcceptance;
  /** v3.9.6: committed rollback directive facts (rollback kind only). */
  recovery?: RecoveryDirective;
  result?: RoundProcessResult;
  /** v3.9.1: every lossy normalization decision for this submission. Saved
   *  with the transaction; strict boundary failures never reach here. */
  normalizationDiagnostics?: SubmissionDiagnostic[];
  /** v3.9.1: the known evaluation paths present in the raw submission. The
   *  receipt uses this manifest; unknown paths live in diagnostics only. */
  submittedFields?: string[];
  /** v3.9.7: the automatic transaction before-image. Required when the
   *  before-phase Git boundary was observed and materialized. */
  beforeCheckpoint?: CheckpointRef;
  /** v3.9.7: explicit machine fact when the automatic before-image failed.
   *  The round may continue; it is simply not a recovery target. */
  beforeCheckpointError?: {
    code: string;
    detail: string;
    at: number;
  };
  /** v3.9.7: Agent-created mid-round savepoints, creation order, capped. */
  checkpoints?: CheckpointRef[];
  /** v3.9.7: only on the redo transaction. Proves this round's before state
   *  was produced by a verified restore of the named directive. The target
   *  checkpoint id/hash live only in the directive. */
  restore?: {
    directiveTransactionId: string;
    redoRound: number;
    verifiedAt: number;
  };
  /** v3.8: the contract binding resolved at commit time (see ContractBinding).
   *  Absent when the committing round declared no contract. */
  contractBinding?: ContractBinding;
  createdAt: number;
  updatedAt: number;
  /** Exact prompt delivered for the current attempt. */
  promptArtifact?: PromptArtifact;
}

export interface RoundTransactionInput {
  snapshot: RoundTransactionSnapshot;
  task: string;
  maxRounds: number;
  selfEval: SelfEvaluation;
  consecutiveRejections: number;
  /** L4 (v3.7.x): previous round's rejection check (own-streak basis). */
  lastRejectionCheck?: string;
  /** v3.8.3: trusted round-start entrypoint fingerprints (see RoundProcessInput). */
  entrypointTrust?: Record<string, string>;
  /** v3.9.1: normalization metadata carried into the evaluated snapshot. */
  normalizationDiagnostics?: SubmissionDiagnostic[];
  submittedFields?: string[];
  actualEvidence: MachineObservation[];
  /** The in-flight transaction's before-image, for machine backtrack target
   *  mapping. Never a cognitive input. */
  beforeCheckpoint?: CheckpointRef;
  /** Reads a checkpoint manifest from the store (machine backtrack only). */
  resolveCheckpointManifest?: (ref: CheckpointRef) => WorkspaceCheckpointManifest | null;
}

export interface RoundTransactionOutcome {
  snapshot: RoundTransactionSnapshot;
  result: RoundProcessResult;
  /** true when a prior committed decision was replayed from the vault. */
  replayed: boolean;
}

/** v3.9.6: a first-class rollback directive. `snapshot` is the held
 *  evaluation snapshot of the abandoned round; `recovery.transaction_id` is
 *  both the directive transaction and the child branch identity. */
export interface RecoveryTransactionInput {
  snapshot: RoundTransactionSnapshot;
  loopId: string;
  recovery: RecoveryDirective;
  actualEvidence: MachineObservation[];
}

/** v3.8/v3.9.1: The round's observation delta (before → after). Each entry
 *  carries raw before/after references; Git's `changedFiles` is the only
 *  file-change fact and is null when the pair cannot be compared. DERIVED,
 *  never persisted: the transaction stores only the two factual observation
 *  collections, and every reader (gates, metrics, git-motion series, replay,
 *  audit) consumes this one derivation. */
export function deriveRoundObservationDelta(
  before: MachineObservation[],
  after: MachineObservation[],
): ObservationDelta[] {
  return deriveObservationDeltas(before, after);
}

/** v3.8: The schema version stamped on a persisted transaction envelope, or
 *  null when the value is not a transaction envelope at all. Used to surface
 *  legacy documents explicitly instead of letting them vanish from history. */
export function transactionSchemaVersionOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  return typeof value.schemaVersion === "number" ? value.schemaVersion : null;
}

/** v3.8: Resolve the machine binding a contract proposal carries at commit. */
function resolveContractBinding(
  proposal: RoundContractProposal | undefined,
  loopId: string,
): ContractBinding | undefined {
  if (!proposal || !Array.isArray(proposal.items) || proposal.items.length === 0) {
    return undefined;
  }
  const commands = getPolicy().evidence.commands ?? [];
  const byName = new Map(commands.map((command) => [command.name, command]));
  const configHashByCommand: Record<string, string> = {};
  for (const item of proposal.items) {
    for (const commandId of item.verify_with ?? []) {
      const command = byName.get(commandId);
      if (command) configHashByCommand[commandId] = commandConfigHash(command);
    }
  }
  return {
    rc_id: deriveContractId(loopId, proposal),
    item_ids: deriveContractItemIds(proposal.items),
    config_hash_by_command: configHashByCommand,
  };
}

export function makeRoundId(loopId: string, round: number): string {
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`Invalid round number: ${round}`);
  }
  return `loop:${loopId}:round:${round}`;
}

export function prepareRoundTransaction(
  loopId: string,
  round: number,
  beforeEvidence: MachineObservation[],
  promptArtifact?: PromptArtifact,
  opts: {
    branchId?: string;
    operatorAcceptance?: OperatorAcceptance;
    kind?: "evaluation";
    beforeCheckpoint?: CheckpointRef;
    beforeCheckpointError?: { code: string; detail: string; at: number };
  } = {},
): RoundTransactionSnapshot {
  const now = Date.now();
  const roundId = makeRoundId(loopId, round);
  const branchId = opts.branchId ?? rootBranchId(loopId);
  const kind = opts.kind ?? "evaluation";
  const observedGit = beforeEvidence.some((observation) =>
    observation.kind === "git" && observation.status === "observed");
  // A direct library caller may have no checkpoint store attached. The
  // schema-5 invariant still records the explicit machine fact.
  const beforeCheckpointError = opts.beforeCheckpointError ??
    (observedGit && !opts.beforeCheckpoint
      ? {
          code: "store_unavailable",
          detail: "no workspace checkpoint store was attached to this prepare",
          at: now,
        }
      : undefined);
  return {
    schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
    branchId,
    transactionId: deriveTransactionId({
      kind,
      branchId,
      roundId,
      attempt: 1,
      promptHash: promptArtifact?.promptHash,
    }),
    kind,
    roundId,
    loopId,
    round,
    attempt: 1,
    phase: promptArtifact ? "prompted" : "prepared",
    beforeEvidence,
    ...(opts.beforeCheckpoint ? { beforeCheckpoint: opts.beforeCheckpoint } : {}),
    ...(beforeCheckpointError ? { beforeCheckpointError } : {}),
    ...(opts.operatorAcceptance
      ? { operatorAcceptance: opts.operatorAcceptance }
      : {}),
    createdAt: now,
    updatedAt: now,
    promptArtifact,
  };
}

/** Attach the next prompt attempt to a rejected logical round without changing
 * its identity or evidence baseline. Evaluation fields belong to the previous
 * attempt and are cleared before the Agent receives the retry prompt. */
export function prepareRejectedAttempt(
  rejected: RoundTransactionSnapshot,
  promptArtifact: PromptArtifact,
): RoundTransactionSnapshot {
  if (rejected.phase !== "rejected") {
    throw new Error(`Cannot retry transaction in phase ${rejected.phase}`);
  }
  if (promptArtifact.roundId !== rejected.roundId) {
    throw new Error(
      `Retry prompt identity mismatch: ${promptArtifact.roundId} !== ${rejected.roundId}`,
    );
  }
  if (promptArtifact.attempt !== rejected.attempt + 1) {
    throw new Error(
      `Retry prompt attempt mismatch: ${promptArtifact.attempt} !== ${rejected.attempt + 1}`,
    );
  }
  const transactionId = deriveTransactionId({
    kind: rejected.kind,
    branchId: rejected.branchId,
    roundId: rejected.roundId,
    attempt: promptArtifact.attempt,
    promptHash: promptArtifact.promptHash,
  });
  // The round-start before-image is the SAME workspace state across attempts;
  // only its owning transaction identity changes. Mid-round savepoints belong
  // to the rejected attempt and are not carried into the retry.
  const beforeCheckpoint = rejected.beforeCheckpoint
    ? { ...rejected.beforeCheckpoint, transactionId }
    : undefined;
  return {
    ...rejected,
    transactionId,
    ...(beforeCheckpoint ? { beforeCheckpoint } : {}),
    ...(rejected.beforeCheckpointError
      ? { beforeCheckpointError: rejected.beforeCheckpointError }
      : {}),
    ...(rejected.restore ? { restore: rejected.restore } : {}),
    attempt: promptArtifact.attempt,
    phase: "prompted",
    afterEvidence: undefined,
    evaluation: undefined,
    result: undefined,
    checkpoints: undefined,
    // The rejected attempt's diagnostics were returned in its receipt; the
    // retry has not submitted a new payload yet.
    normalizationDiagnostics: undefined,
    submittedFields: undefined,
    promptArtifact,
    updatedAt: Date.now(),
  };
}


/** v3.8: Shape check for a persisted contract binding. */
function isContractBinding(value: unknown): value is ContractBinding {
  if (!isRecord(value)) return false;
  if (typeof value.rc_id !== "string" || !Array.isArray(value.item_ids)) return false;
  if (!value.item_ids.every((id) => typeof id === "string")) return false;
  return isRecord(value.config_hash_by_command);
}

export function isProcessResult(value: unknown): value is RoundProcessResult {
  if (!isRecord(value)) return false;
  return ["continue", "stop", "reject", "terminate", "backtrack", "recovery"].includes(
    String(value.action),
  ) && Array.isArray(value.verificationFlags);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOperatorAcceptance(value: unknown): value is OperatorAcceptance {
  if (!isRecord(value)) return false;
  return typeof value.task === "string" &&
    stringArray(value.success_criteria) &&
    stringArray(value.hard_constraints);
}

function isCheckpointRole(value: unknown): value is "before" | "mid" {
  return value === "before" || value === "mid";
}

const CHECKPOINT_ID_RE = /^ck-[a-f0-9]{24}$/;
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;

function isCheckpointRef(value: unknown): value is CheckpointRef {
  if (!isRecord(value)) return false;
  if (typeof value.checkpointId !== "string" ||
      !CHECKPOINT_ID_RE.test(value.checkpointId)) return false;
  if (typeof value.contentHash !== "string" ||
      !CONTENT_HASH_RE.test(value.contentHash)) return false;
  if (!isCheckpointRole(value.role)) return false;
  if (!Number.isInteger(value.round) || (value.round as number) < 1) return false;
  if (typeof value.roundId !== "string" || value.roundId.length === 0) return false;
  if (typeof value.transactionId !== "string" || value.transactionId.length === 0) return false;
  if (typeof value.branchId !== "string" || value.branchId.length === 0) return false;
  if (!Number.isInteger(value.redoRound) || (value.redoRound as number) < 1) return false;
  if (typeof value.createdAt !== "number") return false;
  return true;
}

function isRecoveryTarget(value: unknown): value is RecoveryTarget {
  if (!isRecord(value)) return false;
  if (typeof value.checkpoint_id !== "string" ||
      !CHECKPOINT_ID_RE.test(value.checkpoint_id)) return false;
  if (typeof value.content_hash !== "string" ||
      !CONTENT_HASH_RE.test(value.content_hash)) return false;
  if (!isCheckpointRole(value.role)) return false;
  if (!Number.isInteger(value.round) || (value.round as number) < 1) return false;
  if (typeof value.round_id !== "string" || value.round_id.length === 0) return false;
  if (typeof value.transaction_id !== "string" || value.transaction_id.length === 0) return false;
  if (!Number.isInteger(value.redo_round) || (value.redo_round as number) < 1) return false;
  return true;
}

function isRecoveryDirective(value: unknown): value is RecoveryDirective {
  if (!isRecord(value)) return false;
  if (value.origin !== "agent" && value.origin !== "machine") return false;
  if (typeof value.reason !== "string" || typeof value.transaction_id !== "string") {
    return false;
  }
  if (!isRecoveryTarget(value.target)) return false;
  if (value.trigger_rule !== undefined && typeof value.trigger_rule !== "string") return false;
  if (!stringArray(value.skipped_files) ||
      !stringArray(value.skipped_discoveries) ||
      !stringArray(value.approaches) ||
      !stringArray(value.wrong_assumptions)) return false;
  if (!Array.isArray(value.failed_rounds) ||
      !value.failed_rounds.every((item) => Number.isInteger(item))) return false;
  return true;
}

function isBeforeCheckpointError(
  value: unknown,
): value is { code: string; detail: string; at: number } {
  if (!isRecord(value)) return false;
  return typeof value.code === "string" &&
    typeof value.detail === "string" &&
    typeof value.at === "number";
}

function isRestoreMarker(
  value: unknown,
): value is { directiveTransactionId: string; redoRound: number; verifiedAt: number } {
  if (!isRecord(value)) return false;
  return typeof value.directiveTransactionId === "string" &&
    value.directiveTransactionId.length > 0 &&
    Number.isInteger(value.redoRound) &&
    (value.redoRound as number) >= 1 &&
    typeof value.verifiedAt === "number";
}

function parseMachineObservations(value: unknown): MachineObservation[] | null {
  if (!Array.isArray(value)) return null;
  const observations: MachineObservation[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (
      typeof item.providerId !== "string" ||
      (item.kind !== "git" && item.kind !== "command" && item.kind !== "custom") ||
      (item.phase !== "before" && item.phase !== "after") ||
      typeof item.startedAt !== "number" ||
      typeof item.finishedAt !== "number" ||
      !(OBSERVATION_STATUSES as readonly string[]).includes(String(item.status)) ||
      !Array.isArray(item.files) ||
      !item.files.every((file) => typeof file === "string") ||
      !isRecord(item.data)
    ) return null;
    // v3.9.1: Git observations moved to schema 2 (complete boundary
    // fingerprints); command/custom observations remain schema 1. A
    // mismatched Git observation is a hard break, reported by
    // legacyTransactionRounds as an "observation" envelope loss.
    const expectedVersion = item.kind === "git"
      ? GIT_OBSERVATION_SCHEMA_VERSION
      : 1;
    if (item.schemaVersion !== expectedVersion) return null;
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
    if (item.kind === "custom" &&
        (item.data.progressCapable !== undefined ||
         item.data.progress !== undefined)) {
      if (item.data.progressCapable !== true) return null;
      const progress = item.data.progress;
      if (progress !== null) {
        if (!isRecord(progress) ||
            progress.schemaVersion !== 1 ||
            typeof progress.fingerprint !== "string" ||
            !/^[a-f0-9]{64}$/.test(progress.fingerprint)) {
          return null;
        }
      }
    }
    observations.push(item as unknown as MachineObservation);
  }
  return observations;
}

/** Parse a persisted snapshot without trusting arbitrary vault data. */
export function parseRoundTransactionSnapshot(
  value: unknown,
): RoundTransactionSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== ROUND_TRANSACTION_SCHEMA_VERSION) return null;
  if (value.kind !== "evaluation" && value.kind !== "rollback") return null;
  if (typeof value.branchId !== "string" || value.branchId.length === 0) return null;
  if (typeof value.transactionId !== "string" || value.transactionId.length === 0) {
    return null;
  }
  if (value.operatorAcceptance !== undefined &&
      !isOperatorAcceptance(value.operatorAcceptance)) return null;
  if (value.kind === "rollback") {
    if (!isRecoveryDirective(value.recovery)) return null;
  } else if (value.recovery !== undefined) {
    return null;
  }
  if (typeof value.roundId !== "string" || typeof value.loopId !== "string") {
    return null;
  }
  if (!Number.isInteger(value.round) || (value.round as number) < 1) return null;
  if (!Number.isInteger(value.attempt) || (value.attempt as number) < 1) return null;
  if (
    !["prepared", "prompted", "evaluated", "rejected", "committed", "terminated"]
      .includes(String(value.phase))
  ) return null;
  const beforeEvidence = parseMachineObservations(value.beforeEvidence);
  if (!beforeEvidence) return null;
  const afterEvidence = value.afterEvidence === undefined
    ? undefined
    : parseMachineObservations(value.afterEvidence);
  if (value.afterEvidence !== undefined && !afterEvidence) return null;
  const snapshotRound = value.round as number;
  const snapshotRoundId = value.roundId as string;
  const snapshotTransactionId = value.transactionId as string;
  const snapshotBranchId = value.branchId as string;
  if (value.kind === "rollback") {
    // A rollback directive may carry the abandoned transaction's evidence,
    // but never that transaction's savepoints or restore marker. The
    // directive's `target` is the only checkpoint reference.
    if (value.beforeCheckpoint !== undefined ||
        value.beforeCheckpointError !== undefined ||
        value.checkpoints !== undefined ||
        value.restore !== undefined) return null;
  } else {
    if (value.beforeCheckpoint !== undefined) {
      if (!isCheckpointRef(value.beforeCheckpoint)) return null;
      const ref = value.beforeCheckpoint;
      if (ref.role !== "before" ||
          ref.round !== snapshotRound ||
          ref.roundId !== snapshotRoundId ||
          ref.transactionId !== snapshotTransactionId ||
          ref.branchId !== snapshotBranchId ||
          ref.redoRound !== snapshotRound) return null;
    }
    if (value.beforeCheckpointError !== undefined &&
        !isBeforeCheckpointError(value.beforeCheckpointError)) return null;
    if ((value.beforeCheckpoint === undefined) ===
        (value.beforeCheckpointError === undefined)) {
      const observedGitBefore = beforeEvidence.some(
        (observation) => observation.kind === "git" && observation.status === "observed",
      );
      // A Git-observed transaction owes a before-image or an explicit error.
      if (observedGitBefore) return null;
    }
    if (value.checkpoints !== undefined) {
      if (!Array.isArray(value.checkpoints) ||
          value.checkpoints.length > MAX_MID_CHECKPOINTS_PER_TRANSACTION) return null;
      const seen = new Set<string>();
      for (const item of value.checkpoints) {
        if (!isCheckpointRef(item)) return null;
        if (item.role !== "mid" ||
            item.round !== snapshotRound ||
            item.roundId !== snapshotRoundId ||
            item.transactionId !== snapshotTransactionId ||
            item.branchId !== snapshotBranchId ||
            item.redoRound !== snapshotRound) return null;
        if (seen.has(item.checkpointId)) return null;
        seen.add(item.checkpointId);
      }
    }
    if (value.restore !== undefined) {
      if (!isRestoreMarker(value.restore)) return null;
      if (value.restore.redoRound !== snapshotRound) return null;
      if (value.restore.directiveTransactionId !== snapshotBranchId) return null;
    }
  }
  if (value.result !== undefined && !isProcessResult(value.result)) return null;
  if (value.contractBinding !== undefined && !isContractBinding(value.contractBinding)) return null;
  if (value.normalizationDiagnostics !== undefined) {
    if (!Array.isArray(value.normalizationDiagnostics) ||
        value.normalizationDiagnostics.length > 200) return null;
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
  // A normalized/committed evaluation always carries its attempted manifest.
  // A rollback directive is not an evaluation and has no manifest.
  if (value.kind === "evaluation" &&
      (value.phase === "evaluated" || value.phase === "committed") &&
      value.submittedFields === undefined) {
    return null;
  }
  if (value.promptArtifact !== undefined) {
    if (!isRecord(value.promptArtifact)) return null;
    const artifact = value.promptArtifact;
    // v3.9.1: schema 3 adds prompt-request render effects. An unsupported
    // artifact version is a HARD break: a round whose envelope does not parse
    // is not committed history, and `legacyTransactionRounds` reports the
    // loss explicitly instead of the loop looking complete while rounds are
    // missing.
    // v3.9.4: schema 4 requires the ID-level coverage proof. A missing or
    // malformed coverage object is a hard break, never an empty projection.
    const coverage = artifact.coverage;
    const coverageValid =
      isRecord(coverage) &&
      Array.isArray(coverage.active) &&
      coverage.active.every((entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.kind === "string") &&
      Array.isArray(coverage.rendered) &&
      coverage.rendered.every((id) => typeof id === "string") &&
      Array.isArray(coverage.omitted) &&
      coverage.omitted.every((entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.reason === "string") &&
      typeof coverage.complete === "boolean";
    const effectsValid = artifact.promptRequestEffects === undefined ||
      (Array.isArray(artifact.promptRequestEffects) &&
        artifact.promptRequestEffects.every((effect) =>
          isRecord(effect) &&
          (effect.field === "emphasize" || effect.field === "confusion_points") &&
          typeof effect.request === "string" &&
          ["applied", "no_match", "level_ignored", "capped", "ambiguous"]
            .includes(String(effect.status)) &&
          (effect.matched_ids === undefined ||
            (Array.isArray(effect.matched_ids) &&
              effect.matched_ids.every((id) => typeof id === "string"))) &&
          (effect.matched_count === undefined ||
            typeof effect.matched_count === "number")));
    if (
      artifact.schemaVersion !== PROMPT_ARTIFACT_SCHEMA_VERSION ||
      typeof artifact.roundId !== "string" ||
      typeof artifact.renderedPrompt !== "string" ||
      typeof artifact.promptHash !== "string" ||
      typeof artifact.stateHash !== "string" ||
      !["l0", "l1", "l2"].includes(String(artifact.level)) ||
      !coverageValid ||
      !effectsValid
    ) return null;
  }

  const snapshot = {
    ...value,
    beforeEvidence,
    afterEvidence,
  } as unknown as RoundTransactionSnapshot;
  if (snapshot.roundId !== makeRoundId(snapshot.loopId, snapshot.round)) {
    return null;
  }
  return snapshot;
}

export class RoundTransactionCoordinator {
  private readonly store: LoopStore;
  private readonly commitStore: RoundCommitStore;

  constructor(
    private readonly engine: LoopForgeEngine,
    store?: LoopStore,
    commitStore?: RoundCommitStore,
  ) {
    this.store = store ?? engine.getStore();
    this.commitStore = commitStore ?? new VaultRoundCommitStore(this.store);
  }

  process(input: RoundTransactionInput): RoundTransactionOutcome {
    const { snapshot } = input;
    const finish = (outcome: RoundTransactionOutcome): RoundTransactionOutcome => {
      policyMetrics.recordRound(
        snapshot.loopId,
        outcome.result,
        outcome.replayed,
      );
      return outcome;
    };
    const expectedRoundId = makeRoundId(snapshot.loopId, snapshot.round);
    if (snapshot.roundId !== expectedRoundId) {
      throw new Error(
        `Round snapshot identity mismatch: ${snapshot.roundId} !== ${expectedRoundId}`,
      );
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
    const roundDeltas = deriveRoundObservationDelta(
      snapshot.beforeEvidence,
      input.actualEvidence,
    );
    const coordinator = new RoundCoordinator(this.store);
    const result = coordinator.processRound({
      loopId: snapshot.loopId,
      task: input.task,
      currentRound: snapshot.round,
      maxRounds: input.maxRounds,
      selfEval: input.selfEval,
      consecutiveRejections: input.consecutiveRejections,
      lastRejectionCheck: input.lastRejectionCheck,
      evidenceDeltas: roundDeltas,
      beforeEvidence: snapshot.beforeEvidence,
      entrypointTrust: input.entrypointTrust,
      // v3.9.4: the SAME manifest the receipt reads.
      submittedFields: input.submittedFields ?? snapshot.submittedFields,
      ...(input.beforeCheckpoint ? { beforeCheckpoint: input.beforeCheckpoint } : {}),
      afterEvidence: input.actualEvidence,
      ...(input.resolveCheckpointManifest
        ? { resolveCheckpointManifest: input.resolveCheckpointManifest }
        : {}),
    });

    const evaluated: RoundTransactionSnapshot = {
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
      const terminalPhase: RoundTransactionPhase =
        result.action === "reject" ? "rejected" : "terminated";
      return finish({
        snapshot: { ...evaluated, phase: terminalPhase, updatedAt: Date.now() },
        result,
        replayed: false,
      });
    }
    if ((result.action === "recovery" || result.action === "backtrack") && result.recovery) {
      const recovery = {
        ...result.recovery,
        transaction_id: deriveTransactionId({
          kind: "rollback",
          branchId: snapshot.branchId,
          roundId: snapshot.roundId,
          attempt: 1,
          promptHash: snapshot.promptArtifact?.promptHash,
          recovery: {
            target: result.recovery.target,
            reason: result.recovery.reason,
          },
        }),
      };
      return this.commitRecovery({
        snapshot,
        loopId: snapshot.loopId,
        recovery,
        actualEvidence: input.actualEvidence,
      });
    }

    const committedSnapshot: RoundTransactionSnapshot = {
      ...evaluated,
      phase: "committed",
      // v3.8: the contract binding is resolved HERE, at commit time, because
      // the command configuration in force at declaration is not recoverable
      // from the Vault afterwards. Machine-recomputed — never agent-supplied.
      ...(() => {
        const binding = resolveContractBinding(
          input.selfEval.round_contract,
          snapshot.loopId,
        );
        return binding ? { contractBinding: binding } : {};
      })(),
      updatedAt: Date.now(),
    };
    const metadata: Record<string, unknown> = {
      schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
      round_id: snapshot.roundId,
      snapshot: committedSnapshot,
      result,
    };

    this.engine.autoFeedback(
      input.selfEval,
      snapshot.loopId,
      snapshot.round,
      input.task,
      metadata,
    );
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

  /** v3.9.6: commit an Agent-initiated rollback directive. This path does not
   *  run verification or enforcement: abandoning work is an action, not a
   *  success claim. The directive is a typed event, not a `:feedback` round. */
  commitRecovery(input: RecoveryTransactionInput): RoundTransactionOutcome {
    const { snapshot, recovery } = input;
    if (snapshot.kind !== "evaluation") {
      throw new Error(`Cannot recover from a ${snapshot.kind} transaction`);
    }
    const existing = this.readRecoveryCommitted(
      input.loopId,
      snapshot.round,
      recovery.transaction_id,
    );
    if (existing) {
      policyMetrics.recordRound(input.loopId, existing.result, true);
      return existing;
    }

    const committedSnapshot: RoundTransactionSnapshot = {
      ...snapshot,
      kind: "rollback",
      transactionId: recovery.transaction_id,
      phase: "committed",
      afterEvidence: input.actualEvidence,
      // A machine recovery keeps the triggering evaluation as the record of
      // what was abandoned. An agent recovery has no evaluation at all.
      evaluation: recovery.origin === "machine" ? snapshot.evaluation : undefined,
      result: undefined,
      operatorAcceptance: undefined,
      // The abandoned transaction's savepoints/restore marker belong to that
      // attempt, not to the child branch. The directive target is the only
      // recovery point recorded by this event.
      beforeCheckpoint: undefined,
      beforeCheckpointError: undefined,
      checkpoints: undefined,
      restore: undefined,
      recovery,
      submittedFields: recovery.origin === "machine"
        ? (snapshot.submittedFields ?? [])
        : [],
      normalizationDiagnostics: recovery.origin === "machine"
        ? (snapshot.normalizationDiagnostics ?? [])
        : [],
      updatedAt: Date.now(),
    };
    const result: RoundProcessResult = {
      action: recovery.origin === "machine" ? "backtrack" : "recovery",
      origin: recovery.origin,
      reason: recovery.reason,
      recovery,
      verificationFlags: [],
      roundSuccess: false,
      gateContradicted: false,
      verificationStatus: "not_applicable",
      newConsecutiveRejections: 0,
      shouldPushSuccessTrajectory: false,
    };
    const envelope = {
      schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
      round_id: snapshot.roundId,
      snapshot: committedSnapshot,
      result,
    };
    if (!this.engine.commitRollbackDirective({
      loopId: input.loopId,
      round: snapshot.round,
      transactionId: recovery.transaction_id,
      envelope,
    })) {
      throw new Error(`Rollback directive commit failed: ${recovery.transaction_id}`);
    }
    const persisted = this.readRecoveryCommitted(
      input.loopId,
      snapshot.round,
      recovery.transaction_id,
    );
    if (!persisted) {
      throw new Error(`Rollback directive read-back failed: ${recovery.transaction_id}`);
    }
    policyMetrics.recordRound(input.loopId, result, false);
    logEvent("rollback_directive_committed", {
      loopId: input.loopId,
      round: snapshot.round,
      transactionId: recovery.transaction_id,
      origin: recovery.origin,
      target: recovery.target,
    });
    return { snapshot: committedSnapshot, result, replayed: false };
  }

  private readRecoveryCommitted(
    loopId: string,
    round: number,
    transactionId: string,
  ): RoundTransactionOutcome | null {
    const taskId = `loop:${loopId}:r${round}:rollback:${transactionId}`;
    const entries = queryLoopEntries(this.store, loopId, {
      prefix: `loop:${loopId}:r${round}:rollback:`,
    });
    for (const entry of entries) {
      if (entry.task_id !== taskId || entry.task_type !== "rollback_directive") {
        continue;
      }
      const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
      const transaction = lineage && isRecord(lineage.round_transaction)
        ? lineage.round_transaction
        : null;
      if (!transaction) continue;
      const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
      const result = transaction.result;
      if (!snapshot || snapshot.kind !== "rollback" || !isProcessResult(result)) {
        continue;
      }
      return { snapshot, result, replayed: true };
    }
    return null;
  }

  /** Recover an already committed decision without evaluating or writing. */
  recover(snapshot: RoundTransactionSnapshot): RoundTransactionOutcome | null {
    const outcome = snapshot.kind === "rollback"
      ? this.readRecoveryCommitted(snapshot.loopId, snapshot.round, snapshot.transactionId)
      : this.readCommitted(snapshot);
    if (outcome) {
      policyMetrics.recordRound(snapshot.loopId, outcome.result, true);
    }
    return outcome;
  }

  private readCommitted(
    expected: RoundTransactionSnapshot,
    opts?: { skipBacktrack?: boolean },
  ): RoundTransactionOutcome | null {
    const taskId = `loop:${expected.loopId}:r${expected.round}:feedback`;
    const entries = this.commitStore.find(expected.loopId, expected.round);
    for (const entry of entries) {
      if (entry.task_id !== taskId) continue;
      const outcome = this.outcomeFromEntry(
        entry,
        expected.roundId,
        expected.transactionId,
        opts?.skipBacktrack === true,
      );
      if (outcome) return outcome;
    }
    return null;
  }

  private outcomeFromEntry(
    entry: VaultEntry,
    expectedRoundId: string,
    expectedTransactionId: string,
    skipBacktrack = false,
  ): RoundTransactionOutcome | null {
    const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
    const transaction = lineage && isRecord(lineage.round_transaction)
      ? lineage.round_transaction
      : null;
    if (!transaction || transaction.round_id !== expectedRoundId) return null;
    const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
    const result = transaction.result;
    if (!snapshot || !isProcessResult(result)) return null;
    // v3.9.7: the numeric round identity is NOT enough. A deep restore reuses
    // `target.redo_round`, where the abandoned branch already committed a
    // feedback round with the same roundId. Replaying it would silently discard
    // the redo submission. The transaction id is the branch-scoped identity.
    if (snapshot.transactionId !== expectedTransactionId) return null;
    // v3.2.1: a committed backtrack is a roll-back directive, not a terminal
    // decision. The restored round reuses the same roundId, so replaying it
    // would silently discard the agent's redo submission and re-emit the
    // backtrack prompt forever (the redo's work is never evaluated, and the
    // the terminate guards never run because evaluation is short-circuited).
    // Crash recovery still replays backtracks (recover() → reconcileCommittedRound
    // resets the round counter from the committed decision); only the advance
    // path skips them so the redo is evaluated normally.
    if (skipBacktrack && result.action === "backtrack") return null;
    return { snapshot, result, replayed: true };
  }
}
