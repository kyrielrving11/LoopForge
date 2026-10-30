/** v4.0.4: the ONE presentation of a round's result facts.
 *
 *  Three kinds of facts stay separate and always appear in this order:
 *    1. Agent report   — what the Agent claimed (never machine evidence).
 *    2. LoopForge decision — the disposition and the loop terminal reason.
 *    3. Machine evidence — the persisted EvidencePosture, rendered by the
 *       single `formatEvidencePostureLines` renderer.
 *
 *  This module derives nothing. It formats facts that were already committed
 *  or are already computed by the runtime; it never re-derives `completed`,
 *  `machineBackedSuccess` or a "conflict"/"verdict" boolean.
 */
import { formatEvidencePostureLines } from "./evidence-posture-view.js";
/** Neutral fact statements. They describe the committed trigger; they never
 *  restate "task success". */
const LOOP_STOP_REASON_FACTS = {
    completed: "Agent declared should_continue=false and the active contract was closed or absent.",
    failed: "Agent declared should_continue=false and the effective outcome was not success.",
    blocked: "Agent declared a blocked stop.",
    incomplete: "Agent stopped, but machine verification did not close the active contract " +
        "(or observations were insufficient).",
    max_rounds: "The configured maximum number of rounds was reached.",
    enforcement_terminated: "The enforcement gate terminated the loop.",
    stalled: "The next prompt could not be compiled; call loopforge_resume to retry.",
    cancelled: "The loop was cancelled manually.",
    paused: "Paused is a session status, not a committed loop terminal reason.",
};
function booleanText(value) {
    return value === null ? "not available" : String(value);
}
function outcomeText(facts) {
    if (facts.outcome === null)
        return "not available";
    if (facts.outcomeDeclared !== null)
        return `${facts.outcome} (declared)`;
    return `${facts.outcome} (derived; declared: none)`;
}
/** Render the three fact blocks. The caller owns any heading above them.
 *  `density` selects the shared posture renderer's compact form for terminal
 *  responses; it never changes the facts. */
export function renderResultFacts(facts, density) {
    const lines = ["Agent report"];
    if (!facts.agent) {
        const rollback = facts.loopforge.action === "backtrack" ||
            facts.loopforge.action === "recovery";
        lines.push(`  none (${rollback ? "rollback directive" : "no evaluation"})`);
    }
    else {
        lines.push(`  success_claim: ${booleanText(facts.agent.successClaim)}`);
        lines.push(`  outcome: ${outcomeText(facts.agent)}`);
        lines.push(`  should_continue: ${booleanText(facts.agent.shouldContinue)}`);
        lines.push(`  agent_stop_reason: ${facts.agent.agentStopReason ?? "none"}`);
    }
    lines.push("", "LoopForge decision");
    lines.push(`  action: ${facts.loopforge.action}`);
    if (facts.loopforge.loopStopReason === null) {
        lines.push("  loop_stop_reason: none");
    }
    else {
        lines.push(`  loop_stop_reason: ${facts.loopforge.loopStopReason}`);
        lines.push(`    ${LOOP_STOP_REASON_FACTS[facts.loopforge.loopStopReason]}`);
    }
    lines.push(`  enforcement_reason: ${facts.loopforge.enforcementReason ?? "none"}`);
    lines.push("", facts.machine.committed
        ? "Machine evidence"
        : "Machine evidence (transient; not committed)");
    if (!facts.machine.posture) {
        // Never render a null posture as `machine_backed_success: false`: absence
        // of a committed posture is not a machine denial.
        lines.push("  not available in this projection");
    }
    else {
        // The ONE posture renderer supplies the content; this formatter only
        // aligns it under the block heading.
        lines.push(...formatEvidencePostureLines(facts.machine.posture, {
            compact: density === "terminal",
        }).map((line) => `  ${line}`));
    }
    return lines;
}
//# sourceMappingURL=result-facts.js.map