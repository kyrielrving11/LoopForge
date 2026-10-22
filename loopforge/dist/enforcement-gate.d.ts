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
/** v2.12: The restore point's machine snapshot. `head` is the commit the
 *  workspace must return to; `dirtyFiles` is what was ALREADY dirty there —
 *  the baseline a restored workspace is compared against, so unrelated work
 *  in progress is never mistaken for a failed restore. Read from the restore
 *  round's committed transaction snapshot (after evidence preferred, before
 *  evidence as fallback). Returns null when the round has no git snapshot or
 *  no committed feedback entry. */
export interface BacktrackTargetSnapshot {
    head: string;
    dirtyFiles: string[];
    fingerprints: Record<string, string>;
}
export declare function findBacktrackTargetSnapshot(restoreRound: number, vaultEntries: VaultEntry[]): BacktrackTargetSnapshot | null;
/** v3.8.1: the ONE Recovery Brief renderer.
 *
 *  v3.9.4: it is the shared fact renderer for the prompt's protected
 *  `recovery` section and the state file's Recent tier. The post-compile
 *  backtrack prompt (and its action advice) is gone: `committedBacktrackBrief`
 *  appends the restore HEAD/file set and the artifact is the delivered prompt.
 *  The facts are supplied by the caller from `decodeBacktrackRecord` on the
 *  committed decision. */
export declare function recoveryBriefLines(input: {
    target: number;
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
/** v3.9: the submitted round's own Git motion — see `inFlightGitMotion`.
 *  null when no Git observation was made. */
inFlightMotion?: boolean | null): EnforcementResult;
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