/** v3.9.6: recovery facts and the restore checkpoint.
 *
 * The Agent owns the decision to abandon a branch. This module only turns
 * committed facts into a rollback directive and proves that a redo returned
 * the workspace to the selected restore point. It never chooses a target for
 * the Agent and never mutates the workspace.
 */
import { branchRounds, } from "./committed-round.js";
import { deriveRoundObservationDelta } from "./round-transaction.js";
function observedGit(view) {
    for (const observation of view.afterEvidence) {
        if (observation.kind !== "git" || observation.status !== "observed") {
            continue;
        }
        const data = observation.data;
        const head = data.head;
        if (typeof head !== "string" || head.length === 0)
            continue;
        if (data.coverage !== "tracked_and_non_ignored_untracked")
            continue;
        const dirty = Array.isArray(data.dirty)
            ? data.dirty.filter((file) => typeof file === "string")
            : [];
        const fingerprints = fingerprintMap(observation);
        return { head, dirty, fingerprints };
    }
    return null;
}
/** Resolve an Agent-requested target against the CURRENT branch. This is the
 *  ONLY target-selection predicate. It never falls back to before evidence and
 *  never replaces an invalid target with a "nearest safe" one. */
export function resolveRecoveryTarget(entries, currentRound, targetRound) {
    if (!Number.isInteger(targetRound) || targetRound < 1 || targetRound >= currentRound) {
        return {
            ok: false,
            code: "recovery_invalid",
            reason: "target_out_of_range",
            detail: `target_round must be an integer in [1, ${currentRound - 1}]`,
        };
    }
    const view = branchRounds(entries).find((round) => round.round === targetRound);
    if (!view || view.kind !== "evaluation") {
        return {
            ok: false,
            code: "recovery_invalid",
            reason: "target_not_committed",
            detail: `round ${targetRound} is not a committed evaluation round on the current branch`,
        };
    }
    const git = observedGit(view);
    if (!git) {
        return {
            ok: false,
            code: "recovery_unavailable",
            reason: "restore_point_unobserved",
            detail: `round ${targetRound} has no observed after-phase Git restore point`,
        };
    }
    return {
        ok: true,
        target: { view, head: git.head, dirty: git.dirty, fingerprints: git.fingerprints },
    };
}
function arrayStrings(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
}
function fingerprintMap(observation) {
    if (!observation || observation.kind !== "git" ||
        observation.status !== "observed")
        return {};
    const fingerprints = observation.data.fingerprints;
    if (!fingerprints || typeof fingerprints !== "object" || Array.isArray(fingerprints)) {
        return {};
    }
    const out = {};
    for (const [file, fp] of Object.entries(fingerprints)) {
        if (typeof fp === "string")
            out[file] = fp;
    }
    return out;
}
/** Derive the committed directive facts from the target, the abandoned branch
 *  and the in-flight recovery attempt. Pure; the caller has already validated
 *  the target and collected the current after evidence. */
export function deriveRecoveryDirective(input) {
    const currentDelta = deriveRoundObservationDelta([...input.beforeEvidence], [...input.afterEvidence]);
    const skippedFiles = [];
    const skippedFingerprints = {};
    const skippedDiscoveries = [];
    const failedRounds = [];
    const approaches = [];
    const wrongAssumptions = [];
    const addFile = (file) => {
        if (!skippedFiles.includes(file))
            skippedFiles.push(file);
    };
    const addDiscovery = (text) => {
        if (text && !skippedDiscoveries.includes(text))
            skippedDiscoveries.push(text);
    };
    for (const view of input.abandonedRounds) {
        for (const delta of view.observationDelta) {
            if (delta.kind === "git" && delta.changedFiles) {
                for (const file of delta.changedFiles)
                    addFile(file);
            }
        }
        for (const file of arrayStrings(view.executionReport?.files_changed)) {
            addFile(file);
        }
        const gitAfter = view.afterEvidence.find((observation) => observation.kind === "git" &&
            observation.status === "observed");
        for (const [file, fp] of Object.entries(fingerprintMap(gitAfter))) {
            skippedFingerprints[file] = fp;
        }
        if (view.outputSummary?.trim()) {
            failedRounds.push(view.round);
            approaches.push(view.outputSummary.trim().slice(0, 200));
        }
        for (const assumption of arrayStrings(view.evaluation?.wrong_assumptions)) {
            if (!wrongAssumptions.includes(assumption)) {
                wrongAssumptions.push(assumption.slice(0, 500));
            }
        }
        for (const discovery of arrayStrings(view.evaluation?.discovered_constraints)) {
            addDiscovery(discovery);
        }
    }
    for (const delta of currentDelta) {
        if (delta.kind === "git" && delta.changedFiles) {
            for (const file of delta.changedFiles)
                addFile(file);
        }
    }
    for (const [file, fp] of Object.entries(fingerprintMap(input.afterEvidence.find((observation) => observation.kind === "git")))) {
        skippedFingerprints[file] = fp;
    }
    const trigger = input.triggerEvaluation;
    if (trigger) {
        for (const discovery of arrayStrings(trigger.discovered_constraints)) {
            addDiscovery(discovery);
        }
        for (const assumption of arrayStrings(trigger.wrong_assumptions)) {
            if (!wrongAssumptions.includes(assumption)) {
                wrongAssumptions.push(assumption.slice(0, 500));
            }
        }
    }
    const targetView = input.target.view;
    return {
        origin: input.origin,
        reason: input.reason.slice(0, 500),
        ...(input.triggerRule ? { trigger_rule: input.triggerRule } : {}),
        target: targetView.round,
        target_round_id: targetView.roundId,
        target_transaction_id: targetView.transactionId ?? targetView.roundId,
        target_head: input.target.head,
        target_dirty: [...input.target.dirty],
        target_fingerprints: { ...input.target.fingerprints },
        skipped_files: skippedFiles,
        skipped_fingerprints: skippedFingerprints,
        skipped_discoveries: skippedDiscoveries,
        failed_rounds: failedRounds,
        approaches,
        wrong_assumptions: wrongAssumptions,
        transaction_id: input.transactionId,
    };
}
/** v3.9.6: the one restore checkpoint. A pending directive requires a
 *  machine-observed workspace at the target HEAD with no dirty file outside
 *  the target's own baseline and no skipped file still at its failed-round
 *  fingerprint. Unknown Git is NOT a pass. */
export function verifyRecoveryCheckpoint(input) {
    const targetHead = input.directive.target_head;
    if (!targetHead) {
        return {
            ok: false,
            reason: "recovery_checkpoint_unobservable",
            detail: "the directive has no target HEAD",
        };
    }
    const gitDeltas = input.evidenceDeltas.filter((delta) => delta.kind === "git");
    if (gitDeltas.length === 0) {
        return {
            ok: false,
            reason: "recovery_checkpoint_unobservable",
            detail: "no Git boundary was observed for the redo",
        };
    }
    const targetDirty = new Set(input.directive.target_dirty);
    const targetFingerprints = input.directive.target_fingerprints;
    const sameMap = (actual) => {
        const expectedKeys = Object.keys(targetFingerprints).sort();
        const actualKeys = Object.keys(actual).sort();
        if (expectedKeys.length !== actualKeys.length ||
            expectedKeys.some((key, index) => key !== actualKeys[index]))
            return false;
        return expectedKeys.every((key) => actual[key] === targetFingerprints[key]);
    };
    const restored = gitDeltas.some((delta) => {
        const after = delta.after;
        if (!after || after.kind !== "git" || after.status !== "observed")
            return false;
        const data = after.data;
        const head = typeof data.head === "string" ? data.head : "";
        if (!head || head.slice(0, 12) !== targetHead.slice(0, 12))
            return false;
        const currentDirty = Array.isArray(data.dirty) ? data.dirty : [];
        return currentDirty.every((file) => targetDirty.has(file)) &&
            sameMap(fingerprintMap(after));
    });
    if (!restored) {
        return {
            ok: false,
            reason: "recovery_checkpoint_failed",
            detail: `workspace HEAD is not the restore point ${targetHead} or carries dirty files outside its baseline`,
        };
    }
    // Skipped-file fingerprint arm: a file still byte-identical to its failed
    // state means the failed work was not reverted.
    for (const delta of gitDeltas) {
        const after = delta.after;
        if (!after || after.kind !== "git" || after.status !== "observed")
            continue;
        const fingerprints = fingerprintMap(after);
        for (const file of input.directive.skipped_files) {
            const expected = input.directive.skipped_fingerprints[file];
            if (expected && fingerprints[file] === expected) {
                return {
                    ok: false,
                    reason: "recovery_checkpoint_failed",
                    detail: `skipped file ${file} still matches its failed-round fingerprint`,
                };
            }
        }
    }
    return { ok: true };
}
//# sourceMappingURL=recovery.js.map