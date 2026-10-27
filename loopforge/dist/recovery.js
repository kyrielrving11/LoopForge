/** v3.9.7: checkpoint selection and committed rollback-directive facts.
 *
 * The Agent owns the decision to abandon a branch and the checkpoint it
 * selects. This module only resolves a checkpoint reference against the
 * current branch, validates the reference/manifest binding, and derives the
 * rollback directive facts. It never chooses a target, never judges a reason,
 * and never mutates the workspace. Restore execution lives in
 * `workspace-restore.ts`.
 */
import { deriveFindingId } from "./token-utils.js";
import { branchRounds, } from "./committed-round.js";
function invalid(reason, detail) {
    return { ok: false, code: "recovery_invalid", reason, detail };
}
function unavailable(reason, detail) {
    return { ok: false, code: "recovery_unavailable", reason, detail };
}
function refsOfSnapshot(snapshot) {
    if (!snapshot)
        return [];
    const refs = [];
    if (snapshot.beforeCheckpoint)
        refs.push(snapshot.beforeCheckpoint);
    for (const ref of snapshot.checkpoints ?? [])
        refs.push(ref);
    return refs;
}
function sameTarget(refs) {
    if (refs.length <= 1)
        return true;
    const first = refs[0];
    return refs.every((ref) => ref.role === first.role &&
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
export function findCheckpointRef(input) {
    const { checkpointId } = input;
    if (!/^ck-[a-f0-9]{24}$/.test(checkpointId)) {
        return invalid("invalid_checkpoint_id", "checkpoint id must be ck-<24 hex>");
    }
    const heldRefs = refsOfSnapshot(input.held).filter((ref) => ref.checkpointId === checkpointId);
    const committedRefs = [];
    for (const view of branchRounds(input.entries)) {
        if (view.kind !== "evaluation")
            continue;
        for (const ref of [
            ...(view.beforeCheckpoint ? [view.beforeCheckpoint] : []),
            ...view.checkpoints,
        ]) {
            if (ref.checkpointId === checkpointId)
                committedRefs.push(ref);
        }
    }
    const all = [...heldRefs, ...committedRefs];
    if (all.length === 0) {
        return invalid("target_not_visible", `checkpoint ${checkpointId} is not referenced by the held transaction or a committed evaluation on the current branch`);
    }
    if (!sameTarget(all)) {
        return invalid("ambiguous_checkpoint", `checkpoint ${checkpointId} resolves to conflicting role/round/contentHash references`);
    }
    return { ok: true, ref: heldRefs[0] ?? committedRefs[0] };
}
/** Validate the manifest against its reference. Content/blob/HEAD checks
 *  belong to the restore preflight (they need the workspace and object store). */
export function validateCheckpointManifest(ref, manifest) {
    if (!manifest) {
        return unavailable("manifest_missing", `manifest for ${ref.checkpointId} is missing or unreadable`);
    }
    if (manifest.checkpointId !== ref.checkpointId ||
        manifest.contentHash !== ref.contentHash ||
        manifest.role !== ref.role ||
        manifest.round !== ref.round ||
        manifest.loopId.length === 0) {
        return unavailable("manifest_mismatch", `manifest for ${ref.checkpointId} does not match its transaction reference`);
    }
    const fingerprintPaths = new Set(Object.keys(manifest.fingerprints));
    for (const path of manifest.contents) {
        if (!fingerprintPaths.has(path)) {
            return unavailable("manifest_mismatch", `manifest content path ${path} has no boundary fingerprint`);
        }
    }
    return { ok: true, manifest };
}
/** The before-image that represents the state at the start of `redoRound`.
 *  Used by machine backtrack: the state after round T is the before-image of
 *  round T+1. Returns null when that image was never materialized. */
export function checkpointForRoundBoundary(input) {
    const { redoRound } = input;
    if (input.heldRound === redoRound && input.heldBeforeCheckpoint) {
        return input.heldBeforeCheckpoint;
    }
    const view = branchRounds(input.entries).find((round) => round.round === redoRound && round.kind === "evaluation");
    return view?.beforeCheckpoint ?? null;
}
function observationFingerprints(observation) {
    if (!observation || observation.kind !== "git" || observation.status !== "observed") {
        return null;
    }
    const data = observation.data;
    return data && typeof data === "object" && data.fingerprints &&
        typeof data.fingerprints === "object"
        ? data.fingerprints
        : null;
}
function firstObservedGit(observations) {
    return observations.find((observation) => observation.kind === "git" && observation.status === "observed");
}
function arrayStrings(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
}
/** Union-key comparison against the target snapshot. Paths whose content or
 *  type differs — including additions and deletions — are the abandoned work
 *  seen since the checkpoint. A file changed and changed back is not a net
 *  difference, matching the round-delta semantics. */
function addBoundaryDiff(target, observation, into) {
    const fingerprints = observationFingerprints(observation);
    if (!fingerprints)
        return;
    const keys = new Set([...Object.keys(target), ...Object.keys(fingerprints)]);
    for (const key of keys) {
        if (target[key] !== fingerprints[key])
            into.add(key);
    }
}
/** Derive the committed directive. Pure: the caller has validated the target
 *  and collected the abandoned/current evidence. `skipped_files` is report
 *  data (never a restore gate); discoveries are preserved only from committed
 *  abandoned rounds, never from a rejected/in-flight trigger attempt. */
export function deriveRecoveryDirective(input) {
    const observedSkippedFiles = new Set();
    const reportedSkippedFiles = new Set();
    const skippedDiscoveries = [];
    const machineFailedRounds = [];
    const approaches = [];
    const wrongAssumptions = [];
    const addDiscovery = (text) => {
        if (text && !skippedDiscoveries.includes(text))
            skippedDiscoveries.push(text);
    };
    const addAssumption = (text) => {
        if (text && !wrongAssumptions.includes(text)) {
            wrongAssumptions.push(text.slice(0, 500));
        }
    };
    for (const view of input.abandonedRounds) {
        addBoundaryDiff(input.targetManifest.fingerprints, firstObservedGit(view.afterEvidence), observedSkippedFiles);
        for (const file of arrayStrings(view.executionReport?.files_changed)) {
            reportedSkippedFiles.add(file);
        }
        // v4.0.3: only a MACHINE-detected failure is a failed round. An agent's
        // output_summary is a report, even when the agent chose to abandon.
        if (input.origin === "machine" &&
            view.verificationFlags.some((flag) => flag.severity === "error")) {
            machineFailedRounds.push(view.round);
        }
        if (view.outputSummary?.trim()) {
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
    addBoundaryDiff(input.targetManifest.fingerprints, firstObservedGit(input.currentAfterEvidence), observedSkippedFiles);
    if (input.triggerEvaluation) {
        for (const assumption of arrayStrings(input.triggerEvaluation.wrong_assumptions)) {
            addAssumption(assumption);
        }
        const summary = input.triggerEvaluation.output_summary?.trim() ?? "";
        if (summary && input.triggerRound !== undefined) {
            const approach = summary.slice(0, 200);
            if (!approaches.includes(approach))
                approaches.push(approach);
            if (input.origin === "machine" &&
                !machineFailedRounds.includes(input.triggerRound)) {
                machineFailedRounds.push(input.triggerRound);
            }
        }
    }
    const findings = [];
    const seenFindings = new Set();
    for (const flag of input.triggerFindings ?? []) {
        const id = deriveFindingId(flag);
        if (seenFindings.has(id))
            continue;
        seenFindings.add(id);
        findings.push({ ...flag, detail: flag.detail.slice(0, 500) });
        if (findings.length >= 12)
            break;
    }
    const target = {
        checkpoint_id: input.targetRef.checkpointId,
        content_hash: input.targetRef.contentHash,
        role: input.targetRef.role,
        round: input.targetRef.round,
        round_id: input.targetRef.roundId,
        transaction_id: input.targetRef.transactionId,
        redo_round: input.targetRef.redoRound,
    };
    const observed = [...observedSkippedFiles].sort();
    const reported = [...reportedSkippedFiles].sort();
    const skipped = [...new Set([...observed, ...reported])].sort();
    return {
        origin: input.origin,
        reason: input.reason.slice(0, 500),
        ...(input.triggerRule ? { trigger_rule: input.triggerRule } : {}),
        target,
        skipped_files: skipped,
        observed_skipped_files: observed,
        reported_skipped_files: reported,
        abandoned_rounds: input.abandonedRounds.map((view) => view.round),
        skipped_discoveries: skippedDiscoveries,
        failed_rounds: machineFailedRounds,
        approaches,
        wrong_assumptions: wrongAssumptions,
        ...(findings.length > 0 ? { trigger_findings: findings } : {}),
        transaction_id: input.transactionId,
    };
}
//# sourceMappingURL=recovery.js.map