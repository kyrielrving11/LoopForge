/** v3.8/v4.0.3: `loopforge explain` — the per-round "why" view.
 *
 * Read-only projection over the shared read model: committed round views,
 * the persisted evidence posture, machine observations, verification flags,
 * checkpoints/restore markers and the committed enforcement result. It never
 * rebuilds history and never writes.
 *
 * v4.0.3: the view exposes the FULL command observations (before and after)
 * with truncation metadata, so replay/explain are the complete-observation
 * read surfaces the prompt intentionally points at.
 */

import {
  readOnlyRollbacks,
  readOnlyRounds,
} from "./committed-round.js";
import { gitRoundFacts } from "./git-facts.js";
import { deriveCommittedSubmissionView } from "./submission-receipt.js";
import type {
  EvidencePosture,
  GitObservation,
  MachineObservation,
  PromptContextMode,
  PromptContextReason,
  RoundOutcome,
  StopReason,
  SubmissionReceipt,
} from "./protocol.js";
import { renderResultFacts } from "./result-facts.js";
import { formatContextBoundaryLabel } from "./round-guidance.js";
import {
  committedRoundFacts,
  deriveActiveRoundContract,
  deriveRoundContractView,
} from "./round-contract.js";
import { getPolicy } from "./policy.js";
import type { VaultEntry } from "./loop-store.js";
import { deriveOpenQuestionId } from "./open-question.js";

export interface ExplainObservation {
  providerId: string;
  kind: string;
  phase: string;
  status: string;
  files: string[];
  /** Full machine data. Command observations carry argv/exit/streams/etc. */
  data: Record<string, unknown>;
}

export interface ExplainCheckpoint {
  checkpoint_id: string;
  role: "before" | "mid";
  round: number;
  content_hash: string;
}

export interface ExplainRound {
  round: number;
  roundId: string;
  attempt: number;
  /** Optional transaction/branch identity: a redo may reuse the same numeric
   *  round on a child branch, and these are what distinguish it. */
  branchId?: string;
  transactionId?: string;
  action: string;
  /** v4.0.4: LoopForge's committed terminal reason, when the round stopped the
   *  loop. Renamed from `stopReason` so it cannot be read as the Agent's
   *  `agent_stop_reason`. */
  loopStopReason: StopReason | null;
  /** v4.0.3: the Agent's claim (never a machine verdict). */
  agentSuccessClaim: boolean;
  /** v4.0.3: the effective Agent-declared outcome. */
  agentOutcome: RoundOutcome | null;
  /** v4.0.4: the raw `evaluation.outcome`; null means it was derived from
   *  `success`, not declared. */
  agentOutcomeDeclared: RoundOutcome | null;
  /** v4.0.4: the Agent's declared stop reason (an Agent report). */
  agentStopReason: "gave_up" | "blocked" | "needs_human_input" | null;
  /** v4.0.4: the Agent's declared should_continue. */
  agentShouldContinue: boolean | null;
  /** v4.0.3: the ONE persisted posture. `machineBackedSuccess` lives only
   *  inside it; Explain no longer repeats it at the top level. */
  evidencePosture: EvidencePosture | null;
  /** v4.0.4: the committed enforcement reason, when one was recorded. */
  enforcementReason: string | null;
  /** v4.0.2: the committed context boundary this round was compiled under. */
  context: {
    mode: PromptContextMode;
    reason: PromptContextReason;
  } | null;
  /** The agent's own report, quoted back for audit. Present whenever the
   *  committed evaluation exists, even without an execution_report. */
  report: {
    output_summary: string;
    no_change_reason: string | null;
    subtask_boundary_label: string | null;
    criterion_claims: Array<{ criterion_id: string; outcome: string }>;
    contract_item_claims: Array<{ item_id: string; outcome: string }>;
    worker_results: Array<{
      agent_id: string;
      sub_task: string;
      result_summary: string;
      outcome: string;
    }>;
    retroactive_claims: Array<{ round: number; claim: string }>;
    gate_ids: string[];
    subgoal_updates: Array<{ id: string; status: string; status_note?: string }>;
    /** v4.0.3: the remaining Agent report fields, bounded for display. */
    constraint_violations: string[];
    discovered_constraints: string[];
    emerged_subtasks: string[];
    truncated: Record<string, boolean>;
  } | null;
  /** v4.0.2: committed Agent reports, bounded for display. */
  wrongAssumptions: string[];
  retractedConstraints: string[];
  openQuestions: string[];
  openQuestionIds: string[];
  resolvedOpenQuestionIds: string[];
  blocker: string | null;
  /** v4.0.3: BOTH sides of the round boundary, with full command data. */
  observations: {
    before: ExplainObservation[];
    after: ExplainObservation[];
  };
  /** The derived before→after delta — never persisted. */
  observationDelta: Array<{
    providerId: string;
    kind: string;
    changedFiles: string[] | null;
    beforeStatus: string | null;
    afterStatus: string | null;
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
  /** v3.9.1: the Git boundary facts, from the shared union selector. */
  files_changed: string[] | null;
  git_change_state: "not_applicable" | "unknown" | "observed";
  head_before: string | null;
  head_after: string | null;
  git_status: string | null;
  coverage: string | null;
  /** v3.9.7: the committed checkpoints and verified-restore marker. */
  checkpoints: ExplainCheckpoint[];
  restore: {
    directive_transaction_id: string;
    redo_round: number;
    verified_at: number;
  } | null;
  restore_verified: boolean;
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
  /** v4.0.3: this round's explicit contract redirect, report-only. */
  contractRedirect: {
    kind: "supersede";
    contract_id: string;
    reason?: string;
  } | null;
  /** Per-field clipping metadata. A true value means the displayed text is a
   *  bounded excerpt, never the committed original. */
  truncated: Record<string, boolean>;
}

/** v4.0.2: display caps for report facts. Committed originals stay in the
 *  transaction; explain is a bounded read-only view. */
function clip(text: string | undefined, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  const value = text ?? "";
  return value.length > maxChars
    ? { text: value.slice(0, maxChars), truncated: true }
    : { text: value, truncated: false };
}

function clipList(
  values: ReadonlyArray<string> | undefined,
  maxChars: number,
): { values: string[]; truncated: boolean } {
  let truncated = false;
  const out = (values ?? []).map((value) => {
    const clipped = clip(value, maxChars);
    truncated ||= clipped.truncated;
    return clipped.text;
  });
  return { values: out, truncated };
}

function observationView(observation: MachineObservation): ExplainObservation {
  return {
    providerId: observation.providerId,
    kind: observation.kind,
    phase: observation.phase,
    status: observation.status,
    files: [...observation.files],
    data: { ...(observation.data as Record<string, unknown>) },
  };
}

export interface ExplainRollback {
  round: number;
  transactionId: string;
  origin: "agent" | "machine";
  redoRound: number;
  targetCheckpointId: string;
  reason: string;
  observedSkippedFiles: string[];
  reportedSkippedFiles: string[];
  /** Union of observed + reported. */
  skippedFiles: string[];
  abandonedRounds: number[];
  failedRounds: number[];
  approaches: string[];
  wrongAssumptions: string[];
  /** v4.0.3: Agent reports preserved by the rollback. */
  preservedDiscoveries: string[];
  triggerFindings: Array<{
    check: string;
    severity: string;
    field: string;
    detail: string;
    ref?: string;
  }>;
}

export interface ExplainResult {
  loopId: string;
  /** Only the requested round when `round` was given. */
  rounds: ExplainRound[];
  /** The contract active for the NEXT round (derived), when one exists. */
  activeContract: { id: string; work_item?: string; itemCount: number } | null;
  /** v3.9.6: committed rollback directives as events, never normal rounds. */
  rollbacks: ExplainRollback[];
  /** v4.0.4: rounds whose persisted envelope is an unsupported schema. They
   *  are NOT decoded into fake round rows; the count makes the loss visible
   *  instead of showing a silently empty timeline. */
  legacyRounds: number;
}

/** Build the explain view. Pure and read-only.
 *
 *  `legacyRounds` is the loader's explicit legacy count
 *  (`loadCommittedHistory(...).legacyRounds.length`); it is passed through so
 *  Explain never re-scans for it and never migrates it. */
export function buildExplain(
  loopId: string,
  entries: VaultEntry[],
  round?: number,
  legacyRounds = 0,
): ExplainResult {
  // v4.0.3: the public function must not mix another loop's records even when
  // a caller passes a multi-loop entry list.
  const all = readOnlyRounds(entries).filter((view) => view.loopId === loopId);
  const rollbacks = readOnlyRollbacks(entries)
    .filter((view) => view.loopId === loopId);
  const commands = getPolicy().evidence.commands ?? [];
  const active = deriveActiveRoundContract(all, commands);
  const selected = round === undefined
    ? all
    : all.filter((view) => view.round === round);

  const rounds: ExplainRound[] = selected.map((view) => {
    // v3.8: the contract this round EXECUTED under and its status AS OF this
    // round — the same derivation the coordinator runs live.
    const { contract, statuses } = deriveRoundContractView({
      rounds: all,
      round: view.round,
      current: committedRoundFacts(view),
      commands,
    });
    const git = gitRoundFacts(view.observationDelta);
    const coverage = view.afterEvidence.find(
      (item): item is GitObservation => item.kind === "git",
    );
    const submission = deriveCommittedSubmissionView(view, all, rollbacks);

    const reportText = clip(view.evaluation?.output_summary, 4000);
    const noChange = clip(view.evaluation?.no_change_reason, 500);
    const subtaskLabel = clip(view.evaluation?.subtask_boundary_label, 200);
    const wrongAssumptions = clipList(view.evaluation?.wrong_assumptions, 500);
    const retracted = clipList(view.retractedConstraints, 500);
    const questions = clipList(view.openQuestions, 300);
    const blocker = clip(view.evaluation?.blocker, 500);
    const redirectReason = clip(view.contractTransition?.reason, 500);
    const constraintViolations = clipList(view.constraintViolations, 500);
    const discoveredConstraints = clipList(view.discoveredConstraints, 500);
    const emergedSubtasks = clipList(view.emergedSubtasks, 500);
    let workerTruncated = false;
    const workerResults = (view.evaluation?.worker_results ?? []).map((worker) => {
      const summary = clip(worker.resultSummary, 1000);
      workerTruncated ||= summary.truncated;
      return {
        agent_id: clip(worker.agentId, 200).text,
        sub_task: clip(worker.subTask, 500).text,
        result_summary: summary.text,
        outcome: worker.outcome,
      };
    });
    let retroTruncated = false;
    const retroactiveClaims = (view.evaluation?.retroactiveClaims ?? [])
      .map((claim) => {
        const text = clip(claim.claim, 500);
        retroTruncated ||= text.truncated;
        return { round: claim.round, claim: text.text };
      });
    const subgoalUpdates = (view.subgoalUpdates ?? []).map((update) => ({
      id: update.id,
      status: update.status,
      ...(update.note !== undefined
        ? { status_note: clip(update.note, 300).text }
        : {}),
    }));
    const checkpoints: ExplainCheckpoint[] = [
      ...(view.beforeCheckpoint ? [view.beforeCheckpoint] : []),
      ...view.checkpoints,
    ].map((ref) => ({
      checkpoint_id: ref.checkpointId,
      role: ref.role,
      round: ref.round,
      content_hash: ref.contentHash,
    }));

    return {
      round: view.round,
      roundId: view.roundId,
      attempt: view.attempt,
      ...(view.branchId ? { branchId: view.branchId } : {}),
      ...(view.transactionId ? { transactionId: view.transactionId } : {}),
      action: view.action,
      // v4.0.4: ONE source — the committed result. Explain, Replay, the
      // receipt and resume all read this same field.
      loopStopReason: view.result?.stopReason ?? null,
      agentSuccessClaim: view.agentSuccessClaim,
      agentOutcome: view.agentOutcome,
      agentOutcomeDeclared: view.evaluation?.outcome ?? null,
      agentStopReason: view.evaluation?.agent_stop_reason ?? null,
      agentShouldContinue: view.evaluation?.should_continue ?? null,
      evidencePosture: view.evidencePosture,
      enforcementReason: view.result?.enforcementReason ?? null,
      context: view.promptArtifact
        ? {
            mode: view.promptArtifact.contextMode,
            reason: view.promptArtifact.contextReason,
          }
        : null,
      report: view.evaluation
        ? {
            output_summary: reportText.text,
            no_change_reason: noChange.text || null,
            subtask_boundary_label: subtaskLabel.text || null,
            criterion_claims: (view.executionReport?.criterion_claims ?? [])
              .map((claim) => ({
                criterion_id: claim.criterion_id,
                outcome: claim.outcome,
              })),
            contract_item_claims: (view.executionReport?.contract_item_claims ?? [])
              .map((claim) => ({
                item_id: claim.item_id,
                outcome: claim.outcome,
              })),
            worker_results: workerResults,
            retroactive_claims: retroactiveClaims,
            gate_ids: [...(view.evaluation.gate_ids ?? [])],
            subgoal_updates: subgoalUpdates,
            constraint_violations: constraintViolations.values,
            discovered_constraints: discoveredConstraints.values,
            emerged_subtasks: emergedSubtasks.values,
            truncated: {
              output_summary: reportText.truncated,
              no_change_reason: noChange.truncated,
              subtask_boundary_label: subtaskLabel.truncated,
              worker_results: workerTruncated,
              retroactive_claims: retroTruncated,
              constraint_violations: constraintViolations.truncated,
              discovered_constraints: discoveredConstraints.truncated,
              emerged_subtasks: emergedSubtasks.truncated,
            },
          }
        : null,
      wrongAssumptions: wrongAssumptions.values,
      retractedConstraints: retracted.values,
      openQuestions: questions.values,
      openQuestionIds: (view.openQuestions ?? []).map(deriveOpenQuestionId),
      resolvedOpenQuestionIds: [...(view.resolvedOpenQuestionIds ?? [])],
      blocker: view.evaluation?.blocker ? blocker.text : null,
      observations: {
        before: view.beforeEvidence.map(observationView),
        after: view.afterEvidence.map(observationView),
      },
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
      files_changed: git.changedFiles,
      git_change_state: git.state,
      head_before: git.headBefore,
      head_after: git.headAfter,
      git_status: git.status,
      coverage: typeof coverage?.data.coverage === "string"
        ? coverage.data.coverage
        : null,
      checkpoints,
      restore: view.restore
        ? {
            directive_transaction_id: view.restore.directiveTransactionId,
            redo_round: view.restore.redoRound,
            verified_at: view.restore.verifiedAt,
          }
        : null,
      restore_verified: view.restore !== null,
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
      contractRedirect: view.contractTransition
        ? {
            kind: view.contractTransition.kind,
            contract_id: view.contractTransition.contract_id,
            ...(view.contractTransition.reason !== undefined
              ? { reason: redirectReason.text }
              : {}),
          }
        : null,
      truncated: {
        wrong_assumptions: wrongAssumptions.truncated,
        retracted_constraints: retracted.truncated,
        open_questions: questions.truncated,
        blocker: blocker.truncated,
        redirect_reason: redirectReason.truncated,
      },
    };
  });

  return {
    loopId,
    rounds,
    legacyRounds,
    activeContract: active
      ? { id: active.id, work_item: active.work_item, itemCount: active.items.length }
      : null,
    rollbacks: rollbacks.map((view) => ({
      round: view.round,
      transactionId: view.transactionId ?? view.roundId,
      origin: view.origin === "agent" ? "agent" as const : "machine" as const,
      redoRound: view.recovery?.target.redo_round ?? 0,
      targetCheckpointId: view.recovery?.target.checkpoint_id ?? "",
      reason: clip(view.recovery?.reason, 500).text,
      observedSkippedFiles: [...(view.recovery?.observed_skipped_files ??
        view.recovery?.skipped_files ?? [])],
      reportedSkippedFiles: [...(view.recovery?.reported_skipped_files ?? [])],
      skippedFiles: [...(view.recovery?.skipped_files ?? [])],
      abandonedRounds: [...(view.recovery?.abandoned_rounds ?? [])],
      failedRounds: [...(view.recovery?.failed_rounds ?? [])],
      approaches: clipList(view.recovery?.approaches, 200).values,
      wrongAssumptions: clipList(view.recovery?.wrong_assumptions, 500).values,
      preservedDiscoveries: clipList(view.recovery?.skipped_discoveries, 500).values,
      triggerFindings: (view.recovery?.trigger_findings ?? []).map((flag) => ({
        check: flag.check,
        severity: flag.severity,
        field: flag.field,
        detail: clip(flag.detail, 500).text,
        ...(flag.ref ? { ref: flag.ref } : {}),
      })),
    })),
  };
}

/** Human-readable rendering of the explain view (CLI default).
 *
 *  v4.0.4: every round renders the three fact blocks (Agent report,
 *  LoopForge decision, Machine evidence) through `renderResultFacts`, then the
 *  detailed audit rows. Agent claims are labelled `(Agent report)`, the
 *  machine evidence is rendered ONLY by the shared posture formatter, and the
 *  commit-time contract snapshot is labelled separately from the derived
 *  current status. No "changed"/"conflict" boolean is derived here. */
export function renderExplain(result: ExplainResult): string {
  const lines: string[] = [`Loop ${result.loopId}`];
  if (result.activeContract) {
    lines.push(
      `Active contract: ${result.activeContract.id}` +
      (result.activeContract.work_item ? ` — ${result.activeContract.work_item}` : "") +
      ` (${result.activeContract.itemCount} item(s))`,
    );
  }
  // v4.0.4: a legacy round is reported, never silently omitted and never
  // decoded into a fake row.
  if (result.legacyRounds > 0) {
    lines.push(
      `${result.legacyRounds} 4.0.3 legacy round(s) not decoded; ` +
      "use inspect/raw vault.",
    );
  }
  for (const round of result.rounds) {
    lines.push(
      "",
      `Round ${round.round} (${round.roundId}, attempt ${round.attempt})`,
    );
    if (round.context) {
      lines.push(
        `  context: ${formatContextBoundaryLabel(
          round.context.mode,
          round.context.reason,
          { recoveryBoundary: round.restore_verified },
        )}`,
      );
    }
    if (round.branchId &&
        round.branchId !== `loop:${result.loopId}:branch:root`) {
      lines.push(`  branch: ${round.branchId}`);
    }
    lines.push(
      ...renderResultFacts(
        {
          agent: {
            successClaim: round.agentSuccessClaim,
            outcome: round.agentOutcome,
            outcomeDeclared: round.agentOutcomeDeclared,
            shouldContinue: round.agentShouldContinue,
            agentStopReason: round.agentStopReason,
          },
          loopforge: {
            action: round.action as
              | "continue" | "stop" | "reject" | "terminate" | "backtrack" | "recovery",
            loopStopReason: round.loopStopReason,
            enforcementReason: round.enforcementReason,
          },
          machine: {
            posture: round.evidencePosture,
            // Explain only decodes committed evaluation rounds.
            committed: true,
          },
        },
        "explain",
      ),
    );
    if (round.report) {
      const truncated = round.report.truncated.output_summary ? " [truncated]" : "";
      lines.push(
        `  output_summary (Agent report): ` +
        `${round.report.output_summary.slice(0, 200)}${truncated}`,
      );
      if (round.report.no_change_reason) {
        lines.push(`    no_change_reason (Agent report): ${round.report.no_change_reason.slice(0, 160)}`);
      }
      if (round.report.subtask_boundary_label) {
        lines.push(`    subtask boundary (Agent report): ${round.report.subtask_boundary_label}`);
      }
      for (const claim of round.report.contract_item_claims) {
        lines.push(`    item claim (Agent report): ${claim.item_id} → ${claim.outcome}`);
      }
      for (const worker of round.report.worker_results) {
        lines.push(`    worker ${worker.agent_id} (${worker.outcome}): ${worker.result_summary.slice(0, 160)}`);
      }
      for (const retro of round.report.retroactive_claims) {
        lines.push(`    retroactive claim R${retro.round}: ${retro.claim.slice(0, 160)}`);
      }
      if (round.report.gate_ids.length > 0) {
        lines.push(`    gate ids: ${round.report.gate_ids.join(", ")}`);
      }
      for (const update of round.report.subgoal_updates) {
        lines.push(`    sub-goal ${update.id} → ${update.status}` +
          (update.status_note ? ` — ${update.status_note.slice(0, 160)}` : ""));
      }
      for (const violation of round.report.constraint_violations) {
        lines.push(`    constraint violation (Agent report): ${violation.slice(0, 160)}`);
      }
      for (const discovered of round.report.discovered_constraints) {
        lines.push(`    discovered constraint (Agent report): ${discovered.slice(0, 160)}`);
      }
      for (const emerged of round.report.emerged_subtasks) {
        lines.push(`    emerged subtask (Agent report): ${emerged.slice(0, 160)}`);
      }
    }
    if (round.resolvedOpenQuestionIds.length > 0) {
      lines.push(
        `  resolved open questions (Agent report): ` +
        round.resolvedOpenQuestionIds.slice(0, 20).join(", "),
      );
    }
    for (const assumption of round.wrongAssumptions) {
      lines.push(`  wrong assumption (Agent report): ${assumption.slice(0, 160)}`);
    }
    for (const retraction of round.retractedConstraints) {
      lines.push(`  retracted constraint (Agent report): ${retraction.slice(0, 160)}`);
    }
    for (const question of round.openQuestions) {
      lines.push(`  open question (Agent report): ${question.slice(0, 160)}`);
    }
    if (round.blocker) {
      lines.push(`  blocker (Agent report): ${round.blocker.slice(0, 160)}`);
    }
    for (const observation of round.observations.after) {
      lines.push(`  observation: ${observation.providerId} [${observation.status}] ${observation.files.length} file(s)`);
      if (observation.kind === "command") {
        const data = observation.data as Record<string, unknown>;
        const argv = Array.isArray(data.argv) ? data.argv.join(" ") : "";
        const exit = data.exitCode === null || data.exitCode === undefined
          ? "no exit code"
          : `exit ${String(data.exitCode)}`;
        lines.push(`    command: ${String(data.commandId ?? observation.providerId)} — ${argv} (${exit})`);
      }
    }
    for (const checkpoint of round.checkpoints) {
      lines.push(`  checkpoint: ${checkpoint.checkpoint_id} (${checkpoint.role}, R${checkpoint.round})`);
    }
    if (round.restore_verified) {
      lines.push(`  restore: verified (redo R${round.restore?.redo_round ?? "?"})`);
    }
    if (round.evidenceIncomplete) {
      lines.push("  Evidence boundary: INCOMPLETE — no after-phase observations");
    }
    for (const flag of round.flags) {
      lines.push(`  flag: ${flag.severity} ${flag.check} — ${flag.detail.slice(0, 160)}`);
    }
    // v4.0.4: the two contract sources are labelled and shown side by side.
    // The commit-time snapshot is the posture's persisted contract block
    // (already rendered above by the shared posture formatter); the derived
    // status is this read-time projection. No comparison boolean is emitted.
    const snapshotContract = round.evidencePosture?.contract ?? null;
    if (snapshotContract) {
      lines.push(
        `  Contract at commit (snapshot): ${snapshotContract.id} → ` +
        `${snapshotContract.closure}`,
      );
    }
    if (round.contract) {
      lines.push(
        `  Contract status now (derived): ${round.contract.id} → ` +
        `${round.contract.closure}`,
      );
      for (const item of round.contract.items) {
        lines.push(`    ${item.itemId}: ${item.status}${item.reasons.length > 0 ? ` — ${item.reasons[0]}` : ""}`);
      }
    }
    if (round.contractRedirect) {
      lines.push(
        `  contract redirect: ${round.contractRedirect.kind} ` +
        `${round.contractRedirect.contract_id}` +
        (round.contractRedirect.reason
          ? ` — ${round.contractRedirect.reason.slice(0, 160)} (report only)`
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
      lines.push(`  abandoned approach (Agent report): ${approach.slice(0, 160)}`);
    }
    for (const assumption of rollback.wrongAssumptions) {
      lines.push(`  wrong assumption (Agent report): ${assumption.slice(0, 160)}`);
    }
    for (const flag of rollback.triggerFindings) {
      lines.push(`  trigger finding: ${flag.severity} ${flag.check} — ${flag.detail.slice(0, 160)}`);
    }
  }
  return lines.join("\n");
}
