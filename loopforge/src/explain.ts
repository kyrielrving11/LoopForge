/** v3.8: `loopforge explain` — the per-round "why" view.
 *
 * Read-only projection over the shared read model: committed round views,
 * the contract item reducer, machine observations, verification flags, and
 * the committed enforcement result. It never rebuilds history and never
 * writes. Every fact it prints is one the runtime already derived.
 */

import {
  readOnlyRollbacks,
  readOnlyRounds,
} from "./committed-round.js";
import { observedGitHead } from "./git-motion.js";
import { deriveCommittedSubmissionView } from "./submission-receipt.js";
import type { SubmissionReceipt } from "./protocol.js";
import {
  committedRoundFacts,
  deriveActiveRoundContract,
  deriveRoundContractView,
} from "./round-contract.js";
import { getPolicy } from "./policy.js";
import type { VaultEntry } from "./loop-store.js";

export interface ExplainRound {
  round: number;
  roundId: string;
  attempt: number;
  action: string;
  outcome: string | null;
  /** v4.0.2: the committed context boundary this round was compiled under. */
  context: {
    mode: "fresh_round" | "same_round_retry";
    reason: "first_round" | "next_round" | "recovery_redo" | "enforcement_retry";
  } | null;
  /** The agent's own report, quoted back for audit. Present whenever the
   *  committed evaluation exists, even without an execution_report. */
  report: {
    output_summary: string;
    success: boolean;
    criterion_claims: Array<{ criterion_id: string; outcome: string }>;
    contract_item_claims: Array<{ item_id: string; outcome: string }>;
  } | null;
  /** v4.0.2: committed Agent reports, bounded for display. */
  wrongAssumptions: string[];
  retractedConstraints: string[];
  openQuestions: string[];
  blocker: string | null;
  /** What the machine observed this round. */
  observations: Array<{
    providerId: string;
    kind: string;
    phase: string;
    status: string;
    files: string[];
  }>;
  /** The derived before→after delta — never persisted. Raw observations keep
   *  their own `files` in `observations`; this block carries only the change
   *  set, which is null when the boundary pair is not comparable. */
  observationDelta: Array<{
    providerId: string;
    kind: string;
    changedFiles: string[] | null;
    beforeStatus: string | null;
    afterStatus: string | null;
    /** v3.9.9: the provider's derived progress fact for this delta, with its
     *  coverage. This is the same fact the rules select; it is not re-judged. */
    progress: {
      kind: "git" | "custom";
      coverage: {
        domain: string;
        object: string;
        scope: string;
        version: number;
      };
      state: "changed" | "unchanged" | "unknown";
      complete: boolean;
      detail?: string;
    } | null;
  }>;
  /** v3.9.1: the Git boundary facts, from the same shared derivation. */
  files_changed: string[] | null;
  git_change_state: "not_applicable" | "unknown" | "observed";
  head_before: string | null;
  head_after: string | null;
  git_status: string | null;
  coverage: string | null;
  /** v3.9.1: the committed submission's receipt (same derivation as status). */
  submission: SubmissionReceipt;
  /** True when the round committed without a complete observable boundary. */
  evidenceIncomplete: boolean;
  /** Committed verification findings. */
  flags: Array<{ check: string; severity: string; detail: string; ref?: string }>;
  /** The contract the round executed under, and every item's derived status. */
  contract: {
    id: string;
    declared_at_round: number;
    closure: string;
    items: Array<{ itemId: string; status: string; reasons: string[] }>;
  } | null;
  /** v3.9.9: this round's explicit contract redirect, report-only. */
  contractTransition: {
    kind: "supersede";
    contract_id: string;
    reason?: string;
  } | null;
}

/** v4.0.2: display caps for report facts. Committed originals stay in the
 *  transaction; explain is a bounded read-only view. */
function clip(text: string | undefined, maxChars: number): string {
  const value = text ?? "";
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function clipList(
  values: ReadonlyArray<string> | undefined,
  maxChars: number,
): string[] {
  return (values ?? []).map((value) => clip(value, maxChars));
}

export interface ExplainResult {
  loopId: string;
  /** Only the requested round when `round` was given. */
  rounds: ExplainRound[];
  /** The contract active for the NEXT round (derived), when one exists. */
  activeContract: { id: string; work_item?: string; itemCount: number } | null;
  /** v3.9.6: committed rollback directives as events, never normal rounds. */
  rollbacks: Array<{
    round: number;
    transactionId: string;
    origin: "agent" | "machine";
    redoRound: number;
    targetCheckpointId: string;
    reason: string;
    skippedFiles: string[];
    /** v4.0.2: the directive's committed abandoned-path facts, same caps as
     *  Working Memory and replay. */
    failedRounds: number[];
    approaches: string[];
    wrongAssumptions: string[];
  }>;
}

/** Build the explain view. Pure and read-only. */
export function buildExplain(
  loopId: string,
  entries: VaultEntry[],
  round?: number,
): ExplainResult {
  const all = readOnlyRounds(entries);
  const rollbacks = readOnlyRollbacks(entries);
  const commands = getPolicy().evidence.commands ?? [];
  const active = deriveActiveRoundContract(all, commands);
  const selected = round === undefined
    ? all
    : all.filter((view) => view.round === round);

  const rounds: ExplainRound[] = selected.map((view) => {
    // v3.8: the contract this round EXECUTED under and its status AS OF this
    // round — the same derivation the coordinator runs live. Deriving from
    // `round <= view.round` handed the closing round its successor's contract
    // (the walker had already seen this round close the active one); deriving
    // from `round < view.round` with this round as the in-flight slice reports
    // what actually happened, including a `blocked` closure.
    const { contract, statuses } = deriveRoundContractView({
      rounds: all,
      round: view.round,
      current: committedRoundFacts(view),
      commands,
    });
    const gitBefore = view.beforeEvidence.find((item) => item.providerId === "git");
    const gitAfter = view.afterEvidence.find((item) => item.providerId === "git");
    const gitDelta = view.observationDelta.find((item) => item.kind === "git");
    const coverage = gitAfter && gitAfter.kind === "git" &&
      typeof gitAfter.data.coverage === "string"
      ? gitAfter.data.coverage
      : null;
    const submission = deriveCommittedSubmissionView(view, all, rollbacks);
    return {
      round: view.round,
      roundId: view.roundId,
      attempt: view.attempt,
      action: view.action,
      outcome: view.outcome,
      context: view.promptArtifact
        ? {
            mode: view.promptArtifact.contextMode,
            reason: view.promptArtifact.contextReason,
          }
        : null,
      // v4.0.2: a committed evaluation always carries a report; claims are an
      // optional execution_report projection, defaulting to [].
      report: view.evaluation
        ? {
            output_summary: clip(view.evaluation.output_summary, 4000),
            success: view.evaluation.success,
            criterion_claims: (view.executionReport?.criterion_claims ?? []).map((claim) => ({
              criterion_id: claim.criterion_id,
              outcome: claim.outcome,
            })),
            contract_item_claims: (view.executionReport?.contract_item_claims ?? []).map((claim) => ({
              item_id: claim.item_id,
              outcome: claim.outcome,
            })),
          }
        : null,
      wrongAssumptions: clipList(view.evaluation?.wrong_assumptions, 500),
      retractedConstraints: clipList(view.retractedConstraints, 500),
      openQuestions: clipList(view.openQuestions, 300),
      blocker: view.evaluation?.blocker
        ? clip(view.evaluation.blocker, 500)
        : null,
      observations: view.afterEvidence.map((observation) => ({
        providerId: observation.providerId,
        kind: observation.kind,
        phase: observation.phase,
        status: observation.status,
        files: observation.files,
      })),
      observationDelta: view.observationDelta.map((delta) => ({
        providerId: delta.providerId,
        kind: delta.kind,
        changedFiles: delta.changedFiles === null ? null : [...delta.changedFiles],
        beforeStatus: delta.before?.status ?? null,
        afterStatus: delta.after?.status ?? null,
        progress: delta.progress
          ? {
              kind: delta.progress.kind,
              coverage: { ...delta.progress.coverage },
              state: delta.progress.state,
              complete: delta.progress.complete,
              ...(delta.progress.detail ? { detail: delta.progress.detail } : {}),
            }
          : null,
      })),
      files_changed: gitDelta?.changedFiles ?? null,
      git_change_state: gitDelta === undefined
        ? "not_applicable"
        : gitDelta.changedFiles === null ? "unknown" : "observed",
      head_before: observedGitHead(gitBefore),
      head_after: observedGitHead(gitAfter),
      git_status: gitAfter?.status ?? null,
      coverage,
      submission,
      evidenceIncomplete: view.evidenceIncomplete,
      flags: view.verificationFlags.map((flag) => ({
        check: flag.check,
        severity: flag.severity,
        detail: flag.detail,
        ...(flag.ref ? { ref: flag.ref } : {}),
      })),
      contract: statuses.contractId
        ? {
            id: statuses.contractId,
            declared_at_round: contract?.declared_at_round ?? 0,
            closure: statuses.closure,
            items: statuses.items.map((item) => ({
              itemId: item.itemId,
              status: item.status,
              reasons: item.reasons,
            })),
          }
        : null,
      contractTransition: view.contractTransition
        ? {
            kind: view.contractTransition.kind,
            contract_id: view.contractTransition.contract_id,
            ...(view.contractTransition.reason !== undefined
              ? { reason: view.contractTransition.reason }
              : {}),
          }
        : null,
    };
  });

  return {
    loopId,
    rounds,
    activeContract: active
      ? { id: active.id, work_item: active.work_item, itemCount: active.items.length }
      : null,
    rollbacks: rollbacks.map((view) => ({
      round: view.round,
      transactionId: view.transactionId ?? view.roundId,
      origin: view.origin === "agent" ? "agent" as const : "machine" as const,
      redoRound: view.recovery?.target.redo_round ?? 0,
      targetCheckpointId: view.recovery?.target.checkpoint_id ?? "",
      reason: clip(view.recovery?.reason, 500),
      skippedFiles: [...(view.recovery?.skipped_files ?? [])],
      failedRounds: [...(view.recovery?.failed_rounds ?? [])],
      approaches: clipList(view.recovery?.approaches, 200),
      wrongAssumptions: clipList(view.recovery?.wrong_assumptions, 500),
    })),
  };
}

/** Human-readable rendering of the explain view (CLI default). */
export function renderExplain(result: ExplainResult): string {
  const lines: string[] = [`Loop ${result.loopId}`];
  if (result.activeContract) {
    lines.push(
      `Active contract: ${result.activeContract.id}` +
      (result.activeContract.work_item ? ` — ${result.activeContract.work_item}` : "") +
      ` (${result.activeContract.itemCount} item(s))`,
    );
  }
  for (const round of result.rounds) {
    const context = round.context
      ? ` — context ${round.context.mode} (${round.context.reason})`
      : "";
    lines.push("", `Round ${round.round} (${round.roundId}, attempt ${round.attempt}) — ${round.action}${round.outcome ? ` / ${round.outcome}` : ""}${context}`);
    if (round.report) {
      lines.push(`  report: success=${round.report.success} — ${round.report.output_summary.slice(0, 200)}`);
      for (const claim of round.report.contract_item_claims) {
        lines.push(`    item claim: ${claim.item_id} → ${claim.outcome}`);
      }
    }
    for (const assumption of round.wrongAssumptions) {
      lines.push(`  wrong assumption (report): ${assumption.slice(0, 160)}`);
    }
    for (const retraction of round.retractedConstraints) {
      lines.push(`  retracted constraint (report): ${retraction.slice(0, 160)}`);
    }
    for (const question of round.openQuestions) {
      lines.push(`  open question (report): ${question.slice(0, 160)}`);
    }
    if (round.blocker) {
      lines.push(`  blocker: ${round.blocker.slice(0, 160)}`);
    }
    for (const observation of round.observations) {
      lines.push(`  observation: ${observation.providerId} [${observation.status}] ${observation.files.length} file(s)`);
    }
    if (round.evidenceIncomplete) {
      lines.push("  evidence: INCOMPLETE — the round committed without after-phase observations");
    }
    for (const flag of round.flags) {
      lines.push(`  flag: ${flag.severity} ${flag.check} — ${flag.detail.slice(0, 160)}`);
    }
    if (round.contract) {
      lines.push(`  contract ${round.contract.id} → ${round.contract.closure}`);
      for (const item of round.contract.items) {
        lines.push(`    ${item.itemId}: ${item.status}${item.reasons.length > 0 ? ` — ${item.reasons[0]}` : ""}`);
      }
    }
    if (round.contractTransition) {
      lines.push(
        `  contract transition: ${round.contractTransition.kind} ` +
        `${round.contractTransition.contract_id}` +
        (round.contractTransition.reason
          ? ` — ${round.contractTransition.reason.slice(0, 160)} (report only)`
          : " (report only)"),
      );
    }
  }
  for (const rollback of result.rollbacks) {
    lines.push(
      "",
      `Rollback R${rollback.round} (${rollback.origin}) → redo R${rollback.redoRound}` +
      `, checkpoint ${rollback.targetCheckpointId}`,
    );
    if (rollback.reason) {
      lines.push(`  reason: ${rollback.reason.slice(0, 200)}`);
    }
    if (rollback.failedRounds.length > 0) {
      lines.push(`  failed rounds: R${rollback.failedRounds.join(", R")}`);
    }
    for (const approach of rollback.approaches) {
      lines.push(`  abandoned approach (report): ${approach.slice(0, 160)}`);
    }
    for (const assumption of rollback.wrongAssumptions) {
      lines.push(`  wrong assumption (report): ${assumption.slice(0, 160)}`);
    }
  }
  return lines.join("\n");
}
