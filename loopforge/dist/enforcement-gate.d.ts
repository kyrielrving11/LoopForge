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
import { type RoundProgress } from "./progress.js";
/** Scan backwards from currentRound to find the most recent clean round.
 *  Collects discovered_constraints from skipped rounds along the way.
 *  Returns null when no clean round is found within maxDepth. */
export declare function findSafeRestorePoint(currentRound: number, vaultEntries: VaultEntry[], maxDepth: number, 
/** v3.9.7: a candidate must have a materialized restore checkpoint. */
isEligible?: (round: number) => boolean): {
    round: number;
    skippedDiscoveries: string[];
} | null;
/** v3.8.1: the ONE Recovery Brief renderer.
 *
 *  v3.9.4: it is the shared fact renderer for the prompt's protected
 *  `recovery` section and the state file's Recent tier. The post-compile
 *  backtrack prompt (and its action advice) is gone: `committedBacktrackBrief`
 *  appends the restore HEAD/file set and the artifact is the delivered prompt.
 *  The facts are supplied by the caller from `decodeBacktrackRecord` on the
 *  committed decision. */
export declare function recoveryBriefLines(input: {
    /** v3.9.7: the first round of the child branch. The workspace was restored
     *  to the selected checkpoint BEFORE this prompt was compiled. */
    redoRound: number;
    checkpointId?: string;
    restoreVerified?: boolean;
    triggerRule: string;
    origin?: "agent" | "machine";
    /** Agent reason (agent origin) or machine failure reason. */
    reason?: string;
    /** v3.9.4: the enforcement gate's own sentence for WHY it rolled back. */
    failureReason?: string;
    failedRounds: string[] | number[];
    approaches: string[];
    wrongAssumptions: string[];
    preservedDiscoveries?: string[];
    recoveryRoundId?: string;
    maxApproaches?: number;
    maxAssumptions?: number;
}): string[];
export declare function enforceRound(selfEval: SelfEvaluation, verifyResult: VerificationResult, currentRound: number, vaultEntries: VaultEntry[], consecutiveRejections?: number, 
/** L4 (v3.7.x): which check rejected the PREVIOUS round. The coordinator
 *  resets consecutiveRejections to 1 whenever the check changes, so the
 *  counter only ever measures one check's streak — this field names that
 *  check and lets uniform rows escalate on THEIR OWN streak instead of
 *  inheriting an unrelated history. */
lastRejectionCheck?: string, 
/** v3.8.3: the coordinator has verified that this round declares itself
 *  blocked AND that its new contract proposal's scope covers every file the
 *  round changed outside the active contract's scope. Computed there, not
 *  here: neither the observations nor the active contract reach this
 *  function. See `enforceScopeDrift`. */
scopeDriftWaiver?: boolean, 
/** v3.9.7: the submitted round's provider-neutral progress. */
inFlightProgress?: RoundProgress): EnforcementResult;
/** Build the protected retry notice for the agent.
 *
 *  v3.9.7: this is a protocol fact, not a second task narrative. It carries
 *  the enforcement reason, the required fix and the same-round instruction.
 *  Findings are rendered exactly once by the mandatory Verification Gate; the
 *  original task/contract is rendered by Objective/Current Task. The notice
 *  never promises that an explanation will re-evaluate a machine fact.
 *
 * @param currentRound      The round number that was rejected (NOT incremented).
 * @param _task             Kept for the public signature; not rendered here.
 * @param enforceResult     The enforcement decision with reason and fix instructions.
 * @param _verificationFlags Kept for the public signature; findings render in
 *                          the mandatory Verification Gate. */
export declare function buildRejectionPrompt(currentRound: number, _task: string, enforceResult: EnforcementResult, _verificationFlags?: VerificationFlag[]): string;
//# sourceMappingURL=enforcement-gate.d.ts.map