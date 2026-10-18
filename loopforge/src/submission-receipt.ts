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
  ContractItemStatus,
  PromptArtifact,
  RoundVerificationStatus,
  SelfEvaluation,
  SubmissionDiagnostic,
  SubmissionReceipt,
  SubmissionReportHandling,
  SubGoal,
} from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type { RoundProcessResult } from "./round-coordinator.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";
import type { CommittedRoundView } from "./committed-round.js";
import { deriveActiveRoundContract, deriveRoundContractView } from "./round-contract.js";
import { deriveSubGoals } from "./subgoal-state.js";
import { deriveEvidenceStatus } from "./verification-gate.js";
import { fieldGuide } from "./submission-guidance.js";
import { deriveFieldAccounting } from "./field-accounting.js";
import { deriveFilesReconciliation } from "./files-reconciliation.js";
import { getPolicy } from "./policy.js";

export interface ReceiptFacts {
  contractBefore: string | null;
  contractAfter: string | null;
  subGoalsBefore: ReadonlyArray<SubGoal>;
  subGoalsAfter: ReadonlyArray<SubGoal> | null;
  /** The next compile's active constraint set, or null when not observed. */
  constraintsActiveAfter: string[] | null;
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
  contractItems: Array<{ item_id: string; status: ContractItemStatus }>;
  /** The round delta (already derived) used by the evidence posture. */
  evidenceDeltas: ObservationDelta[];
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
  if (path === "prompt_requests") {
    const nextLevel = input.nextArtifact?.level;
    if (!input.nextArtifact || nextLevel === "l0") {
      return {
        handling: "saved_not_expanded",
        detail: "no next prompt consumed it (or the next prompt is L0)",
      };
    }
  }
  if (path === "round_contract" && hasCheck(input.pr, "contract_premature")) {
    return {
      handling: "saved_not_expanded",
      detail: "the active contract is still open; the different proposal was ignored",
    };
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
  const retracted = diffApplied ? [...(selfEval.retracted_constraints ?? [])] : [];
  const activeAfter = input.facts.constraintsActiveAfter;
  const activationObserved = diffApplied && activeAfter !== null;
  const notExpanded = activationObserved
    ? declared.filter((item) => !activeAfter!.includes(item))
    : [];
  const checkpoint = diffApplied && selfEval.compression_checkpoint === true
    ? {
        label: (selfEval.checkpoint_label ?? "").trim() || `Round ${input.snapshot.round}`,
        round: input.snapshot.round,
      }
    : null;
  const rollback = pr.action === "backtrack"
    ? {
        restore_point: pr.backtrackTarget ?? Math.max(1, input.snapshot.round - 1),
        preserved_discoveries: [...(pr.backtrackSkippedDiscoveries ?? [])],
        wrong_assumptions: [...(pr.backtrackWrongAssumptions ?? [])],
      }
    : null;
  const contractBefore = input.facts.contractBefore;
  const contractAfter = input.facts.contractAfter;

  // ── verification ───────────────────────────────────────────────────────
  const evidence = deriveEvidenceStatus(selfEval, input.evidenceDeltas);
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
    reports: [...reports.values()],
    effects: {
      contract: {
        before_id: contractBefore,
        after_id: contractAfter,
        activated: diffApplied && contractAfter !== null && contractBefore !== contractAfter,
        closed: diffApplied && contractBefore !== null && contractBefore !== contractAfter,
      },
      subgoals_created: subGoals.created,
      subgoals_updated: subGoals.updated,
      constraints_declared: declared,
      constraints_retracted: retracted,
      constraints_activation: activationObserved ? "observed" : "not_observed",
      constraints_active_after: activationObserved ? activeAfter : null,
      constraints_not_expanded: notExpanded,
      checkpoint,
      rollback,
    },
    verification: {
      contract_status: pr.verificationStatus as RoundVerificationStatus,
      evidence_status: evidence.providerStatus,
      checks: pr.verificationFlags.map((flag) => ({
        field: flag.field,
        check: flag.check,
        severity: flag.severity,
        detail: flag.detail,
      })),
      contract_items: input.contractItems,
    },
    files_reconciliation: filesReconciliation,
    prompt: input.nextArtifact
      ? {
          level: input.nextArtifact.level,
          dropped_sections: [...input.nextArtifact.droppedSections],
          prompt_request_effects: [...(input.nextArtifact.promptRequestEffects ?? [])],
        }
      : null,
    diagnostics: input.diagnostics,
  };
}

/** Rebuild the same receipt from committed history. No new persistence and
 *  no second history: `allViews` is the caller's `readOnlyRounds` window. */
export function deriveCommittedSubmissionView(
  view: CommittedRoundView,
  allViews: ReadonlyArray<CommittedRoundView>,
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
  const contractView = deriveRoundContractView({
    rounds: allViews,
    round: view.round,
    report: view.executionReport,
    deltas: view.observationDelta,
    outcome: view.outcome,
    commands,
  });
  const selfEval = view.evaluation ?? {
    success: view.success,
    output_summary: "",
    constraint_violations: [],
    should_continue: view.action === "continue",
  };
  const pr: RoundProcessResult = view.result ?? {
    action: view.action,
    verificationFlags: view.verificationFlags,
    roundSuccess: view.success,
    gateContradicted: false,
    verificationStatus: "trusted",
    newConsecutiveRejections: 0,
    shouldPushSuccessTrajectory: false,
    ...(view.backtrack
      ? {
          backtrackTarget: view.backtrack.target,
          backtrackSkippedDiscoveries: [],
        }
      : {}),
  } as RoundProcessResult;
  const disposition: SubmissionReceipt["disposition"] =
    view.action === "backtrack"
      ? "backtracked"
      : view.action === "stop"
        ? "stopped"
        : "accepted";
  const submittedFields = view.submittedFields;
  const snapshot: RoundTransactionSnapshot = {
    schemaVersion: 3,
    roundId: view.roundId,
    loopId: view.loopId,
    round: view.round,
    attempt: view.attempt,
    phase: "committed",
    beforeEvidence: view.beforeEvidence,
    afterEvidence: view.afterEvidence,
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
    },
    nextArtifact: next?.promptArtifact ?? null,
    contractItems: contractView.statuses.items.map((item) => ({
      item_id: item.itemId,
      status: item.status,
    })),
    evidenceDeltas: view.observationDelta,
  });
}
