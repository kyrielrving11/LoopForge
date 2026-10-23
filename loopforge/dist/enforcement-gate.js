/** Enforcement Gate — Layer 2 round-boundary runtime enforcement (v1.13).
 *
 * Pure-function module. Receives the verification gate's findings plus
 * round-level context and decides whether to accept the round, reject it
 * (force the agent to redo), or terminate the loop.
 *
 * This is the "runtime" that prompt-only constraint systems lack.
 * Verification gate detects WHAT is wrong; enforcement gate decides
 * what to DO about it.
 *
 * Decision semantics:
 * - accept:    round passes all checks; advance to next round as normal.
 * - reject:    agent's self-evaluation or round output is invalid; the
 *              agent receives a rejection prompt and must redo the SAME
 *              round. Round counter does NOT increment.
 * - terminate: loop has reached an unrecoverable state; stop immediately
 *              with stopReason "enforcement_terminated".
 */
import { makeEnforcementResult } from "./protocol.js";
import { CHECK_SUCCESS_WITH_REMAINING_CRITERIA, CHECK_RECURRING_VIOLATION, CHECK_REQUIRED_COMMAND_FAILED, CHECK_COMMAND_EVIDENCE_MISMATCH, CHECK_OUTCOME_SUCCESS_CONTRADICTION, CHECK_VERIFICATION_ENTRYPOINT_MODIFIED, CHECK_ROUND_SCOPE_DRIFT, CHECK_CONTRACT_ITEMS_UNVERIFIED, CHECK_USER_GATE_UNRESOLVED } from "./verification-gate.js";
import { deriveProgressWindow } from "./progress.js";
import { declaresBlocked } from "./round-outcome.js";
import { getPolicy } from "./policy.js";
import { derivationRounds, decodeCommittedRound, hasCommittedMachineBacktrack, } from "./committed-round.js";
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// v2.10: Backtrack helpers
// ═══════════════════════════════════════════════════════════════════════════
/** Extract the committed round decision's result from a vault entry.
 *  The round commit entry (`loop:<id>:r<N>:feedback`) carries the full
 *  decision under loop_lineage.round_transaction; lineage entries carry
 *  nothing at the top level. */
function committedRoundResult(entry) {
    return decodeCommittedRound(entry)?.result ?? null;
}
/** True when a backtrack already committed at or after the current round —
 *  i.e. the loop is re-walking territory the system already rolled back
 *  once. Guards against the reject↔backtrack deadlock on persistent stalls. */
function hasCommittedBacktrack(vaultEntries, currentRound) {
    return hasCommittedMachineBacktrack(vaultEntries, currentRound);
}
/** Check whether a committed round represents a clean restore point.
 *  as a safe restore point. A clean round was accepted (not rejected)
 *  and had no error-level verification flags.
 *
 *  v3.2.1: judged by the COMMITTED decision and gate flags, not by the
 *  agent's self-reported success. A progress-stall round commits with
 *  success=false but is accepted and carries no error flags — it is a
 *  valid backtrack target (the most common backtrack trigger is exactly a
 *  run of such rounds). Rejected/terminated rounds never commit, and
 *  rolled-back rounds are excluded below. */
function isCleanRound(round) {
    return !round.verificationFlags.some((flag) => flag.severity === "error");
}
/** Scan backwards from currentRound to find the most recent clean round.
 *  Collects discovered_constraints from skipped rounds along the way.
 *  Returns null when no clean round is found within maxDepth. */
export function findSafeRestorePoint(currentRound, vaultEntries, maxDepth, 
/** v3.9.7: a candidate must have a materialized restore checkpoint. */
isEligible) {
    const completed = derivationRounds(vaultEntries, currentRound)
        .sort((a, b) => b.round - a.round);
    const skippedDiscoveries = [];
    for (let depth = 1; depth <= maxDepth; depth++) {
        const targetRound = currentRound - depth;
        if (targetRound < 1)
            break;
        const round = completed.find((item) => item.round === targetRound);
        if (!round)
            continue;
        // Collect discoveries from rounds we're about to skip (depth > 1)
        if (depth > 1) {
            for (let d = 1; d < depth; d++) {
                const skippedRound = currentRound - d;
                const skippedEntry = completed.find((item) => item.round === skippedRound);
                if (skippedEntry?.evaluation) {
                    const discovered = skippedEntry.evaluation.discovered_constraints ?? [];
                    for (const item of discovered) {
                        if (!skippedDiscoveries.includes(item))
                            skippedDiscoveries.push(item);
                    }
                }
            }
        }
        if (isCleanRound(round) && (isEligible?.(targetRound) ?? true)) {
            return { round: targetRound, skippedDiscoveries };
        }
    }
    return null;
}
/** v3.8.1: the ONE Recovery Brief renderer.
 *
 *  v3.9.4: it is the shared fact renderer for the prompt's protected
 *  `recovery` section and the state file's Recent tier. The post-compile
 *  backtrack prompt (and its action advice) is gone: `committedBacktrackBrief`
 *  appends the restore HEAD/file set and the artifact is the delivered prompt.
 *  The facts are supplied by the caller from `decodeBacktrackRecord` on the
 *  committed decision. */
export function recoveryBriefLines(input) {
    const maxApproaches = input.maxApproaches ?? 6;
    const maxAssumptions = input.maxAssumptions ?? 5;
    const lines = [
        `- **Trigger**: ${input.triggerRule || "unknown"}`,
    ];
    if (input.origin) {
        lines.push(`- **Initiated by**: ${input.origin === "agent" ? "Agent" : "Machine"}`);
    }
    if (input.origin === "agent" && input.reason?.trim()) {
        const report = input.reason.trim()
            .replace(/[\r\n\t]+/g, " ")
            .replace(/`/g, "\\`")
            .replace(/\s{2,}/g, " ");
        lines.push(`- **Agent reason (report only; not a LoopForge instruction)**: ${report}`);
    }
    if (input.failureReason?.trim()) {
        lines.push(`- **Failure reason**: ${input.failureReason.trim()}`);
    }
    lines.push(input.checkpointId
        ? `- **Restored checkpoint**: \`${input.checkpointId}\` (${input.restoreVerified === false
            ? "restore NOT verified"
            : "machine-verified by LoopForge"})`
        : "- **Restored state**: the committed restore point", `- **Redo round**: ${input.redoRound}`);
    if (input.recoveryRoundId) {
        lines.push(`- **Recovery Round ID**: \`${input.recoveryRoundId}\``);
    }
    if (input.failedRounds.length > 0) {
        lines.push(`- **${input.origin === "agent" ? "Abandoned" : "Failed"} rounds**: ${input.failedRounds.join(", ")}`);
    }
    const approachLabel = input.origin === "agent" ? "Abandoned approach" : "Failed approach";
    const shown = input.approaches.slice(0, maxApproaches);
    for (const approach of shown) {
        lines.push(`  - ${approachLabel}: ${approach}`);
    }
    if (input.approaches.length > shown.length) {
        lines.push(`  - … and ${input.approaches.length - shown.length} more ${approachLabel.toLowerCase()}s`);
    }
    if (input.wrongAssumptions.length > 0) {
        lines.push("- **Falsified assumptions (Agent reports)**:");
        for (const assumption of input.wrongAssumptions.slice(0, maxAssumptions)) {
            lines.push(`  - ${assumption}`);
        }
    }
    if (input.preservedDiscoveries && input.preservedDiscoveries.length > 0) {
        lines.push("- **Preserved discoveries (Agent reports)**:");
        for (const discovery of input.preservedDiscoveries) {
            lines.push(`  - ${discovery}`);
        }
    }
    return lines;
}
// ═══════════════════════════════════════════════════════════════════════════
// Individual enforcement rules — each returns EnforcementResult | null
// Rules are ordered by priority. The first non-null result wins.
// ═══════════════════════════════════════════════════════════════════════════
/** R1: Agent claims success but declared criteria remain outstanding.
 *  This is a lie — the agent must either finish the criteria or
 *  set success=false honestly. Triggered by the verification gate's
 *  "success_with_remaining_criteria" error flag. */
function enforceSuccessWithRemainingCriteria(flags) {
    const flag = flags.find((f) => f.check === CHECK_SUCCESS_WITH_REMAINING_CRITERIA && f.severity === "error");
    if (!flag)
        return null;
    return makeEnforcementResult({
        action: "reject",
        reason: flag.detail,
        fix_instructions: "You set success=true but success criteria remain unmet. " +
            "Either: (a) complete the remaining criteria and re-submit your self-evaluation, " +
            "or (b) set success=false and honestly report what remains to be done.",
        check: "success_with_remaining_criteria",
    });
}
/** R2: Same constraint violation appears in 3 consecutive rounds.
 *  The agent is repeating the same mistake. Triggered by the verification
 *  gate's "recurring_violation" error flag. */
function enforceRecurringViolation(flags) {
    const flag = flags.find((f) => f.check === CHECK_RECURRING_VIOLATION && f.severity === "error");
    if (!flag)
        return null;
    return makeEnforcementResult({
        action: "reject",
        reason: flag.detail,
        fix_instructions: "The same constraint violation has been reported in three consecutive " +
            "committed rounds. This is a record of your own reports. The finding " +
            "clears when a committed evaluation no longer reports the same " +
            "violation, or when you declare outcome blocked with a blocker. " +
            "LoopForge does not prescribe a technique or decomposition.",
        check: "recurring_violation",
    });
}
/** R-EVID (v2.14): A required command failure, a test-results mismatch that
 *  hides failures, or a self-contradictory outcome claim contradicts the
 *  success claim before commit. The verification gate detects the
 *  contradiction; this rule decides what to do about it — reject so the
 *  agent redos the SAME round with honest claims. Same-check rejections
 *  accumulate toward R6 via the per-check counter. */
function enforceEvidenceContradiction(flags) {
    const contradiction = flags.find((f) => f.severity === "error" &&
        (f.check === CHECK_REQUIRED_COMMAND_FAILED ||
            f.check === CHECK_COMMAND_EVIDENCE_MISMATCH ||
            f.check === CHECK_OUTCOME_SUCCESS_CONTRADICTION));
    if (!contradiction)
        return null;
    return makeEnforcementResult({
        action: "reject",
        reason: contradiction.detail,
        fix_instructions: "A required verification command failed or your claims contradict " +
            "the evidence. You must: (a) run the required command and report its " +
            "actual output, (b) reconcile your success claim with the evidence — " +
            "do NOT report success when the evidence contradicts it, and " +
            "(c) resubmit an honest SelfEvaluation for the SAME round.",
        check: contradiction.check,
    });
}
/** v3.3: R-EVID-VERIFY — the verification command's entrypoint changed in
 *  the same round the command ran. The runtime executed a script the agent
 *  just rewrote, so the "machine observation" has no stable baseline and
 *  cannot back the success claim.
 *
 *  v3.8.3: the row owns its whole ladder (RULE_TABLE ladder: "internal").
 *
 *  The old text said "resubmit with the entrypoint unchanged", which is not an
 *  instruction the agent can carry out when the round CREATED the file — it
 *  did not exist to keep unchanged — and the round's baseline never moves, so
 *  the same file was re-detected on every retry until the uniform ladder
 *  terminated the loop. The recovery text now states the round-start state of
 *  each file (the gate puts it in the detail) and the two routes that exist:
 *  restore it, or take the rollback so the work is redone in a round whose
 *  baseline already contains the entrypoint. Repeated non-restoration is a
 *  rollback, not a kill. */
function enforceVerificationEntrypointTampered(flags, vaultEntries, currentRound, consecutiveRejections, lastRejectionCheck) {
    const flag = flags.find((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED && f.severity === "error");
    if (!flag)
        return null;
    const check = "verification_entrypoint_modified";
    const ownStreak = lastRejectionCheck === check ? consecutiveRejections : 0;
    if (ownStreak >= 1) {
        // The agent has already been told, once, exactly what to restore and has
        // not restored it. Retrying the same round cannot help — the baseline is
        // frozen on purpose — so escalate to the rollback, which redoes the work
        // in a fresh round where the entrypoint is part of the starting state.
        // `backtrack_enabled` off, or a rollback already committed for this round
        // (which would loop), leaves termination as the honest end.
        if (getPolicy().engine.backtrack_enabled &&
            !hasCommittedBacktrack(vaultEntries, currentRound)) {
            return makeEnforcementResult({
                action: "backtrack",
                reason: "The verification command's entrypoint is still not back to its " +
                    "round-start state after being asked once, so this round cannot " +
                    "produce a trustworthy observation.",
                fix_instructions: "After the rollback, restore the workspace as the Recovery Brief " +
                    "states. The restore check requires every skipped file to differ " +
                    "from its state at the rollback, so no entrypoint may still be an " +
                    "uncommitted change: revert it, or make a script you intend to keep " +
                    "part of the committed workspace before the round that runs it. " +
                    "Then redo the round.",
                check,
            });
        }
        return makeEnforcementResult({
            action: "terminate",
            reason: "The verification command's entrypoint was changed in the round it " +
                "verified and was not restored after being asked once. Backtrack is " +
                "disabled or already committed for this round.",
            check,
        });
    }
    return makeEnforcementResult({
        action: "reject",
        reason: flag.detail,
        fix_instructions: "The verification command entrypoint changed in this round, so its " +
            "result cannot be trusted as machine evidence — the runtime executed a " +
            "script this round rewrote. To make this round verifiable again: restore " +
            "each of those files to the state it had when the round started (for a " +
            "file that did not exist then, that means removing it), then resubmit " +
            "this same round's SelfEvaluation. Do NOT rewrite the verification " +
            "script to make it pass. If the work genuinely needs that file, this " +
            "round cannot verify it: make the file part of the committed workspace " +
            "first — a script that is not an uncommitted change — and let a later " +
            "round run it.",
        check,
    });
}
/** v3.8: Verification debt — contract items claimed met without machine
 *  verification. The round COMMITS (insufficient is recorded, not rejected);
 *  this row only fires once the debt has persisted for
 *  `engine.unverified_claim_streak_limit` consecutive rounds, then runs its
 *  OWN ladder: reject → terminate as `incomplete`.
 *
 *  v3.8.1: the ladder lives here (RULE_TABLE marks the row "internal").
 *  Declaring it "uniform" as well ran the escalation twice — the notice was
 *  appended twice to one fix_instructions — and made the uniform terminate
 *  branch unreachable, while its bare `consecutiveRejections` read let a
 *  streak earned by a DIFFERENT check terminate this row on its FIRST
 *  occurrence, which is exactly what the L4 rule forbids.
 *
 *  The streak is derived from COMMITTED round flags, so it survives restart
 *  and cannot be moved by an agent self-report. Machine progress does not
 *  excuse it: churning code without verifying is exactly what this row catches. */
function enforceContractItemsUnverified(flags, currentRound, vaultEntries, consecutiveRejections, lastRejectionCheck) {
    const limit = getPolicy().engine.unverified_claim_streak_limit;
    if (!Number.isFinite(limit) || limit <= 0)
        return null;
    const current = flags.find((flag) => flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED);
    if (!current)
        return null;
    let streak = 1;
    const window = derivationRounds(vaultEntries, currentRound);
    for (let round = currentRound - 1; round >= 1; round--) {
        const committed = window.find((view) => view.round === round);
        const carried = committed?.verificationFlags.some((flag) => flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED);
        if (!carried)
            break;
        streak++;
    }
    if (streak < limit)
        return null;
    // The counter measures the PREVIOUS round's check (the coordinator resets it
    // whenever the check changes), so it only speaks for this row when it names
    // this row — same rule the uniform rows apply.
    const ownRejections = lastRejectionCheck === "contract_items_unverified"
        ? consecutiveRejections
        : 0;
    if (ownRejections >= 2) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `Verification debt persisted for ${streak} rounds — contract items ` +
                `claimed met while no bound command was observed passing.`,
            check: "contract_items_unverified",
            stopReason: "incomplete",
        });
    }
    const escalation = getPolicy().engine.enforcement_escalation_enabled &&
        ownRejections >= 1
        ? buildEscalationNotice()
        : "";
    return makeEnforcementResult({
        action: "reject",
        reason: current.detail,
        fix_instructions: `Contract items have been claimed met for ${streak} consecutive rounds ` +
            "without machine verification. You must either: (a) run the item's bound " +
            "command(s) so they are observed passing, or (b) report the item as " +
            "remaining / declare outcome: \"blocked\" with a blocker. " +
            "An unverified claim is never accepted as completion." + escalation,
        check: "contract_items_unverified",
    });
}
/** R-C2 (v3.3): Round Contract scope drift. The gate produced
 *  round_scope_drift (warn): files changed outside the contract's declared
 *  scope. v3.8: scope drift is a MACHINE fact and is no longer waivable by an
 *  agent explanation (the drift_clarification channel was deleted) — the
 *  agent must revert the out-of-scope changes or close the active contract
 *  and declare an extended scope.
 *
 *  v3.8.3: that second route is now actually reachable. The v3.7 wording
 *  ("extend the scope in your re-declared round_contract") was structurally
 *  dead — a replacement proposal is IGNORED while the active contract is open
 *  — so the fix text was rewritten to the only legal route (blocked + the
 *  extended scope as the next proposal) without the matching escape being
 *  implemented. `scopeDriftWaiver` is that missing half: the coordinator has
 *  verified that the round declares blocked AND that its proposal covers every
 *  drifted file. What is waived is the REJECTION, never the fact. */
function enforceScopeDrift(flags, consecutiveRejections, lastRejectionCheck, scopeDriftWaiver) {
    const flag = flags.find((f) => f.check === CHECK_ROUND_SCOPE_DRIFT);
    if (!flag)
        return null;
    // v3.8.3: the legal exit. A round that declares itself blocked may switch
    // contracts, but only by declaring a proposal that covers every file it
    // changed out of scope — the coverage test is the coordinator's, because
    // only there are the git files and the active contract both in reach.
    //
    // Checked ABOVE the terminate arm on purpose: the counter accumulates while
    // the agent tries to get the declaration right, so an escape that only
    // works at streak 0 or 1 is not an escape — it is a race the agent loses.
    // The flag is NOT suppressed; it stays on the committed round, so
    // audit/explain still report the drift as a machine fact. */
    if (scopeDriftWaiver)
        return null;
    const ownStreak = lastRejectionCheck === CHECK_ROUND_SCOPE_DRIFT
        ? consecutiveRejections
        : 0;
    if (ownStreak >= 2) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `Repeated scope drift — the agent keeps changing files outside its ` +
                `declared contract scope.`,
            check: "round_scope_drift",
        });
    }
    const escalation = getPolicy().engine.enforcement_escalation_enabled &&
        ownStreak >= 1
        ? buildEscalationNotice()
        : "";
    return makeEnforcementResult({
        action: "reject",
        reason: flag.detail,
        // L3 (v3.7.x): option (b) previously told the agent to "extend the scope
        // in your re-declared round_contract" — structurally unreachable: while a
        // contract is ACTIVE, a replacement proposal is ignored as premature, so
        // the guidance dead-ended into repeated rejects/termination. The only
        // legal scope change is to CLOSE the active contract first: resubmit with
        // outcome="blocked" (blocker naming the too-narrow scope) and the
        // extended scope as the NEXT round's contract in the same submission.
        // v3.8.3: that route now works, and its one condition is stated here —
        // the new scope must cover EVERY drifted file, not just the listed ones
        // (the detail above truncates its list).
        fix_instructions: "Files changed outside the contract's declared scope. You must either: " +
            "(a) revert the out-of-scope changes, or (b) legally extend the scope: " +
            "a replacement contract is IGNORED while the current one is active, so " +
            "resubmit this work with outcome: \"blocked\" (blocker naming the " +
            "too-narrow scope) plus a round_contract whose scope covers EVERY file " +
            "listed above (and any other file this round changed outside the current " +
            "scope). Scope drift is a machine fact — no explanation waives " +
            "it. Repeated scope drift terminates the loop." +
            escalation,
        check: "round_scope_drift",
    });
}
/** The ONE progress-stall predicate. A stall requires machine proof that both
 *  the committed window AND the submitted round are unchanged; unknown and
 *  not_applicable never produce a verdict. */
function evaluateStallWindow(currentRound, vaultEntries, 
/** v3.8.1: the round's success is machine-verified (`deriveEvidenceStatus`).
 *  A verified round is finishing work; a progress window cannot outvote it. */
machineBackedSuccess, 
/** The submitted round's own provider-neutral progress. */
inFlightProgress) {
    if (machineBackedSuccess)
        return null;
    if (inFlightProgress.state === "changed")
        return null;
    // "Unknown never stalls": a submitted round whose progress cannot be
    // proven unchanged gets no verdict.
    if (inFlightProgress.state !== "unchanged")
        return null;
    const window = Math.max(1, getPolicy().engine.stall_lookback_rounds);
    if (currentRound < window)
        return null;
    const progress = deriveProgressWindow(derivationRounds(vaultEntries, currentRound), currentRound, window);
    if (progress.state !== "unchanged")
        return null;
    const providers = progress.providers.length > 0
        ? ` (providers: ${progress.providers.join(", ")})`
        : "";
    return {
        detail: `no machine-observed progress in the last ${window} committed rounds${providers}`,
        window,
    };
}
/** One progress disposition ladder. The reason states the machine fact; the
 *  fix states the legal protocol paths, never a semantic strategy. */
function resolveStallDisposition(verdict, currentRound, vaultEntries, consecutiveRejections, lastRejectionCheck) {
    const { detail } = verdict;
    const escalation = getPolicy().engine.enforcement_escalation_enabled;
    const stalledReason = `Machine-observed progress is flat: ${detail}.`;
    const check = "progress_stall";
    // v3.8.3: the stall escalates on its OWN streak. The persisted counter is
    // one scalar shared by every check, so two rejections of any other kind must
    // not turn a first-time stall straight into termination.
    const ownStreak = lastRejectionCheck === check ? consecutiveRejections : 0;
    if (ownStreak >= 2) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `${stalledReason} The stall persisted after escalation. Terminating loop.`,
            check,
        });
    }
    if (ownStreak >= 1 && !escalation) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `${stalledReason} The stall persisted after the previous rejection. Terminating loop.`,
            check,
        });
    }
    const escalated = ownStreak >= 1 && escalation;
    if (escalated && getPolicy().engine.backtrack_enabled) {
        if (hasCommittedBacktrack(vaultEntries, currentRound)) {
            return makeEnforcementResult({
                action: "terminate",
                reason: `${stalledReason} A backtrack already fired for this round; the stall persists after rollback.`,
                check,
            });
        }
        return makeEnforcementResult({
            action: "backtrack",
            reason: stalledReason,
            fix_instructions: "This is a machine liveness fact, not a judgment about your plan. " +
                "The loop will restore the last clean round. After the restore you own " +
                "the next action: continue with a new evaluation, request recovery to " +
                "an earlier committed point, or declare blocked/stop.",
            check,
        });
    }
    return makeEnforcementResult({
        action: "reject",
        reason: stalledReason,
        fix_instructions: "This is a machine liveness fact, not a judgment about your plan. " +
            "You own the next action: submit a new evaluation, request recovery to " +
            "an earlier committed point, or declare outcome blocked with a blocker. " +
            "LoopForge does not prescribe a technique or decomposition." +
            (escalated ? buildEscalationNotice() : ""),
        check,
    });
}
function enforceProgressStall(_flags, currentRound, vaultEntries, consecutiveRejections, machineBackedSuccess, lastRejectionCheck, inFlightProgress) {
    const verdict = evaluateStallWindow(currentRound, vaultEntries, machineBackedSuccess, inFlightProgress);
    return verdict
        ? resolveStallDisposition(verdict, currentRound, vaultEntries, consecutiveRejections, lastRejectionCheck)
        : null;
}
/** R6: Two consecutive rejections → escalate (v2.7) or terminate.
 *
 *  v2.7: When enforcement_escalation_enabled is true, the second consecutive
 *  rejection issues an escalated rejection with a "Seek Human Guidance" notice
 *  instead of terminating immediately. Termination occurs on the third
 *  consecutive rejection. When the flag is disabled, behavior is unchanged
 *  (terminate at ≥2 rejections). */
function enforceMaxRejections(consecutiveRejections, driftWaived) {
    // v3.8.3: this row is the catch-all for a round that LOOKS clean while the
    // persisted counter says otherwise. A round waived past scope drift is not
    // that shape: it declares blocked and its new proposal covers every file it
    // drifted into, so the counter it carries is the drift streak it just
    // resolved — not unresolved persistence. Without this, the legal exit would
    // still dead-end here at a counter of 2 or more.
    if (driftWaived)
        return null;
    const escalation = getPolicy().engine.enforcement_escalation_enabled;
    if (escalation) {
        if (consecutiveRejections >= 3) {
            return makeEnforcementResult({
                action: "terminate",
                reason: `${consecutiveRejections} consecutive enforcement rejections for the ` +
                    `same issue without resolution. The agent has been unable to correct ` +
                    `the identified issue even after escalation. Terminating loop.`,
                check: "max_rejections",
            });
        }
        if (consecutiveRejections >= 2) {
            return makeEnforcementResult({
                action: "reject",
                reason: `${consecutiveRejections} consecutive enforcement rejections for the ` +
                    `same issue without resolution.`,
                fix_instructions: "You have been rejected multiple times for the same issue. " +
                    "Address every concrete finding in the mandatory Verification Gate. " +
                    "If you need human input, stop with needs_human_input; there is no " +
                    "semantic waiver for the findings." +
                    buildEscalationNotice(),
                check: "max_rejections",
            });
        }
        return null;
    }
    if (consecutiveRejections < 2)
        return null;
    return makeEnforcementResult({
        action: "terminate",
        reason: `${consecutiveRejections} consecutive enforcement rejections for the ` +
            `same issue without resolution. The agent has been unable to correct the identified issue.`,
        check: "max_rejections",
    });
}
/** Build an escalation notice urging the agent to seek human guidance.
 *
 *  Appended to fix_instructions when a rule would otherwise terminate.
 *  Gives the agent one final chance to correct course with human input
 *  before the loop is irreversibly stopped. */
function buildEscalationNotice() {
    return [
        "",
        "### 🆘 Escalation — Human Decision Required",
        "",
        "This check has rejected the same round more than once. Before retrying, " +
            "ask the human whether to continue the current scope, change the " +
            "operator-owned scope, or stop.",
        "",
        "1. State the machine fact and the attempt already made.",
        "2. Ask the human for a decision (continue / change scope / stop).",
        "3. Record the decision in the next evaluation, or stop.",
        "",
        "⚠️ If the same check rejects again, the loop will be **terminated**.",
    ].join("\n");
}
const RULE_TABLE = [
    { checks: ["success_with_remaining_criteria"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
    { checks: ["recurring_violation"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
    { checks: ["required_command_failed", "command_evidence_mismatch", "outcome_success_contradiction"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
    // v3.8.3: own ladder — reject → backtrack → terminate. A rewritten
    // entrypoint is not fixed by asking again (the round's baseline is frozen on
    // purpose), so the second occurrence rolls the work back instead of killing
    // the loop. See enforceVerificationEntrypointTampered.
    { checks: ["verification_entrypoint_modified"], ladder: "internal" },
    { checks: ["round_scope_drift"], ladder: "internal" },
    // v3.8.1: "internal" — the handler owns this row's ladder (it must terminate
    // as `incomplete`, with its own reason). Declaring it uniform as well ran the
    // escalation notice twice and left the uniform terminate branch dead.
    { checks: ["contract_items_unverified"], ladder: "internal" },
    { checks: ["progress_stall"], ladder: "internal" },
    { checks: ["max_rejections"], ladder: "counter" },
    // v3.7.1: cited gates without an approved human decision
    { checks: ["user_gate_unresolved"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
];
const RULE_TABLE_BY_ID = new Map();
for (const row of RULE_TABLE) {
    for (const id of row.checks)
        RULE_TABLE_BY_ID.set(id, row);
}
// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════
/** Enforce round-boundary rules based on the verification gate's findings
 *  and the agent's self-evaluation integrity.
 *
 *  Rules run in priority order — the rules array below IS the priority
 *  order; numeric IDs (R1–R9, R-EVID) reflect insertion history, not
 *  priority. The first rule that fires wins.
 *
 * @param selfEval              The agent's self-evaluation for the current round.
 * @param verifyResult          The verification gate's output (from verifySelfEvaluation).
 * @param currentRound          Current round number (1-based, BEFORE increment).
 * @param vaultEntries          Vault entries for this loop (used for progress tracking).
 * @param consecutiveRejections How many consecutive rounds have already been rejected.
 *                              Starts at 0; increments on each reject; resets on accept.
 */
/** v3.7.1: user_gate_unresolved — the round cites gates without an
 *  approved human decision. Reject; the uniform ladder escalates repeats
 *  (the agent should pause and obtain approval — never resubmit a claim of
 *  completed high-risk work). */
function enforceUserGateUnresolved(flags) {
    const flag = flags.find((f) => f.check === CHECK_USER_GATE_UNRESOLVED && f.severity === "error");
    if (!flag)
        return null;
    return makeEnforcementResult({
        action: "reject",
        reason: flag.detail,
        fix_instructions: "The round depends on a high-risk action with no approved human " +
            "decision. Run loopforge_gate_check with the action, present the " +
            "approval question, and call loopforge_gate_resolve only after the " +
            "human decides. Then resubmit with the approved gate id in " +
            "evaluation.gate_ids. Do NOT claim the action is done while it is " +
            "unapproved — safe preparation work never needs a gate.",
        check: CHECK_USER_GATE_UNRESOLVED,
    });
}
export function enforceRound(selfEval, verifyResult, currentRound, vaultEntries, consecutiveRejections = 0, 
/** L4 (v3.7.x): which check rejected the PREVIOUS round. The coordinator
 *  resets consecutiveRejections to 1 whenever the check changes, so the
 *  counter only ever measures one check's streak — this field names that
 *  check and lets uniform rows escalate on THEIR OWN streak instead of
 *  inheriting an unrelated history. */
lastRejectionCheck = "", 
/** v3.8.3: the coordinator has verified that this round declares itself
 *  blocked AND that its new contract proposal's scope covers every file the
 *  round changed outside the active contract's scope. Computed there, not
 *  here: neither the observations nor the active contract reach this
 *  function. See `enforceScopeDrift`. */
scopeDriftWaiver = false, 
/** v3.9.7: the submitted round's provider-neutral progress. */
inFlightProgress = { state: "unknown", providers: [] }) {
    const { flags } = verifyResult;
    // A valid blocked stop is the Agent's protocol action. Liveness/retry rows
    // must not convert it into a same-round rejection; machine-integrity rows
    // still apply below because their facts make the submission untrustworthy.
    const blockedStop = declaresBlocked(selfEval) && selfEval.should_continue === false;
    // Run enforcement rules in priority order — the array order IS the
    // priority; the R-labels in the comments are historical (RULE_TABLE is
    // the semantic description). The first rule that fires wins.
    const rules = [
        () => enforceSuccessWithRemainingCriteria(flags),
        () => enforceRecurringViolation(flags),
        // v2.14: R-EVID — a required command failure, hidden test failures, or
        // a self-contradictory outcome claim contradicts the success claim
        () => enforceEvidenceContradiction(flags),
        // v3.3: R-EVID-VERIFY — the verification command entrypoint changed in
        // the same round it ran.
        () => enforceVerificationEntrypointTampered(flags, vaultEntries, currentRound, consecutiveRejections, lastRejectionCheck),
        // v3.5: contract completion claimed without its verification_plan
        // commands passing — runs before R-C1: the completion-truth question
        // outranks boundary nuance.
        // v3.3: R-C1 — contract boundary claimed prematurely (contract-specific
        // wording and check counting).
        // v3.9.1: R8 was removed. Its only trigger was the empty-report arm of
        // success_without_verified_evidence, which is now a warn: report coverage
        // no longer decides acceptance, and the machine-evidence warn still keeps
        // an unbacked success out of the trajectory.
        // v3.3: R-C2 — files changed outside the contract's declared scope
        () => enforceScopeDrift(flags, consecutiveRejections, lastRejectionCheck, scopeDriftWaiver),
        // v3.8: verification debt — contract items claimed met without machine
        // verification (fires only after the configured streak)
        () => blockedStop
            ? null
            : enforceContractItemsUnverified(flags, currentRound, vaultEntries, consecutiveRejections, lastRejectionCheck),
        // v3.9.7: one provider-neutral progress evaluator —
        // reject → backtrack → terminate with the deadlock guard
        () => blockedStop
            ? null
            : enforceProgressStall(flags, currentRound, vaultEntries, consecutiveRejections, verifyResult.machineBackedSuccess, lastRejectionCheck, inFlightProgress),
        // R6: rejection-counter catch-all (evaluated only when no row above
        // fired — a clean-looking round carrying a high persisted counter)
        // v3.7.1: cited gate without an approved human decision
        () => enforceUserGateUnresolved(flags),
        // v3.8.3: the counter is shared, so this row must know that a scope-drift
        // waiver already excused the streak it carries (see enforceMaxRejections).
        () => blockedStop
            ? null
            : enforceMaxRejections(consecutiveRejections, scopeDriftWaiver && flags.some((f) => f.check === CHECK_ROUND_SCOPE_DRIFT)),
    ];
    // v3.7: uniform-ladder escalation. Rows without their own escalation
    // ladder (R1/R2/R-EVID/R-EVID-VERIFY) escalate on the session's
    // consecutive-rejection count: repeat rejections carry the escalation
    // notice (when enabled — the pre-v3.7 comment promised this notice but the
    // UNLADDERED name-set patch never appended it), and a third consecutive
    // occurrence terminates. This replaces the UNLADDERED_REJECT_CHECKS patch,
    // which existed because the generic R6 ladder sits AFTER these rows and a
    // persistent offender's round never reached it. Rows with their own ladder
    // (RULE_TABLE.ladder === "internal" / "counter") are untouched.
    for (const rule of rules) {
        let result = rule();
        if (!result)
            continue;
        const row = result.check !== undefined
            ? RULE_TABLE_BY_ID.get(result.check)
            : undefined;
        if (result.action === "reject" && row && row.ladder === "uniform") {
            // L4: uniform rows escalate on their OWN consecutive streak only.
            // consecutiveRejections is the streak of the PREVIOUS round's check
            // (the coordinator resets it to 1 whenever the check changes) — a
            // streak earned by a DIFFERENT check must not convert this first
            // occurrence into termination. The user_gate row is the sharp case:
            // its recovery is human approval, so a gate cited after unrelated
            // rejections must reject with instructions, not kill the loop.
            const ownStreak = lastRejectionCheck === result.check
                ? consecutiveRejections
                : 0;
            if (ownStreak >= (row.terminalAfter ?? 2)) {
                return makeEnforcementResult({
                    action: "terminate",
                    reason: `${ownStreak + 1} consecutive rejections for the same ` +
                        `issue (${result.check}) without resolution — the agent cannot ` +
                        `correct it even after escalation.`,
                    check: result.check,
                });
            }
            if (ownStreak >= 1 && row.noticeOnRepeat &&
                getPolicy().engine.enforcement_escalation_enabled) {
                result = makeEnforcementResult({
                    ...result,
                    fix_instructions: result.fix_instructions + buildEscalationNotice(),
                });
            }
        }
        return result;
    }
    // All rules passed — accept the round
    return makeEnforcementResult({
        action: "accept",
        reason: "",
        fix_instructions: "",
    });
}
/** Build the protected retry notice for the agent.
 *
 *  v3.9.7: this is a protocol fact, not a second task narrative. It carries
 *  the enforcement reason, the required fix and the same-round instruction.
 *  Findings are rendered exactly once by the mandatory Verification Gate; the
 *  original task/contract is rendered by Objective/Current Task. The notice
 *  never promises that an explanation will re-evaluate a machine fact.
 *
 * @param currentRound      The round number that was rejected (NOT incremented).
 * @param _task             Kept for the public signature; not rendered here.
 * @param enforceResult     The enforcement decision with reason and fix instructions.
 * @param _verificationFlags Kept for the public signature; findings render in
 *                          the mandatory Verification Gate. */
export function buildRejectionPrompt(currentRound, _task, enforceResult, _verificationFlags = []) {
    const lines = [
        "## ⛔ Round " + currentRound + " — REJECTED",
        "",
        "The enforcement gate rejected this round. This is a machine/protocol",
        "decision, not a judgment about your reasoning strategy.",
        "",
        "### Reason",
        "",
        enforceResult.reason,
        "",
    ];
    if (enforceResult.fix_instructions) {
        lines.push("### Required Fix");
        lines.push("");
        lines.push(enforceResult.fix_instructions);
        lines.push("");
    }
    lines.push("### Instructions");
    lines.push("");
    lines.push("1. Read and address each issue in **Required Fix** above.", "2. Re-execute **Round " + currentRound +
        "** — do NOT advance to the next round.", "3. Submit a corrected evaluation via `loopforge_next` using the latest", "   `roundId` returned by LoopForge.", "4. If you believe a finding is factually wrong, identify the specific", "   machine fact you dispute and submit a corrected evaluation. The gate", "   re-evaluates facts, not explanations.");
    return lines.join("\n");
}
//# sourceMappingURL=enforcement-gate.js.map