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
import { getPolicy, isConfiguredCommand } from "./policy.js";
import type { RoundContract, SelfEvaluation, VerificationFlag, VerificationResult } from "./protocol.js";
import { makeVerificationFlag, makeVerificationResult } from "./protocol.js";
import { jaccardSimilarity, tokenize, entryRound as sharedEntryRound, isRecord, machineGitMotionSeries } from "./token-utils.js";
import { computeGoalTextHash, deriveSubGoalId, criteriaMatch } from "./loop-compiler.js";
import {
  committedContractRounds,
  contractDoneWhenSatisfied,
  contractItemMatches,
  deriveActiveRoundContract,
} from "./round-contract.js";
import { stableStringify } from "./canonical-state.js";
import { deriveClaimView, resolveRoundFiles, type ClaimView } from "./evidence-claims.js";
import { effectiveSuccess, parseRoundContract } from "./self-eval.js";

// ═══════════════════════════════════════════════════════════════════════════
// v2.12: Check-name constants — single source of truth so the enforcement
// gate and audit can reference checks without string-literal drift.
// ═══════════════════════════════════════════════════════════════════════════

export const CHECK_PROGRESS_REGRESSION = "progress_regression";
export const CHECK_EMPTY_CHANGE_WITH_PASSING = "empty_change_with_passing";
export const CHECK_SUCCESS_WITH_REMAINING_CRITERIA = "success_with_remaining_criteria";
export const CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE = "success_without_verified_evidence";
export const CHECK_OUTCOME_SUCCESS_CONTRADICTION = "outcome_success_contradiction";
export const CHECK_SUCCESS_CLAIM_CONFLICT = "success_claim_conflict";
export const CHECK_BLOCKED_WITHOUT_BLOCKER = "blocked_without_blocker";
export const CHECK_RETROACTIVE_CLAIM_BAD_ROUND = "retroactive_claim_bad_round";
export const CHECK_RETROACTIVE_CLAIM_UNVERIFIED = "retroactive_claim_unverified";
export const CHECK_DUPLICATE_CONSTRAINT_DISCOVERY = "duplicate_constraint_discovery";
export const CHECK_RECURRING_VIOLATION = "recurring_violation";
export const CHECK_RETRACT_FRESH_CONSTRAINT = "retract_fresh_constraint";
export const CHECK_EVIDENCE_INTEGRITY = "evidence_integrity";
export const CHECK_REQUIRED_COMMAND_FAILED = "required_command_failed";
export const CHECK_COMMAND_EVIDENCE_MISMATCH = "command_evidence_mismatch";
/** v3.3: Verification domain integrity — a command entrypoint (run-tests.sh,
 *  package.json, …) changed in the same round the command ran. The runtime
 *  executed a script the agent just rewrote, so the observation has no
 *  stable baseline: error. Test-file changes are normal dev activity (TDD):
 *  warn-only, see CHECK_TEST_FILES_MODIFIED. */
export const CHECK_VERIFICATION_ENTRYPOINT_MODIFIED = "verification_entrypoint_modified";
/** v3.3: Test files changed in the same round a verification command passed.
 *  Warn-only — the command result stays usable. */
export const CHECK_TEST_FILES_MODIFIED = "test_files_modified";
export const CHECK_INTENT_DRIFT = "intent_drift";
export const CHECK_SUBGOAL_DRIFT = "subgoal_drift";
export const CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED = "backtrack_workspace_not_restored";
export const CHECK_CRITERIA_CLAIMS_UNVERIFIED = "criteria_claims_unverified";
/** v3.2: success declared with no machine-verified observation this round
 *  (providerStatus ≠ verified). Warn-level: the round still commits, but its
 *  success never enters the trajectory and trust drops. */
export const CHECK_SUCCESS_UNVERIFIED = "success_unverified";
// v3.3 — Round Contract checks. v3.4: split by target. The submission's own
// round_contract is a PROPOSAL for the NEXT round and is checked only
// structurally at declaration (underspecified / unverifiable). Execution
// conformance (scope drift / premature boundary) targets the ACTIVE
// contract — the contract the round actually executed under, derived from
// the committed evals of earlier rounds (round-contract.ts). All checks are
// silent when their target is absent: contract-less rounds behave exactly
// as before these checks existed, and round 1 (no committed rounds → no
// active contract) never produces declaration off-by-one noise.
/** Contract proposed with an empty done_when — nothing is promised, so
 *  nothing can be verified at the boundary. Warn: the contract can be fixed
 *  by re-declaring next round. */
export const CHECK_ROUND_UNDERSPECIFIED = "round_underspecified";
/** done_when items exist but verification_plan is empty or names commands
 *  that are not configured AND enabled in policy.evidence.commands — the
 *  completion claims could never be machine-checked. Warn. */
export const CHECK_ROUND_UNVERIFIABLE = "round_unverifiable";
/** The round's actual git changes include files outside the ACTIVE
 *  contract's declared scope. Warn + drift_clarification exemption
 *  (R7-style). */
export const CHECK_ROUND_SCOPE_DRIFT = "round_scope_drift";
/** success claimed under the ACTIVE contract whose done_when items are
 *  either claimed met without machine-verified evidence or silently dropped
 *  (not in success_criteria_met NOR success_criteria_remaining). Error. */
export const CHECK_PREMATURE_BOUNDARY = "premature_boundary";
/** v3.5: Closing a Round Contract is a success-class claim and must be
 *  machine-backed. The eval's met claims satisfy every done_when of the
 *  ACTIVE contract but its verification_plan commands did not pass this
 *  round. Error; warn under evidence.machine_backed_success "warn"; never
 *  downgraded by no_change_reason (all done_when met contradicts "no
 *  change"). Fail-open: plan names no longer configured+enabled are not
 *  required (cannot observe). */
export const CHECK_CONTRACT_COMPLETION_UNVERIFIED = "contract_completion_unverified";
/** v3.5: The ACTIVE contract is still open (not completed, not blocked)
 *  while a different contract was proposed — the proposal is ignored until
 *  the active one closes. Warn: the walker still ignores it; this only
 *  surfaces the otherwise-silent state. */
export const CHECK_CONTRACT_PREMATURE = "contract_premature";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Extract the round number from a vault entry's loop_lineage.
 *  Returns 0 if the entry has no lineage or no round field.
 *  In practice, persistLoopLineage always writes round ≥ 1, so 0
 *  unambiguously means "not a valid round entry" in this context.
 *  Exported for reuse by enforcement-gate.ts. */
export function entryRound(entry: VaultEntry): number {
  return sharedEntryRound(entry as unknown as Record<string, unknown>);
}

/** Read constraint_violations from a vault entry (entry-level, stored from
 *  the previous round's last_round_result at persist time). */
function entryViolations(entry: VaultEntry): string[] {
  const viols = entry.constraint_violations;
  if (Array.isArray(viols)) return viols.filter((v: unknown) => typeof v === "string");
  return [];
}

// ── v3.3: Round Contract scope matching ─────────────────────────────────────

/** Normalize a contract scope entry: backslashes → forward slashes, strip
 *  leading "./", trim, strip trailing slashes. "." / "./" / "" normalize to
 *  "" = the repository root (everything is in scope). */
export function normalizeScopeEntry(path: string): string {
  let s = path.replace(/\\/g, "/").trim();
  while (s.startsWith("./")) s = s.slice(2);
  if (s === "." || s === "") return "";
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Whether a git-diff file path falls inside any declared scope entry:
 *  exact file match, or the file lives under a declared directory. The ""
 *  entry (repo root) matches everything. Git paths are always workspace-
 *  relative with forward slashes. */
export function isFileInScope(file: string, scope: string[]): boolean {
  const normalizedFile = normalizeScopeEntry(file);
  for (const entry of scope) {
    const normalized = normalizeScopeEntry(entry);
    if (normalized === "" || normalizedFile === normalized ||
        normalizedFile.startsWith(normalized + "/")) {
      return true;
    }
  }
  return false;
}

/** Git-diff files outside the declared scope (the round_scope_drift signal). */
export function collectOutOfScopeFiles(files: string[], scope: string[]): string[] {
  return files.filter((file) => !isFileInScope(file, scope));
}

// ═══════════════════════════════════════════════════════════════════════════
// v3.2: Runtime evidence status — the machine-verification capability model.
// Derived from the already-collected provider snapshots (diffSnapshotCollections
// output) plus the agent's own claims; the agent supplies NO new fields.
// ═══════════════════════════════════════════════════════════════════════════

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

/** v3.3: Detect verification-domain tampering for a command snapshot.
 *  entrypointModified — a workspace file the command depends on
 *  (snapshot.data.entrypointFiles) changed this round: the runtime executed
 *  a script the agent just rewrote, so the "machine observation" has no
 *  stable baseline. testFilesModified — the round changed test files
 *  (isTestFile): normal in TDD, so warn-only; the command result stays
 *  usable. Pure snapshot derivation — no fs access (this module is pure). */
function commandTampered(
  snapshot: ProviderSnapshot,
  gitSnapshot: ProviderSnapshot | null,
): { entrypointModified: boolean; testFilesModified: boolean } {
  if (!gitSnapshot) return { entrypointModified: false, testFilesModified: false };
  const gitFiles = new Set(gitSnapshot.files);
  const entrypoints = isRecord(snapshot.data) &&
    Array.isArray(snapshot.data.entrypointFiles)
    ? snapshot.data.entrypointFiles.filter((f): f is string => typeof f === "string")
    : [];
  const entrypointModified = entrypoints.some((file) => gitFiles.has(file));
  const testFilesModified = [...gitFiles].some((file) => isTestFile(file));
  return { entrypointModified, testFilesModified };
}

function passedAfterCommand(snapshots: ProviderSnapshot[]): ProviderSnapshot | null {
  const git = snapshots.find((snapshot) => snapshot.provider === "git") ?? null;
  return snapshots.find((snapshot) =>
    isRecord(snapshot.data) &&
    snapshot.data.kind === "command" &&
    snapshot.data.phase === "after" &&
    snapshot.data.status === "passed" &&
    // v3.3: a command whose entrypoint changed this round is not machine
    // evidence — exclude it so providerStatus degrades to unavailable.
    !commandTampered(snapshot, git).entrypointModified) ?? null;
}

/** v3.5: Names of commands observed passing in the after-phase this round.
 *  Tampered commands (entrypoint changed this round) are not machine
 *  evidence and are excluded — the same rule passedAfterCommand applies. */
function passedPlanCommandNames(snapshots: ProviderSnapshot[]): Set<string> {
  const git = snapshots.find((snapshot) => snapshot.provider === "git") ?? null;
  const names = new Set<string>();
  for (const snapshot of snapshots) {
    if (!isRecord(snapshot.data)) continue;
    if (snapshot.data.kind !== "command") continue;
    if (snapshot.data.phase !== "after" || snapshot.data.status !== "passed") continue;
    if (commandTampered(snapshot, git).entrypointModified) continue;
    const name = snapshot.data.commandName;
    if (typeof name === "string" && name.length > 0) names.add(name);
  }
  return names;
}

/** v3.2: Derive the machine-verification status of a round. The verification
 *  capability is modeled explicitly (verified / unavailable / absent) instead
 *  of letting evidence-dependent checks silently disappear when snapshots are
 *  missing — the fix for the "weakest when it matters most" gap. */
export function deriveEvidenceStatus(
  selfEval: SelfEvaluation,
  evidenceSnapshots: ProviderSnapshot[],
): EvidenceStatus {
  const gitSnap = evidenceSnapshots.find((snapshot) => snapshot.provider === "git") ?? null;
  const gitObserved = gitSnap !== null && gitSnap.files.length > 0;
  const command = passedAfterCommand(evidenceSnapshots);
  const commandVerified = command !== null;

  // testsMachineBacked: agent-reported test_results agree with a passed
  // command's parsed stdout (the same comparison checkCommandEvidenceIntegrity
  // performs — parseTestOutput lives in this module).
  let testsMachineBacked = false;
  const reported = selfEval.execution_evidence?.test_results;
  if (command && reported) {
    const parsed = parseTestOutput(String(command.data.stdout ?? ""));
    testsMachineBacked = parsed !== null &&
      parsed.passed === reported.passed &&
      parsed.failed === reported.failed &&
      parsed.skipped === reported.skipped;
  }

  // reportedFilesMatch: agent-reported files_changed equals the git diff set.
  let reportedFilesMatch = false;
  if (gitSnap && selfEval.execution_evidence) {
    const reportedSet = [...selfEval.execution_evidence.files_changed].sort();
    const actualSet = [...gitSnap.files].sort();
    reportedFilesMatch = reportedSet.length === actualSet.length &&
      reportedSet.every((file, index) => file === actualSet[index]);
  }

  // v3.3: git observation alone is no longer "verified" — the machine seeing
  // file changes is not the machine verifying success. Only a passed
  // after-phase command (observed by the runtime itself) upgrades a round.
  // Any other snapshot presence is "unavailable": the machine saw activity
  // (or nothing at all this round) but could not verify the success claim,
  // so success_unverified warns and trust drops.
  const providerStatus: EvidenceStatus["providerStatus"] = evidenceSnapshots.length === 0
    ? "absent"
    : commandVerified
      ? "verified"
      : "unavailable";

  return {
    providerStatus,
    gitObserved,
    commandVerified,
    testsMachineBacked,
    reportedFilesMatch,
  };
}

/** v3.2: Per-round machine progress — whether git observed file changes in
 *  each of the last `lookback` committed rounds, rebuilt from the feedback
 *  entries' roundEvidence snapshots (already persisted at commit). Returns
 *  null when fewer than `lookback` rounds carry git snapshots — the machine
 *  signal is unavailable and callers (R4/R5) keep their legacy verdict.
 *  v3.3: implementation moved to token-utils (machineGitMotionSeries) so the
 *  compiler can read the same signal for the progress dashboard without an
 *  import cycle; this export is now a thin delegation with unchanged
 *  signature and semantics. */
export function machineProgressSeries(
  vaultEntries: VaultEntry[],
  currentRound: number,
  lookback: number,
): boolean[] | null {
  return machineGitMotionSeries(vaultEntries, currentRound, lookback);
}

/** Read success_criteria_met from a vault entry's execution_evidence
 *  (direct field only — the feedback entries written by persistLoopLineage
 *  carry it at the top level). */
function entryCriteriaMet(entry: VaultEntry): string[] {
  const ev = entry.execution_evidence;
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return [];
  const arr = (ev as Record<string, unknown>).success_criteria_met;
  return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : [];
}

/** v3.3: Whether any success criterion was newly reported met within the
 *  last `lookback` committed rounds — a windowed "unit completion" signal
 *  for R4/R5's exculpatory cross-check on the evidence path.
 *
 *  EXCULPATORY ONLY — this can veto a delta-based stall verdict; it never
 *  grounds a rejection or termination. Reads only committed :feedback
 *  entries (the current round's uncommitted self-report never participates,
 *  so an unverified met claim cannot buy an exemption). Matching is
 *  ID-first (cr-XXXXXXXX) with Jaccard fallback, mirroring the compiler's
 *  criterion dedup. Returns false when the window has no criteria data. */
export function hasNewCriteriaCompletion(
  vaultEntries: VaultEntry[],
  currentRound: number,
  lookback: number,
): boolean {
  const windowStart = currentRound - lookback;
  const committed = vaultEntries
    .filter((entry) => {
      const tid = String(entry.task_id ?? "");
      if (!tid.endsWith(":feedback")) return false;
      const rnd = entryRound(entry);
      return rnd >= 1 && rnd < currentRound;
    })
    .sort((a, b) => entryRound(a) - entryRound(b));
  // Anything first met before the window is already seen and cannot be new.
  const seen: string[] = [];
  for (const entry of committed) {
    const rnd = entryRound(entry);
    for (const item of entryCriteriaMet(entry)) {
      const isNew = !seen.some((prior) => criteriaMatch(item, prior));
      if (isNew && rnd >= windowStart) return true;
      if (isNew) seen.push(item);
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Individual checks — each returns a VerificationFlag or null
// ═══════════════════════════════════════════════════════════════════════════

function checkProgressRegression(
  selfEval: SelfEvaluation,
  prevSelfEval: SelfEvaluation | null,
): VerificationFlag | null {
  if (!prevSelfEval?.execution_evidence) return null;
  if (!selfEval.execution_evidence) return null;

  const prevProgress = prevSelfEval.execution_evidence.progress_estimate;
  const currProgress = selfEval.execution_evidence.progress_estimate;

  if (typeof prevProgress !== "number" || typeof currProgress !== "number") return null;
  // Use delta with epsilon to avoid IEEE 754 rounding issues (0.8 - 0.2 > 0.6 in float)
  if (prevProgress - currProgress <= 0.2 + 1e-10) return null;

  return makeVerificationFlag({
    severity: "warn",
    field: "progress_estimate",
    check: CHECK_PROGRESS_REGRESSION,
    detail:
      `Progress dropped from ${prevProgress.toFixed(2)} to ` +
      `${currProgress.toFixed(2)} (delta: ${(currProgress - prevProgress).toFixed(2)})`,
  });
}

function checkEmptyChangeWithPassing(
  selfEval: SelfEvaluation,
): VerificationFlag | null {
  const ev = selfEval.execution_evidence;
  if (!ev) return null;

  const filesEmpty = ev.files_changed.length === 0;
  const testsAllPass =
    ev.test_results !== null &&
    ev.test_results.failed === 0 &&
    ev.test_results.passed > 0;

  if (!filesEmpty || !testsAllPass || !effectiveSuccess(selfEval)) return null;

  return makeVerificationFlag({
    severity: "warn",
    field: "execution_evidence",
    check: CHECK_EMPTY_CHANGE_WITH_PASSING,
    detail:
      "Agent claims success with no files changed and all tests passing — " +
      "verify that work was actually performed",
  });
}

function checkSuccessWithRemainingCriteria(
  selfEval: SelfEvaluation,
): VerificationFlag | null {
  if (!effectiveSuccess(selfEval)) return null;

  const remaining = selfEval.execution_evidence?.success_criteria_remaining;
  if (!remaining || remaining.length === 0) return null;

  return makeVerificationFlag({
    severity: "error",
    field: "success",
    check: CHECK_SUCCESS_WITH_REMAINING_CRITERIA,
    detail:
      `Agent claims success but ${remaining.length} criteria remain unmet: ` +
      remaining.slice(0, 3).join("; "),
  });
}

/** v2.12: Criteria reported met but none machine-verified. The agent puts
 *  completed criteria into the ledger, but no passing test evidence or
 *  command snapshot backs them. Warn — completion still counts, but the
 *  next prompt tells the agent its claims are unverified. This is the
 *  mild form of the 3.x criterion-specific completion rule. */
function checkUnverifiedCriteriaClaims(
  selfEval: SelfEvaluation,
  claimView: ClaimView,
): VerificationFlag | null {
  const met = selfEval.execution_evidence?.success_criteria_met;
  if (!met || met.length === 0) return null;
  if (claimView.verifiedCount > 0 || claimView.hasMachineEvidence) return null;
  return makeVerificationFlag({
    severity: "warn",
    field: "execution_evidence",
    check: CHECK_CRITERIA_CLAIMS_UNVERIFIED,
    detail:
      `${met.length} criteria reported met but none machine-verified ` +
      "(no passing test evidence or command snapshot)",
  });
}

/** v2.12: Declared outcome vs legacy boolean consistency. A declared success
 *  with success=false is a self-contradiction (error); a declared non-success
 *  with success=true is a compat conflict (warn). Also: outcome==="blocked"
 *  without a blocker description gets a warn so the next prompt asks for it. */
function checkOutcomeConsistency(
  selfEval: SelfEvaluation,
): VerificationFlag | null {
  const outcome = selfEval.outcome;
  if (outcome === "success" && selfEval.success === false) {
    return makeVerificationFlag({
      severity: "error",
      field: "outcome",
      check: CHECK_OUTCOME_SUCCESS_CONTRADICTION,
      detail: "outcome=success but success=false — self-contradictory",
    });
  }
  if (outcome !== undefined && outcome !== "success" && selfEval.success === true) {
    return makeVerificationFlag({
      severity: "warn",
      field: "success",
      check: CHECK_SUCCESS_CLAIM_CONFLICT,
      detail: `outcome=${outcome} but success=true — the declared outcome wins`,
    });
  }
  if (outcome === "blocked" &&
      (typeof selfEval.blocker !== "string" || selfEval.blocker.trim().length === 0)) {
    return makeVerificationFlag({
      severity: "warn",
      field: "blocker",
      check: CHECK_BLOCKED_WITHOUT_BLOCKER,
      detail: "outcome=blocked but no blocker description was provided",
    });
  }
  return null;
}

/** v2.12: Retroactive claims reference PRIOR rounds. Each claim's file
 *  paths are checked against the referenced round's committed git evidence
 *  (P0 provenance layer). Unverifiable claims warn — they never upgrade
 *  criteria status. */
function checkRetroactiveClaims(
  selfEval: SelfEvaluation,
  vaultEntries: VaultEntry[],
  currentRound: number,
): VerificationFlag | VerificationFlag[] | null {
  const claims = selfEval.retroactiveClaims;
  if (!claims || claims.length === 0) return null;
  const loopId = vaultEntries.find((entry) => typeof entry.loop_id === "string")
    ?.loop_id;
  const flags: VerificationFlag[] = [];
  for (const claim of claims) {
    if (claim.round < 1 || claim.round >= currentRound) {
      flags.push(makeVerificationFlag({
        severity: "warn",
        field: "retroactiveClaims",
        check: CHECK_RETROACTIVE_CLAIM_BAD_ROUND,
        detail: `retroactive claim targets round ${claim.round} (must be a prior round)`,
      }));
      continue;
    }
    if (!loopId) continue; // no vault context → cannot verify (fail-open)
    const observed = resolveRoundFiles(vaultEntries, loopId, claim.round);
    if (observed === null) {
      flags.push(makeVerificationFlag({
        severity: "warn",
        field: "retroactiveClaims",
        check: CHECK_RETROACTIVE_CLAIM_UNVERIFIED,
        detail: `retroactive claim for round ${claim.round} has no observable git evidence`,
      }));
      continue;
    }
    const paths = extractFilePaths(claim.claim);
    const unverified = paths.filter((path) =>
      !observed.some((file) => file === path || file.endsWith(path) || path.endsWith(file)));
    if (paths.length > 0 && unverified.length > 0) {
      flags.push(makeVerificationFlag({
        severity: "warn",
        field: "retroactiveClaims",
        check: CHECK_RETROACTIVE_CLAIM_UNVERIFIED,
        detail: `retroactive claim references files not observed in round ${claim.round}: ` +
          unverified.slice(0, 3).join(", "),
      }));
    }
  }
  // v3.3.1: return every offending claim's flag — a single truncated flag
  // hid all but the first problem until the next round.
  return flags.length > 0 ? flags : null;
}

/** v2.12: success with zero machine-verifiable evidence. The agent claims
 *  completion but nothing the runtime observed backs it — no verified claims
 *  (test evidence), no test results, no required commands. A declared
 *  no_change_reason is the honest escape hatch: it downgrades to info. */
function checkSuccessWithoutVerifiedEvidence(
  selfEval: SelfEvaluation,
  claimView: ClaimView,
): VerificationFlag | null {
  if (!effectiveSuccess(selfEval)) return null;
  if (claimView.verifiedCount > 0 || claimView.hasMachineEvidence) return null;
  const noChange = typeof selfEval.no_change_reason === "string" &&
    selfEval.no_change_reason.trim().length > 0;
  // v3.3: severity follows evidence.machine_backed_success — "required"
  // rejects (error), "warn" tolerates with a warn (round commits, success
  // excluded from the trajectory, trust drops). no_change_reason stays info.
  const severity: VerificationFlag["severity"] = noChange
    ? "info"
    : getPolicy().evidence.machine_backed_success === "warn"
      ? "warn"
      : "error";
  return makeVerificationFlag({
    severity,
    field: "success",
    check: CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE,
    detail: noChange
      ? "success with zero verified claims (no_change_reason declared)"
      : "success with zero verified claims and no test evidence",
  });
}

/** v3.2: success declared but no machine-verified observation this round.
 *  Unlike R8 (which keys off the agent's SELF-REPORTED test_results), this
 *  keys off the runtime-derived providerStatus: git diff observed, or a
 *  passed after-command. Warn-level by design — the round commits, but its
 *  success never enters the trajectory (and trust drops). A declared
 *  no_change_reason is the honest escape hatch, mirroring R8.
 *  Crucially this check does NOT self-skip on the heuristic-extraction path:
 *  an unstructured success claim without machine observation is flagged
 *  exactly the same — the check degrades, it never disappears. */
function checkSuccessUnverified(
  selfEval: SelfEvaluation,
  status: EvidenceStatus,
): VerificationFlag | null {
  if (!effectiveSuccess(selfEval)) return null;
  if (typeof selfEval.no_change_reason === "string" &&
      selfEval.no_change_reason.trim().length > 0) return null;
  if (status.providerStatus === "verified") return null;
  return makeVerificationFlag({
    severity: "warn",
    field: "success",
    check: CHECK_SUCCESS_UNVERIFIED,
    detail: `success declared but no machine-verified observation this round (providerStatus: ${status.providerStatus})`,
  });
}

function checkDuplicateConstraintDiscovery(
  selfEval: SelfEvaluation,
  prevSelfEval: SelfEvaluation | null,
  olderViolations: string[],
): VerificationFlag | null {
  const discovered = selfEval.discovered_constraints;
  if (!discovered || discovered.length === 0) return null;

  // Collect all previously-known constraints
  const known = new Set<string>();
  for (const v of olderViolations) known.add(v.toLowerCase().trim());

  if (prevSelfEval) {
    for (const d of prevSelfEval.discovered_constraints ?? []) {
      known.add(d.toLowerCase().trim());
    }
    // Also treat previous violations as implicitly discovered
    for (const v of prevSelfEval.constraint_violations) {
      known.add(v.toLowerCase().trim());
    }
  }

  for (const d of discovered) {
    if (known.has(d.toLowerCase().trim())) {
      return makeVerificationFlag({
        severity: "warn",
        field: "discovered_constraints",
        check: CHECK_DUPLICATE_CONSTRAINT_DISCOVERY,
        detail: `Constraint "${d}" was already known from a previous round`,
      });
    }
  }

  return null;
}

function checkRecurringViolation(
  selfEval: SelfEvaluation,
  prevSelfEval: SelfEvaluation | null,
  vaultEntries: VaultEntry[],
  currentRound: number,
): VerificationFlag | null {
  const currViols = selfEval.constraint_violations;
  if (!currViols || currViols.length === 0) return null;

  // Build the violation history: [round N-2, round N-1, round N]
  const violationsByRound: string[][] = [];

  // Round N-2 violations come from the vault entry for round N-1
  // (persistLoopLineage stores the PREVIOUS round's violations on each entry)
  if (currentRound >= 3) {
    const entryNMinus1 = vaultEntries.find((e) => entryRound(e) === currentRound - 1);
    if (entryNMinus1) {
      const viols = entryViolations(entryNMinus1);
      if (viols.length) violationsByRound.push(viols.map((v) => v.toLowerCase().trim()));
    }
  }

  // Round N-1 violations from prevSelfEval
  if (prevSelfEval) {
    const prevViols = prevSelfEval.constraint_violations;
    violationsByRound.push(prevViols.map((v) => v.toLowerCase().trim()));
  }

  // Round N violations from current selfEval
  violationsByRound.push(currViols.map((v) => v.toLowerCase().trim()));

  // Need at least 3 rounds of data
  if (violationsByRound.length < 3) return null;

  // Check each current violation against the previous 2 rounds
  const [rNMinus2, rNMinus1, rN] = violationsByRound.slice(-3);
  for (const v of rN) {
    if (rNMinus1.includes(v) && rNMinus2.includes(v)) {
      return makeVerificationFlag({
        severity: "error",
        field: "constraint_violations",
        check: CHECK_RECURRING_VIOLATION,
        detail:
          `Constraint violation "${v}" has appeared in 3 consecutive rounds ` +
          `(rounds ${currentRound - 2}–${currentRound}) without resolution`,
      });
    }
  }

  return null;
}

function checkRetractFreshConstraint(
  selfEval: SelfEvaluation,
  prevSelfEval: SelfEvaluation | null,
  currentRound: number,
): VerificationFlag | null {
  const retracted = selfEval.retracted_constraints;
  if (!retracted || retracted.length === 0) return null;
  if (!prevSelfEval) return null;

  const lastRoundDiscoveries = new Set<string>();
  for (const d of prevSelfEval.discovered_constraints ?? []) {
    lastRoundDiscoveries.add(d.toLowerCase().trim());
  }

  for (const r of retracted) {
    if (lastRoundDiscoveries.has(r.toLowerCase().trim())) {
      return makeVerificationFlag({
        severity: "warn",
        field: "retracted_constraints",
        check: CHECK_RETRACT_FRESH_CONSTRAINT,
        detail:
          `Retracting constraint "${r}" that was just discovered in round ` +
          `${currentRound - 1} — may indicate rapid flip-flopping`,
      });
    }
  }

  return null;
}

/** v1.18: Cross-validate agent-reported files_changed against git evidence
 *  from the configured evidence providers (ProviderSnapshot array). */
function checkEvidenceIntegrity(
  selfEval: SelfEvaluation,
  evidenceSnapshots: ProviderSnapshot[],
): VerificationFlag | null {
  if (!selfEval.execution_evidence) return null;
  if (evidenceSnapshots.length === 0) return null;

  const gitSnap = evidenceSnapshots.find((s) => s.provider === "git");
  if (!gitSnap) return null;

  const reported = [...selfEval.execution_evidence.files_changed].sort();
  const actual = [...gitSnap.files].sort();

  if (reported.length === 0 && actual.length === 0) return null;

  if (reported.length === 0 && actual.length > 0) {
    return makeVerificationFlag({
      severity: "warn",
      field: "files_changed",
      check: CHECK_EVIDENCE_INTEGRITY,
      detail:
        `Agent reported no files changed but evidence shows: ${actual.join(", ")}`,
    });
  }

  const ghostFiles = reported.filter((f) => !actual.includes(f));
  const missedFiles = actual.filter((f) => !reported.includes(f));

  if (ghostFiles.length > 0 || missedFiles.length > 0) {
    const parts: string[] = [];
    if (ghostFiles.length > 0) parts.push(`unconfirmed: [${ghostFiles.join(", ")}]`);
    if (missedFiles.length > 0) parts.push(`unreported: [${missedFiles.join(", ")}]`);
    return makeVerificationFlag({
      severity: "warn",
      field: "files_changed",
      check: CHECK_EVIDENCE_INTEGRITY,
      detail: `Agent files_changed doesn't match evidence: ${parts.join("; ")}`,
    });
  }

  return null;
}

/** A required, explicitly configured verification command is authoritative
 * when the Agent claims success. Optional commands remain observational. */
function checkRequiredCommandEvidence(
  selfEval: SelfEvaluation,
  evidenceSnapshots: ProviderSnapshot[],
): VerificationFlag | null {
  if (!effectiveSuccess(selfEval)) return null;
  for (const snapshot of evidenceSnapshots) {
    if (snapshot.data.kind !== "command") continue;
    if (snapshot.data.phase !== "after" || snapshot.data.required !== true) continue;
    const status = snapshot.data.status;
    if (status === "passed") continue;
    const name = typeof snapshot.data.commandName === "string"
      ? snapshot.data.commandName
      : snapshot.provider;
    const exitCode = typeof snapshot.data.exitCode === "number"
      ? ` (exit ${snapshot.data.exitCode})`
      : "";
    return makeVerificationFlag({
      severity: "error",
      field: "execution_evidence",
      check: CHECK_REQUIRED_COMMAND_FAILED,
      detail: `Agent claims success but required command "${name}" ${String(status)}${exitCode}`,
    });
  }
  return null;
}

// ── Test output parsing ────────────────────────────────────────────────────

// jaccardSimilarity() imported from token-utils.ts (v2.1 — intent-action drift detection)

/** Extract stable sub-goal IDs (sg-XXXXXXXX) mentioned in text.
 *  Matches the ID format rendered in prompts (loop-compiler deriveSubGoalId). */
function extractSubGoalIds(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/sg-[a-f0-9]{8}/g) ?? [])];
}

/** Extract file-path-like tokens (e.g. "src/auth/login.ts") from text. */
function extractFilePaths(text: string): string[] {
  return [...new Set(text.match(/[\w./-]+\.[a-z]{2,6}\b/gi) ?? [])];
}

/** Whether a changed path looks like a test file. */
function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[a-z0-9]+$/i.test(path) ||
    /(^|[\\/])tests?[\\/]/i.test(path) ||
    /_test\.[a-z0-9]+$/i.test(path);
}

/** Map each referenced sub-goal ID to its known description(s), reconstructed
 *  from emerged_subtasks in the vault lineage and the previous self-eval. */
function referencedSubGoalDescriptions(
  ids: string[],
  vaultEntries: VaultEntry[],
  prevSelfEval: SelfEvaluation | null,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const id of ids) map.set(id, []);
  const descriptions: string[] = [];
  for (const entry of vaultEntries) {
    const emerged = Array.isArray(entry.emerged_subtasks)
      ? entry.emerged_subtasks.filter((v: unknown) => typeof v === "string")
      : [];
    descriptions.push(...emerged);
  }
  descriptions.push(...(prevSelfEval?.emerged_subtasks ?? []));
  for (const desc of descriptions) {
    const trimmed = desc.trim();
    if (!trimmed) continue;
    const id = deriveSubGoalId(trimmed);
    if (map.has(id)) map.get(id)!.push(trimmed);
  }
  return map;
}

/** v2.1 (check 11): Compare the previous round's declared next_action with
 *  the current round's actual output_summary. Detect when the agent says it
 *  will do X but then does Y — silent drift without explanation.
 *
 *  Only fires when both next_action and output_summary are non-empty.
 *
 *  v2.14: Structured-ID-first detection. Alignment is decided by a waterfall
 *  of concrete signals before falling back to string similarity:
 *    1. Sub-goal IDs (sg-XXXXXXXX) in next_action matched against this
 *       round's completed_subtasks (exact ID, ID derived from the
 *       description text, or Jaccard against the referenced sub-goal's
 *       known description).
 *    2. File paths named in next_action appearing in files_changed.
 *    3. Test evidence — next_action mentions tests and test files were
 *       changed with tests actually run.
 *    4. Jaccard token similarity against the policy threshold (weak signal).
 *  Any signal aligning is sufficient — text similarity is never the sole
 *  authority when structured evidence exists. */
function checkIntentDrift(
  selfEval: SelfEvaluation,
  prevSelfEval: SelfEvaluation | null,
  vaultEntries: VaultEntry[],
): VerificationFlag | null {
  if (!prevSelfEval?.next_action?.trim()) return null;
  if (!selfEval.output_summary.trim()) return null;

  const intent = prevSelfEval.next_action.trim();
  const actual = selfEval.output_summary.trim();
  const policy = getPolicy();
  const filesChanged = selfEval.execution_evidence?.files_changed ?? [];

  // ── Signal 1: sub-goal IDs referenced by next_action → completed this round
  const intentIds = extractSubGoalIds(intent);
  if (intentIds.length > 0) {
    const completed = selfEval.completed_subtasks ?? [];
    const referenced = referencedSubGoalDescriptions(intentIds, vaultEntries, prevSelfEval);
    const idMatched = intentIds.some((id) =>
      completed.some((entry) => {
        const text = entry.trim();
        if (!text) return false;
        if (text.toLowerCase() === id) return true;
        if (deriveSubGoalId(text) === id) return true;
        const descriptions = referenced.get(id) ?? [];
        return descriptions.some((desc) =>
          jaccardSimilarity(text, desc) >= policy.evolution.subgoal_match_threshold);
      }),
    );
    if (idMatched) return null;
  }

  // ── Signal 2: file paths named in next_action appear in files_changed
  const intentPaths = extractFilePaths(intent);
  if (intentPaths.length > 0 && filesChanged.length > 0) {
    const pathMatched = intentPaths.some((p) =>
      filesChanged.some((f) => f === p || f.endsWith(p) || p.endsWith(f)));
    if (pathMatched) return null;
  }

  // ── Signal 3: test evidence — intent mentions tests, test files changed,
  //    and tests actually ran this round
  const intentTokens = tokenize(intent);
  const mentionsTests = intentTokens.has("test") || intentTokens.has("tests");
  const testResults = selfEval.execution_evidence?.test_results;
  const testsRan = !!testResults && testResults.passed + testResults.failed > 0;
  const testFilesChanged = filesChanged.some((f) => isTestFile(f));
  if (mentionsTests && testsRan && testFilesChanged) return null;

  // ── Signal 4 (weak): Jaccard token similarity
  const score = jaccardSimilarity(intent, actual);
  const threshold = policy.evolution.intent_drift_threshold;
  if (score >= threshold) return null;

  const idNote = intentIds.length > 0
    ? `; ${intentIds.length} referenced sub-goal ID(s) did not match completed_subtasks`
    : "";
  return makeVerificationFlag({
    severity: "warn",
    field: "output_summary",
    check: CHECK_INTENT_DRIFT,
    detail:
      `Declared intent was "${intent.slice(0, 120)}" ` +
      `but actual output "${actual.slice(0, 120)}" — ` +
      `similarity ${(score * 100).toFixed(0)}% below threshold ${(threshold * 100).toFixed(0)}%` +
      idNote,
  });
}

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
export function parseTestOutput(stdout: string): ParsedTestCounts | null {
  if (!stdout) return null;
  const tail = stdout.length > 2000 ? stdout.slice(-2000) : stdout;
  let match: RegExpMatchArray | null;

  // 1. Jest verbose: "Tests: 1 failed, 8 passed, 9 total"
  match = tail.match(/Tests:\s*(\d+)\s+failed,\s*(\d+)\s+passed,\s*(\d+)\s+total/i);
  if (match) {
    return { failed: Number(match[1]), passed: Number(match[2]), total: Number(match[3]), skipped: 0 };
  }

  // 2. Jest compact: "Tests: 8 passed, 9 total"
  match = tail.match(/Tests:\s*(\d+)\s+passed,\s*(\d+)\s+total/i);
  if (match) {
    const passed = Number(match[1]);
    const total = Number(match[2]);
    return { passed, failed: total - passed, total, skipped: 0 };
  }

  // 3. Mocha: "8 passing" + optional "2 failing"
  const mochaPass = tail.match(/(\d+)\s+passing/i);
  if (mochaPass) {
    const mochaFail = tail.match(/(\d+)\s+failing/i);
    const passed = Number(mochaPass[1]);
    const failed = mochaFail ? Number(mochaFail[1]) : 0;
    return { passed, failed, total: passed + failed, skipped: 0 };
  }

  // 4. Go test: count "--- PASS:" and "--- FAIL:" lines
  const goPassCount = (tail.match(/---\s+PASS:/g) || []).length;
  const goFailCount = (tail.match(/---\s+FAIL:/g) || []).length;
  if (goPassCount > 0 || goFailCount > 0) {
    return { passed: goPassCount, failed: goFailCount, total: goPassCount + goFailCount, skipped: 0 };
  }

  // 5. pytest / unittest: "8 passed, 1 failed" or "8 passed"
  match = tail.match(/(\d+)\s+passed[,;\s]+(\d+)\s+failed/i);
  if (match) {
    return { passed: Number(match[1]), failed: Number(match[2]), total: Number(match[1]) + Number(match[2]), skipped: 0 };
  }
  // pytest compact: "8 passed" (with a reasonable context hint)
  match = tail.match(/(?:=\s+test session|\b(?:passed|failed)\b)/i);
  if (match) {
    const pCount = tail.match(/(\d+)\s+passed/i);
    const fCount = tail.match(/(\d+)\s+failed/i);
    if (pCount || fCount) {
      const passed = pCount ? Number(pCount[1]) : 0;
      const failed = fCount ? Number(fCount[1]) : 0;
      return { passed, failed, total: passed + failed, skipped: 0 };
    }
  }

  // 6. PHPUnit: "OK (8 tests, 16 assertions)"
  match = tail.match(/OK\s*\((\d+)\s+tests?/i);
  if (match) {
    const total = Number(match[1]);
    return { passed: total, failed: 0, total, skipped: 0 };
  }

  return null;
}

/** Cross-validate agent-reported test_results against command evidence output.
 *
 *  For each command provider whose status is "passed" and output is not
 *  truncated, attempts to parse test counts from stdout. Mismatched counts
 *  produce a warn-level flag; failures hidden by the agent (reported 0 failed
 *  when the command shows >0) produce an error-level flag.
 *
 *  Non-command evidence providers are skipped (no structural cross-check is
 *  defined for them yet). */
function checkCommandEvidenceIntegrity(
  selfEval: SelfEvaluation,
  evidenceSnapshots: ProviderSnapshot[],
): VerificationFlag | null {
  const reported = selfEval.execution_evidence?.test_results;
  if (!reported) return null;

  for (const snapshot of evidenceSnapshots) {
    if (snapshot.data.kind !== "command") continue;
    if (snapshot.data.status !== "passed") continue;
    if (snapshot.data.truncated === true) continue;

    const stdout = typeof snapshot.data.stdout === "string" ? snapshot.data.stdout : "";
    const parsed = parseTestOutput(stdout);
    if (!parsed) continue;

    const mismatches: string[] = [];
    if (parsed.passed !== reported.passed) {
      mismatches.push(`passed: reported ${reported.passed}, command shows ${parsed.passed}`);
    }
    if (parsed.failed !== reported.failed) {
      mismatches.push(`failed: reported ${reported.failed}, command shows ${parsed.failed}`);
    }

    if (mismatches.length === 0) {
      // Counts match exactly — evidence supports the agent's claim.
      continue;
    }

    const name = typeof snapshot.data.commandName === "string"
      ? snapshot.data.commandName
      : snapshot.provider;
    // Agent hides failures → error. Other mismatch → warn.
    const severity = parsed.failed > 0 && reported.failed === 0 ? "error" : "warn";

    return makeVerificationFlag({
      severity,
      field: "test_results",
      check: CHECK_COMMAND_EVIDENCE_MISMATCH,
      detail: `Agent test_results don't match "${name}" output: ${mismatches.join("; ")}`,
    });
  }

  return null;
}

/** v3.3: Verification domain integrity — command entrypoints and test files
 *  changed in the same round the command ran. Entrypoint modification
 *  invalidates the machine observation (error: the runtime executed a script
 *  the agent just rewrote). Test-file changes are normal dev activity (warn:
 *  confirm the tests still verify the task claims). Fail-open when the git
 *  snapshot is missing or the command has no resolvable entrypoint. */
function checkVerificationDomainIntegrity(
  evidenceSnapshots: ProviderSnapshot[],
): VerificationFlag | null {
  const git = evidenceSnapshots.find((snapshot) => snapshot.provider === "git") ?? null;
  if (!git) return null;
  for (const snapshot of evidenceSnapshots) {
    if (!isRecord(snapshot.data) || snapshot.data.kind !== "command") continue;
    if (snapshot.data.phase !== "after") continue;
    const { entrypointModified, testFilesModified } = commandTampered(snapshot, git);
    if (!entrypointModified && !testFilesModified) continue;
    const name = typeof snapshot.data.commandName === "string"
      ? snapshot.data.commandName
      : snapshot.provider;
    if (entrypointModified) {
      return makeVerificationFlag({
        severity: "error",
        field: "execution_evidence",
        check: CHECK_VERIFICATION_ENTRYPOINT_MODIFIED,
        detail:
          `Verification command "${name}" entrypoint changed this round — ` +
          "its result cannot be trusted as machine evidence. Keep the " +
          "verification command stable or resubmit the same round with the " +
          "entrypoint unchanged.",
      });
    }
    return makeVerificationFlag({
      severity: "warn",
      field: "execution_evidence",
      check: CHECK_TEST_FILES_MODIFIED,
      detail:
        `Test files changed in the same round command "${name}" passed — ` +
        "confirm the tests still verify the task claims.",
    });
  }
  return null;
}

/** v2.2: Check if the agent's declared next_action aligns with any pending
 *  or in_progress sub-goal. When 3+ pending sub-goals exist but the agent
 *  plans work unrelated to any of them, it may indicate task drift.
 *  This is a warn-level advisory — the agent always owns prioritization.
 *
 *  v2.14: Exact sub-goal ID alignment first — next_action naming a pending
 *  sub-goal by its stable ID (sg-XXXXXXXX) is aligned by definition.
 *  Jaccard description similarity remains as the fallback. */
function checkSubGoalDrift(
  selfEval: SelfEvaluation,
  prevSelfEval: SelfEvaluation | null,
  vaultEntries: VaultEntry[],
  currentRound: number,
): VerificationFlag | null {
  const nextAction = selfEval.next_action?.trim();
  if (!nextAction) return null;

  // Reconstruct pending sub-goal descriptions from vault entries
  const pendingSubGoals = new Set<string>();
  const completedOrCanceled = new Set<string>();
  for (const entry of vaultEntries) {
    const emerged = Array.isArray(entry.emerged_subtasks)
      ? entry.emerged_subtasks.filter((v: unknown) => typeof v === "string")
      : [];
    for (const desc of emerged) {
      pendingSubGoals.add(desc.trim());
    }
    const done = Array.isArray(entry.completed_subtasks)
      ? entry.completed_subtasks.filter((v: unknown) => typeof v === "string")
      : [];
    for (const desc of done) {
      completedOrCanceled.add(desc.trim());
    }
    const canceled = Array.isArray(entry.canceled_subtasks)
      ? entry.canceled_subtasks.filter((v: unknown) => typeof v === "string")
      : [];
    for (const desc of canceled) {
      completedOrCanceled.add(desc.trim());
    }
  }
  // Also process current selfEval
  for (const desc of selfEval.emerged_subtasks ?? []) {
    pendingSubGoals.add(desc.trim());
  }
  for (const desc of selfEval.completed_subtasks ?? []) {
    completedOrCanceled.add(desc.trim());
  }
  for (const desc of selfEval.canceled_subtasks ?? []) {
    completedOrCanceled.add(desc.trim());
  }

  // Remove completed/canceled from pending
  for (const desc of completedOrCanceled) {
    pendingSubGoals.delete(desc);
  }

  // Need at least 3 pending sub-goals for the check to be meaningful
  if (pendingSubGoals.size < 3) return null;

  // v2.14: Stable ID match first — next_action naming a pending sub-goal
  // by ID is aligned by definition, regardless of description wording.
  const nextActionIds = extractSubGoalIds(nextAction);
  if (nextActionIds.length > 0) {
    const pendingIds = new Set([...pendingSubGoals].map((d) => deriveSubGoalId(d)));
    if (nextActionIds.some((id) => pendingIds.has(id))) return null;
  }

  // Check if next_action aligns with any pending sub-goal
  let aligns = false;
  for (const sg of pendingSubGoals) {
    const score = jaccardSimilarity(nextAction, sg);
    if (score >= getPolicy().evolution.subgoal_drift_alignment_threshold) {
      aligns = true;
      break;
    }
  }

  if (!aligns) {
    const sample = [...pendingSubGoals].slice(0, 3).join(", ");
    return makeVerificationFlag({
      severity: "warn",
      field: "next_action",
      check: CHECK_SUBGOAL_DRIFT,
      detail:
        `Agent's next_action doesn't align with any of ${pendingSubGoals.size} pending sub-goals. ` +
        `Pending: ${sample}… Consider completing existing sub-goals before starting new work, ` +
        `or cancel outdated sub-goals via canceled_subtasks.`,
    });
  }

  return null;
}

/** v2.13: After a backtrack, check that the agent restored the workspace
 *  before working. If the agent's files_changed overlaps with files from
 *  skipped (failed) rounds, the workspace was likely not clean. */
function checkBacktrackWorkspaceRestore(
  selfEval: SelfEvaluation,
  backtrackSkippedFiles: string[],
): VerificationFlag | null {
  if (backtrackSkippedFiles.length === 0) return null;

  const ev = selfEval.execution_evidence;
  if (!ev || ev.files_changed.length === 0) return null;

  // Check overlap: files the agent changed vs. files from skipped rounds
  const overlap = ev.files_changed.filter((f) =>
    backtrackSkippedFiles.some((sf) => sf === f || f.endsWith(sf) || sf.endsWith(f)),
  );

  if (overlap.length === 0) return null;

  // Agent is modifying files that were part of failed rounds without
  // having properly restored the workspace first.
  if (overlap.length >= 3 || overlap.length === ev.files_changed.length) {
    return makeVerificationFlag({
      severity: "error",
      field: "files_changed",
      check: CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED,
      detail:
        `Agent modified ${overlap.length} file(s) that were part of ` +
        `the skipped (failed) rounds: ${overlap.slice(0, 5).join(", ")}. ` +
        `The workspace was likely not restored before working.`,
    });
  }

  // Minor overlap — warn only
  return makeVerificationFlag({
    severity: "warn",
    field: "files_changed",
    check: CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED,
    detail:
      `Agent modified files that overlap with skipped rounds: ` +
      `${overlap.join(", ")}. Verify the workspace was restored.`,
  });
}

/** v2.12: After a backtrack, the working tree must return to the restore
 *  point's git HEAD. Compares the first 12 characters (short hash), matching
 *  how git itself disambiguates. */
function checkBacktrackGitHeadRestore(
  evidenceSnapshots: ProviderSnapshot[],
  backtrackTargetGitHead?: string,
): VerificationFlag | null {
  if (!backtrackTargetGitHead) return null;
  const git = evidenceSnapshots.find((snapshot) =>
    snapshot.provider === "git" && isRecord(snapshot.data) &&
    typeof snapshot.data.head === "string");
  if (!git) return null; // git unavailable → cannot verify → skip (fail-open)
  const currentHead = (git.data as Record<string, unknown>).head as string;
  if (currentHead.length === 0) return null;
  if (currentHead.slice(0, 12) === backtrackTargetGitHead.slice(0, 12)) return null;
  return makeVerificationFlag({
    severity: "error",
    field: "workspace",
    check: CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED,
    detail:
      `Workspace HEAD (${currentHead.slice(0, 12)}) does not match the ` +
      `backtrack restore commit (${backtrackTargetGitHead.slice(0, 12)}). ` +
      `Restore the working tree before continuing.`,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// v3.3 — Round Contract checks (all silent when no contract is declared)
// ═══════════════════════════════════════════════════════════════════════════

/** A PROPOSAL that promises nothing is a wasted round's worth of trust:
 *  done_when empty means the boundary can never be machine-checked.
 *  v3.4: declaration-quality check on the submission's own proposal — never
 *  on the (derived) active contract. */
function checkRoundUnderspecified(selfEval: SelfEvaluation): VerificationFlag | null {
  const contract = selfEval.round_contract;
  if (!contract) return null;
  if (contract.done_when.length > 0) return null;
  return makeVerificationFlag({
    severity: "warn",
    field: "round_contract",
    check: CHECK_ROUND_UNDERSPECIFIED,
    detail:
      "Round Contract declared with an empty done_when — nothing is " +
      "promised, so completion cannot be verified. Declare what must be " +
      "true when the round is done.",
  });
}

/** done_when items whose verification_plan cannot run (empty plan, or names
 *  outside the configured, enabled evidence.commands) can never be
 *  machine-checked at the boundary. v3.4: declaration-quality check on the
 *  submission's own proposal. */
function checkRoundUnverifiable(selfEval: SelfEvaluation): VerificationFlag | null {
  const contract = selfEval.round_contract;
  if (!contract) return null;
  if (contract.done_when.length === 0) return null;
  if (contract.verification_plan.length > 0 &&
      contract.verification_plan.every((name) => isConfiguredCommand(name))) {
    return null;
  }
  const unknown = contract.verification_plan.filter((name) => !isConfiguredCommand(name));
  const detail = contract.verification_plan.length === 0
    ? "done_when items declared but verification_plan is empty — no command " +
      "can back the completion claims"
    : `verification_plan names commands that are not configured and enabled ` +
      `in evidence.commands: ${unknown.slice(0, 3).join(", ")}`;
  return makeVerificationFlag({
    severity: "warn",
    field: "round_contract",
    check: CHECK_ROUND_UNVERIFIABLE,
    detail:
      detail + ". Name only configured, enabled evidence.commands, or drop " +
      "done_when items that cannot be machine-verified.",
  });
}

/** The round changed files outside the ACTIVE contract's declared scope.
 *  Git diff files are the machine-authoritative "what actually changed" set.
 *  v3.4: targets the contract the round actually executed under — derived
 *  from committed evals, never the submission's own proposal. Silent when
 *  no active contract exists (round 1 and whole-task rounds: the agent
 *  executed the original task, not a contract boundary). */
function checkRoundScopeDrift(
  activeContract: RoundContract | null,
  evidenceSnapshots: ProviderSnapshot[],
): VerificationFlag | null {
  if (!activeContract) return null;
  if (activeContract.scope.length === 0) return null;
  const git = evidenceSnapshots.find((snapshot) => snapshot.provider === "git");
  if (!git) return null; // git unavailable → cannot observe → fail open
  const outOfScope = collectOutOfScopeFiles(git.files, activeContract.scope);
  if (outOfScope.length === 0) return null;
  return makeVerificationFlag({
    severity: "warn",
    field: "round_contract",
    check: CHECK_ROUND_SCOPE_DRIFT,
    detail:
      `Files changed outside the active contract's declared scope` +
      (outOfScope.length > 5
        ? ` (${outOfScope.length} total, showing 5): ${outOfScope.slice(0, 5).join(", ")}`
        : `: ${outOfScope.join(", ")}`) +
      `. Revert them or extend the contract scope and explain in drift_clarification.`,
  });
}

/** success claimed under the ACTIVE contract whose done_when items were not
 *  honestly and verifiably completed: claimed met with no machine-verified
 *  evidence this round, or silently dropped (present in neither
 *  success_criteria_met nor success_criteria_remaining). Declaring
 *  no_change_reason downgrades to info (the R8 escape hatch semantics).
 *  v3.4: targets the derived ACTIVE contract (the round's real boundary) —
 *  a proposal declared on a round without an active contract is never
 *  checked for conformance against work the round did not do under it.
 *  v3.5.1: a fully-met posture (every done_when claimed satisfied) is owned
 *  by contract_completion_unverified — this check stays for mixed and
 *  silently-dropped success claims only. */
function checkPrematureBoundary(
  activeContract: RoundContract | null,
  selfEval: SelfEvaluation,
  claimView: ClaimView,
): VerificationFlag | null {
  if (!activeContract || activeContract.done_when.length === 0) return null;
  if (!effectiveSuccess(selfEval)) return null;
  const ev = selfEval.execution_evidence;
  const met = ev?.success_criteria_met ?? [];
  // v3.5.1: full-met → the completion check owns the posture (it also fires
  // on success=false, so nothing is lost — and under machine_backed_success
  // "warn" the same tolerance applies on both sides).
  if (contractDoneWhenSatisfied(activeContract, met)) return null;
  const remaining = ev?.success_criteria_remaining ?? [];
  const problems: string[] = [];
  for (const item of activeContract.done_when) {
    // Shared matcher with the lifecycle walker (round-contract.ts) — the
    // compile-side closure decision and this conformance check can never
    // disagree on what counts as a satisfied item.
    const isMet = met.some((m) => contractItemMatches(item, m));
    const isRemaining = remaining.some((r) => contractItemMatches(item, r));
    if (isMet) {
      // Claimed met — needs round-level machine verification. The v3.3
      // claim model is round-uniform: any verified claim backs the round,
      // so zero verified claims = none of them are backed.
      if (claimView.verifiedCount === 0) {
        problems.push(`"${item.slice(0, 80)}" claimed met without machine-verified evidence`);
      }
    } else if (!isRemaining) {
      // Neither met nor remaining — silently dropped while success is
      // claimed. Honest reporting would list it in remaining (R1's domain).
      problems.push(`"${item.slice(0, 80)}" neither met nor listed as remaining`);
    }
  }
  if (problems.length === 0) return null;
  const severity = selfEval.no_change_reason ? "info" : "error";
  return makeVerificationFlag({
    severity,
    field: "round_contract",
    check: CHECK_PREMATURE_BOUNDARY,
    detail:
      `Round Contract boundary claimed prematurely: ${problems.slice(0, 3).join("; ")}. ` +
      `Run the contract's verification_plan commands and report real output, ` +
      `or set success=false and list the items in success_criteria_remaining.`,
  });
}

/** v3.5: Closing a Round Contract is a success-class claim and must be
 *  machine-backed. When the eval's met claims satisfy EVERY done_when of
 *  the ACTIVE contract (the walker's close condition), each verification_plan
 *  command must have been observed passing (after-phase command snapshot,
 *  untampered) in the same round. Fires regardless of the success flag —
 *  a claim-based closure that the machine cannot back must not advance the
 *  contract state machine. Severity follows evidence.machine_backed_success
 *  (the R8 tolerance switch). Deliberately no no_change_reason downgrade:
 *  all done_when met contradicts "no change". Fail-open: a plan name that
 *  is no longer a configured, enabled command cannot be observed and is
 *  not required. The check observes that the commands ran, not what they
 *  verified — R-C1's claim model remains the content bound. */
function checkContractCompletionUnverified(
  activeContract: RoundContract | null,
  selfEval: SelfEvaluation,
  evidenceSnapshots: ProviderSnapshot[],
): VerificationFlag | null {
  if (!activeContract || activeContract.verification_plan.length === 0) return null;
  const met = selfEval.execution_evidence?.success_criteria_met ?? [];
  if (!contractDoneWhenSatisfied(activeContract, met)) return null; // walker does not close
  const required = activeContract.verification_plan
    .filter((name) => isConfiguredCommand(name));
  if (required.length === 0) return null; // fail open — cannot observe
  const passed = passedPlanCommandNames(evidenceSnapshots);
  const missing = required.filter((name) => !passed.has(name));
  if (missing.length === 0) return null;
  const severity = getPolicy().evidence.machine_backed_success === "warn"
    ? "warn"
    : "error";
  return makeVerificationFlag({
    severity,
    field: "round_contract",
    check: CHECK_CONTRACT_COMPLETION_UNVERIFIED,
    detail:
      `Round Contract completion claimed (every done_when met), but verification_plan ` +
      `command${missing.length > 1 ? "s" : ""} did not pass this round: ` +
      `${missing.slice(0, 3).join(", ")}. Closing a contract is a success-class claim — ` +
      `fix the underlying failure so the command${missing.length > 1 ? "s" : ""} pass and ` +
      `resubmit; no_change_reason does not apply to completion claims.`,
  });
}

/** v3.5: A different contract proposed while the ACTIVE contract is still
 *  open. The walker ignores the premature proposal — this warn only makes
 *  the ignored state visible to the agent. Silent when the eval closes the
 *  active contract (all done_when met, or outcome=blocked — checked FIRST,
 *  mirroring the walker), when no proposal is submitted, or when the
 *  proposal equals the active contract (a restate). Equality is
 *  key-order-insensitive and normalized through parseRoundContract on both
 *  sides so committed-raw vs parsed-submission key-set drift cannot cause
 *  spurious warns. */
function checkContractPremature(
  activeContract: RoundContract | null,
  selfEval: SelfEvaluation,
): VerificationFlag | null {
  if (!activeContract) return null;
  const met = selfEval.execution_evidence?.success_criteria_met ?? [];
  if (contractDoneWhenSatisfied(activeContract, met)) return null; // closed
  if (selfEval.outcome === "blocked") return null; // closed
  const proposal = selfEval.round_contract;
  if (!proposal) return null;
  const same =
    stableStringify(parseRoundContract(activeContract)) ===
    stableStringify(parseRoundContract(proposal));
  if (same) return null; // restate → continue
  return makeVerificationFlag({
    severity: "warn",
    field: "round_contract",
    check: CHECK_CONTRACT_PREMATURE,
    detail:
      "The ACTIVE Round Contract is still open (not all done_when met, not blocked) " +
      "while a different contract was proposed — it is ignored until the active " +
      "contract is completed or blocked. Restate the active contract unchanged to " +
      "continue it.",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════

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
export function verifySelfEvaluation(
  selfEval: SelfEvaluation,
  currentRound: number,
  vaultEntries: VaultEntry[],
  prevSelfEval: SelfEvaluation | null = null,
  evidenceSnapshots: ProviderSnapshot[] = [],
  /** v2.13: Files from skipped backtrack rounds. If the agent's
   *  files_changed overlaps significantly with these, the workspace
   *  was not properly restored before working. */
  backtrackSkippedFiles: string[] = [],
  /** v2.12: Git HEAD commit of the backtrack restore point. When set, the
   *  current git snapshot must sit at this commit — otherwise the workspace
   *  was not restored and the round cannot be accepted. */
  backtrackTargetGitHead?: string,
): VerificationResult {
  const flags: VerificationFlag[] = [];

  // Collect violations from all previous vault entries for duplicate-discovery
  // and other checks that need deeper history.
  const olderViolations: string[] = [];
  for (const entry of vaultEntries) {
    for (const v of entryViolations(entry)) olderViolations.push(v);
  }

  // v3.4: The ACTIVE contract this round executed under — derived from the
  // committed :feedback evals of earlier rounds. The submission's own
  // round_contract is a PROPOSAL for the next round and never participates
  // (the eval under verification is not yet committed, so it structurally
  // cannot influence the derivation).
  const activeContract = deriveActiveRoundContract(
    committedContractRounds(vaultEntries, currentRound),
  );

  // v2.12: Derived claim provenance — which reported criteria completions
  // are backed by machine evidence (pure derivation, not persisted).
  const claimView: ClaimView = deriveClaimView(selfEval, evidenceSnapshots);
  // v3.2: Runtime machine-verification status (git observed / command passed /
  // absent). Feeds the success_unverified check that never self-skips.
  const evidenceStatus = deriveEvidenceStatus(selfEval, evidenceSnapshots);

  // Run all checks
  // v3.3.1: a check may return several flags (checkRetroactiveClaims raises
  // one per offending claim) — the previous single-flag contract truncated
  // the list at the first problem, hiding every other bad retroactive claim
  // from the agent until the next round.
  const checks: Array<() => VerificationFlag | VerificationFlag[] | null> = [
    () => checkProgressRegression(selfEval, prevSelfEval),
    () => checkEmptyChangeWithPassing(selfEval),
    () => checkSuccessWithRemainingCriteria(selfEval),
    // v2.12: success with zero verified claims and no test evidence
    () => checkSuccessWithoutVerifiedEvidence(selfEval, claimView),
    // v3.2: success without a machine-verified observation (never self-skips)
    () => checkSuccessUnverified(selfEval, evidenceStatus),
    // v2.12: criteria met but none machine-verified (mild criterion-specific rule)
    () => checkUnverifiedCriteriaClaims(selfEval, claimView),
    // v2.12: declared outcome vs legacy boolean consistency
    () => checkOutcomeConsistency(selfEval),
    // v2.12: retroactive claims against prior rounds
    () => checkRetroactiveClaims(selfEval, vaultEntries, currentRound),
    () => checkDuplicateConstraintDiscovery(selfEval, prevSelfEval, olderViolations),
    () => checkRecurringViolation(selfEval, prevSelfEval, vaultEntries, currentRound),
    () => checkRetractFreshConstraint(selfEval, prevSelfEval, currentRound),
    // v1.18: Cross-validate agent-reported files_changed against git evidence
    () => checkEvidenceIntegrity(selfEval, evidenceSnapshots),
    () => checkRequiredCommandEvidence(selfEval, evidenceSnapshots),
    // v2.0: Cross-validate agent-reported test_results against command output
    () => checkCommandEvidenceIntegrity(selfEval, evidenceSnapshots),
    // v3.3: Verification domain integrity — command entrypoint / test files
    // changed in the same round the command ran
    () => checkVerificationDomainIntegrity(evidenceSnapshots),
    // v2.1: Detect intent-action drift — agent said X but did Y
    () => checkIntentDrift(selfEval, prevSelfEval, vaultEntries),
    // v2.2: Detect sub-goal drift — next_action doesn't align with pending sub-goals
    () => checkSubGoalDrift(selfEval, prevSelfEval, vaultEntries, currentRound),
    // v2.13: Post-backtrack workspace restore check
    () => checkBacktrackWorkspaceRestore(selfEval, backtrackSkippedFiles),
    // v2.12: Post-backtrack git HEAD restore check
    () => checkBacktrackGitHeadRestore(evidenceSnapshots, backtrackTargetGitHead),
    // v3.3: Round Contract checks. v3.4: split by target — structural
    // (warn) at proposal declaration, conformance against the derived
    // ACTIVE contract (scope_drift warn / premature_boundary error).
    // v3.5: + completion machine-backing (error) and premature-replacement
    // visibility (warn).
    () => checkRoundUnderspecified(selfEval),
    () => checkRoundUnverifiable(selfEval),
    () => checkRoundScopeDrift(activeContract, evidenceSnapshots),
    () => checkPrematureBoundary(activeContract, selfEval, claimView),
    () => checkContractCompletionUnverified(activeContract, selfEval, evidenceSnapshots),
    () => checkContractPremature(activeContract, selfEval),
  ];

  for (const run of checks) {
    const result = run();
    if (Array.isArray(result)) flags.push(...result);
    else if (result) flags.push(result);
  }

  // Determine verdict from the most severe flag present
  const hasError = flags.some((f) => f.severity === "error");
  const hasWarn = flags.some((f) => f.severity === "warn");

  let verdict: VerificationResult["verdict"];
  if (hasError) {
    verdict = "contradicted";
  } else if (hasWarn) {
    verdict = "suspect";
  } else {
    verdict = "trusted";
  }

  return makeVerificationResult({ verdict, flags });
}
