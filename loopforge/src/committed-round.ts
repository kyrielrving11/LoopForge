/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */

import type { MachineObservation } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import { observationVersionIssue } from "./evidence-provider.js";
import { promptContextPairIssue } from "./context-boundary.js";
import type { PromptContextPairInput } from "./context-boundary.js";
import {
  PROMPT_ARTIFACT_SCHEMA_VERSION,
  isPromptContextMode,
  isPromptContextReason,
  makeLoopRoundResult,
} from "./protocol.js";
import type { VaultEntry } from "./loop-store.js";
import type {
  CheckpointRef,
  CompiledRoundFacts,
  ContractBinding,
  ContractTransition,
  EvidencePosture,
  ExecutionReport,
  LoopRoundResult,
  OperatorAcceptance,
  PromptArtifact,
  RecoveryDirective,
  RoundContractProposal,
  RoundOutcome,
  SelfEvaluation,
  SubmissionDiagnostic,
  SubGoalUpdate,
  VerificationFlag,
} from "./protocol.js";
import type { RoundProcessResult } from "./round-coordinator.js";
import {
  ROUND_TRANSACTION_SCHEMA_VERSION,
  deriveRoundObservationDelta,
  isProcessResult,
  parseRoundTransactionSnapshot,
  rootBranchId,
  transactionSchemaVersionOf,
} from "./round-transaction.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
import {
  effectiveOutcome,
  parseContractTransition,
  parseRoundContract,
} from "./self-eval.js";
import { entryRound, isRecord } from "./token-utils.js";
import { transactionIdentityIssue } from "./transaction-identity.js";

export type CommittedAction = "continue" | "stop" | "recovery" | "backtrack";

export interface CommittedRoundView {
  readonly source: "feedback" | "rollback";
  readonly sourceEntry: VaultEntry | Record<string, unknown>;
  readonly loopId: string;
  readonly round: number;
  readonly roundId: string;
  /** v3.9.6: transaction/branch identity. Optional on hand-built/library
   *  views; committed decoders always set them. The branch read model
   *  normalizes a missing kind/branch to an evaluation on the root branch. */
  readonly transactionId?: string;
  readonly branchId?: string;
  readonly kind?: "evaluation" | "rollback";
  /** v3.9.6: evaluation for ordinary work; agent/machine for a directive. */
  readonly origin?: "evaluation" | "agent" | "machine";
  /** v3.9.6: rollback directive facts; null for ordinary evaluation rounds. */
  readonly recovery?: RecoveryDirective | null;
  /** v3.9.7: the transaction's automatic before-image, if one was captured. */
  readonly beforeCheckpoint: CheckpointRef | null;
  /** v3.9.7: Agent-created mid-round savepoints on this transaction. */
  readonly checkpoints: CheckpointRef[];
  /** v3.9.7: present only on a redo transaction that completed a verified
   *  restore. The directive remains the target's one source. */
  readonly restore: RoundTransactionSnapshot["restore"] | null;
  /** Operator-owned immutable acceptance, when this transaction carries it. */
  readonly operatorAcceptance: OperatorAcceptance | null;
  /** v4.0.1: the compile facts stamped at commit, when present. */
  readonly compiled: CompiledRoundFacts | null;
  readonly sequence?: number;
  readonly attempt: number;
  readonly promptArtifact: PromptArtifact | null;
  readonly evaluation: SelfEvaluation | null;
  readonly executionReport: ExecutionReport | null;
  readonly verificationFlags: VerificationFlag[];
  readonly result: RoundProcessResult | null;
  /** v4.0.3: the evidence posture persisted with this transaction. The
   *  current (schema 8) decoder refuses a commit without one, so this is null
   *  only on a hand-built/library view. */
  readonly evidencePosture: EvidencePosture | null;
  readonly action: CommittedAction;
  /** v4.0.3: the Agent's success claim (never a machine verdict). */
  readonly agentSuccessClaim: boolean;
  /** v4.0.3: the effective Agent-declared outcome. */
  readonly agentOutcome: RoundOutcome | null;
  readonly contractProposal: RoundContractProposal | null;
  /** v3.9.9: this round's explicit contract redirection, if it declared one.
   *  Read from the committed evaluation; a target the reducer cannot match is
   *  inert, never a reason to close a contract. */
  readonly contractTransition: ContractTransition | null;
  /** v3.8: the machine binding stamped when the declaring round committed. */
  readonly contractBinding: ContractBinding | null;
  readonly beforeEvidence: MachineObservation[];
  readonly afterEvidence: MachineObservation[];
  /** v3.8: derived before→after delta — never persisted (the transaction
   *  stores only the two factual collections). */
  readonly observationDelta: ObservationDelta[];
  /** v3.9.1: persisted normalization metadata. */
  readonly normalizationDiagnostics: SubmissionDiagnostic[];
  readonly submittedFields: string[];
  /** v3.8: true when the round committed without after-phase observations —
   *  its machine evidence is incomplete and must never be substituted with
   *  the before baseline. */
  readonly evidenceIncomplete: boolean;
  /** Normalized round-level declarations used by compiler projections. */
  readonly outputSummary?: string;
  readonly constraintViolations?: string[];
  readonly discoveredConstraints?: string[];
  readonly activeConstraints?: string[];
  /** Effective retirements from the compile that produced this round. */
  readonly compiledRetirements?: string[];
  readonly retractedConstraints?: string[];
  /** v4.0.2: committed Agent-reported unresolved questions (report-only).
   *  Read by bounded Working Memory, replay and explain; never by a gate. */
  readonly openQuestions?: string[];
  /** v4.0.3: stable ids of questions resolved in this committed round. */
  readonly resolvedOpenQuestionIds?: string[];
  readonly emergedSubtasks?: string[];
  readonly subgoalUpdates?: SubGoalUpdate[];
}

function committedAction(value: unknown): CommittedAction | null {
  return value === "continue" || value === "stop" ||
    value === "recovery" || value === "backtrack"
    ? value
    : null;
}

function snapshots(value: unknown): MachineObservation[] {
  return Array.isArray(value) ? value as MachineObservation[] : [];
}

function flags(value: unknown): VerificationFlag[] {
  return Array.isArray(value) ? value as VerificationFlag[] : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Normalize a raw subgoal_updates value into typed entries. Decode stays
 *  tolerant of any shape (parser caps apply at ingestion; this is the
 *  read-model view of what was committed). */
function subGoalUpdates(value: unknown): SubGoalUpdate[] {
  if (!Array.isArray(value)) return [];
  const out: SubGoalUpdate[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const u = item as Record<string, unknown>;
    if (typeof u.id !== "string") continue;
    const status = u.status;
    if (status !== "in_progress" && status !== "done" &&
        status !== "blocked" && status !== "canceled") continue;
    out.push({
      id: u.id,
      status,
      note: typeof u.note === "string" ? u.note : undefined,
    });
    if (out.length >= 20) break;
  }
  return out;
}

/** Decode a durable :feedback entry. Reject/terminate/in-flight envelopes are
 * not committed history and therefore do not produce a view. */
/** v3.9.1: a round is evidence-incomplete when it has no after evidence at
 *  all, or when Git was configured/appeared but either boundary is not
 *  observable. A command-only round is not incomplete merely because it has
 *  no Git observation. */
function evidenceIncomplete(
  after: ReadonlyArray<MachineObservation>,
  deltas: ReadonlyArray<ObservationDelta>,
): boolean {
  if (after.length === 0) return true;
  // No Git delta means Git was not part of this round. A Git delta whose
  // change set is null means the boundary pair could not be compared —
  // including a missing before baseline.
  return deltas.some((delta) =>
    delta.kind === "git" && delta.changedFiles === null);
}

/** v3.9.1: ONE view builder over ONE transaction snapshot. Both the durable
 *  feedback entry and the engine's hydrated merged entry call it, so there is
 *  no second evaluation/history interpretation. */
function viewFromSnapshot(input: {
  source: "feedback" | "rollback";
  sourceEntry: VaultEntry | Record<string, unknown>;
  snapshot: RoundTransactionSnapshot;
  result: RoundProcessResult;
  sequence?: number;
}): CommittedRoundView | null {
  const { snapshot, result } = input;
  if (snapshot.phase !== "committed") return null;
  const action = committedAction(result.action);
  if (!action) return null;
  const round = snapshot.round;
  const loopId = snapshot.loopId;
  if (round < 1 || !loopId) return null;
  const evaluation = snapshot.evaluation ?? null;
  const outcome = evaluation ? effectiveOutcome(evaluation) : null;
  const beforeEvidence = snapshots(snapshot.beforeEvidence);
  const afterEvidence = snapshots(snapshot.afterEvidence);
  const observationDelta = deriveRoundObservationDelta(beforeEvidence, afterEvidence);
  return {
    source: input.source,
    sourceEntry: input.sourceEntry,
    loopId,
    round,
    roundId: snapshot.roundId,
    transactionId: snapshot.transactionId,
    branchId: snapshot.branchId,
    kind: snapshot.kind,
    origin: snapshot.kind === "rollback"
      ? (snapshot.recovery?.origin ?? "machine")
      : "evaluation",
    recovery: snapshot.recovery ?? null,
    beforeCheckpoint: snapshot.beforeCheckpoint ?? null,
    checkpoints: snapshot.checkpoints ?? [],
    restore: snapshot.restore ?? null,
    operatorAcceptance: snapshot.operatorAcceptance ?? null,
    compiled: snapshot.compiled ?? null,
    sequence: input.sequence,
    attempt: snapshot.attempt,
    promptArtifact: snapshot.promptArtifact ?? null,
    evaluation,
    executionReport: evaluation?.execution_report ?? null,
    verificationFlags: flags(result.verificationFlags),
    result,
    evidencePosture: result.evidencePosture ?? null,
    action,
    agentSuccessClaim: result.agentSuccessClaim === true,
    agentOutcome: result.agentOutcome ?? outcome,
    contractProposal: evaluation?.round_contract
      ? parseRoundContract(evaluation.round_contract) ?? null
      : null,
    contractTransition: evaluation
      ? parseContractTransition(evaluation.contract_transition) ?? null
      : null,
    contractBinding: snapshot.contractBinding ?? null,
    beforeEvidence,
    afterEvidence,
    observationDelta,
    normalizationDiagnostics: snapshot.normalizationDiagnostics ?? [],
    submittedFields: snapshot.submittedFields ?? [],
    evidenceIncomplete: evidenceIncomplete(afterEvidence, observationDelta),
    outputSummary: evaluation?.output_summary,
    constraintViolations: strings(evaluation?.constraint_violations),
    discoveredConstraints: strings(evaluation?.discovered_constraints),
    activeConstraints: snapshot.compiled
      ? [...snapshot.compiled.constraintsActive]
      : [],
    compiledRetirements: snapshot.compiled
      ? [...snapshot.compiled.constraintsRetired]
      : [],
    retractedConstraints: strings(evaluation?.retracted_constraints),
    openQuestions: strings(evaluation?.open_questions),
    resolvedOpenQuestionIds: strings(evaluation?.resolved_open_question_ids),
    emergedSubtasks: strings(evaluation?.emerged_subtasks),
    subgoalUpdates: subGoalUpdates(evaluation?.subgoal_updates),
  };
}

export function decodeCommittedRound(entry: VaultEntry): CommittedRoundView | null {
  if (!String(entry.task_id ?? "").endsWith(":feedback")) return null;
  const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
  const transaction = lineage && isRecord(lineage.round_transaction)
    ? lineage.round_transaction
    : null;
  if (!transaction) return null;
  // v3.8: the transaction schema is a HARD break — an envelope that does not
  // parse (legacy version, malformed observations) is not committed history.
  // legacyTransactionRounds() reports the loss explicitly; it is never
  // silently decoded into a partial view.
  const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
  if (!snapshot || snapshot.kind !== "evaluation") return null;
  const identityIssue = transactionIdentityIssue(entry);
  if (identityIssue) return null;
  const resultValue = isRecord(transaction.result)
    ? transaction.result
    : snapshot.result;
  // v4.0.3/v4.0.4: a current-schema (8) committed result must carry a
  // well-formed Evidence Posture and the Agent's `agent_stop_reason` lives in
  // its evaluation. Missing/corrupt posture is a HARD break, not something to
  // re-derive at read time.
  if (!isRecord(resultValue) || !isProcessResult(resultValue)) return null;
  return viewFromSnapshot({
    source: "feedback",
    sourceEntry: entry,
    snapshot,
    result: resultValue as unknown as RoundProcessResult,
    sequence: typeof entry.sequence === "number" ? entry.sequence : undefined,
  });
}

/** v3.9.6: decode a committed rollback directive event. It is a typed event
 *  in the round document, never a normal feedback round. */
export function decodeRollbackEvent(entry: VaultEntry): CommittedRoundView | null {
  if (entry.task_type !== "rollback_directive") return null;
  const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
  const transaction = lineage && isRecord(lineage.round_transaction)
    ? lineage.round_transaction
    : null;
  if (!transaction) return null;
  const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
  if (!snapshot || snapshot.kind !== "rollback" || !snapshot.recovery) return null;
  const identityIssue = transactionIdentityIssue(entry);
  if (identityIssue) return null;
  const resultValue = isRecord(transaction.result)
    ? transaction.result
    : snapshot.result;
  if (!isRecord(resultValue) || !isProcessResult(resultValue)) return null;
  const result = resultValue as unknown as RoundProcessResult;
  if (result.action !== "recovery" && result.action !== "backtrack") return null;
  return viewFromSnapshot({
    source: "rollback",
    sourceEntry: entry,
    snapshot,
    result,
    sequence: typeof entry.sequence === "number" ? entry.sequence : undefined,
  });
}

/** Normalize committed history: rollback directives disappear, later records
 * replace earlier records for the same logical round, and output is ascending. */
/** v4.0.1: decode either an ordinary committed round or a rollback event.
 *  There is no merged-lineage representation any more: a committed round is
 *  exactly its durable :feedback envelope, and a rollback is its event. */
export function decodeCommittedRecord(entry: unknown): CommittedRoundView | null {
  return decodeCommittedRound(entry as VaultEntry) ??
    decodeRollbackEvent(entry as VaultEntry);
}

/** THE committed-view → compiler-request projection.
 *
 *  The compiler once received these fields from the caller's mutable
 *  `last_round_result`, which existed on the live path and was absent on
 *  resume/unpause/backtrack compiles. This projection lets one committed
 *  fact source feed every consumer. Optional declarations are read from the
 *  decoded view where it exposes them. */
export function roundResultFromCommittedRound(
  view: CommittedRoundView,
): LoopRoundResult {
  const evaluation = view.evaluation;
  return makeLoopRoundResult({
    round: view.round,
    agentSuccessClaim: view.agentSuccessClaim,
    output_summary: evaluation?.output_summary ?? "",
    constraint_violations: [...(evaluation?.constraint_violations ?? [])],
    discovered_constraints: [...(view.discoveredConstraints ?? [])],
    emerged_subtasks: [...(view.emergedSubtasks ?? [])],
    subgoal_updates: [...(view.subgoalUpdates ?? [])],
    execution_report: view.executionReport ?? undefined,
    retracted_constraints: [...(view.retractedConstraints ?? [])],
    wrong_assumptions: [...(evaluation?.wrong_assumptions ?? [])],
    open_questions: [...(evaluation?.open_questions ?? [])],
    resolved_open_question_ids: [...(evaluation?.resolved_open_question_ids ?? [])],
    worker_results: [...(evaluation?.worker_results ?? [])],
    subtask_boundary: evaluation?.subtask_boundary === true,
    subtask_boundary_label: evaluation?.subtask_boundary_label ?? "",
    agentOutcome: evaluation
      ? effectiveOutcome(evaluation)
      : view.agentOutcome ?? undefined,
    blocker: evaluation?.blocker,
    retroactiveClaims: [...(evaluation?.retroactiveClaims ?? [])],
    no_change_reason: evaluation?.no_change_reason,
  });
}

/** The ONE pending-directive lookup for a redo round. The directive's
 *  `target.redo_round` is the branch fence, so a deep restore and a
 *  same-round redo match the same way. */
export function pendingBacktrackRecord(
  entries: ReadonlyArray<unknown>,
  redoRound: number,
): CommittedRoundView | null {
  return pendingRollbackDirective(entries, redoRound);
}

/** Lineage sub-object of an entry (`loop_lineage`; v3.7: the legacy
 *  top-level `lineage` alias was removed), or {} when absent. */
export function entryLineage(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {};
  const value = entry.loop_lineage;
  return isRecord(value) ? value : {};
}

/** v3.9.6: the ONE branch read model. */
export interface BranchView {
  loopId: string;
  branchId: string;
  /** Evaluation rounds on the current branch, ascending. */
  rounds: CommittedRoundView[];
  /** Rollback directives on the chain, chronological. */
  directives: CommittedRoundView[];
  /** The last directive whose child branch has no evaluation commit yet. */
  pendingDirective: CommittedRoundView | null;
}

/** Resolve the current branch from already-decoded committed views. This is
 *  the branch walker itself; `resolveBranch` is only the entry-decoding
 *  wrapper, so a caller that already holds the views (the history loader)
 *  never decodes the same entries twice. */
export function resolveBranchViews(
  records: ReadonlyArray<CommittedRoundView>,
): BranchView {
  const kindOf = (view: CommittedRoundView): "evaluation" | "rollback" =>
    view.kind ?? "evaluation";
  const first = records.find((view) => kindOf(view) === "evaluation") ?? records[0];
  if (!first) {
    return { loopId: "", branchId: "", rounds: [], directives: [], pendingDirective: null };
  }
  const loopId = first.loopId;
  const branchOf = (view: CommittedRoundView): string =>
    view.branchId ?? rootBranchId(loopId);
  let branchId = rootBranchId(loopId);
  let rounds = records
    .filter((view) => kindOf(view) === "evaluation" && branchOf(view) === branchId)
    .sort((a, b) => a.round - b.round);
  const directives: CommittedRoundView[] = [];
  const seen = new Set<string>();

  for (;;) {
    const candidates = records
      .filter((view) =>
        kindOf(view) === "rollback" &&
        branchOf(view) === branchId &&
        view.recovery !== null && view.recovery !== undefined,
      )
      .sort((a, b) => a.round - b.round ||
        (a.transactionId ?? "").localeCompare(b.transactionId ?? ""));
    if (candidates.length === 0) break;
    // A branch closes exactly once. If corrupt data has more, the latest one
    // is the effective directive; the others remain visible in the raw log.
    const directive = candidates[candidates.length - 1]!;
    const directiveId = directive.transactionId ?? directive.roundId;
    if (seen.has(directiveId)) break;
    seen.add(directiveId);
    const recovery = directive.recovery!;
    // v3.9.7: the fence is the explicit redo round, not a nominal target
    // round. A before/mid checkpoint's redo round is its owning round.
    rounds = rounds.filter((view) => view.round < recovery.target.redo_round);
    const child = recovery.transaction_id;
    const childRounds = records
      .filter((view) => kindOf(view) === "evaluation" && branchOf(view) === child)
      .sort((a, b) => a.round - b.round);
    rounds = [...rounds, ...childRounds];
    directives.push(directive);
    branchId = child;
  }

  const byRound = new Map<number, CommittedRoundView>();
  for (const view of rounds) byRound.set(view.round, view);
  rounds = [...byRound.values()].sort((a, b) => a.round - b.round);

  let pendingDirective: CommittedRoundView | null = null;
  const latest = directives[directives.length - 1];
  if (latest && latest.recovery) {
    const child = latest.recovery.transaction_id;
    const hasChildRound = records.some(
      (view) => kindOf(view) === "evaluation" && branchOf(view) === child,
    );
    if (!hasChildRound) pendingDirective = latest;
  }

  return { loopId, branchId, rounds, directives, pendingDirective };
}

/** Resolve the current branch from committed records in the raw entry view.
 *  Decoding happens once here; the walker itself is `resolveBranchViews`. */
export function resolveBranch(entries: ReadonlyArray<unknown>): BranchView {
  return resolveBranchViews(
    entries
      .map(decodeCommittedRecord)
      .filter((view): view is CommittedRoundView => view !== null),
  );
}

/** v3.9.6: current-branch evaluation rounds. */
export function branchRounds(
  entries: ReadonlyArray<unknown>,
): CommittedRoundView[] {
  return resolveBranch(entries).rounds;
}

/** v3.9.6: rollback directive chain. */
export function branchDirectives(
  entries: ReadonlyArray<unknown>,
): CommittedRoundView[] {
  return resolveBranch(entries).directives;
}

/** v3.9.6: the pending directive controlling a redo round. */
export function pendingRollbackDirective(
  entries: ReadonlyArray<unknown>,
  redoRound?: number,
): CommittedRoundView | null {
  const pending = resolveBranch(entries).pendingDirective;
  if (!pending?.recovery) return null;
  if (redoRound !== undefined && pending.recovery.target.redo_round !== redoRound) {
    return null;
  }
  return pending;
}

/** v3.9.6: machine deadlock guard. Agent-origin directives never consume it. */
export function hasCommittedMachineBacktrack(
  entries: ReadonlyArray<unknown>,
  currentRound: number,
): boolean {
  return branchDirectives(entries).some((view) => {
    const recovery = view.recovery;
    return view.origin === "machine" &&
      recovery !== null && recovery !== undefined &&
      recovery.target.redo_round <= currentRound &&
      view.round >= currentRound;
  });
}

/** v3.9.6: live history window = current branch below the round being
 *  compiled. `currentRound` is the round being prepared/submitted. */
export function derivationRounds(
  entries: ReadonlyArray<unknown>,
  currentRound: number = Number.POSITIVE_INFINITY,
): CommittedRoundView[] {
  return branchRounds(entries).filter((view) => view.round < currentRound);
}

/** v3.9.6: read-only history = current branch rounds. No session frontier,
 *  no numeric fence, no second cursor. */
export function readOnlyRounds(
  entries: ReadonlyArray<unknown>,
): CommittedRoundView[] {
  return branchRounds(entries);
}

/** v3.9.6: read-only rollback events = committed directive chain. */
export function readOnlyRollbacks(
  entries: ReadonlyArray<unknown>,
): CommittedRoundView[] {
  return branchDirectives(entries);
}

/** v3.8: Rounds whose persisted transaction carries a LEGACY schema version.
 *  A hard version break must be visible, not silent: these rounds drop out of
 *  history views, so audit/status surface them here instead of letting the
 *  loop look complete while rounds are missing. */
export interface LegacyRound {
  round: number;
  schemaVersion: number;
  /** v3.8.1: which versioned envelope rejected the round. All are hard
   *  breaks — a round that fails any check is not committed history — so all
   *  must be REPORTED, not just the transaction one.
   *  v3.9.1 adds "observation": a transaction whose embedded Git/command
   *  observation schema is unsupported. v4.0.4 adds "prompt_context": the
   *  artifact has the current schema but an illegal context-boundary pair. */
  envelope:
    | "transaction"
    | "prompt_artifact"
    | "prompt_context"
    | "observation";
}

export function legacyTransactionRounds(entries: unknown[]): LegacyRound[] {
  const out: LegacyRound[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const lineage = entryLineage(entry);
    const envelope = isRecord(lineage.round_transaction)
      ? lineage.round_transaction
      : isRecord(entry.round_transaction) ? entry.round_transaction : null;
    if (!envelope || !isRecord(envelope.snapshot)) continue;
    const round = entryRound(entry);
    if (round < 1) continue;
    const version = transactionSchemaVersionOf(envelope.snapshot);
    if (version !== null && version !== ROUND_TRANSACTION_SCHEMA_VERSION) {
      out.push({ round, schemaVersion: version, envelope: "transaction" });
      continue;
    }
    // v3.8.1: the PromptArtifact schema is versioned separately, and the
    // transaction parser rejects a snapshot whose artifact version it does
    // not know — dropping the whole round. Reporting only the transaction
    // version would let an artifact-version break delete committed history
    // silently, which is the one thing this function exists to prevent.
    const snapshot = envelope.snapshot as Record<string, unknown>;
    if (isRecord(snapshot.promptArtifact)) {
      const artifact = snapshot.promptArtifact;
      const artifactVersion = artifact.schemaVersion;
      if (typeof artifactVersion === "number" &&
          artifactVersion !== PROMPT_ARTIFACT_SCHEMA_VERSION) {
        out.push({ round, schemaVersion: artifactVersion, envelope: "prompt_artifact" });
        continue;
      }
      // v4.0.5: the same runtime whitelists the decoder uses. A malformed
      // optional invocation instruction is a legacy artifact, not accepted
      // silently.
      const validInstruction =
        artifact.currentUserInstruction === undefined ||
        (typeof artifact.currentUserInstruction === "string" &&
          artifact.currentUserInstruction.trim().length > 0);
      const validContextFields =
        (artifact.level === "l0" || artifact.level === "l1" || artifact.level === "l2") &&
        isPromptContextMode(artifact.contextMode) &&
        isPromptContextReason(artifact.contextReason) &&
        validInstruction &&
        typeof artifact.attempt === "number" &&
        typeof artifact.round === "number";
      const contextIssue = validContextFields
        ? promptContextPairIssue({
            level: artifact.level,
            mode: artifact.contextMode,
            reason: artifact.contextReason,
            attempt: artifact.attempt,
            round: artifact.round,
          } as PromptContextPairInput)
        : "missing or malformed context boundary fields";
      if (contextIssue !== null) {
        out.push({
          round,
          schemaVersion: typeof artifactVersion === "number" ? artifactVersion : -1,
          envelope: "prompt_context",
        });
        continue;
      }
    }
    // v3.9.1: an observation schema mismatch is also a hard break. The
    // transaction parser drops the whole round on it; report the loss here
    // instead of letting the round vanish from history.
    const observations = [
      ...(Array.isArray(snapshot.beforeEvidence) ? snapshot.beforeEvidence : []),
      ...(Array.isArray(snapshot.afterEvidence) ? snapshot.afterEvidence : []),
    ];
    for (const item of observations) {
      if (!isRecord(item)) {
        out.push({ round, schemaVersion: -1, envelope: "observation" });
        break;
      }
      // v3.9.9: the SAME version judgment the transaction parser uses.
      const issue = observationVersionIssue(
        item.kind, item.schemaVersion, item.data, item.status);
      if (issue) {
        out.push({
          round,
          schemaVersion: issue.schemaVersion,
          envelope: "observation",
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.round - b.round);
}
