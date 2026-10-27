/** The ONE agent-facing routing rule for a lost submission handle.
 *
 *  This is instruction copy, not state: it performs no I/O and is never
 *  persisted. The Agent decides whether the held prompt is still in context;
 *  LoopForge never inspects the caller's context. Status can re-anchor the
 *  current handle read-only; resume is the path that rebuilds a session and
 *  re-delivers the held prompt.
 *
 *  Kept intentionally short: prompt-assembler embeds it in a fixed footer and
 *  one test fixture uses a very tight L2 budget.
 */
export const LOST_HANDLE_ROUTING = "If only the submissionHandle was lost, call loopforge_status with the " +
    "live sessionId or loopId; it returns the current handle without the " +
    "prompt. If the prompt was also lost, or status reports no live session " +
    "or no handle, call loopforge_resume with the loopId.";
//# sourceMappingURL=recovery-guidance.js.map