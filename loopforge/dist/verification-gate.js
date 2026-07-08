/** Verification Gate — Layer 1 cross-round consistency checks.
 *
 * Pure-function module. Validates an agent's SelfEvaluation against the
 * loop's own lineage before it enters the compiler.
 *
 * Verdict semantics:
 * - trusted:      all checks passed; flags are informational only.
 * - suspect:      one or more warn-level flags; flags become warnings in
 *                 the next prompt so the agent can clarify.
 * - contradicted: one or more error-level flags; the success flag for
 *                 this round is excluded from the success trend (NOT
 *                 modified). Flags become hard constraints — the agent
 *                 must respond in the next round.
 */
import { makeVerificationFlag, makeVerificationResult } from "./protocol.js";
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
/** Extract the round number from a vault entry's loop_lineage.
 *  Returns 0 if the entry has no lineage or no round field.
 *  In practice, persistLoopLineage always writes round ≥ 1, so 0
 *  unambiguously means "not a valid round entry" in this context. */
function entryRound(entry) {
    const lineage = (entry.loop_lineage ?? {});
    return lineage.round ?? 0;
}
/** Read constraint_violations from a vault entry (entry-level, stored from
 *  the previous round's last_round_result at persist time). */
function entryViolations(entry) {
    const viols = entry.constraint_violations;
    if (Array.isArray(viols))
        return viols.filter((v) => typeof v === "string");
    return [];
}
// ═══════════════════════════════════════════════════════════════════════════
// Individual checks — each returns a VerificationFlag or null
// ═══════════════════════════════════════════════════════════════════════════
function checkProgressRegression(selfEval, prevSelfEval) {
    if (!prevSelfEval?.execution_evidence)
        return null;
    if (!selfEval.execution_evidence)
        return null;
    const prevProgress = prevSelfEval.execution_evidence.progress_estimate;
    const currProgress = selfEval.execution_evidence.progress_estimate;
    if (typeof prevProgress !== "number" || typeof currProgress !== "number")
        return null;
    // Use delta with epsilon to avoid IEEE 754 rounding issues (0.8 - 0.2 > 0.6 in float)
    if (prevProgress - currProgress <= 0.2 + 1e-10)
        return null;
    return makeVerificationFlag({
        severity: "warn",
        field: "progress_estimate",
        check: "progress_regression",
        detail: `Progress dropped from ${prevProgress.toFixed(2)} to ` +
            `${currProgress.toFixed(2)} (delta: ${(currProgress - prevProgress).toFixed(2)})`,
    });
}
function checkEmptyChangeWithPassing(selfEval) {
    const ev = selfEval.execution_evidence;
    if (!ev)
        return null;
    const filesEmpty = ev.files_changed.length === 0;
    const testsAllPass = ev.test_results !== null &&
        ev.test_results.failed === 0 &&
        ev.test_results.passed > 0;
    if (!filesEmpty || !testsAllPass || !selfEval.success)
        return null;
    return makeVerificationFlag({
        severity: "warn",
        field: "execution_evidence",
        check: "empty_change_with_passing",
        detail: "Agent claims success with no files changed and all tests passing — " +
            "verify that work was actually performed",
    });
}
function checkSuccessWithRemainingCriteria(selfEval) {
    if (!selfEval.success)
        return null;
    const remaining = selfEval.execution_evidence?.success_criteria_remaining;
    if (!remaining || remaining.length === 0)
        return null;
    return makeVerificationFlag({
        severity: "error",
        field: "success",
        check: "success_with_remaining_criteria",
        detail: `Agent claims success but ${remaining.length} criteria remain unmet: ` +
            remaining.slice(0, 3).join("; "),
    });
}
function checkDuplicateConstraintDiscovery(selfEval, prevSelfEval, olderViolations) {
    const discovered = selfEval.discovered_constraints;
    if (!discovered || discovered.length === 0)
        return null;
    // Collect all previously-known constraints
    const known = new Set();
    for (const v of olderViolations)
        known.add(v.toLowerCase().trim());
    if (prevSelfEval) {
        for (const d of prevSelfEval.discovered_constraints ?? []) {
            known.add(d.toLowerCase().trim());
        }
        // Also treat previous violations as implicitly discovered
        for (const v of prevSelfEval.constraint_violations) {
            known.add(v.toLowerCase().trim());
        }
    }
    for (const d of discovered) {
        if (known.has(d.toLowerCase().trim())) {
            return makeVerificationFlag({
                severity: "warn",
                field: "discovered_constraints",
                check: "duplicate_constraint_discovery",
                detail: `Constraint "${d}" was already known from a previous round`,
            });
        }
    }
    return null;
}
function checkRecurringViolation(selfEval, prevSelfEval, vaultEntries, currentRound) {
    const currViols = selfEval.constraint_violations;
    if (!currViols || currViols.length === 0)
        return null;
    // Build the violation history: [round N-2, round N-1, round N]
    const violationsByRound = [];
    // Round N-2 violations come from the vault entry for round N-1
    // (persistLoopLineage stores the PREVIOUS round's violations on each entry)
    if (currentRound >= 3) {
        const entryNMinus1 = vaultEntries.find((e) => entryRound(e) === currentRound - 1);
        if (entryNMinus1) {
            const viols = entryViolations(entryNMinus1);
            if (viols.length)
                violationsByRound.push(viols.map((v) => v.toLowerCase().trim()));
        }
    }
    // Round N-1 violations from prevSelfEval
    if (prevSelfEval) {
        const prevViols = prevSelfEval.constraint_violations;
        violationsByRound.push(prevViols.map((v) => v.toLowerCase().trim()));
    }
    // Round N violations from current selfEval
    violationsByRound.push(currViols.map((v) => v.toLowerCase().trim()));
    // Need at least 3 rounds of data
    if (violationsByRound.length < 3)
        return null;
    // Check each current violation against the previous 2 rounds
    const [rNMinus2, rNMinus1, rN] = violationsByRound.slice(-3);
    for (const v of rN) {
        if (rNMinus1.includes(v) && rNMinus2.includes(v)) {
            return makeVerificationFlag({
                severity: "error",
                field: "constraint_violations",
                check: "recurring_violation",
                detail: `Constraint violation "${v}" has appeared in 3 consecutive rounds ` +
                    `(rounds ${currentRound - 2}–${currentRound}) without resolution`,
            });
        }
    }
    return null;
}
function checkRetractFreshConstraint(selfEval, prevSelfEval, currentRound) {
    const retracted = selfEval.retracted_constraints;
    if (!retracted || retracted.length === 0)
        return null;
    if (!prevSelfEval)
        return null;
    const lastRoundDiscoveries = new Set();
    for (const d of prevSelfEval.discovered_constraints ?? []) {
        lastRoundDiscoveries.add(d.toLowerCase().trim());
    }
    for (const r of retracted) {
        if (lastRoundDiscoveries.has(r.toLowerCase().trim())) {
            return makeVerificationFlag({
                severity: "warn",
                field: "retracted_constraints",
                check: "retract_fresh_constraint",
                detail: `Retracting constraint "${r}" that was just discovered in round ` +
                    `${currentRound - 1} — may indicate rapid flip-flopping`,
            });
        }
    }
    return null;
}
// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════
/** Verify a SelfEvaluation against the loop's cross-round lineage.
 *
 * @param selfEval      The agent's self-evaluation for the current round.
 * @param currentRound  The current round number (1-based).
 * @param vaultEntries  Vault entries for this loop (non-feedback only).
 * @param prevSelfEval  The agent's self-evaluation from the previous round
 *                      (null for round 1).
 */
export function verifySelfEvaluation(selfEval, currentRound, vaultEntries, prevSelfEval = null) {
    const flags = [];
    // Collect violations from all previous vault entries for duplicate-discovery
    // and other checks that need deeper history.
    const olderViolations = [];
    for (const entry of vaultEntries) {
        for (const v of entryViolations(entry))
            olderViolations.push(v);
    }
    // Run all checks
    const checks = [
        () => checkProgressRegression(selfEval, prevSelfEval),
        () => checkEmptyChangeWithPassing(selfEval),
        () => checkSuccessWithRemainingCriteria(selfEval),
        () => checkDuplicateConstraintDiscovery(selfEval, prevSelfEval, olderViolations),
        () => checkRecurringViolation(selfEval, prevSelfEval, vaultEntries, currentRound),
        () => checkRetractFreshConstraint(selfEval, prevSelfEval, currentRound),
    ];
    for (const run of checks) {
        const flag = run();
        if (flag)
            flags.push(flag);
    }
    // Determine verdict from the most severe flag present
    const hasError = flags.some((f) => f.severity === "error");
    const hasWarn = flags.some((f) => f.severity === "warn");
    let verdict;
    if (hasError) {
        verdict = "contradicted";
    }
    else if (hasWarn) {
        verdict = "suspect";
    }
    else {
        verdict = "trusted";
    }
    return makeVerificationResult({ verdict, flags });
}
//# sourceMappingURL=verification-gate.js.map