/** v4.0.2: derive the ONE context boundary of a prompt delivery.
 *
 *  The boundary is a fact about how the host should start the Agent
 *  invocation, not an instruction the Agent submits. The compiler derives it
 *  once from compile inputs and committed facts and writes it into the
 *  PromptArtifact; every prompt-bearing MCP response projects it from that
 *  artifact instead of re-deriving it.
 *
 *  This module is pure: no I/O, no policy, no randomness.
 */
/** Fixed priority:
 *  1. attempt > 1            → same_round_retry / enforcement_retry
 *  2. recovery boundary      → fresh_round / recovery_redo
 *  3. round 1, no prior      → fresh_round / first_round
 *  4. otherwise              → fresh_round / next_round
 */
export function derivePromptContextBoundary(input) {
    const attempt = Number.isFinite(input.attempt)
        ? Math.max(1, Math.trunc(input.attempt))
        : 1;
    if (attempt > 1) {
        return { mode: "same_round_retry", reason: "enforcement_retry" };
    }
    if (input.recoveryBoundary) {
        return { mode: "fresh_round", reason: "recovery_redo" };
    }
    if (input.round === 1 && !input.hasPreviousCommittedRound) {
        return { mode: "fresh_round", reason: "first_round" };
    }
    return { mode: "fresh_round", reason: "next_round" };
}
//# sourceMappingURL=context-boundary.js.map