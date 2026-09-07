/** Canonical read model for committed rounds.
 *
 * Durable documents remain the source of truth. This module is the only
 * place that interprets their transaction envelope or the compiler's merged
 * lineage representation. Consumers receive one stable, read-only view.
 */

import type { ProviderSnapshot } from "./evidence-provider.js";
import type { VaultEntry } from "./loop-store.js";
import type {
  ExecutionEvidence,
  PromptArtifact,
  RoundContract,
  RoundOutcome,
  SelfEvaluation,
  SubGoalUpdate,
  VerificationFlag,
} from "./protocol.js";
import type { RoundProcessResult } from "./round-coordinator.js";
import { parseRoundTransactionSnapshot } from "./round-transaction.js";
import { effectiveOutcome, parseRoundContract } from "./self-eval.js";
import { entryRound, isRecord } from "./token-utils.js";

export type CommittedAction = "continue" | "stop" | "backtrack";

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
  readonly executionEvidence: ExecutionEvidence | null;
  readonly verificationFlags: VerificationFlag[];
  readonly result: RoundProcessResult | null;
  readonly action: CommittedAction;
  readonly success: boolean;
  readonly outcome: RoundOutcome | null;
  readonly contractProposal: RoundContract | null;
  readonly beforeEvidence: ProviderSnapshot[];
  readonly afterEvidence: ProviderSnapshot[];
  readonly roundEvidence: ProviderSnapshot[];
  /** Normalized round-level declarations used by compiler projections. */
  readonly outputSummary?: string;
  readonly constraintViolations?: string[];
  readonly discoveredConstraints?: string[];
  readonly activeConstraints?: string[];
  readonly retractedConstraints?: string[];
  readonly emergedSubtasks?: string[];
  readonly subgoalUpdates?: SubGoalUpdate[];
}

function committedAction(value: unknown): CommittedAction | null {
  return value === "continue" || value === "stop" || value === "backtrack"
    ? value
    : null;
}

function snapshots(value: unknown): ProviderSnapshot[] {
  return Array.isArray(value) ? value as ProviderSnapshot[] : [];
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
export function decodeCommittedRound(entry: VaultEntry): CommittedRoundView | null {
  if (!String(entry.task_id ?? "").endsWith(":feedback")) return null;
  const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
  const transaction = lineage && isRecord(lineage.round_transaction)
    ? lineage.round_transaction
    : null;
  if (!transaction) return null;
  const snapshot = parseRoundTransactionSnapshot(transaction.snapshot);
  if (snapshot && snapshot.phase !== "committed") return null;
  const resultValue = isRecord(transaction.result)
    ? transaction.result
    : snapshot?.result;
  if (!isRecord(resultValue)) return null;
  const action = committedAction(resultValue.action);
  if (!action) return null;
  const result = resultValue as unknown as RoundProcessResult;
  const round = snapshot?.round ?? entryRound(entry as unknown as Record<string, unknown>);
  const loopId = snapshot?.loopId ?? String(entry.loop_id ?? lineage?.loop_id ?? "");
  if (round < 1 || !loopId) return null;
  const evaluation = snapshot?.evaluation ?? null;
  const outcome = evaluation ? effectiveOutcome(evaluation) : null;
  const sequence = typeof entry.sequence === "number" ? entry.sequence : undefined;
  return {
    source: "feedback",
    sourceEntry: entry,
    loopId,
    round,
    roundId: snapshot?.roundId ?? String(transaction.round_id ?? `loop:${loopId}:round:${round}`),
    sequence,
    attempt: snapshot?.attempt ?? 1,
    promptArtifact: snapshot?.promptArtifact ?? null,
    evaluation,
    executionEvidence: evaluation?.execution_evidence ?? null,
    verificationFlags: flags(result.verificationFlags),
    result,
    action,
    success: result.roundSuccess === true,
    outcome,
    contractProposal: evaluation?.round_contract
      ? parseRoundContract(evaluation.round_contract) ?? null
      : null,
    beforeEvidence: snapshots(snapshot?.beforeEvidence),
    afterEvidence: snapshots(snapshot?.afterEvidence),
    roundEvidence: snapshots(snapshot?.roundEvidence),
    outputSummary: evaluation?.output_summary,
    constraintViolations: strings(evaluation?.constraint_violations),
    discoveredConstraints: strings(evaluation?.discovered_constraints),
    activeConstraints: strings(lineage?.constraints_active),
    retractedConstraints: strings(evaluation?.retracted_constraints),
    emergedSubtasks: strings(evaluation?.emerged_subtasks),
    subgoalUpdates: subGoalUpdates(evaluation?.subgoal_updates),
  };
}

/** Decode an in-memory lineage entry after the engine merged its committed
 * feedback. The merged shape is intentionally accepted only when stamped
 * with committed_action. */
export function decodeMergedRound(entry: unknown): CommittedRoundView | null {
  if (!isRecord(entry)) return null;
  const raw = entry as Record<string, unknown>;
  // v3.7: the legacy top-level `lineage` alias was removed — committed
  // entries always carry `loop_lineage`.
  const lineage = isRecord(raw.loop_lineage) ? raw.loop_lineage : {};
  const action = committedAction(lineage.committed_action ?? raw.committed_action);
  if (!action) return null;
  const round = entryRound(raw);
  if (round < 1) return null;
  const loopId = typeof raw.loop_id === "string"
    ? raw.loop_id
    : typeof lineage.loop_id === "string" ? lineage.loop_id : "";
  const roundId = typeof lineage.round_id === "string"
    ? lineage.round_id
    : `loop:${loopId}:round:${round}`;
  const evaluationRaw: Record<string, unknown> = {};
  const evaluationKeys = [
    "success", "output_summary", "constraint_violations", "should_continue",
    "discovered_constraints", "objective_refinement", "emerged_subtasks",
    "execution_evidence", "retracted_constraints", "revised_success_criteria",
    "wrong_assumptions", "worker_results", "compression_checkpoint",
    "checkpoint_label", "next_action", "subgoal_updates", "stop_reason",
    "outcome", "blocker", "gate_ids",
    "retroactiveClaims", "no_change_reason", "drift_clarification",
    "prompt_requests", "round_contract",
  ];
  let hasEvaluation = false;
  for (const key of evaluationKeys) {
    const value = raw[key] ?? lineage[key];
    if (value !== undefined) {
      evaluationRaw[key] = value;
      hasEvaluation = true;
    }
  }
  const evaluation = hasEvaluation
    ? evaluationRaw as unknown as SelfEvaluation
    : null;
  const resultRaw = isRecord(lineage.result) ? lineage.result : null;
  const result = resultRaw ? resultRaw as unknown as RoundProcessResult : null;
  const outcome = roundOutcome(evaluationRaw.outcome) ??
    (typeof evaluationRaw.success === "boolean"
      ? evaluationRaw.success ? "success" : "failed"
      : null);
  const proposal = parseRoundContract(evaluationRaw.round_contract) ?? null;
  const executionEvidence = isRecord(evaluationRaw.execution_evidence)
    ? evaluationRaw.execution_evidence as unknown as ExecutionEvidence
    : null;
  return {
    source: "merged",
    sourceEntry: raw,
    loopId,
    round,
    roundId,
    sequence: typeof lineage.sequence === "number" ? lineage.sequence : undefined,
    attempt: typeof lineage.attempt === "number" ? lineage.attempt : 1,
    promptArtifact: isRecord(lineage.prompt_artifact)
      ? lineage.prompt_artifact as unknown as PromptArtifact
      : null,
    evaluation,
    executionEvidence,
    verificationFlags: flags(raw.verification_flags ?? lineage.verification_flags),
    result,
    action,
    success: typeof raw.success === "boolean"
      ? raw.success
      : typeof lineage.success === "boolean" ? lineage.success : false,
    outcome,
    contractProposal: proposal,
    beforeEvidence: snapshots(lineage.before_evidence),
    afterEvidence: snapshots(lineage.after_evidence),
    roundEvidence: snapshots(lineage.round_evidence),
    outputSummary: typeof evaluationRaw.output_summary === "string"
      ? evaluationRaw.output_summary
      : undefined,
    constraintViolations: strings(evaluationRaw.constraint_violations),
    discoveredConstraints: strings(evaluationRaw.discovered_constraints),
    activeConstraints: strings(raw.constraints_active ?? lineage.constraints_active),
    retractedConstraints: strings(evaluationRaw.retracted_constraints),
    emergedSubtasks: strings(evaluationRaw.emerged_subtasks),
    subgoalUpdates: subGoalUpdates(evaluationRaw.subgoal_updates),
  };
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

/** Extract execution_evidence from an entry, handling both direct-field and
 *  lineage-nested shapes. The decoded committed view wins when the entry is
 *  a committed round. Returns null when absent. Moved from loop-compiler so
 *  field-shape interpretation lives in this module only. */
export function entryExecutionEvidence(entry: unknown): Record<string, unknown> | null {
  const view = decodeRound(entry);
  if (view) return view.executionEvidence as Record<string, unknown> | null;
  const record = isRecord(entry) ? entry : {};
  const direct = record.execution_evidence;
  if (isRecord(direct)) return direct;
  const nested = entryLineage(entry).execution_evidence;
  return isRecord(nested) ? nested : null;
}

/** Read success_criteria_met from an entry's execution_evidence. */
export function entryCriteriaMet(entry: unknown): string[] {
  const view = decodeRound(entry);
  if (view) return view.executionEvidence?.success_criteria_met
    ?.filter((value): value is string => typeof value === "string") ?? [];
  const ev = entryExecutionEvidence(entry);
  if (!ev) return [];
  const arr = ev.success_criteria_met;
  return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
}

/** Read success_criteria_remaining from an entry's execution_evidence. */
export function entryCriteriaRemaining(entry: unknown): string[] {
  const view = decodeRound(entry);
  if (view) return view.executionEvidence?.success_criteria_remaining
    ?.filter((value): value is string => typeof value === "string") ?? [];
  const ev = entryExecutionEvidence(entry);
  if (!ev) return [];
  const arr = ev.success_criteria_remaining;
  return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
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

/** Read progress_estimate from an entry's execution_evidence (0 when
 *  absent). */
export function entryProgressEstimate(entry: unknown): number {
  const ev = entryExecutionEvidence(entry);
  if (!ev) return 0;
  const pe = ev.progress_estimate;
  return typeof pe === "number" ? pe : 0;
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

export function committedRoundsFromEntries(
  entries: VaultEntry[],
  beforeRound = Number.POSITIVE_INFINITY,
): CommittedRoundView[] {
  return historyRounds(entries.map(decodeCommittedRound), beforeRound);
}

/** The machine-evidence set that best represents a committed round: the
 *  after-phase evidence (captured post-execution), else the round's committed
 *  diff evidence, else the pre-round baseline. Shared selector for the
 *  evidence-fallback chains that audit, claims, and backtrack-restore each
 *  used to inline with subtly different tiers — the enforcement-gate variant
 *  previously skipped roundEvidence entirely. Distinct from
 *  machineGitMotionSeries, which deliberately reads roundEvidence alone for
 *  the diffed motion signal. */
export function machineEvidenceForRound(
  view: CommittedRoundView,
): ProviderSnapshot[] {
  if (view.afterEvidence.length > 0) return view.afterEvidence;
  if (view.roundEvidence.length > 0) return view.roundEvidence;
  return view.beforeEvidence;
}

export function mergedRoundsFromEntries(
  entries: unknown[],
  beforeRound = Number.POSITIVE_INFINITY,
): CommittedRoundView[] {
  return historyRounds(entries.map(decodeMergedRound), beforeRound);
}

/** Machine-observed git motion for the most recent contiguous window.
 * Consumers must decode durable or hydrated entries before calling this;
 * transaction-envelope interpretation stays confined to this module. */
export function machineGitMotionSeries(
  rounds: ReadonlyArray<CommittedRoundView>,
  currentRound: number,
  lookback: number,
): boolean[] | null {
  const byRound = new Map<number, boolean>();
  for (const round of rounds) {
    if (round.round < 1 || round.round >= currentRound) continue;
    const git = round.roundEvidence.find((snapshot) => snapshot.provider === "git");
    if (!git) continue;
    byRound.set(round.round, Array.isArray(git.files) && git.files.length > 0);
  }
  if (byRound.size < lookback) return null;
  const recent = [...byRound.keys()].sort((a, b) => a - b).slice(-lookback);
  if (recent[0] < currentRound - lookback) return null;
  return recent.map((round) => byRound.get(round)!);
}
