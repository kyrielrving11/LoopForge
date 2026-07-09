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
import { entryRound } from "./verification-gate.js";
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
/** Extract progress_estimate from a vault entry's execution_evidence.
 *  Returns null if no execution evidence is available. */
function entryProgress(entry) {
    const evidence = entry.execution_evidence;
    if (!evidence)
        return null;
    const pe = evidence.progress_estimate;
    return typeof pe === "number" ? pe : null;
}
// ═══════════════════════════════════════════════════════════════════════════
// Individual enforcement rules — each returns EnforcementResult | null
// Rules are ordered by priority. The first non-null result wins.
// ═══════════════════════════════════════════════════════════════════════════
/** R1: Agent claims success but success_criteria_remaining has items.
 *  This is a lie — the agent must either finish the criteria or
 *  set success=false honestly. Triggered by the verification gate's
 *  "success_with_remaining_criteria" error flag. */
function enforceSuccessWithRemainingCriteria(flags) {
    const flag = flags.find((f) => f.check === "success_with_remaining_criteria" && f.severity === "error");
    if (!flag)
        return null;
    return makeEnforcementResult({
        action: "reject",
        reason: flag.detail,
        fix_instructions: "You set success=true but success criteria remain unmet. " +
            "Either: (a) complete the remaining criteria and re-submit your self-evaluation, " +
            "or (b) set success=false and honestly report what remains to be done.",
    });
}
/** R2: Same constraint violation appears in 3 consecutive rounds.
 *  The agent is repeating the same mistake. Triggered by the verification
 *  gate's "recurring_violation" error flag. */
function enforceRecurringViolation(flags) {
    const flag = flags.find((f) => f.check === "recurring_violation" && f.severity === "error");
    if (!flag)
        return null;
    return makeEnforcementResult({
        action: "reject",
        reason: flag.detail,
        fix_instructions: "The same constraint violation has appeared in 3 consecutive rounds. " +
            "You must: (a) explain WHY this violation keeps occurring, " +
            "and (b) propose a DIFFERENT approach than what you used in the last 3 rounds. " +
            "Do NOT retry the same strategy — it has failed 3 times.",
    });
}
/** R3: Agent claims success but did nothing verifiable.
 *  Only fires when execution_evidence IS provided (structured self-eval path)
 *  but shows no files changed AND no tests run AND success=true.
 *  Skips when execution_evidence is undefined (heuristic fallback) —
 *  heuristic evaluations have no evidence by definition. */
function enforceEmptySuccess(selfEval, _flags) {
    if (!selfEval.success)
        return null;
    const ev = selfEval.execution_evidence;
    // Skip if no execution_evidence at all — this is the heuristic fallback
    // case where the agent didn't provide structured evidence.
    if (!ev)
        return null;
    const filesEmpty = ev.files_changed.length === 0;
    const testsNotRun = ev.test_results === null;
    if (!filesEmpty || !testsNotRun)
        return null;
    return makeEnforcementResult({
        action: "reject",
        reason: "Agent claims success but execution_evidence shows no files changed " +
            "and no tests were run. There is no verifiable evidence of work.",
        fix_instructions: "You must provide verifiable evidence: " +
            "(a) list the files you changed in execution_evidence.files_changed, " +
            "and (b) run tests and report results in execution_evidence.test_results. " +
            "If you genuinely completed the task without file changes or tests, " +
            "explain why in detail in your output_summary.",
    });
}
/** R4: Progress has stalled for 3+ consecutive rounds.
 *  Detected by checking progress_estimate deltas across vault entries.
 *  First occurrence → REJECT (agent must change approach).
 *  Second consecutive occurrence → TERMINATE (agent cannot recover). */
function enforceProgressStall(_selfEval, _flags, currentRound, vaultEntries, consecutiveRejections) {
    // Need at least 3 rounds of history
    if (currentRound < 3)
        return null;
    // Collect progress estimates for the last 3 completed rounds from vault
    const progressByRound = new Map();
    for (const entry of vaultEntries) {
        const rnd = entryRound(entry);
        // Only consider rounds before the current one
        if (rnd < 1 || rnd >= currentRound)
            continue;
        const pe = entryProgress(entry);
        if (pe !== null)
            progressByRound.set(rnd, pe);
    }
    // Need at least 3 data points
    if (progressByRound.size < 3)
        return null;
    // Get the three most recent rounds with progress data
    const sortedRounds = [...progressByRound.keys()].sort((a, b) => a - b);
    const last3 = sortedRounds.slice(-3);
    if (last3.length < 3)
        return null;
    // Verify these are the actual last 3 rounds (contiguous with current)
    // Accept rounds that are within [currentRound-3, currentRound-1]
    const expectedMin = currentRound - 3;
    const actualMin = last3[0];
    // Allow up to 1 round gap (some rounds may not have progress data)
    if (actualMin < expectedMin - 1 || last3[2] > currentRound - 1)
        return null;
    const p1 = progressByRound.get(last3[0]);
    const p2 = progressByRound.get(last3[1]);
    const p3 = progressByRound.get(last3[2]);
    const stallThreshold = 0.05;
    const delta12 = p2 - p1;
    const delta23 = p3 - p2;
    // Both deltas must be below threshold AND not near completion
    const isStalling = delta12 < stallThreshold &&
        delta23 < stallThreshold &&
        p3 < 0.95;
    if (!isStalling)
        return null;
    // If already rejected once for stall → escalate to terminate
    if (consecutiveRejections >= 1) {
        return makeEnforcementResult({
            action: "terminate",
            reason: `Progress stalled for 3+ rounds ` +
                `(${(p1 * 100).toFixed(0)}% → ${(p2 * 100).toFixed(0)}% → ${(p3 * 100).toFixed(0)}%) ` +
                `and agent did not resolve after previous rejection. Terminating loop.`,
        });
    }
    return makeEnforcementResult({
        action: "reject",
        reason: `Progress has stalled: ${(p1 * 100).toFixed(0)}% → ` +
            `${(p2 * 100).toFixed(0)}% → ${(p3 * 100).toFixed(0)}% over the ` +
            `last 3 rounds (delta < ${(stallThreshold * 100).toFixed(0)}% each round).`,
        fix_instructions: "Your progress has been flat for 3 rounds. You must: " +
            "(a) explain what is blocking progress, " +
            "(b) propose a DIFFERENT technique or task decomposition, and " +
            "(c) set a concrete, verifiable goal for the redo of this round. " +
            "Do NOT repeat the same approach — it has not moved progress forward.",
    });
}
/** R5: Two consecutive rejections → terminate.
 *  The agent has been unable or unwilling to fix the identified issues
 *  across two consecutive enforcement rejections. */
function enforceMaxRejections(consecutiveRejections) {
    if (consecutiveRejections < 2)
        return null;
    return makeEnforcementResult({
        action: "terminate",
        reason: `${consecutiveRejections} consecutive enforcement rejections without ` +
            `resolution. The agent has been unable to correct the identified issues.`,
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════
/** Enforce round-boundary rules based on the verification gate's findings
 *  and the agent's self-evaluation integrity.
 *
 *  Rules run in priority order (R1 → R5). The first rule that fires wins.
 *
 * @param selfEval              The agent's self-evaluation for the current round.
 * @param verifyResult          The verification gate's output (from verifySelfEvaluation).
 * @param currentRound          Current round number (1-based, BEFORE increment).
 * @param vaultEntries          Vault entries for this loop (used for progress tracking).
 * @param consecutiveRejections How many consecutive rounds have already been rejected.
 *                              Starts at 0; increments on each reject; resets on accept.
 */
export function enforceRound(selfEval, verifyResult, currentRound, vaultEntries, consecutiveRejections = 0) {
    const { flags } = verifyResult;
    // Run enforcement rules in priority order.
    // Earlier rules take higher precedence.
    const rules = [
        () => enforceSuccessWithRemainingCriteria(flags),
        () => enforceRecurringViolation(flags),
        () => enforceEmptySuccess(selfEval, flags),
        () => enforceProgressStall(selfEval, flags, currentRound, vaultEntries, consecutiveRejections),
        () => enforceMaxRejections(consecutiveRejections),
    ];
    for (const rule of rules) {
        const result = rule();
        if (result)
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
 * @param currentRound  The round number that was rejected (NOT incremented).
 * @param task          The original loop task description.
 * @param enforceResult The enforcement decision with reason and fix instructions.
 */
export function buildRejectionPrompt(currentRound, task, enforceResult) {
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