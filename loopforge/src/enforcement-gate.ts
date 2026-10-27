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
import { CHECK_SUCCESS_WITH_REMAINING_CRITERIA, CHECK_RECURRING_VIOLATION, CHECK_REQUIRED_COMMAND_FAILED, CHECK_COMMAND_EVIDENCE_MISMATCH, CHECK_OUTCOME_SUCCESS_CONTRADICTION, CHECK_VERIFICATION_ENTRYPOINT_MODIFIED, CHECK_CONTRACT_ITEMS_UNVERIFIED, CHECK_USER_GATE_UNRESOLVED } from "./verification-gate.js";
import {
  deriveProgressWindow,
  type RoundProgress,
} from "./progress.js";
import { declaresBlocked } from "./round-outcome.js";
import { getPolicy } from "./policy.js";
import {
  derivationRounds,
  hasCommittedMachineBacktrack,
  type CommittedRoundView,
} from "./committed-round.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// v2.10: Backtrack helpers
// ═══════════════════════════════════════════════════════════════════════════

/** True when a backtrack already committed at or after the current round —
 *  i.e. the loop is re-walking territory the system already rolled back
 *  once. Guards against the reject↔backtrack deadlock on persistent stalls. */
function hasCommittedBacktrack(
  vaultEntries: VaultEntry[],
  currentRound: number,
): boolean {
  return hasCommittedMachineBacktrack(vaultEntries, currentRound);
}

/** Check whether a committed round represents a clean restore point.
 *  as a safe restore point. A clean round was accepted (not rejected)
 *  and had no error-level verification flags.
 *
 *  v3.2.1: judged by the COMMITTED decision and gate flags, not by the
 *  agent's self-reported success. A progress-stall round commits with
 *  success=false but is accepted and carries no error flags — it is a
 *  valid backtrack target (the most common backtrack trigger is exactly a
 *  run of such rounds). Rejected/terminated rounds never commit, and
 *  rolled-back rounds are excluded below. */
function isCleanRound(round: CommittedRoundView): boolean {
  // v4.0.3: a round without a complete observable boundary is not a
  // machine-clean restore point. Unknown evidence never reads as clean.
  if (round.evidenceIncomplete) return false;
  return !round.verificationFlags.some((flag) => flag.severity === "error");
}

/** Scan backwards from currentRound to find the most recent clean round.
 *  Collects discovered_constraints from skipped rounds along the way.
 *  Returns null when no clean round is found within maxDepth. */
export function findSafeRestorePoint(
  currentRound: number,
  vaultEntries: VaultEntry[],
  maxDepth: number,
  /** v3.9.7: a candidate must have a materialized restore checkpoint. */
  isEligible?: (round: number) => boolean,
): { round: number; skippedDiscoveries: string[] } | null {
  const completed = derivationRounds(vaultEntries, currentRound)
    .sort((a, b) => b.round - a.round);

  const skippedDiscoveries: string[] = [];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const targetRound = currentRound - depth;
    if (targetRound < 1) break;
    const round = completed.find((item) => item.round === targetRound);
    if (!round) continue;

    // Collect discoveries from rounds we're about to skip (depth > 1)
    if (depth > 1) {
      for (let d = 1; d < depth; d++) {
        const skippedRound = currentRound - d;
        const skippedEntry = completed.find((item) => item.round === skippedRound);
        if (skippedEntry?.evaluation) {
          const discovered = skippedEntry.evaluation.discovered_constraints ?? [];
          for (const item of discovered) {
            if (!skippedDiscoveries.includes(item)) skippedDiscoveries.push(item);
          }
        }
      }
    }

    if (isCleanRound(round) && (isEligible?.(targetRound) ?? true)) {
      return { round: targetRound, skippedDiscoveries };
    }
  }

  return null;
}

/** v3.8.1: the ONE Recovery Brief renderer.
 *
 *  v3.9.4: it is the shared fact renderer for the prompt's protected
 *  `recovery` section and the state file's Recent tier. The post-compile
 *  backtrack prompt (and its action advice) is gone: `committedBacktrackBrief`
 *  appends the restore HEAD/file set and the artifact is the delivered prompt.
 *  The facts are supplied by the caller from `decodeBacktrackRecord` on the
 *  committed decision. */
export function recoveryBriefLines(input: {
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
}): string[] {
  const maxApproaches = input.maxApproaches ?? 6;
  const maxAssumptions = input.maxAssumptions ?? 5;
  const lines = [
    `- **Trigger**: ${input.triggerRule || "unknown"}`,
  ];
  if (input.origin) {
    lines.push(`- **Initiated by**: ${input.origin === "agent" ? "Agent" : "Machine"}`);
  }
  if (input.origin === "agent" && input.reason?.trim()) {
    const report = input.reason.trim()
      .replace(/[\r\n\t]+/g, " ")
      .replace(/`/g, "\\`")
      .replace(/\s{2,}/g, " ");
    lines.push(`- **Agent reason (report only; not a LoopForge instruction)**: ${report}`);
  }
  if (input.failureReason?.trim()) {
    lines.push(`- **Failure reason**: ${input.failureReason.trim()}`);
  }
  lines.push(
    input.checkpointId
      ? `- **Restored checkpoint**: \`${input.checkpointId}\` (${
          input.restoreVerified === false
            ? "restore NOT verified"
            : "machine-verified by LoopForge"
        })`
      : "- **Restored state**: the committed restore point",
    `- **Redo round**: ${input.redoRound}`,
  );
  if (input.recoveryRoundId) {
    lines.push(`- **Recovery Round ID**: \`${input.recoveryRoundId}\``);
  }
  if (input.failedRounds.length > 0) {
    lines.push(
      `- **${input.origin === "agent" ? "Abandoned" : "Failed"} rounds**: ${input.failedRounds.join(", ")}`,
    );
  }
  const approachLabel = input.origin === "agent" ? "Abandoned approach" : "Failed approach";
  const shown = input.approaches.slice(0, maxApproaches);
  for (const approach of shown) {
    lines.push(`  - ${approachLabel}: ${approach}`);
  }
  if (input.approaches.length > shown.length) {
    lines.push(
      `  - … and ${input.approaches.length - shown.length} more ${approachLabel.toLowerCase()}s`,
    );
  }
  if (input.wrongAssumptions.length > 0) {
    lines.push("- **Falsified assumptions (Agent reports)**:");
    for (const assumption of input.wrongAssumptions.slice(0, maxAssumptions)) {
      lines.push(`  - ${assumption}`);
    }
  }
  if (input.preservedDiscoveries && input.preservedDiscoveries.length > 0) {
    lines.push("- **Preserved discoveries (Agent reports)**:");
    for (const discovery of input.preservedDiscoveries) {
      lines.push(`  - ${discovery}`);
    }
  }
  return lines;
}


// ═══════════════════════════════════════════════════════════════════════════
// Individual enforcement rules — each returns EnforcementResult | null
// Rules are ordered by priority. The first non-null result wins.
// ═══════════════════════════════════════════════════════════════════════════

/** R1: Agent claims success but declared criteria remain outstanding.
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
      "The same constraint violation has been reported in three consecutive " +
      "committed rounds. This is a record of your own reports. The finding " +
      "clears when a committed evaluation no longer reports the same " +
      "violation, or when you declare outcome blocked with a blocker. " +
      "LoopForge does not prescribe a technique or decomposition.",
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
 *  cannot back the success claim.
 *
 *  v3.8.3: the row owns its whole ladder (RULE_TABLE ladder: "internal").
 *
 *  The old text said "resubmit with the entrypoint unchanged", which is not an
 *  instruction the agent can carry out when the round CREATED the file — it
 *  did not exist to keep unchanged — and the round's baseline never moves, so
 *  the same file was re-detected on every retry until the uniform ladder
 *  terminated the loop. The recovery text now states the round-start state of
 *  each file (the gate puts it in the detail) and the two routes that exist:
 *  restore it, or take the rollback so the work is redone in a round whose
 *  baseline already contains the entrypoint. Repeated non-restoration is a
 *  rollback, not a kill. */
function enforceVerificationEntrypointTampered(
  flags: VerificationFlag[],
  vaultEntries: VaultEntry[],
  currentRound: number,
  consecutiveRejections: number,
  lastRejectionCheck: string,
): EnforcementResult | null {
  const flag = flags.find(
    (f) => f.check === CHECK_VERIFICATION_ENTRYPOINT_MODIFIED && f.severity === "error",
  );
  if (!flag) return null;

  const check = "verification_entrypoint_modified";
  const ownStreak = lastRejectionCheck === check ? consecutiveRejections : 0;

  if (ownStreak >= 1) {
    // The agent has already been told, once, exactly what to restore and has
    // not restored it. Retrying the same round cannot help — the baseline is
    // frozen on purpose — so escalate to the rollback, which redoes the work
    // in a fresh round where the entrypoint is part of the starting state.
    // `backtrack_enabled` off, or a rollback already committed for this round
    // (which would loop), leaves termination as the honest end.
    if (getPolicy().engine.backtrack_enabled &&
        !hasCommittedBacktrack(vaultEntries, currentRound)) {
      return makeEnforcementResult({
        action: "backtrack",
        reason:
          "The verification command's entrypoint is still not back to its " +
          "round-start state after being asked once, so this round cannot " +
          "produce a trustworthy observation.",
        fix_instructions:
          "After the rollback, restore the workspace as the Recovery Brief " +
          "states. The restore check requires every skipped file to differ " +
          "from its state at the rollback, so no entrypoint may still be an " +
          "uncommitted change: revert it, or make a script you intend to keep " +
          "part of the committed workspace before the round that runs it. " +
          "Then redo the round.",
        check,
      });
    }
    return makeEnforcementResult({
      action: "terminate",
      reason:
        "The verification command's entrypoint was changed in the round it " +
        "verified and was not restored after being asked once. Backtrack is " +
        "disabled or already committed for this round.",
      check,
    });
  }

  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "The verification command entrypoint changed in this round, so its " +
      "result cannot be trusted as machine evidence — the runtime executed a " +
      "script this round rewrote. To make this round verifiable again: restore " +
      "each of those files to the state it had when the round started (for a " +
      "file that did not exist then, that means removing it), then resubmit " +
      "this same round's SelfEvaluation. Do NOT rewrite the verification " +
      "script to make it pass. If the work genuinely needs that file, this " +
      "round cannot verify it: make the file part of the committed workspace " +
      "first — a script that is not an uncommitted change — and let a later " +
      "round run it.",
    check,
  });
}

/** v3.8: Verification debt — contract items claimed met without machine
 *  verification. The round COMMITS (insufficient is recorded, not rejected);
 *  this row only fires once the debt has persisted for
 *  `engine.unverified_claim_streak_limit` consecutive rounds, then runs its
 *  OWN ladder: reject → terminate as `incomplete`.
 *
 *  v3.8.1: the ladder lives here (RULE_TABLE marks the row "internal").
 *  Declaring it "uniform" as well ran the escalation twice — the notice was
 *  appended twice to one fix_instructions — and made the uniform terminate
 *  branch unreachable, while its bare `consecutiveRejections` read let a
 *  streak earned by a DIFFERENT check terminate this row on its FIRST
 *  occurrence, which is exactly what the L4 rule forbids.
 *
 *  The streak is derived from COMMITTED round flags, so it survives restart
 *  and cannot be moved by an agent self-report. Machine progress does not
 *  excuse it: churning code without verifying is exactly what this row catches. */
function enforceContractItemsUnverified(
  flags: VerificationFlag[],
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number,
  lastRejectionCheck: string,
): EnforcementResult | null {
  const limit = getPolicy().engine.unverified_claim_streak_limit;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const current = flags.find((flag) => flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED);
  if (!current) return null;

  let streak = 1;
  const window = derivationRounds(vaultEntries, currentRound);
  for (let round = currentRound - 1; round >= 1; round--) {
    const committed = window.find((view) => view.round === round);
    const carried = committed?.verificationFlags.some(
      (flag) => flag.check === CHECK_CONTRACT_ITEMS_UNVERIFIED,
    );
    if (!carried) break;
    streak++;
  }
  if (streak < limit) return null;

  // The counter measures the PREVIOUS round's check (the coordinator resets it
  // whenever the check changes), so it only speaks for this row when it names
  // this row — same rule the uniform rows apply.
  const ownRejections = lastRejectionCheck === "contract_items_unverified"
    ? consecutiveRejections
    : 0;

  if (ownRejections >= 2) {
    return makeEnforcementResult({
      action: "terminate",
      reason:
        `Verification debt persisted for ${streak} rounds — contract items ` +
        `claimed met while no bound command was observed passing.`,
      check: "contract_items_unverified",
      stopReason: "incomplete",
    });
  }
  const escalation = getPolicy().engine.enforcement_escalation_enabled &&
    ownRejections >= 1
    ? buildEscalationNotice()
    : "";
  return makeEnforcementResult({
    action: "reject",
    reason: current.detail,
    fix_instructions:
      `Contract items have been claimed met for ${streak} consecutive rounds ` +
      "without machine verification. You must either: (a) run the item's bound " +
      "command(s) so they are observed passing, or (b) report the item as " +
      "remaining / declare outcome: \"blocked\" with a blocker. " +
      "An unverified claim is never accepted as completion." + escalation,
    check: "contract_items_unverified",
  });
}

interface StallWindowVerdict {
  detail: string;
  window: number;
}

/** The ONE progress-stall predicate. A stall requires machine proof that both
 *  the committed window AND the submitted round are unchanged; unknown and
 *  not_applicable never produce a verdict. */
function evaluateStallWindow(
  currentRound: number,
  vaultEntries: VaultEntry[],
  /** v3.8.1: the round's success is machine-verified (`deriveEvidenceStatus`).
   *  A verified round is finishing work; a progress window cannot outvote it. */
  machineBackedSuccess: boolean,
  /** The submitted round's own provider-neutral progress. */
  inFlightProgress: RoundProgress,
): StallWindowVerdict | null {
  if (machineBackedSuccess) return null;
  if (inFlightProgress.state === "changed") return null;
  // "Unknown never stalls": a submitted round whose progress cannot be
  // proven unchanged gets no verdict.
  if (inFlightProgress.state !== "unchanged") return null;

  const window = Math.max(1, getPolicy().engine.stall_lookback_rounds);
  if (currentRound < window) return null;
  const progress = deriveProgressWindow(
    derivationRounds(vaultEntries, currentRound),
    currentRound,
    window,
  );
  if (progress.state !== "unchanged") return null;
  // The verdict is about the Git workspace coverage ONLY. A custom provider's
  // fact — changed, unchanged or unknown — is never part of this sentence.
  const providers = progress.providers.length > 0
    ? ` (providers: ${progress.providers.join(", ")})`
    : "";
  return {
    detail:
      `no machine-observed progress within the Git workspace coverage in the ` +
      `last ${window} committed rounds${providers}`,
    window,
  };
}

/** One progress disposition ladder. The reason states the machine fact; the
 *  fix states the legal protocol paths, never a semantic strategy. */
function resolveStallDisposition(
  verdict: StallWindowVerdict,
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number,
  lastRejectionCheck: string,
): EnforcementResult {
  const { detail } = verdict;
  const escalation = getPolicy().engine.enforcement_escalation_enabled;
  const stalledReason = `Machine-observed progress is flat: ${detail}.`;
  const check = "progress_stall";

  // v3.8.3: the stall escalates on its OWN streak. The persisted counter is
  // one scalar shared by every check, so two rejections of any other kind must
  // not turn a first-time stall straight into termination.
  const ownStreak = lastRejectionCheck === check ? consecutiveRejections : 0;

  if (ownStreak >= 2) {
    return makeEnforcementResult({
      action: "terminate",
      reason: `${stalledReason} The stall persisted after escalation. Terminating loop.`,
      check,
    });
  }

  if (ownStreak >= 1 && !escalation) {
    return makeEnforcementResult({
      action: "terminate",
      reason: `${stalledReason} The stall persisted after the previous rejection. Terminating loop.`,
      check,
    });
  }

  const escalated = ownStreak >= 1 && escalation;
  if (escalated && getPolicy().engine.backtrack_enabled) {
    if (hasCommittedBacktrack(vaultEntries, currentRound)) {
      return makeEnforcementResult({
        action: "terminate",
        reason: `${stalledReason} A backtrack already fired for this round; the stall persists after rollback.`,
        check,
      });
    }
    return makeEnforcementResult({
      action: "backtrack",
      reason: stalledReason,
      fix_instructions:
        "This is a machine liveness fact, not a judgment about your plan. " +
        "The loop will restore the last clean round. After the restore you own " +
        "the next action: continue with a new evaluation, request recovery to " +
        "an earlier committed point, or declare blocked/stop.",
      check,
    });
  }

  return makeEnforcementResult({
    action: "reject",
    reason: stalledReason,
    fix_instructions:
      "This is a machine liveness fact, not a judgment about your plan. " +
      "You own the next action: submit a new evaluation, request recovery to " +
      "an earlier committed point, or declare outcome blocked with a blocker. " +
      "LoopForge does not prescribe a technique or decomposition." +
      (escalated ? buildEscalationNotice() : ""),
    check,
  });
}

function enforceProgressStall(
  _flags: VerificationFlag[],
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number,
  machineBackedSuccess: boolean,
  lastRejectionCheck: string,
  inFlightProgress: RoundProgress,
): EnforcementResult | null {
  const verdict = evaluateStallWindow(
    currentRound,
    vaultEntries,
    machineBackedSuccess,
    inFlightProgress,
  );
  return verdict
    ? resolveStallDisposition(verdict, currentRound, vaultEntries, consecutiveRejections, lastRejectionCheck)
    : null;
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
          "Address every concrete finding in the mandatory Verification Gate. " +
          "If you need human input, stop with needs_human_input; there is no " +
          "semantic waiver for the findings." +
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

/** Build an escalation notice urging the agent to seek human guidance.
 *
 *  Appended to fix_instructions when a rule would otherwise terminate.
 *  Gives the agent one final chance to correct course with human input
 *  before the loop is irreversibly stopped. */
function buildEscalationNotice(): string {
  return [
    "",
    "### 🆘 Escalation — Human Decision Required",
    "",
    "This check has rejected the same round more than once. Before retrying, " +
      "ask the human whether to continue the current scope, change the " +
      "operator-owned scope, or stop.",
    "",
    "1. State the machine fact and the attempt already made.",
    "2. Ask the human for a decision (continue / change scope / stop).",
    "3. Record the decision in the next evaluation, or stop.",
    "",
    "⚠️ If the same check rejects again, the loop will be **terminated**.",
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// v3.7 — Enforcement strategy table
//
// The single in-process description of every enforcement row: its ladder kind
// and escalation knobs. Lives only in memory — never persisted, never a
// second state source. Priority is the ordered walk in enforceRound (the
// R-labels in rule comments are historical); this table supplies per-row
// semantics. v3.8: the never-read `category` / `clarificationAllowed` /
// `backtrackAllowed` fields were deleted with the drift machinery.
// ═══════════════════════════════════════════════════════════════════════════

interface RuleRow {
  /** Enforcement check ids the row owns; in-row first match wins. */
  checks: readonly string[];
  /** uniform — no internal ladder; escalates on the session's consecutive
   *  rejection count (escalation notice on repeat, terminate at
   *  terminalAfter). Replaces the former UNLADDERED_REJECT_CHECKS name set.
   *  internal — the row's own enforcer implements its ladder.
   *  counter — fires only from the rejection counter (R6 catch-all). */
  ladder: "uniform" | "internal" | "counter";
  /** uniform rows only: prior same-check rejections after which the row
   *  terminates instead of rejecting again. */
  terminalAfter?: number;
  /** uniform rows only: repeat rejections carry the escalation notice when
   *  enforcement_escalation_enabled. (Internal rows append their own.) */
  noticeOnRepeat?: boolean;
}

const RULE_TABLE: readonly RuleRow[] = [
  { checks: ["success_with_remaining_criteria"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
  { checks: ["recurring_violation"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
  { checks: ["required_command_failed", "command_evidence_mismatch", "outcome_success_contradiction"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
  // v3.8.3: own ladder — reject → backtrack → terminate. A rewritten
  // entrypoint is not fixed by asking again (the round's baseline is frozen on
  // purpose), so the second occurrence rolls the work back instead of killing
  // the loop. See enforceVerificationEntrypointTampered.
  { checks: ["verification_entrypoint_modified"], ladder: "internal" },
  // v3.9.9: round_scope_drift is REPORT-ONLY. It has no enforcement row, no
  // waiver, no rejection counter, and no stall/backtrack interaction.
  // v3.8.1: "internal" — the handler owns this row's ladder (it must terminate
  // as `incomplete`, with its own reason). Declaring it uniform as well ran the
  // escalation notice twice and left the uniform terminate branch dead.
  { checks: ["contract_items_unverified"], ladder: "internal" },
  { checks: ["progress_stall"], ladder: "internal" },
  { checks: ["max_rejections"], ladder: "counter" },
  // v3.7.1: cited gates without an approved human decision
  { checks: ["user_gate_unresolved"], ladder: "uniform", terminalAfter: 2, noticeOnRepeat: true },
];

const RULE_TABLE_BY_ID = new Map<string, RuleRow>();
for (const row of RULE_TABLE) {
  for (const id of row.checks) RULE_TABLE_BY_ID.set(id, row);
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
/** v3.7.1: user_gate_unresolved — the round cites gates without an
 *  approved human decision. Reject; the uniform ladder escalates repeats
 *  (the agent should pause and obtain approval — never resubmit a claim of
 *  completed high-risk work). */
function enforceUserGateUnresolved(flags: VerificationFlag[]): EnforcementResult | null {
  const flag = flags.find(
    (f) => f.check === CHECK_USER_GATE_UNRESOLVED && f.severity === "error",
  );
  if (!flag) return null;
  return makeEnforcementResult({
    action: "reject",
    reason: flag.detail,
    fix_instructions:
      "The round depends on a high-risk action with no approved human " +
      "decision. Run loopforge_gate_check with the action, present the " +
      "approval question, and call loopforge_gate_resolve only after the " +
      "human decides. Then resubmit with the approved gate id in " +
      "evaluation.gate_ids. Do NOT claim the action is done while it is " +
      "unapproved — safe preparation work never needs a gate.",
    check: CHECK_USER_GATE_UNRESOLVED,
  });
}

export function enforceRound(
  selfEval: SelfEvaluation,
  verifyResult: VerificationResult,
  currentRound: number,
  vaultEntries: VaultEntry[],
  consecutiveRejections: number = 0,
  /** L4 (v3.7.x): which check rejected the PREVIOUS round. The coordinator
   *  resets consecutiveRejections to 1 whenever the check changes, so the
   *  counter only ever measures one check's streak — this field names that
   *  check and lets uniform rows escalate on THEIR OWN streak instead of
   *  inheriting an unrelated history. */
  lastRejectionCheck: string = "",
  /** v3.9.7: the submitted round's provider-neutral progress. */
  inFlightProgress: RoundProgress = {
    state: "unknown",
    providers: [],
    coverages: [],
  },
): EnforcementResult {
  const { flags } = verifyResult;
  // v3.9.9: `round_scope_drift` is a retired enforcement check. A session
  // restored from an older runtime may still name it; it is not a current
  // check, and its persisted count must not reach the max_rejections
  // catch-all as unresolved persistence.
  const retiredScopeCheck = lastRejectionCheck === "round_scope_drift";
  const effectiveRejections = retiredScopeCheck ? 0 : consecutiveRejections;
  const effectiveLastCheck = retiredScopeCheck ? "" : lastRejectionCheck;
  // A valid blocked stop is the Agent's protocol action. Liveness/retry rows
  // must not convert it into a same-round rejection; machine-integrity rows
  // still apply below because their facts make the submission untrustworthy.
  const blockedStop = declaresBlocked(selfEval) && selfEval.should_continue === false;

  // Run enforcement rules in priority order — the array order IS the
  // priority; the R-labels in the comments are historical (RULE_TABLE is
  // the semantic description). The first rule that fires wins.
  const rules: Array<() => EnforcementResult | null> = [
    () => enforceSuccessWithRemainingCriteria(flags),
    () => enforceRecurringViolation(flags),
    // v2.14: R-EVID — a required command failure, hidden test failures, or
    // a self-contradictory outcome claim contradicts the success claim
    () => enforceEvidenceContradiction(flags),
    // v3.3: R-EVID-VERIFY — the verification command entrypoint changed in
    // the same round it ran.
    () => enforceVerificationEntrypointTampered(
      flags, vaultEntries, currentRound, effectiveRejections, effectiveLastCheck),
    // v3.5: contract completion claimed without its verification_plan
    // commands passing — runs before R-C1: the completion-truth question
    // outranks boundary nuance.

    // v3.3: R-C1 — contract boundary claimed prematurely (contract-specific
    // wording and check counting).
    // v3.9.1: R8 was removed. Its only trigger was the empty-report arm of
    // success_without_verified_evidence, which is now a warn: report coverage
    // no longer decides acceptance, and the machine-evidence warn still keeps
    // an unbacked success out of the trajectory.
    // v3.9.9: scope drift is an INFO fact only; it never appears here.
    // v3.8: verification debt — contract items claimed met without machine
    // verification (fires only after the configured streak)
    () => blockedStop
      ? null
      : enforceContractItemsUnverified(
          flags, currentRound, vaultEntries, effectiveRejections, effectiveLastCheck),
    // v3.9.7: one provider-neutral progress evaluator —
    // reject → backtrack → terminate with the deadlock guard
    () => blockedStop
      ? null
      : enforceProgressStall(
          flags, currentRound, vaultEntries, effectiveRejections,
          verifyResult.machineBackedSuccess, effectiveLastCheck, inFlightProgress),
    // R6: rejection-counter catch-all (evaluated only when no row above
    // fired — a clean-looking round carrying a high persisted counter)
    // v3.7.1: cited gate without an approved human decision
    () => enforceUserGateUnresolved(flags),
    // v3.9.9: round_scope_drift is not a rejection source, so this catch-all
    // has no drift-waiver special case anymore.
    () => blockedStop
      ? null
      : enforceMaxRejections(effectiveRejections),
  ];

  // v3.7: uniform-ladder escalation. Rows without their own escalation
  // ladder (R1/R2/R-EVID/R-EVID-VERIFY) escalate on the session's
  // consecutive-rejection count: repeat rejections carry the escalation
  // notice (when enabled — the pre-v3.7 comment promised this notice but the
  // UNLADDERED name-set patch never appended it), and a third consecutive
  // occurrence terminates. This replaces the UNLADDERED_REJECT_CHECKS patch,
  // which existed because the generic R6 ladder sits AFTER these rows and a
  // persistent offender's round never reached it. Rows with their own ladder
  // (RULE_TABLE.ladder === "internal" / "counter") are untouched.
  for (const rule of rules) {
    let result = rule();
    if (!result) continue;
    const row = result.check !== undefined
      ? RULE_TABLE_BY_ID.get(result.check)
      : undefined;
    if (result.action === "reject" && row && row.ladder === "uniform") {
      // L4: uniform rows escalate on their OWN consecutive streak only.
      // consecutiveRejections is the streak of the PREVIOUS round's check
      // (the coordinator resets it to 1 whenever the check changes) — a
      // streak earned by a DIFFERENT check must not convert this first
      // occurrence into termination. The user_gate row is the sharp case:
      // its recovery is human approval, so a gate cited after unrelated
      // rejections must reject with instructions, not kill the loop.
      const ownStreak = effectiveLastCheck === result.check
        ? effectiveRejections
        : 0;
      if (ownStreak >= (row.terminalAfter ?? 2)) {
        return makeEnforcementResult({
          action: "terminate",
          reason:
            `${ownStreak + 1} consecutive rejections for the same ` +
            `issue (${result.check}) without resolution — the agent cannot ` +
            `correct it even after escalation.`,
          check: result.check,
        });
      }
      if (ownStreak >= 1 && row.noticeOnRepeat &&
          getPolicy().engine.enforcement_escalation_enabled) {
        result = makeEnforcementResult({
          ...result,
          fix_instructions: result.fix_instructions + buildEscalationNotice(),
        });
      }
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
export function buildRejectionPrompt(
  currentRound: number,
  _task: string,
  enforceResult: EnforcementResult,
  _verificationFlags: VerificationFlag[] = [],
): string {
  const lines: string[] = [
    "## ⛔ Round " + currentRound + " — REJECTED",
    "",
    "The enforcement gate rejected this round. This is a machine/protocol",
    "decision, not a judgment about your reasoning strategy.",
    "",
    "### Reason",
    "",
    enforceResult.reason,
    "",
  ];

  if (enforceResult.fix_instructions) {
    lines.push("### Required Fix");
    lines.push("");
    lines.push(enforceResult.fix_instructions);
    lines.push("");
  }

  lines.push("### Instructions");
  lines.push("");
  lines.push(
    "1. Read and address each issue in **Required Fix** above.",
    "2. Re-execute **Round " + currentRound +
    "** — do NOT advance to the next round.",
    "3. Submit a corrected evaluation via `loopforge_next` using the latest",
    "   `roundId` returned by LoopForge.",
    "4. If you believe a finding is factually wrong, identify the specific",
    "   machine fact you dispute and submit a corrected evaluation. The gate",
    "   re-evaluates facts, not explanations.",
  );

  return lines.join("\n");
}
