/** Shared test utilities — in-memory store, test data factories.
 *
 * Imported by replay.test.ts and mcp.test.ts to avoid ~50 lines of
 * duplicated MemoryLoopStore implementation.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LoopStore,
  LoopSessionDocument,
  LoopRoundDocument,
  VaultEntry,
} from "../loop-store.js";
import { LOOP_STORE_SCHEMA_VERSION } from "../loop-store.js";
import { ROUND_TRANSACTION_SCHEMA_VERSION } from "../round-transaction.js";
import { makeExecutionReport, makeSelfEvaluation } from "../protocol.js";
import type {
  CriterionClaim,
  MachineObservation,
  RoundContractProposal,
  RoundOutcome,
  SelfEvaluation,
  VerificationFlag,
} from "../protocol.js";
import type { GitDeltaState, ObservationDelta } from "../evidence-provider.js";
import { getPolicy } from "../policy.js";
import { POLICY_SCHEMA_VERSION } from "../policy.js";

/** The compiler's default objective criterion when the task declares none. */
export const DEFAULT_SUCCESS_CRITERION =
  "Task goal achieved with verifiable evidence";

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
  if (evaluation.round_contract) fields.push("round_contract");
  if (evaluation.outcome) fields.push("outcome");
  return fields;
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
    action?: string;
    attempt?: number;
    beforeEvidence?: unknown[];
    roundEvidence?: unknown[];
    files?: string[];
    progress?: number;
    noExecutionReport?: boolean;
    discoveredConstraints?: string[];
    verificationFlags?: VerificationFlag[];
    loopId?: string;
    /** v3.8: machine binding stamped on the committed contract. */
    contractBinding?: unknown;
    /** v3.8: committed item claims (replaces the legacy `met` list). */
    contractItemClaims?: Array<{ item_id: string; outcome: "met" | "remaining" }>;
  } = {},
): VaultEntry {
  const loopId = opts.loopId ?? "cc";
  const evaluation = makeSelfEvaluation({
    success: false,
    output_summary: `Committed round ${round}.`,
    constraint_violations: [],
    should_continue: true,
    outcome: opts.outcome,
    round_contract: opts.contract,
    discovered_constraints: opts.discoveredConstraints ?? [],
    execution_report: opts.noExecutionReport
      ? undefined
      : makeExecutionReport({
          files_changed: opts.files ?? [],
          tests_reported: { passed: 0, failed: 0, skipped: 0 },
          criterion_claims: criterionClaims(opts.met ?? []),
          ...(opts.contractItemClaims
            ? { contract_item_claims: opts.contractItemClaims }
            : {}),
        }),
  });
  return {
    task_id: `loop:${loopId}:r${round}:feedback`,
    loop_id: loopId,
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
        round_id: `loop:${loopId}:round:${round}`,
        snapshot: {
          schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
          roundId: `loop:${loopId}:round:${round}`,
          loopId,
          round,
          attempt: opts.attempt ?? 1,
          phase: "committed",
          beforeEvidence: opts.beforeEvidence ?? [],
          afterEvidence: opts.roundEvidence,
          ...(opts.contractBinding !== undefined ? { contractBinding: opts.contractBinding } : {}),
          createdAt: 0,
          updatedAt: 0,
          evaluation,
          submittedFields: manifestFor(evaluation),
        },
        result: {
          action: opts.action ?? "continue",
          verificationFlags: opts.verificationFlags ?? [],
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
): VaultEntry {
  const evaluation = makeSelfEvaluation({
    success: false,
    output_summary: `Rolled back round ${round}.`,
    constraint_violations: [],
    should_continue: true,
  });
  return {
    task_id: `loop:${loopId}:r${round}:feedback`,
    loop_id: loopId,
    loop_lineage: {
      round,
      round_transaction: {
        schema_version: ROUND_TRANSACTION_SCHEMA_VERSION,
        round_id: `loop:${loopId}:round:${round}`,
        snapshot: {
          schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
          roundId: `loop:${loopId}:round:${round}`,
          loopId,
          round,
          attempt: 1,
          phase: "committed",
          beforeEvidence: [],
          afterEvidence: [],
          evaluation,
          submittedFields: manifestFor(evaluation),
          createdAt: 0,
          updatedAt: 0,
        },
        result: { action: "backtrack", verificationFlags: [], roundSuccess: false },
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
): Record<string, unknown> {
  const lineage = (entry.loop_lineage ?? {}) as Record<string, unknown>;
  const loopId = String(entry.loop_id ?? lineage.loop_id ?? "");
  const round = Number(lineage.round ?? entry.round ?? 0);
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
    ...(entry.execution_report !== undefined
      ? { execution_report: entry.execution_report }
      : {}),
    ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
    ...(entry.round_contract !== undefined
      ? { round_contract: entry.round_contract }
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
    roundId: `loop:${loopId}:round:${round}`,
    loopId,
    round,
    attempt: Number(lineage.attempt ?? 1),
    phase: "committed",
    beforeEvidence: [],
    afterEvidence: [],
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
  } = {},
): Record<string, unknown> {
  const loopId = opts.loopId ?? "me";
  const lin: Record<string, unknown> = {
    loop_id: loopId,
    round,
    success: false,
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
    task_id: `${loopId}:r${round}`,
    task_type: "loop_lineage",
    success: false,
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
    success: false,
    output_summary: opts.outputSummary ?? "",
    constraint_violations: opts.constraintViolations ?? [],
    should_continue: true,
    outcome: opts.outcome,
    round_contract: opts.contract,
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
    roundSuccess: false,
    gateContradicted: false,
    verificationStatus: "trusted",
    newConsecutiveRejections: 0,
    shouldPushSuccessTrajectory: false,
  };
  const snapshot = {
    schemaVersion: ROUND_TRANSACTION_SCHEMA_VERSION,
    roundId: `loop:${loopId}:round:${round}`,
    loopId,
    round,
    attempt: opts.attempt ?? 1,
    phase: "committed",
    beforeEvidence: opts.beforeEvidence ?? [],
    afterEvidence: opts.roundEvidence ?? [],
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
    const result = [...this.entries];
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
  appendEntry(entry: VaultEntry): void { this.entries.push(entry); }
  appendEntries(entries: VaultEntry[]): number { this.entries.push(...entries); return entries.length; }
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
