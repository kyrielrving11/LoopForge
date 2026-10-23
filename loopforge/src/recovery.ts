/** v3.9.7: checkpoint selection and committed rollback-directive facts.
 *
 * The Agent owns the decision to abandon a branch and the checkpoint it
 * selects. This module only resolves a checkpoint reference against the
 * current branch, validates the reference/manifest binding, and derives the
 * rollback directive facts. It never chooses a target, never judges a reason,
 * and never mutates the workspace. Restore execution lives in
 * `workspace-restore.ts`.
 */

import type {
  CheckpointRef,
  MachineObservation,
  RecoveryDirective,
  RecoveryTarget,
  SelfEvaluation,
  WorkspaceCheckpointManifest,
} from "./protocol.js";
import {
  type CommittedRoundView,
  branchRounds,
} from "./committed-round.js";
import type { RoundTransactionSnapshot } from "./round-transaction.js";

export interface CheckpointTargetResult {
  ok: true;
  ref: CheckpointRef;
}

export type CheckpointTargetFailure = {
  ok: false;
  code: "recovery_invalid" | "recovery_unavailable";
  reason: string;
  detail: string;
};

function invalid(reason: string, detail: string): CheckpointTargetFailure {
  return { ok: false, code: "recovery_invalid", reason, detail };
}

function unavailable(reason: string, detail: string): CheckpointTargetFailure {
  return { ok: false, code: "recovery_unavailable", reason, detail };
}

function refsOfSnapshot(snapshot: RoundTransactionSnapshot | null | undefined): CheckpointRef[] {
  if (!snapshot) return [];
  const refs: CheckpointRef[] = [];
  if (snapshot.beforeCheckpoint) refs.push(snapshot.beforeCheckpoint);
  for (const ref of snapshot.checkpoints ?? []) refs.push(ref);
  return refs;
}

function sameTarget(refs: ReadonlyArray<CheckpointRef>): boolean {
  if (refs.length <= 1) return true;
  const first = refs[0];
  return refs.every((ref) =>
    ref.role === first.role &&
    ref.round === first.round &&
    ref.redoRound === first.redoRound &&
    ref.contentHash === first.contentHash);
}

/** Resolve a checkpoint id against the held transaction and the current
 *  branch's committed evaluation transactions. The held reference wins when
 *  the same state also appears in committed history (retry re-binding).
 *
 *  This function is pure: it only uses committed read models and the held
 *  snapshot. The caller loads and validates the manifest. */
export function findCheckpointRef(input: {
  entries: ReadonlyArray<unknown>;
  held?: RoundTransactionSnapshot | null;
  checkpointId: string;
}): CheckpointTargetResult | CheckpointTargetFailure {
  const { checkpointId } = input;
  if (!/^ck-[a-f0-9]{24}$/.test(checkpointId)) {
    return invalid("invalid_checkpoint_id", "checkpoint id must be ck-<24 hex>");
  }
  const heldRefs = refsOfSnapshot(input.held).filter(
    (ref) => ref.checkpointId === checkpointId,
  );
  const committedRefs: CheckpointRef[] = [];
  for (const view of branchRounds(input.entries)) {
    if (view.kind !== "evaluation") continue;
    for (const ref of [
      ...(view.beforeCheckpoint ? [view.beforeCheckpoint] : []),
      ...view.checkpoints,
    ]) {
      if (ref.checkpointId === checkpointId) committedRefs.push(ref);
    }
  }
  const all = [...heldRefs, ...committedRefs];
  if (all.length === 0) {
    return invalid(
      "target_not_visible",
      `checkpoint ${checkpointId} is not referenced by the held transaction or a committed evaluation on the current branch`,
    );
  }
  if (!sameTarget(all)) {
    return invalid(
      "ambiguous_checkpoint",
      `checkpoint ${checkpointId} resolves to conflicting role/round/contentHash references`,
    );
  }
  return { ok: true, ref: heldRefs[0] ?? committedRefs[0] };
}

/** Validate the manifest against its reference. Content/blob/HEAD checks
 *  belong to the restore preflight (they need the workspace and object store). */
export function validateCheckpointManifest(
  ref: CheckpointRef,
  manifest: WorkspaceCheckpointManifest | null,
): { ok: true; manifest: WorkspaceCheckpointManifest } | CheckpointTargetFailure {
  if (!manifest) {
    return unavailable("manifest_missing", `manifest for ${ref.checkpointId} is missing or unreadable`);
  }
  if (manifest.checkpointId !== ref.checkpointId ||
      manifest.contentHash !== ref.contentHash ||
      manifest.role !== ref.role ||
      manifest.round !== ref.round ||
      manifest.loopId.length === 0) {
    return unavailable(
      "manifest_mismatch",
      `manifest for ${ref.checkpointId} does not match its transaction reference`,
    );
  }
  const fingerprintPaths = new Set(Object.keys(manifest.fingerprints));
  for (const path of manifest.contents) {
    if (!fingerprintPaths.has(path)) {
      return unavailable(
        "manifest_mismatch",
        `manifest content path ${path} has no boundary fingerprint`,
      );
    }
  }
  return { ok: true, manifest };
}

/** The before-image that represents the state at the start of `redoRound`.
 *  Used by machine backtrack: the state after round T is the before-image of
 *  round T+1. Returns null when that image was never materialized. */
export function checkpointForRoundBoundary(input: {
  entries: ReadonlyArray<unknown>;
  /** The in-flight transaction's round and before-image, when available. */
  heldRound?: number;
  heldBeforeCheckpoint?: CheckpointRef | null;
  redoRound: number;
}): CheckpointRef | null {
  const { redoRound } = input;
  if (input.heldRound === redoRound && input.heldBeforeCheckpoint) {
    return input.heldBeforeCheckpoint;
  }
  const view = branchRounds(input.entries).find(
    (round) => round.round === redoRound && round.kind === "evaluation",
  );
  return view?.beforeCheckpoint ?? null;
}

function observationFingerprints(
  observation: MachineObservation | undefined,
): Record<string, string> | null {
  if (!observation || observation.kind !== "git" || observation.status !== "observed") {
    return null;
  }
  const data = observation.data;
  return data && typeof data === "object" && data.fingerprints &&
      typeof data.fingerprints === "object"
    ? data.fingerprints
    : null;
}

function firstObservedGit(
  observations: ReadonlyArray<MachineObservation>,
): MachineObservation | undefined {
  return observations.find(
    (observation) => observation.kind === "git" && observation.status === "observed",
  );
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Union-key comparison against the target snapshot. Paths whose content or
 *  type differs — including additions and deletions — are the abandoned work
 *  seen since the checkpoint. A file changed and changed back is not a net
 *  difference, matching the round-delta semantics. */
function addBoundaryDiff(
  target: Record<string, string>,
  observation: MachineObservation | undefined,
  into: Set<string>,
): void {
  const fingerprints = observationFingerprints(observation);
  if (!fingerprints) return;
  const keys = new Set([...Object.keys(target), ...Object.keys(fingerprints)]);
  for (const key of keys) {
    if (target[key] !== fingerprints[key]) into.add(key);
  }
}

/** Derive the committed directive. Pure: the caller has validated the target
 *  and collected the abandoned/current evidence. `skipped_files` is report
 *  data (never a restore gate); discoveries are preserved only from committed
 *  abandoned rounds, never from a rejected/in-flight trigger attempt. */
export function deriveRecoveryDirective(input: {
  origin: "agent" | "machine";
  reason: string;
  triggerRule?: string;
  transactionId: string;
  targetRef: CheckpointRef;
  targetManifest: WorkspaceCheckpointManifest;
  abandonedRounds: ReadonlyArray<CommittedRoundView>;
  currentAfterEvidence: ReadonlyArray<MachineObservation>;
  triggerEvaluation?: SelfEvaluation | null;
  triggerRound?: number;
}): RecoveryDirective {
  const skippedFiles = new Set<string>();
  const skippedDiscoveries: string[] = [];
  const failedRounds: number[] = [];
  const approaches: string[] = [];
  const wrongAssumptions: string[] = [];

  const addDiscovery = (text: string): void => {
    if (text && !skippedDiscoveries.includes(text)) skippedDiscoveries.push(text);
  };
  const addAssumption = (text: string): void => {
    if (text && !wrongAssumptions.includes(text)) {
      wrongAssumptions.push(text.slice(0, 500));
    }
  };

  for (const view of input.abandonedRounds) {
    addBoundaryDiff(
      input.targetManifest.fingerprints,
      firstObservedGit(view.afterEvidence),
      skippedFiles,
    );
    for (const file of arrayStrings(view.executionReport?.files_changed)) {
      skippedFiles.add(file);
    }
    if (view.outputSummary?.trim()) {
      failedRounds.push(view.round);
      approaches.push(view.outputSummary.trim().slice(0, 200));
    }
    for (const assumption of arrayStrings(view.evaluation?.wrong_assumptions)) {
      addAssumption(assumption);
    }
    for (const discovery of arrayStrings(view.evaluation?.discovered_constraints)) {
      addDiscovery(discovery);
    }
  }

  // The current in-flight transaction is not committed history: it can
  // contribute its machine net-diff and its trigger assumptions, but never a
  // discovery that would become an active constraint.
  addBoundaryDiff(
    input.targetManifest.fingerprints,
    firstObservedGit(input.currentAfterEvidence),
    skippedFiles,
  );
  if (input.triggerEvaluation) {
    for (const assumption of arrayStrings(input.triggerEvaluation.wrong_assumptions)) {
      addAssumption(assumption);
    }
    const summary = input.triggerEvaluation.output_summary?.trim() ?? "";
    if (summary && input.triggerRound !== undefined) {
      if (!failedRounds.includes(input.triggerRound)) failedRounds.push(input.triggerRound);
      const approach = summary.slice(0, 200);
      if (!approaches.includes(approach)) approaches.push(approach);
    }
  }

  const target: RecoveryTarget = {
    checkpoint_id: input.targetRef.checkpointId,
    content_hash: input.targetRef.contentHash,
    role: input.targetRef.role,
    round: input.targetRef.round,
    round_id: input.targetRef.roundId,
    transaction_id: input.targetRef.transactionId,
    redo_round: input.targetRef.redoRound,
  };

  return {
    origin: input.origin,
    reason: input.reason.slice(0, 500),
    ...(input.triggerRule ? { trigger_rule: input.triggerRule } : {}),
    target,
    skipped_files: [...skippedFiles].sort(),
    skipped_discoveries: skippedDiscoveries,
    failed_rounds: failedRounds,
    approaches,
    wrong_assumptions: wrongAssumptions,
    transaction_id: input.transactionId,
  };
}
