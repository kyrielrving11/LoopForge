/** Verification Gate — Layer 1 cross-round consistency checks.
 *
 * Pure-function module. Validates an agent's SelfEvaluation against the
 * loop's own lineage before it enters the compiler.
 *
 * Verdict semantics:
 * - trusted:      all checks passed; flags are informational only.
 * - suspect:      one or more warn-level flags; flags become warnings in
 *                 the next prompt so the agent can clarify.
 * - contradicted: one or more error-level flags; the success flag for
 *                 this round is excluded from the success trend (NOT
 *                 modified). Flags become hard constraints — the agent
 *                 must respond in the next round.
 */
import type { VaultEntry } from "./loop-store.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type { SelfEvaluation, VerificationResult } from "./protocol.js";
export declare const CHECK_PROGRESS_REGRESSION = "progress_regression";
export declare const CHECK_EMPTY_CHANGE_WITH_PASSING = "empty_change_with_passing";
export declare const CHECK_SUCCESS_WITH_REMAINING_CRITERIA = "success_with_remaining_criteria";
export declare const CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE = "success_without_verified_evidence";
export declare const CHECK_OUTCOME_SUCCESS_CONTRADICTION = "outcome_success_contradiction";
export declare const CHECK_SUCCESS_CLAIM_CONFLICT = "success_claim_conflict";
export declare const CHECK_BLOCKED_WITHOUT_BLOCKER = "blocked_without_blocker";
export declare const CHECK_RETROACTIVE_CLAIM_BAD_ROUND = "retroactive_claim_bad_round";
export declare const CHECK_RETROACTIVE_CLAIM_UNVERIFIED = "retroactive_claim_unverified";
export declare const CHECK_DUPLICATE_CONSTRAINT_DISCOVERY = "duplicate_constraint_discovery";
export declare const CHECK_RECURRING_VIOLATION = "recurring_violation";
export declare const CHECK_RETRACT_FRESH_CONSTRAINT = "retract_fresh_constraint";
export declare const CHECK_EVIDENCE_INTEGRITY = "evidence_integrity";
export declare const CHECK_REQUIRED_COMMAND_FAILED = "required_command_failed";
export declare const CHECK_COMMAND_EVIDENCE_MISMATCH = "command_evidence_mismatch";
/** v3.3: Verification domain integrity — a command entrypoint (run-tests.sh,
 *  package.json, …) changed in the same round the command ran. The runtime
 *  executed a script the agent just rewrote, so the observation has no
 *  stable baseline: error. Test-file changes are normal dev activity (TDD):
 *  warn-only, see CHECK_TEST_FILES_MODIFIED. */
export declare const CHECK_VERIFICATION_ENTRYPOINT_MODIFIED = "verification_entrypoint_modified";
/** v3.3: Test files changed in the same round a verification command passed.
 *  Warn-only — the command result stays usable. */
export declare const CHECK_TEST_FILES_MODIFIED = "test_files_modified";
export declare const CHECK_INTENT_DRIFT = "intent_drift";
export declare const CHECK_SUBGOAL_DRIFT = "subgoal_drift";
export declare const CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED = "backtrack_workspace_not_restored";
export declare const CHECK_CRITERIA_CLAIMS_UNVERIFIED = "criteria_claims_unverified";
/** Contract proposed with an empty done_when — nothing is promised, so
 *  nothing can be verified at the boundary. Warn: the contract can be fixed
 *  by re-declaring next round. */
export declare const CHECK_ROUND_UNDERSPECIFIED = "round_underspecified";
/** done_when items exist but verification_plan is empty or names commands
 *  that are not configured AND enabled in policy.evidence.commands — the
 *  completion claims could never be machine-checked. Warn. */
export declare const CHECK_ROUND_UNVERIFIABLE = "round_unverifiable";
/** The round's actual git changes include files outside the ACTIVE
 *  contract's declared scope. Warn + drift_clarification exemption
 *  (R7-style). */
export declare const CHECK_ROUND_SCOPE_DRIFT = "round_scope_drift";
/** success claimed under the ACTIVE contract whose done_when items are
 *  either claimed met without machine-verified evidence or silently dropped
 *  (not in success_criteria_met NOR success_criteria_remaining). Error. */
export declare const CHECK_PREMATURE_BOUNDARY = "premature_boundary";
/** v3.5: Closing a Round Contract is a success-class claim and must be
 *  machine-backed. The eval's met claims satisfy every done_when of the
 *  ACTIVE contract but its verification_plan commands did not pass this
 *  round. Error; warn under evidence.machine_backed_success "warn"; never
 *  downgraded by no_change_reason (all done_when met contradicts "no
 *  change"). Fail-open: plan names no longer configured+enabled are not
 *  required (cannot observe). */
export declare const CHECK_CONTRACT_COMPLETION_UNVERIFIED = "contract_completion_unverified";
/** v3.5: The ACTIVE contract is still open (not completed, not blocked)
 *  while a different contract was proposed — the proposal is ignored until
 *  the active one closes. Warn: the walker still ignores it; this only
 *  surfaces the otherwise-silent state. */
export declare const CHECK_CONTRACT_PREMATURE = "contract_premature";
/** Extract the round number from a vault entry's loop_lineage.
 *  Returns 0 if the entry has no lineage or no round field.
 *  In practice, persistLoopLineage always writes round ≥ 1, so 0
 *  unambiguously means "not a valid round entry" in this context.
 *  Exported for reuse by enforcement-gate.ts. */
export declare function entryRound(entry: VaultEntry): number;
/** Normalize a contract scope entry: backslashes → forward slashes, strip
 *  leading "./", trim, strip trailing slashes. "." / "./" / "" normalize to
 *  "" = the repository root (everything is in scope). */
export declare function normalizeScopeEntry(path: string): string;
/** Whether a git-diff file path falls inside any declared scope entry:
 *  exact file match, or the file lives under a declared directory. The ""
 *  entry (repo root) matches everything. Git paths are always workspace-
 *  relative with forward slashes. */
export declare function isFileInScope(file: string, scope: string[]): boolean;
/** Git-diff files outside the declared scope (the round_scope_drift signal). */
export declare function collectOutOfScopeFiles(files: string[], scope: string[]): string[];
export interface EvidenceStatus {
    /** Whether this round produced a machine-verified observation. */
    providerStatus: "verified" | "unavailable" | "absent";
    /** Git snapshot exists and diffed file changes this round. */
    gitObserved: boolean;
    /** A passed after-phase command snapshot exists. */
    commandVerified: boolean;
    /** Agent-reported test_results agree with a passed command's parsed stdout. */
    testsMachineBacked: boolean;
    /** Agent-reported files_changed equals the git diff set exactly. */
    reportedFilesMatch: boolean;
}
/** v3.2: Derive the machine-verification status of a round. The verification
 *  capability is modeled explicitly (verified / unavailable / absent) instead
 *  of letting evidence-dependent checks silently disappear when snapshots are
 *  missing — the fix for the "weakest when it matters most" gap. */
export declare function deriveEvidenceStatus(selfEval: SelfEvaluation, evidenceSnapshots: ProviderSnapshot[]): EvidenceStatus;
/** Per-round machine progress over decoded committed history. */
export declare function machineProgressSeries(vaultEntries: VaultEntry[], currentRound: number, lookback: number): boolean[] | null;
interface ParsedTestCounts {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
}
/** Best-effort parse of test counts from common test-runner output formats.
 *
 *  Scans the last 2000 characters of stdout (where summary lines typically
 *  appear) and tries patterns in descending specificity order. Returns null
 *  when the output format is unrecognized, stdout is empty, or a confident
 *  parse cannot be made.
 *
 *  Recognized formats: Jest verbose/compact, Mocha, pytest/unittest, Go test,
 *  and PHPUnit OK summaries. */
export declare function parseTestOutput(stdout: string): ParsedTestCounts | null;
/** Verify a SelfEvaluation against the loop's cross-round lineage.
 *
 * @param selfEval             The agent's self-evaluation for the current round.
 * @param currentRound         The current round number (1-based).
 * @param vaultEntries         Vault entries for this loop (committed lineage
 *                             entries AND :feedback entries — the feedback
 *                             entries feed the ACTIVE-contract derivation).
 * @param prevSelfEval         The agent's self-evaluation from the previous round
 *                             (null for round 1).
 * @param evidenceSnapshots    v1.18: Evidence snapshots from configured providers.
 *                             Used by checkEvidenceIntegrity for multi-provider
 *                             cross-validation. Defaults to empty array. */
export declare function verifySelfEvaluation(selfEval: SelfEvaluation, currentRound: number, vaultEntries: VaultEntry[], prevSelfEval?: SelfEvaluation | null, evidenceSnapshots?: ProviderSnapshot[], 
/** v2.13: Files from skipped backtrack rounds. If the agent's
 *  files_changed overlaps significantly with these, the workspace
 *  was not properly restored before working. */
backtrackSkippedFiles?: string[], 
/** v2.12: Git HEAD commit of the backtrack restore point. When set, the
 *  current git snapshot must sit at this commit — otherwise the workspace
 *  was not restored and the round cannot be accepted. */
backtrackTargetGitHead?: string): VerificationResult;
export {};
//# sourceMappingURL=verification-gate.d.ts.map