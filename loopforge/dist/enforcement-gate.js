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
import { machineProgressSeries, CHECK_SUCCESS_WITH_REMAINING_CRITERIA, CHECK_RECURRING_VIOLATION, CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE, CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED, CHECK_REQUIRED_COMMAND_FAILED, CHECK_COMMAND_EVIDENCE_MISMATCH, CHECK_OUTCOME_SUCCESS_CONTRADICTION, CHECK_VERIFICATION_ENTRYPOINT_MODIFIED, CHECK_ROUND_SCOPE_DRIFT, CHECK_CONTRACT_ITEMS_UNVERIFIED, CHECK_USER_GATE_UNRESOLVED } from "./verification-gate.js";
import { getPolicy } from "./policy.js";
import { isRecord, entryRound } from "./token-utils.js";
import { committedRoundsFromEntries, decodeCommittedRound, machineEvidenceForRound, } from "./committed-round.js";
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
/** Collect progress estimates from vault entries into a round→estimate map.
 *  Shared by the progress evaluator's stall and flatline tiers. */
function collectProgressByRound(vaultEntries, currentRound) {
    const progressByRound = new Map();
    for (const round of committedRoundsFromEntries(vaultEntries, currentRound)) {
        const progress = round.executionReport?.progress_estimate;
        if (typeof progress === "number")
            progressByRound.set(round.round, progress);
    }
    return progressByRound;
}
/** v3.2.1: R4/R5 progress window — after a backtrack committed for this
 *  round, the agent's redo submission is the freshest data point. The
 *  pre-rollback history (which triggered the stall) stays in the vault and
 *  the redo does not commit while it is being evaluated, so without this
 *  the window never changes: a genuinely fixed redo is rejected forever and
 *  the loop dies in a spurious terminate. A redo that is STILL stalled
 *  keeps the window flat and hits the normal reject → terminate ladder. */
function progressWindow(vaultEntries, currentRound, selfEval) {
    const progressByRound = collectProgressByRound(vaultEntries, currentRound);
    if (hasCommittedBacktrack(vaultEntries, currentRound)) {
        const pe = selfEval.execution_report?.progress_estimate;
        if (typeof pe === "number")
            progressByRound.set(currentRound, pe);
    }
    return progressByRound;
}
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
    return vaultEntries.some((entry) => {
        if (entryRound(entry) < currentRound)
            return false;
        return committedRoundResult(entry)?.action === "backtrack";
    });
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
export function findSafeRestorePoint(currentRound, vaultEntries, maxDepth) {
    const completed = committedRoundsFromEntries(vaultEntries, currentRound)
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
        if (isCleanRound(round)) {
            return { round: targetRound, skippedDiscoveries };
        }
    }
    return null;
}
/** v2.12: Git HEAD commit hash at the restore point. Read from the restore
 *  round's committed transaction snapshot (after evidence preferred, before
 *  evidence as fallback). Returns null when the round has no git snapshot
 *  or no committed feedback entry. */
export function findBacktrackTargetGitHead(restoreRound, vaultEntries) {
    const committed = committedRoundsFromEntries(vaultEntries)
        .find((view) => view.round === restoreRound);
    if (!committed)
        return null;
    const evidence = machineEvidenceForRound(committed);
    for (const item of evidence) {
        if (!isRecord(item) || item.providerId !== "git" || !isRecord(item.data))
            continue;
        const head = item.data.head;
        if (typeof head === "string" && head.length > 0)
            return head;
    }
    return null;
}
export function buildBacktrackPrompt(fromRound, toRound, triggerRule, skippedDiscoveries,
/** v2.13: Files changed in the skipped rounds (from evidence snapshots).
 *  Used to show the agent exactly what needs to be reverted. */
skippedFiles = [],
/** v2.12: Git HEAD commit hash at the backtrack point (current HEAD).
 *  The agent must discard work back to the clean round's state. */
gitHead,
/** v3.7.1: The redo submission's roundId (loop:<id>:round:<toRound+1>). */
recoveryRoundId,
/** v3.7.1: Derived Recovery Brief facts — committed facts + the
 *  in-flight attempt only; never rejected payloads. */
recovery) {
    const lines = [
        `## ⛔ Backtrack — Round ${fromRound} → Restored to Round ${toRound}`,
        "",
    ];
    // ── Recovery Brief (v3.7.1) ──────────────────────────────────────────
    // A compact structured summary at the top of the rollback directive. The
    // detailed sections below (workspace restore, discoveries, instructions)
    // keep their existing wording; the brief exists so the agent cannot miss
    // why it was rolled back, what failed, and what the redo round is.
    if (recovery) {
        lines.push("### Recovery Brief", "");
        lines.push(`- **Trigger**: ${triggerRule}`);
        lines.push(`- **Restored to round**: ${toRound} (the redo is round ${toRound + 1})`);
        if (recoveryRoundId) {
            lines.push(`- **Recovery Round ID**: \`${recoveryRoundId}\``);
        }
        if (recovery.failedRounds.length > 0) {
            lines.push(`- **Failed rounds**: ${recovery.failedRounds.join(", ")}`);
            const shown = recovery.approaches.slice(0, 6);
            for (const approach of shown) {
                lines.push(`  - Failed approach: ${approach}`);
            }
            if (recovery.approaches.length > shown.length) {
                lines.push(`  - … and ${recovery.approaches.length - shown.length} more failed approaches`);
            }
        }
        if (recovery.wrongAssumptions.length > 0) {
            lines.push("- **Falsified assumptions** (do not rebuild on these):");
            for (const assumption of recovery.wrongAssumptions.slice(0, 5)) {
                lines.push(`  - ${assumption}`);
            }
        }
        lines.push("");
    }
    // ── Why This Happened ────────────────────────────────────────────────
    // v3.7: stall and flatline are one evaluator emitting progress_stall; the
    // former flatline-specific wording ("zero forward motion → radically
    // different strategy") is folded into the single section — the disposition
    // tier still distinguishes the enforcement reason itself.
    if (triggerRule === "progress_stall") {
        lines.push("### Why This Happened", "", `Progress stalled over rounds ${toRound + 1}–${fromRound}: the work ` +
            `produced no verifiable forward motion — no new files changed, no ` +
            `criteria met, no progress estimates moving.`, "", "The approach used in those rounds **did not work**. It should not be " +
            "repeated — a **radically different** strategy is needed.", "");
    }
    // ── v2.13: Workspace Restore ──────────────────────────────────────────
    lines.push("### ⚠️ Workspace Restore Required", "", `Your working directory still contains changes from the **failed** ` +
        `rounds (${toRound + 1}–${fromRound}). You MUST discard those changes ` +
        `before starting Round ${toRound + 1}. Working on top of stale changes ` +
        `will cause the verification gate to reject your next submission.`, "");
    if (skippedFiles.length > 0) {
        lines.push("**Files modified in skipped rounds (must be reverted):**", "");
        for (const f of skippedFiles.slice(0, 15)) {
            lines.push(`- \`${f}\``);
        }
        if (skippedFiles.length > 15) {
            lines.push(`- … and ${skippedFiles.length - 15} more files`);
        }
        lines.push("");
    }
    // v3.8: FACTS, not commands. LoopForge never mutates the working tree, and it
    // does not prescribe how the agent restores it either — the restore is the
    // AGENT's action, so the prompt states what must be true (the target HEAD and
    // the files that must be reverted) and leaves the means entirely to the
    // agent. No `git stash` / `git reset` / `git checkout` / `git clean` line
    // belongs here.
    if (gitHead) {
        lines.push("**The workspace must be returned to the restore point before you " +
            "continue:**", "", `- HEAD must be at \`${gitHead.slice(0, 12)}\``, `- Every file listed above must be back in its state at Round ${toRound}`, `- No leftover change from rounds ${toRound + 1}–${fromRound} may remain`, "", "Your next submission's git observation is compared against that HEAD, " +
            "and a file whose fingerprint still matches the failed round proves the " +
            "restore did not happen.", "");
    }
    else {
        lines.push(`**The workspace must be returned to its state at Round ${toRound}** — ` +
            "every file listed above reverted, with nothing left over from the " +
            "failed rounds.", "");
    }
    lines.push("Restoring the workspace is **your** responsibility. LoopForge never " +
        "modifies the working tree; it only records the restore requirement and " +
        "checks the result.", "", `**If git is unavailable**, revert the files listed above by hand to ` +
        `their state at Round ${toRound}. Re-read the state file below — ` +
        `it reflects the correct state at Round ${toRound}.`, "", "> 🛡️ **Verification:** The next round's evidence check will verify that " +
        "> your workspace no longer contains the failed changes. Submissions " +
        "> with unrestored files will be **rejected**.", "");
    // ── What Must Change ──────────────────────────────────────────────────
    lines.push("### What Must Change", "", "- Do **NOT** repeat the approach used in the skipped rounds.", "- Try a **different** task decomposition or technique.", "- If the current sub-goal is stuck, consider canceling it " +
        "(`subgoal_updates` to canceled) and working on a different one.",
    // v3.5: the restored Current Task may be the very Round Contract that
    // stalled — the agent must be told the sanctioned way to revise it
    // (outcome=blocked closes the active contract; the revised proposal in
    // the same submission becomes active next round). Without this the
    // agent's revision would be silently ignored as premature.
    "- If the restored Current Task is a Round Contract that caused the stall: " +
        "close it in this submission with `outcome=\"blocked\"` (+ a blocker " +
        "explaining why it stalled) and declare the REVISED contract in the " +
        "same submission. Do **NOT** silently restate the stalled contract.", "- Use the `prompt_requests.confusion_points` field in your self-evaluation " +
        "to flag anything you don't understand about the task or the blockage.", "");
    // ── Preserved Discoveries ─────────────────────────────────────────────
    if (skippedDiscoveries.length > 0) {
        lines.push("### Preserved Discoveries", "", "These were discovered in the skipped rounds and remain valid:", "");
        for (const d of skippedDiscoveries) {
            lines.push(`- ${d}`);
        }
        lines.push("");
    }
    // ── Instructions ──────────────────────────────────────────────────────
    lines.push("### Instructions", "", `You have been rolled back to Round ${toRound}. ` +
        `You are now starting **Round ${toRound + 1}** with the lessons above.`, "", "1. **First**: restore your workspace using the commands above.", "2. Read the restored state below — it reflects Round " + toRound + ".", "3. The discoveries from skipped rounds (if any) have been merged " +
        "into the active constraints.", "4. Do NOT retrace the steps that led to the stall. Choose a new path.", "");
    return lines.join("\n");
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
        fix_instructions: "The same constraint violation has appeared in 3 consecutive rounds. " +
            "You must: (a) explain WHY this violation keeps occurring, " +
            "and (b) propose a DIFFERENT approach than what you used in the last 3 rounds. " +
            "Do NOT retry the same strategy — it has failed 3 times.",
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
 *  cannot back the success claim. Reject so the agent resubmits the SAME
 *  round with the entrypoint unchanged (a freshly created entrypoint passes
 *  on the redo — the diff no longer contains it). */
function enforceVerificationEntrypointTampered(flags) {
    const flag = flags.find((f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED && f.severity === "error");
    if (!flag)
        return null;
    return makeEnforcementResult({
        action: "reject",
        reason: flag.detail,
        fix_instructions: "The verification command entrypoint changed in this round, so its " +
            "result cannot be trusted as machine evidence. You must: (a) keep the " +
            "verification command (and its entrypoint files) stable, (b) resubmit " +
            "your SelfEvaluation for the SAME round with the entrypoint unchanged " +
            "so the runtime can re-run it against a stable baseline, and (c) do " +
            "NOT rewrite the verification script to make it pass.",
        check: "verification_entrypoint_modified",
    });
}
/** R8 (v2.12/v3.7): The single success-evidence row. The verification gate
 *  produced success_without_verified_evidence (error) — either the empty/
 *  missing-evidence arm (v3.7: the ex-R3 empty_success posture moved into
 *  checkSuccessWithoutVerifiedEvidence) or the claims arm (zero verified
 *  claims). First occurrence → reject with concrete evidence requirements;
 *  second consecutive → terminate. */
function enforceSuccessWithoutVerifiedEvidence(flags, consecutiveRejections) {
    const flag = flags.find((f) => f.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE && f.severity === "error");
    if (!flag)
        return null;
    if (consecutiveRejections >= 2) {
        return makeEnforcementResult({
            action: "terminate",
            reason: "Repeated success claims with zero machine-verifiable evidence.",
            check: "success_without_verified_evidence",
        });
    }
    const escalation = getPolicy().engine.enforcement_escalation_enabled &&
        consecutiveRejections >= 1
        ? buildEscalationNotice()
        : "";
    return makeEnforcementResult({
        action: "reject",
        reason: "Agent claims success but the runtime verified zero claims: no passing " +
            "test evidence and no test results were observed. Success must be backed " +
            "by machine-verifiable evidence.",
        fix_instructions: "Provide verifiable evidence for your success claim: (a) run tests and " +
            "report results in execution_report.tests_reported, or (b) configure a " +
            "required verification command and run it, or (c) if no change was " +
            "genuinely needed, declare no_change_reason explaining why." + escalation,
        check: "success_without_verified_evidence",
    });
}
/** v3.8: Verification debt — contract items claimed met without machine
 *  verification. The round COMMITS (insufficient is recorded, not rejected);
 *  this row only fires once the debt has persisted for
 *  `engine.unverified_claim_streak_limit` consecutive rounds, then runs the
 *  standard uniform ladder (reject → terminate as `incomplete`).
 *
 *  The streak is derived from COMMITTED round flags, so it survives restart
 *  and cannot be moved by an agent self-report. Git motion does not excuse
 *  it: churning code without verifying is exactly what this row catches. */
function enforceContractItemsUnverified(flags, currentRound, vaultEntries, consecutiveRejections) {
    const limit = getPolicy().engine.unverified_claim_streak_limit;
    if (!Number.isFinite(limit) || limit <= 0)
        return null;
    const current = flags.find((flag) => flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED);
    if (!current)
        return null;
    let streak = 1;
    for (let round = currentRound - 1; round >= 1; round--) {
        const entry = vaultEntries.find((item) => entryRound(item) === round && String(item.task_id ?? "").endsWith(":feedback"));
        const committed = entry ? decodeCommittedRound(entry) : null;
        const carried = committed?.verificationFlags.some((flag) => flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED);
        if (!carried)
            break;
        streak++;
    }
    if (streak < limit)
        return null;
    if (consecutiveRejections >= 2) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `Verification debt persisted for ${streak} rounds — contract items ` +
                `claimed met while no bound command was observed passing.`,
            check: "contract_items_unverified",
            stopReason: "incomplete",
        });
    }
    const escalation = getPolicy().engine.enforcement_escalation_enabled &&
        consecutiveRejections >= 1
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
 *  and declare an extended scope. Repeated drift terminates. */
function enforceScopeDrift(flags, selfEval, consecutiveRejections, vaultEntries = []) {
    const flag = flags.find((f) => f.check === CHECK_ROUND_SCOPE_DRIFT);
    if (!flag)
        return null;
    if (consecutiveRejections >= 2) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `Repeated scope drift — the agent keeps changing files outside its ` +
                `declared contract scope.`,
            check: "round_scope_drift",
        });
    }
    const escalation = getPolicy().engine.enforcement_escalation_enabled &&
        consecutiveRejections >= 1
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
        fix_instructions: "Files changed outside the contract's declared scope. You must either: " +
            "(a) revert the out-of-scope changes, or (b) legally extend the scope: " +
            "a replacement contract is IGNORED while the current one is active, so " +
            "resubmit this work with outcome: \"blocked\" (blocker naming the " +
            "too-narrow scope) plus the extended scope as the next round's " +
            "round_contract. Scope drift is a machine fact — no explanation waives " +
            "it. Repeated scope drift terminates the loop." +
            escalation,
        check: "round_scope_drift",
    });
}
/** R9 (v2.12): Post-backtrack workspace not restored. The verification gate
 *  produced backtrack_workspace_not_restored (error): either skipped-round
 *  files are still dirty, or the working tree is not at the restore point's
 *  git HEAD. The agent must restore the workspace, not redo the round. */
function enforceBacktrackNotRestored(flags, vaultEntries = [], currentRound = 0) {
    const flag = flags.find((f) => f.check === CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED && f.severity === "error");
    if (!flag)
        return null;
    if (!getPolicy().engine.backtrack_enabled)
        return null;
    // v2.14: same deadlock guard as R4/R5 — a backtrack that already fired
    // for this round means a non-restoring agent would otherwise cycle
    // R9-backtrack forever (backtracks do not increment the rejection
    // counter). One rollback chance, then terminate.
    if (currentRound > 0 && hasCommittedBacktrack(vaultEntries, currentRound)) {
        return makeEnforcementResult({
            action: "terminate",
            reason: "The workspace is still not restored after the previous backtrack: " +
                flag.detail,
            check: "backtrack_workspace_not_restored",
        });
    }
    return makeEnforcementResult({
        action: "backtrack",
        reason: "The workspace was not restored after backtrack: " + flag.detail,
        // v3.8: the requirement, not the recipe — LoopForge never mutates the
        // working tree and does not prescribe how the agent restores it.
        fix_instructions: "Return the working directory to the clean round's state before " +
            "submitting the next round: the skipped-round files must be reverted " +
            "and HEAD must be back at the restore point the backtrack prompt named.",
        check: "backtrack_workspace_not_restored",
    });
}
/** Shared observation pipeline for the progress evaluator (stall window,
 *  flatline tier). Machine git motion is exculpatory only: it may veto a
 *  self-reported stall but can never create one. */
function evaluateStallWindow(tier, selfEval, currentRound, vaultEntries) {
    const window = tier === "progress_stall"
        ? 3
        : Math.max(1, getPolicy().engine.stall_lookback_rounds);
    if (currentRound < window)
        return null;
    const progressByRound = progressWindow(vaultEntries, currentRound, selfEval);
    let stalled = false;
    let detail = "";
    const threshold = getPolicy().evolution.progress_stall_threshold;
    if (progressByRound.size >= window) {
        const recent = [...progressByRound.keys()].sort((a, b) => a - b).slice(-window);
        if (recent[0] < currentRound - window)
            return null;
        const values = recent.map((round) => progressByRound.get(round));
        if (values[values.length - 1] >= 0.95)
            return null;
        if (tier === "progress_stall") {
            stalled = values.slice(1).every((value, index) => value - values[index] < threshold);
            detail = values.map((value) => `${(value * 100).toFixed(0)}%`).join(" → ");
        }
        else {
            const first = values[0];
            stalled = values.every((value) => Math.abs(value - first) < 1e-10);
            detail = `completely flat at ${(first * 100).toFixed(0)}%`;
        }
    }
    else {
        const machine = machineProgressSeries(vaultEntries, currentRound, window);
        if (machine === null)
            return null;
        stalled = machine.every((value) => !value);
        detail = tier === "progress_stall"
            ? `no machine-observed changes in the last ${window} rounds`
            : `no machine-observed changes for ${window} consecutive rounds`;
    }
    if (!stalled)
        return null;
    const machine = machineProgressSeries(vaultEntries, currentRound, window);
    if (machine?.some(Boolean))
        return null;
    if (machine !== null) {
        detail += ` — no machine-observed git motion in rounds ${currentRound - window}–${currentRound - 1}`;
    }
    return { tier, detail, window, threshold };
}
/** Shared progress escalation and backtrack deadlock guard (v3.7: one
 * evaluator). The flatline tier keeps its steeper threshold-0 ladder while
 * using the same mechanics — the tier is an internal diagnostic only. */
function resolveStallDisposition(verdict, currentRound, vaultEntries, consecutiveRejections) {
    const { tier, detail, window, threshold } = verdict;
    const flatline = tier === "progress_flatline";
    const escalation = getPolicy().engine.enforcement_escalation_enabled;
    const stalledReason = flatline
        ? `Progress has been ${detail} for ${window} consecutive rounds.`
        : `Progress has stalled: ${detail} over the last ${window} rounds` +
            `${threshold > 0 ? ` (delta < ${(threshold * 100).toFixed(0)}% each round)` : ""}.`;
    // v3.7: both tiers emit the single progress_stall check id — the tier
    // survives only in the reason/fix wording (former progress_flatline id).
    const check = "progress_stall";
    if ((flatline && consecutiveRejections >= 1) || consecutiveRejections >= 2) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `${stalledReason} The stall persisted after escalation. Terminating loop.`,
            check,
        });
    }
    if (consecutiveRejections >= 1 && !escalation) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `${stalledReason} The stall persisted after the previous rejection. Terminating loop.`,
            check,
        });
    }
    const escalated = flatline ? escalation : consecutiveRejections >= 1 && escalation;
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
            fix_instructions: flatline
                ? "Progress is exactly flat. After rollback, choose a radically different approach."
                : "After rollback, do not repeat the stalled approach; choose a different technique or task decomposition.",
            check,
        });
    }
    if (flatline && !escalation) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `${stalledReason} The agent is making zero forward motion and cannot recover.`,
            check,
        });
    }
    return makeEnforcementResult({
        action: "reject",
        reason: stalledReason,
        fix_instructions: (flatline
            ? "Explain the fundamental blocker, choose a radically different approach, and set a concrete verifiable goal."
            : "Explain the blocker, choose a different technique or task decomposition, and set a concrete verifiable goal for this retry.") +
            (escalated ? buildEscalationNotice() : ""),
        check,
    });
}
/** v3.7: The single progress evaluator (former R4 stall and R5 flatline rows
 *  merged into one). The stall-tier window is consulted first — under the
 *  default positive threshold its predicate covers exactly-flat runs too,
 *  reproducing the v3.6 R4-before-R5 shadowing; the flatline tier is
 *  consulted only when the stall predicate cannot hold (threshold ≤ 0,
 *  shorter lookback configs), where it applies its steeper disposition
 *  ladder. Machine git motion is exculpatory only — it may veto a
 *  self-reported stall but can never create one. */
function enforceProgressStall(selfEval, _flags, currentRound, vaultEntries, consecutiveRejections) {
    const verdict = evaluateStallWindow("progress_stall", selfEval, currentRound, vaultEntries)
        ?? evaluateStallWindow("progress_flatline", selfEval, currentRound, vaultEntries);
    return verdict
        ? resolveStallDisposition(verdict, currentRound, vaultEntries, consecutiveRejections)
        : null;
}
/** R6: Two consecutive rejections → escalate (v2.7) or terminate.
 *
 *  v2.7: When enforcement_escalation_enabled is true, the second consecutive
 *  rejection issues an escalated rejection with a "Seek Human Guidance" notice
 *  instead of terminating immediately. Termination occurs on the third
 *  consecutive rejection. When the flag is disabled, behavior is unchanged
 *  (terminate at ≥2 rejections). */
function enforceMaxRejections(consecutiveRejections) {
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
                    "You must address ALL items in the Evidence Gap section above. " +
                    "If you do not understand why you are being rejected, explain " +
                    "your confusion explicitly and ask for clarification." +
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
        "### 🆘 Escalation — Seek Human Guidance",
        "",
        "You have been rejected multiple times for the same issue. " +
            "Before retrying, pause and ask a human for help:",
        "",
        "1. Explain what you've tried so far and why each approach failed.",
        "2. Ask the human for specific guidance on what to try next.",
        "3. Incorporate their feedback before re-submitting your self-evaluation.",
        "",
        "⚠️ If this round is rejected again, the loop will be **terminated**. " +
            "Do NOT resubmit without meaningful changes.",
    ].join("\n");
}
// ═══════════════════════════════════════════════════════════════════════════
// Diagnostic gap builder (v2.7)
// ═══════════════════════════════════════════════════════════════════════════
/** Build a diagnostic gap section from verification flags.
 *
 *  Translates each error/warn-level VerificationFlag into a concrete
 *  claim-vs-evidence mismatch statement. Info-level flags are excluded
 *  because they are purely informational and do not represent gaps.
 *
 *  Returns an empty string when there are no diagnostic flags to report. */
function buildDiagnosticGap(flags) {
    const diagnosticFlags = flags.filter((f) => f.severity === "error" || f.severity === "warn");
    if (diagnosticFlags.length === 0)
        return "";
    const lines = [
        "### Evidence Gap",
        "",
        "The enforcement gate detected mismatches between your claims and the evidence. " +
            "Each item below shows a specific discrepancy — address every one before re-submitting.",
        "",
    ];
    for (const flag of diagnosticFlags) {
        const icon = flag.severity === "error" ? "🚫" : "⚠️";
        lines.push(`- ${icon} **[${flag.check}]** \`${flag.field}\` — ${flag.detail}`);
    }
    lines.push("");
    return lines.join("\n");
}
const RULE_TABLE = [
    { checks: ["success_with_remaining_criteria"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
    { checks: ["recurring_violation"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
    { checks: ["required_command_failed", "command_evidence_mismatch", "outcome_success_contradiction"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
    { checks: ["verification_entrypoint_modified"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
    { checks: ["success_without_verified_evidence"], ladder: "internal" },
    { checks: ["round_scope_drift"], ladder: "internal" },
    { checks: ["contract_items_unverified"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
    { checks: ["progress_stall"], ladder: "internal" },
    { checks: ["max_rejections"], ladder: "counter" },
    { checks: ["backtrack_workspace_not_restored"], ladder: "internal" },
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
lastRejectionCheck = "") {
    const { flags } = verifyResult;
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
        // the same round it ran. Runs before R8: when the entrypoint is tainted
        // R8 also fires, but this reason is more specific.
        () => enforceVerificationEntrypointTampered(flags),
        // v3.5: contract completion claimed without its verification_plan
        // commands passing — runs before R-C1: the completion-truth question
        // outranks boundary nuance.
        // v3.3: R-C1 — contract boundary claimed prematurely (contract-specific
        // wording and check counting; runs before R8 so contract rounds get the
        // contract's own reason.)
        // v2.12/v3.7: R8 — the single success-evidence row (empty/missing-evidence
        // arm merged from the former R3 empty_success posture + claims arm)
        () => enforceSuccessWithoutVerifiedEvidence(flags, consecutiveRejections),
        // v3.3: R-C2 — files changed outside the contract's declared scope
        () => enforceScopeDrift(flags, selfEval, consecutiveRejections, vaultEntries),
        // v3.8: verification debt — contract items claimed met without machine
        // verification (fires only after the configured streak)
        () => enforceContractItemsUnverified(flags, currentRound, vaultEntries, consecutiveRejections),
        // v3.7: single progress evaluator (former R4/R5 slots merged) —
        // reject → backtrack → terminate with the deadlock guard
        () => enforceProgressStall(selfEval, flags, currentRound, vaultEntries, consecutiveRejections),
        // R6: rejection-counter catch-all (evaluated only when no row above
        // fired — a clean-looking round carrying a high persisted counter)
        // v3.7.1: cited gate without an approved human decision
        () => enforceUserGateUnresolved(flags),
        () => enforceMaxRejections(consecutiveRejections),
        // v2.12: R9 — post-backtrack workspace not restored
        () => enforceBacktrackNotRestored(flags, vaultEntries, currentRound),
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
/** Build a rejection prompt for the agent.
 *
 *  The prompt clearly states the round was rejected, why, what the agent
 *  must fix, and that the agent must redo the SAME round (not advance).
 *
 *  v2.7: Accepts verificationFlags to render a diagnostic "Evidence Gap"
 *  section. Each error/warn flag becomes a concrete claim-vs-evidence
 *  mismatch statement so the agent knows exactly what to correct rather
 *  than retrying blindly.
 *
 * @param currentRound      The round number that was rejected (NOT incremented).
 * @param task              The original loop task description.
 * @param enforceResult     The enforcement decision with reason and fix instructions.
 * @param verificationFlags The verification gate's findings for this round.
 *                          Used to build the Evidence Gap section. */
export function buildRejectionPrompt(currentRound, task, enforceResult, verificationFlags = []) {
    const lines = [
        "## ⛔ Round " + currentRound + " — REJECTED",
        "",
        "Your self-evaluation for Round " + currentRound +
            " was **rejected** by the enforcement gate.",
        "",
        "### Reason",
        "",
        enforceResult.reason,
        "",
    ];
    // v2.7: Diagnostic gap — show the agent exactly what doesn't match.
    const gap = buildDiagnosticGap(verificationFlags);
    if (gap) {
        lines.push(gap);
    }
    if (enforceResult.fix_instructions) {
        lines.push("### Required Fix");
        lines.push("");
        lines.push(enforceResult.fix_instructions);
        lines.push("");
    }
    lines.push("### Your Task (Round " + currentRound + " — Retry)");
    lines.push("");
    lines.push(task);
    lines.push("");
    lines.push("### Instructions");
    lines.push("");
    lines.push("1. Read and address each issue in **Required Fix** above.", "2. Re-execute **Round " + currentRound +
        "** — do NOT advance to the next round.", "3. Submit a corrected self-evaluation via `loopforge_next`.", "4. Be honest in your self-evaluation — " +
        "claiming success when criteria are unmet will be rejected again.", "5. If you believe this rejection is incorrect, " +
        "explain why in your output_summary and the enforcement gate will re-evaluate.");
    return lines.join("\n");
}
//# sourceMappingURL=enforcement-gate.js.map