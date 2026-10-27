/** v2.12/v4.0.3: Read-only, replayable end-of-loop audit — the verification
 *  view.
 *
 *  Positioning vs loopforge_replay: replay is the factual timeline (what
 *  happened per round); audit is the assessment layer (which claims are
 *  machine-verified, which gates were decided, is the sequence intact).
 *  Everything is derived from committed vault entries — audit never writes.
 *
 *  v4.0.3: every round reports the SAME persisted evidence posture. A claim is
 *  `verified` only when a machine criterion fact backs its criterion; Agent
 *  reports never upgrade themselves. `evidenceVerdict` is the terminal
 *  posture, while `verdict` is the verification view over structure + posture.
 */

import type { LoopStore } from "./loop-store.js";
import { eventSequence, StorageCorruptionError } from "./loop-store.js";
import { auditOrder, deriveGate } from "./cognitive-governance.js";
import type { VaultEntry } from "./loop-store.js";
import {
  deriveCriterionId,
  entryRound,
  isCriterionId,
  isRecord,
} from "./token-utils.js";
import {
  legacyTransactionRounds,
  readOnlyRollbacks,
  readOnlyRounds,
} from "./committed-round.js";
import {
  committedRoundFacts,
  deriveRoundContractView,
} from "./round-contract.js";
import { deriveCriterionFacts } from "./round-facts.js";
import { deriveCommittedSubmissionView } from "./submission-receipt.js";
import type {
  ContractItemStatus,
  EvidencePosture,
  EvidencePostureStatus,
  FilesReconciliation,
  SubmissionDiagnostic,
} from "./protocol.js";
import type { SubmissionReceipt } from "./protocol.js";
import { getPolicy } from "./policy.js";

export interface AuditRound {
  round: number;
  /** v4.0.3: Agent claim; never a machine verdict. */
  agentSuccessClaim: boolean;
  agentOutcome: string;
  machineBackedSuccess: boolean;
  evidencePosture: EvidencePosture | null;
  claims: Array<{ text: string; status: "verified" | "unverified" }>;
  checks: Array<{ check: string; severity: string; verdict: "failed" | "warn" | "info" }>;
  /** v3.8: the contract this round EXECUTED under and each item's status as of
   *  this round — the same derivation `explain` renders. */
  contract: {
    id: string;
    declared_at_round: number;
    closure: string;
    items: Array<{ itemId: string; status: ContractItemStatus }>;
  } | null;
  /** v4.0.3: committed recovery material that history can still discover. */
  checkpoints: Array<{
    checkpoint_id: string;
    role: "before" | "mid";
    round: number;
    content_hash: string;
  }>;
  restore: {
    directive_transaction_id: string;
    redo_round: number;
    verified_at: number;
  } | null;
  restore_verified: boolean;
  /** v3.9.1/v4.0.3: compact submission accounting. */
  submission: {
    record: SubmissionReceipt["record"];
    entered_history: boolean;
    diagnostics: SubmissionDiagnostic[];
    saved_not_expanded: string[];
    effects: SubmissionReceipt["effects"];
    verification: {
      evidence_posture: EvidencePosture;
      checks: SubmissionReceipt["verification"]["checks"];
    };
    files_reconciliation: FilesReconciliation;
    recovery_checkpoint: SubmissionReceipt["recovery_checkpoint"] | null;
    prompt: { level: string; dropped_sections: string[] } | null;
  };
}

export interface AuditGate {
  gateId: string;
  kind: "user" | "agent";
  actionHash: string;
  approved: boolean;
  decidedAt: string;
  round: number;
}

/** v3.8: One contract's outcome over the loop, keyed by its content-addressed
 *  id. Re-declaring the same contract later extends the same entry — the
 *  identity says it IS the same contract. */
export interface AuditContract {
  contract_id: string;
  declared_at_round: number;
  first_active_round: number;
  last_active_round: number;
  closure: "open" | "verified" | "blocked" | "superseded";
  closed_at_round: number | null;
  /** Item statuses as of the last round the contract was execution-relevant. */
  items: Array<{ itemId: string; description: string; status: ContractItemStatus }>;
}

export interface AuditContractSummary {
  contracts: AuditContract[];
  /** Contracts whose final closure is still `open`. */
  open: number;
  /** v3.9.9: contracts the Agent explicitly abandoned via a transition. */
  superseded: number;
  verifiedItems: number;
  insufficientItems: number;
  contradictedItems: number;
  pendingItems: number;
}

export interface AuditResult {
  loopId: string;
  /** Verification-view verdict: `passed` requires the structure to be intact
   *  AND the terminal evidence posture to be verified/not_applicable. */
  verdict: "passed" | "incomplete" | "contradicted";
  /** v4.0.3: the terminal posture itself, unmodified. */
  evidenceVerdict: EvidencePostureStatus | null;
  rounds: AuditRound[];
  /** v3.9.6: committed rollback directives — events, never normal rounds. */
  rollbacks: Array<{
    round: number;
    transactionId: string;
    origin: "agent" | "machine";
    redoRound: number;
    targetCheckpointId: string;
    reason: string;
    observedSkippedFiles: string[];
    reportedSkippedFiles: string[];
    skippedFiles: string[];
    abandonedRounds: number[];
    failedRounds: number[];
    /** v4.0.3: Agent reports preserved by the rollback. */
    preservedDiscoveries: string[];
    approaches: string[];
    wrongAssumptions: string[];
  }>;
  gates: AuditGate[];
  unresolvedUserGates: string[];
  /** v3.8: the verification skeleton — the primary completion basis. */
  contracts: AuditContractSummary;
  /** Advisory second axis: criterion claims, not the completion signal.
   *  `declared` comes from the immutable operator objective; `evidenced` is the
   *  machine-verified set. Both are distinct-id counts. */
  criteria: { declared: number; evidenced: number; missing: number };
  sequenceComplete: boolean;
  /** False when no LoopStore was provided (sequence/provenance degraded). */
  provenanceAvailable: boolean;
  /** v3.8: rounds whose persisted transaction carries a legacy schema
   *  version. They are NOT part of history (the version break is hard) — this
   *  list makes the loss visible instead of letting the loop look complete. */
  legacyRounds: number[];
}

/** Build the audit from committed vault entries. Pure, read-only.
 *  @param store Optional LoopStore — when provided, sequence integrity is
 *  checked and provenanceAvailable becomes true. */
export function buildAudit(
  loopId: string,
  entries: VaultEntry[],
  store?: LoopStore,
): AuditResult {
  // v4.0.3: a multi-loop entry list must not leak another loop's gates,
  // legacy rounds or rollbacks into this audit.
  const loopEntries = entries.filter((entry) =>
    entry.loop_id === loopId ||
    String(entry.task_id ?? "").startsWith(`loop:${loopId}:`));
  const ordered = auditOrder(loopEntries);
  const views = readOnlyRounds(entries).filter((view) => view.loopId === loopId);
  const rollbacks = readOnlyRollbacks(entries).filter((view) => view.loopId === loopId);
  const commands = getPolicy().evidence.commands ?? [];
  // The executed contract per round, through the ONE derivation explain and
  // the live coordinator also call.
  const contractByRound = new Map<number, ReturnType<typeof deriveRoundContractView>>();
  for (const view of views) {
    contractByRound.set(view.round, deriveRoundContractView({
      rounds: views,
      round: view.round,
      current: committedRoundFacts(view),
      commands,
    }));
  }

  // v4.0.3: machine criterion facts are the ONLY upgrade path for a claim.
  const factsUpTo = (round: number) => deriveCriterionFacts({
    rounds: views.filter((view) => view.round <= round),
    commands,
  });
  const machineVerifiedIdsUpTo = (round: number): Set<string> =>
    new Set(factsUpTo(round)
      .filter((fact) => fact.status === "verified")
      .map((fact) => fact.criterion_id));

  const rounds: AuditRound[] = [];
  for (const view of views) {
    const round = view.round;
    const verifiedIds = machineVerifiedIdsUpTo(round);
    const receipt = deriveCommittedSubmissionView(view, views, rollbacks);
    const executed = contractByRound.get(round);
    rounds.push({
      round,
      agentSuccessClaim: view.agentSuccessClaim,
      agentOutcome: view.agentOutcome ?? "unknown",
      machineBackedSuccess: view.evidencePosture?.machineBackedSuccess ?? false,
      evidencePosture: view.evidencePosture,
      claims: (view.executionReport?.criterion_claims ?? [])
        .filter((claim) => claim.outcome === "met")
        .map((claim) => {
          const id = isCriterionId(claim.criterion_id)
            ? claim.criterion_id
            : deriveCriterionId(claim.criterion_id);
          return {
            text: claim.criterion_id,
            status: verifiedIds.has(id)
              ? "verified" as const
              : "unverified" as const,
          };
        }),
      checks: view.verificationFlags.map((flag) => ({
        check: flag.check,
        severity: flag.severity,
        verdict: flag.severity === "error" ? "failed" as const : flag.severity as "warn" | "info",
      })),
      contract: executed?.contract && executed.statuses.contractId
        ? {
            id: executed.statuses.contractId,
            declared_at_round: executed.contract.declared_at_round,
            closure: executed.statuses.closure,
            items: executed.statuses.items.map((item) => ({
              itemId: item.itemId,
              status: item.status,
            })),
          }
        : null,
      checkpoints: [
        ...(view.beforeCheckpoint ? [view.beforeCheckpoint] : []),
        ...view.checkpoints,
      ].map((ref) => ({
        checkpoint_id: ref.checkpointId,
        role: ref.role,
        round: ref.round,
        content_hash: ref.contentHash,
      })),
      restore: view.restore
        ? {
            directive_transaction_id: view.restore.directiveTransactionId,
            redo_round: view.restore.redoRound,
            verified_at: view.restore.verifiedAt,
          }
        : null,
      restore_verified: view.restore !== null,
      submission: {
        record: receipt.record,
        entered_history: receipt.entered_history,
        diagnostics: receipt.diagnostics,
        saved_not_expanded: receipt.reports
          .filter((report) => report.handling === "saved_not_expanded")
          .map((report) => report.path),
        effects: receipt.effects,
        verification: {
          evidence_posture: receipt.verification.evidence_posture,
          checks: receipt.verification.checks,
        },
        files_reconciliation: receipt.files_reconciliation,
        recovery_checkpoint: receipt.recovery_checkpoint ?? null,
        prompt: receipt.prompt
          ? {
              level: receipt.prompt.level,
              dropped_sections: receipt.prompt.dropped_sections,
            }
          : null,
      },
    });
  }

  // ── Contract item axis — the verification skeleton ─────────────────────
  const contractsById = new Map<string, AuditContract>();
  for (const view of views) {
    const executed = contractByRound.get(view.round);
    if (!executed?.contract || !executed.statuses.contractId) continue;
    const id = executed.statuses.contractId;
    const existing = contractsById.get(id);
    contractsById.set(id, {
      contract_id: id,
      declared_at_round: existing?.declared_at_round ?? executed.contract.declared_at_round,
      first_active_round: existing?.first_active_round ?? view.round,
      last_active_round: view.round,
      closure: executed.statuses.closure,
      closed_at_round: executed.statuses.closed_at_round,
      items: executed.statuses.items.map((item) => ({
        itemId: item.itemId,
        description: item.description,
        status: item.status,
      })),
    });
  }
  const contracts = [...contractsById.values()]
    .sort((a, b) =>
      a.first_active_round - b.first_active_round ||
      a.contract_id.localeCompare(b.contract_id));
  const flatItems = contracts.flatMap((contract) => contract.items);
  const contractsSummary: AuditContractSummary = {
    contracts,
    open: contracts.filter((contract) => contract.closure === "open").length,
    superseded: contracts.filter((contract) => contract.closure === "superseded").length,
    verifiedItems: flatItems.filter((item) => item.status === "verified").length,
    insufficientItems: flatItems.filter((item) => item.status === "insufficient").length,
    contradictedItems: flatItems.filter((item) => item.status === "contradicted").length,
    pendingItems: flatItems.filter((item) => item.status === "pending").length,
  };

  // ── Gates: latest decision wins; opened-without-decision stays open ────
  const decisionsByGate = new Map<string, AuditGate>();
  const openedGates = new Map<string, { description: string; round: number }>();
  for (const entry of ordered) {
    const gateId = String(entry.gate_id ?? "");
    if (!gateId) continue;
    if (entry.task_type === "gate_decision" && isRecord(entry.gate_decision)) {
      const decision = entry.gate_decision as Record<string, unknown>;
      decisionsByGate.set(gateId, {
        gateId,
        kind: decision.kind === "agent" ? "agent" : "user",
        actionHash: typeof decision.actionHash === "string" ? decision.actionHash : "",
        approved: decision.approved === true,
        decidedAt: typeof decision.decidedAt === "string" ? decision.decidedAt : "",
        round: entryRound(entry),
      });
    } else if (entry.task_type === "gate_opened") {
      openedGates.set(gateId, {
        description: typeof entry.gate_action === "string" ? entry.gate_action : gateId,
        round: entryRound(entry),
      });
    }
  }
  const gates = [...decisionsByGate.values()];
  const unresolvedUserGates: string[] = [];
  for (const [gateId, opened] of openedGates) {
    if (decisionsByGate.has(gateId)) continue;
    // Re-derive the classification from the recorded action text.
    const { gate } = deriveGate(opened.description);
    if (gate.kind === "user") {
      unresolvedUserGates.push(`${gateId} (round ${opened.round}): ${opened.description}`);
    }
  }

  // ── Sequence integrity (P0) ────────────────────────────────────────────
  let sequenceComplete = true;
  let provenanceAvailable = store !== undefined;
  if (store) {
    try {
      const sequences = eventSequence(store, loopId);
      const max = sequences.length > 0 ? Math.max(...sequences) : 0;
      sequenceComplete = sequences.length === max;
    } catch (error) {
      sequenceComplete = false;
      if (!(error instanceof StorageCorruptionError)) throw error;
    }
  }

  // ── Criteria accounting: objective declares, machine facts evidence ────
  const acceptance = views.find((view) => view.operatorAcceptance !== null)
    ?.operatorAcceptance ?? null;
  const declaredIds = new Set(
    (acceptance?.success_criteria ?? []).map(deriveCriterionId),
  );
  const allVerified = new Set(
    deriveCriterionFacts({ rounds: views, commands })
      .filter((fact) => fact.status === "verified")
      .map((fact) => fact.criterion_id),
  );
  const evidencedIds = [...declaredIds].filter((id) => allVerified.has(id));

  // v4.0.3: the terminal posture is a fact; the verdict is the verification
  // view over structure + posture, never a copy of the Agent's claim.
  const lastView = views.length > 0 ? views[views.length - 1] : undefined;
  const terminalClosure = lastView
    ? contractByRound.get(lastView.round)?.statuses.closure
    : undefined;
  const terminalPosture = lastView?.evidencePosture?.status ?? null;
  let verdict: AuditResult["verdict"] = "passed";
  if (rounds.some((round) => round.checks.some((check) => check.verdict === "failed")) ||
      contractsSummary.contradictedItems > 0 ||
      terminalPosture === "contradicted") {
    verdict = "contradicted";
  } else if (
    unresolvedUserGates.length > 0 ||
    contractsSummary.open > 0 ||
    terminalClosure === "superseded" ||
    terminalClosure === "blocked" ||
    terminalPosture === "insufficient" ||
    terminalPosture === "unknown" ||
    (declaredIds.size > 0 && evidencedIds.length === 0)
  ) {
    verdict = "incomplete";
  }

  return {
    loopId,
    verdict,
    evidenceVerdict: terminalPosture,
    rounds,
    rollbacks: rollbacks.map((view) => ({
      round: view.round,
      transactionId: view.transactionId ?? view.roundId,
      origin: view.origin === "agent" ? "agent" as const : "machine" as const,
      redoRound: view.recovery?.target.redo_round ?? 0,
      targetCheckpointId: view.recovery?.target.checkpoint_id ?? "",
      reason: view.recovery?.reason ?? "",
      observedSkippedFiles: [...(view.recovery?.observed_skipped_files ??
        view.recovery?.skipped_files ?? [])],
      reportedSkippedFiles: [...(view.recovery?.reported_skipped_files ?? [])],
      skippedFiles: [...(view.recovery?.skipped_files ?? [])],
      abandonedRounds: [...(view.recovery?.abandoned_rounds ?? [])],
      failedRounds: [...(view.recovery?.failed_rounds ?? [])],
      preservedDiscoveries: [...(view.recovery?.skipped_discoveries ?? [])],
      approaches: [...(view.recovery?.approaches ?? [])],
      wrongAssumptions: [...(view.recovery?.wrong_assumptions ?? [])],
    })),
    gates,
    unresolvedUserGates,
    contracts: contractsSummary,
    criteria: {
      declared: declaredIds.size,
      evidenced: evidencedIds.length,
      missing: Math.max(0, declaredIds.size - evidencedIds.length),
    },
    sequenceComplete,
    provenanceAvailable,
    legacyRounds: legacyTransactionRounds(loopEntries).map((item) => item.round),
  };
}
