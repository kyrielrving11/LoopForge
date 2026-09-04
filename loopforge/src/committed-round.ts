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
  readonly completedSubtasks?: string[];
  readonly blockedSubtasks?: string[];
  readonly canceledSubtasks?: string[];
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
    completedSubtasks: strings(evaluation?.completed_subtasks),
    blockedSubtasks: strings(evaluation?.blocked_subtasks),
    canceledSubtasks: strings(evaluation?.canceled_subtasks),
  };
}

/** Decode an in-memory lineage entry after the engine merged its committed
 * feedback. The merged shape is intentionally accepted only when stamped
 * with committed_action. */
export function decodeMergedRound(entry: unknown): CommittedRoundView | null {
  if (!isRecord(entry)) return null;
  const raw = entry as Record<string, unknown>;
  const lineageValue = raw.loop_lineage ?? raw.lineage;
  const lineage = isRecord(lineageValue) ? lineageValue : {};
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
    "checkpoint_label", "next_action", "completed_subtasks", "blocked_subtasks",
    "canceled_subtasks", "stop_reason", "outcome", "blocker",
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
    completedSubtasks: strings(evaluationRaw.completed_subtasks),
    blockedSubtasks: strings(evaluationRaw.blocked_subtasks),
    canceledSubtasks: strings(evaluationRaw.canceled_subtasks),
  };
}

/** Normalize committed history: rollback directives disappear, later records
 * replace earlier records for the same logical round, and output is ascending. */
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
