/** Verification Gate — Layer 1 cross-round consistency checks.
 *
 * Pure-function module. Validates an agent's SelfEvaluation against the
 * loop's own lineage before it enters the compiler.
 *
 * Verdict semantics:
 * - trusted:      all checks passed; flags are informational only.
 * - suspect:      one or more warn-level flags; flags become warnings in
 *                 the next prompt so the agent can clarify.
 * - contradicted: one or more error-level flags; the quality score for
 *                 this round is excluded from the quality trend (NOT
 *                 modified). Flags become hard constraints — the agent
 *                 must respond in the next round.
 */
import type { VaultEntry } from "./backends/interface.js";
import type { SelfEvaluation, VerificationResult } from "./protocol.js";
/** Verify a SelfEvaluation against the loop's cross-round lineage.
 *
 * @param selfEval      The agent's self-evaluation for the current round.
 * @param currentRound  The current round number (1-based).
 * @param vaultEntries  Vault entries for this loop (non-feedback only).
 * @param prevSelfEval  The agent's self-evaluation from the previous round
 *                      (null for round 1).
 */
export declare function verifySelfEvaluation(selfEval: SelfEvaluation, currentRound: number, vaultEntries: VaultEntry[], prevSelfEval?: SelfEvaluation | null): VerificationResult;
//# sourceMappingURL=verification-gate.d.ts.map