/** v2.12: Read-only, replayable end-of-loop audit — the verification view.
 *
 *  Positioning vs loopforge_replay: replay is the factual timeline (what
 *  happened per round); audit is the assessment layer (which claims are
 *  machine-verified, which gates were decided, is the sequence intact).
 *  Everything is derived from committed vault entries — audit never writes.
 *
 *  v3.8: the CONTRACT ITEM axis is the primary completion basis. The criterion
 *  claims stay as an advisory second view — a criterion claim is an agent
 *  statement whose machine backing is mediated by the contract items, so it
 *  cannot be the completion signal. Both axes read the same committed-round
 *  model and the same item reducer the coordinator and explain use.
 */

import type { LoopStore } from "./loop-store.js";
import { eventSequence, StorageCorruptionError } from "./loop-store.js";
import { auditOrder, deriveGate } from "./cognitive-governance.js";
import { rederiveClaimViewWithFlags, listVerifiedClaims } from "./evidence-claims.js";
import type { VaultEntry } from "./loop-store.js";
import { isRecord, entryRound } from "./token-utils.js";
import {
  committedRoundsFromEntries,
  decodeCommittedRound,
  legacyTransactionRounds,
  machineEvidenceForRound,
} from "./committed-round.js";
import { deriveRoundContractView } from "./round-contract.js";
import type { ContractItemStatus } from "./protocol.js";
import { getPolicy } from "./policy.js";

export interface AuditRound {
  round: number;
  outcome: string;
  claims: Array<{ text: string; status: "verified" | "unverified" | "no_evidence" }>;
  checks: Array<{ check: string; severity: string; verdict: "failed" | "warn" | "info" }>;
  /** v3.8: the contract this round EXECUTED under and each item's status as of
   *  this round — the same derivation `explain` renders. */
  contract: {
    id: string;
    declared_at_round: number;
    closure: string;
    items: Array<{ itemId: string; status: ContractItemStatus }>;
  } | null;
}

export interface AuditGate {
  gateId: string;
  kind: "user" | "agent";
  actionHash: string;
  approved: boolean;
  decidedAt: string;
  round: number;
}

/** v3.8: One contract's outcome over the loaned loop, keyed by its content-
 *  addressed id. Re-declaring the same contract later extends the same entry —
 *  the identity says it IS the same contract. */
export interface AuditContract {
  contract_id: string;
  declared_at_round: number;
  first_active_round: number;
  last_active_round: number;
  closure: "open" | "verified" | "blocked";
  closed_at_round: number | null;
  /** Item statuses as of the last round the contract was execution-relevant. */
  items: Array<{ itemId: string; description: string; status: ContractItemStatus }>;
}

export interface AuditContractSummary {
  contracts: AuditContract[];
  /** Contracts whose final closure is still `open`. */
  open: number;
  verifiedItems: number;
  insufficientItems: number;
  contradictedItems: number;
  pendingItems: number;
}

export interface AuditResult {
  loopId: string;
  verdict: "passed" | "incomplete" | "contradicted";
  rounds: AuditRound[];
  gates: AuditGate[];
  unresolvedUserGates: string[];
  /** v3.8: the verification skeleton — the primary completion basis. */
  contracts: AuditContractSummary;
  /** Advisory second axis: criterion claims, not the completion signal.
   *  `declared` and `evidenced` are both DISTINCT-id counts, so they compare. */
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
  const ordered = auditOrder(entries);
  // v3.8: the shared committed-round read model — ordering, dedup and rollback
  // exclusion come from it, not from a private rule.
  const views = committedRoundsFromEntries(entries).filter((view) => view.loopId === loopId);
  const commands = getPolicy().evidence.commands ?? [];
  const viewByRound = new Map(views.map((view) => [view.round, view] as const));
  // The executed contract per round, through the ONE derivation explain and
  // the live coordinator also call. Re-derived per round rather than walked
  // incrementally on purpose: a private incremental walker would be a second
  // history interpretation, which is exactly what this project forbids.
  const contractByRound = new Map<number, ReturnType<typeof deriveRoundContractView>>();
  for (const view of views) {
    contractByRound.set(view.round, deriveRoundContractView({
      rounds: views,
      round: view.round,
      report: view.executionReport,
      observations: view.observationDelta,
      outcome: view.outcome,
      commands,
    }));
  }

  // ── Rounds: per-round claims + checks from committed snapshots ─────────
  const rounds: AuditRound[] = [];
  for (const entry of ordered) {
    const taskId = String(entry.task_id ?? "");
    if (!taskId.startsWith(`loop:${loopId}:r`) || !taskId.endsWith(":feedback")) continue;
    const committed = decodeCommittedRound(entry);
    if (!committed) continue;
    // v2.14: rounds committed with action="backtrack" were rolled back —
    // they are not part of the loop's final history. Counting them would
    // inflate the round list and let their error flags flip the verdict.
    if (committed.action === "backtrack") continue;
    const round = entryRound(entry);
    const outcome = committed.outcome ?? "unknown";
    const claimView = committed.evaluation
      ? rederiveClaimViewWithFlags(
          committed.evaluation,
          machineEvidenceForRound(committed),
          committed.verificationFlags,
        )
      : null;
    const executed = contractByRound.get(round);
    rounds.push({
      round,
      outcome,
      claims: claimView
        ? claimView.claims.map((claim) => ({
            text: claim.targetId,
            status: claim.status === "verified" ? "verified" as const : "unverified" as const,
          }))
        : [],
      checks: committed.verificationFlags.map((flag) => ({
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
    .sort((a, b) => a.first_active_round - b.first_active_round || a.contract_id.localeCompare(b.contract_id));
  const flatItems = contracts.flatMap((contract) => contract.items);
  const contractsSummary: AuditContractSummary = {
    contracts,
    open: contracts.filter((contract) => contract.closure === "open").length,
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

  // ── Criteria accounting (advisory second axis) + verdict ───────────────
  //
  // v3.8 fix: `declared` used to be a PER-ROUND SUM while `evidenced` was a
  // DEDUPLICATED count — a criterion claimed in three rounds read as three
  // declared against one evidenced, so `missing` was fiction. Both sides are
  // now distinct-id counts over the same history and compare directly.
  const verified = listVerifiedClaims(entries, loopId);
  const declaredIds = new Set(rounds.flatMap((round) => round.claims.map((claim) => claim.text)));
  const declared = declaredIds.size;
  const evidenced = verified.length;

  // v3.8: the contract item axis decides completion. A contradicted item is a
  // machine denial; an open contract is unfinished verification; the claim
  // axis only speaks when no contract item exists to speak for it.
  let verdict: AuditResult["verdict"] = "passed";
  if (rounds.some((round) => round.checks.some((check) => check.verdict === "failed")) ||
      contractsSummary.contradictedItems > 0) {
    verdict = "contradicted";
  } else if (unresolvedUserGates.length > 0 || contractsSummary.open > 0 ||
      (declared > 0 && evidenced === 0)) {
    verdict = "incomplete";
  }

  return {
    loopId,
    verdict,
    rounds,
    gates,
    unresolvedUserGates,
    contracts: contractsSummary,
    criteria: { declared, evidenced, missing: Math.max(0, declared - evidenced) },
    sequenceComplete,
    provenanceAvailable,
    legacyRounds: legacyTransactionRounds(entries).map((item) => item.round),
  };
}
