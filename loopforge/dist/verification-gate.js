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
import { isPassedAfterObservation } from "./evidence-provider.js";
import { getPolicy } from "./policy.js";
import { makeVerificationFlag, makeVerificationResult } from "./protocol.js";
import { isRecord, entryRound, extractFilePathTokens } from "./token-utils.js";
import { committedRoundsFromEntries, machineGitMotionSeries, entryViolations, } from "./committed-round.js";
import { deriveActiveRoundContract, sameContract, } from "./round-contract.js";
import { deriveContractItemStatuses, } from "./contract-items.js";
import { deriveClaimView, resolveRoundFiles } from "./evidence-claims.js";
import { claimedMetCriteria, claimedRemainingCriteria, effectiveSuccess } from "./self-eval.js";
import { deriveGate, preflightStructuredGate } from "./cognitive-governance.js";
// ═══════════════════════════════════════════════════════════════════════════
// v2.12: Check-name constants — single source of truth so the enforcement
// gate and audit can reference checks without string-literal drift.
//
// v3.7: every check belongs to one of four verification domains (CHECK_DOMAIN
// below). The flag set was converged from 27 to 24:
// - progress_regression removed — self-report-only decoration; machine-side
//   progress policing lives in the enforcement gate's progress stall row.
// - empty_change_with_passing removed — success without machine backing is
//   already covered by the success-evidence arms below.
// - success_claim_conflict merged into outcome_success_contradiction.
// ═══════════════════════════════════════════════════════════════════════════
export const CHECK_SUCCESS_WITH_REMAINING_CRITERIA = "success_with_remaining_criteria";
export const CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE = "success_without_verified_evidence";
// v3.7: single id for the outcome-vs-success axis — error when a declared
// success contradicts success=false, warn when success=true but the outcome
// declares a non-success (the former success_claim_conflict direction).
export const CHECK_OUTCOME_SUCCESS_CONTRADICTION = "outcome_success_contradiction";
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
export const CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED = "backtrack_workspace_not_restored";
export const CHECK_CRITERIA_CLAIMS_UNVERIFIED = "criteria_claims_unverified";
// v3.3 — Round Contract checks. v3.4: split by target. The submission's own
// round_contract is a PROPOSAL for the NEXT round and is checked only
// structurally at declaration (underspecified / unverifiable). Execution
// conformance (scope drift / premature boundary) targets the ACTIVE
// contract — the contract the round actually executed under, derived from
// the committed evals of earlier rounds (round-contract.ts). All checks are
// silent when their target is absent: contract-less rounds behave exactly
// as before these checks existed, and round 1 (no committed rounds → no
// active contract) never produces declaration off-by-one noise.
// v3.7: the checks are framed as three contract stages — Declaration
// (proposal quality: round_underspecified / round_unverifiable /
// contract_premature), Execution (conformance under the ACTIVE contract:
// round_scope_drift; premature_boundary's silently-dropped arm), Closure
// (completion truth: contract_completion_unverified; premature_boundary's
// claimed-met-unverified arm). The framing is documentation only — no phase
// field exists on the contract.
/** v3.8: Contract items claimed met but not machine-verified this round.
 *  The round commits; the debt is surfaced and the enforcement gate's
 *  verification-debt row handles a persistent pattern. */
export const CHECK_CONTRACT_ITEMS_UNVERIFIED = "contract_items_unverified";
/** The round's actual git changes include files outside the ACTIVE
 *  contract's declared scope. Warn; v3.8: not waivable by explanation — the
 *  enforcement gate rejects, and repeated drift terminates. */
export const CHECK_ROUND_SCOPE_DRIFT = "round_scope_drift";
/** v3.5: The ACTIVE contract is still open (not completed, not blocked)
 *  while a different contract was proposed — the proposal is ignored until
 *  the active one closes. Warn: the walker still ignores it; this only
 *  surfaces the otherwise-silent state. */
export const CHECK_CONTRACT_PREMATURE = "contract_premature";
/** v3.7.1: A cited gate (evaluation.gate_ids) is not approved. Opt-in:
 *  checked ONLY when policy.gate.enabled — citations are meaningless when
 *  the gate layer is off. Error → enforcement rejects the round. */
export const CHECK_USER_GATE_UNRESOLVED = "user_gate_unresolved";
export const CHECK_DOMAIN = {
    // ── evaluation_consistency ────────────────────────────────────────────────
    [CHECK_SUCCESS_WITH_REMAINING_CRITERIA]: "evaluation_consistency",
    [CHECK_OUTCOME_SUCCESS_CONTRADICTION]: "evaluation_consistency",
    [CHECK_BLOCKED_WITHOUT_BLOCKER]: "evaluation_consistency",
    [CHECK_RETROACTIVE_CLAIM_BAD_ROUND]: "evaluation_consistency",
    [CHECK_RETROACTIVE_CLAIM_UNVERIFIED]: "evaluation_consistency",
    [CHECK_DUPLICATE_CONSTRAINT_DISCOVERY]: "evaluation_consistency",
    [CHECK_RECURRING_VIOLATION]: "evaluation_consistency",
    [CHECK_RETRACT_FRESH_CONSTRAINT]: "evaluation_consistency",
    // ── evidence_integrity ────────────────────────────────────────────────────
    [CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE]: "evidence_integrity",
    [CHECK_CRITERIA_CLAIMS_UNVERIFIED]: "evidence_integrity",
    [CHECK_EVIDENCE_INTEGRITY]: "evidence_integrity",
    [CHECK_REQUIRED_COMMAND_FAILED]: "evidence_integrity",
    [CHECK_COMMAND_EVIDENCE_MISMATCH]: "evidence_integrity",
    [CHECK_VERIFICATION_ENTRYPOINT_MODIFIED]: "evidence_integrity",
    [CHECK_TEST_FILES_MODIFIED]: "evidence_integrity",
    // ── plan_contract ─────────────────────────────────────────────────────────
    [CHECK_CONTRACT_ITEMS_UNVERIFIED]: "plan_contract",
    [CHECK_ROUND_SCOPE_DRIFT]: "plan_contract",
    [CHECK_CONTRACT_PREMATURE]: "plan_contract",
    // v3.7.1: cited-gate authorization conformance (opt-in blocking layer).
    [CHECK_USER_GATE_UNRESOLVED]: "plan_contract",
    // ── progress_recovery ─────────────────────────────────────────────────────
    [CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED]: "progress_recovery",
};
// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════
// ── v3.3: Round Contract scope matching ─────────────────────────────────────
/** Normalize a contract scope entry: backslashes → forward slashes, strip
 *  leading "./", trim, strip trailing slashes. "." / "./" / "" normalize to
 *  "" = the repository root (everything is in scope). */
export function normalizeScopeEntry(path) {
    let s = path.replace(/\\/g, "/").trim();
    while (s.startsWith("./"))
        s = s.slice(2);
    if (s === "." || s === "")
        return "";
    while (s.endsWith("/"))
        s = s.slice(0, -1);
    return s;
}
/** Whether a git-diff file path falls inside any declared scope entry:
 *  exact file match, or the file lives under a declared directory. The ""
 *  entry (repo root) matches everything. Git paths are always workspace-
 *  relative with forward slashes. */
export function isFileInScope(file, scope) {
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
export function collectOutOfScopeFiles(files, scope) {
    return files.filter((file) => !isFileInScope(file, scope));
}
/** v3.3: Detect verification-domain tampering for a command observation.
 *  entrypointModified — a workspace file the command depends on changed this
 *  round: the runtime executed a script the agent just rewrote, so the
 *  "machine observation" has no stable baseline. testFilesModified — the
 *  round changed test files (isTestFile): normal in TDD, so warn-only; the
 *  command result stays usable. Pure derivation — no fs access. */
function commandTampered(observation, gitObservation) {
    if (!gitObservation)
        return { entrypointModified: false, testFilesModified: false };
    const gitFiles = new Set(gitObservation.files);
    const entrypoints = observation.kind === "command"
        ? observation.data.entrypointFiles ?? []
        : [];
    const entrypointModified = entrypoints.some((file) => gitFiles.has(file));
    const testFilesModified = [...gitFiles].some((file) => isTestFile(file));
    return { entrypointModified, testFilesModified };
}
/** v3.8: The single machine-backed predicate lives in evidence-provider.ts.
 *  This wrapper resolves the round's git observation once for a collection. */
function passedAfterCommand(observations) {
    const git = observations.find((item) => item.providerId === "git") ?? null;
    const changed = git ? new Set(git.files) : null;
    return observations.find((item) => isPassedAfterObservation(item, changed)) ?? null;
}
/** v3.5: Names of commands observed passing in the after-phase this round.
 *  Tampered commands (entrypoint changed this round) are not machine
 *  evidence and are excluded — the same predicate passedAfterCommand uses. */
function passedPlanCommandNames(observations) {
    const git = observations.find((item) => item.providerId === "git") ?? null;
    const changed = git ? new Set(git.files) : null;
    const names = new Set();
    for (const observation of observations) {
        if (!isPassedAfterObservation(observation, changed))
            continue;
        if (observation.kind !== "command")
            continue;
        if (observation.data.commandId.length > 0)
            names.add(observation.data.commandId);
    }
    return names;
}
/** v3.2: Derive the machine-verification status of a round. The verification
 *  capability is modeled explicitly (verified / unavailable / absent) instead
 *  of letting evidence-dependent checks silently disappear when snapshots are
 *  missing — the fix for the "weakest when it matters most" gap. */
export function deriveEvidenceStatus(selfEval, evidenceSnapshots) {
    const gitSnap = evidenceSnapshots.find((item) => item.providerId === "git") ?? null;
    const gitObserved = gitSnap !== null && gitSnap.files.length > 0;
    const command = passedAfterCommand(evidenceSnapshots);
    const commandVerified = command !== null;
    // testsMachineBacked: agent-reported tests_reported agree with a passed
    // command's parsed stdout (the same comparison checkCommandEvidenceIntegrity
    // performs — parseTestOutput lives in this module).
    let testsMachineBacked = false;
    const reported = selfEval.execution_report?.tests_reported;
    if (command && command.kind === "command" && reported) {
        const parsed = parseTestOutput(command.data.stdoutExcerpt ?? "");
        testsMachineBacked = parsed !== null &&
            parsed.passed === reported.passed &&
            parsed.failed === reported.failed &&
            parsed.skipped === reported.skipped;
    }
    // reportedFilesMatch: agent-reported files_changed equals the git diff set.
    let reportedFilesMatch = false;
    if (gitSnap && selfEval.execution_report) {
        const reportedSet = [...(selfEval.execution_report.files_changed ?? [])].sort();
        const actualSet = [...gitSnap.files].sort();
        reportedFilesMatch = reportedSet.length === actualSet.length &&
            reportedSet.every((file, index) => file === actualSet[index]);
    }
    // v3.3: git observation alone is no longer "verified" — the machine seeing
    // file changes is not the machine verifying success. Only a passed
    // after-phase command (observed by the runtime itself) upgrades a round.
    // Any other snapshot presence is "unavailable": the machine saw activity
    // (or nothing at all this round) but could not verify the success claim,
    // so R8 warns and trust drops (v3.6: merged success_unverified semantics).
    const providerStatus = evidenceSnapshots.length === 0
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
/** Per-round machine progress over decoded committed history. */
export function machineProgressSeries(vaultEntries, currentRound, lookback) {
    return machineGitMotionSeries(committedRoundsFromEntries(vaultEntries, currentRound), currentRound, lookback);
}
// ═══════════════════════════════════════════════════════════════════════════
// Individual checks — each returns a VerificationFlag or null
// ═══════════════════════════════════════════════════════════════════════════
function checkSuccessWithRemainingCriteria(selfEval) {
    if (!effectiveSuccess(selfEval))
        return null;
    const remaining = claimedRemainingCriteria(selfEval.execution_report);
    if (remaining.length === 0)
        return null;
    return makeVerificationFlag({
        severity: "error",
        field: "success",
        check: CHECK_SUCCESS_WITH_REMAINING_CRITERIA,
        detail: `Agent claims success but ${remaining.length} criteria remain unmet: ` +
            remaining.slice(0, 3).join("; "),
    });
}
/** v2.12: Criteria reported met but none machine-verified. The agent puts
 *  completed criteria into the ledger, but no passing test evidence or
 *  command snapshot backs them. Warn — completion still counts, but the
 *  next prompt tells the agent its claims are unverified. This is the
 *  mild form of the 3.x criterion-specific completion rule. */
function checkUnverifiedCriteriaClaims(selfEval, claimView) {
    const met = claimedMetCriteria(selfEval.execution_report);
    if (met.length === 0)
        return null;
    if (claimView.verifiedCount > 0 || claimView.hasMachineEvidence)
        return null;
    return makeVerificationFlag({
        severity: "warn",
        field: "execution_report",
        check: CHECK_CRITERIA_CLAIMS_UNVERIFIED,
        detail: `${met.length} criteria reported met but none machine-verified ` +
            "(no passing test evidence or command snapshot)",
    });
}
/** Declared outcome vs the core success flag — one check id for the whole
 *  axis (v3.7: the former success_claim_conflict warn direction merged here).
 *  A declared success with success=false is a self-contradiction (error);
 *  success=true with a non-success outcome is an inconsistent claim (warn).
 *  Also: outcome==="blocked" without a blocker description gets a warn so the
 *  next prompt asks for it. */
function checkOutcomeConsistency(selfEval) {
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
            check: CHECK_OUTCOME_SUCCESS_CONTRADICTION,
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
function checkRetroactiveClaims(selfEval, vaultEntries, currentRound) {
    const claims = selfEval.retroactiveClaims;
    if (!claims || claims.length === 0)
        return null;
    const loopId = vaultEntries.find((entry) => typeof entry.loop_id === "string")
        ?.loop_id;
    const flags = [];
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
        if (!loopId)
            continue; // no vault context → cannot verify (fail-open)
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
        const paths = extractFilePathTokens(claim.claim);
        const unverified = paths.filter((path) => !observed.some((file) => file === path || file.endsWith(path) || path.endsWith(file)));
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
/** v2.12/v3.6/v3.7: success without machine backing — the single
 *  "success evidence" semantic. Two arms, evaluated in order:
 *  1. Empty/missing-evidence arm (v3.7: absorbed the enforcement-only
 *     empty_success rule): success=true with NO execution_report at all, or
 *     with files_changed empty AND tests_reported null, is an error
 *     unconditionally — BEFORE the providerStatus early-exit, so a passed
 *     command never rescues it (execution_report stays mandatory), and
 *     no declared no_change_reason downgrades it ("no change" with literally
 *     no evidence recorded is still an unbacked claim).
 *  2. Claims arm (v3.6): success=true but the runtime observed no machine
 *     evidence for it. The trigger is the runtime-derived providerStatus
 *     (verified / unavailable / absent) — "verified" requires an UNTAMPERED
 *     passed after-command, so an entrypoint-tampered command no longer
 *     counts as machine evidence. Severity follows evidence.machine_backed_
 *     success — "required" rejects (error), "warn" tolerates with a warn
 *     (round commits, success excluded from the trajectory, trust drops). A
 *     declared no_change_reason is the honest escape hatch: it downgrades to
 *     info — honored only while NO enabled verification command is
 *     configured (machine verification was structurally impossible); a
 *     configured command closes the escape. no_change_reason is honored HERE
 *     ONLY — contract checks refuse it. */
function checkSuccessWithoutVerifiedEvidence(selfEval, status) {
    if (!effectiveSuccess(selfEval))
        return null;
    // v3.7: empty/missing-evidence arm (ex-R3 empty_success posture).
    const ev = selfEval.execution_report;
    if (!ev || ((ev.files_changed ?? []).length === 0 && ev.tests_reported === null)) {
        return makeVerificationFlag({
            severity: "error",
            field: "success",
            check: CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE,
            detail: ev
                ? "Agent claims success but execution_report shows no files changed " +
                    "and no tests were run. There is no verifiable evidence of work."
                : "Agent claims success but provided no execution_report. " +
                    "Every successful round MUST include execution_report with " +
                    "files_changed, tests_reported, and progress_estimate.",
        });
    }
    // Claims arm (v3.6).
    if (status.providerStatus === "verified")
        return null;
    // M2 (v3.7.x): the no_change_reason escape is only honest when machine
    // verification was STRUCTURALLY impossible. With an enabled verification
    // command configured, the runtime had a machine-verifiable path for this
    // round — a declared reason cannot waive it (that would let an agent
    // dodge the configured verification by writing a sentence, even while git
    // observed real file changes). Verification-less policies (the default:
    // commands: []) keep the escape: there is genuinely nothing to run.
    const verificationConfigured = getPolicy().evidence.commands.some((command) => command.enabled);
    const noChange = !verificationConfigured &&
        typeof selfEval.no_change_reason === "string" &&
        selfEval.no_change_reason.trim().length > 0;
    // v3.8: an unbacked success claim is "机器观察不足", not a contradiction —
    // the round COMMITS with the claim recorded as insufficient, and the
    // success stays out of the success trajectory (shouldPushSuccess keys on
    // this warn). The bounded verification-debt row is what eventually acts on
    // a persistent pattern. `no_change_reason` stays info, and only works when
    // machine verification was structurally impossible (no enabled command).
    // A success claim with NO execution_report at all is the other arm and
    // remains an unconditional error.
    const severity = noChange ? "info" : "warn";
    return makeVerificationFlag({
        severity,
        field: "success",
        check: CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE,
        detail: noChange
            ? "success with zero verified claims (no_change_reason declared)"
            : `success declared but no machine-verified observation this round (providerStatus: ${status.providerStatus})`,
    });
}
function checkDuplicateConstraintDiscovery(selfEval, prevSelfEval, olderViolations) {
    const discovered = selfEval.discovered_constraints;
    if (!discovered || discovered.length === 0)
        return null;
    // Collect all previously-known constraints
    const known = new Set();
    for (const v of olderViolations)
        known.add(v.toLowerCase().trim());
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
function checkRecurringViolation(selfEval, prevSelfEval, vaultEntries, currentRound) {
    const currViols = selfEval.constraint_violations;
    if (!currViols || currViols.length === 0)
        return null;
    // Build the violation history: [round N-2, round N-1, round N]
    const violationsByRound = [];
    // Round N-2 violations come from the vault entry for round N-1
    // (persistLoopLineage stores the PREVIOUS round's violations on each entry)
    if (currentRound >= 3) {
        const entryNMinus1 = vaultEntries.find((e) => entryRound(e) === currentRound - 1);
        if (entryNMinus1) {
            const viols = entryViolations(entryNMinus1);
            if (viols.length)
                violationsByRound.push(viols.map((v) => v.toLowerCase().trim()));
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
    if (violationsByRound.length < 3)
        return null;
    // Check each current violation against the previous 2 rounds
    const [rNMinus2, rNMinus1, rN] = violationsByRound.slice(-3);
    for (const v of rN) {
        if (rNMinus1.includes(v) && rNMinus2.includes(v)) {
            return makeVerificationFlag({
                severity: "error",
                field: "constraint_violations",
                check: CHECK_RECURRING_VIOLATION,
                detail: `Constraint violation "${v}" has appeared in 3 consecutive rounds ` +
                    `(rounds ${currentRound - 2}–${currentRound}) without resolution`,
            });
        }
    }
    return null;
}
function checkRetractFreshConstraint(selfEval, prevSelfEval, currentRound) {
    const retracted = selfEval.retracted_constraints;
    if (!retracted || retracted.length === 0)
        return null;
    if (!prevSelfEval)
        return null;
    const lastRoundDiscoveries = new Set();
    for (const d of prevSelfEval.discovered_constraints ?? []) {
        lastRoundDiscoveries.add(d.toLowerCase().trim());
    }
    for (const r of retracted) {
        if (lastRoundDiscoveries.has(r.toLowerCase().trim())) {
            return makeVerificationFlag({
                severity: "warn",
                field: "retracted_constraints",
                check: CHECK_RETRACT_FRESH_CONSTRAINT,
                detail: `Retracting constraint "${r}" that was just discovered in round ` +
                    `${currentRound - 1} — may indicate rapid flip-flopping`,
            });
        }
    }
    return null;
}
/** v1.18: Cross-validate agent-reported files_changed against git evidence
 *  from the configured evidence providers (MachineObservation array). */
function checkEvidenceIntegrity(selfEval, evidenceSnapshots) {
    if (!selfEval.execution_report)
        return null;
    if (evidenceSnapshots.length === 0)
        return null;
    const gitSnap = evidenceSnapshots.find((s) => s.providerId === "git");
    if (!gitSnap)
        return null;
    const reported = [...(selfEval.execution_report.files_changed ?? [])].sort();
    const actual = [...gitSnap.files].sort();
    if (reported.length === 0 && actual.length === 0)
        return null;
    if (reported.length === 0 && actual.length > 0) {
        return makeVerificationFlag({
            severity: "warn",
            field: "files_changed",
            check: CHECK_EVIDENCE_INTEGRITY,
            detail: `Agent reported no files changed but evidence shows: ${actual.join(", ")}`,
        });
    }
    const ghostFiles = reported.filter((f) => !actual.includes(f));
    const missedFiles = actual.filter((f) => !reported.includes(f));
    if (ghostFiles.length > 0 || missedFiles.length > 0) {
        const parts = [];
        if (ghostFiles.length > 0)
            parts.push(`unconfirmed: [${ghostFiles.join(", ")}]`);
        if (missedFiles.length > 0)
            parts.push(`unreported: [${missedFiles.join(", ")}]`);
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
function checkRequiredCommandEvidence(selfEval, evidenceSnapshots) {
    if (!effectiveSuccess(selfEval))
        return null;
    for (const snapshot of evidenceSnapshots) {
        if (snapshot.kind !== "command")
            continue;
        if (snapshot.phase !== "after" || snapshot.data.required !== true)
            continue;
        const status = snapshot.status;
        if (status === "passed")
            continue;
        const name = snapshot.data.commandId;
        const exitCode = typeof snapshot.data.exitCode === "number"
            ? ` (exit ${snapshot.data.exitCode})`
            : "";
        return makeVerificationFlag({
            severity: "error",
            field: "execution_report",
            check: CHECK_REQUIRED_COMMAND_FAILED,
            detail: `Agent claims success but required command "${name}" ${String(status)}${exitCode}`,
        });
    }
    return null;
}
// ── Test output parsing ────────────────────────────────────────────────────
/** Whether a changed path looks like a test file. */
function isTestFile(path) {
    return /\.(test|spec)\.[a-z0-9]+$/i.test(path) ||
        /(^|[\\/])tests?[\\/]/i.test(path) ||
        /_test\.[a-z0-9]+$/i.test(path);
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
export function parseTestOutput(stdout) {
    if (!stdout)
        return null;
    const tail = stdout.length > 2000 ? stdout.slice(-2000) : stdout;
    let match;
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
/** Cross-validate agent-reported tests_reported against command evidence output.
 *
 *  For each command provider whose status is "passed" and output is not
 *  truncated, attempts to parse test counts from stdout. Mismatched counts
 *  produce a warn-level flag; failures hidden by the agent (reported 0 failed
 *  when the command shows >0) produce an error-level flag.
 *
 *  Non-command evidence providers are skipped (no structural cross-check is
 *  defined for them yet). */
function checkCommandEvidenceIntegrity(selfEval, evidenceSnapshots) {
    const reported = selfEval.execution_report?.tests_reported;
    if (!reported)
        return null;
    for (const snapshot of evidenceSnapshots) {
        if (snapshot.kind !== "command")
            continue;
        if (snapshot.status !== "passed")
            continue;
        if (snapshot.data.truncated === true)
            continue;
        const stdout = typeof snapshot.data.stdoutExcerpt === "string" ? snapshot.data.stdoutExcerpt : "";
        const parsed = parseTestOutput(stdout);
        if (!parsed)
            continue;
        const mismatches = [];
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
        const name = snapshot.data.commandId;
        // Agent hides failures → error. Other mismatch → warn.
        const severity = parsed.failed > 0 && reported.failed === 0 ? "error" : "warn";
        return makeVerificationFlag({
            severity,
            field: "tests_reported",
            check: CHECK_COMMAND_EVIDENCE_MISMATCH,
            detail: `Agent tests_reported don't match "${name}" output: ${mismatches.join("; ")}`,
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
function checkVerificationDomainIntegrity(evidenceSnapshots) {
    const git = evidenceSnapshots.find((snapshot) => snapshot.providerId === "git") ?? null;
    if (!git)
        return null;
    for (const snapshot of evidenceSnapshots) {
        if (!isRecord(snapshot.data) || snapshot.kind !== "command")
            continue;
        if (snapshot.phase !== "after")
            continue;
        const { entrypointModified, testFilesModified } = commandTampered(snapshot, git);
        if (!entrypointModified && !testFilesModified)
            continue;
        const name = snapshot.data.commandId;
        if (entrypointModified) {
            return makeVerificationFlag({
                severity: "error",
                field: "execution_report",
                check: CHECK_VERIFICATION_ENTRYPOINT_MODIFIED,
                detail: `Verification command "${name}" entrypoint changed this round — ` +
                    "its result cannot be trusted as machine evidence. Keep the " +
                    "verification command stable or resubmit the same round with the " +
                    "entrypoint unchanged.",
            });
        }
        return makeVerificationFlag({
            severity: "warn",
            field: "execution_report",
            check: CHECK_TEST_FILES_MODIFIED,
            detail: `Test files changed in the same round command "${name}" passed — ` +
                "confirm the tests still verify the task claims.",
        });
    }
    return null;
}
/** v2.13: After a backtrack, check that the agent restored the workspace
 *  before working. Two arms:
 *
 *  1. Machine arm (M3, error): a skipped file whose CURRENT git fingerprint
 *     still equals the fingerprint recorded at its failed round was never
 *     touched since the rollback — the workspace was provably not restored.
 *     Restored or re-modified files change fingerprint and can never be
 *     misjudged by this arm.
 *
 *  2. Claims arm (warn only): the agent's files_changed overlaps the skipped
 *     list. A self-report alone cannot distinguish a restored-then-redone
 *     file from a never-restored one — a legitimate multi-file redo would
 *     otherwise be falsely terminated — so overlap is guidance, not a
 *     verdict. (The old error tier for >= 3 overlapping files was removed
 *     for exactly this reason: it fired on honest redos.) */
function checkBacktrackWorkspaceRestore(selfEval, backtrackSkippedFiles, backtrackSkippedFingerprints = {}, evidenceSnapshots = []) {
    // Machine arm — untouched-since-rollback proof, independent of claims.
    const failedEntries = Object.entries(backtrackSkippedFingerprints);
    if (failedEntries.length > 0) {
        const git = evidenceSnapshots.find((snapshot) => snapshot.kind === "git" && isRecord(snapshot.data.fingerprints));
        const currentFingerprints = git && git.kind === "git"
            ? git.data.fingerprints
            : null;
        if (currentFingerprints) {
            const untouched = failedEntries
                .filter(([file, failedFp]) => currentFingerprints[file] === failedFp)
                .map(([file]) => file)
                .sort();
            if (untouched.length > 0) {
                return makeVerificationFlag({
                    severity: "error",
                    field: "workspace",
                    check: CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED,
                    detail: `File(s) from the failed rounds are byte-identical to their ` +
                        `state at the rollback: ${untouched.slice(0, 5).join(", ")}. The ` +
                        `workspace was never restored — restore it to the restore point ` +
                        `(git checkout/reset) before redoing the work.`,
                });
            }
        }
    }
    const ev = selfEval.execution_report;
    if (!ev || (ev.files_changed ?? []).length === 0)
        return null;
    // Claims arm — overlap as guidance only.
    const overlap = (ev.files_changed ?? []).filter((f) => backtrackSkippedFiles.some((sf) => sf === f || f.endsWith(sf) || sf.endsWith(f)));
    if (overlap.length === 0)
        return null;
    return makeVerificationFlag({
        severity: "warn",
        field: "files_changed",
        check: CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED,
        detail: `Agent modified files that overlap with skipped rounds: ` +
            `${overlap.join(", ")}. Verify the workspace was restored.`,
    });
}
/** v2.12: After a backtrack, the working tree must return to the restore
 *  point's git HEAD. Compares the first 12 characters (short hash), matching
 *  how git itself disambiguates. */
function checkBacktrackGitHeadRestore(evidenceSnapshots, backtrackTargetGitHead) {
    if (!backtrackTargetGitHead)
        return null;
    const git = evidenceSnapshots.find((snapshot) => snapshot.providerId === "git" && isRecord(snapshot.data) &&
        typeof snapshot.data.head === "string");
    if (!git)
        return null; // git unavailable → cannot verify → skip (fail-open)
    const currentHead = git.data.head;
    if (currentHead.length === 0)
        return null;
    if (currentHead.slice(0, 12) === backtrackTargetGitHead.slice(0, 12))
        return null;
    return makeVerificationFlag({
        severity: "error",
        field: "workspace",
        check: CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED,
        detail: `Workspace HEAD (${currentHead.slice(0, 12)}) does not match the ` +
            `backtrack restore commit (${backtrackTargetGitHead.slice(0, 12)}). ` +
            `Restore the working tree before continuing.`,
    });
}
// ═══════════════════════════════════════════════════════════════════════════
// v3.8 — Round Contract checks (all silent when no contract is declared)
//
// The item model moved closure to the runtime: an item is verified only when
// its bound commands were observed passing (untampered, same config) in the
// claiming round. A claimed-but-unbacked item is therefore `insufficient`
// (recorded, never a rejection), and a premature closure is structurally
// impossible. The checks below only surface state the agent must see.
// ═══════════════════════════════════════════════════════════════════════════
/** The round changed files outside the ACTIVE contract's declared scope.
 *  Git diff files are the machine-authoritative "what actually changed" set.
 *  Silent when no active contract exists or it declares no scope. */
function checkRoundScopeDrift(activeContract, evidenceSnapshots) {
    if (!activeContract)
        return null;
    if (activeContract.scope.length === 0)
        return null;
    const git = evidenceSnapshots.find((snapshot) => snapshot.providerId === "git");
    if (!git)
        return null; // git unavailable → cannot observe → fail open
    const outOfScope = collectOutOfScopeFiles(git.files, activeContract.scope);
    if (outOfScope.length === 0)
        return null;
    return makeVerificationFlag({
        severity: "warn",
        field: "round_contract",
        check: CHECK_ROUND_SCOPE_DRIFT,
        detail: `Files changed outside the active contract's declared scope` +
            (outOfScope.length > 5
                ? ` (${outOfScope.length} total, showing 5): ${outOfScope.slice(0, 5).join(", ")}`
                : `: ${outOfScope.join(", ")}`) +
            `. Revert them, or close the active contract and declare the extended scope in a new proposal.`,
    });
}
/** v3.8: Claimed-but-unverified contract items. The round COMMITS — the debt
 *  is surfaced (prompt, state file, handoff) and the enforcement gate's
 *  verification-debt row handles a persistent pattern. */
function checkContractItemsUnverified(statuses) {
    if (statuses.insufficientCount === 0)
        return null;
    const unverified = statuses.items
        .filter((item) => item.status === "insufficient")
        .slice(0, 3)
        .map((item) => item.itemId);
    return makeVerificationFlag({
        severity: "warn",
        field: "round_contract",
        check: CHECK_CONTRACT_ITEMS_UNVERIFIED,
        detail: `${statuses.insufficientCount} contract item(s) claimed met but not machine-verified: ` +
            `${unverified.join(", ")}. Run the bound command(s) or report the item as remaining.`,
    });
}
/** A different contract proposed while the ACTIVE contract is still open. The
 *  walker ignores the premature proposal — this warn only makes the ignored
 *  state visible. Silent when the active contract is closed (all items
 *  verified, or outcome=blocked), when no proposal is submitted, or when the
 *  proposal is a restate (content equality, never id equality). */
function checkContractPremature(activeContract, statuses, selfEval) {
    if (!activeContract)
        return null;
    if (statuses.closure !== "open")
        return null; // closed
    if (selfEval.outcome === "blocked")
        return null; // closed
    const proposal = selfEval.round_contract;
    if (!proposal)
        return null;
    if (sameContract(proposal, activeContract))
        return null; // restate → continue
    return makeVerificationFlag({
        severity: "warn",
        field: "round_contract",
        check: CHECK_CONTRACT_PREMATURE,
        detail: "The ACTIVE Round Contract is still open (not every item verified, not blocked) " +
            "while a different contract was proposed — it is ignored until the active " +
            "contract closes. Restate the active contract unchanged to continue it.",
    });
}
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
/** v3.7.1: Opt-in round blocking for the gate layer. For every gate id the
 *  round cites (gate_ids), the gate_opened record must exist, must be a
 *  USER gate, and must have an approved gate_decision. Error flags list
 *  every failing id with a reason. Entirely skipped when the feature is
 *  disabled — there is nothing to cite against. */
function checkUserGateUnresolved(selfEval, gateEntries) {
    if (!getPolicy().gate.enabled)
        return null;
    const cited = (selfEval.gate_ids ?? []).filter((id) => typeof id === "string");
    if (cited.length === 0)
        return null;
    const opened = new Set();
    const userKind = new Set();
    const approved = new Set();
    for (const entry of gateEntries) {
        if (entry.task_type === "gate_opened" && typeof entry.gate_id === "string") {
            opened.add(entry.gate_id);
            // v3.7.1: structured records declare gate_kind; legacy flat records
            // (blocked-round auto-records) classify their stored action text.
            if (entry.gate_kind === "user") {
                userKind.add(entry.gate_id);
            }
            else if (typeof entry.gate_action === "string") {
                let kind = null;
                try {
                    kind = preflightStructuredGate(JSON.parse(entry.gate_action)).kind;
                }
                catch {
                    kind = deriveGate(entry.gate_action).gate.kind;
                }
                if (kind === "user")
                    userKind.add(entry.gate_id);
            }
        }
        if (entry.task_type === "gate_decision" && entry.approved === true &&
            typeof entry.gate_id === "string") {
            approved.add(entry.gate_id);
        }
    }
    const failures = [];
    for (const gateId of cited) {
        if (!opened.has(gateId))
            failures.push(`${gateId} (not_found)`);
        else if (!userKind.has(gateId))
            failures.push(`${gateId} (not_user_gate)`);
        else if (!approved.has(gateId))
            failures.push(`${gateId} (not_approved)`);
    }
    if (failures.length === 0)
        return null;
    return makeVerificationFlag({
        severity: "error",
        field: "evaluation",
        check: CHECK_USER_GATE_UNRESOLVED,
        detail: `The round cites gates without an approved human decision: ` +
            `${failures.join("; ")}. Obtain approval via loopforge_gate_check / ` +
            `loopforge_gate_resolve before claiming the action is done.`,
    });
}
export function verifySelfEvaluation(selfEval, currentRound, vaultEntries, prevSelfEval = null, evidenceSnapshots = [],
/** v2.13: Files from skipped backtrack rounds. If the agent's
 *  files_changed overlaps significantly with these, the workspace
 *  was not properly restored before working. */
backtrackSkippedFiles = [],
/** M3 (v3.7.x): skipped-file git fingerprints at their failed rounds —
 *  machine proof of "untouched since the rollback" for the restore check. */
backtrackSkippedFingerprints = {},
/** v2.12: Git HEAD commit of the backtrack restore point. When set, the
 *  current git snapshot must sit at this commit — otherwise the workspace
 *  was not restored and the round cannot be accepted. */
backtrackTargetGitHead,
/** v3.7.1: gate records (task_type gate_opened / gate_decision) live
 *  outside the round prefix — the caller passes them in explicitly. */
gateEntries = []) {
    const flags = [];
    // Collect violations from all previous vault entries for duplicate-discovery
    // and other checks that need deeper history.
    const olderViolations = [];
    for (const entry of vaultEntries) {
        for (const v of entryViolations(entry))
            olderViolations.push(v);
    }
    // v3.4: The ACTIVE contract this round executed under — derived from the
    // committed :feedback evals of earlier rounds. The submission's own
    // round_contract is a PROPOSAL for the next round and never participates
    // (the eval under verification is not yet committed, so it structurally
    // cannot influence the derivation).
    const committedRounds = committedRoundsFromEntries(vaultEntries, currentRound);
    const activeContract = deriveActiveRoundContract(committedRounds);
    // v3.8: The item-level status of the ACTIVE contract for THIS round — the
    // same reducer the compile path, audit, and explain consume.
    const contractStatuses = deriveContractItemStatuses({
        contract: activeContract,
        rounds: committedRounds,
        currentRound,
        currentReport: selfEval.execution_report ?? null,
        currentObservations: evidenceSnapshots,
        commands: getPolicy().evidence.commands ?? [],
    });
    // v2.12: Derived claim provenance — which reported criteria completions
    // are backed by machine evidence (pure derivation, not persisted).
    const claimView = deriveClaimView(selfEval, evidenceSnapshots);
    // v3.2: Runtime machine-verification status (git observed / command passed /
    // absent). v3.6: feeds the merged R8 check (providerStatus lens) that
    // never self-skips.
    const evidenceStatus = deriveEvidenceStatus(selfEval, evidenceSnapshots);
    // Run all checks
    // v3.3.1: a check may return several flags (checkRetroactiveClaims raises
    // one per offending claim) — the previous single-flag contract truncated
    // the list at the first problem, hiding every other bad retroactive claim
    // from the agent until the next round.
    const checks = [
        () => checkSuccessWithRemainingCriteria(selfEval),
        // v2.12/v3.6/v3.7: the single success-evidence semantic — empty/missing-
        // evidence arm (ex-R3) + claims arm (providerStatus lens, tamper-aware)
        () => checkSuccessWithoutVerifiedEvidence(selfEval, evidenceStatus),
        // v2.12: criteria met but none machine-verified (mild criterion-specific rule)
        () => checkUnverifiedCriteriaClaims(selfEval, claimView),
        // Declared outcome vs the required core success flag.
        () => checkOutcomeConsistency(selfEval),
        // v2.12: retroactive claims against prior rounds
        () => checkRetroactiveClaims(selfEval, vaultEntries, currentRound),
        () => checkDuplicateConstraintDiscovery(selfEval, prevSelfEval, olderViolations),
        () => checkRecurringViolation(selfEval, prevSelfEval, vaultEntries, currentRound),
        () => checkRetractFreshConstraint(selfEval, prevSelfEval, currentRound),
        // v1.18: Cross-validate agent-reported files_changed against git evidence
        () => checkEvidenceIntegrity(selfEval, evidenceSnapshots),
        () => checkRequiredCommandEvidence(selfEval, evidenceSnapshots),
        // v2.0: Cross-validate agent-reported tests_reported against command output
        () => checkCommandEvidenceIntegrity(selfEval, evidenceSnapshots),
        // v3.3: Verification domain integrity — command entrypoint / test files
        // changed in the same round the command ran
        () => checkVerificationDomainIntegrity(evidenceSnapshots),
        // v2.13: Post-backtrack workspace restore check
        () => checkBacktrackWorkspaceRestore(selfEval, backtrackSkippedFiles, backtrackSkippedFingerprints, evidenceSnapshots),
        // v2.12: Post-backtrack git HEAD restore check
        () => checkBacktrackGitHeadRestore(evidenceSnapshots, backtrackTargetGitHead),
        // v3.8: Round Contract checks over the derived item model. Declaration
        // quality is enforced structurally (contract_invalid) before the round
        // advances, so the gate only reports execution state: scope drift,
        // claimed-but-unverified items, and an ignored replacement proposal.
        () => checkRoundScopeDrift(activeContract, evidenceSnapshots),
        () => checkContractItemsUnverified(contractStatuses),
        () => checkContractPremature(activeContract, contractStatuses, selfEval),
        // v3.7.1: opt-in gate-layer blocking (skipped when disabled)
        () => checkUserGateUnresolved(selfEval, gateEntries),
    ];
    for (const run of checks) {
        const result = run();
        if (Array.isArray(result))
            flags.push(...result);
        else if (result)
            flags.push(result);
    }
    // Determine verdict from the most severe flag present
    const hasError = flags.some((f) => f.severity === "error");
    const hasWarn = flags.some((f) => f.severity === "warn");
    let verdict;
    if (hasError) {
        verdict = "contradicted";
    }
    else if (hasWarn) {
        verdict = "suspect";
    }
    else {
        verdict = "trusted";
    }
    return makeVerificationResult({ verdict, flags });
}
//# sourceMappingURL=verification-gate.js.map