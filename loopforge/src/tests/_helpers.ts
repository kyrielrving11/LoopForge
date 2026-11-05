/** Shared test utilities — in-memory store, test data factories.
 *
 * Imported by replay.test.ts and mcp.test.ts to avoid ~50 lines of
 * duplicated MemoryLoopStore implementation.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LoopStore,
  LoopSessionDocument,
  LoopRoundDocument,
  VaultEntry,
} from "../loop-store.js";
import { LOOP_STORE_SCHEMA_VERSION } from "../loop-store.js";
import {
  ROUND_TRANSACTION_SCHEMA_VERSION,
  rootBranchId,
} from "../round-transaction.js";
import {
  PROMPT_ARTIFACT_SCHEMA_VERSION,
  makeExecutionReport,
  makeSelfEvaluation,
} from "../protocol.js";
import type {
  CheckpointRef,
  CompiledRoundFacts,
  ContractSupersede,
  EvidencePosture,
  ExecutionClaim,
  MachineObservation,
  PromptArtifact,
  RoundContractProposal,
  RoundOutcome,
  SelfEvaluation,
  SubmissionHandle,
  VerificationFlag,
} from "../protocol.js";
import type {
  GitDeltaState,
  ObservationDelta,
  ObservationProgress,
} from "../evidence-provider.js";
import { GIT_WORKSPACE_COVERAGE } from "../git-motion.js";
import { getPolicy } from "../policy.js";
import { deriveCriterionId } from "../token-utils.js";
import { POLICY_SCHEMA_VERSION } from "../policy.js";

/** The compiler's default objective criterion when the task declares none. */
export const DEFAULT_SUCCESS_CRITERION =
  "Task goal achieved with verifiable evidence";

/** v4.0.3: a structurally valid committed posture for fixtures that only need
 *  the envelope to decode. Tests that assert posture semantics build their
 *  own facts. */
export function fixtureEvidencePosture(
  round: number,
  overrides: Partial<EvidencePosture> = {},
): EvidencePosture {
  return {
    round,
    kind: "evaluation",
    status: "not_applicable",
    machineBackedSuccess: false,
    verificationConfigured: false,
    workspace: { status: "not_applicable", changedPathCount: 0 },
    files: null,
    providers: [],
    commands: [],
    contract: null,
    findings: [],
    omitted: { providers: 0, commands: 0, contractItems: 0, findings: 0 },
    ...overrides,
  };
}

/** The rollback posture: no evaluation, no evidence, no claims. */
export function fixtureRollbackEvidencePosture(round: number): EvidencePosture {
  return fixtureEvidencePosture(round, { kind: "rollback" });
}

/** v4.0.6 fixture: a continuing round with an after-capable command must
 *  leave an active contract. Test suites that are not about contract flow use
 *  a per-round default slice so ordinary continuations satisfy coverage.
 *
 *  When `activeItemIds` is supplied, the evaluation also claims those ACTIVE
 *  items `met` so the round's passed verification command closes the old
 *  contract before the successor proposal is judged. The per-round tag keeps
 *  every successor's acceptance content distinct (`contract_successor_unchanged`). */
export function withDefaultContract(
  input: Record<string, unknown>,
  options: { tag?: string; activeItemIds?: readonly string[] } = {},
): Record<string, unknown> {
  const evaluation = input.evaluation;
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
    return input;
  }
  const record = evaluation as Record<string, unknown>;
  if (record.outcome === "blocked") return input;
  const continuing = record.should_continue !== false;
  // A stop round carries no new contract, but it may still close the ACTIVE
  // one; claim management follows contract management, not "continuing".
  const managingContract = record.round_contract === undefined;
  const injectingContract = continuing && managingContract;
  const command = getPolicy().evidence.commands.find(
    (candidate) => candidate.enabled &&
      (candidate.phase === "after" || candidate.phase === "both"));
  if (!command) return input;
  const tag = options.tag ?? "default";
  const claims: Array<{ id: string; outcome: "met" }> = [];
  const report = record.execution_report;
  const reportRecord = report && typeof report === "object" && !Array.isArray(report)
    ? report as Record<string, unknown>
    : {};
  const existingClaims = Array.isArray(reportRecord.claims)
    ? reportRecord.claims as Array<Record<string, unknown>>
    : [];
  const claimed = new Set(existingClaims.map((claim) => String(claim.id)));
  // Only the fixture's own default contract carries the active-item claim.
  // A test that provides an explicit proposal is exercising contract
  // semantics itself and must control its claims.
  if (managingContract) {
    for (const id of options.activeItemIds ?? []) {
      if (!claimed.has(id)) claims.push({ id, outcome: "met" });
    }
  }
  const effectiveReport: Record<string, unknown> = {
    ...reportRecord,
    ...(existingClaims.length > 0 || claims.length > 0
      ? { claims: [...existingClaims, ...claims] }
      : {}),
  };
  return {
    ...input,
    evaluation: {
      ...record,
      ...(injectingContract
        ? {
            round_contract: {
              work_item: `test slice ${tag}`,
              items: [{
                description: `the configured verification command passes (${tag})`,
                verify_with: [command.name],
              }],
            },
          }
        : {}),
      ...(Object.keys(effectiveReport).length > 0
        ? { execution_report: effectiveReport }
        : {}),
    },
  };
}

/** v4.0.0: tool-handler wrapper that supplies the current held handle for
 *  tests that drive the handler directly. A test that deliberately submits a
 *  stale handle passes `input.submissionHandle` explicitly. */
export function toolNext(
  mgr: import("../mcp/session.js").SessionManager,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = String(
    input.sessionId ??
      (input.submissionHandle as { sessionId?: unknown } | undefined)?.sessionId ??
      "",
  );
  const handle = input.submissionHandle ?? mgr.getSubmissionHandle(sessionId);
  const session = mgr.get(sessionId);
  const active = mgr.getActiveContract(sessionId);
  const prepared = withDefaultContract(input, {
    tag: `r${session?.currentRound ?? 1}`,
    activeItemIds: (active?.items ?? []).map((item) => item.id),
  });
  return import("../mcp/tools.js").then(({ TOOL_HANDLERS }) =>
    TOOL_HANDLERS.loopforge_next(mgr, {
      ...prepared,
      ...(handle ? { submissionHandle: handle } : {}),
    }),
  );
}

/** v4.0.0: test-only submission helper. Tests that drive a session in order
 *  use the current handle; tests that deliberately submit a stale handle call
 *  `mgr.advance(handle, ...)` raw. */
export async function advanceWithHeld(
  mgr: import("../mcp/session.js").SessionManager,
  sessionId: string,
  output: string,
  evaluation?: unknown,
  submissionHandle?: SubmissionHandle,
) {
  const session = mgr.get(sessionId);
  const active = mgr.getActiveContract(sessionId);
  const effective = evaluation && typeof evaluation === "object" &&
    !Array.isArray(evaluation)
    ? withDefaultContract({ evaluation }, {
        tag: `r${session?.currentRound ?? 1}`,
        activeItemIds: (active?.items ?? []).map((item) => item.id),
      }).evaluation
    : evaluation;
  return mgr.advance(
    submissionHandle ?? mgr.getSubmissionHandle(sessionId),
    output,
    effective,
  );
}

/** v3.9.7: a fixture that supplies observed Git before-evidence must also
 *  supply the schema-5 before-image fact. Old fixtures use this explicit
 *  unavailable fact rather than fabricating a restorable checkpoint. */
export function fixtureBeforeCheckpointError(observations: unknown): {
  beforeCheckpointError?: { code: string; detail: string; at: number };
} {
  const observedGit = Array.isArray(observations) && observations.some((item) =>
    item && typeof item === "object" &&
    (item as { kind?: unknown }).kind === "git" &&
    (item as { status?: unknown }).status === "observed");
  return observedGit
    ? { beforeCheckpointError: { code: "fixture_unavailable", detail: "test fixture", at: 0 } }
    : {};
}

/** v3.8 / v4.0.6: Build the claims an evaluation submits. The helper keeps its
 *  historical name (tests call it for `cr-` claims), but the entries use the
 *  ONE `{ id, outcome }` claims shape. */
export function criterionClaims(met: string[] = [], remaining: string[] = []): ExecutionClaim[] {
  const idOf = (value: string): string =>
    value.startsWith("cr-") || value.startsWith("rci-")
      ? value
      : deriveCriterionId(value);
  return [
    ...met.map((value) => ({ id: idOf(value), outcome: "met" as const })),
    ...remaining.map((value) => ({ id: idOf(value), outcome: "remaining" as const })),
  ];
}

/** v4.0.6: an `rci-` claim list in the ONE claims shape. */
export function itemClaims(
  claims: Array<{ item_id: string; outcome: "met" | "remaining" }> = [],
): ExecutionClaim[] {
  return claims.map((claim) => ({ id: claim.item_id, outcome: claim.outcome }));
}

/** A committed round always carries its attempted manifest. Tests build the
 *  manifest from what the fixture evaluation actually contains, so the
 *  accounting read model sees the same fields the round declared. */
export function manifestFor(evaluation: SelfEvaluation): string[] {
  const fields = [
    "outcome", "output_summary", "constraint_violations", "should_continue",
  ];
  if (evaluation.execution_report) {
    fields.push("execution_report.files_changed");
    if ((evaluation.execution_report.claims ?? []).length > 0) {
      fields.push("execution_report.claims");
    }
  }
  if (evaluation.objective_refinement !== undefined) {
    fields.push("objective_refinement");
  }
  if ((evaluation.discovered_constraints ?? []).length > 0) fields.push("discovered_constraints");
  if ((evaluation.emerged_subtasks ?? []).length > 0) fields.push("emerged_subtasks");
  if ((evaluation.subgoal_updates ?? []).length > 0) fields.push("subgoal_updates");
  if ((evaluation.retracted_constraints ?? []).length > 0) fields.push("retracted_constraints");
  if ((evaluation.wrong_assumptions ?? []).length > 0) fields.push("wrong_assumptions");
  if ((evaluation.open_questions ?? []).length > 0) fields.push("open_questions");
  if ((evaluation.resolved_open_question_ids ?? []).length > 0) fields.push("resolved_open_question_ids");
  if (evaluation.round_contract) fields.push("round_contract");
  return fields;
}

/** v3.9.6: a held prompt artifact for session reconstruction tests. */
export function promptArtifact(input: {
  roundId: string;
  round: number;
  renderedPrompt: string;
  level?: "l0" | "l1" | "l2";
  attempt?: number;
  warnings?: string[];
  contextMode?: "fresh_invocation" | "same_round_retry";
  contextReason?: "first_round" | "next_round" | "recovery_redo" | "enforcement_retry" | "rejection_escalation" | "invocation_recovery";
}): PromptArtifact {
  return {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
    roundId: input.roundId,
    round: input.round,
    attempt: input.attempt ?? 1,
    level: input.level ?? "l1",
    contextMode: input.contextMode ?? "fresh_invocation",
    contextReason: input.contextReason ?? "next_round",
    renderedPrompt: input.renderedPrompt,
    promptHash: `hash-${input.round}`,
    stateHash: `state-${input.round}`,
    sections: [],
    droppedSections: [],
    protectedOverflow: false,
    budget: 10_000,
    renderedChars: input.renderedPrompt.length,
    coverage: { active: [], rendered: [], omitted: [], complete: true },
    warnings: [...(input.warnings ?? [])],
  };
}

/** Test-only: the progress fact an after-only fixture delta carries. A
 *  one-sided pair is never a comparable verdict, so Git always yields an
 *  `unknown` fact and a custom provider yields one only when it persisted a
 *  snapshot. */
function fixtureProgress(
  observation: MachineObservation,
): ObservationProgress | null {
  if (observation.kind === "git") {
    return {
      kind: "git",
      coverage: { ...GIT_WORKSPACE_COVERAGE },
      state: "unknown",
      complete: false,
      detail: "test fixture has no before boundary",
    };
  }
  return null;
}

/** Test-only: wrap raw after observations as after-only deltas. A Git
 *  observation's own `files` is its test-authored change set; command/custom
 *  deltas carry no file-change concept. */
export function deltasFrom(observations: MachineObservation[]): ObservationDelta[] {
  return observations.map((observation) => ({
    providerId: observation.providerId,
    kind: observation.kind,
    before: null,
    after: observation,
    changedFiles: observation.kind === "git" ? [...observation.files] : null,
    progress: fixtureProgress(observation),
  }));
}

/** Test-only: one explicit delta. */
export function deltaAfter(
  observation: MachineObservation,
  changedFiles: string[] | null = null,
): ObservationDelta {
  return {
    providerId: observation.providerId,
    kind: observation.kind,
    before: null,
    after: observation,
    changedFiles,
    progress: fixtureProgress(observation),
  };
}

/** Test-only: build the Git applicability/observability tri-state.
 *  undefined = not applicable, null = unknown, array = observed. */
export function gitState(files?: string[] | null): GitDeltaState {
  if (files === undefined) return { state: "not_applicable" };
  if (files === null) return { state: "unknown" };
  return { state: "observed", changedFiles: new Set(files) };
}

// ── v3.5.1: shared committed-round fixtures ─────────────────────────────────
// One builder each for the two vault entry shapes every contract/dashboard
// suite needs — previously each test file carried its own ~35-line twin
// (feedbackRound / feedbackRaw / committedRound / mergedRound), and a change
// to the committed shape had to be mirrored in three files.

/** v3.5.1: Raw committed :feedback vault entry — the shape on disk.
 *  snapshot.evaluation is the only committed copy of round_contract /
 *  outcome / met claims; snapshot.attempt + snapshot.roundEvidence carry
 *  the machine-observed data the engine stamps onto merged lineage entries
 *  at hydration. A contract passed here was PROPOSED at `round` and becomes
 *  the ACTIVE contract for round+1 (declaration-round met claims never
 *  satisfy its own proposal). */
export function committedFeedbackRound(
  round: number,
  opts: {
    contract?: RoundContractProposal;
    outcome?: RoundOutcome;
    met?: string[];
    remaining?: string[];
    emergedSubtasks?: string[];
    action?: string;
    attempt?: number;
    /** 3.9.3: the committed round's effective success. Fixtures used to omit
     *  `agentSuccessClaim`, making every decoded view look failed. */
    success?: boolean;
    /** v3.9.6: the branch this evaluation belongs to. */
    branchId?: string;
    beforeEvidence?: unknown[];
    roundEvidence?: unknown[];
    files?: string[];
    progress?: number;
    noExecutionReport?: boolean;
    discoveredConstraints?: string[];
    constraintViolations?: string[];
    stopReason?: import("../protocol.js").StopReason;
    /** v4.0.2: committed report facts for Working Memory / replay / explain. */
    outputSummary?: string;
    /** Fixture convenience: maps a legacy stop declaration onto the ONE
     *  `outcome` + `blocker` shape. */
    agentStopReason?: "gave_up" | "blocked" | "needs_human_input";
    /** v4.0.4: the Agent's declared should_continue. */
    shouldContinue?: boolean;
    wrongAssumptions?: string[];
    retractedConstraints?: string[];
    openQuestions?: string[];
    resolvedOpenQuestionIds?: string[];
    blocker?: string;
    verificationFlags?: VerificationFlag[];
    loopId?: string;
    /** v3.8: machine binding stamped on the committed contract. */
    contractBinding?: unknown;
    /** v3.8: committed item claims (replaces the legacy `met` list). */
    contractItemClaims?: Array<{ item_id: string; outcome: "met" | "remaining" }>;
    /** v3.9.9/v4.0.6: a committed contract redirect; merged into the
     *  contract proposal's optional `supersedes`. */
    contractTransition?: ContractSupersede;
    /** v4.0.6: the Agent's committed overall-objective refinement. */
    objectiveRefinement?: string;
    /** The operator acceptance task carried by this committed round. */
    task?: string;
    /** v4.0.1: the prompt artifact stamped on the committed transaction. */
    promptArtifact?: PromptArtifact;
    /** v4.0.1: compile facts stamped on the committed transaction. */
    compiled?: CompiledRoundFacts;
    /** v4.0.3: an explicit persisted evidence posture for the round. */
    evidencePosture?: EvidencePosture;
    /** v4.0.3: Agent-report fields surfaced by replay/explain. */
    workerResults?: import("../protocol.js").WorkerResult[];
    retroactiveClaims?: Array<{ round: number; claim: string }>;
    gateIds?: string[];
    noChangeReason?: string;
    subtaskBoundary?: boolean;
    subtaskBoundaryLabel?: string;
    subgoalUpdates?: import("../protocol.js").SubGoalUpdate[];
    /** v4.0.3: committed checkpoints and the verified-restore marker. */
    beforeCheckpoint?: CheckpointRef;
    checkpoints?: CheckpointRef[];
    /** v4.0.3: the immutable operator criteria carried by the round. */
    criteria?: string[];
    restore?: {
      directiveTransactionId: string;
      redoRound: number;
      verifiedAt: number;
    };
  } = {},
): VaultEntry {
  const loopId = opts.loopId ?? "cc";
  const fixtureOutcome = opts.outcome ??
    (opts.agentStopReason === "blocked" || opts.agentStopReason === "needs_human_input"
      ? "blocked"
      : opts.success ? "success" : "failed");
  const fixtureBlocker = opts.blocker ??
    (fixtureOutcome === "blocked"
      ? (opts.agentStopReason === "needs_human_input"
          ? "needs human input (fixture)"
          : "blocked (fixture)")
      : undefined);
  const fixtureContract = opts.contract
    ? {
        ...opts.contract,
        ...(opts.contractTransition
          ? { supersedes: opts.contractTransition }
          : {}),
      }
    : opts.contract;
  const evaluation = makeSelfEvaluation({
    outcome: fixtureOutcome,
    output_summary: opts.outputSummary ?? `Committed round ${round}.`,
    constraint_violations: opts.constraintViolations ?? [],
    should_continue: opts.shouldContinue ?? true,
    objective_refinement: opts.objectiveRefinement,
    wrong_assumptions: opts.wrongAssumptions ?? [],
    retracted_constraints: opts.retractedConstraints ?? [],
    open_questions: opts.openQuestions ?? [],
    resolved_open_question_ids: opts.resolvedOpenQuestionIds ?? [],
    blocker: fixtureBlocker,
    round_contract: fixtureContract,
    emerged_subtasks: opts.emergedSubtasks ?? [],
    subgoal_updates: opts.subgoalUpdates ?? [],
    worker_results: opts.workerResults ?? [],
    retroactiveClaims: opts.retroactiveClaims ?? [],
    gate_ids: opts.gateIds ?? [],
    no_change_reason: opts.noChangeReason,
    subtask_boundary: opts.subtaskBoundary ?? false,
    subtask_boundary_label: opts.subtaskBoundaryLabel ?? "",
    discovered_constraints: opts.discoveredConstraints ?? [],
    execution_report: opts.noExecutionReport
      ? undefined
      : makeExecutionReport({
          files_changed: opts.files ?? [],
          claims: [
            ...criterionClaims(opts.met ?? [], opts.remaining ?? []),
            ...itemClaims(opts.contractItemClaims ?? []),
          ],
        }),
  });
  return {
    task_id: `loop:${loopId}:r${round}:feedback`,
    task_type: "feedback",
    loop_id: loopId,
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
        round_id: `loop:${loopId}:round:${round}`,
        snapshot: {
          schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
          kind: "evaluation",
          branchId: opts.branchId ?? rootBranchId(loopId),
          transactionId: `tx-${loopId}-${round}-${opts.attempt ?? 1}`,
          roundId: `loop:${loopId}:round:${round}`,
          loopId,
          round,
          attempt: opts.attempt ?? 1,
          phase: "committed",
          beforeEvidence: opts.beforeEvidence ?? [],
          afterEvidence: opts.roundEvidence,
          operatorAcceptance: {
            task: opts.task ?? "Test task",
            success_criteria: opts.criteria ?? [],
            hard_constraints: [],
          },
          ...(opts.beforeCheckpoint ? { beforeCheckpoint: opts.beforeCheckpoint } : {}),
          ...(opts.checkpoints ? { checkpoints: opts.checkpoints } : {}),
          compiled: opts.compiled ?? {
            task: opts.task ?? "Test task",
            goalId: "",
            constraintsActive: [],
            constraintsRetired: [],
          },
          ...(opts.promptArtifact ? { promptArtifact: opts.promptArtifact } : {}),
          ...fixtureBeforeCheckpointError(opts.beforeEvidence ?? []),
          ...(opts.restore ? { restore: opts.restore } : {}),
          ...(opts.contractBinding !== undefined ? { contractBinding: opts.contractBinding } : {}),
          createdAt: 0,
          updatedAt: 0,
          evaluation,
          submittedFields: manifestFor(evaluation),
        },
        result: {
          action: opts.action ?? "continue",
          ...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
          verificationFlags: opts.verificationFlags ?? [],
          agentSuccessClaim: fixtureOutcome === "success",
          agentOutcome: fixtureOutcome,
          evidencePosture: opts.evidencePosture ?? fixtureEvidencePosture(round),
        },
      },
    },
  };
}

/** v3.8: A committed backtrack directive — the rollback record written when
 *  the enforcement gate rolls a stalled round back. Its transaction carries a
 *  full committed snapshot like every other committed round; the branch read
 *  model excludes it from final history. */
export function committedBacktrackRound(
  round: number,
  loopId = "test-loop",
  /** Restore point; defaults to the depth-1 target `round - 1`. */
  target = round - 1,
  opts: { branchId?: string; transactionId?: string } = {},
): VaultEntry {
  const transactionId = opts.transactionId ?? `tx-rollback-${loopId}-${round}`;
  const redoRound = target + 1;
  const recovery = {
    origin: "machine" as const,
    reason: "test_restore",
    trigger_rule: "test_restore",
    target: {
      checkpoint_id: `ck-${createHash("sha256").update(`${loopId}:${redoRound}`).digest("hex").slice(0, 24)}`,
      content_hash: createHash("sha256").update(`${loopId}:${redoRound}:content`).digest("hex"),
      role: "before" as const,
      round: redoRound,
      round_id: `loop:${loopId}:round:${redoRound}`,
      transaction_id: `tx-${loopId}-${redoRound}-1`,
      redo_round: redoRound,
    },
    skipped_files: [],
    skipped_discoveries: [],
    failed_rounds: [round],
    approaches: [],
    wrong_assumptions: [],
    transaction_id: transactionId,
  };
  return {
    task_id: `loop:${loopId}:r${round}:rollback:${transactionId}`,
    task_type: "rollback_directive",
    loop_id: loopId,
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
        round_id: `loop:${loopId}:round:${round}`,
        snapshot: {
          schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
          kind: "rollback",
          branchId: opts.branchId ?? rootBranchId(loopId),
          transactionId,
          roundId: `loop:${loopId}:round:${round}`,
          loopId,
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: [],
          afterEvidence: [],
          operatorAcceptance: {
            task: "Test task",
            success_criteria: [],
            hard_constraints: [],
          },
          recovery,
          createdAt: 0,
          updatedAt: 0,
        },
        result: {
          action: "recovery",
          origin: "machine",
          reason: recovery.reason,
          recovery,
          verificationFlags: [],
          agentSuccessClaim: false,
          agentOutcome: null,
          evidencePosture: fixtureRollbackEvidencePosture(round),
        },
      },
    },
  };
}

/** v3.9.1: attach the embedded transaction snapshot a hydrated merged entry
 *  must carry. Ad-hoc test entries used to rely on raw-field reconstruction;
 *  the read model now has one source, so fixtures stamp the envelope too. */
export function withTransaction(
  entry: Record<string, unknown>,
  action: "continue" | "stop" | "backtrack" = "continue",
  evidence: {
    beforeEvidence?: unknown[];
    afterEvidence?: unknown[];
  } = {},
): Record<string, unknown> {
  const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
  const loopId = String(entry.loop_id ?? lineage.loop_id ?? "");
  const round = Number(lineage.round ?? entry.round ?? 0);
  entry.task_id = `loop:${loopId}:r${round}:feedback`;
  entry.task_type = "feedback";
  const outcome = entry.outcome === "success" || entry.outcome === "partial" ||
    entry.outcome === "failed" || entry.outcome === "blocked"
    ? entry.outcome as SelfEvaluation["outcome"]
    : (entry.success === true ? "success" as const : "failed" as const);
  const evaluation = {
    outcome,
    output_summary: String(entry.output_summary ?? ""),
    constraint_violations: Array.isArray(entry.constraint_violations)
      ? entry.constraint_violations
      : [],
    should_continue: true,
    ...(Array.isArray(entry.emerged_subtasks)
      ? { emerged_subtasks: entry.emerged_subtasks }
      : {}),
    ...(Array.isArray(entry.subgoal_updates)
      ? { subgoal_updates: entry.subgoal_updates }
      : {}),
    ...(Array.isArray(entry.discovered_constraints)
      ? { discovered_constraints: entry.discovered_constraints }
      : {}),
    ...(Array.isArray(entry.retracted_constraints)
      ? { retracted_constraints: entry.retracted_constraints }
      : {}),
    ...(Array.isArray(entry.wrong_assumptions)
      ? { wrong_assumptions: entry.wrong_assumptions }
      : {}),
    ...(Array.isArray(entry.worker_results)
      ? { worker_results: entry.worker_results }
      : {}),
    ...(entry.subtask_boundary === true
      ? {
          subtask_boundary: true,
          ...(typeof entry.subtask_boundary_label === "string"
            ? { subtask_boundary_label: entry.subtask_boundary_label }
            : {}),
        }
      : {}),
    ...(entry.execution_report !== undefined
      ? { execution_report: entry.execution_report }
      : {}),
    ...(entry.round_contract !== undefined
      ? { round_contract: entry.round_contract }
      : {}),
  } as unknown as SelfEvaluation;
  const result = {
    action,
    verificationFlags: Array.isArray(entry.verification_flags)
      ? entry.verification_flags
      : [],
    agentSuccessClaim: outcome === "success",
    agentOutcome: outcome,
    gateContradicted: false,
    evidencePosture: fixtureEvidencePosture(round),
    newConsecutiveRejections: 0,
    shouldPushSuccessTrajectory: false,
  };
  const snapshot = {
    schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
    kind: "evaluation",
    branchId: rootBranchId(loopId),
    transactionId: `tx-${loopId}-${round}-${Number(lineage.attempt ?? 1)}`,
    roundId: `loop:${loopId}:round:${round}`,
    loopId,
    round,
    attempt: Number(lineage.attempt ?? 1),
    phase: "committed",
    beforeEvidence: evidence.beforeEvidence ?? [],
    afterEvidence: evidence.afterEvidence ?? [],
    operatorAcceptance: {
      task: String(entry.task ?? "Test task"),
      success_criteria: [],
      hard_constraints: [],
    },
    compiled: {
      task: String(entry.task ?? "Test task"),
      goalId: "",
      constraintsActive: Array.isArray(lineage.constraints_active)
        ? lineage.constraints_active as string[]
        : [],
      constraintsRetired: Array.isArray(lineage.constraints_retired)
        ? lineage.constraints_retired as string[]
        : [],
    },
    ...fixtureBeforeCheckpointError(evidence.beforeEvidence ?? []),
    evaluation,
    submittedFields: manifestFor(evaluation),
    result,
    createdAt: 0,
    updatedAt: 0,
  };
  lineage.round_transaction = {
    schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
    round_id: snapshot.roundId,
    snapshot,
    result,
  };
  entry.loop_lineage = lineage;
  return entry;
}

/** v3.5.1: Merged production-shape lineage entry — engine hydration merges
 *  a committed eval onto the round's lineage entry (fields top-level AND in
 *  loop_lineage) and stamps committed_action, and since v3.5.1 also
 *  lineage.attempt / lineage.round_evidence (the compile-view dashboard
 *  data). The compile-side contract extraction (mergedEntryEvaluation) and
 *  the dashboard readers consume exactly this shape. */
export function mergedLineageRound(
  round: number,
  opts: {
    contract?: RoundContractProposal;
    outcome?: RoundOutcome;
    met?: string[];
    action?: string;
    /** false → omit committed_action (an uncommitted compile-time entry). */
    committed?: boolean;
    attempt?: number;
    /** 3.9.3: the committed round's effective success. */
    success?: boolean;
    /** v3.9.6: the branch this evaluation belongs to. */
    branchId?: string;
    beforeEvidence?: unknown[];
    roundEvidence?: unknown[];
    files?: string[];
    progress?: number;
    loopId?: string;
    /** v3.8: machine binding stamped on the committed contract. */
    contractBinding?: unknown;
    /** v3.8: the round's committed item claims. */
    contractItemClaims?: Array<{ item_id: string; outcome: "met" | "remaining" }>;
    /** v3.9.1: the committed output summary carried by the evaluation. */
    outputSummary?: string;
    /** v3.9.1: committed constraint violations and verification flags. */
    constraintViolations?: string[];
    verificationFlags?: VerificationFlag[];
    /** v3.9.9/v4.0.6: a committed contract redirect. */
    contractTransition?: ContractSupersede;
    /** v4.0.6: the Agent's committed overall-objective refinement. */
    objectiveRefinement?: string;
    /** The operator acceptance task carried by this committed round. */
    task?: string;
  } = {},
): Record<string, unknown> {
  const loopId = opts.loopId ?? "me";
  const fixtureOutcome = opts.outcome ?? (opts.success ? "success" : "failed");
  const fixtureContract = opts.contract
    ? {
        ...opts.contract,
        ...(opts.contractTransition
          ? { supersedes: opts.contractTransition }
          : {}),
      }
    : opts.contract;
  const lin: Record<string, unknown> = {
    loop_id: loopId,
    round,
    outcome: fixtureOutcome,
    ...(opts.outputSummary !== undefined ? { output_summary: opts.outputSummary } : {}),
    ...(opts.committed === false
      ? {}
      : { committed_action: opts.action ?? "continue" }),
    execution_report: {
      files_changed: opts.files ?? [],
      claims: [
        ...criterionClaims(opts.met ?? []),
        ...itemClaims(opts.contractItemClaims ?? []),
      ],
    },
  };
  if (fixtureContract) lin.round_contract = fixtureContract;
  if (opts.objectiveRefinement !== undefined) {
    lin.objective_refinement = opts.objectiveRefinement;
  }
  if (opts.attempt !== undefined) lin.attempt = opts.attempt;
  if (opts.beforeEvidence !== undefined) lin.before_evidence = opts.beforeEvidence;
  if (opts.roundEvidence !== undefined) lin.after_evidence = opts.roundEvidence;
  if (opts.contractBinding !== undefined) lin.contract_binding = opts.contractBinding;
  const body: Record<string, unknown> = {
    loop_id: loopId,
    task_id: `loop:${loopId}:r${round}:feedback`,
    task_type: "feedback",
    outcome: fixtureOutcome,
    ...(opts.outputSummary !== undefined ? { output_summary: opts.outputSummary } : {}),
    execution_report: {
      files_changed: opts.files ?? [],
      claims: [
        ...criterionClaims(opts.met ?? []),
        ...itemClaims(opts.contractItemClaims ?? []),
      ],
    },
  };
  if (fixtureContract) body.round_contract = fixtureContract;
  if (opts.objectiveRefinement !== undefined) {
    body.objective_refinement = opts.objectiveRefinement;
  }
  // v3.9.1: a merged entry is only committed history when it carries the
  // embedded transaction snapshot. Build the SAME envelope a real commit
  // writes, so decodeMergedRound has one factual source.
  const evaluation = makeSelfEvaluation({
    outcome: fixtureOutcome,
    output_summary: opts.outputSummary ?? "",
    constraint_violations: opts.constraintViolations ?? [],
    should_continue: true,
    objective_refinement: opts.objectiveRefinement,
    round_contract: fixtureContract,
    execution_report: makeExecutionReport({
      files_changed: opts.files ?? [],
      claims: [
        ...criterionClaims(opts.met ?? []),
        ...itemClaims(opts.contractItemClaims ?? []),
      ],
    }),
  });
  const result = {
    action: opts.action ?? "continue",
    verificationFlags: opts.verificationFlags ?? [],
    agentSuccessClaim: fixtureOutcome === "success",
    agentOutcome: fixtureOutcome,
    gateContradicted: false,
    evidencePosture: fixtureEvidencePosture(round),
    newConsecutiveRejections: 0,
    shouldPushSuccessTrajectory: false,
  };
  const snapshot = {
    schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
    kind: "evaluation",
    branchId: opts.branchId ?? rootBranchId(loopId),
    transactionId: `tx-${loopId}-${round}-${opts.attempt ?? 1}`,
    roundId: `loop:${loopId}:round:${round}`,
    loopId,
    round,
    attempt: opts.attempt ?? 1,
    phase: "committed",
    beforeEvidence: opts.beforeEvidence ?? [],
    afterEvidence: opts.roundEvidence ?? [],
    operatorAcceptance: {
      task: opts.task ?? "Test task",
      success_criteria: [],
      hard_constraints: [],
    },
    compiled: {
      task: opts.task ?? "Test task",
      goalId: "",
      constraintsActive: Array.isArray(lin.constraints_active)
        ? lin.constraints_active as string[]
        : [],
      constraintsRetired: Array.isArray(lin.constraints_retired)
        ? lin.constraints_retired as string[]
        : [],
    },
    ...fixtureBeforeCheckpointError(opts.beforeEvidence ?? []),
    evaluation,
    submittedFields: manifestFor(evaluation),
    result,
    ...(opts.contractBinding !== undefined
      ? { contractBinding: opts.contractBinding }
      : {}),
    createdAt: 0,
    updatedAt: 0,
  };
  lin.round_transaction = {
    schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
    round_id: snapshot.roundId,
    snapshot,
    result,
  };
  body.loop_lineage = lin;
  return body;
}

/** v3.3: Install a real after-phase verification command on the current
 *  policy so end-to-end tests exercise the machine-backed-success path.
 *  The command passes (exit 0) with output that cannot be parsed into test
 *  counts — commandVerified=true (so R8 / success_unverified / criteria
 *  claims stay silent) while count-comparison checks have nothing to match
 *  against. Call after any resetPolicy() in the same test setup.
 *  Mutates the cached policy singleton; the per-file process isolation of
 *  `node --test` keeps this scoped to the test file. */
export function installTestCommandProvider(): void {
  getPolicy().evidence.commands = [testCommandProvider()];
}

/** Shared command-provider policy shape (executable + args + limits). */
export function testCommandProvider(): {
  name: string; enabled: boolean; executable: string; args: string[];
  phase: "after"; required: boolean; timeout_ms: number;
  max_output_chars: number; success_exit_codes: number[];
} {
  return {
    name: "verify",
    enabled: true,
    executable: process.execPath,
    args: ["-e", "console.log('verification ok')"],
    phase: "after",
    required: false,
    timeout_ms: 5000,
    max_output_chars: 2000,
    success_exit_codes: [0],
  };
}

/** v3.3: Write a loop_policy.json (with a passing verification command) into
 *  a subprocess working directory — the CLI child loads policy from its own
 *  cwd, so in-process policy injection does not reach spawned servers. */
export function writeMachineBackedPolicy(
  dir: string,
  options: { commands?: ReturnType<typeof testCommandProvider>[] } = {},
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "loop_policy.json"), JSON.stringify({
    // v3.8.1: the policy version is load-bearing — a file that does not
    // declare the current schema is REJECTED, so this fixture must track it
    // rather than hardcode a number that rots.
    version: POLICY_SCHEMA_VERSION,
    evidence: {
      providers: ["git"],
      timeout_ms: 120000,
      commands: options.commands ?? [testCommandProvider()],
    },
  }, null, 2));
}

/** In-memory LoopStore for testing — implements LoopStore without filesystem. */
export class MemoryLoopStore implements LoopStore {
  sessions = new Map<string, LoopSessionDocument>();
  rounds = new Map<string, LoopRoundDocument>();
  entries: VaultEntry[] = [];

  withLock<T>(fn: () => T): T { return fn(); }
  listLoopIds(): string[] {
    const ids = new Set<string>(this.sessions.keys());
    // Round keys are "<loopId>:<round>" — strip the numeric round suffix.
    // Loop IDs may themselves contain colons, so take the LAST ":digits".
    for (const key of this.rounds.keys()) {
      const match = key.match(/^(.*):\d+$/);
      if (match) ids.add(match[1]);
    }
    return [...ids].sort();
  }
  /** Flat entry view. Mirrors FileLoopStore.listEntries: typed session
   *  documents are included alongside raw appended entries. In production
   *  the session document IS the storage for a session entry (writeEntry
   *  routes session_state to session.json and writeSession overwrites the
   *  same file), so a session document replaces any raw entry with the same
   *  task_id instead of appearing twice. */
  listEntries(loopId?: string, opts?: { sinceRound?: number }): VaultEntry[] {
    // FileLoopStore scopes the flat view to one loop; the in-memory store
    // must do the same or a loader that trusts `listEntries(loopId)` would
    // read another loop's history.
    const result = loopId === undefined
      ? [...this.entries]
      : this.entries.filter((entry) =>
          entry.loop_id === loopId ||
          String(entry.task_id ?? "").startsWith(`loop:${loopId}:`));
    // v3.0.1: mirror FileLoopStore.listEntries — sinceRound drops entries
    // from round documents older than the window (session entries have no
    // round and are always kept).
    if (opts?.sinceRound !== undefined) {
      const since = opts.sinceRound;
      for (let i = result.length - 1; i >= 0; i--) {
        const entry = result[i];
        const lineage = entry.loop_lineage as Record<string, unknown> | undefined;
        let round: number | null = null;
        if (lineage && typeof lineage.round === "number") round = lineage.round;
        else {
          const match = String(entry.task_id ?? "").match(/:r(\d+)(?::|$)/);
          if (match) round = Number(match[1]);
        }
        if (round !== null && round < since) result.splice(i, 1);
      }
    }
    for (const [id, doc] of this.sessions) {
      if (loopId && id !== loopId) continue;
      const taskId = String(doc.entry.task_id ?? "");
      const index = result.findIndex((e) => String(e.task_id ?? "") === taskId);
      if (index >= 0) result[index] = doc.entry;
      else result.push(doc.entry);
    }
    return result;
  }
  /** Mirror FileLoopStore.writeEntry: the flat log stays available for tests
   *  that inspect appended events, and the typed round/session documents are
   *  updated in parallel so `readRound` and the transaction commit store see
   *  the same fact. */
  appendEntry(entry: VaultEntry): void {
    this.entries.push(entry);
    const loopId = typeof entry.loop_id === "string" && entry.loop_id.length > 0
      ? entry.loop_id
      : String(entry.task_id ?? "").match(/^loop:(.+):(?:session|r\d+(?::|$))/)?.[1];
    if (!loopId) return;
    if (entry.task_type === "session_state" ||
        entry.task_id === `loop:${loopId}:session`) {
      this.sessions.set(loopId, {
        schemaVersion: LOOP_STORE_SCHEMA_VERSION,
        loopId,
        updatedAt: new Date().toISOString(),
        entry,
      });
      return;
    }
    const lineage = entry.loop_lineage as Record<string, unknown> | undefined;
    const round = lineage && typeof lineage.round === "number"
      ? lineage.round
      : Number(String(entry.task_id ?? "").match(/:r(\d+)(?::|$)/)?.[1] ?? NaN);
    if (!Number.isInteger(round) || round < 1) return;
    const key = `${loopId}:${round}`;
    const current = this.rounds.get(key) ?? {
      schemaVersion: LOOP_STORE_SCHEMA_VERSION,
      loopId,
      round,
      sequence: round,
      updatedAt: new Date().toISOString(),
      events: [],
    };
    const taskId = String(entry.task_id ?? "");
    if (taskId.endsWith(":feedback")) {
      current.feedback = entry;
    } else {
      current.events = [
        ...current.events.filter((event) => event.task_id !== taskId),
        entry,
      ];
    }
    current.updatedAt = new Date().toISOString();
    this.rounds.set(key, current);
  }
  appendEntries(entries: VaultEntry[]): number {
    for (const entry of entries) this.appendEntry(entry);
    return entries.length;
  }
  readSession(loopId: string): LoopSessionDocument | null {
    return this.sessions.get(loopId) ?? null;
  }
  writeSession(loopId: string, document: LoopSessionDocument): void {
    this.sessions.set(loopId, document);
  }
  readRound(loopId: string, round: number): LoopRoundDocument | null {
    return this.rounds.get(`${loopId}:${round}`) ?? null;
  }
  /** Direct round-document write for sequence/corruption fixtures. */
  writeRound(loopId: string, document: LoopRoundDocument): void {
    this.rounds.set(`${loopId}:${document.round}`, document);
  }
  listRoundSequences(loopId: string): Array<{ round: number; sequence?: number }> {
    return [...this.rounds.entries()]
      .filter(([key]) => key.startsWith(`${loopId}:`))
      .map(([key, doc]) => ({ round: doc.round, sequence: doc.sequence }))
      .sort((a, b) => a.round - b.round);
  }
}
