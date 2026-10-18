/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */

import type { MachineObservation } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import {
  GIT_OBSERVATION_SCHEMA_VERSION,
  PROMPT_ARTIFACT_SCHEMA_VERSION,
} from "./protocol.js";
import type { VaultEntry } from "./loop-store.js";
import type {
  ContractBinding,
  ExecutionReport,
  PromptArtifact,
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
  parseRoundTransactionSnapshot,
  transactionSchemaVersionOf,
} from "./round-transaction.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
import { claimedMetCriteria, claimedRemainingCriteria, effectiveOutcome, parseRoundContract } from "./self-eval.js";
import { entryRound, isRecord } from "./token-utils.js";

export type CommittedAction = "continue" | "stop" | "backtrack";

/** v3.8.1: the rolled-back branch's facts, decoded from a committed rollback
 *  directive. One shape for the compile-side Recovery Brief, the state file's
 *  Recent tier and the rollback prompt — these were three renderers over two
 *  independent derivations (the committed record and an in-memory walk).
 *
 *  Note the target is a RESTORE POINT, not an upper bound: the redo re-commits
 *  the same round numbers the abandoned rounds occupied (round-lifecycle.ts
 *  sets `currentRound = backtrackTarget + 1`), so this is never a window
 *  fence. Abandonment is temporal, not numeric. */
export interface BacktrackRecoveryRecord {
  readonly target: number;
  readonly triggerRule: string;
  readonly failedRounds: number[];
  readonly approaches: string[];
  readonly wrongAssumptions: string[];
  readonly skippedFiles: string[];
  readonly skippedFingerprints: Record<string, string>;
  readonly targetGitHead?: string;
}

export interface CommittedRoundView {
  readonly source: "feedback" | "merged";
  readonly sourceEntry: VaultEntry | Record<string, unknown>;
  readonly loopId: string;
  readonly round: number;
  readonly roundId: string;
  readonly sequence?: number;
  readonly attempt: number;
  readonly promptArtifact: PromptArtifact | null;
  readonly evaluation: SelfEvaluation | null;
  readonly executionReport: ExecutionReport | null;
  readonly verificationFlags: VerificationFlag[];
  readonly result: RoundProcessResult | null;
  readonly action: CommittedAction;
  readonly success: boolean;
  readonly outcome: RoundOutcome | null;
  readonly contractProposal: RoundContractProposal | null;
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
  readonly retractedConstraints?: string[];
  readonly emergedSubtasks?: string[];
  readonly subgoalUpdates?: SubGoalUpdate[];
  /** v3.8.1: present only on a committed rollback directive, null elsewhere.
   *  Decoded from `result.*` on the durable feedback entry and from the
   *  `lineage.backtrack*` stamps on a hydrated merged entry. */
  readonly backtrack: BacktrackRecoveryRecord | null;
}

function committedAction(value: unknown): CommittedAction | null {
  return value === "continue" || value === "stop" || value === "backtrack"
    ? value
    : null;
}

function snapshots(value: unknown): MachineObservation[] {
  return Array.isArray(value) ? value as MachineObservation[] : [];
}

function flags(value: unknown): VerificationFlag[] {
  return Array.isArray(value) ? value as VerificationFlag[] : [];
}

function roundOutcome(value: unknown): RoundOutcome | null {
  return value === "success" || value === "partial" ||
    value === "failed" || value === "blocked"
    ? value
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** v3.8.1: decode a rollback directive's facts from either carrier —
 *  `result.*` on a durable :feedback entry, `lineage.*` on a hydrated merged
 *  entry. Returns null when no restore point is recorded, which is also the
 *  signal that the record cannot serve as recovery guidance. */
export function decodeBacktrackRecord(source: unknown): BacktrackRecoveryRecord | null {
  const value = isRecord(source) ? source : {};
  const target = typeof value.backtrackTarget === "number" ? value.backtrackTarget : null;
  if (target === null) return null;
  return {
    target,
    triggerRule: typeof value.backtrackTriggerRule === "string"
      ? value.backtrackTriggerRule
      : "",
    failedRounds: numbers(value.backtrackFailedRounds),
    approaches: strings(value.backtrackApproaches),
    wrongAssumptions: strings(value.backtrackWrongAssumptions),
    skippedFiles: strings(value.backtrackSkippedFiles),
    skippedFingerprints: stringMap(value.backtrackSkippedFingerprints),
    targetGitHead: typeof value.backtrackTargetGitHead === "string"
      ? value.backtrackTargetGitHead
      : undefined,
  };
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
  source: "feedback" | "merged";
  sourceEntry: VaultEntry | Record<string, unknown>;
  lineage: Record<string, unknown> | null;
  snapshot: RoundTransactionSnapshot;
  result: RoundProcessResult;
  sequence?: number;
}): CommittedRoundView | null {
  const { snapshot, result, lineage } = input;
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
    sequence: input.sequence,
    attempt: snapshot.attempt,
    promptArtifact: snapshot.promptArtifact ?? null,
    evaluation,
    executionReport: evaluation?.execution_report ?? null,
    verificationFlags: flags(result.verificationFlags),
    result,
    action,
    success: result.roundSuccess === true,
    outcome,
    contractProposal: evaluation?.round_contract
      ? parseRoundContract(evaluation.round_contract) ?? null
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
    activeConstraints: strings(lineage?.constraints_active),
    retractedConstraints: strings(evaluation?.retracted_constraints),
    emergedSubtasks: strings(evaluation?.emerged_subtasks),
    subgoalUpdates: subGoalUpdates(evaluation?.subgoal_updates),
    backtrack: action === "backtrack"
      ? decodeBacktrackRecord(result as unknown as Record<string, unknown>)
      : null,
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
  if (!snapshot) return null;
  const resultValue = isRecord(transaction.result)
    ? transaction.result
    : snapshot.result;
  if (!isRecord(resultValue)) return null;
  return viewFromSnapshot({
    source: "feedback",
    sourceEntry: entry,
    lineage,
    snapshot,
    result: resultValue as unknown as RoundProcessResult,
    sequence: typeof entry.sequence === "number" ? entry.sequence : undefined,
  });
}

/** Decode an in-memory lineage entry after the engine merged its committed
 * feedback. The merged entry MUST carry the embedded transaction snapshot;
 * the old raw top-level evaluation reconstruction is gone, so a partial
 * lineage entry cannot become a second history. */
export function decodeMergedRound(entry: unknown): CommittedRoundView | null {
  if (!isRecord(entry)) return null;
  const raw = entry as Record<string, unknown>;
  const lineage = isRecord(raw.loop_lineage) ? raw.loop_lineage : {};
  const action = committedAction(lineage.committed_action ?? raw.committed_action);
  if (!action) return null;
  const transaction = isRecord(lineage.round_transaction)
    ? lineage.round_transaction
    : isRecord(raw.round_transaction)
      ? raw.round_transaction
      : null;
  if (!transaction) return null;
  const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
  if (!snapshot) return null;
  const resultValue = isRecord(transaction.result)
    ? transaction.result
    : snapshot.result;
  if (!isRecord(resultValue)) return null;
  return viewFromSnapshot({
    source: "merged",
    sourceEntry: raw,
    lineage,
    snapshot,
    result: resultValue as unknown as RoundProcessResult,
    sequence: typeof lineage.sequence === "number" ? lineage.sequence : undefined,
  });
}

/** Normalize committed history: rollback directives disappear, later records
 * replace earlier records for the same logical round, and output is ascending. */
/** Decode a committed round from either representation: an engine-hydrated
 *  merged lineage entry first (decodeMergedRound), then a durable :feedback
 *  entry. Compile-side callers used to inline this chain as a private
 *  `committedView` helper. */
export function decodeRound(entry: unknown): CommittedRoundView | null {
  return decodeMergedRound(entry) ?? decodeCommittedRound(entry as VaultEntry);
}

/** Lineage sub-object of an entry (`loop_lineage`; v3.7: the legacy
 *  top-level `lineage` alias was removed), or {} when absent. */
export function entryLineage(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {};
  const value = entry.loop_lineage;
  return isRecord(value) ? value : {};
}

/** Extract execution_report from an entry, handling both direct-field and
 *  lineage-nested shapes. The decoded committed view wins when the entry is
 *  a committed round. Returns null when absent. Moved from loop-compiler so
 *  field-shape interpretation lives in this module only. */
export function entryExecutionReport(entry: unknown): Record<string, unknown> | null {
  const view = decodeRound(entry);
  if (view) return view.executionReport as Record<string, unknown> | null;
  const record = isRecord(entry) ? entry : {};
  const direct = record.execution_report;
  if (isRecord(direct)) return direct;
  const nested = entryLineage(entry).execution_report;
  return isRecord(nested) ? nested : null;
}

/** Read the criteria the agent claimed met from an entry's execution_report. */
export function entryCriteriaMet(entry: unknown): string[] {
  const view = decodeRound(entry);
  if (view) return claimedMetCriteria(view.executionReport);
  const ev = entryExecutionReport(entry);
  if (!ev) return [];
  return rawCriterionClaims(ev, "met");
}

/** Read the criteria the agent declared outstanding from an entry. */
export function entryCriteriaRemaining(entry: unknown): string[] {
  const view = decodeRound(entry);
  if (view) return claimedRemainingCriteria(view.executionReport);
  const ev = entryExecutionReport(entry);
  if (!ev) return [];
  return rawCriterionClaims(ev, "remaining");
}

/** Shape-tolerant reader for a raw entry's criterion claims (the durable
 *  shape, before the typed parse). */
function rawCriterionClaims(
  report: Record<string, unknown>,
  outcome: "met" | "remaining",
): string[] {
  const claims = report.criterion_claims;
  if (!Array.isArray(claims)) return [];
  return claims
    .filter(isRecord)
    .filter((claim) => claim.outcome === outcome && typeof claim.criterion_id === "string")
    .map((claim) => claim.criterion_id as string);
}

/** Read constraints_active from an entry's lineage. */
export function entryActiveConstraints(entry: unknown): string[] {
  const view = decodeRound(entry);
  if (view) return view.activeConstraints ?? [];
  const arr = entryLineage(entry).constraints_active;
  return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
}

/** Read retracted_constraints from an entry (direct field, else nested in
 *  the lineage). */
export function entryRetractedConstraints(entry: unknown): string[] {
  const view = decodeRound(entry);
  if (view) return view.retractedConstraints ?? [];
  const record = isRecord(entry) ? entry : {};
  const direct = record.retracted_constraints;
  if (Array.isArray(direct)) return direct.filter((v): v is string => typeof v === "string");
  const nested = entryLineage(entry).retracted_constraints;
  if (Array.isArray(nested)) return nested.filter((v): v is string => typeof v === "string");
  return [];
}

/** Read emerged_subtasks from an entry (handles direct + lineage nesting). */
export function entryEmergedSubtasks(entry: unknown): string[] {
  const view = decodeRound(entry);
  if (view) return view.emergedSubtasks ?? [];
  const record = isRecord(entry) ? entry : {};
  const direct = record.emerged_subtasks;
  if (Array.isArray(direct)) return direct.filter((v): v is string => typeof v === "string");
  const nested = entryLineage(entry).emerged_subtasks;
  if (Array.isArray(nested)) return nested.filter((v): v is string => typeof v === "string");
  return [];
}

/** Read subgoal_updates from an entry (handles direct + lineage nesting).
 *  v3.7.1: committed status transitions are replayed in round order by the
 *  compiler — every derivation replays ALL committed rounds, not just the
 *  last one. */
export function entrySubGoalUpdates(entry: unknown): SubGoalUpdate[] {
  const view = decodeRound(entry);
  if (view) return view.subgoalUpdates ?? [];
  const record = isRecord(entry) ? entry : {};
  const direct = record.subgoal_updates;
  if (Array.isArray(direct)) return subGoalUpdates(direct);
  const nested = entryLineage(entry).subgoal_updates;
  if (Array.isArray(nested)) return subGoalUpdates(nested);
  return [];
}

/** Read constraint_violations from an entry (entry-level, stored from the
 *  previous round's last_round_result at persist time — distinct from the
 *  evaluation-level violations on the committed view). Moved from
 *  verification-gate so lineage-shape reads live in this module only. */
export function entryViolations(entry: unknown): string[] {
  const record = isRecord(entry) ? entry : {};
  const viols = record.constraint_violations;
  if (Array.isArray(viols)) return viols.filter((v: unknown) => typeof v === "string");
  return [];
}

export function historyRounds(
  views: Iterable<CommittedRoundView | null>,
  beforeRound = Number.POSITIVE_INFINITY,
): CommittedRoundView[] {
  const byRound = new Map<number, CommittedRoundView>();
  for (const view of views) {
    if (!view || view.action === "backtrack" || view.round >= beforeRound) continue;
    byRound.set(view.round, view);
  }
  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

/** v3.8.1: the ONE committed-history window every derivation reads.
 *
 * `decodeRound` (hydrated merged lineage first, then the durable feedback
 * entry) plus the rollback handling in `historyRounds` — so the compile path,
 * the projection, the live coordinator, audit and explain can no longer
 * disagree about which rounds are this branch's history, nor about how their
 * envelope was interpreted.
 *
 * `currentRound` bounds the window exactly as before (default: unbounded). It
 * is NOT a rollback fence: the redo re-commits the round numbers the abandoned
 * rounds occupied, so abandonment is temporal, not numeric, and cannot be
 * expressed as a bound here. */
export function derivationRounds(
  entries: ReadonlyArray<unknown>,
  currentRound: number = Number.POSITIVE_INFINITY,
): CommittedRoundView[] {
  return historyRounds(entries.map(decodeRound), currentRound);
}

/** v3.8.1: the loop's durable round frontier — the session document's
 *  `current_round`. Null when no session document is in the entry set, so
 *  callers fail OPEN rather than inventing a bound. */
export function persistedFrontier(entries: ReadonlyArray<unknown>): number | null {
  for (const entry of entries) {
    if (!isRecord(entry) || entry.task_type !== "session_state") continue;
    const round = entryLineage(entry).current_round;
    return typeof round === "number" && Number.isFinite(round) && round >= 1
      ? round
      : null;
  }
  return null;
}

/** v3.8.1: THE window for a READ-ONLY view of a loop — audit, explain, replay,
 *  the projection, the metrics replay. Same decoder and same rollback handling
 *  as `derivationRounds`, plus the bound those callers cannot compute
 *  themselves.
 *
 *  The live paths bound their window at the round being compiled, and that
 *  bound is what keeps a backtracked branch out of this branch's history. A
 *  read-only view has no compile round, so it reads the SAME frontier from the
 *  durable session document and applies it only while a committed rollback
 *  directive is still in effect — a directive stops being history the moment
 *  the redo commit replaces its round's record, which is exactly when the
 *  abandoned rounds have been re-committed and must count again.
 *
 *  With no directive in effect the window stays UNBOUNDED on purpose: after a
 *  stop, terminate or max_rounds the session's `current_round` sits ON the
 *  round it just committed, so bounding there would silently drop the loop's
 *  final round. An unobservable frontier fails open the same way — a read-only
 *  view never invents a fence, it only applies the one the runtime recorded. */
export function readOnlyRounds(
  entries: ReadonlyArray<unknown>,
): CommittedRoundView[] {
  const views = entries.map(decodeRound);
  const rollbackPending = views.some((view) => view?.action === "backtrack");
  if (!rollbackPending) return historyRounds(views);
  return historyRounds(views, persistedFrontier(entries) ?? Number.POSITIVE_INFINITY);
}

/** The machine-evidence set that best represents a committed round: the
 *  after-phase observations (captured post-execution), else the pre-round
 *  baseline. The derived delta is never evidence — it is a change-set view
 *  over these facts, not a second observation collection. */
export function machineEvidenceForRound(
  view: CommittedRoundView,
): MachineObservation[] {
  if (view.afterEvidence.length > 0) return view.afterEvidence;
  return view.beforeEvidence;
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
   *  observation schema is unsupported. */
  envelope: "transaction" | "prompt_artifact" | "observation";
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
      const artifactVersion = snapshot.promptArtifact.schemaVersion;
      if (typeof artifactVersion === "number" &&
          artifactVersion !== PROMPT_ARTIFACT_SCHEMA_VERSION) {
        out.push({ round, schemaVersion: artifactVersion, envelope: "prompt_artifact" });
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
      if (!isRecord(item) || typeof item.kind !== "string") {
        out.push({ round, schemaVersion: -1, envelope: "observation" });
        break;
      }
      const expected = item.kind === "git" ? GIT_OBSERVATION_SCHEMA_VERSION : 1;
      const observationVersion = item.schemaVersion;
      if (typeof observationVersion !== "number" || observationVersion !== expected) {
        out.push({
          round,
          schemaVersion: typeof observationVersion === "number" ? observationVersion : -1,
          envelope: "observation",
        });
        break;
      }
    }
  }
  return out.sort((a, b) => a.round - b.round);
}

/** The ONE definition of machine Git motion for a single round.
 *
 *  Motion is a non-empty file list, a HEAD that moved across the round, or a
 *  HEAD that landed on the rollback's restore point — restoring the workspace
 *  IS that round's work, and would otherwise read as a round that did
 *  nothing. A clean worktree is not the same thing as no progress:
 *  commit-per-slice workflows leave no file delta even though HEAD advanced.
 *
 *  Observability stays the caller's concern: this answers "did this round
 *  move", never "could the round be observed". The restore-point arm compares
 *  short hashes, the rule `checkBacktrackGitHeadRestore` uses; the
 *  before/after arm compares the observations themselves. */
export function gitMotionSignal(input: {
  /** The round's derived Git change set; null means unknown. */
  changedFiles: ReadonlyArray<string> | null;
  headBefore?: string | null;
  headAfter?: string | null;
  restoreTargetHead?: string | null;
}): boolean | null {
  if (input.changedFiles !== null && input.changedFiles.length > 0) return true;
  const { headBefore, headAfter, restoreTargetHead } = input;
  if (headAfter && headBefore && headAfter !== headBefore) return true;
  if (headAfter && restoreTargetHead &&
      headAfter.slice(0, 12) === restoreTargetHead.slice(0, 12)) return true;
  if (input.changedFiles === null) return null;
  // An observed empty change set is no motion only when both HEADs are known;
  // otherwise a commit-only slice could still have moved HEAD.
  if (!headBefore || !headAfter) return null;
  return false;
}

/** Git HEAD as a machine observation exposes it, or null when it is silent. */
export function observedGitHead(observation: MachineObservation | undefined): string | null {
  return observation && isRecord(observation.data) &&
      typeof observation.data.head === "string" && observation.data.head
    ? observation.data.head
    : null;
}

function observedGitObservation(
  observation: MachineObservation | null | undefined,
): MachineObservation | null {
  return observation && observation.kind === "git" && observation.status === "observed"
    ? observation
    : null;
}

function observedGitIn(
  observations: ReadonlyArray<MachineObservation>,
): MachineObservation | null {
  return observations.find((observation) =>
    observation.kind === "git" && observation.status === "observed") ?? null;
}

/** The in-flight round's own motion, from its derived Git delta. A Git
 *  boundary that cannot be compared yields `null` unless HEAD movement or the
 *  restore point independently proves motion. */
export function inFlightGitMotion(
  deltas: ReadonlyArray<ObservationDelta>,
  restoreTargetHead?: string,
): boolean | null {
  const git = deltas.find((delta) => delta.kind === "git");
  if (!git) return null;
  const before = observedGitObservation(git.before);
  const after = observedGitObservation(git.after);
  return gitMotionSignal({
    changedFiles: git.changedFiles,
    headBefore: observedGitHead(before ?? undefined),
    headAfter: observedGitHead(after ?? undefined),
    restoreTargetHead: restoreTargetHead ?? null,
  });
}

/** Machine-observed git motion for the most recent contiguous window.
 * A clean worktree is not the same thing as no progress: commit-per-slice
 * workflows leave no file delta even though HEAD advanced. Unknown motion in
 * any round makes the window undecidable rather than falsely empty. */
export function machineGitMotionSeries(
  rounds: ReadonlyArray<CommittedRoundView>,
  currentRound: number,
  lookback: number,
): boolean[] | null {
  if (!Number.isInteger(lookback) || lookback < 1 || currentRound <= lookback) return null;
  const byRound = new Map<number, CommittedRoundView>();
  for (const round of rounds) {
    if (round.round < 1 || round.round >= currentRound) continue;
    byRound.set(round.round, round);
  }
  const recent: CommittedRoundView[] = [];
  for (let number = currentRound - lookback; number < currentRound; number++) {
    const round = byRound.get(number);
    if (!round) return null;
    if (!round.observationDelta.some((delta) => delta.kind === "git")) return null;
    recent.push(round);
  }
  const motion: boolean[] = [];
  for (const round of recent) {
    const git = round.observationDelta.find((delta) => delta.kind === "git")!;
    // The round's baseline: its own before observation, else the previous
    // round's after observation. Older Git observations do not carry a HEAD
    // field; their change set is still a valid motion signal.
    const baseline = observedGitObservation(git.before)
      ?? observedGitIn(byRound.get(round.round - 1)?.afterEvidence ?? []);
    const after = observedGitObservation(git.after);
    const signal = gitMotionSignal({
      changedFiles: git.changedFiles,
      headBefore: observedGitHead(baseline ?? undefined),
      headAfter: observedGitHead(after ?? undefined),
    });
    if (signal === null) return null;
    motion.push(signal);
  }
  return motion;
}
