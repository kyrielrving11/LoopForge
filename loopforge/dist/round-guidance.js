/** v4.0.4 / v4.0.7: the ONE runtime source of round-boundary and
 *  context-continuity guidance.
 *
 *  The compiled prompt footer, the MCP server instructions, the tools/list
 *  `contextMode` description, the state file and the Explain view read these
 *  constants. The Forge skill keeps only the definitions and a pointer; it
 *  must not grow a second copy of the executable sizing rules.
 *
 *  `HOST_INVOCATION_CONTRACT` is server-density prose only: the per-round
 *  prompt footer carries the Agent action surface, not the host runtime
 *  contract. `CONTEXT_MODE_DESCRIPTION` is the ONE tools/list description.
 *
 *  This module is pure: no I/O, no policy, no time, no randomness.
 */
export const ROUND_BOUNDARY_PRINCIPLE = "One round is a work slice with before/after evidence, not file/token/commit " +
    "count.";
export const ROUND_BOUNDARY_SIZING = "Keep coupled work together; split when unsafe to verify.";
export const ROUND_BOUNDARY_SUBMISSION = "Agent chooses continuation via should_continue. A Round Contract scopes " +
    "bounded NEXT-round work and acceptance, not this round's end. Acceptance " +
    "commits; rejection retries the round (+1); maxRounds stops.";
export const ROUND_BOUNDARY_NON_BOUNDARIES = "Time, invocation/session/stage changes, redelivery, checkpoints, restores, " +
    "status, resume and unpause do not end rounds.";
/** v4.0.5: the ONE routing sentence for a lost in-context retry invocation.
 *  The prompt footer and the short retry guidance read it. LoopForge — not
 *  the Agent — recompiles the same round/attempt in clean context. */
export const ROUND_BOUNDARY_INVOCATION_LOST = "If the invocation that received the previous prompt is gone, call " +
    "loopforge_resume(loopId, invocationLost: true); LoopForge recompiles the " +
    "same logical round and attempt in clean context. Never carry this " +
    "in-context retry prompt into a new invocation.";
/** v4.0.7: the ONE host invocation contract. It separates the cleared model
 *  conversation from the warm host runtime and states what LoopForge does not
 *  manage. It is rendered at server density only; the per-round prompt footer
 *  does not repeat it. */
export const HOST_INVOCATION_CONTRACT = "Clean context starts a new model conversation, not a new host or tool " +
    "runtime: do not carry the previous model transcript, tool outputs or " +
    "uncommitted reasoning into it. Keep the same loopId, logical session and " +
    "modified workspace; a host process that stays alive may keep the MCP " +
    "connection and tool processes warm and the installed skill files " +
    "available, while the host holds the submissionHandle for tool calls. " +
    "A warm runtime is not model memory: the new conversation knows only what " +
    "this prompt and the host's stable environment provide. LoopForge does not " +
    "manage provider prompt/KV caches or implicit model habits and neither " +
    "clears nor relies on them. Only committed facts and the bounded " +
    "projections LoopForge returns for this invocation are guaranteed; " +
    "anything else that must survive belongs to explicit host configuration, " +
    "not a LoopForge fact.";
/** v4.0.7: the ONE tools/list description of PromptContextMode. tools.ts
 *  imports it so the wire description and the runtime prose cannot drift. */
export const CONTEXT_MODE_DESCRIPTION = "The derived context boundary of the returned prompt, projected from its " +
    "PromptArtifact. fresh_invocation starts a new model conversation, not a " +
    "host runtime: the previous model transcript, tool outputs and uncommitted " +
    "reasoning are not carried; the invocation keeps the same loopId, logical " +
    "session and workspace; a live host may keep its MCP connection, tool " +
    "processes and installed skill files warm. It covers first_round, " +
    "next_round, recovery_redo, rejection_escalation and invocation_recovery, " +
    "and may describe the SAME logical round. same_round_retry " +
    "(enforcement_retry) continues the original invocation below the repeated " +
    "same-check rejection threshold. Prompt density does not determine it. " +
    "LoopForge does not manage provider prompt/KV caches or implicit model " +
    "habits. Read contextReason for the specific case.";
/** The host execution contract. It names the four context strategies instead
 *  of asking the host to reinterpret an enum value:
 *  clean context, in-context repair, clean-context repair, recovery redo. */
export const CONTEXT_CONTINUITY_RULES = "A fresh invocation is not a new loop: reuse the same loopId and workspace. " +
    "It may carry the same logical round (an enforcement retry) or the next " +
    "round after the last commit; it is the context boundary, not the round " +
    "boundary. Clean context is not a workspace reset: the current modified " +
    "workspace continues; it exists to keep the round focused and avoid an " +
    "overloaded or misleading transcript. " +
    HOST_INVOCATION_CONTRACT + " " +
    "Prompt density does not choose the context boundary. Below the repeated " +
    "same-check rejection threshold, continue the original invocation and " +
    "inject the rejection notice, findings and failure reason. If that " +
    "invocation is gone, call loopforge_resume(loopId, invocationLost: true): " +
    "LoopForge recompiles the SAME round and attempt as a cold-context " +
    "invocation_recovery prompt; never reuse the in-context retry prompt in a " +
    "new model conversation. At the rejection escalation threshold, start a " +
    "clean model conversation with the retry notice, findings, rejected-attempt " +
    "posture and committed memory. That posture describes the rejected attempt, " +
    "not the current workspace; inspect the current workspace before acting. " +
    "A retry inside a recovered redo keeps its Recovery Brief. A held prompt, " +
    "checkpoint, restore, status, resume or unpause never advances or resets " +
    "the round. If the loopId or prompt is lost, use loopforge_status view=all " +
    "and loopforge_resume; do not call loopforge_start for an existing " +
    "objective. A stopped loop is terminal; resume does not reopen it.";
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
            return [
                ROUND_BOUNDARY_SUBMISSION,
                ROUND_BOUNDARY_NON_BOUNDARIES,
                ROUND_BOUNDARY_INVOCATION_LOST,
            ].join("\n");
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
    if (reason === "invocation_recovery") {
        return options.recoveryBoundary
            ? "clean context repair + invocation recovery + recovery retry " +
                "(fresh_invocation; invocation_recovery; same logical round; " +
                "retry and recovery lessons carried)"
            : "clean context repair + invocation recovery (fresh_invocation; " +
                "invocation_recovery; same logical round; retry lessons carried)";
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