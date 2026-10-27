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
  CompiledRoundFacts,
  ContractTransition,
  CriterionClaim,
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
import { POLICY_SCHEMA_VERSION } from "../policy.js";

/** The compiler's default objective criterion when the task declares none. */
export const DEFAULT_SUCCESS_CRITERION =
  "Task goal achieved with verifiable evidence";

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
  return import("../mcp/tools.js").then(({ TOOL_HANDLERS }) =>
    TOOL_HANDLERS.loopforge_next(mgr, {
      ...input,
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
  return mgr.advance(
    submissionHandle ?? mgr.getSubmissionHandle(sessionId),
    output,
    evaluation,
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

/** v3.8: Build the criterion claims an evaluation submits. */
export function criterionClaims(met: string[] = [], remaining: string[] = []): CriterionClaim[] {
  return [
    ...met.map((criterion_id) => ({ criterion_id, outcome: "met" as const })),
    ...remaining.map((criterion_id) => ({ criterion_id, outcome: "remaining" as const })),
  ];
}

/** A committed round always carries its attempted manifest. Tests build the
 *  manifest from what the fixture evaluation actually contains, so the
 *  accounting read model sees the same fields the round declared. */
export function manifestFor(evaluation: SelfEvaluation): string[] {
  const fields = [
    "success", "output_summary", "constraint_violations", "should_continue",
  ];
  if (evaluation.execution_report) {
    fields.push("execution_report.files_changed", "execution_report.tests_reported");
    if ((evaluation.execution_report.criterion_claims ?? []).length > 0) {
      fields.push("execution_report.criterion_claims");
    }
    if ((evaluation.execution_report.contract_item_claims ?? []).length > 0) {
      fields.push("execution_report.contract_item_claims");
    }
  }
  if ((evaluation.discovered_constraints ?? []).length > 0) fields.push("discovered_constraints");
  if ((evaluation.emerged_subtasks ?? []).length > 0) fields.push("emerged_subtasks");
  if ((evaluation.subgoal_updates ?? []).length > 0) fields.push("subgoal_updates");
  if ((evaluation.retracted_constraints ?? []).length > 0) fields.push("retracted_constraints");
  if ((evaluation.wrong_assumptions ?? []).length > 0) fields.push("wrong_assumptions");
  if ((evaluation.open_questions ?? []).length > 0) fields.push("open_questions");
  if (evaluation.round_contract) fields.push("round_contract");
  if (evaluation.contract_transition) fields.push("contract_transition");
  if (evaluation.outcome) fields.push("outcome");
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
  contextMode?: "fresh_round" | "same_round_retry";
  contextReason?: "first_round" | "next_round" | "recovery_redo" | "enforcement_retry";
}): PromptArtifact {
  return {
    schemaVersion: PROMPT_ARTIFACT_SCHEMA_VERSION,
    roundId: input.roundId,
    round: input.round,
    attempt: input.attempt ?? 1,
    level: input.level ?? "l1",
    contextMode: input.contextMode ?? "fresh_round",
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
     *  `roundSuccess`, making every decoded view look failed. */
    success?: boolean;
    /** v3.9.6: the branch this evaluation belongs to. */
    branchId?: string;
    beforeEvidence?: unknown[];
    roundEvidence?: unknown[];
    files?: string[];
    progress?: number;
    noExecutionReport?: boolean;
    discoveredConstraints?: string[];
    /** v4.0.2: committed report facts for Working Memory / replay / explain. */
    outputSummary?: string;
    wrongAssumptions?: string[];
    retractedConstraints?: string[];
    openQuestions?: string[];
    blocker?: string;
    verificationFlags?: VerificationFlag[];
    loopId?: string;
    /** v3.8: machine binding stamped on the committed contract. */
    contractBinding?: unknown;
    /** v3.8: committed item claims (replaces the legacy `met` list). */
    contractItemClaims?: Array<{ item_id: string; outcome: "met" | "remaining" }>;
    /** v3.9.9: a committed contract redirect. */
    contractTransition?: ContractTransition;
    /** v4.0.1: the prompt artifact stamped on the committed transaction. */
    promptArtifact?: PromptArtifact;
    /** v4.0.1: compile facts stamped on the committed transaction. */
    compiled?: CompiledRoundFacts;
    restore?: {
      directiveTransactionId: string;
      redoRound: number;
      verifiedAt: number;
    };
  } = {},
): VaultEntry {
  const loopId = opts.loopId ?? "cc";
  const evaluation = makeSelfEvaluation({
    success: opts.success ?? false,
    output_summary: opts.outputSummary ?? `Committed round ${round}.`,
    constraint_violations: [],
    should_continue: true,
    outcome: opts.outcome,
    wrong_assumptions: opts.wrongAssumptions ?? [],
    retracted_constraints: opts.retractedConstraints ?? [],
    open_questions: opts.openQuestions ?? [],
    blocker: opts.blocker,
    round_contract: opts.contract,
    contract_transition: opts.contractTransition,
    emerged_subtasks: opts.emergedSubtasks ?? [],
    discovered_constraints: opts.discoveredConstraints ?? [],
    execution_report: opts.noExecutionReport
      ? undefined
      : makeExecutionReport({
          files_changed: opts.files ?? [],
          tests_reported: { passed: 0, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims(opts.met ?? [], opts.remaining ?? []),
          ...(opts.contractItemClaims
            ? { contract_item_claims: opts.contractItemClaims }
            : {}),
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
            task: "Test task",
            success_criteria: [],
            hard_constraints: [],
          },
          compiled: opts.compiled ?? {
            task: "Test task",
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
          verificationFlags: opts.verificationFlags ?? [],
          roundSuccess: opts.success ?? false,
        },
      },
    },
  };
}

/** v3.8: A committed backtrack directive — the rollback record written when
 *  the enforcement gate rolls a stalled round back. Its transaction carries a
 *  full committed snapshot like every other committed round; `historyRounds`
 *  excludes it from final history. */
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
          roundSuccess: false,
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
  const evaluation = {
    success: entry.success === true,
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
    ...(entry.compression_checkpoint === true
      ? {
          compression_checkpoint: true,
          ...(typeof entry.checkpoint_label === "string"
            ? { checkpoint_label: entry.checkpoint_label }
            : {}),
        }
      : {}),
    ...(entry.execution_report !== undefined
      ? { execution_report: entry.execution_report }
      : {}),
    ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
    ...(entry.round_contract !== undefined
      ? { round_contract: entry.round_contract }
      : {}),
    ...(entry.contract_transition !== undefined
      ? { contract_transition: entry.contract_transition }
      : {}),
  } as unknown as SelfEvaluation;
  const result = {
    action,
    verificationFlags: Array.isArray(entry.verification_flags)
      ? entry.verification_flags
      : [],
    roundSuccess: entry.success === true,
    gateContradicted: false,
    verificationStatus: "trusted",
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
    /** v3.9.9: a committed contract redirect. */
    contractTransition?: ContractTransition;
  } = {},
): Record<string, unknown> {
  const loopId = opts.loopId ?? "me";
  const lin: Record<string, unknown> = {
    loop_id: loopId,
    round,
    success: opts.success ?? false,
    ...(opts.outputSummary !== undefined ? { output_summary: opts.outputSummary } : {}),
    ...(opts.committed === false
      ? {}
      : { committed_action: opts.action ?? "continue" }),
    execution_report: {
      files_changed: opts.files ?? [],
      tests_reported: { passed: 0, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims(opts.met ?? []),
    },
  };
  if (opts.contract) lin.round_contract = opts.contract;
  if (opts.outcome !== undefined) lin.outcome = opts.outcome;
  if (opts.attempt !== undefined) lin.attempt = opts.attempt;
  if (opts.beforeEvidence !== undefined) lin.before_evidence = opts.beforeEvidence;
  if (opts.roundEvidence !== undefined) lin.after_evidence = opts.roundEvidence;
  if (opts.contractBinding !== undefined) lin.contract_binding = opts.contractBinding;
  const body: Record<string, unknown> = {
    loop_id: loopId,
    task_id: `loop:${loopId}:r${round}:feedback`,
    task_type: "feedback",
    success: opts.success ?? false,
    ...(opts.outputSummary !== undefined ? { output_summary: opts.outputSummary } : {}),
    execution_report: {
      files_changed: opts.files ?? [],
      tests_reported: { passed: 0, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims(opts.met ?? []),
    },
  };
  if (opts.contract) body.round_contract = opts.contract;
  if (opts.outcome !== undefined) body.outcome = opts.outcome;
  // decodeMergedRound reads `raw[key] ?? lineage[key]` — the body wins, so the
  // item claims must be stamped on BOTH shapes.
  if (opts.contractItemClaims) {
    const withClaims = (report: Record<string, unknown>): Record<string, unknown> => ({
      ...report,
      contract_item_claims: opts.contractItemClaims,
    });
    lin.execution_report = withClaims(lin.execution_report as Record<string, unknown>);
    body.execution_report = withClaims(body.execution_report as Record<string, unknown>);
  }
  // v3.9.1: a merged entry is only committed history when it carries the
  // embedded transaction snapshot. Build the SAME envelope a real commit
  // writes, so decodeMergedRound has one factual source.
  const evaluation = makeSelfEvaluation({
    success: opts.success ?? false,
    output_summary: opts.outputSummary ?? "",
    constraint_violations: opts.constraintViolations ?? [],
    should_continue: true,
    outcome: opts.outcome,
    round_contract: opts.contract,
    contract_transition: opts.contractTransition,
    execution_report: makeExecutionReport({
      files_changed: opts.files ?? [],
      tests_reported: { passed: 0, failed: 0, skipped: 0 },
      criterion_claims: criterionClaims(opts.met ?? []),
      ...(opts.contractItemClaims
        ? { contract_item_claims: opts.contractItemClaims }
        : {}),
    }),
  });
  const result = {
    action: opts.action ?? "continue",
    verificationFlags: opts.verificationFlags ?? [],
    roundSuccess: opts.success ?? false,
    gateContradicted: false,
    verificationStatus: "trusted",
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
      task: String(body.task ?? "Test task"),
      success_criteria: [],
      hard_constraints: [],
    },
    compiled: {
      task: String(body.task ?? "Test task"),
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
export function writeMachineBackedPolicy(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "loop_policy.json"), JSON.stringify({
    // v3.8.1: the policy version is load-bearing — a file that does not
    // declare the current schema is REJECTED, so this fixture must track it
    // rather than hardcode a number that rots.
    version: POLICY_SCHEMA_VERSION,
    evidence: {
      providers: ["git"],
      timeout_ms: 120000,
      commands: [testCommandProvider()],
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
