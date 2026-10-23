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
import type { MachineObservation } from "./protocol.js";
import type { ObservationDelta } from "./evidence-provider.js";
import type {
  CheckpointRef,
  ContractTransition,
  EnforcementResult,
  SelfEvaluation,
  RoundVerificationStatus,
  StopReason,
  VerificationFlag,
  VerificationResult,
  WorkspaceCheckpointManifest,
} from "./protocol.js";
import {
  CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE,
  verifySelfEvaluation,
} from "./verification-gate.js";
import {
  checkpointForRoundBoundary,
  deriveRecoveryDirective,
  validateCheckpointManifest,
} from "./recovery.js";
import { driftedEntrypoints } from "./evidence-provider.js";
import { isRecord } from "./token-utils.js";
import { declaresBlocked, effectiveSuccess } from "./round-outcome.js";
import { derivationRounds } from "./committed-round.js";
import {
  deriveRoundProgress,
  STALL_PROGRESS_COVERAGE,
} from "./progress.js";
import {
  enforceRound,
  buildRejectionPrompt,
  findSafeRestorePoint,
} from "./enforcement-gate.js";
import { logEvent } from "./observability.js";
import { getPolicy } from "./policy.js";
import { deriveRoundContractView } from "./round-contract.js";
import {
  roundVerificationStatus,
  type ContractItemStatusView,
} from "./contract-items.js";


// ── Types ──────────────────────────────────────────────────────────────────

/** Input to a single round processing step. */
export interface RoundProcessInput {
  loopId: string;
  task: string;
  currentRound: number;
  maxRounds: number;
  /** The agent's self-evaluation for this round. */
  selfEval: SelfEvaluation;
  /** How many consecutive rounds have been rejected by enforcement. */
  consecutiveRejections: number;
  /** L4 (v3.7.x): which check rejected the previous round — lets uniform
   *  escalation rows act on their own streak, not an unrelated one. */
  lastRejectionCheck?: string;
  /** v1.18: Evidence snapshots from configured providers. */
  evidenceDeltas?: ObservationDelta[];
  /** Full round-start observations for post-backtrack restore validation. */
  beforeEvidence?: MachineObservation[];
  /** The current in-flight transaction's automatic before-image (machine
   *  backtrack target mapping only; never a cognitive input). */
  beforeCheckpoint?: CheckpointRef;
  /** This submission's after observations, used to derive abandoned-file
   *  report facts. */
  afterEvidence?: MachineObservation[];
  /** Reads the target checkpoint manifest for machine backtrack target
   *  eligibility and skipped-file derivation. Provided by the transaction
   *  layer's checkpoint store. */
  resolveCheckpointManifest?: (
    ref: CheckpointRef,
  ) => WorkspaceCheckpointManifest | null;
  /** v3.8.3: the trusted round-start fingerprint of every configured
   *  command's entrypoint files, captured when this round was prepared. Only
   *  the in-flight round has one — a round whose preparation predates the
   *  baseline (or whose session lost it) simply runs without the absolute
   *  arm and falls back to the git-delta rule. */
  entrypointTrust?: Record<string, string>;
  /** v3.9.4: the persisted submitted-field manifest. The files-reconciliation
   *  gate uses the same `execution_report.files_changed` attempt basis as the
   *  receipt; undefined keeps the legacy "report exists" fallback. */
  submittedFields?: string[];
}

/** Result of processing a round through the coordinator. */
export interface RoundProcessResult {
  /** What the caller should do next. */
  action: "continue" | "stop" | "reject" | "terminate" | "backtrack" | "recovery";
  /** v3.9.6: who produced the disposition. Evaluations are ordinary work;
   *  machine/agent recoveries are rollback directives. */
  origin?: "evaluation" | "machine" | "agent";
  /** v3.9.6: machine failure reason or agent recovery reason. */
  reason?: string;
  /** v3.9.6: committed rollback directive facts. */
  recovery?: import("./protocol.js").RecoveryDirective;
  /** Reason for stop (set when action is "stop" or "terminate"). */
  stopReason?: StopReason;
  /** Rejection prompt (set when action is "reject"). */
  rejectionPrompt?: string;
  /** Verification flags from this round (for injection into next prompt). */
  verificationFlags: VerificationFlag[];
  /** Enforcement action for observability. */
  enforcementAction?: "accept" | "reject" | "terminate" | "backtrack" | "recovery";
  /** Enforcement reason (set when rejected or terminated). */
  enforcementReason?: string;
  /** Whether this round was successful (from selfEval.success). */
  roundSuccess: boolean;
  /** Whether the verification gate returned "contradicted". */
  gateContradicted: boolean;
  /** v3.8: The round-level verification posture, derived from the ACTIVE
   *  contract's item statuses and this round's claims: `trusted` (everything
   *  claimed is machine-backed), `insufficient` (claims unbacked, nothing
   *  contradicted), `contradicted` (a machine fact denies a claim). */
  verificationStatus: RoundVerificationStatus;
  /** Updated consecutiveRejections count — caller must persist. */
  newConsecutiveRejections: number;
  /** Which enforcement check fired (set when action is "reject" or "terminate").
   *  Used by callers to track per-rule rejection counters. */
  rejectionCheck?: string;
  /** Whether the caller should push roundSuccess onto the success trajectory.
   *  false when gateContradicted or when action is "reject". */
  shouldPushSuccessTrajectory: boolean;
}

/** v3.2/v3.6: Whether a round's success enters the success trajectory.
 *  Excluded when the gate contradicted the round, or when the success claim
 *  carries no machine-verified observation — the merged R8 check fires a
 *  warn under machine_backed_success "warn" (v3.6: success_unverified merged
 *  into R8; its warn-level trajectory exclusion moved with it) — an
 *  accepted-but-unverified round is not evidence of progress. */
function shouldPushSuccess(
  gateContradicted: boolean,
  verificationFlags: VerificationFlag[],
  contractStatuses?: ContractItemStatusView,
): boolean {
  if (gateContradicted) return false;
  // v3.9.9: a redirect round abandons a slice; it is never success evidence.
  if (contractStatuses?.closure === "superseded") return false;
  // v3.8: an unverified contract item (or a claimed-but-unbacked success)
  // keeps the round out of the success trajectory — an accepted-but-unverified
  // round is not evidence of progress.
  if (contractStatuses && contractStatuses.insufficientCount > 0) return false;
  return !verificationFlags.some(
    (flag) =>
      flag.severity === "warn" &&
      flag.check === CHECK_SUCCESS_WITHOUT_VERIFIED_EVIDENCE,
  );
}

/** v3.8.3: Completion truth as a guard, not a convention.
 *
 *  A round that declares itself blocked is NOT a finished round — whatever
 *  else it claims — and neither is one whose contract closed on a `blocked`
 *  outcome. The stop decision below already orders `declaredBlocked` first,
 *  and `contractClosed` admits only `verified` or no contract, so this can
 *  never fire on the ordinary path. It is the SECOND line, called at the two
 *  points where the reason becomes durable or visible:
 *
 *  - the coordinator, BEFORE the transaction commits — the committed round
 *    document carries `result.stopReason`, so an unguarded reason here would
 *    be a false fact in the Vault, not just a wrong reply;
 *  - the lifecycle end, where the disposition is finalized into the reported
 *    stop reason and the terminal notification.
 *
 *  A violation can only mean a code defect routed a blocked round to
 *  `completed`. Throwing mid-lifecycle would kill the loop over a reporting
 *  bug, so the guard degrades to the honest reason and returns the downgrade
 *  as a flag: the loop keeps a truthful, observable stop instead of a false
 *  completion. */
export function finalizeStopReason(
  /** `undefined` when the disposition named no terminal reason at all (the
   *  callers fall back to their own default) — there is nothing to guard. */
  reason: StopReason | undefined,
  selfEval: SelfEvaluation,
  contractStatuses?: ContractItemStatusView | null,
  /** v3.9.9: the current round's transition. A committed redirect can never
   *  produce `completed` even if the old items were all verified. */
  transition?: ContractTransition | null,
): { reason: StopReason | undefined; flags: VerificationFlag[] } {
  if (reason !== "completed") return { reason, flags: [] };
  const declared = declaresBlocked(selfEval);
  const blockedContract = contractStatuses?.closure === "blocked";
  if (declared || blockedContract) {
    return {
      reason: "blocked",
      flags: [{
        severity: "warn",
        field: declared ? "outcome" : "round_contract",
        check: "completion_truth_downgraded",
        detail: declared
          ? "The round declared a blocked outcome but the stop decision produced " +
            "`completed`; the declaration wins and the stop reason was downgraded " +
            "to `blocked`."
          : "The active contract closed on a blocked outcome but the stop decision " +
            "produced `completed`; the stop reason was downgraded to `blocked`.",
      }],
    };
  }
  const superseded = contractStatuses?.closure === "superseded" ||
    Boolean(transition);
  if (superseded) {
    return {
      reason: "incomplete",
      flags: [{
        severity: "warn",
        field: "contract_transition",
        check: "completion_truth_downgraded",
        detail:
          "The round superseded its active contract, so the old slice is not " +
          "verified and the round cannot be `completed`; the stop reason was " +
          "downgraded to `incomplete`.",
      }],
    };
  }
  return { reason, flags: [] };
}

// ── RoundCoordinator ───────────────────────────────────────────────────────

/** v3.8.1: The rolled-back branch's facts — the ONE derivation of which rounds
 *  failed, which approaches must not be repeated, which assumptions were
 *  falsified, and which files (with their failed-round git fingerprints) the
 *  agent must restore.
 *
 *  Sources are COMMITTED rounds above the restore point; rejected attempts are
 *  not durable history and never become a source. The in-flight attempt that
 *  triggered the rollback is the one exception — its evaluation lives in this
 *  process, not in committed history.
 *
 *  Extracted from the coordinator's inline walk so it is unit-testable without
 *  driving a whole rollback, and so the prompt, the state file and the
 *  committed decision all describe one event. */
export function deriveBacktrackRecoveryFacts(input: {
  currentRound: number;
  restoreRound: number;
  vaultEntries: VaultEntry[];
  selfEval: SelfEvaluation;
  /** v3.9.7: the ONE discovery set from `findSafeRestorePoint` (committed
   *  skipped rounds only). The rejected trigger attempt contributes none. */
  skippedDiscoveries: ReadonlyArray<string>;
}): {
  skippedFiles: string[];
  skippedFingerprints: Record<string, string>;
  skippedDiscoveries: string[];
  failedRounds: number[];
  approaches: string[];
  wrongAssumptions: string[];
} {
  const { currentRound, restoreRound, vaultEntries, selfEval } = input;
  // v2.13: files changed in skipped rounds, for the restore prompt.
  const skippedFiles: string[] = [];
  // M3 (v3.7.x): each skipped file's git fingerprint at its failed round.
  // Recorded from the round's own after-evidence (machine data, not the
  // agent's report); later rounds overwrite earlier ones so the map holds the
  // LAST failed state of every file.
  const skippedFingerprints: Record<string, string> = {};
  const skippedDiscoveries: string[] = [...input.skippedDiscoveries];
  const failedRounds: number[] = [];
  const approaches: string[] = [];
  const wrongAssumptions: string[] = [];
  const window = derivationRounds(vaultEntries, currentRound);
  for (let r = restoreRound + 1; r < currentRound; r++) {
    const view = window.find((candidate) => candidate.round === r) ?? null;
    const evaluation = view?.evaluation ?? null;
    const report = view?.executionReport ?? null;
    if (report) {
      const reported = (report.files_changed ?? [])
        .filter((f): f is string => typeof f === "string");
      // v3.9.1: the machine delta is the primary set of files the failed
      // round changed; the agent report is unioned in so an ignored file the
      // agent named is not lost from the recovery brief.
      const machineFiles = (view?.observationDelta ?? [])
        .filter((delta) => delta.kind === "git" && delta.changedFiles !== null)
        .flatMap((delta) => delta.changedFiles!);
      const files = [...new Set([...machineFiles, ...reported])];
      const git = view?.afterEvidence.find(
        (snapshot) => snapshot.kind === "git" &&
          snapshot.status === "observed" &&
          isRecord(snapshot.data.fingerprints),
      );
      const gitFingerprints = git && git.kind === "git"
        ? (git.data.fingerprints as Record<string, unknown>)
        : null;
      for (const f of files) {
        if (!skippedFiles.includes(f)) skippedFiles.push(f);
        const fp = gitFingerprints?.[f];
        if (typeof fp === "string") skippedFingerprints[f] = fp;
      }
    }
    const summary = evaluation?.output_summary ?? "";
    if (summary.trim().length > 0) {
      failedRounds.push(r);
      approaches.push(summary.trim().slice(0, 200));
    }
    const assumptions = (evaluation?.wrong_assumptions ?? [])
      .filter((v: unknown): v is string => typeof v === "string")
      .map((s) => s.slice(0, 500));
    for (const a of assumptions) {
      if (!wrongAssumptions.includes(a)) wrongAssumptions.push(a);
    }
  }
  // The in-flight attempt that triggered this rollback.
  const triggerSummary = selfEval.output_summary?.trim() ?? "";
  if (triggerSummary.length > 0) {
    if (!failedRounds.includes(currentRound)) failedRounds.push(currentRound);
    approaches.push(triggerSummary.slice(0, 200));
    for (const a of (selfEval.wrong_assumptions ?? [])
      .filter((v: unknown): v is string => typeof v === "string")) {
      if (!wrongAssumptions.includes(a)) wrongAssumptions.push(a.slice(0, 500));
    }
  }
  // A discovery declared by the rejected trigger attempt is NOT committed and
  // must never become an active constraint through the rollback. Only
  // discoveries from committed skipped rounds are preserved.
  return {
    skippedFiles,
    skippedFingerprints,
    skippedDiscoveries,
    failedRounds,
    approaches,
    wrongAssumptions,
  };
}

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
   *  - State file I/O (both paths, after compiling) */
  processRound(
    input: RoundProcessInput,
  ): RoundProcessResult {
    const {
      loopId, task, currentRound, maxRounds,
      selfEval,
      consecutiveRejections,
      evidenceDeltas,
    } = input;

    const roundSuccess = selfEval.success ?? false;

    // ── 1. Query vault entries ──────────────────────────────────────────
    // Lineage entries (constraint violations, output summaries) and feedback
    // entries (including execution_report) are both needed by
    // the enforcement gate. queryLoopEntries excludes feedback by default,
    // so we issue a second query and merge both result sets.
    const prefix = `loop:${loopId}:r`;
    const vaultEntries: VaultEntry[] = this.store
      ? [
          ...queryLoopEntries(this.store, loopId, { prefix }),
          ...queryLoopEntries(this.store, loopId, { prefix, feedbackOnly: true }),
        ]
      : [];

    // v3.9.6: the previous evaluation is the last committed branch round,
    // never a session copy.
    const committedRounds = derivationRounds(vaultEntries, currentRound);
    const previousCommitted = committedRounds.length > 0
      ? committedRounds[committedRounds.length - 1]!.evaluation
      : null;
    // ── 2. Verification gate ────────────────────────────────────────────
    // v3.9.7: the old post-backtrack restore checks/R9 are gone. LoopForge
    // verifies the restore before issuing the redo prompt; a redo submission
    // is ordinary work, so its after boundary must never be compared to the
    // restore target.
    const verifyResult: VerificationResult = verifySelfEvaluation(
      selfEval,
      currentRound,
      vaultEntries,
      previousCommitted,
      evidenceDeltas ?? [],
      // v3.7.1: gate records live under the gate: prefix — outside the round
      // entries above — and are passed separately to the gate check.
      this.store
        ? queryLoopEntries(this.store, loopId, { prefix: `loop:${loopId}:gate:` })
        : [],
      // v3.8.3: the absolute arm of the entrypoint check. Derived here, not in
      // the gate, because it needs the filesystem and the in-flight trust map
      // captured when this round was prepared — the gate stays a pure function
      // of its inputs.
      driftedEntrypoints(input.entrypointTrust),
      // v3.9.4: the SAME manifest basis the receipt uses. An omitted
      // files_changed field is not silently treated as "a report exists".
      input.submittedFields
        ? input.submittedFields.includes("execution_report.files_changed")
        : undefined,
    );
    const verificationFlags = verifyResult.flags;
    const gateContradicted = verifyResult.verdict === "contradicted";

    // v3.8: the ACTIVE contract's derived item statuses for this round — the
    // same reducer the gate, compile path, audit and explain consume. Drives
    // the stop mapping (completed vs incomplete) and the success trajectory.
    // v3.8: the shared executed-contract derivation — the same one explain and
    // audit call, so the live posture and the read-only views cannot diverge.
    const { contract: activeContract, statuses: activeContractStatuses } =
      deriveRoundContractView({
        rounds: committedRounds,
        round: currentRound,
        current: {
          report: selfEval.execution_report ?? null,
          deltas: evidenceDeltas ?? [],
          blocked: declaresBlocked(selfEval),
          transition: selfEval.contract_transition ?? null,
        },
        commands: getPolicy().evidence.commands ?? [],
      });

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
      input.lastRejectionCheck ?? "",
      // v3.9.9: what THIS round moved, under the SAME Git workspace selector
      // the committed window uses. Unknown/not_applicable never gains the
      // stall excuse, and no other provider's fact can change this verdict.
      deriveRoundProgress(evidenceDeltas ?? [], STALL_PROGRESS_COVERAGE),
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
        verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
        rejectionPrompt,
        verificationFlags,
        enforcementAction: "reject",
        enforcementReason: enforceResult.reason,
        rejectionCheck: enforceResult.check,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: newRejections,
        shouldPushSuccessTrajectory: false,
      };
    }

    if (enforceResult.action === "terminate") {
      // v3.8: a row may name the stop reason it terminates with (the
      // verification-debt row reports `incomplete` — the agent stopped short
      // of machine verification, which is not the same as a contradiction).
      const terminateReason: StopReason =
        enforceResult.stopReason ?? "enforcement_terminated";
      logEvent("session_end", {
        loopId,
        stopReason: terminateReason,
        round: currentRound,
      });
      return {
        action: "terminate",
        verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
        stopReason: terminateReason,
        verificationFlags,
        enforcementAction: "terminate",
        enforcementReason: enforceResult.reason,
        rejectionCheck: enforceResult.check,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        shouldPushSuccessTrajectory: false,
      };
    }

    // ── v2.10 / v3.9.7: Backtrack ─────────────────────────────────────────
    if (enforceResult.action === "backtrack") {
      const maxDepth = getPolicy().engine.backtrack_max_depth;
      // The state after round T is the before-image of round T+1. A candidate
      // is eligible only when that image was materialized and its manifest is
      // readable; there is no verification-only fallback.
      const resolveRef = (restoreRound: number): CheckpointRef | null => {
        const redoRound = restoreRound + 1;
        const ref = checkpointForRoundBoundary({
          entries: vaultEntries,
          heldRound: currentRound,
          heldBeforeCheckpoint: input.beforeCheckpoint,
          redoRound,
        });
        if (!ref) return null;
        if (input.resolveCheckpointManifest) {
          const manifest = input.resolveCheckpointManifest(ref);
          // Machine target selection must prove the ref and manifest are
          // self-consistent BEFORE committing an immutable directive. Blob
          // and HEAD checks still run in the post-commit preflight.
          if (!manifest || !validateCheckpointManifest(ref, manifest).ok) {
            return null;
          }
        }
        return ref;
      };
      const restorePoint = findSafeRestorePoint(
        currentRound,
        vaultEntries,
        maxDepth,
        (restoreRound) => resolveRef(restoreRound) !== null,
      );

      if (!restorePoint) {
        // No clean round with a materialized restore point within maxDepth.
        logEvent("session_end", {
          loopId,
          stopReason: "enforcement_terminated",
          round: currentRound,
        });
        return {
          action: "terminate",
          verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
          stopReason: "enforcement_terminated",
          verificationFlags,
          enforcementAction: "terminate",
          enforcementReason:
            `${enforceResult.reason} (backtrack failed: no materialized restore point within ${maxDepth} rounds)`,
          rejectionCheck: enforceResult.check,
          roundSuccess,
          gateContradicted,
          newConsecutiveRejections: 0,
          shouldPushSuccessTrajectory: false,
        };
      }

      const targetRef = resolveRef(restorePoint.round);
      const targetManifest = targetRef && input.resolveCheckpointManifest
        ? input.resolveCheckpointManifest(targetRef)
        : null;
      if (!targetRef || !targetManifest) {
        logEvent("session_end", {
          loopId,
          stopReason: "enforcement_terminated",
          round: currentRound,
        });
        return {
          action: "terminate",
          verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
          stopReason: "enforcement_terminated",
          verificationFlags,
          enforcementAction: "terminate",
          enforcementReason:
            `${enforceResult.reason} (backtrack failed: restore point manifest unavailable)`,
          rejectionCheck: enforceResult.check,
          roundSuccess,
          gateContradicted,
          newConsecutiveRejections: 0,
          shouldPushSuccessTrajectory: false,
        };
      }

      const abandonedRounds = derivationRounds(vaultEntries, currentRound)
        .filter((view) => view.round >= targetRef.redoRound);
      const recovery = deriveRecoveryDirective({
        origin: "machine",
        reason: enforceResult.reason,
        ...(enforceResult.check ? { triggerRule: enforceResult.check } : {}),
        // The transaction layer fills the directive transaction id, which
        // depends on the prompt hash/branch identity.
        transactionId: "",
        targetRef,
        targetManifest,
        abandonedRounds,
        currentAfterEvidence: input.afterEvidence ?? [],
        triggerEvaluation: selfEval,
        triggerRound: currentRound,
      });

      logEvent("enforcement_backtrack", {
        loopId,
        round: currentRound,
        reason: enforceResult.reason.slice(0, 120),
        check: enforceResult.check ?? "",
        backtrackTarget: targetRef.redoRound,
        skippedDiscoveries: recovery.skipped_discoveries.length,
      });

      return {
        action: "backtrack",
        origin: "machine",
        reason: enforceResult.reason,
        recovery,
        verificationStatus: "not_applicable",
        verificationFlags,
        enforcementAction: "backtrack",
        enforcementReason: enforceResult.reason,
        rejectionCheck: enforceResult.check,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0, // reset — fresh start
        shouldPushSuccessTrajectory: false,
      };
    }

    // Accept: reset rejection counter
    // (consecutiveRejections reset to 0 — caller persists)

    // ── 4. Auto-feedback (AFTER enforcement, only if accepted) ──────────
    // ── 5. Stop condition checks ────────────────────────────────────────

    // 5b. Agent says stop
    if (!selfEval.should_continue) {
      // v3.8: `completed` is a machine claim. It requires the active contract
      // to be closed — every item `verified` — or no contract at all. A stop
      // with claimed-but-unverified items is `incomplete`, never `completed`.
      // An empty contract id means no contract is active (the reducer's
      // sentinel view) — a contract-less loop completes on the success claim
      // alone, exactly as before v3.8.
      //
      // A `blocked` closure deliberately does NOT satisfy `contractClosed`: a
      // contract closed by its own blocked outcome is not a verified one, and
      // the declaration arm below already owns that posture.
      const contractClosed = activeContractStatuses.contractId === "" ||
        activeContractStatuses.closure === "verified";
      // The agent's explicit declaration of a blocked stop outranks the
      // success claim. It is checked FIRST so `success: true` + a declared
      // `outcome`/`stop_reason` of blocked can never be reported as
      // `completed` — the two fields contradict, and the honest reading is the
      // declared one. A contradicted item also never reaches `completed`
      // (closure is `verified` only when EVERY item is), so the
      // contradicted-and-stopping posture lands on `incomplete` at worst; the
      // reject/terminate path for it is the enforcement gate's, evaluated
      // before this point.
      const declaredBlocked = declaresBlocked(selfEval);
      let reason: StopReason;
      if (declaredBlocked) {
        reason = "blocked";
      } else if (effectiveSuccess(selfEval) && contractClosed) {
        reason = "completed";
      } else if (effectiveSuccess(selfEval)) {
        reason = "incomplete";
      } else {
        reason = "failed";
      }
      // v3.8.3: the guard runs BEFORE the transaction commits — this reason
      // is written into the committed round document below, so it must be
      // truthful at the moment it becomes a fact, not only when it is
      // returned to the client.
      const finalized = finalizeStopReason(
        reason,
        selfEval,
        activeContractStatuses,
        selfEval.contract_transition ?? null,
      );
      return {
        action: "stop",
        verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
        stopReason: finalized.reason,
        verificationFlags: finalized.flags.length > 0
          ? [...verificationFlags, ...finalized.flags]
          : verificationFlags,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        shouldPushSuccessTrajectory: shouldPushSuccess(gateContradicted, verificationFlags, activeContractStatuses),
      };
    }

    // 5c. Max rounds reached
    //
    // Progress stalls are handled before this point by the R4 delta tier and
    // R5 flatline tier. Max rounds is an independent hard boundary.
    if (currentRound >= maxRounds) {
      return {
        action: "stop",
        verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
        stopReason: "max_rounds",
        verificationFlags,
        roundSuccess,
        gateContradicted,
        newConsecutiveRejections: 0,
        shouldPushSuccessTrajectory: shouldPushSuccess(gateContradicted, verificationFlags, activeContractStatuses),
      };
    }

    // ── 6. Continue — caller compiles next round ────────────────────────
    return {
      action: "continue",
      verificationStatus: roundVerificationStatus(activeContractStatuses, selfEval.execution_report ?? null),
      verificationFlags,
      enforcementAction: "accept",
      roundSuccess,
      gateContradicted,
      newConsecutiveRejections: 0,
      shouldPushSuccessTrajectory: shouldPushSuccess(gateContradicted, verificationFlags, activeContractStatuses),
    };
  }
}
