/** v3.8: `loopforge explain` — the per-round "why" view.
 *
 * Read-only projection over the shared read model: committed round views,
 * the contract item reducer, machine observations, verification flags, and
 * the committed enforcement result. It never rebuilds history and never
 * writes. Every fact it prints is one the runtime already derived.
 */
import { readOnlyRollbacks, readOnlyRounds, } from "./committed-round.js";
import { observedGitHead } from "./git-motion.js";
import { deriveCommittedSubmissionView } from "./submission-receipt.js";
import { committedRoundFacts, deriveActiveRoundContract, deriveRoundContractView, } from "./round-contract.js";
import { getPolicy } from "./policy.js";
/** Build the explain view. Pure and read-only. */
export function buildExplain(loopId, entries, round) {
    const all = readOnlyRounds(entries);
    const rollbacks = readOnlyRollbacks(entries);
    const commands = getPolicy().evidence.commands ?? [];
    const active = deriveActiveRoundContract(all, commands);
    const selected = round === undefined
        ? all
        : all.filter((view) => view.round === round);
    const rounds = selected.map((view) => {
        // v3.8: the contract this round EXECUTED under and its status AS OF this
        // round — the same derivation the coordinator runs live. Deriving from
        // `round <= view.round` handed the closing round its successor's contract
        // (the walker had already seen this round close the active one); deriving
        // from `round < view.round` with this round as the in-flight slice reports
        // what actually happened, including a `blocked` closure.
        const { contract, statuses } = deriveRoundContractView({
            rounds: all,
            round: view.round,
            current: committedRoundFacts(view),
            commands,
        });
        const gitBefore = view.beforeEvidence.find((item) => item.providerId === "git");
        const gitAfter = view.afterEvidence.find((item) => item.providerId === "git");
        const gitDelta = view.observationDelta.find((item) => item.kind === "git");
        const coverage = gitAfter && gitAfter.kind === "git" &&
            typeof gitAfter.data.coverage === "string"
            ? gitAfter.data.coverage
            : null;
        const submission = deriveCommittedSubmissionView(view, all, rollbacks);
        return {
            round: view.round,
            roundId: view.roundId,
            attempt: view.attempt,
            action: view.action,
            outcome: view.outcome,
            report: view.executionReport
                ? {
                    output_summary: view.evaluation?.output_summary ?? "",
                    success: view.evaluation?.success ?? false,
                    criterion_claims: (view.executionReport.criterion_claims ?? []).map((claim) => ({
                        criterion_id: claim.criterion_id,
                        outcome: claim.outcome,
                    })),
                    contract_item_claims: (view.executionReport.contract_item_claims ?? []).map((claim) => ({
                        item_id: claim.item_id,
                        outcome: claim.outcome,
                    })),
                }
                : null,
            observations: view.afterEvidence.map((observation) => ({
                providerId: observation.providerId,
                kind: observation.kind,
                phase: observation.phase,
                status: observation.status,
                files: observation.files,
            })),
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
            files_changed: gitDelta?.changedFiles ?? null,
            git_change_state: gitDelta === undefined
                ? "not_applicable"
                : gitDelta.changedFiles === null ? "unknown" : "observed",
            head_before: observedGitHead(gitBefore),
            head_after: observedGitHead(gitAfter),
            git_status: gitAfter?.status ?? null,
            coverage,
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
            contractTransition: view.contractTransition
                ? {
                    kind: view.contractTransition.kind,
                    contract_id: view.contractTransition.contract_id,
                    ...(view.contractTransition.reason !== undefined
                        ? { reason: view.contractTransition.reason }
                        : {}),
                }
                : null,
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
            reason: view.recovery?.reason ?? "",
            skippedFiles: [...(view.recovery?.skipped_files ?? [])],
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
        lines.push("", `Round ${round.round} (${round.roundId}, attempt ${round.attempt}) — ${round.action}${round.outcome ? ` / ${round.outcome}` : ""}`);
        if (round.report) {
            lines.push(`  report: success=${round.report.success} — ${round.report.output_summary.slice(0, 200)}`);
            for (const claim of round.report.contract_item_claims) {
                lines.push(`    item claim: ${claim.item_id} → ${claim.outcome}`);
            }
        }
        for (const observation of round.observations) {
            lines.push(`  observation: ${observation.providerId} [${observation.status}] ${observation.files.length} file(s)`);
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
        if (round.contractTransition) {
            lines.push(`  contract transition: ${round.contractTransition.kind} ` +
                `${round.contractTransition.contract_id}` +
                (round.contractTransition.reason
                    ? ` — ${round.contractTransition.reason.slice(0, 160)} (report only)`
                    : " (report only)"));
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=explain.js.map