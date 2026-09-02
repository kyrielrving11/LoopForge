/** RoundCoordinator — Unified round-boundary state machine (v1.17).
 *
 * Encapsulates the shared round processing pipeline used by
 * SessionManager (mcp/session.ts):
 *
 *   verify → enforce → stop decision
 *
 * Before this module, runtime.ts and session.ts each maintained their
 * own copy of the pipeline (~60 lines each). Drift between the two
 * paths (e.g. git verification only wired into one side) was a known
 * risk. The RoundCoordinator is the single source of truth.
 *
 * State transitions:
 *   RoundStarted → EvidenceCaptured → EvaluationSubmitted
 *   → VerificationCompleted → EnforcementDecided
 *
 * Persistence is owned by round-transaction.ts so reject paths remain
 * side-effect free and accepted decisions can be replayed idempotently.
 */

import { queryLoopEntries } from "./loop-store.js";
import type { LoopStore, VaultEntry } from "./loop-store.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type {
  EnforcementResult,
  SelfEvaluation,
  StopReason,
  VerificationFlag,
  VerificationResult,
} from "./protocol.js";
import { CHECK_SUCCESS_UNVERIFIED, verifySelfEvaluation, entryRound } from "./verification-gate.js";
import { effectiveSuccess } from "./self-eval.js";
import {
  enforceRound,
  buildRejectionPrompt,
  findSafeRestorePoint,
  buildBacktrackPrompt,
  findBacktrackTargetGitHead,
} from "./enforcement-gate.js";
import { logEvent } from "./observability.js";
import { getPolicy } from "./policy.js";


// ── Types ──────────────────────────────────────────────────────────────────

/** Input to a single round processing step. */
export interface RoundProcessInput {
  loopId: string;
  task: string;
  currentRound: number;
  maxRounds: number;
  /** The agent's self-evaluation for this round. */
  selfEval: SelfEvaluation;
  /** The previous round's validated SelfEvaluation (null for round 1). */
  lastSelfEval?: SelfEvaluation;
  /** How many consecutive rounds have been rejected by enforcement. */
  consecutiveRejections: number;
  /** v1.18: Evidence snapshots from configured providers. */
  evidenceSnapshots?: ProviderSnapshot[];
  /** Success values from already committed rounds. */
  successTrajectory?: boolean[];
  /** v2.13: Files from skipped backtrack rounds. Passed to verification
   *  gate for post-backtrack workspace restore check. */
  backtrackSkippedFiles?: string[];
  /** v2.12: Git HEAD of the backtrack restore point. The verification gate
   *  checks the workspace returns to this commit before accepting work. */
  backtrackTargetGitHead?: string;
}

/** Result of processing a round through the coordinator. */
export interface RoundProcessResult {
  /** What the caller should do next. */
  action: "continue" | "stop" | "reject" | "terminate" | "backtrack";
  /** Reason for stop (set when action is "stop" or "terminate"). */
  stopReason?: StopReason;
  /** Rejection prompt (set when action is "reject"). */
  rejectionPrompt?: string;
  /** v2.10: Backtrack prompt (set when action is "backtrack"). */
  backtrackPrompt?: string;
  /** v2.10: Round to restore state from (set when action is "backtrack"). */
  backtrackTarget?: number;
  /** v2.10: Discovered constraints from skipped rounds to preserve. */
  backtrackSkippedDiscoveries?: string[];
  /** v2.10: Which enforcement rule triggered the backtrack. */
  backtrackTriggerRule?: string;
  /** Verification flags from this round (for injection into next prompt). */
  verificationFlags: VerificationFlag[];
  /** Enforcement action for observability. */
  enforcementAction?: "accept" | "reject" | "terminate" | "backtrack";
  /** Enforcement reason (set when rejected or terminated). */
  enforcementReason?: string;
  /** Whether this round was successful (from selfEval.success). */
  roundSuccess: boolean;
  /** Whether the verification gate returned "contradicted". */
  gateContradicted: boolean;
  /** Updated consecutiveRejections count — caller must persist. */
  newConsecutiveRejections: number;
  /** Which enforcement check fired (set when action is "reject" or "terminate").
   *  Used by callers to track per-rule rejection counters. */
  rejectionCheck?: string;
  /** The selfEval to store as lastSelfEval for the next round
   *  (undefined when action is "reject" — caller should NOT update). */
  newLastSelfEval?: SelfEvaluation;
  /** Whether the caller should push roundSuccess onto the success trajectory.
   *  false when gateContradicted or when action is "reject". */
  shouldPushSuccessTrajectory: boolean;
  /** v2.12: True when this round's intent_drift was waived via substantive
   *  drift_clarification. The caller uses this to track clarification streaks.
   *  v3.3.1: false when R7 itself rejected/terminated on a weak or missing
   *  clarification (the caller increments the streak); undefined when R7 did
   *  not participate in the decision — a higher-priority rule's rejection
   *  must never touch the streak. */
  clarificationAccepted?: boolean;
  /** v2.13: Git HEAD commit hash of the backtrack target round.
   *  Set when action is "backtrack". The verification gate uses this
   *  to check that the agent restored the workspace before working. */
  backtrackTargetGitHead?: string;
  /** v2.13: Files changed in skipped rounds during backtrack.
   *  The next round's verification gate checks that these files are
   *  not still dirty (agent must restore workspace first). */
  backtrackSkippedFiles?: string[];
}

/** v3.2: Whether a round's success enters the success trajectory. Excluded
 *  when the gate contradicted the round, or when the success claim carries no
 *  machine-verified observation (success_unverified warn) — an
 *  accepted-but-unverified round is not evidence of progress. */
function shouldPushSuccess(
  gateContradicted: boolean,
  verificationFlags: VerificationFlag[],
): boolean {
  if (gateContradicted) return false;
  return !verificationFlags.some(
    (flag) => flag.severity === "warn" && flag.check === CHECK_SUCCESS_UNVERIFIED,
  );
}

// ── RoundCoordinator ───────────────────────────────────────────────────────

export class RoundCoordinator {
  private store: LoopStore | undefined;

  constructor(store?: LoopStore) {
    this.store = store;
  }

  /** Process a single round's self-evaluation through the decision pipeline:
   *  verify → enforce → stop decision.
   *
   *  This is the single entry point called by SessionManager.
   *  The caller is responsible for:
   *  - Compiling the next prompt (if action is "continue")
   *  - Managing heartbeat / signal handlers (runtime only)
   *  - Memory injection (both paths, before calling processRound)
   *  - Transactional feedback commit (accepted rounds only)
   *  - State file I/O (both paths, after compiling)
   *
   * @param driftClarificationStreak v2.12: Current clarification streak
   *  from session state. Passed through to enforceRound for R7 escalation. */
  processRound(
    input: RoundProcessInput,
    driftClarificationStreak: number = 0,
  ): RoundProcessResult {
    const {
      loopId, task, currentRound, maxRounds,
      selfEval, lastSelfEval,
      consecutiveRejections,
      evidenceSnapshots,
    } = input;

    const roundSuccess = selfEval.success ?? false;

    // ── 1. Query vault entries ──────────────────────────────────────────
    // Lineage entries (constraint violations, output summaries) and feedback
    // entries (execution_evidence, progress estimates) are both needed by
    // the enforcement gate. queryLoopEntries excludes feedback by default,
    // so we issue a second query and merge both result sets.
    const prefix = `loop:${loopId}:r`;
    const vaultEntries: VaultEntry[] = this.store
      ? [
          ...queryLoopEntries(this.store, loopId, { prefix }),
          ...queryLoopEntries(this.store, loopId, { prefix, feedbackOnly: true }),
        ]
      : [];

    // ── 2. Verification gate ────────────────────────────────────────────
    const verifyResult: VerificationResult = verifySelfEvaluation(
      selfEval,
      currentRound,
      vaultEntries,
      lastSelfEval ?? null,
      evidenceSnapshots ?? [],
      input.backtrackSkippedFiles ?? [],
      input.backtrackTargetGitHead,
    );
    const verificationFlags = verifyResult.flags;
    const gateContradicted = verifyResult.verdict === "contradicted";

    if (gateContradicted) {
      logEvent("gate_contradicted", {
        loopId,
        round: currentRound,
        flags: verificationFlags.map((f) => f.check),
      });
    }

    // ── 3. Enforcement gate ──────────────────────────────────────────
    // v3.3.1: extraction failures stall the round upstream (round-lifecycle,
    // v2.6 design — the runtime never guesses state from text), so every
    // transaction reaches enforcement with a fully extracted self-evaluation.
    // The old v2.5 "heuristic partial enforcement" plumbing (extractionSucceeded
    // flag, enforcement skipEvidenceRules mode) was removed as unreachable.
    const enforceResult: EnforcementResult = enforceRound(
      selfEval,
      verifyResult,
      currentRound,
      vaultEntries,
      consecutiveRejections,
      driftClarificationStreak,
    );

    if (enforceResult.action === "reject") {
      const newRejections = consecutiveRejections + 1;
      const rejectionPrompt = buildRejectionPrompt(
        currentRound, task, enforceResult, verificationFlags,
      );
      logEvent("enforcement_reject", {
        loopId,
        round: currentRound,
        reason: enforceResult.reason.slice(0, 120),
        check: enforceResult.check ?? "",
        consecutiveRejections: newRejections,
      });
      return {
        action: "reject",
        rejectionPrompt,
        verificationFlags,
        enforcementAction: "reject",
        enforcementReason: enforceResult.reason,
        rejectionCheck: enforceResult.check,
        // v3.3.1: an R7-participated reject (weak or missing
        // drift_clarification) echoes clarificationAccepted: false so the
        // caller's streak tracking increments — without this the
        // drift_clarification_max_streak terminate ladder was unreachable
        // (the increment branch required the field, and only the continue
        // path ever set it). Higher-priority rules' rejects keep it
        // undefined, preserving the v3.2.1 "R7-only streak" semantics.
        ...(enforceResult.check === "intent_drift"
          ? { clarificationAccepted: false }
          : {}),
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: newRejections,
        // Don't update lastSelfEval on reject — the agent redoes the same round
        newLastSelfEval: undefined,
        shouldPushSuccessTrajectory: false,
      };
    }

    if (enforceResult.action === "terminate") {
      logEvent("session_end", {
        loopId,
        stopReason: "enforcement_terminated",
        round: currentRound,
      });
      return {
        action: "terminate",
        stopReason: "enforcement_terminated",
        verificationFlags,
        enforcementAction: "terminate",
        enforcementReason: enforceResult.reason,
        rejectionCheck: enforceResult.check,
        // v3.3.1: same echo as the reject branch — R7-participated
        // terminates keep the streak contract consistent for the
        // snapshot/audit record (harmless: the session is ending).
        ...(enforceResult.check === "intent_drift"
          ? { clarificationAccepted: false }
          : {}),
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        newLastSelfEval: selfEval,
        shouldPushSuccessTrajectory: false,
      };
    }

    // ── v2.10: Backtrack ──────────────────────────────────────────────────
    if (enforceResult.action === "backtrack") {
      const maxDepth = getPolicy().engine.backtrack_max_depth;
      const restorePoint = findSafeRestorePoint(currentRound, vaultEntries, maxDepth);

      if (!restorePoint) {
        // No clean round found within maxDepth — fall through to terminate
        logEvent("session_end", {
          loopId,
          stopReason: "enforcement_terminated",
          round: currentRound,
        });
        return {
          action: "terminate",
          stopReason: "enforcement_terminated",
          verificationFlags,
          enforcementAction: "terminate",
          enforcementReason:
            `${enforceResult.reason} (backtrack failed: no clean restore point within ${maxDepth} rounds)`,
          rejectionCheck: enforceResult.check,
          roundSuccess,
          gateContradicted,
          newConsecutiveRejections: 0,
          newLastSelfEval: selfEval,
          shouldPushSuccessTrajectory: false,
        };
      }

      // v2.13: Collect files changed in skipped rounds for the restore prompt
      const skippedFiles: string[] = [];
      for (let r = restorePoint.round + 1; r < currentRound; r++) {
        // v3.2.1: match the feedback entry (execution_evidence lives there) —
        // the compile-time lineage entry for the same round precedes it in
        // the flat view and carries no evidence.
        const entry = vaultEntries.find(
          (e) => entryRound(e) === r && e.task_type !== "loop_lineage",
        );
        if (entry?.execution_evidence) {
          const ev = entry.execution_evidence as Record<string, unknown>;
          const files = Array.isArray(ev.files_changed)
            ? ev.files_changed.filter((f: unknown) => typeof f === "string")
            : [];
          for (const f of files) {
            if (!skippedFiles.includes(f)) skippedFiles.push(f);
          }
        }
      }

      // v2.12: Capture the restore point's git HEAD so the next round's
      // verification can confirm the workspace returned to this commit.
      const targetGitHead = findBacktrackTargetGitHead(restorePoint.round, vaultEntries);

      const backtrackPrompt = buildBacktrackPrompt(
        currentRound,
        restorePoint.round,
        enforceResult.check ?? "progress_stall",
        getPolicy().engine.backtrack_preserve_discoveries
          ? restorePoint.skippedDiscoveries
          : [],
        skippedFiles,
        targetGitHead ?? undefined,
      );

      logEvent("enforcement_backtrack", {
        loopId,
        round: currentRound,
        reason: enforceResult.reason.slice(0, 120),
        check: enforceResult.check ?? "",
        backtrackTarget: restorePoint.round,
        skippedDiscoveries: restorePoint.skippedDiscoveries.length,
      });

      return {
        action: "backtrack",
        backtrackPrompt,
        backtrackTarget: restorePoint.round,
        backtrackSkippedDiscoveries: getPolicy().engine.backtrack_preserve_discoveries
          ? restorePoint.skippedDiscoveries
          : [],
        backtrackSkippedFiles: skippedFiles,
        backtrackTargetGitHead: targetGitHead ?? undefined,
        backtrackTriggerRule: enforceResult.check,
        verificationFlags,
        enforcementAction: "backtrack",
        enforcementReason: enforceResult.reason,
        rejectionCheck: enforceResult.check,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0, // reset — fresh start
        newLastSelfEval: undefined,
        shouldPushSuccessTrajectory: false,
      };
    }

    // Accept: reset rejection counter
    // (consecutiveRejections reset to 0 — caller persists)

    // ── 4. Auto-feedback (AFTER enforcement, only if accepted) ──────────
    // ── 5. Stop condition checks ────────────────────────────────────────
    // (v3.3.1: the old 5a "extraction failed → stalled" branch was removed —
    // extraction failures stall upstream in round-lifecycle, before the
    // transaction, so this branch was unreachable.)

    // 5b. Agent says stop
    if (!selfEval.should_continue) {
      let reason: StopReason;
      if (effectiveSuccess(selfEval)) {
        reason = "completed";
      } else if (selfEval.outcome === "blocked" ||
          selfEval.stop_reason === "blocked" || selfEval.stop_reason === "needs_human_input") {
        reason = "blocked";
      } else {
        reason = "failed";
      }
      return {
        action: "stop",
        stopReason: reason,
        verificationFlags,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        newLastSelfEval: selfEval,
        shouldPushSuccessTrajectory: shouldPushSuccess(gateContradicted, verificationFlags),
      };
    }

    // 5c. Max rounds reached
    //
    // NOTE: The binary-success circuit breaker previously at 5c is removed.
    // Genuine agent stalls are now detected by the enforcement gate via
    // enforceProgressStall (R4: delta < 5% → reject → terminate on repeat)
    // and enforceProgressStallTerminal (R5: delta = 0 for N rounds → terminate).
    // These use progress_estimate, not the binary success flag, so they
    // correctly distinguish "task not done yet" from "agent is stuck".
    if (currentRound >= maxRounds) {
      return {
        action: "stop",
        stopReason: "max_rounds",
        verificationFlags,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        newLastSelfEval: selfEval,
        shouldPushSuccessTrajectory: shouldPushSuccess(gateContradicted, verificationFlags),
      };
    }

    // ── 6. Continue — caller compiles next round ────────────────────────
    return {
      action: "continue",
      verificationFlags,
      enforcementAction: "accept",
      roundSuccess,
      gateContradicted,
      newConsecutiveRejections: 0,
      newLastSelfEval: selfEval,
      shouldPushSuccessTrajectory: shouldPushSuccess(gateContradicted, verificationFlags),
      // v2.12: Propagate clarification acceptance signal for streak tracking
      clarificationAccepted: enforceResult.clarification_accepted ?? false,
    };
  }
}
