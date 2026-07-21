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

import type { VaultBackend, VaultEntry } from "./backends/interface.js";
import type { ProviderSnapshot } from "./evidence-provider.js";
import type {
  EnforcementResult,
  SelfEvaluation,
  StopReason,
  VerificationFlag,
  VerificationResult,
} from "./protocol.js";
import { verifySelfEvaluation } from "./verification-gate.js";
import { enforceRound, buildRejectionPrompt } from "./enforcement-gate.js";
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
  /** Whether structured extraction succeeded (false = heuristic fallback). */
  extractionSucceeded: boolean;
  /** The previous round's validated SelfEvaluation (null for round 1). */
  lastSelfEval?: SelfEvaluation;
  /** How many consecutive rounds have been rejected by enforcement. */
  consecutiveRejections: number;
  /** v1.16: Files detected as changed by git diff. null if git unavailable. */
  runtimeFilesChanged?: string[] | null;
  /** v1.18: Evidence snapshots from configured providers. */
  evidenceSnapshots?: ProviderSnapshot[];
  /** Success values from already committed rounds. */
  successTrajectory?: boolean[];
}

/** Result of processing a round through the coordinator. */
export interface RoundProcessResult {
  /** What the caller should do next. */
  action: "continue" | "stop" | "reject" | "terminate";
  /** Reason for stop (set when action is "stop" or "terminate"). */
  stopReason?: StopReason;
  /** Rejection prompt (set when action is "reject"). */
  rejectionPrompt?: string;
  /** Verification flags from this round (for injection into next prompt). */
  verificationFlags: VerificationFlag[];
  /** Enforcement action for observability. */
  enforcementAction?: "accept" | "reject" | "terminate";
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
}

// ── RoundCoordinator ───────────────────────────────────────────────────────

export class RoundCoordinator {
  private backend: VaultBackend | undefined;

  constructor(backend?: VaultBackend) {
    this.backend = backend;
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
   */
  processRound(input: RoundProcessInput): RoundProcessResult {
    const {
      loopId, task, currentRound, maxRounds,
      selfEval, extractionSucceeded, lastSelfEval,
      consecutiveRejections, runtimeFilesChanged,
      evidenceSnapshots,
    } = input;

    const roundSuccess = selfEval.success ?? false;

    // ── 1. Query vault entries ──────────────────────────────────────────
    const vaultEntries: VaultEntry[] = this.backend
      ? this.backend.queryEntries({ prefix: `loop:${loopId}:r` })
      : [];

    // ── 2. Verification gate ────────────────────────────────────────────
    const verifyResult: VerificationResult = verifySelfEvaluation(
      selfEval,
      currentRound,
      vaultEntries,
      lastSelfEval ?? null,
      runtimeFilesChanged ?? null,
      evidenceSnapshots ?? [],
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

    // ── 3. Enforcement gate (structured extractions only) ───────────────
    // Heuristic evaluations have no reliable execution_evidence —
    // enforcement rules that depend on evidence are skipped.
    if (extractionSucceeded) {
      const enforceResult: EnforcementResult = enforceRound(
        selfEval,
        verifyResult,
        currentRound,
        vaultEntries,
        consecutiveRejections,
      );

      if (enforceResult.action === "reject") {
        const newRejections = consecutiveRejections + 1;
        const rejectionPrompt = buildRejectionPrompt(
          currentRound, task, enforceResult,
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
          roundSuccess,
          gateContradicted,
          newConsecutiveRejections: 0,
          newLastSelfEval: selfEval,
          shouldPushSuccessTrajectory: false,
        };
      }

      // Accept: reset rejection counter
      // (consecutiveRejections reset to 0 — caller persists)
    }

    // ── 4. Auto-feedback (AFTER enforcement, only if accepted) ──────────
    // ── 5. Stop condition checks ────────────────────────────────────────

    // 5a. Extraction failed → stalled
    if (!extractionSucceeded) {
      return {
        action: "stop",
        stopReason: "stalled",
        verificationFlags,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        newLastSelfEval: selfEval,
        shouldPushSuccessTrajectory: !gateContradicted,
      };
    }

    // 5b. Agent says stop
    if (!selfEval.should_continue) {
      const reason = roundSuccess ? "completed" : "failed";
      return {
        action: "stop",
        stopReason: reason,
        verificationFlags,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        newLastSelfEval: selfEval,
        shouldPushSuccessTrajectory: !gateContradicted,
      };
    }

    // 5c. Circuit breaker
    const projectedTrajectory = [...(input.successTrajectory ?? [])];
    if (!gateContradicted) projectedTrajectory.push(roundSuccess);
    const breakerSize = getPolicy().engine.max_circuit_breaker;
    const circuitBroken =
      projectedTrajectory.length >= breakerSize &&
      projectedTrajectory.slice(-breakerSize).every((value) => !value);
    if (circuitBroken) {
      return {
        action: "stop",
        stopReason: "circuit_breaker",
        verificationFlags,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        newLastSelfEval: selfEval,
        shouldPushSuccessTrajectory: !gateContradicted,
      };
    }

    // 5d. Max rounds reached
    if (currentRound >= maxRounds) {
      return {
        action: "stop",
        stopReason: "max_rounds",
        verificationFlags,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        newLastSelfEval: selfEval,
        shouldPushSuccessTrajectory: !gateContradicted,
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
      shouldPushSuccessTrajectory: !gateContradicted,
    };
  }
}
