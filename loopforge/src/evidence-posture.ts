/** v4.0.3: the ONE evidence-posture derivation.
 *
 *  `deriveEvidencePosture` is a PURE function over the facts of a single round
 *  transaction: the submitted evaluation, the after observations, their
 *  derived deltas, the verification flags, the contract binding and the
 *  machine-backed-success fact the verification gate already computed.
 *
 *  It reads no policy, no filesystem, no Vault and no live workspace. The
 *  coordinator calls it exactly once per round (before the transaction is
 *  committed), persists the result inside that transaction, and every read
 *  surface consumes the persisted copy. Re-deriving the posture elsewhere
 *  would create a second interpretation of the same round, which is exactly
 *  what this module exists to prevent.
 *
 *  Status priority (fixed; see the release plan):
 *    1. rollback                              → not_applicable
 *    2. contradicted  (error flag, contradicted item, failed command)
 *    3. unknown       (indeterminate observation, unobservable workspace with
 *                      verification in play, configured verification with no
 *                      after command observation)
 *    4. not_applicable (no success claim and no active contract)
 *    5. verified      (no contract or contract verified; no claim or the
 *                      machine backed the claim)
 *    6. insufficient  (everything else)
 *
 *  `unknown` never degrades to `verified` or to an empty result. `status` is
 *  computed from the COMPLETE data, before any display cap is applied.
 */

import type {
  EvidencePosture,
  FilesReconciliation,
  MachineObservation,
  ObservationStatus,
  SelfEvaluation,
  VerificationFlag,
} from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import { gitDeltaState } from "./evidence-provider.js";
import type { ActiveContractView } from "./round-contract.js";
import type { ContractItemStatusView } from "./contract-items.js";
import { effectiveSuccess } from "./round-outcome.js";
import { deriveFindingId } from "./token-utils.js";

/** Fixed, code-level display caps. They are never policy: a policy knob must
 *  not be able to change which machine evidence a round carries. `omitted`
 *  records what the cap hid; the status decision always sees everything. */
export const EVIDENCE_POSTURE_CAPS = {
  providers: 16,
  commands: 16,
  contractItems: 24,
  findings: 12,
} as const;

/** Per-item reason cap: a few short sentences of historical explanation. */
export const EVIDENCE_POSTURE_REASON_CAP = 2;
export const EVIDENCE_POSTURE_REASON_CHARS = 200;

/** Observation statuses that leave the boundary undetermined. They are never
 *  treated as a pass and never as "no change". */
const INDETERMINATE_OBSERVATIONS: ReadonlySet<ObservationStatus> = new Set([
  "timeout",
  "unavailable",
  "error",
  "aborted",
]);

const PROVIDER_KIND_RANK: Record<"git" | "custom", number> = {
  git: 0,
  custom: 1,
};

const SEVERITY_RANK: Record<VerificationFlag["severity"], number> = {
  error: 0,
  warn: 1,
  info: 2,
};

/** Locale-independent ordering: the same input must produce the same JSON in
 *  every environment. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function capList<T>(
  values: ReadonlyArray<T>,
  cap: number,
): { items: T[]; omitted: number } {
  const limit = Math.max(0, cap);
  if (values.length <= limit) return { items: [...values], omitted: 0 };
  return { items: values.slice(0, limit), omitted: values.length - limit };
}

/** The empty posture of a rollback directive: abandoning a branch makes no
 *  success claim and produces no evidence, so nothing is fabricated. */
export function rollbackEvidencePosture(round: number): EvidencePosture {
  return {
    round,
    kind: "rollback",
    status: "not_applicable",
    machineBackedSuccess: false,
    verificationConfigured: false,
    workspace: { status: "not_applicable", changedPathCount: 0 },
    files: null,
    providers: [],
    commands: [],
    contract: null,
    findings: [],
    omitted: {
      providers: 0,
      commands: 0,
      contractItems: 0,
      findings: 0,
    },
  };
}

export interface EvidencePostureInput {
  round: number;
  kind: "evaluation" | "rollback";
  /** The submitted evaluation; null only for callers with no evaluation. */
  selfEval: SelfEvaluation | null;
  afterEvidence: ReadonlyArray<MachineObservation>;
  evidenceDeltas: ReadonlyArray<ObservationDelta>;
  verificationFlags: ReadonlyArray<VerificationFlag>;
  /** ONLY `VerificationResult.machineBackedSuccess`. This function never
   *  re-derives it from observations, flags or claims. */
  machineBackedSuccess: boolean;
  activeContract: ActiveContractView | null;
  contractStatuses: ContractItemStatusView;
  /** Policy fact at commit time: at least one enabled, after-capable command. */
  verificationConfigured: boolean;
  filesReconciliation: Pick<
    FilesReconciliation,
    "status" | "reported" | "observed"
  > | null;
}

function providerEntries(
  observations: ReadonlyArray<MachineObservation>,
): EvidencePosture["providers"] {
  const byKey = new Map<string, EvidencePosture["providers"][number]>();
  for (const observation of observations) {
    // Command observations are reported under `commands`; this list is the
    // Git/custom provider surface.
    if (observation.kind === "command") continue;
    byKey.set(`${observation.kind}\u0000${observation.providerId}`, {
      providerId: observation.providerId,
      kind: observation.kind,
      status: observation.status,
    });
  }
  return [...byKey.values()].sort((left, right) =>
    PROVIDER_KIND_RANK[left.kind] - PROVIDER_KIND_RANK[right.kind] ||
    compareText(left.providerId, right.providerId));
}

function commandEntries(
  observations: ReadonlyArray<MachineObservation>,
): EvidencePosture["commands"] {
  const byId = new Map<string, EvidencePosture["commands"][number]>();
  for (const observation of observations) {
    if (observation.kind !== "command") continue;
    // A collector-synthesized failure observation (unavailable/timeout/error)
    // may carry no per-command data. It is still a provider-level fact, but
    // it cannot be attributed to a command id, so it does not invent one.
    const commandId = observation.data.commandId;
    if (typeof commandId !== "string" || commandId.length === 0) continue;
    byId.set(commandId, {
      commandId,
      status: observation.status,
      required: observation.data.required === true,
    });
  }
  return [...byId.values()].sort((left, right) =>
    compareText(left.commandId, right.commandId));
}

function findingEntries(
  flags: ReadonlyArray<VerificationFlag>,
): EvidencePosture["findings"] {
  const byId = new Map<string, EvidencePosture["findings"][number]>();
  for (const flag of flags) {
    const id = deriveFindingId(flag);
    const existing = byId.get(id);
    // The id names the finding's SUBJECT, not its severity. A later, stronger
    // finding for the same subject must not be hidden by an earlier weaker
    // duplicate.
    if (existing && SEVERITY_RANK[existing.severity] <= SEVERITY_RANK[flag.severity]) {
      continue;
    }
    byId.set(id, {
      id,
      check: flag.check,
      severity: flag.severity,
      ...(flag.ref ? { ref: flag.ref } : {}),
    });
  }
  return [...byId.values()].sort((left, right) =>
    SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
    compareText(left.check, right.check) ||
    compareText(left.ref ?? "", right.ref ?? "") ||
    compareText(left.id, right.id));
}

function contractEntry(
  activeContract: ActiveContractView | null,
  statuses: ContractItemStatusView,
): { contract: EvidencePosture["contract"]; omitted: number } {
  if (!statuses.contractId) return { contract: null, omitted: 0 };
  const criterionRefsById = new Map(
    (activeContract?.items ?? []).map((item) =>
      [item.id, [...item.criterion_refs]] as const),
  );
  const items = statuses.items
    .map((item) => ({
      id: item.itemId,
      status: item.status,
      criterionRefs: [...(criterionRefsById.get(item.itemId) ?? [])],
      reasons: [...new Set(item.reasons)]
        .slice(0, EVIDENCE_POSTURE_REASON_CAP)
        .map((reason) => reason.slice(0, EVIDENCE_POSTURE_REASON_CHARS)),
    }))
    .sort((left, right) => compareText(left.id, right.id));
  const capped = capList(items, EVIDENCE_POSTURE_CAPS.contractItems);
  const pendingCount = Math.max(
    0,
    statuses.items.length -
      statuses.verifiedCount -
      statuses.insufficientCount -
      statuses.contradictedCount,
  );
  return {
    contract: {
      id: statuses.contractId,
      closure: statuses.closure,
      items: capped.items,
      verifiedCount: statuses.verifiedCount,
      insufficientCount: statuses.insufficientCount,
      contradictedCount: statuses.contradictedCount,
      pendingCount,
    },
    omitted: capped.omitted,
  };
}

function workspaceEntry(
  deltas: ReadonlyArray<ObservationDelta>,
): EvidencePosture["workspace"] {
  const git = gitDeltaState(deltas);
  if (git.state === "observed") {
    return { status: "observed", changedPathCount: git.changedFiles.size };
  }
  return { status: git.state, changedPathCount: 0 };
}

function filesEntry(
  files: EvidencePostureInput["filesReconciliation"],
): EvidencePosture["files"] {
  if (!files) return null;
  return {
    reconciliation: files.status,
    reported: files.reported.length,
    observed: files.observed?.length ?? 0,
  };
}

/** Derive the ONE evidence posture of a round.
 *
 *  All inputs belong to the same round transaction. The function is pure,
 *  deterministic and independent of any current policy: the caller passes the
 *  policy-derived `verificationConfigured` fact and the already-computed
 *  `machineBackedSuccess`.
 */
export function deriveEvidencePosture(
  input: EvidencePostureInput,
): EvidencePosture {
  if (input.kind === "rollback") {
    return rollbackEvidencePosture(input.round);
  }

  const providers = providerEntries(input.afterEvidence);
  const commands = commandEntries(input.afterEvidence);
  const findings = findingEntries(input.verificationFlags);
  const contract = contractEntry(input.activeContract, input.contractStatuses);
  const workspace = workspaceEntry(input.evidenceDeltas);
  const files = filesEntry(input.filesReconciliation);

  const successClaim = input.selfEval ? effectiveSuccess(input.selfEval) : false;
  const hasContract = input.contractStatuses.contractId !== "";
  const hasObligation = successClaim || hasContract || input.verificationConfigured;
  const afterCommands = input.afterEvidence.filter(
    (observation) => observation.kind === "command" && observation.phase === "after",
  );

  // 2. A machine fact denies the round: an error-level finding, a
  //    contradicted contract item, or a command observed FAILING. Entrypoint
  //    tampering arrives as an error-level finding and is covered here; the
  //    failed command is checked explicitly so the deduction cannot depend on
  //    which layer happened to raise a flag.
  const contradicted =
    input.verificationFlags.some((flag) => flag.severity === "error") ||
    input.contractStatuses.items.some((item) => item.status === "contradicted") ||
    commands.some((command) => command.status === "failed");

  // 3. The machine could not determine the boundary. "Unknown" is a fact of
  //    observability, never an empty result.
  const unknown =
    input.afterEvidence.some((observation) =>
      INDETERMINATE_OBSERVATIONS.has(observation.status)) ||
    (workspace.status === "unknown" &&
      (hasContract || input.verificationConfigured)) ||
    (input.verificationConfigured && hasObligation && afterCommands.length === 0);

  let status: EvidencePosture["status"];
  if (contradicted) {
    status = "contradicted";
  } else if (unknown) {
    status = "unknown";
  } else if (!successClaim && !hasContract) {
    // 4. Nothing was claimed and no slice was executed. Passed commands stay
    //    listed as facts; they do not add up to "this round was verified".
    status = "not_applicable";
  } else if (
    (!hasContract || input.contractStatuses.closure === "verified") &&
    (!successClaim || input.machineBackedSuccess)
  ) {
    // 5. Evidence coverage is complete. With no success claim this says the
    //    machine evidence is complete, not that the task succeeded.
    status = "verified";
  } else {
    // 6. A claim or contract remains without complete machine backing.
    status = "insufficient";
  }

  const cappedProviders = capList(providers, EVIDENCE_POSTURE_CAPS.providers);
  const cappedCommands = capList(commands, EVIDENCE_POSTURE_CAPS.commands);
  const cappedFindings = capList(findings, EVIDENCE_POSTURE_CAPS.findings);

  return {
    round: input.round,
    kind: "evaluation",
    status,
    machineBackedSuccess: input.machineBackedSuccess === true,
    verificationConfigured: input.verificationConfigured === true,
    workspace,
    files,
    providers: cappedProviders.items,
    commands: cappedCommands.items,
    contract: contract.contract,
    findings: cappedFindings.items,
    omitted: {
      providers: cappedProviders.omitted,
      commands: cappedCommands.omitted,
      contractItems: contract.omitted,
      findings: cappedFindings.omitted,
    },
  };
}
