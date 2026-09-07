/** Enforcement Gate — Layer 2 round-boundary runtime enforcement (v1.13).
 *
 * Pure-function module. Receives the verification gate's findings plus
 * round-level context and decides whether to accept the round, reject it
 * (force the agent to redo), or terminate the loop.
 *
 * This is the "runtime" that prompt-only constraint systems lack.
 * Verification gate detects WHAT is wrong; enforcement gate decides
 * what to DO about it.
 *
 * Decision semantics:
 * - accept:    round passes all checks; advance to next round as normal.
 * - reject:    agent's self-evaluation or round output is invalid; the
 *              agent receives a rejection prompt and must redo the SAME
 *              round. Round counter does NOT increment.
 * - terminate: loop has reached an unrecoverable state; stop immediately
 *              with stopReason "enforcement_terminated".
 */
import type { VaultEntry } from "./loop-store.js";
import type { EnforcementResult, SelfEvaluation, VerificationFlag, VerificationResult } from "./protocol.js";
/** Scan backwards from currentRound to find the most recent clean round.
 *  Collects discovered_constraints from skipped rounds along the way.
 *  Returns null when no clean round is found within maxDepth. */
export declare function findSafeRestorePoint(currentRound: number, vaultEntries: VaultEntry[], maxDepth: number): {
    round: number;
    skippedDiscoveries: string[];
} | null;
/** v2.12: Git HEAD commit hash at the restore point. Read from the restore
 *  round's committed transaction snapshot (after evidence preferred, before
 *  evidence as fallback). Returns null when the round has no git snapshot
 *  or no committed feedback entry. */
export declare function findBacktrackTargetGitHead(restoreRound: number, vaultEntries: VaultEntry[]): string | null;
/** Build the backtrack prompt injected at the top of the restored round.
 *
 *  v2.13: Includes concrete workspace restore instructions with affected
 *  file lists from skipped rounds. The agent must restore the working tree
 *  to the clean round's state before proceeding. */
export interface BacktrackRecoveryFacts {
    /** v3.7.1: Rolled-back rounds (restore point + 1 … trigger round). */
    failedRounds: number[];
    /** v3.7.1: One approach per failed round — what must NOT be repeated. */
    approaches: string[];
    /** v3.7.1: Falsified assumptions collected from the failed rounds. */
    wrongAssumptions: string[];
}
export declare function buildBacktrackPrompt(fromRound: number, toRound: number, triggerRule: string, skippedDiscoveries: string[],
/** v2.13: Files changed in the skipped rounds (from evidence snapshots).
 *  Used to show the agent exactly what needs to be reverted. */
skippedFiles?: string[],
/** v2.12: Git HEAD commit hash at the backtrack point (current HEAD).
 *  The agent must discard work back to the clean round's state. */
gitHead?: string,
/** v3.7.1: The redo submission's roundId (loop:<id>:round:<toRound+1>). */
recoveryRoundId?: string,
/** v3.7.1: Derived Recovery Brief facts — committed facts + the
 *  in-flight attempt only; never rejected payloads. */
recovery?: BacktrackRecoveryFacts): string;
export declare function enforceRound(selfEval: SelfEvaluation, verifyResult: VerificationResult, currentRound: number, vaultEntries: VaultEntry[], consecutiveRejections?: number,
/** v2.12: Current clarification streak for R7 escalation. */
driftClarificationStreak?: number,
/** L4 (v3.7.x): which check rejected the PREVIOUS round. The coordinator
 *  resets consecutiveRejections to 1 whenever the check changes, so the
 *  counter only ever measures one check's streak — this field names that
 *  check and lets uniform rows escalate on THEIR OWN streak instead of
 *  inheriting an unrelated history. */
lastRejectionCheck?: string): EnforcementResult;
/** Build a rejection prompt for the agent.
 *
 *  The prompt clearly states the round was rejected, why, what the agent
 *  must fix, and that the agent must redo the SAME round (not advance).
 *
 *  v2.7: Accepts verificationFlags to render a diagnostic "Evidence Gap"
 *  section. Each error/warn flag becomes a concrete claim-vs-evidence
 *  mismatch statement so the agent knows exactly what to correct rather
 *  than retrying blindly.
 *
 * @param currentRound      The round number that was rejected (NOT incremented).
 * @param task              The original loop task description.
 * @param enforceResult     The enforcement decision with reason and fix instructions.
 * @param verificationFlags The verification gate's findings for this round.
 *                          Used to build the Evidence Gap section. */
export declare function buildRejectionPrompt(currentRound: number, task: string, enforceResult: EnforcementResult, verificationFlags?: VerificationFlag[]): string;
//# sourceMappingURL=enforcement-gate.d.ts.map