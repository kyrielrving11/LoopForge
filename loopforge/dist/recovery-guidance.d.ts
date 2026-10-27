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
export declare const LOST_HANDLE_ROUTING: string;
//# sourceMappingURL=recovery-guidance.d.ts.map