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
 *
 * v3.7: every check belongs to one of four verification domains (CHECK_DOMAIN
 * below): evaluation consistency / evidence integrity / plan & contract /
 * progress & recovery. A domain describes a check's semantic job — it never
 * changes run order or verdict aggregation. Round Contract checks are further
 * framed as declaration / execution / closure stages in their doc comments.
 */
import type { VaultEntry } from "./loop-store.js";
import type { MachineObservation } from "./protocol.js";
import type { SelfEvaluation, VerificationResult } from "./protocol.js";
export declare const CHECK_SUCCESS_WITH_REMAINING_CRITERIA = "success_with_remaining_criteria";
export declare const CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE = "success_without_verified_evidence";
export declare const CHECK_OUTCOME_SUCCESS_CONTRADICTION = "outcome_success_contradiction";
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
export declare const CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED = "backtrack_workspace_not_restored";
export declare const CHECK_CRITERIA_CLAIMS_UNVERIFIED = "criteria_claims_unverified";
/** v3.8: Contract items claimed met but not machine-verified this round.
 *  The round commits; the debt is surfaced and the enforcement gate's
 *  verification-debt row handles a persistent pattern. */
export declare const CHECK_CONTRACT_ITEMS_UNVERIFIED = "contract_items_unverified";
/** The round's actual git changes include files outside the ACTIVE
 *  contract's declared scope. Warn; v3.8: not waivable by explanation — the
 *  enforcement gate rejects, and repeated drift terminates. */
export declare const CHECK_ROUND_SCOPE_DRIFT = "round_scope_drift";
/** v3.5: The ACTIVE contract is still open (not completed, not blocked)
 *  while a different contract was proposed — the proposal is ignored until
 *  the active one closes. Warn: the walker still ignores it; this only
 *  surfaces the otherwise-silent state. */
export declare const CHECK_CONTRACT_PREMATURE = "contract_premature";
/** v3.7.1: A cited gate (evaluation.gate_ids) is not approved. Opt-in:
 *  checked ONLY when policy.gate.enabled — citations are meaningless when
 *  the gate layer is off. Error → enforcement rejects the round. */
export declare const CHECK_USER_GATE_UNRESOLVED = "user_gate_unresolved";
export type VerificationDomain =
/** The declaration is self-consistent (and consistent with committed facts). */
"evaluation_consistency"
/** Machine evidence and the agent's claims about it. */
 | "evidence_integrity"
/** Plan conformance: intent/sub-goal drift (two detection bases under the
 *  "plan drift" label) and the Round Contract declaration/execution/closure
 *  checks. */
 | "plan_contract"
/** Workspace restore after backtrack. Machine-side progress enforcement
 *  (the stall evaluator) lives in the enforcement gate, not here. */
 | "progress_recovery";
export declare const CHECK_DOMAIN: Readonly<Record<string, VerificationDomain>>;
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
    /** Agent-reported tests_reported agree with a passed command's parsed stdout. */
    testsMachineBacked: boolean;
    /** Agent-reported files_changed equals the git diff set exactly. */
    reportedFilesMatch: boolean;
}
/** v3.2: Derive the machine-verification status of a round. The verification
 *  capability is modeled explicitly (verified / unavailable / absent) instead
 *  of letting evidence-dependent checks silently disappear when snapshots are
 *  missing — the fix for the "weakest when it matters most" gap. */
export declare function deriveEvidenceStatus(selfEval: SelfEvaluation, evidenceSnapshots: MachineObservation[]): EvidenceStatus;
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
export declare function verifySelfEvaluation(selfEval: SelfEvaluation, currentRound: number, vaultEntries: VaultEntry[], prevSelfEval?: SelfEvaluation | null, evidenceSnapshots?: MachineObservation[],
/** v2.13: Files from skipped backtrack rounds. If the agent's
 *  files_changed overlaps significantly with these, the workspace
 *  was not properly restored before working. */
backtrackSkippedFiles?: string[],
/** M3 (v3.7.x): skipped-file git fingerprints at their failed rounds —
 *  machine proof of "untouched since the rollback" for the restore check. */
backtrackSkippedFingerprints?: Record<string, string>,
/** v2.12: Git HEAD commit of the backtrack restore point. When set, the
 *  current git snapshot must sit at this commit — otherwise the workspace
 *  was not restored and the round cannot be accepted. */
backtrackTargetGitHead?: string,
/** v3.7.1: gate records (task_type gate_opened / gate_decision) live
 *  outside the round prefix — the caller passes them in explicitly. */
gateEntries?: VaultEntry[]): VerificationResult;
export {};
//# sourceMappingURL=verification-gate.d.ts.map