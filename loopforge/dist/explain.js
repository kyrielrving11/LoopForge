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
import { readOnlyRollbacks, readOnlyRounds, } from "./committed-round.js";
import { gitRoundFacts } from "./git-facts.js";
import { deriveCommittedSubmissionView } from "./submission-receipt.js";
import { committedRoundFacts, deriveActiveRoundContract, deriveRoundContractView, } from "./round-contract.js";
import { getPolicy } from "./policy.js";
import { deriveOpenQuestionId } from "./open-question.js";
/** v4.0.2: display caps for report facts. Committed originals stay in the
 *  transaction; explain is a bounded read-only view. */
function clip(text, maxChars) {
    const value = text ?? "";
    return value.length > maxChars
        ? { text: value.slice(0, maxChars), truncated: true }
        : { text: value, truncated: false };
}
function clipList(values, maxChars) {
    let truncated = false;
    const out = (values ?? []).map((value) => {
        const clipped = clip(value, maxChars);
        truncated ||= clipped.truncated;
        return clipped.text;
    });
    return { values: out, truncated };
}
function observationView(observation) {
    return {
        providerId: observation.providerId,
        kind: observation.kind,
        phase: observation.phase,
        status: observation.status,
        files: [...observation.files],
        data: { ...observation.data },
    };
}
/** Build the explain view. Pure and read-only. */
export function buildExplain(loopId, entries, round) {
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
    const rounds = selected.map((view) => {
        // v3.8: the contract this round EXECUTED under and its status AS OF this
        // round — the same derivation the coordinator runs live.
        const { contract, statuses } = deriveRoundContractView({
            rounds: all,
            round: view.round,
            current: committedRoundFacts(view),
            commands,
        });
        const git = gitRoundFacts(view.observationDelta);
        const coverage = view.afterEvidence.find((item) => item.kind === "git");
        const submission = deriveCommittedSubmissionView(view, all, rollbacks);
        const reportText = clip(view.evaluation?.output_summary, 4000);
        const noChange = clip(view.evaluation?.no_change_reason, 500);
        const subtaskLabel = clip(view.evaluation?.subtask_boundary_label, 200);
        const wrongAssumptions = clipList(view.evaluation?.wrong_assumptions, 500);
        const retracted = clipList(view.retractedConstraints, 500);
        const questions = clipList(view.openQuestions, 300);
        const blocker = clip(view.evaluation?.blocker, 500);
        const redirectReason = clip(view.contractTransition?.reason, 500);
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
        const checkpoints = [
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
            action: view.action,
            agentSuccessClaim: view.agentSuccessClaim,
            agentOutcome: view.agentOutcome,
            machineBackedSuccess: view.evidencePosture?.machineBackedSuccess ?? false,
            evidencePosture: view.evidencePosture,
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
                    truncated: {
                        output_summary: reportText.truncated,
                        no_change_reason: noChange.truncated,
                        subtask_boundary_label: subtaskLabel.truncated,
                        worker_results: workerTruncated,
                        retroactive_claims: retroTruncated,
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
        activeContract: active
            ? { id: active.id, work_item: active.work_item, itemCount: active.items.length }
            : null,
        rollbacks: rollbacks.map((view) => ({
            round: view.round,
            transactionId: view.transactionId ?? view.roundId,
            origin: view.origin === "agent" ? "agent" : "machine",
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
/** Human-readable rendering of the explain view (CLI default). */
export function renderExplain(result) {
    const lines = [`Loop ${result.loopId}`];
    if (result.activeContract) {
        lines.push(`Active contract: ${result.activeContract.id}` +
            (result.activeContract.work_item ? ` — ${result.activeContract.work_item}` : "") +
            ` (${result.activeContract.itemCount} item(s))`);
    }
    for (const round of result.rounds) {
        const context = round.context
            ? ` — context ${round.context.mode} (${round.context.reason})`
            : "";
        const claim = `claim=${round.agentSuccessClaim}` +
            (round.agentOutcome ? ` / outcome=${round.agentOutcome}` : "");
        lines.push("", `Round ${round.round} (${round.roundId}, attempt ${round.attempt}) — ${round.action} — ${claim}${context}`);
        const posture = round.evidencePosture;
        if (posture) {
            lines.push(`  evidence: ${posture.status}` +
                ` (machine_backed_success=${posture.machineBackedSuccess}, ` +
                `verification_configured=${posture.verificationConfigured})`);
            lines.push(`    workspace: ${posture.workspace.status}` +
                (posture.workspace.status === "observed"
                    ? ` (${posture.workspace.changedPathCount} changed)`
                    : "") +
                `; files reconciliation: ${posture.files?.reconciliation ?? "not_applicable"}`);
            for (const command of posture.commands) {
                lines.push(`    command ${command.commandId}: ${command.status}` +
                    (command.required ? " (required)" : ""));
            }
            if (posture.contract) {
                lines.push(`    contract ${posture.contract.id}: ${posture.contract.closure}`);
                for (const item of posture.contract.items) {
                    lines.push(`      ${item.id}: ${item.status}`);
                }
            }
        }
        if (round.report) {
            const truncated = round.report.truncated.output_summary ? " [truncated]" : "";
            lines.push(`  report: ${round.report.output_summary.slice(0, 200)}${truncated}`);
            if (round.report.no_change_reason) {
                lines.push(`    no_change_reason (Agent report): ${round.report.no_change_reason.slice(0, 160)}`);
            }
            if (round.report.subtask_boundary_label) {
                lines.push(`    subtask boundary (Agent report): ${round.report.subtask_boundary_label}`);
            }
            for (const claim of round.report.contract_item_claims) {
                lines.push(`    item claim: ${claim.item_id} → ${claim.outcome}`);
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
        }
        for (const assumption of round.wrongAssumptions) {
            lines.push(`  wrong assumption (report): ${assumption.slice(0, 160)}`);
        }
        for (const retraction of round.retractedConstraints) {
            lines.push(`  retracted constraint (report): ${retraction.slice(0, 160)}`);
        }
        for (const question of round.openQuestions) {
            lines.push(`  open question (report): ${question.slice(0, 160)}`);
        }
        if (round.blocker) {
            lines.push(`  blocker: ${round.blocker.slice(0, 160)}`);
        }
        for (const observation of round.observations.after) {
            lines.push(`  observation: ${observation.providerId} [${observation.status}] ${observation.files.length} file(s)`);
            if (observation.kind === "command") {
                const data = observation.data;
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
            lines.push("  evidence: INCOMPLETE — the round committed without after-phase observations");
        }
        for (const flag of round.flags) {
            lines.push(`  flag: ${flag.severity} ${flag.check} — ${flag.detail.slice(0, 160)}`);
        }
        if (round.contract) {
            lines.push(`  contract ${round.contract.id} → ${round.contract.closure}`);
            for (const item of round.contract.items) {
                lines.push(`    ${item.itemId}: ${item.status}${item.reasons.length > 0 ? ` — ${item.reasons[0]}` : ""}`);
            }
        }
        if (round.contractRedirect) {
            lines.push(`  contract redirect: ${round.contractRedirect.kind} ` +
                `${round.contractRedirect.contract_id}` +
                (round.contractRedirect.reason
                    ? ` — ${round.contractRedirect.reason.slice(0, 160)} (report only)`
                    : " (report only)"));
        }
    }
    for (const rollback of result.rollbacks) {
        lines.push("", `Rollback R${rollback.round} (${rollback.origin}) → redo R${rollback.redoRound}` +
            `, checkpoint ${rollback.targetCheckpointId}`);
        if (rollback.reason) {
            lines.push(`  reason: ${rollback.reason.slice(0, 200)}`);
        }
        if (rollback.failedRounds.length > 0) {
            lines.push(`  failed rounds: R${rollback.failedRounds.join(", R")}`);
        }
        for (const approach of rollback.approaches) {
            lines.push(`  abandoned approach (report): ${approach.slice(0, 160)}`);
        }
        for (const assumption of rollback.wrongAssumptions) {
            lines.push(`  wrong assumption (report): ${assumption.slice(0, 160)}`);
        }
        for (const flag of rollback.triggerFindings) {
            lines.push(`  trigger finding: ${flag.severity} ${flag.check} — ${flag.detail.slice(0, 160)}`);
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=explain.js.map