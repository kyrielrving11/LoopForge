/** Round Contract item status — the v3.8 verification skeleton.
 *
 *  A contract declares ITEMS; each item binds evidence commands. The agent
 *  may only CLAIM `met` / `remaining`; whether an item is `verified`,
 *  `contradicted`, or `insufficient` is derived here from committed
 *  observations and the in-flight round. Nothing in this module writes state:
 *  it is a pure function of the committed round views, the current report,
 *  the current observations, and policy.
 */

import type {
  ContractItemClaim,
  ContractItemStatus,
  ContractTransition,
  ExecutionReport,
} from "./protocol.js";
import type { ActiveContractView, ActiveContractItem } from "./round-contract.js";
import type { CommittedRoundView } from "./committed-round.js";
import type { ObservationDelta } from "./evidence-provider.js";
import { gitDeltaState } from "./evidence-provider.js";
import type { CommandEvidencePolicy } from "./policy.js";
import { declaresBlocked } from "./round-outcome.js";

/** Per-round slice the reducer needs. */
interface RoundSlice {
  round: number;
  report: ExecutionReport | null;
  deltas: ReadonlyArray<ObservationDelta>;
  /** The round's ONE blocked declaration (outcome or stop_reason). */
  blocked: boolean;
  /** v3.9.9: the round's explicit contract redirect, if it declared one. */
  transition: ContractTransition | null;
}

export interface ItemStatusHistoryEntry {
  round: number;
  status: ContractItemStatus;
  refs: string[];
}

export interface ItemStatusRecord {
  itemId: string;
  description: string;
  status: ContractItemStatus;
  /** Round the current status was first reached. */
  status_at_round: number | null;
  history: ItemStatusHistoryEntry[];
  reasons: string[];
}

export interface ContractItemStatusView {
  contractId: string;
  /** Priority: blocked > superseded > verified > open. `superseded` outranks
   *  `verified` because the Agent explicitly abandoned the slice — even a
   *  round that verified every old item still closes it as superseded. */
  closure: "open" | "verified" | "blocked" | "superseded";
  closed_at_round: number | null;
  items: ItemStatusRecord[];
  verifiedCount: number;
  contradictedCount: number;
  insufficientCount: number;
}

export interface ContractItemInput {
  contract: ActiveContractView | null;
  /** Committed rounds below `currentRound`, ascending, rollback-excluded. */
  rounds: ReadonlyArray<CommittedRoundView>;
  currentRound: number;
  currentReport: ExecutionReport | null;
  currentDeltas: ReadonlyArray<ObservationDelta>;
  /** The in-flight round's own blocked declaration. A `blocked` round CLOSES
   *  its contract, so closure cannot be derived from committed slices alone —
   *  the round being decided is not committed yet. Leave false where no
   *  in-flight round exists (a pure committed-history replay). */
  currentBlocked?: boolean;
  /** v3.9.9: the in-flight (or decoded committed) round's transition. It
   *  closes the contract as `superseded` only when its target matches. */
  currentTransition?: ContractTransition | null;
  commands: ReadonlyArray<CommandEvidencePolicy>;
}

const EMPTY_VIEW: ContractItemStatusView = {
  contractId: "",
  closure: "open",
  closed_at_round: null,
  items: [],
  verifiedCount: 0,
  contradictedCount: 0,
  insufficientCount: 0,
};

function itemClaims(
  item: ActiveContractItem,
  slices: ReadonlyArray<RoundSlice>,
): Array<{ round: number; outcome: ContractItemClaim["outcome"] }> {
  const claims: Array<{ round: number; outcome: ContractItemClaim["outcome"] }> = [];
  for (const slice of slices) {
    for (const claim of slice.report?.contract_item_claims ?? []) {
      if (claim.item_id === item.id) claims.push({ round: slice.round, outcome: claim.outcome });
    }
  }
  return claims;
}

/** The round in which the item was last claimed `met` (null when the latest
 *  claim is `remaining` or there is none). */
function metClaimRound(
  claims: ReadonlyArray<{ round: number; outcome: ContractItemClaim["outcome"] }>,
): number | null {
  const last = claims[claims.length - 1];
  return last && last.outcome === "met" ? last.round : null;
}

type CommandVerdict = "verified" | "contradicted" | "insufficient";

function evaluateCommand(
  commandId: string,
  declaredHash: string | undefined,
  slices: ReadonlyArray<RoundSlice>,
  fromRound: number,
  configured: boolean,
): { verdict: CommandVerdict; reason: string } {
  if (!configured) {
    return {
      verdict: "insufficient",
      reason: `command "${commandId}" is no longer configured/enabled — cannot observe it`,
    };
  }
  // v3.8.1: the LATEST observation at or after the claim decides, so the
  // closing round's evidence is the one consulted. Scanning forward let an
  // early pass outlive a later failure: the item stayed `verified`, its
  // contract closed, and a success stop could reach `completed` in a round
  // whose bound command the machine had just observed FAILING.
  for (const slice of [...slices].reverse()) {
    if (slice.round < fromRound) continue;
    const observation = slice.deltas
      .map((delta) => delta.after)
      .find((item) =>
        item !== null &&
        item.kind === "command" &&
        item.phase === "after" &&
        item.data.commandId === commandId);
    if (!observation || observation.kind !== "command") continue;
    const data = observation.data;
    if (declaredHash && data.configHash !== declaredHash) {
      return {
        verdict: "insufficient",
        reason: `command "${commandId}" was reconfigured after declaration (round ${slice.round})`,
      };
    }
    const git = gitDeltaState(slice.deltas);
    if (observation.status === "passed") {
      // An unknown boundary cannot rule out entrypoint tampering; it is not
      // an empty change set. The absolute entrypoint-trust arm still runs in
      // the verification gate.
      if (git.state === "unknown") {
        return {
          verdict: "insufficient",
          reason: `command "${commandId}" passed, but the Git boundary is unobservable in round ${slice.round}`,
        };
      }
      // A malformed observation must not crash the derivation the compile
      // path, the projection, the coordinator, explain and audit all share:
      // no entrypoint list means the tamper check simply has nothing to
      // compare, the same posture as a command with no entrypoint files.
      const entrypoints = Array.isArray(data.entrypointFiles) ? data.entrypointFiles : [];
      if (git.state === "observed" && entrypoints.some((file) => git.changedFiles.has(file))) {
        return {
          verdict: "contradicted",
          reason: `command "${commandId}" passed but its entrypoint changed in round ${slice.round}`,
        };
      }
      return { verdict: "verified", reason: "" };
    }
    if (observation.status === "failed") {
      return {
        verdict: "contradicted",
        reason: `command "${commandId}" failed in round ${slice.round}` +
          (typeof data.exitCode === "number" ? ` (exit ${data.exitCode})` : ""),
      };
    }
    return {
      verdict: "insufficient",
      reason: `command "${commandId}" observed ${observation.status} in round ${slice.round}`,
    };
  }
  return {
    verdict: "insufficient",
    reason: `command "${commandId}" produced no after-phase observation since round ${fromRound}`,
  };
}

/** v3.8: Derive every item's status plus the contract's closure. */
export function deriveContractItemStatuses(input: ContractItemInput): ContractItemStatusView {
  const contract = input.contract;
  if (!contract) return EMPTY_VIEW;

  const slices: RoundSlice[] = [
    ...input.rounds.map((round) => ({
      round: round.round,
      report: round.executionReport,
      deltas: round.observationDelta,
      blocked: round.evaluation
        ? declaresBlocked(round.evaluation)
        : round.outcome === "blocked",
      transition: round.contractTransition,
    })),
    {
      round: input.currentRound,
      report: input.currentReport,
      deltas: input.currentDeltas,
      blocked: input.currentBlocked === true,
      transition: input.currentTransition ?? null,
    },
  ].filter((slice) => slice.round < input.currentRound || slice.round === input.currentRound);

  const enabledCommands = new Set(
    input.commands.filter((command) => command.enabled).map((command) => command.name),
  );

  const items: ItemStatusRecord[] = contract.items.map((item) => {
    const claims = itemClaims(item, slices);
    const metRound = metClaimRound(claims);
    if (metRound === null) {
      return {
        itemId: item.id,
        description: item.description,
        status: "pending",
        status_at_round: null,
        history: [],
        reasons: [],
      };
    }
    const verdicts = item.verify_with.map((commandId) =>
      evaluateCommand(
        commandId,
        contract.config_hash_by_command[commandId],
        slices,
        metRound,
        enabledCommands.has(commandId),
      ));
    const reasons = verdicts.map((verdict) => verdict.reason).filter(Boolean);
    let status: ContractItemStatus;
    if (verdicts.some((verdict) => verdict.verdict === "contradicted")) {
      status = "contradicted";
    } else if (verdicts.length > 0 && verdicts.every((verdict) => verdict.verdict === "verified")) {
      status = "verified";
    } else {
      status = "insufficient";
    }
    return {
      itemId: item.id,
      description: item.description,
      status,
      status_at_round: metRound,
      history: [{ round: metRound, status, refs: item.verify_with }],
      reasons,
    };
  });

  const verifiedCount = items.filter((item) => item.status === "verified").length;
  const contradictedCount = items.filter((item) => item.status === "contradicted").length;
  const insufficientCount = items.filter((item) => item.status === "insufficient").length;

  const committingRound = slices[slices.length - 1];
  const blocked = committingRound?.blocked === true;
  const allVerified = items.length > 0 && verifiedCount === items.length;
  // v3.9.9 closure priority: blocked > superseded > verified > open.
  // A blocked declaration is the Agent's protocol action and closes the
  // contract first. A transition supersedes only when its target is THIS
  // contract; an inert/abnormal target is ignored rather than closing a
  // contract the Agent never named.
  const superseded = !blocked &&
    committingRound?.transition !== null &&
    committingRound?.transition !== undefined &&
    committingRound.transition.contract_id === contract.id;
  const closure: ContractItemStatusView["closure"] =
    blocked ? "blocked"
      : superseded ? "superseded"
      : allVerified ? "verified"
      : "open";

  return {
    contractId: contract.id,
    closure,
    closed_at_round: closure === "open" ? null : committingRound?.round ?? null,
    items,
    verifiedCount,
    contradictedCount,
    insufficientCount,
  };
}

/** v3.8: The round-level verification posture. */
export function roundVerificationStatus(
  view: ContractItemStatusView,
  report: ExecutionReport | null,
): "trusted" | "insufficient" | "contradicted" {
  if (view.contradictedCount > 0) return "contradicted";
  if (view.insufficientCount > 0) return "insufficient";
  // A success claim with no machine-backed item at all is insufficient too.
  const claims = report?.contract_item_claims ?? [];
  if (claims.some((claim) => claim.outcome === "met") && view.verifiedCount === 0) {
    return "insufficient";
  }
  return "trusted";
}
