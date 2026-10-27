/** v3.9.1 — the submission receipt.
 *
 * A receipt is a READ-ONLY projection: it compares existing derivations and
 * reports what the transaction actually did. It is never persisted as its own
 * ledger; a committed round's receipt is rebuilt from its transaction snapshot
 * plus the shared `CommittedRoundView` window.
 *
 * The three facts are deliberately separate:
 *   - reports:   what was saved (or dropped/truncated/not applied);
 *   - effects:   which derived state actually changed;
 *   - verification: what the machine observed/verified.
 * A saved report is never a verified fact.
 */

import type {
  PromptArtifact,
  RecoveryDirective,
  SelfEvaluation,
  SubmissionDiagnostic,
  SubmissionReceipt,
  SubmissionReportHandling,
  SubGoal,
} from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { RoundProcessResult } from "./round-coordinator.js";
import {
  ROUND_TRANSACTION_SCHEMA_VERSION,
  rootBranchId,
} from "./round-transaction.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
import type { CommittedRoundView } from "./committed-round.js";
import { deriveActiveRoundContract } from "./round-contract.js";
import { deriveSubGoals } from "./subgoal-state.js";
import { rollbackEvidencePosture } from "./evidence-posture.js";
import { fieldGuide } from "./submission-guidance.js";
import { effectiveOutcome } from "./self-eval.js";
import { deriveFieldAccounting } from "./field-accounting.js";
import { deriveFilesReconciliation } from "./files-reconciliation.js";
import { getPolicy } from "./policy.js";
import {
  deriveConstraintId,
  deriveFindingId,
  normalizeText,
} from "./token-utils.js";

export interface ReceiptFacts {
  contractBefore: string | null;
  contractAfter: string | null;
  subGoalsBefore: ReadonlyArray<SubGoal>;
  subGoalsAfter: ReadonlyArray<SubGoal> | null;
  /** The next compile's active constraint set, or null when not observed. */
  constraintsActiveAfter: string[] | null;
  /** The next compile's effective retired set, or null when not observed. */
  constraintsRetiredAfter: string[] | null;
}

export interface ReceiptInput {
  snapshot: RoundTransactionSnapshot;
  selfEval: SelfEvaluation;
  pr: RoundProcessResult;
  disposition: SubmissionReceipt["disposition"];
  diagnostics: SubmissionDiagnostic[];
  submittedFields: string[];
  facts: ReceiptFacts;
  nextArtifact?: PromptArtifact | null;
  /** The round delta (already derived) used by the files reconciliation. */
  evidenceDeltas: ObservationDelta[];
  /** The pending rollback directive governing this submission, captured
   *  before a redo commit (it stops being "pending" once the child round
   *  commits). Null/absent for ordinary submissions. */
  recoveryDirective?: RecoveryDirective | null;
  /** v4.0.3: the restore outcome from the run that produced this receipt.
   *  It is the SAME verified-restore fact the top-level `recovery.restore`
   *  reports; a committed redo falls back to its snapshot marker. */
  recoveryRestoreVerified?: boolean;
}

const HANDLING_PRIORITY: Record<SubmissionReportHandling, number> = {
  "not_applied": 6,
  "dropped": 5,
  "truncated": 4,
  "normalized": 3,
  "saved_not_expanded": 2,
  "saved": 1,
};

function stronger(
  left: SubmissionReportHandling,
  right: SubmissionReportHandling,
): SubmissionReportHandling {
  return HANDLING_PRIORITY[right] > HANDLING_PRIORITY[left] ? right : left;
}

function combineDetail(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return `${left}; ${right}`;
}

function hasCheck(pr: RoundProcessResult, check: string): boolean {
  return pr.verificationFlags.some((flag) => flag.check === check);
}

function baseReportHandling(
  path: string,
  input: ReceiptInput,
): { handling: SubmissionReportHandling; detail?: string } {
  if (input.disposition === "rejected" || input.disposition === "terminated") {
    return { handling: "not_applied" };
  }
  if (input.disposition === "backtracked") {
    return path === "wrong_assumptions"
      ? { handling: "saved", detail: "kept in the recovery brief" }
      : { handling: "not_applied" };
  }
  const guide = fieldGuide(path);
  if (guide?.reportOnly) {
    return {
      handling: "saved_not_expanded",
      detail: "saved as a report; it does not change derived state automatically",
    };
  }
  if (path === "gate_ids" && getPolicy().gate.enabled !== true) {
    return {
      handling: "saved_not_expanded",
      detail: "the gate layer is disabled; the citation has no runtime effect",
    };
  }
  if (path === "round_contract") {
    const transition = input.selfEval.contract_transition;
    if (transition && transition.contract_id === input.facts.contractBefore) {
      // v3.9.9: in a transition round the successor is the EFFECTIVE next
      // slice, not an ignored premature proposal.
      return {
        handling: "saved",
        detail: "the successor contract activates next round (the old one closes as superseded)",
      };
    }
    if (hasCheck(input.pr, "contract_premature")) {
      return {
        handling: "saved_not_expanded",
        detail: "the active contract is still open; the different proposal was ignored",
      };
    }
  }
  if (path === "no_change_reason") {
    const commands = getPolicy().evidence.commands ?? [];
    if (commands.some((command) => command.enabled)) {
      return {
        handling: "saved_not_expanded",
        detail: "a verification command is configured; the escape is not honored",
      };
    }
  }
  return { handling: "saved" };
}

function subGoalDiff(
  before: ReadonlyArray<SubGoal>,
  after: ReadonlyArray<SubGoal> | null,
): {
  created: Array<{ id: string; description: string }>;
  updated: Array<{ id: string; from: string; to: string }>;
} {
  if (!after) return { created: [], updated: [] };
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const created: Array<{ id: string; description: string }> = [];
  const updated: Array<{ id: string; from: string; to: string }> = [];
  for (const item of after) {
    const previous = beforeById.get(item.id);
    if (!previous) {
      created.push({ id: item.id, description: item.description });
      continue;
    }
    if (previous.status !== item.status) {
      updated.push({ id: item.id, from: previous.status, to: item.status });
    }
  }
  return { created, updated };
}

/** Build a receipt from explicitly supplied before/after facts. */
export function deriveSubmissionReceipt(input: ReceiptInput): SubmissionReceipt {
  const { selfEval, pr, disposition } = input;
  const enteredHistory = disposition === "accepted" || disposition === "stopped";
  const record: SubmissionReceipt["record"] =
    disposition === "accepted" || disposition === "stopped"
      ? "committed"
      : disposition === "backtracked"
        ? "rollback_directive"
        : "none";
  // The redo's checkpoint is the machine restore result. A warn (e.g. the
  // claimed files overlap the skipped set) is guidance, not a failed restore.
  // Present whenever a pre-existing directive governed this submission. A
  // rollback directive's own receipt passes no directive (`recover()`); a redo
  // that itself triggers another rollback still carries the checkpoint it was
  // judged against.
  const recoveryCheckpoint = input.recoveryDirective
    ? {
        checkpoint_id: input.recoveryDirective.target.checkpoint_id,
        redo_round: input.recoveryDirective.target.redo_round,
        origin: input.recoveryDirective.origin,
        reason: input.recoveryDirective.reason,
        restore_verified: input.recoveryRestoreVerified ??
          (input.snapshot.restore?.directiveTransactionId ===
            input.recoveryDirective.transaction_id),
      }
    : null;

  // ── reports ────────────────────────────────────────────────────────────
  const accounting = deriveFieldAccounting({
    submittedFields: input.submittedFields,
    normalizationDiagnostics: input.diagnostics,
    evaluation: selfEval,
  });
  const retained = new Set(accounting.retained);
  const reports = new Map<string, {
    path: string;
    handling: SubmissionReportHandling;
    detail?: string;
  }>();
  for (const path of input.submittedFields) {
    const base = baseReportHandling(path, input);
    const detail = !retained.has(path) && accounting.incomplete &&
        base.handling !== "not_applied"
      ? combineDetail(base.detail, "retention unknown (diagnostics were truncated)")
      : base.detail;
    reports.set(path, {
      path,
      handling: base.handling,
      ...(detail ? { detail } : {}),
    });
  }
  for (const diagnostic of input.diagnostics) {
    if (diagnostic.handling === "rejected") continue;
    const existing = reports.get(diagnostic.path);
    if (existing) {
      // A partial array loss must not downgrade a retained field: the field
      // survived with some entries. Keep its handling and surface the loss as
      // a detail instead.
      if (retained.has(diagnostic.path) && diagnostic.handling === "dropped") {
        existing.detail = combineDetail(existing.detail, diagnostic.detail);
        continue;
      }
      if (existing.handling === "not_applied") {
        existing.detail = diagnostic.detail;
      } else {
        existing.handling = stronger(existing.handling, diagnostic.handling);
        existing.detail = diagnostic.detail;
      }
    } else {
      reports.set(diagnostic.path, {
        path: diagnostic.path,
        handling: diagnostic.handling,
        detail: diagnostic.detail,
      });
    }
  }

  // ── effects ────────────────────────────────────────────────────────────
  const diffApplied = disposition === "accepted" || disposition === "stopped";
  const subGoals = diffApplied
    ? subGoalDiff(input.facts.subGoalsBefore, input.facts.subGoalsAfter)
    : { created: [], updated: [] };
  const declared = diffApplied ? [...(selfEval.discovered_constraints ?? [])] : [];
  const rawRetracted = diffApplied
    ? [...(selfEval.retracted_constraints ?? [])]
    : [];
  const activeAfter = input.facts.constraintsActiveAfter;
  const retiredAfter = input.facts.constraintsRetiredAfter;
  const activationObserved = diffApplied && activeAfter !== null;
  const retractionObserved = diffApplied && retiredAfter !== null;
  // Effective retractions come from the next compile — the same resolver the
  // compiler used. Unknown/no-op targets are listed separately, never as
  // "retracted".
  const retracted = retractionObserved ? [...retiredAfter!] : [];
  const retractedKeys = new Set(retracted.map((text) => normalizeText(text)));
  const retractedIds = new Set(retracted.map((text) => deriveConstraintId(text)));
  const notRetracted = retractionObserved
    ? rawRetracted.filter((item) =>
        !retractedKeys.has(normalizeText(item)) &&
        !retractedIds.has(item))
    : [];
  const notExpanded = activationObserved
    ? declared.filter((item) =>
        !activeAfter!.some((active) => normalizeText(active) === normalizeText(item)))
    : [];
  const subtaskBoundary = diffApplied && selfEval.subtask_boundary === true
    ? {
        label: (selfEval.subtask_boundary_label ?? "").trim() ||
          `Round ${input.snapshot.round}`,
        round: input.snapshot.round,
      }
    : null;
  const rollback = (pr.action === "backtrack" || pr.action === "recovery")
    ? {
        redo_round: pr.recovery?.target.redo_round ??
          Math.max(1, input.snapshot.round),
        target_checkpoint_id: pr.recovery?.target.checkpoint_id ?? "",
        preserved_discoveries: [...(pr.recovery?.skipped_discoveries ?? [])],
        wrong_assumptions: [...(pr.recovery?.wrong_assumptions ?? [])],
        observed_skipped_files: [...(pr.recovery?.observed_skipped_files ??
          pr.recovery?.skipped_files ?? [])],
        reported_skipped_files: [...(pr.recovery?.reported_skipped_files ?? [])],
        abandoned_rounds: [...(pr.recovery?.abandoned_rounds ?? [])],
        trigger_finding_ids: (pr.recovery?.trigger_findings ?? [])
          .map((flag) => deriveFindingId(flag)),
        ...(pr.recovery?.origin ? { origin: pr.recovery.origin } : {}),
        ...(pr.recovery?.reason ? { reason: pr.recovery.reason } : {}),
      }
    : null;
  const contractBefore = input.facts.contractBefore;
  const contractAfter = input.facts.contractAfter;
  // v3.9.9: the receipt's `superseded` fact comes from the COMMITTED
  // transition and its target, never from inferring a successor out of a
  // `contract_premature` flag.
  const transition = selfEval.contract_transition ?? null;
  const transitionApplied = diffApplied && transition !== null &&
    contractBefore !== null && transition.contract_id === contractBefore;

  // ── verification ───────────────────────────────────────────────────────
  // v4.0.3: the receipt reads the ONE posture the transaction persisted. It
  // never re-derives verification status or a second evidence verdict.
  const posture = pr.evidencePosture;
  const filesReconciliation = deriveFilesReconciliation(
    selfEval.execution_report ?? null,
    input.evidenceDeltas,
    {
      attempted: input.submittedFields.includes(
        "execution_report.files_changed"),
    },
  );

  return {
    round_id: input.snapshot.roundId,
    attempt: input.snapshot.attempt,
    disposition,
    record,
    entered_history: enteredHistory,
    agent_success_claim: selfEval.success === true,
    agent_outcome: effectiveOutcome(selfEval),
    ...(recoveryCheckpoint ? { recovery_checkpoint: recoveryCheckpoint } : {}),
    reports: [...reports.values()],
    effects: {
      contract: {
        before_id: contractBefore,
        after_id: contractAfter,
        activated: diffApplied && contractAfter !== null && contractBefore !== contractAfter,
        closed: diffApplied && contractBefore !== null && contractBefore !== contractAfter,
        ...(transitionApplied
          ? {
              superseded: true,
              ...(transition?.reason
                ? { transition_reason: transition.reason }
                : {}),
            }
          : {}),
      },
      subgoals_created: subGoals.created,
      subgoals_updated: subGoals.updated,
      constraints_declared: declared,
      constraints_retracted: retracted,
      constraints_retraction: retractionObserved ? "observed" : "not_observed",
      constraints_not_retracted: notRetracted,
      constraints_activation: activationObserved ? "observed" : "not_observed",
      constraints_active_after: activationObserved ? activeAfter : null,
      constraints_not_expanded: notExpanded,
      subtask_boundary: subtaskBoundary,
      rollback,
    },
    verification: {
      evidence_posture: posture,
      checks: pr.verificationFlags.map((flag) => ({
        field: flag.field,
        check: flag.check,
        severity: flag.severity,
        detail: flag.detail,
        ...(flag.ref ? { ref: flag.ref } : {}),
      })),
      contract_items: (posture.contract?.items ?? []).map((item) => ({
        item_id: item.id,
        status: item.status,
      })),
    },
    files_reconciliation: filesReconciliation,
    prompt: input.nextArtifact
      ? {
          level: input.nextArtifact.level,
          dropped_sections: [...input.nextArtifact.droppedSections],
          // v4.0.2: the SAME artifact fact the next prompt was compiled with.
          context_mode: input.nextArtifact.contextMode,
          context_reason: input.nextArtifact.contextReason,
        }
      : null,
    diagnostics: input.diagnostics,
  };
}

/** Rebuild the same receipt from committed history. No new persistence and
 *  no second history: `allViews` is the loader's current-branch evaluation
 *  window. `rollbacks` is the loader's directive chain; it supplies the
 *  directive that governed a redo after that redo has committed. */
export function deriveCommittedSubmissionView(
  view: CommittedRoundView,
  allViews: ReadonlyArray<CommittedRoundView>,
  rollbacks: ReadonlyArray<CommittedRoundView> = [],
): SubmissionReceipt {
  const commands = getPolicy().evidence.commands ?? [];
  const beforeRounds = allViews.filter((item) => item.round < view.round);
  const afterRounds = allViews.filter((item) => item.round <= view.round);
  const next = allViews.find((item) => item.round === view.round + 1) ?? null;
  const contractBefore = deriveActiveRoundContract(beforeRounds, commands)?.id ?? null;
  const contractAfter = deriveActiveRoundContract(afterRounds, commands)?.id ?? null;
  const subGoalsBefore = deriveSubGoals({
    loopId: view.loopId,
    currentRound: view.round,
    rounds: beforeRounds,
  });
  const subGoalsAfter = deriveSubGoals({
    loopId: view.loopId,
    currentRound: view.round + 1,
    rounds: afterRounds,
  });
  const selfEval = view.evaluation ?? {
    success: view.agentSuccessClaim,
    output_summary: "",
    constraint_violations: [],
    should_continue: view.action === "continue",
  };
  const fallbackPosture = view.evidencePosture ?? {
    // A hand-built view that predates the posture carries no machine claim;
    // a not_applicable posture is the honest projection, never a guess.
    ...rollbackEvidencePosture(view.round),
    kind: "evaluation" as const,
  };
  const pr: RoundProcessResult = view.result ?? {
    action: view.action,
    origin: view.kind === "rollback" ? (view.origin ?? "machine") : "evaluation",
    ...(view.recovery ? { reason: view.recovery.reason, recovery: view.recovery } : {}),
    verificationFlags: view.verificationFlags,
    agentSuccessClaim: view.agentSuccessClaim,
    agentOutcome: view.agentOutcome,
    gateContradicted: false,
    evidencePosture: fallbackPosture,
    newConsecutiveRejections: 0,
    shouldPushSuccessTrajectory: false,
  } as RoundProcessResult;
  const disposition: SubmissionReceipt["disposition"] =
    view.kind === "rollback"
      ? "backtracked"
      : view.action === "stop"
        ? "stopped"
        : "accepted";
  const submittedFields = view.submittedFields;
  // A rollback directive's own receipt has no checkpoint to report; an
  // evaluation round on the directive's child branch at `redo_round` is the
  // redo that was restored for.
  const recoveryDirective = view.kind === "rollback"
    ? null
    : [...rollbacks].reverse().find((item) =>
        item.recovery !== null && item.recovery !== undefined &&
        item.recovery.target.redo_round === view.round &&
        (!view.branchId || item.recovery.transaction_id === view.branchId),
      )?.recovery ?? null;
  const snapshot: RoundTransactionSnapshot = {
    schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
    branchId: view.branchId ?? rootBranchId(view.loopId),
    transactionId: view.transactionId ?? view.roundId,
    kind: view.kind ?? "evaluation",
    roundId: view.roundId,
    loopId: view.loopId,
    round: view.round,
    attempt: view.attempt,
    phase: "committed",
    beforeEvidence: view.beforeEvidence,
    afterEvidence: view.afterEvidence,
    ...(view.beforeCheckpoint ? { beforeCheckpoint: view.beforeCheckpoint } : {}),
    ...(view.checkpoints.length > 0 ? { checkpoints: view.checkpoints } : {}),
    ...(view.restore ? { restore: view.restore } : {}),
    ...(view.operatorAcceptance ? { operatorAcceptance: view.operatorAcceptance } : {}),
    ...(view.compiled ? { compiled: view.compiled } : {}),
    evaluation: view.evaluation ?? undefined,
    result: view.result ?? undefined,
    ...(view.normalizationDiagnostics.length > 0
      ? { normalizationDiagnostics: view.normalizationDiagnostics }
      : {}),
    ...(view.submittedFields.length > 0 ? { submittedFields: view.submittedFields } : {}),
    createdAt: 0,
    updatedAt: 0,
  };
  return deriveSubmissionReceipt({
    snapshot,
    selfEval,
    pr,
    disposition,
    diagnostics: view.normalizationDiagnostics,
    submittedFields,
    facts: {
      contractBefore,
      contractAfter,
      subGoalsBefore,
      subGoalsAfter,
      // A stopped/backtracked round has no next compile to attribute an
      // active set to. A continue round uses the next round's stamped set.
      constraintsActiveAfter: disposition === "accepted"
        ? next?.activeConstraints ?? null
        : null,
      constraintsRetiredAfter: disposition === "accepted"
        ? next?.compiledRetirements ?? null
        : null,
    },
    nextArtifact: next?.promptArtifact ?? null,
    evidenceDeltas: view.observationDelta,
    recoveryDirective,
  });
}
