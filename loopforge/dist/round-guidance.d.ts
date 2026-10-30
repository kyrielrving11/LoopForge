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
import type { PromptContextMode, PromptContextReason } from "./protocol.js";
export declare const ROUND_BOUNDARY_PRINCIPLE: string;
export declare const ROUND_BOUNDARY_SIZING: string;
export declare const ROUND_BOUNDARY_SUBMISSION: string;
export declare const ROUND_BOUNDARY_NON_BOUNDARIES: string;
/** v4.0.5: the ONE routing sentence for a lost in-context retry invocation.
 *  The prompt footer and the short retry guidance read it. LoopForge — not
 *  the Agent — recompiles the same round/attempt in clean context. */
export declare const ROUND_BOUNDARY_INVOCATION_LOST: string;
/** The host execution contract. It names the four context strategies instead
 *  of asking the host to reinterpret an enum value:
 *  clean context, in-context repair, clean-context repair, recovery redo. */
export declare const CONTEXT_CONTINUITY_RULES: string;
export type GuidanceDensity = "prompt" | "server";
/** Render the runtime guidance.
 *
 *  - `prompt` renders the boundary principle, sizing, submission and
 *    non-boundary rules. A `same_round_retry` already explained its single
 *    logical round in the retry section, so only submission and non-boundary
 *    rules are repeated. The fresh body is kept under ~480 characters so the
 *    L0 footer does not force a policy-budget change.
 *  - `server` renders the same rules plus the host context-continuity
 *    contract. */
export declare function renderRoundGuidance(density: GuidanceDensity, contextMode?: PromptContextMode): string;
/** Human-readable strategy label for one context boundary. JSON/artifacts keep
 *  the enum values; every human surface uses this ONE mapping.
 *
 *  `recoveryBoundary` means a committed rollback directive governs this
 *  compile. A repeated rejection can escalate a retried redo; the label must
 *  keep the recovery-lesson fact instead of dropping it. */
export declare function formatContextBoundaryLabel(mode: PromptContextMode, reason: PromptContextReason, options?: {
    recoveryBoundary?: boolean;
}): string;
//# sourceMappingURL=round-guidance.d.ts.map