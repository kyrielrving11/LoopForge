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
import type {
  EnforcementResult,
  SelfEvaluation,
  VerificationFlag,
  VerificationResult,
} from "./protocol.js";
import { makeEnforcementResult } from "./protocol.js";
import { entryRound, machineProgressSeries, hasNewCriteriaCompletion, CHECK_SUCCESS_WITH_REMAINING_CRITERIA, CHECK_RECURRING_VIOLATION, CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE, CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED, CHECK_REQUIRED_COMMAND_FAILED, CHECK_COMMAND_EVIDENCE_MISMATCH, CHECK_OUTCOME_SUCCESS_CONTRADICTION, CHECK_VERIFICATION_ENTRYPOINT_MODIFIED, CHECK_PREMATURE_BOUNDARY, CHECK_ROUND_SCOPE_DRIFT, CHECK_CONTRACT_COMPLETION_UNVERIFIED } from "./verification-gate.js";
import { effectiveSuccess } from "./self-eval.js";
import { deriveConstraintId, deriveCriterionId, deriveSubGoalId } from "./loop-compiler.js";
import { getPolicy } from "./policy.js";
import { STABLE_ID_RE, isRecord } from "./token-utils.js";
import { isProcessResult } from "./round-transaction.js";
import type { RoundProcessResult } from "./round-coordinator.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Extract progress_estimate from a vault entry's execution_evidence.
 *  Returns null if no execution evidence is available. */
function entryProgress(entry: VaultEntry): number | null {
  const evidence = entry.execution_evidence as Record<string, unknown> | undefined;
  if (!evidence) return null;
  const pe = evidence.progress_estimate;
  return typeof pe === "number" ? pe : null;
}

/** Collect progress estimates from vault entries into a round→estimate map.
 *  Shared by R4 (progress_stall) and R5 (progress_stall_terminal). */
function collectProgressByRound(
  vaultEntries: VaultEntry[],
  currentRound: number,
): Map<number, number> {
  const progressByRound = new Map<number, number>();
  for (const entry of vaultEntries) {
    const rnd = entryRound(entry);
    if (rnd < 1 || rnd >= currentRound) continue;
    const pe = entryProgress(entry);
    if (pe !== null) progressByRound.set(rnd, pe);
  }
  return progressByRound;
}

/** v3.2.1: R4/R5 progress window — after a backtrack committed for this
 *  round, the agent's redo submission is the freshest data point. The
 *  pre-rollback history (which triggered the stall) stays in the vault and
 *  the redo does not commit while it is being evaluated, so without this
 *  the window never changes: a genuinely fixed redo is rejected forever and
 *  the loop dies in a spurious terminate. A redo that is STILL stalled
 *  keeps the window flat and hits the normal reject → terminate ladder. */
function progressWindow(
  vaultEntries: VaultEntry[],
  currentRound: number,
  selfEval: SelfEvaluation,
): Map<number, number> {
  const progressByRound = collectProgressByRound(vaultEntries, currentRound);
  if (hasCommittedBacktrack(vaultEntries, currentRound)) {
    const pe = selfEval.execution_evidence?.progress_estimate;
    if (typeof pe === "number") progressByRound.set(currentRound, pe);
  }
  return progressByRound;
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.10: Backtrack helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Extract the committed round decision's result from a vault entry.
 *  The round commit entry (`loop:<id>:r<N>:feedback`) carries the full
 *  decision under loop_lineage.round_transaction; lineage entries carry
 *  nothing at the top level. */
function committedRoundResult(entry: VaultEntry): RoundProcessResult | null {
  const lineage = isRecord(entry.loop_lineage) ? entry.loop_lineage : null;
  const rt = lineage && isRecord(lineage.round_transaction)
    ? lineage.round_transaction
    : null;
  if (!rt) return null;
  return isProcessResult(rt.result) ? rt.result : null;
}

/** True when a backtrack already committed at or after the current round —
 *  i.e. the loop is re-walking territory the system already rolled back
 *  once. Guards against the reject↔backtrack deadlock on persistent stalls. */
function hasCommittedBacktrack(
  vaultEntries: VaultEntry[],
  currentRound: number,
): boolean {
  return vaultEntries.some((entry) => {
    if (entryRound(entry) < currentRound) return false;
    return committedRoundResult(entry)?.action === "backtrack";
  });
}

/** Check whether a vault entry represents a "clean" round that can serve
 *  as a safe restore point. A clean round was accepted (not rejected)
 *  and had no error-level verification flags.
 *
 *  v3.2.1: judged by the COMMITTED decision and gate flags, not by the
 *  agent's self-reported success. A progress-stall round commits with
 *  success=false but is accepted and carries no error flags — it is a
 *  valid backtrack target (the most common backtrack trigger is exactly a
 *  run of such rounds). Rejected/terminated rounds never commit, and
 *  rolled-back rounds are excluded below. */
function isCleanRound(entry: VaultEntry): boolean {
  const committed = committedRoundResult(entry);
  // A rolled-back round (already backtracked) is not a valid restore point.
  if (committed?.action === "backtrack") return false;
  // Rejected/terminated rounds are not clean. (They never commit in the
  // real vault — this guards legacy or mixed-shape data.)
  if (committed && (committed.action === "reject" || committed.action === "terminate")) {
    return false;
  }
  // Rounds with error-level verification flags are not clean
  const flags = Array.isArray(entry.verification_flags)
    ? entry.verification_flags
    : committed?.verificationFlags ?? [];
  for (const f of flags) {
    if (
      f !== null && typeof f === "object" &&
      (f as Record<string, unknown>).severity === "error"
    ) return false;
  }
  return true;
}

/** Scan backwards from currentRound to find the most recent clean round.
 *  Collects discovered_constraints from skipped rounds along the way.
 *  Returns null when no clean round is found within maxDepth. */
export function findSafeRestorePoint(
  currentRound: number,
  vaultEntries: VaultEntry[],
  maxDepth: number,
): { round: number; skippedDiscoveries: string[] } | null {
  // v3.2.1: exclude compile-time lineage entries — every committed round
  // writes one (engine.ts hardcodes `success: true` on it, and it carries no
  // round_transaction), and it precedes the feedback entry in the flat view.
  // Treating it as a decision made every round look clean, so the restore
  // point was always currentRound-1: dirty/rejected rounds were never
  // skipped, depth > 1 never collected skippedDiscoveries, and the restore
  // prompt's file list (round-coordinator) was always empty.
  // v3.3.1: only entries that carry a committed decision (or evidence of
  // one) may rank as restore points. The v3.2.1 filter excluded compile-time
  // lineage entries, but event/journal entries (delegation journals, gate
  // records) also share the round number while carrying no decision and no
  // flags — they passed isCleanRound vacuously and could shadow the round's
  // real dirty feedback entry. A committed round's decision lives on its
  // :feedback entry (raw view) or on a lineage entry with a persisted
  // round_transaction (legacy merged shapes); everything else is not a
  // round outcome.
  const completed = vaultEntries
    .filter((e) => {
      const rnd = entryRound(e);
      if (rnd < 1 || rnd >= currentRound) return false;
      const tid = String(e.task_id ?? "");
      if (tid.endsWith(":feedback")) return true;
      const lin = isRecord(e.loop_lineage) ? e.loop_lineage : null;
      return lin !== null && isRecord(lin.round_transaction);
    })
    .sort((a, b) => entryRound(b) - entryRound(a)); // newest first

  const skippedDiscoveries: string[] = [];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const targetRound = currentRound - depth;
    if (targetRound < 1) break;
    const entry = completed.find((e) => entryRound(e) === targetRound);
    if (!entry) continue;

    // Collect discoveries from rounds we're about to skip (depth > 1)
    if (depth > 1) {
      for (let d = 1; d < depth; d++) {
        const skippedRound = currentRound - d;
        const skippedEntry = completed.find((e) => entryRound(e) === skippedRound);
        if (skippedEntry) {
          const discovered = Array.isArray(skippedEntry.discovered_constraints)
            ? skippedEntry.discovered_constraints.filter((v: unknown) => typeof v === "string")
            : [];
          for (const item of discovered) {
            if (!skippedDiscoveries.includes(item)) skippedDiscoveries.push(item);
          }
        }
      }
    }

    if (isCleanRound(entry)) {
      return { round: targetRound, skippedDiscoveries };
    }
  }

  return null;
}

/** v2.12: Git HEAD commit hash at the restore point. Read from the restore
 *  round's committed transaction snapshot (after evidence preferred, before
 *  evidence as fallback). Returns null when the round has no git snapshot
 *  or no committed feedback entry. */
export function findBacktrackTargetGitHead(
  restoreRound: number,
  vaultEntries: VaultEntry[],
): string | null {
  const feedback = vaultEntries.find((entry) =>
    String(entry.task_id ?? "") === `loop:${entry.loop_id}:r${restoreRound}:feedback`);
  const lineage = feedback && isRecord(feedback.loop_lineage)
    ? feedback.loop_lineage
    : null;
  const transaction = lineage && isRecord(lineage.round_transaction)
    ? lineage.round_transaction
    : null;
  const snapshot = transaction && isRecord(transaction.snapshot)
    ? transaction.snapshot
    : null;
  if (!snapshot) return null;
  const evidence = Array.isArray(snapshot.afterEvidence) && snapshot.afterEvidence.length > 0
    ? snapshot.afterEvidence as unknown[]
    : Array.isArray(snapshot.beforeEvidence)
      ? snapshot.beforeEvidence as unknown[]
      : [];
  for (const item of evidence) {
    if (!isRecord(item) || item.provider !== "git" || !isRecord(item.data)) continue;
    const head = item.data.head;
    if (typeof head === "string" && head.length > 0) return head;
  }
  return null;
}

/** Build the backtrack prompt injected at the top of the restored round.
 *
 *  v2.13: Includes concrete workspace restore instructions with affected
 *  file lists from skipped rounds. The agent must restore the working tree
 *  to the clean round's state before proceeding. */
export function buildBacktrackPrompt(
  fromRound: number,
  toRound: number,
  triggerRule: string,
  skippedDiscoveries: string[],
  /** v2.13: Files changed in the skipped rounds (from evidence snapshots).
   *  Used to show the agent exactly what needs to be reverted. */
  skippedFiles: string[] = [],
  /** v2.12: Git HEAD commit hash at the backtrack point (current HEAD).
   *  The agent must discard work back to the clean round's state. */
  gitHead?: string,
): string {
  const lines: string[] = [
    `## ⛔ Backtrack — Round ${fromRound} → Restored to Round ${toRound}`,
    "",
  ];

  // ── Why This Happened ────────────────────────────────────────────────
  if (triggerRule === "progress_stall") {
    lines.push(
      "### Why This Happened",
      "",
      `Progress stalled over rounds ${toRound + 1}–${fromRound}. ` +
      `The work done in those rounds produced no verifiable progress — ` +
      `no new files changed, no criteria met.`,
      "",
      "The approach used in those rounds **did not work**. It should not be repeated.",
      "",
    );
  } else if (triggerRule === "progress_stall_terminal") {
    lines.push(
      "### Why This Happened",
      "",
      `Progress was completely flat for multiple rounds leading up to Round ${fromRound}. ` +
      `The agent made **zero forward motion** — the task is not advancing.`,
      "",
      "A **radically different** strategy is needed. The previous approach produced nothing.",
      "",
    );
  }

  // ── v2.13: Workspace Restore ──────────────────────────────────────────
  lines.push(
    "### ⚠️ Workspace Restore Required",
    "",
    `Your working directory still contains changes from the **failed** ` +
    `rounds (${toRound + 1}–${fromRound}). You MUST discard those changes ` +
    `before starting Round ${toRound + 1}. Working on top of stale changes ` +
    `will cause the verification gate to reject your next submission.`,
    "",
  );

  if (skippedFiles.length > 0) {
    lines.push(
      "**Files modified in skipped rounds (must be reverted):**",
      "",
    );
    for (const f of skippedFiles.slice(0, 15)) {
      lines.push(`- \`${f}\``);
    }
    if (skippedFiles.length > 15) {
      lines.push(`- … and ${skippedFiles.length - 15} more files`);
    }
    lines.push("");
  }

  lines.push(
    "**To restore a clean workspace, run:**",
    "",
    "```bash",
    "# Option A: Discard all uncommitted changes (recommended)",
    "git checkout -- .",
    "git clean -fd",
    "",
    "# Option B: If you have unrelated work to keep",
    `git stash push -m "backtrack-safety-net-round-${fromRound}"`,
    "git checkout -- .",
    "git clean -fd",
    "```",
    "",
  );
  // v2.12: Restore to the exact commit observed at the clean round.
  if (gitHead) {
    lines.push(
      `**Restore to commit \`${gitHead.slice(0, 12)}\`** — the verification ` +
      "gate checks that your working tree returns to this commit before " +
      "accepting your next submission.",
      "",
      "```bash",
      "# Option C: If the failed rounds created commits, reset HEAD to the restore point",
      `git reset --hard ${gitHead.slice(0, 12)}`,
      "```",
      "",
      "> Option C discards the failed rounds' commits — use it only when those",
      "> commits belong to the failed work.",
      "",
    );
  }
  lines.push(
    `**If git is unavailable**, manually revert the files listed above ` +
    `to their state at Round ${toRound}. Re-read the state file below — ` +
    `it reflects the correct state at Round ${toRound}.`,
    "",
    "> 🛡️ **Verification:** The next round's evidence check will verify that " +
    "> your workspace no longer contains the failed changes. Submissions " +
    "> with unrestored files will be **rejected**.",
    "",
  );

  // ── What Must Change ──────────────────────────────────────────────────
  lines.push(
    "### What Must Change",
    "",
    "- Do **NOT** repeat the approach used in the skipped rounds.",
    "- Try a **different** task decomposition or technique.",
    "- If the current sub-goal is stuck, consider canceling it " +
      "(`canceled_subtasks`) and working on a different one.",
    // v3.5: the restored Current Task may be the very Round Contract that
    // stalled — the agent must be told the sanctioned way to revise it
    // (outcome=blocked closes the active contract; the revised proposal in
    // the same submission becomes active next round). Without this the
    // agent's revision would be silently ignored as premature.
    "- If the restored Current Task is a Round Contract that caused the stall: " +
      "close it in this submission with `outcome=\"blocked\"` (+ a blocker " +
      "explaining why it stalled) and declare the REVISED contract in the " +
      "same submission. Do **NOT** silently restate the stalled contract.",
    "- Use the `prompt_requests.confusion_points` field in your self-evaluation " +
      "to flag anything you don't understand about the task or the blockage.",
    "",
  );

  // ── Preserved Discoveries ─────────────────────────────────────────────
  if (skippedDiscoveries.length > 0) {
    lines.push(
      "### Preserved Discoveries",
      "",
      "These were discovered in the skipped rounds and remain valid:",
      "",
    );
    for (const d of skippedDiscoveries) {
      lines.push(`- ${d}`);
    }
    lines.push("");
  }

  // ── Instructions ──────────────────────────────────────────────────────
  lines.push(
    "### Instructions",
    "",
    `You have been rolled back to Round ${toRound}. ` +
    `You are now starting **Round ${toRound + 1}** with the lessons above.`,
    "",
    "1. **First**: restore your workspace using the commands above.",
    "2. Read the restored state below — it reflects Round " + toRound + ".",
    "3. The discoveries from skipped rounds (if any) have been merged " +
      "into the active constraints.",
    "4. Do NOT retrace the steps that led to the stall. Choose a new path.",
    "",
  );

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Individual enforcement rules — each returns EnforcementResult | null
// Rules are ordered by priority. The first non-null result wins.
// ═══════════════════════════════════════════════════════════════════════════

/** R1: Agent claims success but success_criteria_remaining has items.
 *  This is a lie — the agent must either finish the criteria or
 *  set success=false honestly. Triggered by the verification gate's
 *  "success_with_remaining_criteria" error flag. */
function enforceSuccessWithRemainingCriteria(
  flags: VerificationFlag[],
): EnforcementResult | null {
  const flag = flags.find(
    (f) => f.check === CHECK_SUCCESS_WITH_REMAINING_CRITERIA && f.severity === "error",
  );
  if (!flag) return null;

  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "You set success=true but success criteria remain unmet. " +
      "Either: (a) complete the remaining criteria and re-submit your self-evaluation, " +
      "or (b) set success=false and honestly report what remains to be done.",
    check: "success_with_remaining_criteria",
  });
}

/** R2: Same constraint violation appears in 3 consecutive rounds.
 *  The agent is repeating the same mistake. Triggered by the verification
 *  gate's "recurring_violation" error flag. */
function enforceRecurringViolation(
  flags: VerificationFlag[],
): EnforcementResult | null {
  const flag = flags.find(
    (f) => f.check === CHECK_RECURRING_VIOLATION && f.severity === "error",
  );
  if (!flag) return null;

  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "The same constraint violation has appeared in 3 consecutive rounds. " +
      "You must: (a) explain WHY this violation keeps occurring, " +
      "and (b) propose a DIFFERENT approach than what you used in the last 3 rounds. " +
      "Do NOT retry the same strategy — it has failed 3 times.",
    check: "recurring_violation",
  });
}

/** R-EVID (v2.14): A required command failure, a test-results mismatch that
 *  hides failures, or a self-contradictory outcome claim contradicts the
 *  success claim before commit. The verification gate detects the
 *  contradiction; this rule decides what to do about it — reject so the
 *  agent redos the SAME round with honest claims. Same-check rejections
 *  accumulate toward R6 via the per-check counter. */
function enforceEvidenceContradiction(
  flags: VerificationFlag[],
): EnforcementResult | null {
  const contradiction = flags.find(
    (f) =>
      f.severity === "error" &&
      (f.check === CHECK_REQUIRED_COMMAND_FAILED ||
        f.check === CHECK_COMMAND_EVIDENCE_MISMATCH ||
        f.check === CHECK_OUTCOME_SUCCESS_CONTRADICTION),
  );
  if (!contradiction) return null;

  return makeEnforcementResult({
    action: "reject",
    reason: contradiction.detail,
    fix_instructions:
      "A required verification command failed or your claims contradict " +
      "the evidence. You must: (a) run the required command and report its " +
      "actual output, (b) reconcile your success claim with the evidence — " +
      "do NOT report success when the evidence contradicts it, and " +
      "(c) resubmit an honest SelfEvaluation for the SAME round.",
    check: contradiction.check,
  });
}

/** v3.3: R-EVID-VERIFY — the verification command's entrypoint changed in
 *  the same round the command ran. The runtime executed a script the agent
 *  just rewrote, so the "machine observation" has no stable baseline and
 *  cannot back the success claim. Reject so the agent resubmits the SAME
 *  round with the entrypoint unchanged (a freshly created entrypoint passes
 *  on the redo — the diff no longer contains it). */
function enforceVerificationEntrypointTampered(
  flags: VerificationFlag[],
): EnforcementResult | null {
  const flag = flags.find(
    (f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED && f.severity === "error",
  );
  if (!flag) return null;

  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "The verification command entrypoint changed in this round, so its " +
      "result cannot be trusted as machine evidence. You must: (a) keep the " +
      "verification command (and its entrypoint files) stable, (b) resubmit " +
      "your SelfEvaluation for the SAME round with the entrypoint unchanged " +
      "so the runtime can re-run it against a stable baseline, and (c) do " +
      "NOT rewrite the verification script to make it pass.",
    check: "verification_entrypoint_modified",
  });
}

/** R3: Agent claims success but did nothing verifiable.
 *  v1.17: execution_evidence is now MANDATORY for structured self-evaluations.
 *  Missing evidence when success=true → reject (agent must provide evidence).
 *  Empty evidence (no files + no tests) when success=true → reject. */
function enforceEmptySuccess(
  selfEval: SelfEvaluation,
  _flags: VerificationFlag[],
): EnforcementResult | null {
  if (!effectiveSuccess(selfEval)) return null;

  const ev = selfEval.execution_evidence;

  // v1.17: Missing evidence when claiming success → reject.
  // The agent MUST provide execution_evidence to back up a success claim.
  if (!ev) {
    return makeEnforcementResult({
      action: "reject",
      reason:
        "Agent claims success but provided no execution_evidence. " +
        "Every successful round MUST include execution_evidence with " +
        "files_changed, test_results, and progress_estimate.",
      fix_instructions:
        "You must provide execution_evidence in your self-evaluation: " +
        "(a) list the files you changed in execution_evidence.files_changed, " +
        "(b) run tests and report results in execution_evidence.test_results, " +
        "(c) estimate your progress in execution_evidence.progress_estimate. " +
        "If you genuinely completed the task without file changes or tests, " +
        "explain why in detail in your output_summary.",
      check: "empty_success",
    });
  }

  const filesEmpty = ev.files_changed.length === 0;
  const testsNotRun = ev.test_results === null;

  if (!filesEmpty || !testsNotRun) return null;

  return makeEnforcementResult({
    action: "reject",
    reason:
      "Agent claims success but execution_evidence shows no files changed " +
      "and no tests were run. There is no verifiable evidence of work.",
    fix_instructions:
      "You must provide verifiable evidence: " +
      "(a) list the files you changed in execution_evidence.files_changed, " +
      "and (b) run tests and report results in execution_evidence.test_results. " +
      "If you genuinely completed the task without file changes or tests, " +
      "explain why in detail in your output_summary.",
    check: "empty_success",
  });
}

/** R8 (v2.12): Success claimed without any machine-verifiable evidence.
 *  The verification gate produced success_without_verified_evidence (error):
 *  zero verified claims, no test results. First occurrence → reject with
 *  concrete evidence requirements; second consecutive → terminate. */
function enforceSuccessWithoutVerifiedEvidence(
  flags: VerificationFlag[],
  consecutiveRejections: number,
): EnforcementResult | null {
  const flag = flags.find((f) =>
    f.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE && f.severity === "error");
  if (!flag) return null;

  if (consecutiveRejections >= 2) {
    return makeEnforcementResult({
      action: "terminate",
      reason: "Repeated success claims with zero machine-verifiable evidence.",
      check: "success_without_verified_evidence",
    });
  }
  const escalation = getPolicy().engine.enforcement_escalation_enabled &&
    consecutiveRejections >= 1
    ? buildEscalationNotice()
    : "";
  return makeEnforcementResult({
    action: "reject",
    reason:
      "Agent claims success but the runtime verified zero claims: no passing " +
      "test evidence and no test results were observed. Success must be backed " +
      "by machine-verifiable evidence.",
    fix_instructions:
      "Provide verifiable evidence for your success claim: (a) run tests and " +
      "report results in execution_evidence.test_results, or (b) configure a " +
      "required verification command and run it, or (c) if no change was " +
      "genuinely needed, declare no_change_reason explaining why." + escalation,
    check: "success_without_verified_evidence",
  });
}

/** R-C1 (v3.3): Round Contract boundary claimed prematurely. The gate
 *  produced premature_boundary (error): success claimed while done_when
 *  items were claimed met without machine-verified evidence or silently
 *  dropped. First occurrence → reject with contract-specific fix
 *  instructions; second consecutive → terminate (R8 ladder). */
function enforcePrematureBoundary(
  flags: VerificationFlag[],
  consecutiveRejections: number,
): EnforcementResult | null {
  const flag = flags.find((f) =>
    f.check === CHECK_PREMATURE_BOUNDARY && f.severity === "error");
  if (!flag) return null;

  if (consecutiveRejections >= 2) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        "Repeated premature Round Contract boundary claims — done_when items " +
        "claimed without machine evidence or dropped while success is claimed.",
      check: "premature_boundary",
    });
  }
  const escalation = getPolicy().engine.enforcement_escalation_enabled &&
    consecutiveRejections >= 1
    ? buildEscalationNotice()
    : "";
  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "You claimed success under a Round Contract but done_when items are " +
      "unfinished or unverified. You must: (a) run the contract's " +
      "verification_plan commands (configured in loop_policy.json " +
      "evidence.commands) and report their actual output, listing satisfied " +
      "done_when items in success_criteria_met; or (b) set success=false and " +
      "list what remains in success_criteria_remaining; or (c) if no code " +
      "change was genuinely needed, declare no_change_reason. " +
      "Do NOT claim contract completion without machine evidence." + escalation,
    check: "premature_boundary",
  });
}

/** v3.5: Round Contract completion claimed without its verification_plan
 *  commands passing this round. The gate produced
 *  contract_completion_unverified (error): the eval's met claims satisfy
 *  every done_when of the ACTIVE contract, but the machine never observed
 *  the plan's commands pass. Closing a contract is a success-class claim —
 *  first occurrence → reject with fix instructions; second consecutive →
 *  terminate (R-C1's ladder). Registered BEFORE R-C1: the completion-truth
 *  question outranks boundary nuance. */
function enforceContractCompletionUnverified(
  flags: VerificationFlag[],
  consecutiveRejections: number,
): EnforcementResult | null {
  const flag = flags.find((f) =>
    f.check === CHECK_CONTRACT_COMPLETION_UNVERIFIED && f.severity === "error");
  if (!flag) return null;

  if (consecutiveRejections >= 2) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        "Repeated unverified Round Contract completion claims — done_when items " +
        "claimed complete while the verification_plan commands never passed.",
      check: "contract_completion_unverified",
    });
  }
  const escalation = getPolicy().engine.enforcement_escalation_enabled &&
    consecutiveRejections >= 1
    ? buildEscalationNotice()
    : "";
  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "You claimed completion under the ACTIVE Round Contract, but its " +
      "verification_plan commands did not pass this round. You must: (a) fix " +
      "the underlying failure, re-run the contract's verification_plan " +
      "commands (configured in loop_policy.json evidence.commands), and list " +
      "satisfied done_when items in success_criteria_met; or (b) set " +
      "success=false and list what remains in success_criteria_remaining. " +
      "Completion claims are never accepted without machine verification — " +
      "do NOT use no_change_reason for completion claims." + escalation,
    check: "contract_completion_unverified",
  });
}

/** R-C2 (v3.3): Round Contract scope drift. The gate produced
 *  round_scope_drift (warn): files changed outside the contract's declared
 *  scope. A substantive drift_clarification (≥ 20 chars with real anchors —
 *  the out-of-scope file paths count) accepts the legitimately expanded
 *  scope; no/weak clarification rejects; repeated unclarified drift
 *  terminates. Mirrors R8's ladder, not R7's streak counter — no new
 *  session state. */
function enforceScopeDrift(
  flags: VerificationFlag[],
  selfEval: SelfEvaluation,
  consecutiveRejections: number,
  vaultEntries: VaultEntry[] = [],
): EnforcementResult | null {
  const flag = flags.find((f) => f.check === CHECK_ROUND_SCOPE_DRIFT);
  if (!flag) return null;

  const clarification = selfEval.drift_clarification?.trim();
  const hasAnchor = clarification
    ? clarificationIsSubstantive(clarification, selfEval, vaultEntries)
    : false;
  const isSubstantive = clarification !== undefined
    && clarification.length >= 20
    && hasAnchor;

  if (isSubstantive) {
    // Genuine scope expansion with concrete file references → accept.
    return makeEnforcementResult({
      action: "accept",
      reason: "",
      fix_instructions: "",
      check: "round_scope_drift",
      clarification_accepted: true,
    });
  }

  if (consecutiveRejections >= 2) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Repeated scope drift without substantive drift_clarification — ` +
        `the agent keeps changing files outside its declared contract scope.`,
      check: "round_scope_drift",
    });
  }
  const escalation = getPolicy().engine.enforcement_escalation_enabled &&
    consecutiveRejections >= 1
    ? buildEscalationNotice()
    : "";
  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "Files changed outside the contract's declared scope. You must either: " +
      "(a) revert the out-of-scope changes, or (b) extend the scope in your " +
      "re-declared round_contract AND explain the pivot in drift_clarification " +
      "with concrete file paths (≥ 20 characters, real anchors). Weak or " +
      "missing clarifications are rejected; repeated scope drift terminates " +
      "the loop." + escalation,
    check: "round_scope_drift",
  });
}

/** R9 (v2.12): Post-backtrack workspace not restored. The verification gate
 *  produced backtrack_workspace_not_restored (error): either skipped-round
 *  files are still dirty, or the working tree is not at the restore point's
 *  git HEAD. The agent must restore the workspace, not redo the round. */
function enforceBacktrackNotRestored(
  flags: VerificationFlag[],
  vaultEntries: VaultEntry[] = [],
  currentRound = 0,
): EnforcementResult | null {
  const flag = flags.find((f) =>
    f.check === CHECK_BACKTRACK_WORKSPACE_NOT_RESTORED && f.severity === "error");
  if (!flag) return null;
  if (!getPolicy().engine.backtrack_enabled) return null;
  // v2.14: same deadlock guard as R4/R5 — a backtrack that already fired
  // for this round means a non-restoring agent would otherwise cycle
  // R9-backtrack forever (backtracks do not increment the rejection
  // counter). One rollback chance, then terminate.
  if (currentRound > 0 && hasCommittedBacktrack(vaultEntries, currentRound)) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        "The workspace is still not restored after the previous backtrack: " +
        flag.detail,
      check: "backtrack_workspace_not_restored",
    });
  }
  return makeEnforcementResult({
    action: "backtrack",
    reason:
      "The workspace was not restored after backtrack: " + flag.detail,
    fix_instructions:
      "Restore the working directory to the clean round's state " +
      "(git checkout -- . && git clean -fd, or git stash; if the failed " +
      "rounds created commits, git reset --hard <restore-commit>) before " +
      "submitting the next round.",
    check: "backtrack_workspace_not_restored",
  });
}

/** R4: Progress has stalled for 3+ consecutive rounds.
 *  Detected by checking progress_estimate deltas across vault entries.
 *  First occurrence → REJECT (agent must change approach).
 *  Second consecutive occurrence → TERMINATE (agent cannot recover). */
function enforceProgressStall(
  selfEval: SelfEvaluation,
  _flags: VerificationFlag[],
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number,
): EnforcementResult | null {
  // Need at least 3 rounds of history
  if (currentRound < 3) return null;

  let isStalling = false;
  let stallDetail = "";
  let stallThreshold = 0;

  // Evidence path: three reported progress estimates within the window.
  const progressByRound = progressWindow(vaultEntries, currentRound, selfEval);
  if (progressByRound.size >= 3) {
    const sortedRounds = [...progressByRound.keys()].sort((a, b) => a - b);
    const last3 = sortedRounds.slice(-3);

    // Require all three data points to be within [currentRound-3, currentRound-1].
    // (collectProgressByRound already filters rnd < currentRound, so the upper
    // bound is always satisfied — the lower bound is the real continuity guard.)
    const expectedMin = currentRound - 3;
    if (last3[0] < expectedMin) return null;

    const p1 = progressByRound.get(last3[0])!;
    const p2 = progressByRound.get(last3[1])!;
    const p3 = progressByRound.get(last3[2])!;

    stallThreshold = getPolicy().evolution.progress_stall_threshold;
    const delta12 = p2 - p1;
    const delta23 = p3 - p2;

    // Both deltas must be below threshold AND not near completion
    isStalling = delta12 < stallThreshold && delta23 < stallThreshold && p3 < 0.95;
    stallDetail = `${(p1 * 100).toFixed(0)}% → ${(p2 * 100).toFixed(0)}% → ${(p3 * 100).toFixed(0)}%`;
  } else {
    // v3.2/v3.3.1: rounds without execution_evidence (the agent omitted it,
    // or a legacy client) — the machine decides from committed git
    // observations instead of self-skipping: three consecutive rounds with
    // no git change is a stall. No git signal → skip (the machine cannot
    // observe). This branch is reachable by real evidence-less rounds; the
    // old skipEvidenceRules flag that gated it was never set on the
    // production path (extraction failures stall upstream), which silently
    // disabled the fallback the v3.2 invariant promises.
    const machine = machineProgressSeries(vaultEntries, currentRound, 3);
    if (machine === null) return null;
    isStalling = machine.every((value) => !value);
    stallDetail = "no machine-observed changes in the last 3 rounds";
  }

  // v3.3: Exculpatory machine cross-check. The delta-based stall verdict
  // requires machine agreement: when committed git snapshots cover the
  // window, observed git motion OR a newly met criterion within the window
  // means work is happening — not stalled. When the machine signal is
  // unavailable the legacy verdict stands.
  if (isStalling) {
    const machine = machineProgressSeries(vaultEntries, currentRound, 3);
    if (machine !== null) {
      if (machine.some(Boolean) ||
          hasNewCriteriaCompletion(vaultEntries, currentRound, 3)) {
        isStalling = false;
      } else {
        stallDetail += ` — no machine-observed git motion or criteria completion in rounds ${currentRound - 3}–${currentRound - 1}`;
      }
    }
  }

  if (!isStalling) return null;

  const escalation = getPolicy().engine.enforcement_escalation_enabled;

  // v2.7: When escalation is enabled, give one extra rejection round with a
  // "Seek Human Guidance" notice before terminating. This lets the agent
  // course-correct with human input rather than being killed immediately.
  if (consecutiveRejections >= 2) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Progress stalled for 3+ rounds ` +
        `(${stallDetail}) ` +
        `and agent did not resolve after escalation. Terminating loop.`,
      check: "progress_stall",
    });
  }

  if (consecutiveRejections >= 1 && escalation) {
    // v2.10: When backtrack is enabled, escalate to backtrack instead of
    // reject. The agent is rolled back to the last clean round with lessons
    // injected, rather than redoing the same round with an escalation notice.
    if (getPolicy().engine.backtrack_enabled) {
      // v2.14: A backtrack that already committed for this round (the loop
      // is re-walking rolled-back territory with the same stall) must not
      // loop forever — terminate instead. Without this, consecutive
      // rejections reset on every backtrack and the R4 cycle has no exit.
      if (hasCommittedBacktrack(vaultEntries, currentRound)) {
        return makeEnforcementResult({
          action: "terminate",
          reason:
            `Progress has stalled over the last 3 rounds ` +
            `(${stallDetail}) and a backtrack already fired for ` +
            `this round. The stall persists after rollback — terminating.`,
          check: "progress_stall",
        });
      }
      return makeEnforcementResult({
        action: "backtrack",
        reason:
          `Progress has stalled: ${stallDetail} over the last 3 rounds` +
          `${stallThreshold > 0 ? ` (delta < ${(stallThreshold * 100).toFixed(0)}% each round)` : ""}.`,
        fix_instructions:
          "Your progress has been flat for 3 rounds. You are being rolled back " +
          "to the last clean round. Do NOT repeat the approach that led to the stall. " +
          "Choose a different technique or task decomposition.",
        check: "progress_stall",
      });
    }
    return makeEnforcementResult({
      action: "reject",
      reason:
        `Progress has stalled: ${stallDetail} over the last 3 rounds` +
        `${stallThreshold > 0 ? ` (delta < ${(stallThreshold * 100).toFixed(0)}% each round)` : ""}.`,
      fix_instructions:
        "Your progress has been flat for 3 rounds. You must: " +
        "(a) explain what is blocking progress, " +
        "(b) propose a DIFFERENT technique or task decomposition, and " +
        "(c) set a concrete, verifiable goal for the redo of this round. " +
        "Do NOT repeat the same approach — it has not moved progress forward." +
        buildEscalationNotice(),
      check: "progress_stall",
    });
  }

  if (consecutiveRejections >= 1) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Progress stalled for 3+ rounds ` +
        `(${stallDetail}) ` +
        `and agent did not resolve after previous rejection. Terminating loop.`,
      check: "progress_stall",
    });
  }

  return makeEnforcementResult({
    action: "reject",
    reason:
      `Progress has stalled: ${stallDetail} over the last 3 rounds` +
      `${stallThreshold > 0 ? ` (delta < ${(stallThreshold * 100).toFixed(0)}% each round)` : ""}.`,
    fix_instructions:
      "Your progress has been flat for 3 rounds. You must: " +
      "(a) explain what is blocking progress, " +
      "(b) propose a DIFFERENT technique or task decomposition, and " +
      "(c) set a concrete, verifiable goal for the redo of this round. " +
      "Do NOT repeat the same approach — it has not moved progress forward.",
    check: "progress_stall",
  });
}

/** R5: Progress completely stalled (delta = 0) for N consecutive rounds —
 *  the "flat terminal" severity tier. Its flatness predicate (all window
 *  values equal within epsilon) is a strict subset of R4's stall predicate
 *  (deltas below progress_stall_threshold), and its window mirrors R4's
 *  (breakerSize == 3 by default, both with the same exculpatory machine
 *  veto). R4 is evaluated FIRST in the priority array, so under the default
 *  ladder every flat run is handled by R4 — first occurrence rejects, the
 *  second escalates (backtrack with v2.10 semantics) — and R5's own steeper
 *  ladder (terminate on the second consecutive flatline) is not reached.
 *  That reject-then-escalate rhythm is the product contract (backtrack-e2e
 *  locks it for exactly-flat runs).
 *
 *  R5 remains the reserved severity tier, not dead code: it is the ONLY
 *  stall guard when R4's delta gate is closed (`progress_stall_threshold
 *  <= 0` — R4 then fires only on negative deltas, i.e. regression, and a
 *  flat run reaches R5), and it is where a future window/threshold split
 *  (breakerSize > 3) would express the flat-specific escalation. Its
 *  ladder: termination on the second consecutive flatline detection;
 *  with enforcement_escalation_enabled the first occurrence issues an
 *  escalated rejection (backtrack under v2.10) instead of terminating.
 *
 *  Uses the engine.max_circuit_breaker policy value as the lookback window. */
function enforceProgressStallTerminal(
  selfEval: SelfEvaluation,
  _flags: VerificationFlag[],
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number,
): EnforcementResult | null {
  const breakerSize = getPolicy().engine.max_circuit_breaker;
  if (currentRound < breakerSize || vaultEntries.length < breakerSize) return null;

  let allFlat = false;
  let flatDetail = "";

  // Evidence path: `breakerSize` reported progress estimates in the window.
  const progressByRound = progressWindow(vaultEntries, currentRound, selfEval);
  if (progressByRound.size >= breakerSize) {
    const sortedRounds = [...progressByRound.keys()].sort((a, b) => a - b);
    const recent = sortedRounds.slice(-breakerSize);

    // v2.14: continuity guard (mirrors R4) — "consecutive" means the most
    // recent rounds. Rounds without execution_evidence are unknown motion,
    // not zero motion; taking "the last N rounds that happened to report
    // progress" terminated loops whose recent rounds simply had no data.
    if (recent[0] < currentRound - breakerSize) return null;

    // Check that progress values are ALL identical (delta = 0).
    // Use epsilon comparison — JSON round-trips can produce float drift
    // (e.g. 0.3 vs 0.30000000000000004) that would defeat strict === .
    const EPSILON = 1e-10;
    const first = progressByRound.get(recent[0])!;
    allFlat = recent.every((r) => Math.abs((progressByRound.get(r) ?? 0) - first) < EPSILON);
    if (!allFlat || first >= 0.95) return null;
    flatDetail = `completely flat at ${(first * 100).toFixed(0)}%`;
  } else {
    // v3.2/v3.3.1: evidence-less rounds — machine git-motion flatline over
    // the breaker window (reachable by real evidence-less rounds; see the
    // R4 comment — the old flag-gated branch never ran on the production
    // path). No git signal → skip (the machine cannot observe).
    const machine = machineProgressSeries(vaultEntries, currentRound, breakerSize);
    if (machine === null) return null;
    allFlat = machine.every((value) => !value);
    flatDetail = `no machine-observed changes for ${breakerSize} consecutive rounds`;
  }

  // v3.3: Exculpatory machine cross-check — mirrors R4: a flatline verdict
  // requires machine agreement over the breaker window. Git motion or a
  // newly met criterion = work is happening.
  if (allFlat) {
    const machine = machineProgressSeries(vaultEntries, currentRound, breakerSize);
    if (machine !== null) {
      if (machine.some(Boolean) ||
          hasNewCriteriaCompletion(vaultEntries, currentRound, breakerSize)) {
        allFlat = false;
      } else {
        flatDetail += ` — no machine-observed git motion or criteria completion in rounds ${currentRound - breakerSize}–${currentRound - 1}`;
      }
    }
  }

  if (!allFlat) return null;

  const escalation = getPolicy().engine.enforcement_escalation_enabled;

  // v2.7: When escalation is enabled, give one rejection round with a
  // "Seek Human Guidance" notice before terminating.
  if (consecutiveRejections >= 1) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Progress has been ${flatDetail} ` +
        `for ${breakerSize} consecutive rounds and agent did not resolve ` +
        `after escalation. The agent is making zero forward motion.`,
      check: "progress_stall_terminal",
    });
  }

  if (escalation) {
    // v2.10: When backtrack is enabled, escalate to backtrack instead of
    // reject. The agent is rolled back to the last clean round with a
    // "radically different strategy" lesson injected.
    if (getPolicy().engine.backtrack_enabled) {
      // v2.14: Same deadlock guard as R4 — a backtrack that already fired
      // for this round means the loop is re-walking rolled-back territory.
      if (hasCommittedBacktrack(vaultEntries, currentRound)) {
        return makeEnforcementResult({
          action: "terminate",
          reason:
            `Progress has been ${flatDetail} ` +
            `for ${breakerSize} consecutive rounds and a backtrack already ` +
            `fired for this round. Flatline persists after rollback — ` +
            `terminating the loop.`,
          check: "progress_stall_terminal",
        });
      }
      return makeEnforcementResult({
        action: "backtrack",
        reason:
          `Progress has been ${flatDetail} ` +
          `for ${breakerSize} consecutive rounds. The agent is making zero ` +
          `forward motion.`,
        fix_instructions:
          "Your progress has been exactly flat — zero forward motion. " +
          "You are being rolled back to the last clean round. " +
          "Choose a RADICALLY different approach. The previous one produced nothing.",
        check: "progress_stall_terminal",
      });
    }
    return makeEnforcementResult({
      action: "reject",
      reason:
        `Progress has been ${flatDetail} ` +
        `for ${breakerSize} consecutive rounds. The agent is making zero ` +
        `forward motion.`,
      fix_instructions:
        "Your progress has been exactly flat — you are making zero forward " +
        "motion. You must: (a) explain what is fundamentally blocking you, " +
        "(b) propose a radically different approach, and " +
        "(c) set a concrete verifiable goal. " +
        "Do NOT resubmit the same output." +
        buildEscalationNotice(),
      check: "progress_stall_terminal",
    });
  }

  return makeEnforcementResult({
    action: "terminate",
    reason:
      `Progress has been ${flatDetail} ` +
      `for ${breakerSize} consecutive rounds. The agent is making zero ` +
      `forward motion and cannot recover.`,
    check: "progress_stall_terminal",
  });
}

/** R6: Two consecutive rejections → escalate (v2.7) or terminate.
 *
 *  v2.7: When enforcement_escalation_enabled is true, the second consecutive
 *  rejection issues an escalated rejection with a "Seek Human Guidance" notice
 *  instead of terminating immediately. Termination occurs on the third
 *  consecutive rejection. When the flag is disabled, behavior is unchanged
 *  (terminate at ≥2 rejections). */
function enforceMaxRejections(
  consecutiveRejections: number,
): EnforcementResult | null {
  const escalation = getPolicy().engine.enforcement_escalation_enabled;

  if (escalation) {
    if (consecutiveRejections >= 3) {
      return makeEnforcementResult({
        action: "terminate",
        reason:
          `${consecutiveRejections} consecutive enforcement rejections for the ` +
          `same issue without resolution. The agent has been unable to correct ` +
          `the identified issue even after escalation. Terminating loop.`,
        check: "max_rejections",
      });
    }

    if (consecutiveRejections >= 2) {
      return makeEnforcementResult({
        action: "reject",
        reason:
          `${consecutiveRejections} consecutive enforcement rejections for the ` +
          `same issue without resolution.`,
        fix_instructions:
          "You have been rejected multiple times for the same issue. " +
          "You must address ALL items in the Evidence Gap section above. " +
          "If you do not understand why you are being rejected, explain " +
          "your confusion explicitly and ask for clarification." +
          buildEscalationNotice(),
        check: "max_rejections",
      });
    }

    return null;
  }

  if (consecutiveRejections < 2) return null;

  return makeEnforcementResult({
    action: "terminate",
    reason:
      `${consecutiveRejections} consecutive enforcement rejections for the ` +
      `same issue without resolution. The agent has been unable to correct the identified issue.`,
    check: "max_rejections",
  });
}

/** v2.12: Check if a drift_clarification contains at least one semantic
 *  anchor — a constraint/criterion/sub-goal ID (v2.11) or a file-path-like
 *  reference. This distinguishes genuine explanations from filler text that
 *  just happens to be ≥ 20 characters. */
/** Extract anchor candidates from a clarification: c-/cr-/sg- IDs and
 *  file-path-like tokens. */
function extractAnchors(clarification: string): string[] {
  const anchors = new Set<string>();
  for (const match of clarification.matchAll(/[c]r?-[a-f0-9]{8}|sg-[a-f0-9]{8}/gi)) {
    anchors.add(match[0].toLowerCase());
  }
  for (const match of clarification.matchAll(/[\w./-]+\.[a-z]{2,6}\b/gi)) {
    anchors.add(match[0]);
  }
  return [...anchors];
}

/** v2.12: A drift clarification is substantive only when at least one anchor
 *  is REAL — a stable ID that derives from a known constraint/criterion/
 *  sub-goal text in the vault, or a file path present in reported/observed
 *  files. Regex patterns alone (e.g. a fabricated `c-00000000`) no longer
 *  count, closing the v2.12 filler-text loophole. */
function clarificationIsSubstantive(
  clarification: string,
  selfEval: SelfEvaluation,
  vaultEntries: VaultEntry[],
): boolean {
  const anchors = extractAnchors(clarification);
  if (anchors.length === 0) return false;

  const knownFiles = new Set<string>();
  const knownTexts = new Set<string>();
  const collect = (values: unknown): void => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value === "string" && value.length > 0) knownTexts.add(value);
    }
  };
  // The agent's own round report is a known set: its constraints, criteria,
  // and files are legitimate anchor targets.
  for (const file of selfEval.execution_evidence?.files_changed ?? []) knownFiles.add(file);
  collect(selfEval.discovered_constraints);
  collect(selfEval.constraint_violations);
  const selfEvidence = selfEval.execution_evidence;
  if (selfEvidence) {
    collect(selfEvidence.success_criteria_met);
    collect(selfEvidence.success_criteria_remaining);
  }
  for (const entry of vaultEntries) {
    collect(entry.constraint_violations);
    collect(entry.discovered_constraints);
    const ev = entry.execution_evidence as Record<string, unknown> | undefined;
    if (ev) {
      collect(ev.files_changed);
      collect(ev.success_criteria_met);
      collect(ev.success_criteria_remaining);
    }
  }

  for (const anchor of anchors) {
    if (STABLE_ID_RE.test(anchor)) {
      const matches = anchor.startsWith("c-") && !anchor.startsWith("cr-")
        ? [...knownTexts].some((text) => deriveConstraintId(text) === anchor)
        : anchor.startsWith("cr-")
          ? [...knownTexts].some((text) => deriveCriterionId(text) === anchor)
          : [...knownTexts].some((text) => deriveSubGoalId(text) === anchor);
      if (matches) return true;
      continue;
    }
    // File path: exact or suffix match against known files.
    if ([...knownFiles].some((file) =>
      file === anchor || file.endsWith(`/${anchor}`) || file.endsWith(`\\${anchor}`))) {
      return true;
    }
  }
  return false;
}

/** Build a stronger rejection notice as the clarification streak grows. */
function buildClarificationRejectionNotice(streak: number): string {
  const base =
    "Your declared next_action from the previous round does not match " +
    "what you actually did this round. You must either: " +
    "(a) explain why you pivoted in the drift_clarification field, " +
    "mentioning specific constraint/criterion/sub-goal IDs or file paths " +
    "that prompted the change, or " +
    "(b) redo this round and do what you said you would do.";

  if (streak >= 2) {
    return (
      base +
      "\n\n### ⚠️ Repeated Weak Clarification\n\n" +
      `You have submitted drift_clarification without concrete references ` +
      `for ${streak} consecutive rounds. Your explanation MUST include at ` +
      `least one of: a constraint ID (c-XXXXXXXX), criterion ID (cr-XXXXXXXX), ` +
      `sub-goal ID (sg-XXXXXXXX), or a file path you changed.\n\n` +
      `🚨 If the next clarification also lacks concrete anchors, the loop ` +
      `will be terminated.`
    );
  }

  return base;
}

/** R7: Agent declared a next_action but did something unrelated.
 *
 *  v2.8: When the agent provides a substantive drift_clarification (≥ 20
 *  characters), the rejection is waived — the agent has acknowledged and
 *  explained the pivot. An empty or absent clarification still triggers
 *  the normal reject/terminate path.
 *
 *  v2.12: Clarification now requires a semantic anchor (constraint/criterion/
 *  sub-goal ID or file path) in addition to the ≥ 20 char minimum. Weak
 *  clarifications (no anchors) increment a streak counter; 3 consecutive
 *  weak clarifications terminate the loop.
 *
 *  First occurrence → reject (agent must explain the gap or realign).
 *  Second consecutive → terminate (agent cannot/will not follow its own plan). */
function enforceIntentDrift(
  flags: VerificationFlag[],
  selfEval: SelfEvaluation,
  consecutiveRejections: number,
  driftClarificationStreak: number = 0,
  vaultEntries: VaultEntry[] = [],
): EnforcementResult | null {
  const flag = flags.find((f) => f.check === "intent_drift");
  if (!flag) return null;

  const clarification = selfEval.drift_clarification?.trim();

  // v2.12: Substantive anchors — the referenced ID/path must actually exist
  // in the vault or in reported files; a fabricated ID no longer counts.
  const hasAnchor = clarification
    ? clarificationIsSubstantive(clarification, selfEval, vaultEntries)
    : false;

  // v2.12: Substantive clarification = length check + semantic anchor
  const isSubstantive = clarification
    && clarification.length >= 20
    && hasAnchor;

  if (isSubstantive) {
    // Genuine explanation with concrete references → accept the pivot
    return makeEnforcementResult({
      action: "accept",
      reason: "",
      fix_instructions: "",
      check: "intent_drift",
      clarification_accepted: true,
    });
  }

  // v2.12: Clarification present but weak (no semantic anchors)
  if (clarification && clarification.length >= 20 && !hasAnchor) {
    const maxStreak = getPolicy().engine.drift_clarification_max_streak;

    // When maxStreak is 0, disable the check (pre-v2.12 behavior)
    if (maxStreak <= 0) {
      return makeEnforcementResult({
        action: "accept",
        reason: "",
        fix_instructions: "",
        check: "intent_drift",
        clarification_accepted: true,
      });
    }

    const newStreak = driftClarificationStreak + 1;
    if (newStreak >= maxStreak) {
      return makeEnforcementResult({
        action: "terminate",
        reason:
          `Agent has submitted weak drift_clarification (no concrete IDs or ` +
          `file references) for ${newStreak} consecutive rounds. The agent ` +
          `systematically avoids following its own plan without substantive ` +
          `explanation.`,
        check: "intent_drift",
      });
    }

    return makeEnforcementResult({
      action: "reject",
      reason: flag.detail,
      fix_instructions: buildClarificationRejectionNotice(newStreak),
      check: "intent_drift",
    });
  }

  // No clarification or too short — the worst form of drift. v2.14: counts
  // toward the SAME streak as weak clarifications (maxStreak consecutive
  // un-explained drifts terminate, per the README's "three consecutive weak
  // clarifications"). Previously this branch used the GLOBAL
  // consecutiveRejections counter, so an unrelated earlier rejection
  // (e.g. R1) terminated the loop on the very first drift.
  const maxStreak = getPolicy().engine.drift_clarification_max_streak;

  // When maxStreak is 0, disable the check (pre-v2.12 behavior)
  if (maxStreak <= 0) {
    return makeEnforcementResult({
      action: "accept",
      reason: "",
      fix_instructions: "",
      check: "intent_drift",
      clarification_accepted: true,
    });
  }

  const newStreak = driftClarificationStreak + 1;
  if (newStreak >= maxStreak) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Agent has drifted from its declared next_action for ${newStreak} ` +
        `consecutive rounds without any drift_clarification. The agent ` +
        `cannot or will not follow its own plan — terminating loop.`,
      check: "intent_drift",
    });
  }

  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "Your declared next_action from the previous round does not match " +
      "what you actually did this round. You must either: " +
      "(a) explain why you pivoted and what you learned in the " +
      "drift_clarification field, or " +
      "(b) redo this round and do what you said you would do. " +
      "If you intentionally changed direction, update your objective_refinement " +
      "and set a new next_action that reflects the new plan.",
    check: "intent_drift",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Escalation notice builder (v2.7)
// ═══════════════════════════════════════════════════════════════════════════

/** Build an escalation notice urging the agent to seek human guidance.
 *
 *  Appended to fix_instructions when a rule would otherwise terminate.
 *  Gives the agent one final chance to correct course with human input
 *  before the loop is irreversibly stopped. */
function buildEscalationNotice(): string {
  return [
    "",
    "### 🆘 Escalation — Seek Human Guidance",
    "",
    "You have been rejected multiple times for the same issue. " +
      "Before retrying, pause and ask a human for help:",
    "",
    "1. Explain what you've tried so far and why each approach failed.",
    "2. Ask the human for specific guidance on what to try next.",
    "3. Incorporate their feedback before re-submitting your self-evaluation.",
    "",
    "⚠️ If this round is rejected again, the loop will be **terminated**. " +
      "Do NOT resubmit without meaningful changes.",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Diagnostic gap builder (v2.7)
// ═══════════════════════════════════════════════════════════════════════════

/** Build a diagnostic gap section from verification flags.
 *
 *  Translates each error/warn-level VerificationFlag into a concrete
 *  claim-vs-evidence mismatch statement. Info-level flags are excluded
 *  because they are purely informational and do not represent gaps.
 *
 *  Returns an empty string when there are no diagnostic flags to report. */
function buildDiagnosticGap(flags: VerificationFlag[]): string {
  const diagnosticFlags = flags.filter(
    (f) => f.severity === "error" || f.severity === "warn",
  );
  if (diagnosticFlags.length === 0) return "";

  const lines: string[] = [
    "### Evidence Gap",
    "",
    "The enforcement gate detected mismatches between your claims and the evidence. " +
      "Each item below shows a specific discrepancy — address every one before re-submitting.",
    "",
  ];

  for (const flag of diagnosticFlags) {
    const icon = flag.severity === "error" ? "🚫" : "⚠️";
    lines.push(`- ${icon} **[${flag.check}]** \`${flag.field}\` — ${flag.detail}`);
  }

  lines.push("");
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════

/** Enforce round-boundary rules based on the verification gate's findings
 *  and the agent's self-evaluation integrity.
 *
 *  Rules run in priority order — the rules array below IS the priority
 *  order; numeric IDs (R1–R9, R-EVID) reflect insertion history, not
 *  priority. The first rule that fires wins.
 *
 * @param selfEval              The agent's self-evaluation for the current round.
 * @param verifyResult          The verification gate's output (from verifySelfEvaluation).
 * @param currentRound          Current round number (1-based, BEFORE increment).
 * @param vaultEntries          Vault entries for this loop (used for progress tracking).
 * @param consecutiveRejections How many consecutive rounds have already been rejected.
 *                              Starts at 0; increments on each reject; resets on accept.
 */
export function enforceRound(
  selfEval: SelfEvaluation,
  verifyResult: VerificationResult,
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number = 0,
  /** v2.12: Current clarification streak for R7 escalation. */
  driftClarificationStreak: number = 0,
): EnforcementResult {
  const { flags } = verifyResult;

  // Run enforcement rules in priority order.
  // Earlier rules take higher precedence.
  const rules: Array<() => EnforcementResult | null> = [
    () => enforceSuccessWithRemainingCriteria(flags),
    () => enforceRecurringViolation(flags),
    () => enforceEmptySuccess(selfEval, flags),
    // v2.14: R-EVID — a required command failure or self-contradictory
    // outcome claim contradicts the success claim before commit
    () => enforceEvidenceContradiction(flags),
    // v3.3: R-EVID-VERIFY — the verification command entrypoint changed in
    // the same round it ran; its result cannot back the success claim.
    // Runs before R8: when the entrypoint is tainted, R8 also fires (the
    // status degrades to unavailable), but this reason is more specific.
    () => enforceVerificationEntrypointTampered(flags),
    // v3.5: contract completion claimed without its verification_plan
    // commands passing — runs before R-C1: the completion-truth question
    // outranks boundary nuance (a completing eval that also lies about its
    // evidence gets the completion reason first).
    () => enforceContractCompletionUnverified(flags, consecutiveRejections),
    // v3.3: R-C1 — contract boundary claimed prematurely (contract-specific
    // wording and check counting; runs before R8 so contract rounds get the
    // contract's own reason. R8 itself is untouched.)
    () => enforcePrematureBoundary(flags, consecutiveRejections),
    // v2.12: R8 — success with zero machine-verifiable evidence
    () => enforceSuccessWithoutVerifiedEvidence(flags, consecutiveRejections),
    // v3.3: R-C2 — files changed outside the contract's declared scope
    () => enforceScopeDrift(flags, selfEval, consecutiveRejections, vaultEntries),
    // v3.3.1: R4 is evaluated first and its stall predicate contains R5's
    // flatness predicate — under the default ladder R4 proxies for flat runs
    // too (reject → backtrack/terminate). R5 stays as the reserved severity
    // tier (see its doc comment: active when progress_stall_threshold <= 0
    // or after a future window split).
    () => enforceProgressStall(selfEval, flags, currentRound, vaultEntries, consecutiveRejections),
    () => enforceProgressStallTerminal(selfEval, flags, currentRound, vaultEntries, consecutiveRejections),
    () => enforceMaxRejections(consecutiveRejections),
    () => enforceIntentDrift(flags, selfEval, consecutiveRejections, driftClarificationStreak, vaultEntries),
    // v2.12: R9 — post-backtrack workspace not restored
    () => enforceBacktrackNotRestored(flags, vaultEntries, currentRound),
  ];

  // v3.3.1: rules without an internal escalation ladder (R1/R2/R3/R-EVID/
  // R-EVID-VERIFY) reject on EVERY occurrence of their check, and the
  // generic R6 ladder sits AFTER them in this priority array — R6 is only
  // evaluated when no earlier rule fires, which a persistent offender's
  // round never is. The documented "same-check rejections accumulate toward
  // R6" (per-check counter the session maintains) was therefore unreachable
  // and a repeat offender was rejected forever without a terminating step.
  // Escalate these rules' rejects on the session's consecutive-rejection
  // count, mirroring the R8/R7 three-strike rhythm: reject, reject
  // (escalation notice), terminate on the third consecutive occurrence.
  // Rules with their own ladder (R4/R5/R6/R7/R8/R9/R-C1/R-C2) are untouched.
  const UNLADDERED_REJECT_CHECKS = new Set([
    "success_with_remaining_criteria", // R1
    "recurring_violation", // R2
    "empty_success", // R3
    "required_command_failed", // R-EVID
    "command_evidence_mismatch", // R-EVID
    "outcome_success_contradiction", // R-EVID
    "verification_entrypoint_modified", // R-EVID-VERIFY
  ]);

  for (const rule of rules) {
    const result = rule();
    if (!result) continue;
    if (
      result.action === "reject" &&
      consecutiveRejections >= 2 &&
      result.check !== undefined &&
      UNLADDERED_REJECT_CHECKS.has(result.check)
    ) {
      return makeEnforcementResult({
        action: "terminate",
        reason:
          `${consecutiveRejections + 1} consecutive rejections for the same ` +
          `issue (${result.check}) without resolution — the agent cannot ` +
          `correct it even after escalation.`,
        check: result.check,
      });
    }
    return result;
  }

  // All rules passed — accept the round
  return makeEnforcementResult({
    action: "accept",
    reason: "",
    fix_instructions: "",
  });
}

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
export function buildRejectionPrompt(
  currentRound: number,
  task: string,
  enforceResult: EnforcementResult,
  verificationFlags: VerificationFlag[] = [],
): string {
  const lines: string[] = [
    "## ⛔ Round " + currentRound + " — REJECTED",
    "",
    "Your self-evaluation for Round " + currentRound +
    " was **rejected** by the enforcement gate.",
    "",
    "### Reason",
    "",
    enforceResult.reason,
    "",
  ];

  // v2.7: Diagnostic gap — show the agent exactly what doesn't match.
  const gap = buildDiagnosticGap(verificationFlags);
  if (gap) {
    lines.push(gap);
  }

  if (enforceResult.fix_instructions) {
    lines.push("### Required Fix");
    lines.push("");
    lines.push(enforceResult.fix_instructions);
    lines.push("");
  }

  lines.push("### Your Task (Round " + currentRound + " — Retry)");
  lines.push("");
  lines.push(task);
  lines.push("");

  lines.push("### Instructions");
  lines.push("");
  lines.push(
    "1. Read and address each issue in **Required Fix** above.",
    "2. Re-execute **Round " + currentRound +
    "** — do NOT advance to the next round.",
    "3. Submit a corrected self-evaluation via `loopforge_next`.",
    "4. Be honest in your self-evaluation — " +
    "claiming success when criteria are unmet will be rejected again.",
    "5. If you believe this rejection is incorrect, " +
    "explain why in your output_summary and the enforcement gate will re-evaluate.",
  );

  return lines.join("\n");
}
