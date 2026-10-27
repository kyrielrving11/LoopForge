/** LoopForge-loop_compile — TypeScript protocol definitions.
 *
 * All types exchanged between the Main Agent and LoopForge flow through
 * these interfaces. This is the contract layer — no implementation logic.
 *
 * v3.3: 41 types — 2 enums + 35 interfaces + 4 type aliases.
 */

// ── Enums ──────────────────────────────────────────────────────────────────

// Type-only import — erased at runtime, no dependency cycle with
// canonical-state.ts (which imports protocol.ts for its types).

export enum AgentStatus {
  OK = "ok",
  ERROR = "error",
  STALLED = "stalled",
}

// ── Request schemas ─────────────────────────────────────────────────────────

// ── Agent Self-Evaluation (autonomous loop feedback) ────────────────────────

/** Structured self-evaluation submitted at the round boundary.
 *  The agent outputs this after completing each round.
 *  Every field is consumed by at least one downstream function.
 *
 *  v1.4 (P0–P2): Three new optional fields enable cognitive evolution.
 *  v1.5 (P4–P5): Execution evidence, progress tracking, and self-correction.
 *
 *  Optional fields are normalized leniently and never dropped silently: the
 *  normalizer returns stable diagnostics for every correction, and a committed
 *  transaction persists them with the submitted-field manifest. Four fields
 *  are structural exceptions validated BEFORE the round advances —
 *  `subgoal_updates`, `round_contract`, `contract_transition`, and
 *  `execution_report.contract_item_claims` — because each references the exact
 *  derived set the Agent was shown. `scope` is deliberately not structural:
 *  optional, report-only intent, normalized leniently and never rejected. */
export interface SelfEvaluation {
  /** true ONLY if all hard constraints were met and the task goal was achieved. */
  success: boolean;
  /** Specific, actionable summary of what was DONE this round.
   *  Feeds: committed record, state file, audit/replay/explain, and
   *  backtrack failed-approach facts. Never machine evidence, never a
   *  current-prompt narrative, and never a second history. */
  output_summary: string;
  /** Constraints the agent actually violated this round.
   *  Feeds: deriveRecurringFlags (the constraint_violation kind) and
   *  computeConstraintRetirement. */
  constraint_violations: string[];
  /** false ONLY when the entire task is complete. Tells the autonomous
   *  runner to stop the loop. Not consumed by the compiler. */
  should_continue: boolean;
  /** P0: New constraints discovered during this round that were not
   *  known before. Merged into the active constraint set by the compiler.
   *  Omit or leave empty if none discovered. */
  discovered_constraints?: string[];
  /** Sub-problems that surfaced during execution. This is the ONLY
   *  sub-goal creation channel; the runtime derives stable sg- ids and tracks
   *  their lifecycle. Omit or leave empty if none emerged.
   *  v3.7.1: a text matching the sg-XXXXXXXX ID pattern is rejected —
   *  creation never accepts an ID reference. */
  emerged_subtasks?: string[];
  /** v3.7.1: Explicit status transitions for EXISTING sub-goals. Each
   *  entry must reference a committed sub-goal ID (sg-XXXXXXXX) and a
   *  legal target status; unknown IDs, terminal (done/canceled)
   *  references, and illegal migrations are evaluation_invalid before
   *  the round advances. in_progress is only reachable through this
   *  field — the runtime no longer infers it. */
  subgoal_updates?: SubGoalUpdate[];
  /** P4: Structured claims about what was executed this round.
   *  Files changed, test results, and criteria met/remaining are checked
   *  against independent evidence where available. */
  execution_report?: ExecutionReport;
  /** P5: Constraints that the agent now believes are wrong or irrelevant.
   *  Removed from the active constraint set by the compiler.
   *  Omit or leave empty if none. */
  retracted_constraints?: string[];
  /** Assumptions the agent made in earlier rounds that turned out to be
   *  wrong. A committed Agent report; it surfaces in bounded Working Memory
   *  and recovery brief facts, never as a LoopForge conclusion or machine
   *  evidence. Omit or leave empty if none. */
  wrong_assumptions?: string[];
  /** v4.0.2: unresolved questions that still affect later slices. Strictly
   *  report-only: it feeds Working Memory, replay and explain, never the
   *  verification gate, success, contract closure or machine evidence.
   *  At most 3 entries, 300 chars each. It is a question list, not a todo
   *  list and not a completion checklist. */
  open_questions?: string[];
  /** Agent declares a subtask boundary. When true, the next compile uses an
   *  L2 rehydration boundary; no milestone or phase narrative is generated. */
  compression_checkpoint?: boolean;
  /** Human-readable label stored on the committed report. It does not create a
   *  later prompt heading. */
  checkpoint_label?: string;
  /** Multi-agent: Results of sub-agent / Worker delegations this round.
   *  The main agent reports what it delegated; the report is saved inside the
   *  committed transaction for audit. Omit or leave empty if none occurred. */
  worker_results?: WorkerResult[];
  /** v2.5: Why the agent is stopping. Only meaningful when
   *  should_continue=false and success=false. Defaults to "gave_up"
   *  (current behavior) when absent. "blocked" means work cannot proceed
   *  under current constraints; "needs_human_input" requires intervention. */
  stop_reason?: "gave_up" | "blocked" | "needs_human_input";
  /** v2.12: Declared outcome (four values). When absent, derived from success
   *  (true → "success", false → "failed"). "partial" and "blocked" can only
   *  be declared explicitly. A declared non-success outcome suppresses the
   *  success-class verification checks even when success=true. */
  outcome?: RoundOutcome;
  /** v2.12: Flat blocker description, meaningful only when outcome==="blocked".
   *  Also feeds the user/agent gate classification (P2). ≤ 500 chars. */
  blocker?: string;
  /** v2.12: Retroactive claims that a PRIOR round satisfied a criterion.
   *  The runtime verifies these against the prior round's git evidence.
   *  Max 20 entries. */
  retroactiveClaims?: { round: number; claim: string }[];
  /** v2.12: Declared reason for claiming success with no machine-verifiable
   *  evidence (e.g. "no code changes required — documentation-only round").
   *  Downgrades the success_without_verified_evidence check from error to
   *  info. Flat string, ≤ 200 chars. */
  no_change_reason?: string;
  /** v3.7.1: gate_opened ids this round's work depended on (returned by
   *  loopforge_gate_check). Lenient format — non-string entries are
   *  ignored, ≤ 20 entries. Enforced ONLY when policy.gate.enabled: a
   *  cited gate that does not exist, is not a user gate, or has no
   *  approved gate_decision produces the user_gate_unresolved error and
   *  the round is rejected. Safe pre-work (investigation, dry-runs,
   *  rollback evidence) never needs a gate. */
  gate_ids?: string[];
  /** v3.3: Round Contract. v3.4: a PROPOSAL for the NEXT round's contract
   *  (restated unchanged while the current one is active; a new one after
   *  it completes or blocks). Becomes the ACTIVE contract only once this
   *  round commits; it is then derived at compile time from committed
   *  rounds — see round-contract.ts. Optional. */
  round_contract?: RoundContractProposal;
  /** v3.9.9: an explicit contract redirection transaction. The Agent states
   *  that the ACTIVE contract it saw is no longer the right slice and submits
   *  its successor in the SAME evaluation. The old contract closes as
   *  `superseded`; its unverified items remain visible in audit/explain. This
   *  is a redirect, not a blocked declaration and not a rollback: the
   *  workspace is untouched and the round cannot be `completed`. */
  contract_transition?: ContractTransition;
}

/** v3.9.7: the kind of recovery material a checkpoint represents. `before` is
 *  the automatic transaction before-image; `mid` is an Agent-created savepoint
 *  during a round. Both are evidence/recovery material, never progress. */
export type CheckpointRole = "before" | "mid";

/** v3.9.7: a checkpoint reference held by a typed transaction snapshot. This
 *  reference is the authority for ownership, current-branch visibility and the
 *  redo round. The manifest alone is content-addressed recovery material and
 *  can never become a recovery point by itself. */
export interface CheckpointRef {
  checkpointId: string;
  contentHash: string;
  role: CheckpointRole;
  /** Logical round whose snapshot carries this reference. */
  round: number;
  roundId: string;
  /** Transaction that currently owns this reference (retry may re-bind it). */
  transactionId: string;
  branchId: string;
  /** First round of the child branch if this checkpoint is restored. For
   *  before/mid checkpoints this equals `round`. */
  redoRound: number;
  createdAt: number;
}

/** v4.0.0: the ONE transport projection of the held round attempt.
 *
 *  It bundles the three identities a held-round call needs — the owning
 *  session, the logical round, and the exact transaction attempt — so a client
 *  copies one object instead of three independent strings. It is DERIVED from
 *  the persisted session snapshot on every response; it is never persisted in
 *  the session document, a round transaction, a prompt artifact, guidance, or
 *  a receipt.
 *
 *  It is not a security token and grants no authority: the session lease plus
 *  an exact comparison against the held snapshot remain the only authority. A
 *  stale handle never submits work; a live session re-anchors through
 *  `loopforge_status`, and a lost prompt or missing live session is recovered
 *  through `loopforge_resume`. */
export interface SubmissionHandle {
  sessionId: string;
  roundId: string;
  transactionId: string;
}

/** v3.9.7: the restore-relevant content manifest. `fingerprints` is exactly
 *  the Git observation boundary; `contents` names the dirty regular files and
 *  symlinks whose bytes are stored as content-addressed blobs. */
export interface WorkspaceCheckpointManifest {
  schemaVersion: 1;
  checkpointId: string;
  loopId: string;
  round: number;
  role: CheckpointRole;
  createdAt: number;
  head?: string;
  dirty: string[];
  fingerprints: Record<string, string>;
  contents: string[];
  coverage: "tracked_and_non_ignored_untracked";
  contentHash: string;
}

/** v3.9.7: The Agent's request to abandon the current branch and restore a
 *  checkpoint it selected. This is an ACTION, not an evaluation: it never
 *  carries success/output_summary/constraint_violations/should_continue and
 *  never fabricates a SelfEvaluation. The checkpoint must be visible in the
 *  current held transaction or a committed evaluation transaction on the
 *  current branch. LoopForge records the directive, executes and verifies the
 *  restore, and only then issues the redo prompt. The reason is the Agent's
 *  judgment, recorded verbatim and never judged. */
export interface RecoveryRequest {
  target_checkpoint_id: string;
  reason: string;
}

/** v3.9.6: The operator-owned acceptance surface, written once in the root
 *  branch's round-1 evaluation transaction. Neither the Agent nor LoopForge
 *  may revise, replace, or retract it. */
export interface OperatorAcceptance {
  task: string;
  success_criteria: string[];
  hard_constraints: string[];
}

/** v3.9.7: the committed recovery target. It references a checkpoint by id and
 *  content hash; the manifest is the one copy of the boundary. `redo_round`
 *  is the branch fence: parent rounds with `round < redo_round` are retained,
 *  and the child branch starts at `redo_round`. */
export interface RecoveryTarget {
  checkpoint_id: string;
  content_hash: string;
  role: CheckpointRole;
  /** Round that owns the checkpoint reference. */
  round: number;
  round_id: string;
  /** Transaction that owns the checkpoint reference. */
  transaction_id: string;
  /** First round of the child branch. */
  redo_round: number;
}

/** v4.0.1: the compile facts stamped into an evaluation transaction at commit.
 *  They are the machine-computed state the next compile carries forward, not
 *  Agent input. `task`/`goalId` serve level and replay; the constraint sets
 *  are the effective compile result. */
export interface CompiledRoundFacts {
  task: string;
  goalId: string;
  constraintsActive: string[];
  constraintsRetired: string[];
}

/** v3.9.7: A committed rollback directive. It is a typed event in the same
 *  round document as the abandoned/triggering transaction, not a normal
 *  round. `transaction_id` also names the child branch; the redo and all
 *  later transactions on that branch carry it as `branchId`.
 *
 *  The directive deliberately does NOT duplicate the target's HEAD or
 *  fingerprints: the checkpoint manifest is the one copy, bound by
 *  `target.content_hash`. `skipped_files` is a report fact derived from the
 *  target manifest vs. the abandoned boundaries; it is never a restore gate. */
export interface RecoveryDirective {
  origin: "agent" | "machine";
  /** Agent reason or machine failure reason. */
  reason: string;
  /** Machine check id; never set for an agent request. */
  trigger_rule?: string;
  target: RecoveryTarget;
  skipped_files: string[];
  skipped_discoveries: string[];
  failed_rounds: number[];
  /** Committed Agent reports from abandoned rounds. */
  approaches: string[];
  wrong_assumptions: string[];
  /** The directive transaction; also the child branch identity. */
  transaction_id: string;
}

/** v2.12: Tri-state round outcome. Declared via SelfEvaluation.outcome;
 *  derived from `success` when absent. Shared by the dual gates, the stop
 *  mapping, and the audit view. */
export type RoundOutcome = "success" | "partial" | "failed" | "blocked";

/** v2.12: Structured high-risk action descriptor (internal — audit display
 *  and gate classification). The MCP surface uses a flat gate text instead. */
export interface GateActionDescriptor {
  description: string;
  scope: string[];
  effects: Array<
    | "workspace_write" | "production" | "credentials" | "data_migration"
    | "public_api" | "publish" | "payment" | "external_communication" | "network"
  >;
  reversibility: "reversible" | "recoverable" | "irreversible" | "unknown";
  authorization: "agent_allowed" | "user_required" | "unknown";
}

/** v2.12: Classified gate — user gates need human authorization, agent
 *  gates are resolved by the agent submitting verifiable evidence. */
export interface DerivedGate {
  kind: "user" | "agent";
  question?: string;
  blockedScope?: string[];
  allowedWork?: string[];
  problem?: string;
  requiredEvidence?: string[];
  suggestedResolution?: string;
}

/** v2.12: A persisted user decision for a gate. The actionHash binds the
 *  approval to the exact canonicalized action — an edited action changes
 *  the hash, so stale approvals fail the gateId match automatically. */
export interface GateDecision {
  gateId: string;
  kind: "user" | "agent";
  approved: boolean;
  scope: string[];
  note: string;
  decidedAt: string;
  actionHash: string;
}

export function makeGateDecision(
  overrides: Partial<GateDecision> = {},
): GateDecision {
  return {
    gateId: "",
    kind: "user",
    approved: false,
    scope: [],
    note: "",
    decidedAt: new Date().toISOString(),
    actionHash: "",
    ...overrides,
  };
}

/** v3.9.1: One normalization diagnostic. The submission boundary NEVER drops
 *  an optional value silently: every drop, truncation or normalization is
 *  reported with a stable code and an actionable detail. Strict boundary
 *  failures use `handling: "rejected"` and are returned only for that attempt;
 *  they are never written to history. */
export type SubmissionDiagnosticHandling =
  | "dropped"
  | "truncated"
  | "normalized"
  | "rejected";

export interface SubmissionDiagnostic {
  /** Dotted field path, e.g. `execution_report.files_changed`. */
  path: string;
  /** Stable reason code (e.g. `unknown_field`, `not_array`, `too_many`). */
  code: string;
  handling: SubmissionDiagnosticHandling;
  /** What happened and how to correct it. */
  detail: string;
}

/** v3.9.1: How a submitted field was handled in the round's receipt. */
export type SubmissionReportHandling =
  | "saved"
  | "saved_not_expanded"
  | "dropped"
  | "truncated"
  | "normalized"
  | "not_applied";

/** v3.9.2: The machine boundary the agent's files_changed report is compared
 *  against. Receipt-only; never persisted, never next-prompt input. */
export const FILES_RECONCILIATION_SCOPE =
  "tracked_and_non_ignored_untracked" as const;

export interface FilesReconciliation {
  status: "match" | "mismatch" | "unknown" | "not_applicable";
  scope: typeof FILES_RECONCILIATION_SCOPE;
  /** True when the raw submission named execution_report.files_changed. */
  attempted: boolean;
  /** Submitted paths, first-seen order, exact strings, duplicates retained. */
  reported: string[];
  /** Observed Git change set, sorted; null when unknown/not applicable. */
  observed: string[] | null;
  /** observed - reported, sorted. */
  unreported: string[];
  /** reported - observed, sorted. */
  unconfirmed: string[];
}

/** v3.9.1: The machine's report of what one submission DID. It is derived
 *  from the transaction + the shared read model; it is never a second ledger. */
export interface SubmissionReceipt {
  round_id: string;
  attempt: number;
  disposition: "accepted" | "rejected" | "terminated" | "backtracked" | "stopped";
  /** Which record, if any, the transaction persisted. A rollback directive is
   *  a committed record but NOT the submitted evaluation applied. */
  record: "committed" | "rollback_directive" | "none";
  entered_history: boolean;
  /** v3.9.7: the checkpoint this submission was judged against. Present only
   *  when a pending rollback directive governed the submission — the redo.
   *  `restore_verified` reads the redo transaction's verified-restore marker;
   *  the directive itself remains the committed audit record. This is the
   *  redo's receipt projection of it, never a second ledger. */
  recovery_checkpoint?: {
    checkpoint_id: string;
    redo_round: number;
    origin: "agent" | "machine";
    reason: string;
    /** Machine result: the redo snapshot carries a restore marker produced by
     *  the verified restore. The directive remains the committed audit record. */
    restore_verified: boolean;
  };
  reports: Array<{
    path: string;
    handling: SubmissionReportHandling;
    detail?: string;
  }>;
  effects: {
    contract: {
      before_id: string | null;
      after_id: string | null;
      activated: boolean;
      closed: boolean;
      /** v3.9.9: the ACTIVE contract closed by this round's explicit
       *  `contract_transition` (report-only fact, derived from the committed
       *  transition — never inferred from `contract_premature`). */
      superseded?: boolean;
      /** v3.9.9: the Agent's transition reason, verbatim (report-only). */
      transition_reason?: string;
    };
    subgoals_created: Array<{ id: string; description: string }>;
    subgoals_updated: Array<{ id: string; from: string; to: string }>;
    constraints_declared: string[];
    /** Effective retractions only, from the next compile's retired set. */
    constraints_retracted: string[];
    /** "observed" only when a next compile exists; never guess. */
    constraints_retraction: "observed" | "not_observed";
    /** Requests that resolved to no effective retraction. */
    constraints_not_retracted: string[];
    /** "observed" only when a next compile (or the next committed round's
     *  stamped active set) exists; "not_observed" for stop/terminate/reject/
     *  backtrack. Never guess an active set from the agent's report. */
    constraints_activation: "observed" | "not_observed";
    constraints_active_after: string[] | null;
    constraints_not_expanded: string[];
    checkpoint: { label: string; round: number } | null;
    rollback: {
      redo_round: number;
      target_checkpoint_id: string;
      preserved_discoveries: string[];
      wrong_assumptions: string[];
      origin?: "agent" | "machine";
      reason?: string;
    } | null;
  };
  verification: {
    /** Contract-item posture (RoundVerificationStatus). */
    contract_status: RoundVerificationStatus;
    /** Round-level machine evidence posture. A round can have trusted
     *  contract items while a bare success claim has no machine evidence. */
    evidence_status: "verified" | "unavailable" | "absent";
    checks: Array<{
      field: string;
      check: string;
      severity: string;
      detail: string;
      /** v3.9.4: the concrete subject (command id, path, or stable id). */
      ref?: string;
    }>;
    contract_items: Array<{ item_id: string; status: ContractItemStatus }>;
  };
  /** v3.9.2: agent report vs the shared Git change set. Read-only. */
  files_reconciliation: FilesReconciliation;
  prompt: {
    level: "l0" | "l1" | "l2";
    dropped_sections: string[];
    /** v4.0.2: the context boundary the NEXT prompt was compiled under, read
     *  from the same PromptArtifact that produced it. Absent only when no next
     *  artifact exists (terminal/rejected-without-retry paths). */
    context_mode?: PromptContextMode;
    context_reason?: PromptContextReason;
  } | null;
  diagnostics: SubmissionDiagnostic[];
}

/** v3.9.1: The live submission-guidance projection returned with a prepared
 *  round. It is derived from current facts only (committed rounds, policy,
 *  the compiled state); it is never persisted and never becomes input to a
 *  later prompt. Real ids are rendered only when the facts exist; a null
 *  example means "not usable at this submission point". */
export interface SubmissionGuidance {
  active_contract: {
    id: string;
    work_item?: string;
    /** v3.9.9: the Agent's declared intent boundary. Report-only — it is not
     *  enforced and never rejects a round. */
    scope: string[];
    declared_at_round: number;
    items: Array<{
      id: string;
      description: string;
      status: ContractItemStatus;
      verify_with: string[];
    }>;
  } | null;
  contract_commands: string[];
  contract_verification_available: boolean;
  subgoals: Array<{ id: string; description: string; status: string }>;
  /** Current real criteria, for criterion_claims selection/examples. */
  criteria: Array<{
    id: string;
    text: string;
    status: CriterionStatus["status"];
  }>;
  recovery: {
    /** The directive is pending until the redo round commits. */
    pending: boolean;
    redo_round: number;
    checkpoint_id: string;
    /** True after the executor verified the restored boundary. */
    restore_verified: boolean;
    origin?: "agent" | "machine";
    reason?: string;
  } | null;
  prompt: {
    /** null when no prompt artifact is observable; never guess a level. */
    level: "l0" | "l1" | "l2" | null;
    dropped_sections: string[];
    protected_overflow: boolean;
  };
  fields: Array<{
    path: string;
    when: string;
    example: unknown | null;
    effect: string;
  }>;
  findings: Array<{
    field: string;
    check: string;
    severity: string;
    detail: string;
    /** v3.9.4: the concrete subject (command id, path, or stable id). */
    ref?: string;
  }>;
}

/** A single sub-agent / Worker delegation result (v1.9 — multi-agent).
 *  v3.7.1: `outcome` is the single reported fact. `success` is deleted —
 *  entries without a valid outcome are dropped by the parser, never
 *  derived. The whole array is optional and informational: it buys no
 *  machine verdict and an absent/empty array (no delegation this round)
 *  is always accepted. */
export interface WorkerResult {
  agentId: string;
  subTask: string;
  resultSummary: string;
  outcome: "success" | "partial" | "failed";
}

export function makeSelfEvaluation(
  overrides: Partial<SelfEvaluation> = {},
): SelfEvaluation {
  return {
    success: false,
    output_summary: "",
    constraint_violations: [],
    should_continue: true,
    discovered_constraints: [],
    emerged_subtasks: [],
    subgoal_updates: [],
    execution_report: undefined,
    retracted_constraints: [],
    wrong_assumptions: [],
    open_questions: [],
    worker_results: [],
    compression_checkpoint: false,
    checkpoint_label: "",
    stop_reason: undefined,
    outcome: undefined,
    blocker: undefined,
    retroactiveClaims: [],
    no_change_reason: undefined,
    round_contract: undefined,
    ...overrides,
  };
}

// ── Loop Compile types ──────────────────────────────────────────────────────

export interface LoopObjective {
  /** The operator objective. It is written once (round 1 / operator
   *  acceptance) and is never rewritten by an Agent report. */
  objective: string;
  success_criteria: string[];
  hard_constraints: string[];
  created_at_round: number;
  loop_id: string;
}

/** v3.2: Derived per-criterion status for the progress dashboard — the
 *  "goal → criteria → evidence" vertical view. Zero persistence: derived
 *  from committed rounds each round.
 *
 *  v3.8 states: `claimed` (the agent claims it met), `remaining` (declared
 *  outstanding), `verified` (a verified contract item references it),
 *  `contradicted` / `insufficient` (machine evidence denies / cannot back
 *  the claim), `unknown` (never mentioned). */
export interface CriterionStatus {
  /** Stable ID derived from the criterion text (cr-XXXXXXXX). */
  id: string;
  /** The criterion text as declared in the objective. */
  text: string;
  status:
    | "unknown"
    | "claimed"
    | "remaining"
    | "insufficient"
    | "contradicted"
    | "verified";
  /** Round when the criterion was first reported met (machine-backed). */
  met_at_round?: number;
}

/** v3.2: A deterministic "lesson learned" — a constraint or verification
 *  check that failed repeatedly across rounds. Rendered in the prompt to
 *  immunize the agent against repeating the same mistakes. Zero persistence:
 *  derived from vault entries each round; presentation only — never feeds
 *  the enforcement gate's decisions. */
/** v3.8.1: a repeated machine fact, keyed by what it is ABOUT.
 *
 *  One derivation over the whole committed history replaces the three
 *  separate views of "what keeps going wrong" this release removed:
 *  `Lesson` (whole history, count >= 2), `rolling_summary.recurring_issues`
 *  (the last 5 rounds' raw violation texts, no threshold at all despite the
 *  name), and the L1/L2 prompt sections built on top of each. Callers FILTER
 *  this list — the state file renders the genuinely recurring set, the prompt
 *  renders the recent tail. */
export interface RecurringFlag {
  /** Constraint text (for a violation) or the verification check id. */
  subject: string;
  kind: "constraint_violation" | "verification_error" | "verification_warning";
  /** `VerificationFlag.ref` — the command id, `rci-`/`sg-`/`cr-` id or path
   *  the flag was about. Empty when the check recorded no subject. */
  ref: string;
  /** Occurrences across the whole committed history. */
  count: number;
  /** The distinct rounds it occurred in, ascending. */
  rounds: number[];
}

export function makeLoopObjective(
  overrides: Partial<LoopObjective> = {},
): LoopObjective {
  return {
    objective: "",
    success_criteria: [],
    hard_constraints: [],
    created_at_round: 1,
    loop_id: "",
    ...overrides,
  };
}

/** The operator acceptance carried by a committed transaction is the same
 *  immutable surface the compiler used to derive the objective. */
export function operatorAcceptanceFromObjective(
  objective: LoopObjective,
): OperatorAcceptance {
  return {
    task: objective.objective,
    success_criteria: [...objective.success_criteria],
    hard_constraints: [...objective.hard_constraints],
  };
}

/** v3.7.1: One explicit sub-goal status transition. The closed migration
 *  matrix (loop-compiler.ts, single source) governs legality:
 *  in_progress from pending|blocked; done from pending|in_progress|blocked;
 *  blocked|canceled from pending|in_progress; blocked → canceled. done and
 *  canceled are terminal — re-opening requires a NEW emerged_subtasks item. */
export interface SubGoalUpdate {
  /** The sub-goal to transition (sg-XXXXXXXX). Unknown IDs are invalid. */
  id: string;
  status: "in_progress" | "done" | "blocked" | "canceled";
  /** Optional free-text note (≤ 300 chars). Lenient — never validated. */
  note?: string;
}

/** v2.2: A structured sub-goal tracked by the compiler across rounds.
 *  Declared by the agent via emerged_subtasks (creation) and
 *  subgoal_updates (explicit transitions); statuses are compiler-derived
 *  from committed round facts. Never creates sub-loops — the agent still
 *  owns execution; the compiler only tracks state. */
export interface SubGoal {
  /** Stable identifier derived from description hash (sg-XXXXXXXX). */
  id: string;
  /** Agent-declared description. Exact repeats within one declaration round
   *  keep only the first entry (v3.8.1 — no similarity dedup). */
  description: string;
  /** Compiler-derived status. */
  status: "pending" | "in_progress" | "done" | "blocked" | "canceled";
  /** Round when the agent first declared this sub-goal. */
  declared_at_round: number;
  /** Round of the last status change. */
  status_changed_at_round: number;
  /** Round when completed (only for done status). */
  completed_at_round?: number;
  /** Priority hint: 0 = highest. Derived from declaration order. */
  priority: number;
  /** v3.8: The agent's note from the transition that set the current status.
   *  Lenient — it never affects validation, only what the agent reads back. */
  status_note?: string;
}

export function makeSubGoal(
  overrides: Partial<SubGoal> = {},
): SubGoal {
  return {
    id: "",
    description: "",
    status: "pending",
    declared_at_round: 0,
    status_changed_at_round: 0,
    priority: 0,
    ...overrides,
  };
}

/** v2.3: Per-constraint lifecycle metadata for the active constraint set.
 *  Reconstructed each round from vault entries — no new persistence.
 *  v3.7: the time-aware decay arm (status inactive / discovered_at_round)
 *  was removed — active constraints never auto-demote. */
export interface ConstraintMeta {
  /** v2.11: Stable identifier derived from text hash (c-XXXXXXXX).
   *  The only name an agent can use to refer to this constraint — v3.8.1
   *  deleted every similarity fallback, so stable ids and normalized-exact
   *  text are the whole matching surface. */
  id: string;
  /** Normalized constraint text (the key). */
  text: string;
  /** Which round this constraint was last violated by the agent.
   *  0 if never violated. */
  last_violated_at_round: number;
  /** Origin — criteria texts carry the cr-XXXXXXXX namespace (v3.3.1).
   *  `discovered`/`preserved` are Agent declarations, never machine facts;
   *  `unrecorded` means committed facts cannot establish an origin. */
  source: "hard" | "plan" | "criteria" | "discovered" | "preserved" | "unrecorded";
  /** First committed round of the current active provenance, when derivable.
   *  Absent (never 0) when the origin round cannot be established from
   *  committed facts. */
  source_round?: number;
}

export function makeConstraintMeta(
  overrides: Partial<ConstraintMeta> = {},
): ConstraintMeta {
  return {
    id: "",
    text: "",
    last_violated_at_round: 0,
    source: "discovered",
    ...overrides,
  };
}

export interface LoopRoundResult {
  round: number;
  success: boolean;
  output_summary: string;
  constraint_violations: string[];
  manual_fixes_needed: string;
  /** P0: Constraints discovered during this round. */
  discovered_constraints?: string[];
  /** P2: Sub-problems that emerged during this round. */
  emerged_subtasks?: string[];
  /** v3.7.1: Explicit sub-goal transitions declared this round.
   *  Set from SelfEvaluation.subgoal_updates during buildLoopRequest. */
  subgoal_updates?: SubGoalUpdate[];
  /** P4: Execution evidence from this round. */
  execution_report?: ExecutionReport;
  /** P5: Constraints retracted this round. */
  retracted_constraints?: string[];
  /** P5: Wrong assumptions identified this round. */
  wrong_assumptions?: string[];
  /** v4.0.2: unresolved questions reported this round (report-only). */
  open_questions?: string[];
  /** Multi-agent: Delegation results from this round.
   *  Set from SelfEvaluation.worker_results during buildLoopRequest. */
  worker_results?: WorkerResult[];
  /** v1.10: Agent declared a subtask boundary in this round. */
  compression_checkpoint?: boolean;
  /** v1.10: Human-readable label for the checkpoint. */
  checkpoint_label?: string;
  /** v2.12: Declared outcome. Carried forward from SelfEvaluation. */
  outcome?: RoundOutcome;
  /** v2.12: Flat blocker description (outcome==="blocked" only). */
  blocker?: string;
  /** v2.12: Retroactive claims against prior rounds. */
  retroactiveClaims?: { round: number; claim: string }[];
  /** v2.12: Declared reason for success without machine evidence.
   *  Carried forward from SelfEvaluation. */
  no_change_reason?: string;
}

export function makeLoopRoundResult(
  overrides: Partial<LoopRoundResult> = {},
): LoopRoundResult {
  return {
    round: 0,
    success: false,
    output_summary: "",
    constraint_violations: [],
    manual_fixes_needed: "",
    discovered_constraints: [],
    emerged_subtasks: [],
    subgoal_updates: [],
    execution_report: undefined,
    retracted_constraints: [],
    wrong_assumptions: [],
    open_questions: [],
    worker_results: [],
    compression_checkpoint: false,
    checkpoint_label: "",
    outcome: undefined,
    blocker: undefined,
    retroactiveClaims: [],
    no_change_reason: undefined,
    ...overrides,
  };
}

export interface LoopCompileRequest {
  loop_id: string;
  round: number;
  goal_id: string;
  task: string;
  loop_objective: LoopObjective | null;
  plan_source: string | null;
  constraints_from_plan: string[];
  force_level: string;
  /** Maximum rounds for this loop. Used by the state file header to show
   *  accurate progress (Round X / Y). */
  max_rounds?: number;
  /** Verification findings from the previous attempt. Prompt compilation uses
   *  these to select a rehydrate view and render the gate findings exactly
   *  once as part of the final prompt. */
  verification_flags?: VerificationFlag[];
  /** One-based attempt within the same logical round. Enforcement rejection
   * increments this without advancing `round`. */
  attempt: number;
  /** Consecutive zero-commit enforcement rejections for this round. */
  consecutive_rejections: number;
  /** Structured enforcement feedback rendered into retry prompts. */
  rejection_notice: string;
}

export function makeLoopCompileRequest(
  overrides: Partial<LoopCompileRequest> = {},
): LoopCompileRequest {
  return {
    loop_id: "",
    round: 1,
    goal_id: "",
    task: "",
    loop_objective: null,
    plan_source: null,
    constraints_from_plan: [],
    force_level: "auto",
    verification_flags: [],
    attempt: 1,
    consecutive_rejections: 0,
    rejection_notice: "",
    ...overrides,
  };
}

/** v3.9.4: ID-level proof that the current prompt rendered every active
 *  normative object. This is an OUTPUT fact about one render — never an
 *  instruction for a later prompt and never an input to fact derivation.
 *
 *  `active` is the required set derived from the same `CanonicalLoopState`
 *  the renderer consumed; `rendered` is the union of the IDs the included
 *  sections declared; `omitted = active - rendered`. `complete` is false only
 *  when a normative ID was lost; prompt preparation then fails closed.
 *
 *  Ordering is deterministic: `active` by (kind rank, id), `rendered` sorted
 *  unique, `omitted` by id. */
export interface PromptCoverage {
  active: Array<{
    id: string;
    kind:
      | "constraint"
      | "criterion"
      | "contract"
      | "contract_item"
      | "subgoal"
      | "finding"
      | "recovery";
  }>;
  rendered: string[];
  omitted: Array<{
    id: string;
    /** Every normative section is protected, so a normative omission can
     *  only be a renderer defect. Keeping a single reason prevents a defect
     *  from being disguised as a level/budget decision. */
    reason: "defect";
  }>;
  complete: boolean;
}

/** Immutable record of the exact prompt delivered for one round attempt. */
/** v4.0.2: the context boundary of one prompt delivery.
 *
 *  `fresh_round` means the host starts a NEW Agent invocation for this logical
 *  round: the previous transcript, tool logs and uncommitted reasoning are
 *  not part of the prompt. `same_round_retry` means this is another attempt
 *  of the SAME logical round after an enforcement rejection; if the original
 *  invocation still exists, it continues.
 *
 *  The value is DERIVED by the compiler from compile inputs and committed
 *  facts. It is never submitted by the Agent and never re-derived by the MCP
 *  lifecycle; every response projects it from the committed PromptArtifact. */
export type PromptContextMode = "fresh_round" | "same_round_retry";

export type PromptContextReason =
  | "first_round"
  | "next_round"
  | "recovery_redo"
  | "enforcement_retry";

/** v4.0.2: what the prompt projection actually rendered from the bounded
 *  Working Memory. Audit metadata only — it never feeds a decision. */
export interface PromptWorkingMemoryProjection {
  /** Report rounds actually rendered, newest first. */
  reportRounds: number[];
  counts: {
    reports: number;
    assumptions: number;
    openQuestions: number;
    recoveries: number;
    redirects: number;
  };
  /** The latest report's projection facts; null when none was rendered. */
  previousReport: {
    round: number;
    sourceChars: number;
    renderedChars: number;
    truncated: boolean;
  } | null;
  /** Characters the Working Memory section body produced. */
  renderedChars: number;
  /** True when a window/cap/budget rule dropped or truncated any content. */
  truncated: boolean;
}

/** v3.8.1: the artifact schema version lives next to the type it versions.
 *  The transaction envelope parser reads it, so the constant lives here rather
 *  than in the renderer.
 *
 *  v4.0.1: schema 7 removes the prompt-request effects. v4.0.2: schema 8 adds
 *  the derived context boundary and the optional Working Memory projection.
 *  Older versions are a HARD break — a round whose artifact does not parse is
 *  not committed history, and `legacyTransactionRounds` reports the loss
 *  rather than letting it vanish. */
export const PROMPT_ARTIFACT_SCHEMA_VERSION = 8 as const;

export interface PromptArtifact {
  schemaVersion: typeof PROMPT_ARTIFACT_SCHEMA_VERSION;
  /** Round identity: `loop:<loopId>:round:<n>`. */
  roundId: string;
  /** The round number on its own, so a reader does not re-parse roundId. */
  round: number;
  attempt: number;
  level: "l0" | "l1" | "l2";
  /** v4.0.2: the derived context boundary of THIS delivery. */
  contextMode: PromptContextMode;
  contextReason: PromptContextReason;
  renderedPrompt: string;
  promptHash: string;
  stateHash: string;
  /** Section ids actually rendered, in render order. */
  sections: string[];
  /** Section ids the deterministic budget rule dropped. */
  droppedSections: string[];
  /** True when the PROTECTED sections alone exceeded the budget. Recorded so
   *  an over-budget prompt is visible rather than silently over-long. */
  protectedOverflow: boolean;
  /** The ceiling this render was measured against: the level's configured
   *  budget (`lN_max_chars`) minus the fixed footer, which is appended after
   *  budgeting because it is never dropped. Measured over the SAME region as
   *  `renderedChars`. */
  budget: number;
  /** Characters the budgeted region produced: the fixed header and the
   *  rendered sections — everything except the footer. NOT the full prompt
   *  length; `renderedPrompt` adds the footer on top. */
  renderedChars: number;
  /** v3.9.4: ID-level proof that every active normative object was rendered.
   *  Required: a schema-4 artifact without it is a hard break. */
  coverage: PromptCoverage;
  /** v3.9.6: compile diagnostics delivered with this exact prompt. Replaces
   *  the session-only `currentWarnings` mirror, so a held prompt remains
   *  self-contained across a restart. */
  warnings?: string[];
  /** v4.0.2: present only when this prompt rendered bounded Working Memory.
   *  Audit metadata; it is not a second history and is never an input to a
   *  later prompt. */
  workingMemory?: PromptWorkingMemoryProjection;
}

export interface LoopCompileResponse {
  status: AgentStatus;
  prompt: string;
  recompile_level: string;
  constraints_active: string[];
  constraints_retired: string[];
  loop_id: string;
  round: number;
  goal_id: string;
  loop_objective: LoopObjective | null;
  /** v2.2: Structured sub-goals tracked across rounds. Compiler-managed
   *  lifecycle with derived status. Rendered as Sub-Goal Dashboard. */
  sub_goals?: SubGoal[];
  /** v2.3: Per-constraint lifecycle metadata for state file rendering. */
  constraint_metadata?: ConstraintMeta[];
  /** v2.5: Current round's agent trust score [0, 1]. Derived from verification
   *  flags: -0.15 per error, -0.03 per warn. Always 1.0 for round 1. */
  /** v2.5: Trust scores from the last 10 rounds, newest last. Empty for
   *  round 1. Reconstructed from vault entries — zero new persistence. */
  /** v3.2: Derived per-criterion status (goal → criteria → evidence view).
   *  Zero persistence — re-derived from vault entries each round. */
  criterion_statuses?: CriterionStatus[];
  /** v3.8.1: repeated machine facts over the whole committed history, keyed
   *  by check id / constraint text and the id they were about. Presentation
   *  only — never feeds enforcement. Replaces the former Lessons list; callers
   *  filter it (state file: count >= 2, prompt: recent tail). */
  recurring_flags?: RecurringFlag[];
  plan_source: string | null;
  warnings: string[];
  error: string;
  /** v1.14: Content for the loop state file. Written by the caller
   *  (SessionManager or Runtime) to .loopforge/state/{loopId}-state.md.
   *  Present on every level when `state_file.enabled` (default true) —
   *  L0/L1/L2 all render it. Undefined only when the state file is
   *  disabled or the compile produced no prompt. */
  state_file_content?: string;
  /** Exact, hashed prompt record used by transaction replay and audit. */
  prompt_artifact?: PromptArtifact;
  /** v4.0.1: the compile facts the transaction stamps at commit. */
  compiled?: CompiledRoundFacts;
  /** v4.0.1: the immutable operator surface this compile used. */
  operatorAcceptance?: OperatorAcceptance;
}

export function makeLoopCompileResponse(
  overrides: Partial<LoopCompileResponse> = {},
): LoopCompileResponse {
  return {
    status: AgentStatus.OK,
    prompt: "",
    recompile_level: "l2",
    constraints_active: [],
    constraints_retired: [],
    loop_id: "",
    round: 0,
    goal_id: "",
    loop_objective: null,
    sub_goals: [],
    constraint_metadata: [],
    plan_source: null,
    warnings: [],
    error: "",
    state_file_content: undefined,
    prompt_artifact: undefined,
    ...overrides,
  };
}

// ── Evidence Snapshot (v1.16) ─────────────────────────────────────────────

/** Aggregated evidence snapshot for the state file Evidence section.
 *  Four categories give the agent a clear picture of what's been confirmed,
 *  what remains, what was wrong, and what's newly discovered — all derived
 *  from accumulated SelfEvaluation data across rounds. */
export interface EvidenceSnapshot {
  /** Criteria met + successful outcomes confirmed across rounds. */
  verified: string[];
  /** Criteria still unmet — work remaining. */
  pending: string[];
  /** Wrong assumptions + retracted constraints — things we were wrong about. */
  invalidated: string[];
  /** New constraints + emerged subtasks discovered this round. */
  discovered: string[];
}

export function makeEvidenceSnapshot(
  overrides: Partial<EvidenceSnapshot> = {},
): EvidenceSnapshot {
  return { verified: [], pending: [], invalidated: [], discovered: [], ...overrides };
}

/** Why a loop stopped. Used by MCP session and vault persistence.
 *  `completed` requires both success=true and should_continue=false.
 *  `failed` is success=false + should_continue=false (agent gave up).
 *  `cancelled` is manual stop via loopforge_stop. */
export type StopReason =
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "max_rounds"
  | "stalled"
  | "enforcement_terminated"
  /** Loop was paused by user or signal. */
  | "paused"
  /** v3.8: The agent stopped, but machine verification did not close the
   *  active contract (or the observations are insufficient to prove the task
   *  complete). Never reported as `completed`. */
  | "incomplete";


// ── Enforcement Gate types (v1.13) ──────────────────────────────────────────

/** Result of round-boundary enforcement. Decides whether to accept the round,
 *  reject it (force the agent to redo the SAME round), or terminate the loop.
 *
 *  accept:    round passes; proceed to next round as normal.
 *  reject:    agent's self-evaluation or output is invalid; the agent receives
 *             a rejection prompt and must redo the same round. Round counter
 *             does NOT increment.
 *  terminate: loop has reached an unrecoverable state; stop immediately with
 *             stopReason "enforcement_terminated". */
export interface EnforcementResult {
  action: "accept" | "reject" | "terminate" | "backtrack";
  /** Human-readable reason for the enforcement decision. */
  reason: string;
  /** For reject: concrete instructions the agent must follow.
   *  Empty for accept and terminate. */
  fix_instructions: string;
  /** Which enforcement rule fired. Empty for accept.
   *  Used by callers to track consecutive rejections per-rule
   *  so unrelated rejections don't accumulate toward the max. */
  check?: string;
  /** v3.8: The stop reason a `terminate` decision must map to. Absent means
   *  the historical `enforcement_terminated`; `incomplete` is set by the
   *  verification-debt row. */
  stopReason?: StopReason;
}

export function makeEnforcementResult(
  overrides: Partial<EnforcementResult> = {},
): EnforcementResult {
  return {
    action: "accept",
    reason: "",
    fix_instructions: "",
    check: "",
    stopReason: undefined,
    ...overrides,
  };
}

export interface LoopTerminalEvent {
  success: boolean;
  stopReason: StopReason;
  roundsCompleted: number;
  successTrajectory: boolean[];
  loopId: string;
  task: string;
  lastEvaluation?: SelfEvaluation;
}

export type LoopTerminalSink = (event: LoopTerminalEvent) => Promise<void> | void;

// ── Verification Gate (v1.6) ──────────────────────────────────────────────────

/** A single flag raised during self-evaluation verification.
 *  Each flag identifies a specific inconsistency between the agent's
 *  self-reported data and the committed round history. */
export interface VerificationFlag {
  /** info | warn | error — determines how aggressively the compiler reacts. */
  severity: "info" | "warn" | "error";
  /** Which SelfEvaluation field triggered this flag (e.g. "success"). */
  field: string;
  /** Check name for debugging / audit (e.g. "outcome_success_contradiction"). */
  check: string;
  /** Human-readable description of the inconsistency found. */
  detail: string;
  /** v3.8.1: the id this flag is ABOUT — a configured command id, an
   *  `rci-` / `sg-` / `cr-` id, or a workspace path. Optional: only checks with
   *  a concrete subject set it. Recurring-warning grouping keys on
   *  `(check, ref)` so it reports WHICH item keeps failing rather than
   *  re-parsing `detail` prose. */
  ref?: string;
}

export function makeVerificationFlag(
  overrides: Partial<VerificationFlag> = {},
): VerificationFlag {
  return {
    severity: "warn",
    field: "",
    check: "",
    detail: "",
    ...overrides,
  };
}

/** Result of cross-round self-evaluation verification.
 *
 *  Verdict semantics:
 *  - trusted:   all checks passed; flags are informational only.
 *  - suspect:   one or more warn-level flags; flags become warnings in the
 *               next prompt so the agent can clarify.
 *  - contradicted: one or more error-level flags; the quality score for this
 *                  round is excluded from the quality trend (NOT modified).
 *                  Flags become hard constraints — the agent must respond. */
export interface VerificationResult {
  verdict: "trusted" | "suspect" | "contradicted";
  flags: VerificationFlag[];
  /** v3.8.1: the round's success claim is MACHINE-backed — a passed
   *  after-phase command observed by the runtime (`deriveEvidenceStatus`).
   *  Carried as a fact so a consumer never re-derives it; the progress
   *  evaluator reads it as "this round is finishing, not churning". */
  machineBackedSuccess: boolean;
}

export function makeVerificationResult(
  overrides: Partial<VerificationResult> = {},
): VerificationResult {
  return {
    verdict: "trusted",
    flags: [],
    machineBackedSuccess: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// v3.8 — Agent report, contract items, machine observations, capability
//
// The boundary this version draws: an agent's self-report is a CLAIM and can
// never create a `verified` fact; a machine observation is a FACT and always
// exists once a provider is configured (unavailable/timeout/error/aborted are
// recorded, never silently filtered).
// ═══════════════════════════════════════════════════════════════════════════

/** v3.8: The agent's self-report for a round — renamed from ExecutionReport
 *  because these fields are claims, not evidence. The whole object is
 *  optional; a mistyped optional field is dropped with a warning and never
 *  rejects the round. */
export interface ExecutionReport {
  /** Files the agent says it changed. Informational — compared against the
   *  git observation, never trusted as the observation. */
  files_changed?: string[];
  /** Test counts the agent reports. Informational. */
  tests_reported?: { passed: number; failed: number; skipped: number } | null;
  /** Advisory claims about objective criteria. LENIENT: unknown/duplicate
   *  criterion ids and malformed outcomes are dropped with a warning. */
  criterion_claims?: CriterionClaim[];
  /** Claims about ACTIVE contract items. STRICT: an unknown/duplicate item id
   *  or an illegal outcome is a structural defect (contract_invalid). */
  contract_item_claims?: ContractItemClaim[];
}

export function makeExecutionReport(
  overrides: Partial<ExecutionReport> = {},
): ExecutionReport {
  return {
    files_changed: [],
    tests_reported: null,
    criterion_claims: [],
    contract_item_claims: [],
    ...overrides,
  };
}

/** v3.8: An advisory claim about an objective criterion. Lenient by design —
 *  the criterion layer is advisory; the contract item layer is the machine
 *  verification skeleton. */
export interface CriterionClaim {
  /** cr-XXXXXXXX (or the criterion text for plain-text matching). */
  criterion_id: string;
  outcome: "met" | "remaining";
}

/** v3.8: A claim about an ACTIVE contract item, cited by the derived
 *  rci-XXXXXXXX id the prompt rendered. */
export interface ContractItemClaim {
  item_id: string;
  outcome: "met" | "remaining";
}

/** v3.8/v3.9.5: One acceptance condition inside a Round Contract slice.
 *  `description` states what must be true, not an activity. `verify_with`
 *  must name configured, enabled, after-capable evidence commands — the
 *  declaration is strict. A command may back several conditions, and one
 *  condition may bind several commands. */
export interface ContractItemProposal {
  /** The acceptance condition: what must be true for this slice. */
  description: string;
  /** v3.9.4: real cr-XXXXXXXX ids of ACTIVE criteria rendered in the
   *  current prompt. Free text and unknown ids are `contract_invalid`. */
  criterion_refs: string[];
  /** Evidence command ids (policy.evidence.commands[].name) that check this
   *  acceptance condition. */
  verify_with: string[];
}

/** v3.9.5: A Round Contract proposal for the NEXT round. It becomes ACTIVE
 *  only after the declaring round commits. Identity (rc-/rci-) is derived
 *  from CONTENT ONLY — restating an unchanged contract keeps the same
 *  identity, unlike a SubGoal whose id includes its declaration round.
 *
 *  `work_item` is the bounded deliverable this slice produces (an outcome,
 *  not an activity). New declarations must provide it; it stays optional in
 *  this persisted type because committed history may contain legacy
 *  contracts without a label. `items[]` are the acceptance conditions;
 *  `verify_with` remains item-level.
 *
 *  The runtime validates structure, command bindings and references. It never
 *  judges whether `work_item` sounds like a deliverable, whether an item
 *  matches a command semantically, or whether a command is the right
 *  acceptance test; that is Agent/operator semantic judgment. */
export interface RoundContractProposal {
  /** The bounded deliverable this slice produces. Required for NEW
   *  declarations, optional when reading legacy committed history. */
  work_item?: string;
  /** v3.9.9: the Agent's declared intended file boundary — an optional,
   *  report-only intent statement. Omission and `[]` both mean "no declared
   *  intent". It takes part in contract content identity (a restated route is
   *  a new declaration), but it grants no permission and never rejects a
   *  round: drift is reported as an info fact only. Required for legacy reads
   *  of pre-3.9.9 proposals; new declarations may omit it. */
  scope?: string[];
  items: ContractItemProposal[];
}

/** v3.9.9: an explicit, one-way redirection of the ACTIVE Round Contract.
 *  The target id binds the transition to the exact contract the Agent saw, so
 *  a stale prompt cannot close a different contract. A legal transition
 *  always carries the successor proposal in the same evaluation. */
export interface ContractTransition {
  kind: "supersede";
  /** Must equal the active contract id (`rc-XXXXXXXX`) rendered in this
   *  round's prompt. */
  contract_id: string;
  /** Agent report, audit only, ≤ 500 chars. */
  reason?: string;
}

/** v3.8: The machine's record of what a contract bound at its declaration
 *  round. Stamped by the runtime when the declaring round COMMITS (policy is
 *  not part of the Vault, so the command configuration in force at
 *  declaration could not otherwise be recovered). It is machine-recomputed,
 *  never agent-supplied, and adds no second truth. */
export interface ContractBinding {
  rc_id: string;
  item_ids: string[];
  config_hash_by_command: Record<string, string>;
}

/** v3.8: Runtime-derived contract item status. The agent may only claim
 *  `met` / `remaining`; the other three are machine-derived. */
export type ContractItemStatus =
  | "pending"
  | "insufficient"
  | "contradicted"
  | "verified";

/** v3.8: The round-level verification posture. `trusted` means every claim in
 *  the round is machine-backed; `insufficient` means claims are unbacked but
 *  not contradicted; `contradicted` means machine facts deny a claim. */
export type RoundVerificationStatus =
  | "trusted"
  | "insufficient"
  | "contradicted"
  | "not_applicable";

/** v3.8: Machine observation status. A configured provider always produces an
 *  observation — the failure modes are recorded, not filtered away.
 *
 *  Who reports what: `timeout` and `unavailable` are the runtime's own words
 *  for "the provider exceeded its deadline" and "the provider yielded
 *  nothing" (the collector synthesizes both, so a provider cannot hide a
 *  failure by returning nothing). `aborted` is what a PROVIDER reports when
 *  its own capture was aborted — a command killed mid-flight, say. A
 *  collector deadline aborts the capture AS a timeout, so the round records
 *  the runtime's measured cause, not the provider's. */
/** v3.9.7: the four-state progress verdict shared by every consumer.
 *  `not_applicable` = no progress-capable provider participated;
 *  `unknown` = a progress-capable provider participated but its signal could
 *  not be compared. Neither ever proves "no progress". */
export type ProgressState =
  | "changed"
  | "unchanged"
  | "unknown"
  | "not_applicable";

/** v3.9.7: prompt-level freshness derived over one committed round. The
 *  prompt level is a density decision; it never changes governance facts. */
export type PromptFreshnessReason =
  | "progress_changed"
  | "progress_unchanged"
  | "progress_unknown"
  | "no_progress_provider"
  | "after_command_activity"
  | "declared_evolution"
  | "no_observable_activity"
  | "no_previous_committed_round";

export interface PromptFreshness {
  machineProgress: ProgressState;
  providers: string[];
  /** An after-phase command produced a structured, attributable result. */
  machineActivity: boolean;
  /** The committed evaluation declared evolution the compiler consumes. */
  declaredEvolution: boolean;
  /** false ONLY when no-activity is proven; unknown counts as fresh. */
  observableNewInformation: boolean;
  /** Stable, deterministic order. */
  reasons: PromptFreshnessReason[];
}

export type ObservationStatus =
  | "observed"
  | "passed"
  | "failed"
  | "timeout"
  | "unavailable"
  | "error"
  | "aborted";

/** v3.8: Common machine-observation fields. Observations are the factual
 *  record of what the machine saw; they are persisted with the round and are
 *  the only input that can create a `verified` fact. */
export interface MachineObservationBase {
  /** v3.9.1: Git observations are schema 2 (complete boundary), command and
   *  custom observations remain schema 1. The persisted parser validates the
   *  version per kind; an unsupported pair is a hard break. */
  schemaVersion: 1 | 2;
  providerId: string;
  kind: "git" | "command" | "custom";
  phase: "before" | "after";
  startedAt: number;
  finishedAt: number;
  status: ObservationStatus;
  /** Observation-local file list. NEVER the round change set:
   *  - git: the dirty display list at this boundary; the complete boundary is
   *    `data.fingerprints` and the round delta is derived from before/after;
   *  - command: always empty; entrypoints live in `data.entrypointFiles`;
   *  - custom: provider-defined display metadata. */
  files: string[];
}

/** v3.9.1: the Git observation's data schema. Version 1 was the
 *  dirty-files-only shape; version 2 is the complete workspace boundary. */
export const GIT_OBSERVATION_SCHEMA_VERSION = 2 as const;

export interface GitObservationData {
  /** Paths dirty relative to HEAD at this boundary. Informational only; the
   *  round's change set is derived from `fingerprints`, never from this list. */
  dirty: string[];
  /** Every tracked path plus every non-ignored untracked path at this
   *  boundary. Value: a content/type fingerprint.
   *  - regular file: `<mode>:<sha256>`
   *  - symlink: `link:<sha256(target text)>`
   *  - gitlink (submodule): `gitlink:<index commit sha>`
   *  - other directory: `dir:<mode>`
   *  - absent: `missing`
   *  - unreadable: `unreadable:<mode>`
   *  The delta is the union-key comparison of the before/after maps. */
  fingerprints: Record<string, string>;
  head?: string;
  /** Explicit coverage statement. Gitignored paths and submodule contents are
   *  NOT enumerated; the filesystem entrypoint-trust baseline independently
   *  covers entrypoints. */
  coverage: "tracked_and_non_ignored_untracked";
}

export interface GitObservation extends MachineObservationBase {
  kind: "git";
  data: GitObservationData;
}

export interface CommandObservationData {
  commandId: string;
  argv: string[];
  cwd: string;
  /** sha256 of the normalized command configuration at capture time. */
  configHash: string;
  required: boolean;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  /** Why a non-passed observation did not pass (e.g. "ENOENT", "cwd leaves
   *  the workspace"). Free text for the audit trail — never a verdict. */
  failureDetail?: string;
  /** sha256 over the FULL stdout stream — never the truncated excerpt. */
  stdoutSha256: string;
  /** sha256 over the FULL stderr stream. */
  stderrSha256: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  truncated: boolean;
  entrypointFiles: string[];
}

export interface CommandObservation extends MachineObservationBase {
  kind: "command";
  data: CommandObservationData;
}

/** v3.9.9: the normalized identity of the evidence range a progress fact
 *  covers. `domain/object/scope` is a logical identity, not a file path:
 *  matching is exact — no wildcards, no normalization, no subset inference —
 *  and `version` must be equal because a different version means the
 *  provider's fingerprint semantics changed. */
export interface ProgressCoverage {
  /** Evidence domain, e.g. "workspace". */
  domain: string;
  /** Object/rule inside the domain, e.g. "git-motion". */
  object: string;
  /** Normalized coverage identity, e.g. "tracked_and_non_ignored_untracked". */
  scope: string;
  /** The provider's own evidence semantics version. */
  version: number;
}

export interface CustomObservation extends MachineObservationBase {
  kind: "custom";
  /** Provider-defined display data. It is a report, not a progress fact:
   *  only Git workspace progress participates in stall/freshness rules. */
  data: Record<string, unknown>;
}

export type MachineObservation =
  | GitObservation
  | CommandObservation
  | CustomObservation;

/** v3.8: Static, policy-derived verification capability. A pure function of
 *  policy — no probing, no filesystem, no provider registry — so it can be
 *  hashed into stateHash and reproduced by replay/audit from committed facts.
 *  Provider REGISTRATION is code state and is deliberately excluded; it is
 *  reported as an unhashed readiness diagnostic instead. */
export interface ConfiguredCapability {
  schemaVersion: 1;
  providers: Array<{ providerId: string }>;
  commands: Array<{
    commandId: string;
    enabled: boolean;
    phase: "after" | "both";
    required: boolean;
    configHash: string;
  }>;
  /** policy.evidence.providers is non-empty. */
  observationConfigured: boolean;
  /** At least one enabled, after-capable command. */
  contractVerificationAvailable: boolean;
}

/** v3.8: Live observation capability. Rendered only — never hashed, never
 *  persisted independently of the observations it is derived from. */
export interface ObservedCapability {
  providers: Array<{ providerId: string; status: ObservationStatus }>;
  commands: Array<{
    commandId: string;
    status: ObservationStatus;
    configHash: string;
  }>;
}

/** v3.8: The single capability fact a prepared round returns — the union of
 *  the two halves, split so that only the POLICY half is hashable.
 *
 *  `ConfiguredCapability` is a pure function of policy and feeds
 *  `stateHash`/`promptHash`; `ObservedCapability` carries live statuses and is
 *  rendered only. `provider.available` is provider-REGISTRY state (code, not
 *  policy) and therefore never enters the hash either — it is reported here and
 *  by `doctor`. Every surface that speaks about capability (MCP start / next /
 *  status, the warning list) calls this one function, so they cannot drift
 *  apart — and none of them carries a second copy of the fact. */
export interface EvidenceCapability {
  schemaVersion: 1;
  providers: Array<{
    providerId: string;
    /** A factory for this name is registered in this runtime. */
    available: boolean;
    status: ObservationStatus;
  }>;
  commands: Array<{
    commandId: string;
    enabled: boolean;
    phase: "after" | "both";
    configHash: string;
    /** Enabled and after-capable — i.e. usable as a contract item's evidence. */
    ready: boolean;
  }>;
  contractVerificationAvailable: boolean;
  /** Human-readable capability gaps (the same text start/resume/status show). */
  warnings: string[];
}

// ── v3.8: MCP tool error codes ──────────────────────────────────────────────

/** v3.8: The STABLE error codes every tool answers with. A client can branch
 *  on these; the human sentence rides in `ToolError.message` and never doubles
 *  as the code.
 *
 *  - `evaluation_invalid` / `contract_invalid` / `policy_invalid` — a payload
 *    or configuration defect; the same submissionHandle may be retried.
 *  - `projection_incomplete` — a code defect in the prompt projection: an
 *    active normative ID was not rendered, so no prompt is delivered. Not
 *    retryable by the agent.
 *  - `submission_handle_required` — the handle is missing or structurally
 *    malformed. The same call may be retried after obtaining the current
 *    handle from `loopforge_status` (live session) or `loopforge_resume`
 *    (lost prompt or no live session).
 *  - `submission_handle_mismatch` — the handle no longer names the held
 *    attempt. A `next`/`recover` submission returns the held prompt with a
 *    warning and `ok: true` when one exists so the agent can recover the
 *    response it missed; with no held prompt, or for `checkpoint`/
 *    `gate_check`, it is this stable error.
 *  - `session_not_found` / `state_unavailable` — the named session or read
 *    model is not there.
 *  - `invalid_argument` — the request itself is malformed at the tool boundary.
 *  - `gate_disabled` / `gate_invalid` / `loop_already_running` /
 *    `lease_conflict` — a state
 *    condition, not a defect. */
export type ToolErrorCode =
  | "evaluation_invalid"
  | "contract_invalid"
  | "policy_invalid"
  | "projection_incomplete"
  | "session_not_found"
  | "submission_handle_required"
  | "submission_handle_mismatch"
  | "state_unavailable"
  | "invalid_argument"
  | "gate_disabled"
  | "gate_invalid"
  | "loop_already_running"
  | "lease_conflict"
  | "start_failed"
  | "loop_exists"
  | "legacy_history"
  | "operator_acceptance_conflict"
  | "recovery_invalid"
  | "recovery_disabled"
  | "recovery_unavailable"
  | "checkpoint_invalid"
  | "checkpoint_unavailable"
  | "checkpoint_failed"
  | "checkpoint_limit"
  | "restore_failed"
  | "restore_pending";

/** v3.8: The structured error inside the uniform `{ok: false}` envelope. */
export interface ToolError {
  code: ToolErrorCode;
  /** Human-readable cause. Never the code. */
  message: string;
  /** Whether the fix is a corrected payload the agent may resend. */
  retryable: boolean;
  sessionId?: string;
  /** v4.0.0: the current held handle, when one exists, so the caller can
   *  re-anchor without reconstructing it. */
  submissionHandle?: SubmissionHandle;
  details?: Record<string, unknown>;
}

// ── Factory helpers ─────────────────────────────────────────────────────────
