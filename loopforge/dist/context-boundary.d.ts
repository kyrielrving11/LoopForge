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
import type { PromptContextMode, PromptContextReason } from "./protocol.js";
export interface ContextBoundaryInput {
    /** The logical round being compiled. */
    round: number;
    /** One-based attempt within the same logical round. */
    attempt: number;
    /** A committed rollback directive controls this round's redo. */
    recoveryBoundary: boolean;
    /** A committed evaluation round exists before this one. */
    hasPreviousCommittedRound: boolean;
}
export interface PromptContextBoundary {
    mode: PromptContextMode;
    reason: PromptContextReason;
}
/** Fixed priority:
 *  1. attempt > 1            → same_round_retry / enforcement_retry
 *  2. recovery boundary      → fresh_round / recovery_redo
 *  3. round 1, no prior      → fresh_round / first_round
 *  4. otherwise              → fresh_round / next_round
 */
export declare function derivePromptContextBoundary(input: ContextBoundaryInput): PromptContextBoundary;
//# sourceMappingURL=context-boundary.d.ts.map