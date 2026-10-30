/** v4.0.4: the ONE runtime source of round-boundary and context-continuity
 *  guidance.
 *
 *  The compiled prompt footer, the MCP server instructions, the state file and
 *  the Explain view read these constants. The Forge skill keeps only the
 *  definitions and a pointer; it must not grow a second copy of the executable
 *  sizing rules.
 *
 *  This module is pure: no I/O, no policy, no time, no randomness.
 */
export const ROUND_BOUNDARY_PRINCIPLE = "A round is one coherent work slice with one before/after evidence " +
    "boundary, not a file/token/commit count.";
export const ROUND_BOUNDARY_SIZING = "Keep tightly coupled work together; split when uncertainty or rollback " +
    "risk makes it unsafe to verify.";
export const ROUND_BOUNDARY_SUBMISSION = "Submit at a completion, decision point or blocker; only acceptance " +
    "commits the round, a rejection keeps it (+1 attempt).";
export const ROUND_BOUNDARY_NON_BOUNDARIES = "Time, a new invocation/session/stage, a re-delivered prompt, checkpoint, " +
    "restore, status, resume or unpause is not a boundary.";
/** The host execution contract. It names the four context strategies instead
 *  of asking the host to reinterpret an enum value:
 *  clean context, in-context repair, clean-context repair, recovery redo. */
export const CONTEXT_CONTINUITY_RULES = "A fresh invocation is not a new loop: reuse the same loopId and workspace. " +
    "It may carry the same logical round (an enforcement retry) or the next " +
    "round after the last commit; it is the context boundary, not the round " +
    "boundary. Clean context is not a workspace reset: the current modified " +
    "workspace continues, while the previous transcript, tool logs and " +
    "uncommitted reasoning do not; it exists to keep the round focused and " +
    "avoid an overloaded or misleading transcript. Start a new invocation, and " +
    "carry only the prompt, loopId, session and the committed facts, bounded " +
    "Working Memory, Machine Evidence and failure lessons it contains. Prompt " +
    "density does not choose the context boundary. Below the repeated " +
    "same-check rejection threshold, continue the original invocation and " +
    "inject the rejection notice, findings and failure reason; if it is gone, " +
    "start a new invocation from the self-contained prompt but keep the same " +
    "round and attempt. At the rejection escalation threshold, start a clean " +
    "invocation with the retry notice, findings, rejected-attempt posture and " +
    "committed memory. That posture describes the rejected attempt, not the " +
    "current workspace; inspect the current workspace before acting. A retry " +
    "inside a recovered redo keeps its Recovery Brief. A held prompt, " +
    "checkpoint, restore, " +
    "status, resume or unpause never advances or resets the round. If the " +
    "loopId or prompt is lost, use loopforge_status view=all and " +
    "loopforge_resume; do not call loopforge_start for an existing objective. " +
    "A stopped loop is terminal; resume does not reopen it.";
/** Render the runtime guidance.
 *
 *  - `prompt` renders the boundary principle, sizing, submission and
 *    non-boundary rules. A `same_round_retry` already explained its single
 *    logical round in the retry section, so only submission and non-boundary
 *    rules are repeated. The fresh body is kept under ~480 characters so the
 *    L0 footer does not force a policy-budget change.
 *  - `server` renders the same rules plus the host context-continuity
 *    contract. */
export function renderRoundGuidance(density, contextMode) {
    if (density === "prompt") {
        if (contextMode === "same_round_retry") {
            return [ROUND_BOUNDARY_SUBMISSION, ROUND_BOUNDARY_NON_BOUNDARIES]
                .join("\n");
        }
        return [
            ROUND_BOUNDARY_PRINCIPLE,
            ROUND_BOUNDARY_SIZING,
            ROUND_BOUNDARY_SUBMISSION,
            ROUND_BOUNDARY_NON_BOUNDARIES,
        ].join("\n");
    }
    return [
        ROUND_BOUNDARY_PRINCIPLE,
        ROUND_BOUNDARY_SIZING,
        ROUND_BOUNDARY_SUBMISSION,
        ROUND_BOUNDARY_NON_BOUNDARIES,
        CONTEXT_CONTINUITY_RULES,
    ].join("\n");
}
/** Human-readable strategy label for one context boundary. JSON/artifacts keep
 *  the enum values; every human surface uses this ONE mapping.
 *
 *  `recoveryBoundary` means a committed rollback directive governs this
 *  compile. A repeated rejection can escalate a retried redo; the label must
 *  keep the recovery-lesson fact instead of dropping it. */
export function formatContextBoundaryLabel(mode, reason, options = {}) {
    if (mode === "same_round_retry") {
        return "in-context repair (same_round_retry; enforcement_retry; continue " +
            "original invocation if alive; lessons injected)";
    }
    if (reason === "rejection_escalation") {
        return options.recoveryBoundary
            ? "clean context repair + recovery retry (fresh_invocation; " +
                "rejection_escalation; recovery lessons carried)"
            : "clean context repair (fresh_invocation; rejection_escalation; same " +
                "logical round; rejected posture is attempt-time only)";
    }
    if (reason === "enforcement_retry") {
        return options.recoveryBoundary
            ? "clean context repair + recovery retry (fresh_invocation; " +
                "enforcement_retry; recovery lessons carried)"
            : "clean context repair (fresh_invocation; enforcement_retry; same " +
                "logical round; lessons carried)";
    }
    if (reason === "recovery_redo") {
        return "clean context after restore (fresh_invocation; recovery_redo; " +
            "lessons carried)";
    }
    if (reason === "first_round") {
        return "clean context — first round (fresh_invocation)";
    }
    return "clean context — next round (fresh_invocation; workspace continues)";
}
//# sourceMappingURL=round-guidance.js.map