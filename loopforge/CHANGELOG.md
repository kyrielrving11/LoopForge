# Changelog

## 4.0.2 (2026-10-27)

**The fresh-context / bounded-working-memory release.** Each round can now run
in a clean Agent context without losing long-horizon continuity. This is a
breaking release with no migration path: 4.0.1 committed rounds are reported as
legacy envelopes, and 4.0.1 held sessions cannot be resumed.

### Derived context boundary

- `PromptArtifact` schema 8 adds required `contextMode` (`fresh_round` /
  `same_round_retry`) and `contextReason` (`first_round`, `next_round`,
  `recovery_redo`, `enforcement_retry`). The compiler derives the pair once
  from compile inputs and committed facts; MCP responses project it from the
  artifact and never re-derive it.
- The prompt header shows the boundary, and the authority boundary explains
  that a fresh context is not a workspace reset. A re-delivered held prompt
  keeps the same artifact and boundary.
- `AdvanceResult` and `SubmissionReceipt.prompt` expose the same facts.

### Bounded Working Memory

- `CanonicalLoopState` schema 6 adds `workingMemory`, derived only from the
  current branch's committed rounds and committed rollback directives: recent
  reports, falsified assumptions/retractions, open questions, consumed
  recoveries, and contract redirects.
- Prompt density follows the level (L0 1 report / L1 3 / L2 5, plus capped
  assumptions, questions, recoveries and redirects) with a hard per-level
  character ceiling; the state file keeps the full fixed window. All Agent text
  is normalized and blockquoted. The section is protected, declares no
  normative ids, and never changes coverage, level, freshness, gates or
  success. A same-round retry renders none.
- The state file's `Corrections` and `Discoveries` sections are replaced by
  `Working Memory`. Wrong assumptions/retractions now render there; discovered
  constraints remain visible through active-constraint provenance. `Retired
  Constraints` is unchanged.
- `PromptArtifact` carries optional Working Memory projection metadata
  (`reportRounds`, counts, previous-report source/rendered chars, truncation).

### `open_questions`

- `SelfEvaluation.open_questions` is an optional, strictly report-only list of
  at most 3 questions × 300 chars. It feeds Working Memory, replay and explain,
  never a gate, success, contract closure or machine evidence.
- `submission_guidance`, the MCP evaluation schema, field accounting, the
  receipt (`saved_not_expanded`) and `CommittedRoundView` carry it.

### Retrieval

- `loopforge_replay` accepts `start` / `end`, defaults to the last 10 committed
  rounds, caps an explicit window at 50 rounds, and returns
  `window: { start, end, totalRounds, hasBefore, hasAfter }`.
- Timeline rows add `attempt`, `context_mode`, `context_reason`, `outcome`,
  bounded `report`, `wrong_assumptions`, `retracted_constraints`,
  `open_questions`, `blocker`, and `contract_redirect` (replacing
  `contract_transition`). Rollbacks add `failedRounds`, `approaches` and
  `wrongAssumptions`.
- `explain` returns a committed report whenever an evaluation exists (even
  without an `execution_report`), plus context, assumptions, open questions,
  blocker and rollback abandoned-path facts.

## 4.0.1 (2026-10-24)

**The single-commit release.** One committed typed round transaction is now the
complete fact of a round. Compiling no longer writes the Vault, so an
uncommitted prompt or a rejected attempt cannot influence a later prompt.
History has one interpretation (`CommittedRoundView`), one window
(`historyWindow` / `derivationRounds`) and one read path
(`loadCommittedHistory`). This is a breaking release with no migration path.

### Breaking: one committed round document

- `compileLoop` / `LoopForgeEngine.invokeLoopCompile` are read-only. Compile
  lineage, the merged read model, the hydration cache and their invalidation
  paths are removed. A round record is written only by
  `RoundTransactionCoordinator`, as one `:feedback` document containing the
  complete snapshot.
- The engine exposes no feedback, rollback or delegation write API. The
  coordinator is the only history writer.
- `LoopCompileRequest` is a closed typed request. `LoopForgeRequest`, `Mode`,
  `ExecutionFeedback`, `LoopForgeResponse`, `SessionState`, `makeTaskId`,
  `last_round_result`, `next_task_proposal`, `mode`, `domain` and
  `loop-extras-parser.ts` are removed. Operator acceptance is passed as
  `invokeLoopCompile(request, { operatorAcceptance })` and is immutable.
- Removed response fields: `diff_from_previous`, `lineage`, `goal_text_hash`,
  `PreviousRound.goal_text_hash`. A caller-supplied acceptance that disagrees
  with committed history fails closed with `operator_acceptance_conflict`.

### Removed channels

- `prompt_requests` (emphasize/confusion points, effects, critical context).
- `objective_refinement`.
- Custom progress snapshots, selectors and provider governance. Progress is a
  Git workspace fact; a custom observation remains a raw report and cannot
  affect stall or freshness.
- The delegation journal. `worker_results` keeps only
  `agentId/subTask/resultSummary/outcome` inside the committed transaction.
- Contract item `subgoal_refs`, `VerifiedSubGoalFact`, verification debt and
  `CriterionStatus.related_subgoal_ids`. Sub-goals remain an Agent plan report
  and are still rendered.

### Lifecycle and integrity

- A failed start returns stable `start_failed` and saves no running session.
  A failed resume/unpause compilation becomes `stalled` and is retryable; a
  projection defect remains `projection_incomplete`.
- Starting over an existing session or any committed round returns
  `loop_exists` (non-retryable). `SessionStateStore.save` gained
  `expectAbsent` for the atomic create gate.
- Compile fails closed when projection coverage is incomplete
  (`projection_incomplete`) or acceptance copies conflict
  (`operator_acceptance_conflict`).
- Schema 6 requires `compiled` and `operatorAcceptance` on a submitted
  evaluation and `operatorAcceptance` (without `compiled`) on a rollback
  directive. Schema 5 rounds are reported as legacy; resume/unpause refuse to
  recompile over them (`legacy_history`), audit reports the gap explicitly, and
  health exposes `legacy_rounds`.
- State-file writes are skipped when the rendered content is unchanged.

### Versions

- package: `4.0.0` → `4.0.1`
- `ROUND_TRANSACTION_SCHEMA_VERSION`: `5` → `6`
- `PROMPT_ARTIFACT_SCHEMA_VERSION`: `6` → `7`
- `CANONICAL_STATE_SCHEMA_VERSION`: `4` → `5`
- `POLICY_SCHEMA_VERSION`: `"9"` → `"10"`
- Existing round documents are not migrated. Use a new loop id for new work;
  old rounds stay readable only as explicit legacy diagnostics.

### Read-only views

- `loadCommittedHistory` performs one store read and returns entries, views,
  branch, window, directives, pending directive and legacy rounds. Session,
  lifecycle, submission boundary, coordinator, audit, explain, replay and
  metrics read through it; the CLI remains the allowed low-level query surface.
- `ReplayBackend.getRound` / `replay` return `CommittedRoundView`; `timeline`
  reads the Vault once and takes level from `promptArtifact`, task/goal from
  `compiled`, and progress from Git facts only.

## 4.0.0 (2026-10-24)

**The submission-handle release.** Held-round identity becomes ONE derived
transport object, validated exactly against the held snapshot before any
payload judgment, queueing, lease heartbeat, save, Vault write, gate record, or
terminal notification. The Forge skill becomes a lean core manual plus
on-demand references. This is a breaking release with no migration path.

### Breaking: one submission handle

- `loopforge_next`, `loopforge_checkpoint`, and `loopforge_gate_check` now take
  a single `submissionHandle` (`{sessionId, roundId, transactionId}`) instead
  of separate top-level anchors. The object is closed; old scattered anchors
  are rejected by the tool schema.
- `submissionHandle` is a projection derived from the persisted held snapshot.
  It is never persisted in the session document, a round transaction, a prompt
  artifact, guidance, or a receipt, and it is never embedded in the prompt
  (`transactionId` is derived from `promptHash`, so embedding would be
  circular).
- Held-prompt responses (`start`, `next`, `resume`, `status view=session`,
  `checkpoint`) return `submissionHandle` and no longer return top-level
  `roundId`/`transactionId`. `sessionId` remains for session-only tools.
- `submission_guidance.round_id` is removed: the guidance no longer carries a
  second anchor representation.
- `ToolError` replaces `roundId` with `submissionHandle`.
  `round_id_required`/`round_id_mismatch` become
  `submission_handle_required`/`submission_handle_mismatch`.
- The public `SessionManager.advance`/`recover`/`checkpoint`/`checkGate`
  signatures take the raw handle; `AdvanceResult` no longer exposes
  `roundId`/`transactionId`.

### Identity and zero side effects

- A stale handle never submits work. `next`/`recover` return the exact held
  prompt with the current handle and a warning when one exists; otherwise they
  return `submission_handle_mismatch`. `checkpoint`/`gate_check` return the
  stable mismatch without creating a checkpoint or `gate_opened`.
- Handle validation runs before the payload boundary and again inside the
  session queue before `renewSessionLease`. A stale handle cannot renew a
  lease, save a session, write the Vault, increment rejection state, record
  metrics, notify a terminal sink, or flip a stalled session to running.
- `restoredPromptResult` becomes `heldPromptResult`: the held predicate now
  requires a prompted evaluation whose snapshot and prompt artifact agree on
  round, attempt, and non-empty rendered prompt.
- A rejection rebinds the attempt and returns a new handle; an invalid
  evaluation keeps the same handle; a checkpoint leaves it unchanged; terminal
  results carry none.
- A post-commit compile failure has no held prompt and is recovered with
  `loopforge_resume`; an old handle never re-submits the committed round.

### Forge skill and onboarding

- `SKILL.md` is now the lean core workflow, with detailed
  `references/evidence-and-contracts.md` and
  `references/recovery-and-views.md` read on demand. Field applicability,
  legal shapes, real ids, and usable commands remain runtime
  `submission_guidance` facts; the references do not duplicate them.
- `loopforge init` installs the whole Forge skill directory. A normal install
  leaves an existing skill untouched; `--force` replaces the package-owned
  tree, removing stale reference files. After upgrading, run
  `loopforge init --client <client> --force`.
- The MCP `initialize` instructions stop restating field semantics and no
  longer say “execution_report is expected”; they point at `submission_guidance`
  and the one handle.

### Consistency and maintenance

- The real-field-usage experiment harness uses the handle API (it had already
  been missing the required transaction anchor since 3.9.7).
- Command evidence is unchanged: no `result_format`, no policy/command
  observation schema change, and existing command contract bindings remain
  valid.
- The transaction envelope (5), policy schema (9), prompt artifact (6), and
  command observation (1) versions are unchanged. Old Vault history remains
  readable; legacy reports are preserved.

## 3.9.9 (2026-10-23)

**The evidence-coverage and contract-redirection release.** Machine progress
becomes a set of reported facts with an explicit coverage range; a rule selects
the exact facts it consumes. The Agent can redirect an active Round Contract
through a typed transaction instead of misreporting it as blocked. `scope`
remains a useful intent signal but stops being a machine permission.

### Progress facts and coverage

- `ProgressCoverage { domain, object, scope, version }` identifies the evidence
  range a provider observed. Matching is exact and kind-gated — no wildcards,
  path normalization, or subset inference.
- `ObservationDelta.progress` is now a typed fact
  (`{ kind, coverage, state, complete, detail? }`) or `null`. `state` is the
  only authority; `complete` is a display/diagnostic assertion.
- `deriveRoundProgress(deltas, selector)` and
  `deriveProgressWindow(rounds, currentRound, lookback, selector)` require an
  explicit selector. Array selectors are ALL-style: a missing required
  coverage is `unknown` when another has a fact, never `unchanged`. `"any"` is
  display-only.
- Stall, the submitted round, prompt freshness, and the machine-status
  dashboard all use the fixed Git workspace coverage
  (`GIT_WORKSPACE_COVERAGE`). A custom provider's changed/unknown/unchanged can
  no longer prevent a stall or pin the loop at L1; replay/explain show every
  fact.
- Custom providers declare `progressCoverage` instead of `progressCapable`.
  Every capture carries a nested `ProgressSnapshot` (inner schema 2) with the
  declared coverage, a completeness flag and a 64-hex fingerprint; failures
  carry the same coverage with `complete:false` and a null fingerprint, so an
  unobservable capture remains an explicit `unknown`.
- Custom observation base schema stays 1. Only the nested progress snapshot
  moved to inner schema 2; rounds without progress stay readable, while old
  inner-1 snapshots and the retired `progressCapable` marker are reported as
  observation legacy. Transaction envelope remains 5.
- Capability warnings state when no Git provider is configured: the stall rule
  then has no workspace evidence basis. This is a fact, not a block.

### Contract redirection

- New `contract_transition { kind: "supersede", contract_id, reason? }`.
  `contract_id` must equal the active `rc-*` id rendered in the current
  prompt, and the successor `round_contract` is required in the same
  evaluation.
- Strict boundary rejects: no active contract, stale/other target, missing
  successor, blocked outcome/stop_reason, `should_continue=false`, invalid
  kind, over-long reason, unknown fields, and a successor whose acceptance
  items are unchanged (work_item/scope-only edits do not count).
- Closure priority is `blocked > superseded > verified > open`. A redirect
  round closes the old contract as `superseded`, keeps every item status for
  audit, activates its successor next round, never restores the workspace, and
  cannot be `completed`. Audit's final verdict is `incomplete` when the last
  executed contract ended superseded or blocked.
- Verification debt is retired only by an honest abandonment: a superseded
  contract with no `met` claim on its items produces no debt finding; a round
  that still claims an old item `met` keeps the finding and its streak.
- Explain and replay expose the transition; the receipt derives
  `effects.contract.superseded` / `transition_reason` from the committed
  transition, never from a `contract_premature` inference.

### Scope is report-only

- `RoundContractProposal.scope` is optional. It no longer requires workspace
  containment, never rejects a declaration, and is normalized leniently with
  diagnostics.
- `round_scope_drift` is now an `info` fact: it never rejects, terminates,
  backtracks, stalls, or reaches the rejection counter. A persisted
  `round_scope_drift` streak from an older runtime is drained on load.
- Prompts render `Declared scope (Agent report; not enforced)`.

## 3.9.8 (2026-10-23)

**The workspace-checkpoint release.** Rounds remain the cognitive and audit
unit; transactions remain the execution unit; workspace checkpoints become the
recovery and machine-evidence unit. LoopForge no longer asks the Agent to
restore its own workspace. The Agent selects a checkpoint, LoopForge commits a
typed rollback directive, executes the restore, verifies the complete Git
boundary, and only then issues the redo prompt.

### Checkpoints and restore

- Every prepared evaluation transaction records an automatic before-image
  (`beforeCheckpoint`) or an explicit `beforeCheckpointError`; a round still
  proceeds when no checkpoint store or Git boundary is available.
- `loopforge_checkpoint` creates explicit mid-round savepoints. They add no
  round, commit or progress and are capped per transaction.
- Checkpoints are content-addressed: the manifest holds the exact fingerprint
  map and only dirty/untracked regular-file and symlink content is stored as
  blobs. Visibility, ownership and `redoRound` come from the transaction's
  `CheckpointRef`, never from a manifest alone.
- `loopforge_next` recovery now takes `target_checkpoint_id`. The directive
  binds the target by checkpoint id and content hash; `redoRound` is the only
  branch fence.
- LoopForge executes the restore (`git reset --hard` for the recorded HEAD plus
  exact file writes/deletes), then verifies HEAD and the full fingerprint map
  against the manifest before compiling the redo.
- A failed restore keeps the directive pending, persists `stalled`, and is
  retried by `loopforge_resume`; no redo prompt is issued without verification.
- Machine backtrack targets the before-image of round T+1 and uses the same
  restore protocol. R9 and the old skipped-file/HEAD redo checks are deleted;
  a restore is not round progress.

### Transaction and session identity

- Round transaction schema 4 → 5. Schema 4 is reported as legacy, not migrated.
- `transactionId` joins `roundId` as a required submission anchor for
  `loopforge_next` and `loopforge_checkpoint`; recovery requires both.
- Retry rebinds the transaction id while preserving the logical round, the
  before-image/error fact and a verified restore marker.
- Branch identity propagates through redo, resume, unpause and later rounds.
- `stalled` sessions are reconstructible and resumable; pending directives are
  processed before committed-decision replay.
- `operatorAcceptance` is carried as a session cursor so a restore that clears
  the held snapshot cannot lose the operator's acceptance surface.

## 3.9.7 (2026-10-22)

**The responsibility-boundary hardening release.** Agent semantics remain
Agent-owned; LoopForge owns committed facts, provenance, deterministic
projection and machine checks. The Agent can no longer accidentally turn a
report into a second governance history: objective refinements are report-only,
discovered constraints carry rendered provenance, retractions resolve to real
active discoveries, and emphasis can reach every current governance object
without duplicating it. Machine progress becomes provider-neutral while the
Git correctness boundaries stay exactly where they are.

### Semantic reports and governance

- `objective_refinement` is report-only. `LoopObjective.version` and
  `refinement_history` are removed; the report survives only in the committed
  evaluation and receipt/replay/audit. A request objective/plan input is
  accepted only at round 1 or when no committed objective exists.
- `ConstraintMeta` gains `source_round`; constraints render `(Agent-declared
  R3; report, not machine-verified)`, `(plan/carried R2)`, or
  `(origin not recorded)`. Operator precedence is fixed; worker discoveries
  remain reports.
- `retracted_constraints` accepts a `c-` id or normalized-exact text and
  resolves against the current active set. Only active Agent-discovered
  (including recovery-preserved) constraints are retractable. Operator and
  plan targets are rejected; unknown/inactive/already-retired targets are
  inert diagnostics. `constraints.retire_window` is deleted; a new discovery
  reactivates immediately.
- The per-round discovery cap is diagnosed at the submission boundary instead
  of silently sliced in the compiler.
- Recovery-preserved discoveries come from the committed rollback directive,
  never `constraints_from_plan`; discoveries from the rejected trigger attempt
  never enter the active set.
- `state.discoveries` contains discovered constraints only. Corrections render
  the Agent's report verbatim, without a LoopForge "Corrected/Falsified"
  verdict.

### Prompt requests

- Emphasis candidates are the current `CanonicalLoopState`: constraints,
  criteria, contract (`rc-`), items (`rci-`), active sub-goals (`sg-`), current
  findings (`f-`), and the recovery brief (`recovery`). Matching is exact id or
  normalized-exact text; closed/historical objects never resurrect.
- A contract id moves the whole block; an item id moves only that item.
  Findings and recovery move without duplication; Current Task is re-rendered
  from the structured contract. Effects record `applied`/`capped`/`no_match`/
  `ambiguous`/`level_ignored` with `matched_ids` and `matched_count`.
- Confusion points are echoed as the Agent's own notes, never matched against
  state.

### Provider-neutral progress

- Git keeps its complete-boundary/HEAD/restore-point rule. A custom provider
  opts in with a persisted `data.progressCapable` marker and a versioned
  `data.progress` fingerprint. Command observations never provide progress.
- One `progress.ts` produces `changed`/`unchanged`/`unknown`/`not_applicable`;
  any proven change wins, unknown blocks "unchanged", and no applicable
  provider is `not_applicable`. A stall requires both the window and the
  submitted round to be `unchanged`. The flatline tier is collapsed into one
  policy-configurable window and the `progress_stall` ladder.
- Prompt freshness, machine-status display, replay and metrics read the same
  derivation. Git-specific entrypoint trust, recovery restore, scope drift,
  files reconciliation, `evidenceIncomplete` and contract-item checks are
  unchanged.

### Contract / blocked / rejection

- `declaresBlocked` is the one blocked predicate for stop, waiver, contract
  closure/walker, `contract_premature` and the blocked-gate record. A blocked
  contract closes before a verified reading.
- A valid blocked stop is not converted into a same-round rejection by
  `progress_stall`, contract debt or the rejection counter; machine-integrity
  rows still apply.
- The rejection notice is a protected `retry_requirements` section at every
  level. It no longer repeats the original task or the full finding list; the
  false "explain and the gate will re-evaluate" promise is gone.
- Strategy-prescribing texts are removed from enforcement, actions and
  guidance; the tables state machine facts and legal protocol paths only.

### Breaking boundaries

- `CANONICAL_STATE_SCHEMA_VERSION` is `4`.
- `PROMPT_ARTIFACT_SCHEMA_VERSION` is `6`.
- `POLICY_SCHEMA_VERSION` is `"9"`: `constraints` and
  `evolution.max_objective_versions` are removed.
- `LoopObjective.version` / `refinement_history` and
  `CanonicalLoopState.objectiveVersion` are removed.
- `PromptCoverage.omitted[].reason` is `"defect"` only.
- `PromptRequestEffect` adds `matched_ids`, `matched_count` and `ambiguous`.
- No migration is provided. Schema-5 artifacts and policy v8 are unsupported
  and reported as legacy/loss. Custom observations remain schema 1; an old
  observation without progress data reads as `not_applicable`.

## 3.9.6 (2026-10-22)

**The Agent-authority release.** LoopForge stops generating plans, phase
narrative, task-specific contract proposals, and non-committed prompt context.
The Agent owns semantic judgment and action; LoopForge owns committed facts,
machine checks, recovery mechanics and deterministic projections.

### Agent-initiated recovery

`loopforge_next` accepts a top-level `recovery: { target_round, reason }` as an
alternative to `evaluation`. Recovery is an action, not an evaluation: it does
not require the four core fields and never fabricates a `SelfEvaluation`. The
held prompt's `roundId` is required (`round_id_required`), and the target must
be an earlier committed evaluation on the current branch with an observed
after-phase Git restore point. The target is a restore point, not a success
claim: error-level verification findings on it do not disqualify it. The
restore checkpoint compares the workspace's complete Git fingerprint boundary
with the target's own snapshot. LoopForge records the Agent's reason verbatim
and never judges it; the Recovery Brief renders it as report-only text, never
as an instruction.

Rollback directives are committed as typed `rollback_directive` events rather
than `:feedback` rounds, so a redo cannot overwrite the audit record. Every
transaction now carries a deterministic `transactionId` and a `branchId`; a
rollback directive's transaction id names the child branch. The branch read
model (`resolveBranch`/`branchRounds`/`pendingRollbackDirective`) replaces the
session frontier, excluding abandoned rounds and preserving the final redo
round after a stop. The redo checkpoint is fail-closed: an unobservable Git
boundary is a `recovery_checkpoint_failed` finding, and an Agent checkpoint
rejects the redo for the same `roundId` rather than opening a machine-origin
backtrack. Replay is keyed by `transactionId`, not only `roundId`: a redo at
`target + 1` no longer replays the abandoned feedback commit that occupied the
same numeric round.

### Redo receipt checkpoint

The first submission after a rollback (the redo) now carries
`recovery_checkpoint: { restore_point, origin, reason, verified }` on its
`submission_receipt`. The directive is captured before the redo commits,
because a committed child round consumes the pending state. `verified` is the
same machine checkpoint the gate acts on: an error-severity
`backtrack_workspace_not_restored` finding makes it false, while a warning
(claimed files overlap the skipped set) does not. Explain, audit and
`last_submission` rebuild the same field from the rollback window, so a lost
response does not lose the checkpoint fact.

### Operator acceptance is immutable

`revised_success_criteria` is removed. Criteria and hard constraints written by
`loopforge_start` cannot be revised or retracted by the Agent; a boundary
attempt returns `evaluation_invalid` with the `immutable_constraint` detail,
and the compiler ignores such retractions as a second line of defense. The
acceptance surface is carried on the round-1 transaction snapshot and
propagated with the held round; the boundary reads it directly when present. `retracted_constraints` applies only to Agent-discovered
constraints. Objective refinements are committed reports and no longer rewrite
the operator objective.

### Removed LoopForge-authored cognition

- `LoopProjection` / `todo` / `handoff` / `phase` / `delegation` are deleted.
- `RollingSummary`, `MilestoneSummary`, automatic/criteria milestones, and the
  prompt `Phase`/`Phase Anchors` sections are deleted. `compression_checkpoint`
  remains only as an Agent declaration and L2 boundary reason.
- The no-active-contract prompt no longer seeds a `round_contract` from the
  task/criteria or gives slice-sizing advice; it shows a schema-only example,
  real usable command names, and the structural lifecycle rules.
- Explicit `external_context` injection is removed. The prompt is built only
  from committed facts and the current in-flight machine inputs.
- The typed projection was removed from `loopforge_next`/`loopforge_status`.
- Task-specific contract proposal and decomposition advice are removed from
  the evaluation prompt; verification repair text remains a description of the
  machine condition that must be cleared.

### Session is a cursor, not a second history

The session no longer mirrors committed facts. `successTrajectory`,
`lastSelfEval`, `evidenceBaseline`, `currentPrompt`, `currentLevel`,
`currentWarnings` and the `backtrack*` restore fields are removed. The success
trajectory and previous evaluation derive from committed branch rounds; the
restore facts derive from the pending rollback directive; the held prompt and
level derive from `roundSnapshot.promptArtifact` (warnings are stored on the
artifact). `loopforge_stop`/`status` compute the trajectory from committed
rounds. `task`, `consecutiveRejections`, `lastRejectionCheck` and
`entrypointTrust` remain runtime control state. `lastCompileResponse` is
removed: sub-goals, criteria, prompt level and the criterion reference space
derive from the committed window and the held `operatorAcceptance` instead of
whatever the last compile happened to cache. The process/result inputs
`lastSelfEval`, `successTrajectory`, `newLastSelfEval` and the legacy
`backtrack*` mirrors are deleted; rollback facts have one representation,
`RoundProcessResult.recovery`.

### Breaking boundaries

- `ROUND_TRANSACTION_SCHEMA_VERSION` is `4` (`kind`, `transactionId`,
  `branchId`, `recovery` with `target_fingerprints`, `operatorAcceptance`).
- `PROMPT_ARTIFACT_SCHEMA_VERSION` is `5` (`warnings` on the artifact).
- `CANONICAL_STATE_SCHEMA_VERSION` is `3`.
- `POLICY_SCHEMA_VERSION` is `"8"`; `summary`/`checkpoint` sections and
  `summary.milestone_interval` are removed; `engine.agent_recovery_enabled`
  is added.
- Removed protocol types/fields: `LoopProjection`, `CriterionRevision`,
  `RollingSummary`, `MilestoneSummary`, `ExternalContextProvider`,
  `ExternalContextRequest`, `revised_success_criteria`, `Failed patterns`,
  phase/milestone fields.
- No migration is provided. Schema-3 transactions, schema-4 prompt artifacts
  and policy v7 files are unsupported and reported as legacy/loss.

## 3.9.5 (2026-10-21)

**The memory-boundary and contract-semantics release.** The prompt stops
replaying the Agent's own progress narrative. It becomes a current-governance
projection: objective, criteria, constraints, active contract and acceptance
conditions, active sub-goals, machine findings, recovery facts, and a compact
phase anchor. Full history stays in the derived state file / replay / audit.

`output_summary` is still a strict core field and remains in the Vault, audit,
replay, explain, receipts, checkpoint outcomes and backtrack failed-approach
facts. It is no longer a default prompt input and the projection no longer
exposes a latest-outcome `focus` or `handoff.summary` "Latest outcome" segment.
`Recent Rounds`, `Cross-Round Outcomes`, `Failed Patterns`, `Discoveries`,
`Retired Constraints`, `Full Rehydrated State`, and the old `Changes Since Last
Round` narrative are removed from prompts; the state file keeps them as derived
history. L2 renders at most three `Phase Anchors` (labels/ranges only, never
`outcome`) and never embeds the state markdown.

Committed-only gating: `prompt_requests`, `Corrections` (wrong assumptions),
agent-reported blockers, discoveries, progress evidence, remaining criteria,
and duplicate-declaration warnings read the committed previous round, not the
library `last_round_result` fallback. The fallback may still drive semantic
evolution when no committed view exists, but it cannot become prompt or
state-file narrative.

The fixed prompt header now states the authority boundary: LoopForge's current
committed projection wins for committed/verified state; the Agent's session
history and long-term memory are background and may contain unsubmitted,
rejected or rolled-back work; a current explicit user instruction defines the
task. The state-file read instruction no longer calls the file the source of
truth. Confusion alerts no longer point at a disabled state file.

Round Contract semantics are explicit: `work_item` is the bounded deliverable
(an outcome, not an activity) and is required for new declarations; persistence
stays optional for legacy committed contracts. `items[]` are acceptance
conditions; `verify_with` remains item-level, one condition may use several
commands, and one command may back several conditions. The strict boundary
rejects missing/empty/over-long `work_item` or `scope`, over-long item
descriptions, unknown top-level/item fields, and a top-level `verify_with`.
LoopForge does not judge semantic fit between work_item, items and commands.
Criteria remain the operator acceptance surface, sub-goals the Agent execution
plan, and the contract the explicit bridge; zero `emerged_subtasks` is valid.

### Breaking boundaries

- `LoopProjection.focus` is removed.
- `LoopCompileRequest.new_since_last_round` is removed.
- `PromptAssemblyInput.fullStateMarkdown` and the `full_state` prompt section
  are removed; L2 never embeds the state markdown.
- `prompt.l2_pointer_enabled` is removed; `POLICY_SCHEMA_VERSION` is `"7"`.
- New Round Contract declarations require `work_item` and `scope`; legacy
  committed contracts without `work_item` remain readable.
- `CANONICAL_STATE_SCHEMA_VERSION` is `2` (`changesSinceLastRound` replaced by
  committed `corrections`).
- No migration is provided.

## 3.9.4 (2026-10-19)

**The normative-projection release.** The prompt could omit an active
requirement without saying so: L0 carried no criteria, discovered
constraints or sub-goals, every level capped or dropped normative
sections, and a contract could cite criterion/sub-goal text the prompt
never rendered. Machine findings were prose-only, and a backtrack prefix
was appended after the artifact was hashed. 3.9.4 makes the projection
provable and closes the repair loop.

### Criterion anchors and explicit relations

`loopforge_start.criteria` turns initial local requirements into real
objective criteria with stable `cr-*` ids (normalized-exact dedupe,
empty/duplicate/over-cap warnings, default criterion when omitted, and
round-1 retry preservation). Criterion identity is normalized-exact
everywhere; `unique`'s trim-only dedupe no longer lets case variants share
one id. `criterion_refs` must cite an active `cr-*` the prompt rendered;
`subgoal_refs` may cite only an active displayed `sg-*` (same-round
emerged sub-goals become referenceable next round); duplicate refs and
duplicate normalized items are `contract_invalid`. `deriveCriterionFacts`
no longer hashes free text into a relationship. A revised-away criterion
text is suppressed from the active merge instead of lingering as a
discovered constraint. The silent `max_active_constraints` slice is gone:
every merged active constraint is normative.

### Prompt coverage

`PromptCoverage` on every `PromptArtifact` (schema 4) records the active
normative ids, the ids the included sections actually rendered, and any
omission with a reason. L0/L1/L2 now share one protected normative entry
set — criteria, hard/other active constraints, the active contract and all
its items, every active sub-goal (display caps keep ids via an id-only
overflow line), every verification finding, and the committed recovery
brief. Optional narrative sections never carry a normative id. A missing
id throws `ProjectionCoverageError`; the engine rethrows it instead of
turning it into `prompt: null`, and MCP returns the new non-retryable
`projection_incomplete` code. Prompt/state-file/guidance id sets now come
from the same partition and formatters.

### Repair-fact loop

`VerificationFlag.ref` is populated for command-triggered findings and is
rendered in the prompt, state file, receipt, guidance and explain. Contract
debt names every insufficient `rci-*`. The gate and the receipt use the
same `submittedFields` attempt basis: an omitted `files_changed` with Git-
observed changes is the same `evidence_integrity` mismatch in both. The
recovery brief now carries the restore HEAD and skipped file set inside the
artifact; the post-compile backtrack prefix (and its action advice) is gone,
so the delivered prompt equals `prompt_artifact.renderedPrompt`.

### Breaking boundaries

- `PROMPT_ARTIFACT_SCHEMA_VERSION` is `4`; schema-3 artifacts are legacy.
- `POLICY_SCHEMA_VERSION` is `"6"`; `evolution.max_active_constraints` is
  removed and `evolution.max_start_criteria` is added.
- No migration is provided.

## 3.9.3 (2026-10-19)

**The committed-fact prompt-level release.** 3.9.2 made the optional fields
visible and real-id-bound; the case data then showed a self-reinforcing L0
loop: an Agent changed files and ran commands, but reported no introspection
fields, so `hasNewInformation` stayed false, the next prompt dropped to L0,
and L0 hid the very triggers that would have produced future information. The
root cause was that prompt level, and much of the prompt's previous-round
content, came from a mutable caller projection (`last_round_result`) that
existed on the live path and vanished on resume/unpause/backtrack compiles.

### Prompt level from committed facts

`derivePromptFreshness` is a pure derivation over one `CommittedRoundView`:

- `machineMotion` reuses the ONE Git motion rule (now over every Git delta)
  and stays tri-state: `true` motion, `false` proven no-motion, `null`
  unobservable;
- `machineActivity` is an after-phase command with an attributable result
  (`passed`/`failed`/`timeout`/`aborted`/`error`, never `unavailable`);
- `declaredEvolution` is a committed semantic declaration the compiler
  already consumes.

`observableNewInformation` is false ONLY when the machine proves no activity
and nothing was declared. Unknown is never read as "nothing changed". The
failed-round downgrade now fires only for that proven-stale case; every other
new round is L1, and same-round retries remain L0. L2's fact-based reasons are
unchanged. `new_since_last_round` is no longer a level input.

One `PreviousRoundFacts` bundle now feeds the level policy, canonical state
(including `changesSinceLastRound`, discoveries, blockers, remaining criteria,
progress), and the evaluation block. The MCP request builder no longer carries
`last_round_result`; live, resume, unpause and backtrack compiles read the
same committed history. A caller projection remains the fallback only when no
committed view exists, and that path fails open to L1.

### One field interface at every level

`promptLevels` is gone. `compact` is the only marker of compact-checklist
membership, and `isFieldApplicable` is the one semantic rule, independent of
level. L0/L1/L2 now offer the same applicable trigger set (at most seven), so
L0 again shows `criterion_claims` with real `cr-` ids/text, `emerged_subtasks`,
`worker_results`, `compression_checkpoint`, and `prompt_requests`.
`round_contract`, `subgoal_updates` and `contract_item_claims` keep their
dedicated renderers and never duplicate into the compact list. Level still
controls state density, not which evaluation fields the Agent may use.
`prompt_requests` remains applicable in an L0 round; only a NEXT prompt that
is L0 ignores the incoming requests.

### Natural requirement contract guidance

With no active contract and a usable command, the proposal now uses the
current requirement as `work_item`, the first `remaining`/`unknown` criterion
as the item description and real `criterion_refs`, and the real command as
`verify_with`. It is still a proposal: LoopForge never auto-declares or
auto-activates a contract. The Agent decides whether the command is the
requirement's acceptance check.

### Deep-restore recovery

`pendingBacktrackRecord` matches a rollback directive by
`backtrack.target + 1 === redoRound` (with an exact-round fallback for legacy
records), so the recovery boundary AND the Recovery Brief work at every
`backtrack_max_depth`. The objective lookup and the constraint-retirement scan
are bounded by the compile window, so an abandoned branch cannot leak its
refinements or retractions into the redo prompt.

### Actionable committed findings

The `evidence_integrity` action now tells the Agent exactly how to fix a
reported-vs-observed files mismatch (add unreported, remove unconfirmed, list
the net boundary change). At L0, where the Verification Gate stays compact,
the evaluation block adds up to three deduplicated error/warn actions. The
receipt remains a read-only projection; the prompt reads the committed
verification flag, not the receipt.

### Public behavior changes

- A library/engine caller with no committed view and a failed
  `last_round_result` now stays L1 instead of downgrading to L0.
- `new_since_last_round` no longer influences prompt freshness; it still
  feeds `changesSinceLastRound`.
- `inFlightGitMotion` aggregates all Git providers: any motion wins, any
  undecidable provider makes the aggregate unknown, and only all-provider
  observed no-change is false.

### Envelope versions

No transaction, observation, prompt-artifact, receipt, or policy version
changes. The protocol schema's `$defs` count stays 64. Package version is
3.9.3.

## 3.9.2 (2026-10-18)

**The field-decision release.** 3.9.1 made the submission channel complete; the
case data showed agents still treated the optional fields as a catalog. This
release replaces the long optional-field list with a compact trigger checklist,
puts real criterion ids/text in front of the agent, and adds one structured
`files_changed` reconciliation to the receipt.

### Compact trigger checklist

The evaluation block now carries at most seven `trigger → field → effect`
lines. A field is shown only when its trigger is a real fact (criteria exist,
no active contract and a usable command, gate enabled) or a conditional
opportunity the agent can recognize after doing the work (a discovered
constraint, a falsified assumption, a new sub-problem, a delegation, a phase
boundary, a next-prompt need). The full legal shapes remain in
`submission_guidance`; the prompt no longer contains the 15-field form.

`isFieldApplicable` is the one semantic applicability rule. `isFieldPrompted`
is the level-aware presentation subset; both live in `submission-guidance.ts`.
`round_contract`, `contract_item_claims` and `subgoal_updates` keep their
dedicated renderers with real `rci-`/`sg-` ids; the active-contract block still
explains the successor path. L0 retries show only the retry findings and the
two introspection triggers (plus real criteria when a criterion finding is what
the retry is fixing).

### Real criterion references and lenient filtering

`criterion_claims` now uses the real `cr-` ids and text derived from
`criterion_statuses`; the old `<criterion text or cr id from the prompt>`
placeholder is gone. The compile response's full criterion set is also
available as `submission_guidance.criteria`.

A claim that cites a criterion the prompt did not render is dropped with a
diagnostic (`unknown_id`, or `all_entries_dropped` when none survive). This is
lenient, never a rejection. When the reference space is unobservable (no
compile response), the boundary fails open; an observed empty space drops every
claim. The display cap (three criteria plus `+N more`) never narrows validation.

### Structured `files_changed` reconciliation

`submission_receipt.files_reconciliation` compares the agent report with the
shared `ObservationDelta.changedFiles` using one derivation:
`status` (`match` / `mismatch` / `unknown` / `not_applicable`), `attempted`,
`reported`, `observed`, `unreported`, `unconfirmed`, and the machine scope.
`reportedFilesMatch` is removed — it was dead output and encoded a second
comparison rule. The `evidence_integrity` warning now reads the same helper and
fires only on `mismatch`; duplicates collapse for the status, an omitted report
with observed changes is a mismatch, and unknown Git stays unknown. Paths are
exact strings: no separator, `./`, case, or Unicode normalization is applied.

### Metrics

`filesChangedRounds` / `filesChangedTotal` now use the union Git state instead
of the first Git delta. A new `filesReconciliation` record counts each status
from the same committed-round view; nothing is persisted or fed back into a
later prompt.

### Envelope versions

No transaction, observation, prompt-artifact, or policy version changes. The
receipt is a returned projection, not persisted. The generated protocol schema
gains `FilesReconciliation` (`$defs` 63 → 64). Package version is 3.9.2.

## 3.9.1 (2026-10-18)

**The submission-channel release.** The evaluation fields stop being a form to
fill and become a closed channel: the runtime says which fields apply now, what
happened to each submitted value, which derived state actually changed, and
what the machine verified. `files_changed` gets one boundary definition, and a
worker's discovery stops becoming a global constraint without the main agent
saying so.

### One field guide, real examples, no phantom ids

`submission-guidance.ts` is now the single source for every evaluation field's
meaning, applicable event, legal example and downstream effect. The tool
schema, the round prompt and `submission_guidance` all read it.

The prompt's base template is only the four required fields. Optional fields
are shown as separate, legal snippets, and only when the current facts make
them usable. An active contract renders its REAL `rci-` ids, statuses and bound
commands; continuing it no longer requires restating it, and a different
proposal is surfaced as `contract_premature`. With no active contract and a
usable command, a first declaration example appears with the real command name;
with no usable command, the prompt says the contract cannot be machine-verified
instead of inviting one. Sub-goal examples use real active `sg-` ids. The old
`done_when` / `verification_plan` template — which the parser rejected — is
gone.

### `submission_guidance` and `submission_receipt`

Every prepared response (`start`, `next`, `resume`, `status`) carries
`submission_guidance`: active contract items/statuses, active sub-goals, usable
commands, recovery facts, findings from a retry, and the fields applicable at
this submission point. It is derived from current facts and never persisted.

Every `loopforge_next` submission returns `submission_receipt`, which keeps
three facts separate:

- **reports** — saved, saved-but-not-expanded, dropped, truncated, normalized,
  or `not_applied` for a rejected/terminated attempt;
- **effects** — contract activation/closure, sub-goal creation/update,
  constraints declared/retracted/active-after, checkpoints, rollback facts;
- **verification** — contract-item posture, round-level machine evidence
  posture, checks and item statuses.

A saved report is never displayed as verified, and a rejected attempt never
shows an applied effect. A backtrack reports only the discoveries and
assumptions it actually preserves. Lost-response replay rebuilds the receipt
from the committed transaction; it is not a second ledger.

### Diagnostics instead of silent drops

Optional fields are normalized through `normalizeSelfEvaluation`, which returns
a stable list of diagnostics: path, reason code, handling and correction. A
retired field such as `progress_estimate` is reported as an unknown field and
dropped instead of looking accepted. Strict core/structural failures remain
pre-persistence and are retryable with the same round id; their details now
carry the same diagnostic vocabulary. Unknown optional evaluation keys reach
the runtime (the transport no longer rejects them first), so the normalizer,
not the JSON-RPC schema, owns the drop.

### Field accounting: attempted vs retained

`submittedFields` now means exactly what it says: the known paths that appeared
in the raw payload. Whether a value survived normalization is a separate,
read-time derivation (`deriveFieldAccounting`) over the already-persisted
manifest, diagnostics and normalized evaluation. No new persisted field, no
second ledger, and no re-parse of the raw payload.

The metrics split the old ambiguous `fieldUsage` into `attemptedFieldUsage` and
`retainedFieldUsage`, with `fieldAccountingRounds` / `fieldAccountingIncompleteRounds`
making coverage explicit. A committed round always carries its manifest; a
missing manifest is not a supported shape. The receipt labels a partial array
loss as retained-with-detail instead of downgrading the whole field to
`dropped`. `all_entries_dropped` and `empty_value` close the remaining silent
losses, so the accounting invariant — attempted implies retained or an
exact-path whole-field drop — is testable for every field.

### Worker findings are reports

`worker_results.discoveredConstraints` is no longer merged into the global
constraint stream in either the runtime or the compiler request. The worker
report and delegation journal are preserved; the main agent promotes a finding
by submitting it in top-level `discovered_constraints`.

### `files_changed` is a boundary net change

The Git provider now enumerates every tracked path and every non-ignored
untracked path at both boundaries and fingerprints the actual workspace
content (regular file, symlink link text, gitlink index commit, directory,
missing, unreadable) with bounded streaming concurrency. The round delta is the
union-key comparison of those two maps, so committed work, deletions, renames
and `--amend` are seen without consulting the last commit. The dirty list is
display-only. Unavailable/timeout/error/aborted captures are explicit
observation statuses and fail open; they are never an empty diff or a reason to
blame the agent. Gitignored paths are outside the declared coverage, while the
filesystem entrypoint-trust baseline still covers entrypoints independently.

`execution_report.files_changed` is defined against that same boundary: paths
whose content or type differs between round preparation and submission,
including deletions; a commit alone adds no entry when content is unchanged.
The round document no longer stores a second copy of the transaction or prompt
artifact; the feedback entry is the one persisted copy.

### One delta type; unknown is not empty

`MachineObservation.files` is now documented and used only as observation-local
display data: Git's dirty list, a command's empty list, or a custom provider's
metadata. The round change set lives on the derived `ObservationDelta.changedFiles`
and nowhere else. The old copy-and-overwrite helpers are removed; `before` and
`after` are raw observation references and are never mutated.

`[]` means an observed no-change; `null` means the change set is unknown. A
missing before boundary, a failed capture, an unreadable fingerprint map or an
ambiguous duplicate is null — never the after dirty list. The Git state is
three-valued: no Git provider is `not_applicable`, an unobservable pair is
`unknown`, and a passed command is not machine-backed under `unknown`. Contract
items become `insufficient` in that case; command-only rounds remain
`not_applicable` and can still verify. Stall motion is likewise tri-state: HEAD
movement can prove motion, but unknown files with no HEAD evidence produce no
verdict. `evidenceIncomplete` is true for a no-baseline Git round.

Historical explain/audit/replay/metrics views are re-derived under these rules.
The delta is still never persisted, and no envelope version changes for it.

### A success report gap is not an acceptance gate

`success=true` with a missing/empty `execution_report` is now a warning, not an
error. Acceptance is decided by machine evidence and contract rules, not by how
many optional fields were filled. The machine-evidence arm still keeps an
unbacked success out of the success trajectory, and the R8 enforcement row —
whose only trigger was the removed error arm — is deleted with its tests.

### Envelope versions

`ROUND_TRANSACTION_SCHEMA_VERSION` moves 2 → 3 together with Git observation
schema 2; `PROMPT_ARTIFACT_SCHEMA_VERSION` moves 2 → 3 with the prompt-request
effects. Old transaction, observation and artifact versions are not parsed or
migrated; audit/replay report them as legacy, and upgrade acceptance uses a new
session. Policy schema remains 5: no policy key or switch changed.

The field-accounting and delta changes add no envelope bump: the attempted
manifest already exists in transaction schema 3, and the delta is derived and
never persisted. There is no compatibility shim for a committed transaction
without a manifest.

## 3.9.0 (2026-10-14)

**The machine-only verdict release.** Progress is judged by what the machine
observed and nothing else. One self-report field is removed, the stall detector
learns to see committed work, and the post-backtrack restore check stops
demanding a globally clean tree.

### `progress_estimate` is gone

The field asked the agent to grade its own progress, and the runtime consulted
that grade in the stall evaluator's fallback tier. A verdict about machine
motion that the agent's own report could move is the one thing an external
verifier must not allow, and the number never carried information the machine
observations did not: a loop with no readable Git history has no honest basis
for a stall verdict at all. Removed from `ExecutionReport`, the MCP tool
schema, the prompt template, the canonical state, and the milestone summary
(`progress_at_boundary` — a milestone renders its round range, not a
percentage); `entryProgressEstimate` and the whole self-reported window are
deleted. An evaluation that still sends the key is accepted, and the key is
dropped: unknown optional fields are ignored, exactly as before.

`evolution.progress_stall_threshold` goes with it — its last consumer was the
removed tier. The policy schema version moves 4 → 5, so a file written for the
old surface reports an outdated schema instead of a stray key.

### Committed work is motion

Motion was read from the round's file delta alone. In the commit-per-slice
workflow — and LoopForge's own guidance tells the agent to commit each slice —
every worktree is clean at the round boundary, so three rounds of real,
committed progress read as three rounds of nothing: `progress_stall`, then a
backtrack, then termination. The false verdict was systemic, not model-specific:
any agent obeying the workflow hit it.

`gitMotionSignal` is now the one definition of machine motion — a non-empty
file delta, a Git HEAD that moved across the round, or a HEAD that landed back
on a rollback's restore point — and it is read by both the committed series and
the submitted round. A window that cannot be observed (a round with no observed
Git snapshot) yields no verdict, never a stall by default. The submitted
round's own motion is now part of the judgement too, which is what lets a redo
that fixed its approach clear a window that legitimately stalled before the
rollback, while a redo that moved nothing still reaches the deadlock guard and
terminates.

### Restoring a workspace no longer means a clean tree

The post-backtrack check required HEAD equality *and* an empty working tree. Any
unrelated work in progress — a developer's own edits, another task's files —
made a correctly restored workspace read as unrestored, and because a rollback
had already committed for that round, the loop terminated. A workspace with
HEAD exactly at the restore commit was killed by files that had nothing to do
with the loop.

The restore point now carries its own machine snapshot: its HEAD and the files
already dirty there. Restoration is the same HEAD with no dirty file the
restore point did not already have, so unrelated work is tolerated and a file
the failed rounds left behind is still caught — even when the HEAD matches. An
absent baseline (a session from before this release) degrades to HEAD equality
rather than to an empty baseline. The first post-rollback submission is a
recovery checkpoint, stated as such in the Recovery Brief: prove the restore,
then redo, and the redo may commit freely.

### The round prompt's fixed footer is smaller

The per-round footer carried evaluation rules and rejection guidance that the
Perception skill states once, word for word, for every round. It now carries
only what is specific to this round: execute, submit, read the current `roundId`
from the latest response (a rejection keeps it), and the JSON template, which
stays because its fields genuinely vary per round and per active contract.
Prompt budgets were re-measured; no section that used to render is now dropped
because of this.

## 3.8.3 (2026-09-17)

**The unobstructed-path release.** Three dead ends removed, one opening closed,
and the configuration surface made legible. No new persistence, no new source
of truth: every change either completes a route the runtime already told the
agent to take, or stops the runtime from describing a state it is not in.

### Scope drift has the exit it always advertised (completing a half-fix)

`enforceScopeDrift`'s instructions were rewritten in v3.7 after the old advice
— "extend the scope in your re-declared round_contract" — was found to be
structurally unreachable (a replacement proposal is ignored while the contract
is open). The replacement text told the agent to resubmit with
`outcome: "blocked"` plus the extended scope as the next contract. **That route
was never implemented**, so the new guidance was as unreachable as the old one:
the same `round_scope_drift` check kept rejecting, the streak accumulated, and
the third occurrence terminated.

A blocked round whose proposal's `scope` covers **every** file the round
changed out of scope now passes that row. What is waived is the rejection,
never the fact — `round_scope_drift` still lands on the committed round, so
audit, explain and replay report it. The coverage set is derived by
`roundDriftFiles()`, shared with the drift check itself; it is never read from
the flag's `detail`, which truncates its file list at five and would have let a
partial expansion through. The waiver is evaluated above the terminate arm
(previously a streak of two killed the round before any waiver could be
consulted), and the rejection-counter catch-all stands aside for a waived
round — it exists for a round that looks clean while the counter says
otherwise, which is not this shape. Ordinary drift still rejects, and no
explanation channel was added.

The route is narrow on purpose: contract debt, machine stalls, and an
unrestored post-backtrack workspace still apply to the same round.

### A rewritten verification entrypoint is a dead end no longer

The check compared the entrypoint against the round's git change set. Two
consequences, both wrong:

- A **created** entrypoint stayed in that set for every retry — the round's
  baseline is deliberately frozen — so "keep the entrypoint unchanged" was not
  an instruction the agent could carry out, and the loop retried until the
  uniform ladder terminated it.
- An entrypoint git cannot see (**gitignored**) is in no git diff at all, so a
  script rewritten this round read as untouched.

The entrypoint's state is now captured from the **filesystem** when the round is
prepared (never when tampering is detected — a baseline written at detection
time could never catch its own first occurrence) and compared absolutely:
current content against round-start content, unioned with the unchanged git
arm. It is stored in the session state entry, read back leniently, seeded only
for a round being prepared, and never enters committed round history; a corrupt
or absent value drops the absolute arm rather than the round.

Recovery is stated in the terms the round can actually satisfy, using the
round-start state of each file: restore it, or — when it did not exist at round
start — leave it in place and let a later round run it. Repeated
non-restoration **backtracks** instead of terminating (this row now owns its
escalation ladder, like the progress-stall row), so the work is redone in a
round whose baseline already contains the entrypoint. Committing the script
mid-round does not launder it: the comparison is against content, not against
whether the file left the change set.

### A first occurrence is no longer treated as a repeat

The persisted rejection counter is one scalar. The L4 rule — a row escalates on
its **own** streak — had been applied only to the uniform rows and the contract
row, so `success_without_verified_evidence`, `round_scope_drift` and
`progress_stall` still read the raw counter: a first-ever occurrence arriving
after two unrelated rejections terminated the loop instead of rejecting it.
Those three rows now use their own streak, matching the rule the code's own
comments describe. The `max_rejections` row keeps the shared counter — that is
what it is for.

### Blocked can never be reported as completed

The stop decision already ordered the blocked declaration first. It is now also
a guard, `finalizeStopReason`, applied where the reason becomes durable (in the
coordinator, before the transaction commits — the committed round document
carries `result.stopReason`) and again where it becomes client-visible. A
violation can only be a code defect, so the guard degrades to `blocked` and
reports the downgrade as a flag rather than throwing mid-lifecycle. "This round
declares itself blocked" is now one function (`declaresBlocked`), read by both
the stop decision and the scope-drift waiver.

Also fixed: `buildTerminationResult` and the crash-recovery path hard-coded
`enforcement_terminated`, discarding the `incomplete` the contract-debt row
sets. The specific reason reached neither observability nor the client.

### An orphaned store lock no longer outlives its owner

The lock's wait budget was 1s while the dead-owner reclaim required the lock to
be older than 5s (Windows EPERM: 10s) — so a restart within five seconds of a
crash **could not** reclaim it and failed with `LoopStore lock timeout`. The
retry loop also spun without sleeping, burning CPU for that full second.

The three staleness thresholds are now named separately with their reasons
(they are three different rules, not one constant repeated), the dead-owner
grace is small enough to be reachable inside the budget, and attempts sleep
between retries. The budget stays far below the Windows case on purpose: it
blocks the whole single-threaded server, so a lock held by a **live** process
must fail fast rather than hang.

### A broken policy file is no longer a silent one

`loadPolicy`'s bare `catch` could not tell "no file" from "EACCES" from "not
JSON", so a mistyped or half-written `loop_policy.json` ran the loop on the
defaults while the operator believed their configuration was in force —
exactly the outcome the v3.8.1 version boundary exists to prevent. A missing
file still falls through to the defaults; a file that exists but is unreadable,
unparseable, or not an object now throws with the stable `policy_invalid` code
and its path. The CLI reports that code at the `mcp` startup boundary with a
`doctor` pointer instead of a bare message.

### `--target` means one thing, and the workspace is named

`--target` was a shared root for two different layouts: the skill went to
`<target>/perception/SKILL.md` and the policy to `<target>/loop_policy.json`.
It also never influenced the **reader** — the runtime only ever read the
workspace it was started in — so `init --target DIR` wrote a policy the runtime
would not use.

`--target` now selects the client skill location only. `--workspace DIR` names
the runtime boundary: `loop_policy.json`, `.loopforge/`, evidence commands, and
every workspace check resolve against it. `loopforge mcp --workspace DIR`
switches directory before the server reads its policy or resolves its store
root, which is why it must happen before the server is constructed. `init`
prints the skill path, the policy path, and the command that starts the server
against that workspace.

Two smaller frictions went with it: a flag with no value was indistinguishable
from an absent flag (`init --client generic --target` silently wrote the policy
to the current directory), and an unknown option was silently ignored, so a
typo behaved exactly like the flag was never passed.

### Configuration is discoverable from both ends

`doctor` now states the **evidence posture** in the same words the round
prompts and MCP responses use — one derivation
(`deriveEvidenceCapability`), so it cannot describe a capability the runtime
does not have — and every failing check carries the next step, not only the
defect. The Perception skill gained the piece it was missing entirely: where
`evidence.commands` lives, what each field means, that commands are spawned
without a shell inside the workspace, that `loopforge doctor` checks them
statically, how to read the `capability` object a prepared round returns, and
that a command's entrypoint must already exist when the round starts.

## 3.8.1 (2026-09-11)

**The convergence release.** 3.8.0 established the boundaries — one factual
source, one cognitive source, a claim/observation/verification split. 3.8.1
removes what grew on top of them: a single data flow that still had several
parallel ways to say the same thing. Nothing is added. Across `src/` this is
2,169 lines in and 2,931 out (1,365 in / 1,727 out excluding `src/tests`). No
compatibility is carried: the protocol field set, the policy schema and both
versioned envelopes are this version's.

### Text similarity is gone

`jaccardSimilarity`, `tokenize`, `isCjkCodePoint` and all seven similarity
thresholds (`criteria_dedup_threshold`, `subgoal_dedup_threshold`,
`subgoal_match_threshold`, `constraint_match_threshold`,
`task_continuity_threshold`, `progress_mismatch_threshold`,
`confusion_section_threshold`) are deleted. Relationships are established by a
stable id, explicit refs, normalized-exact text, or a content hash — never by a
score.

The honest accounting: **no verification check was ever driven by Jaccard**,
and of the eleven enforcement rows exactly one (`round_scope_drift`) is
matching-driven — and that is path containment, not text similarity. So this is
not a bug fix in the gates. What it removes is the *concept*: a score that
could stand in for an identity, plus the policy surface that made it
configurable.

- `criteriaMatch`, `matchesConstraintText`, `matchEmphasize`: id, then
  normalized-exact. A paraphrase is a different thing.
- `CriterionStatus.related_subgoal_ids` reads the Contract item's explicit
  `subgoal_refs` — a criterion is never linked to a sub-goal it merely
  resembles.
- `possibleDuplicateSubGoals` (a cross-round near-duplicate warning that never
  reached the prompt) becomes `duplicateEmergedDeclarations`: the same-round
  EXACT repeats that `deriveEmergedItems` really did drop, reported as
  `duplicate_declaration`. Those entries genuinely were discarded; saying so is
  a fact, not a guess.
- `confusion_points` keeps its section, cap and 200-char truncation; the
  eight-keyword similarity scoring that picked a state-file section is gone.
  It was nearly always wrong anyway — "I don't understand milestone tracking"
  scores 0.125 against the keyword `milestone`, below the 0.15 default.
- Dead `contractItemMatches` (zero callers) deleted.

### The presentation layer stopped being an input

`PresentedStateSnapshot` — persisted onto the vault lineage entry as
`presented_constraint_ids` / `presented_subgoals` /
`presented_milestone_ranges` — existed so the NEXT L1 prompt could fold
unchanged content into "… N unchanged (see state file)" pointer lines. Those
pointer lines entered the prompt text, so `promptHash` depended on what the
previous prompt had happened to show. Deleted, along with `readPresentedBaseline`,
`diffConstraints`, `diffSubGoals`, `milestoneBoundaryChanged`, `l1_collapse_enabled`,
and the four `l2_adaptive_*` knobs (a budget that scaled with round count is a
prompt whose allowed content depends on how long the loop has been running).

Both the presentation snapshot and the adaptive budget are gone; `l2_pointer_enabled`
stays. The one fact the folded branch carried that a plain list does not —
"(violated this round)" — moved to the full render, so it was not lost with the
mechanism that happened to host it.

### Diagnostics left the prompt; the valueless ones were deleted

Trust score and trend are **deleted outright**, not moved. The score was
`1 - errors*0.15 - warns*0.03` — arbitrary weights re-encoding flag counts that
are already visible. The trend was worse: `1 - violations*0.1` per round, from
`constraint_violations`, i.e. a DIFFERENT source from the score it was
displayed beside. "Trend" was never that score's history.

`buildRoadmap` is deleted; its only non-duplicated fact — position and distance
to the next boundary — survives as a one-line phase. The other three lines
(met/remaining criteria with ids, sub-goal activity) were already rendered by
the sections that own them. `LoopHealth` and `TaskAlignment` are deleted with
it: every field was a similarity verdict, and two were degenerate in the
view that reported them (`task_continuity` was pinned to 1.0 because the
request was built with `round: 1`; `strategy_stability` was a literal `true`).

The L2 Progress Dashboard and Round Stats sections are deleted — they
re-composed `criterionStatuses` into a table and mixed in the agent's OWN
completion estimate and test counts. The criterion list and the machine
git/criteria rows still render in the state file.

`roundStats` turned out to be **dead data that participated in `stateHash`**:
its only reader was the L2 section being deleted, and the state file never
rendered it. Deleted rather than given a new renderer.

### One recurring-fact derivation, two windows

`deriveLessons` (whole history, count >= 2), `rolling_summary.recurring_issues`
(the last 5 rounds' raw violation texts, with NO threshold at all despite the
name) and the prompt sections built on each were three windows over one fact
set. `deriveRecurringFlags(committedRounds)` is now the single derivation
(`{subject, kind, ref, count, rounds}`, no threshold — the threshold belongs to
the renderer). The state file shows the genuinely recurring set
(`## Recurring Flags`, rounds >= 2); the prompt shows the recent tail
(`## Active Warnings`, last 3 committed rounds, <= 5 lines, each carrying the
check, the id it was about, the count and the latest round). L1 and L2 call the
same function, so the two levels cannot describe "what is going wrong right
now" differently.

A side effect worth naming: the derivation takes `CommittedRoundView[]`, while
the old one fell back to reading raw entry fields. The "a delegation journal
must not double-count a violation" regression therefore stopped being a
behavioural invariant and became a structural one.

### Fixed priority, a protected set, and deterministic truncation

`renderWithinBudget` was greedy first-fit in declaration order: mandatory
sections joined unconditionally, optional ones appended while they fit,
otherwise dropped whole and silently. A single large early section could push
out every later one.

`SECTION_PRIORITY` (one table, in `prompt-assembler.ts`) fixes the order.
Section order is a property of the section, not of policy: a budget knob must
not be able to change which facts count as more important. The protected set
(objective, current task, hard constraints, verification flags, the rejection's
required fix, critical context) is never dropped or truncated. Everything else
is cut **strictly lowest-priority-first** — greedy first-fit is explicitly NOT
the rule, because it can render a small low-priority section into room a larger
high-priority one could not use, so "Blockers" could be missing while "Phase"
is present. At most one optional section may be rendered partially, cut at a
line boundary. When the protected set alone exceeds the budget the prompt is
rendered anyway and `protectedOverflow` is set: an over-budget prompt is
recorded, never silently produced.

`PromptArtifact` is schema 2 and records what THIS prompt did: `round`,
`sections`, `droppedSections`, `protectedOverflow`, `budget`, `renderedChars`.
It records nothing about what a later prompt should do.

### The policy version became load-bearing

`LoopPolicy.version` was read by NOTHING. A config written for an older schema
was silently merged over the current defaults — options that no longer existed
evaporated and options that had changed meaning were applied under their old
name. Now `loadPolicy` rejects a file whose version is not the current schema
version (4), and an unknown key is an ERROR rather than a warning (a typo used
to be announced and then ignored, so the loop ran on a value the operator never
set). A missing file still falls back to the defaults; a file that exists and
parses is a declaration, so its defects propagate as `policy_invalid` instead
of being swallowed by the candidate loop.

### Two hard breaks, both reported

The transaction schema (2) and the PromptArtifact schema (2) are both versioned
envelopes, and both are HARD breaks: a round whose envelope does not parse is
not history. `legacyTransactionRounds()` now reports which envelope rejected
each round — reporting only the transaction version would let an
artifact-version break delete committed history silently, which is the one
outcome that function exists to prevent.

### Deleted as dead

`suggestedNextTask` (written into the canonical state and the response, read by
nothing), `health_check_interval` (a protocol field parsed and passed through,
never read), `full_refresh_interval` together with the `periodic_refresh` level
reason (a switch whose default 0 disabled its own branch), `contract_nudge_on_l2`,
`state_drift`'s branch, `ActiveRoundContract` and `ActiveContractItem` in
`protocol.ts` (duplicate declarations of the runtime's `ActiveContractView`;
the wire schema described a type the runtime never used while the type it did
use was absent from the contract), the unused imports in `enforcement-gate.ts`,
and `constraint_id_enabled` — which never switched the matching strategy, only
whether ids RENDERED, so turning it off could only produce a prompt whose items
the agent could not name.

The per-rule rejection counter (same check accumulates, a different check
resets to 1) was two byte-identical copies, in the live advance path and the
crash replay. One implementation now, so the two paths cannot drift.

### Verification-debt and recovery semantics: unchanged

This release does not touch the contract item model, the strict
`contract_invalid` boundary, the closure rules, `MachineObservation`, the
verification/enforcement split, round identity, leases, crash recovery, or the
backtrack directives. The backtrack prompt still states restore FACTS and never
prescribes a git command — the agent owns the restore, the gate owns the check.

### The submission boundary moved into the runtime

`SessionManager` is exported from `index.ts`; `RoundLifecycle` is not. The five
strict submission checks lived in the MCP tool handler, so "strict" was a
property of one transport — a library caller, a future CLI command, or any
direct `mgr.advance()` got none of it. A partial copy of two of them (the
object check and the core-field validation) sat in the session manager too, so
one rule had three homes across two layers.

All five now live in `mcp/submission-boundary.ts` and are applied by
`SessionManager.advance`, before its session queue and before its lease
heartbeat. The handler only maps the result onto its tool envelope.

Two orderings are part of the contract, and both are why the boundary sits
where it does. **Before the session is resolved**: a malformed evaluation is a
payload defect whatever the session's state, and answering `session_not_found`
for it would send the agent after the wrong problem — the reference spaces that
need a session fail open when there is none. **Before the queue and the lease
heartbeat**: renewing a lease writes the session document, so a payload that is
never accepted must not reach it. That second ordering is what makes AGENTS.md's
"changes nothing durable" literally true rather than nearly true, and it is why
the heartbeat did *not* simply move into the lifecycle: `RoundLifecycle.advance`
has direct callers that hold no lease, and a heartbeat there would have fenced
them out.

Each reference space is null — fail open, shape checks still strict — when it
cannot be observed. An unobserved session is not the same as a session with no
active contract: the latter is an observed EMPTY space, and an item claim in it
is false. `activeContractOf` and `compileSessionContext` moved into the new
module so the session's own `getActiveContract` and `getProjection` share the
boundary's derivation rather than keeping a second one.

The visible consequence: a contract item binding a command that is not
configured is now rejected on EVERY advance, not just through the MCP handler.
One existing test had been passing `verify_with: ["run-tests"]` against a policy
that configures `verify` — it had only ever been exercise-able because the
direct-`mgr.advance` path skipped the check. That fixture now names a real
command, and two new tests lock the invariant itself: a direct `advance` with an
unconfigured command returns `contract_invalid`, and a payload defect is
reported before the session is resolved.

### Test suite

Sixteen test files changed. Tests that existed only to pin a deleted mechanism
were deleted rather than adapted (the L1 collapse blocks, the tokenizer and
Jaccard suites, `possibleDuplicateSubGoals`, `state_drift`, the
`constraint_id_enabled` kill switch, the `LoopHealth`/`TaskAlignment` schema
cases, the `contract_nudge_on_l2` kill switch, the periodic-refresh level
cases). New invariants were added for what replaced them: normalized-exact
identity (a paraphrase must compare unequal), same-round declaration
duplicates, recurring flags counted once per occurrence, the two render windows
over one list, the milestone history cap applied identically at every level,
and the budget rules — protected content survives a crushing ceiling,
`protectedOverflow` is recorded, every rendered optional section outranks every
dropped one, and identical input yields an identical prompt and artifact.

### Residual gaps closed before release

A review of this branch found thirteen defects that the convergence story
above does not cover. Each one is fixed with a regression test that was run
against the previous code first (every test below fails without its fix):

- **A contract item cannot close on stale evidence.** `verified` means "every
  bound command observed passing in the CLOSING round"; the reducer read the
  EARLIEST observation at or after the claim, so a round whose bound command
  FAILED kept the item `verified`, closed the contract, and could reach
  `completed`.
- **The binding reaches the compile path.** `decodeMergedRound` read
  `lineage.contract_binding`, which nothing wrote — so the compile-side "same
  configuration as at declaration" check never ran, and the prompt and state
  file could call a contract closed while the coordinator, explain and audit
  called it open and insufficient.
- **An entrypoint tamper is found behind a test-file warning.** The check
  answered with the warn on the first after-phase command in array order, and
  `testFilesModified` comes from the git file set alone — so a rewritten
  verification entrypoint often produced no error at all and the enforcement
  row that reacts to it never fired. The verdict depended on observation order.
- **`audit` reads the shared window.** It scanned raw entries with its own,
  weaker rule: a superseded record was listed twice and could flip the verdict
  to `contradicted` for something that is not committed history.
- **Read-only views honour the rollback frontier.** `audit`, `explain`, the
  projection, `replay`, the metrics replay and the verified-claim view applied
  no bound, so after a backtrack they reported the abandoned branch as this
  branch's history and contradicted the prompt.
- **The runtime's own state directory is not machine-observed work.** The
  vault lives inside the workspace by default, so every round's bookkeeping
  writes read as git motion — the signal the stall evaluator and the restore
  checks consume.
- **Progress enforcement is machine-first.** When the git series is observable
  it decides alone; the agent's `progress_estimate` series is the fallback for
  a loop with no machine history to read. A rising self-report can no longer
  cancel a machine stall. A machine-verified round is exempt — it is the loop
  finishing, not churning.
- **Policy v4 rejects what it says it rejects.** `Object.hasOwn` instead of
  `in` (a `__proto__` / `constructor` key was merged as if the schema declared
  it), and array entries are key-checked — `"enable"` for `"enabled"` is now a
  load error instead of a command that silently never registers.
- **The lenient/structural split holds.** A non-string `subgoal_updates.note`
  no longer rejects the whole submission (protocol.ts calls it lenient), and
  the emerged list is bounded by ONE normalization, so the boundary can no
  longer accept a sub-goal transition the compiled prompt never carried.
- **Criterion machine facts survive their contract closing.** The state file's
  Goal → Criteria row fell back to the agent's claim the moment the contract
  fully verified; the fact now comes from the same history walk as the verified
  sub-goals.
- **Verification debt escalates on its own streak.** The row declared a
  `uniform` ladder while its handler ran one too: the escalation notice was
  appended twice, the uniform terminate branch was dead, and a streak earned by
  a DIFFERENT check could terminate this row on its first appearance.
- **`doctor` reports a policy defect instead of dying on it.** Loading the
  policy ran first and threw, so `doctor --json` produced no report for exactly
  the defect the README says it checks.
- **The published JSON Schema is faithful to the protocol.** `extends` was
  ignored (every concrete observation lost the seven fields the base declares,
  and the base was referenced by nothing), inline object types were published
  as strings (the projection payload, the reported test counts), and
  `typeof CONST` was published as a string — a client generated from the schema
  would serialize the envelope version as a String and have every round
  hard-broken. The converter no longer guesses: a node JSON cannot express is
  recorded as an omission, and any other unhandled node kind fails the build.
- **`package.json` is an entrypoint only where it defines what runs.** It was
  added unconditionally to every command's entrypoint set, so a round that
  touched it — for any reason, with any command — was reported as "the
  verification entrypoint changed" and rejected, however unrelated the file was
  to what executed (`node -e …` never reads it). It is a candidate now only for
  a package-manager invocation, which is exactly the case where editing it
  changes the harness.

Alongside: dead code deleted — `deriveActiveContract` (a second
active-contract implementation with zero callers), `makeSubGoalUpdate`,
`contractSubGoalIds`, the unread `PreparedRound.capability`, and 37 unused
declarations across `src/` — and the prose corrected where it had drifted from
the code (the enforcement table's action classes, the `emphasize` matching
rule, `doctor`'s check list, `max_confusion_points`' level scope, the
`ObservationStatus` provenance, and the artifact's measured budget region).

908 tests.

## 3.8.0 (2026-09-10)

The verification-boundary version. The two sources are untouched — the Vault's
committed round documents remain the only factual source, `CanonicalLoopState`
the only cognitive source — but the boundary now separates four states
explicitly: **the agent claims it / the machine observed nothing / the machine
verified it / the machine contradicted it.** No compatibility is carried: the
protocol field set is this version's field set, and a schema-1 transaction is
not history (see below).

**The agent's report stopped being called evidence.** `ExecutionEvidence` →
`ExecutionReport` (field `execution_evidence` → `execution_report`). Its fields
are now claims: `criterion_claims: [{criterion_id, outcome}]` and
`contract_item_claims: [{item_id, outcome: "met" | "remaining"}]`. The old
`success_criteria_met` / `success_criteria_remaining` string arrays are
deleted. No claim can create a verified fact.

**Round Contract is an item model.** A proposal declares
`items: [{description, criterion_refs, verify_with}]`; every item must bind at
least one configured, enabled evidence command. The runtime derives a stable
`rci-XXXXXXXX` per item and an `rc-XXXXXXXX` per contract **from content only**
(loopId + canonicalized proposal — never the declaring round), so restating a
contract unchanged keeps its identity and the item ids the agent already cited.
A SubGoal is the deliberate opposite: its `sg-` id includes the declaration
round, because re-declaring a sub-goal is a new declaration event.

**Closure is machine-derived.** Item statuses `pending | insufficient |
contradicted | verified` are computed by the runtime. `verified` requires the
agent to have claimed `met` *and* every bound command to have been observed
passing in the closing round — after-phase, entrypoint untampered, and with the
command configuration recorded at declaration time (the commit stamps a
`ContractBinding`, because policy is not part of the Vault). Claimed-but-unbacked
is `insufficient` and **the round still commits**: the debt is surfaced instead
of rejected. The contract closes when every item is `verified`, or when a round
reports `outcome: "blocked"`. Because closure is derived, a premature closure is
structurally impossible — `premature_boundary` and
`contract_completion_unverified` are deleted along with their enforcement rows.

**Strict vs lenient, stated once.** STRICT — `contract_invalid`, same-roundId
retry, zero state change: a contract with no items, an item with no
`verify_with`, an unknown or disabled command id, malformed `subgoal_refs`,
malformed/duplicate/unknown `contract_item_claims`. LENIENT — dropped with a
warning, never a rejection: `criterion_claims` with unknown or malformed ids.
The criterion layer is advisory; the contract item layer is the verification
skeleton.

**Machine observations replaced provider snapshots.** Providers emit
`MachineObservation` with `status: observed | passed | failed | timeout |
unavailable | error | aborted`. A configured provider now ALWAYS produces an
observation — unavailability, timeouts, errors and aborts are recorded in the
round's factual record instead of being silently filtered out. Command
observations carry argv, cwd, configHash, exit code, signal, duration,
full-stream `stdoutSha256` / `stderrSha256` (the hash covers the whole stream,
never the truncated excerpt), capped excerpts, and `entrypointFiles`. The two
divergent "machine-backed" predicates (the gate excluded entrypoint-tampered
commands, `evidence-claims` did not) converged into one
`isPassedAfterObservation`.

**Transaction schema 2 — derived data is no longer persisted.** The snapshot
stores only the before/after observation collections; the round delta is
`deriveRoundObservationDelta(before, after)`, consumed by every reader
(gates, git-motion series, metrics, replay, audit). A schema-1 envelope is a
HARD break — the round is not history — and the loss is explicit:
`legacyTransactionRounds()` lists those rounds in the audit rather than letting
the loop look complete while rounds are missing. Committed rounds expose
`evidenceIncomplete` when they carry no after-phase observations; the before
baseline is never substituted for them.

**EvidenceCapability, split so it can be hashed.** `ConfiguredCapability` is a
pure function of policy (providers, enabled commands, per-command config hashes)
and feeds `stateHash`/`promptHash`, so it is byte-identical across retries of a
round and reproducible by replay. `ObservedCapability` carries live statuses and
is rendered only — never hashed. Provider registration is code state and is
deliberately excluded from the hashed half; runtime readiness is a `doctor`
concern. Adding capability to the canonical state changes every `stateHash`
once — a one-time, intentional change.

**Verification debt is bounded.** `insufficient` items do not reject a round,
but they cannot accumulate forever: once the debt persists for
`engine.unverified_claim_streak_limit` consecutive committed rounds (default 3)
the enforcement gate rejects with instructions, and terminates as `incomplete`
on the next same-check strike. The streak is derived from committed round flags,
so an agent self-report cannot move it and git motion does not excuse it —
churning code without verifying is exactly what this row catches. A stop with
the active contract still unverified now reports `incomplete`, never
`completed`, and an unverified success stays out of the success trajectory.

**Sub-goals replay from the shared read model.** The lifecycle moved to
`subgoal-state.ts` and consumes committed round views only — the drift check
that rebuilt a pending set from raw vault entries (a second history
interpretation) is gone, along with `intent_drift`, `subgoal_drift`,
`drift_clarification`, `next_action` and R7. Jaccard similarity survives as a
diagnostic (`possible_duplicate_subgoal` warning) but never merges, blocks, or
changes a status. Machine verification still never writes `SubGoal.status`; a
verified contract item that references a sub-goal produces a derived
`VerifiedSubGoalFact`.

**Scope drift is a machine fact with no waiver.** The `drift_clarification`
channel is deleted, so an out-of-scope change can no longer be argued away: the
round is rejected and repeated drift terminates. `machine_backed_success` is
deleted with it — the item model replaced its two-setting tolerance switch.
`backtrack_auto_restore` and its git stash/reset implementation are deleted too:
LoopForge never mutates the working tree, and the backtrack prompt's restore
facts plus the gate's restore check are the whole mechanism — facts, not
commands, so the prompt does not prescribe a git invocation either (see the
convergence batch below).

**Uniform MCP result envelope, and an explain view.** Every tool answers with
`{ok: true, ...payload}` or `{ok: false, error: {code, message, retryable,
sessionId?, roundId?, details?}}`. `loopforge_status` gained `view="explain"`
and the CLI gained `loopforge explain LOOP_ID [--round N] [--json]` — a
read-only per-round "why" view over committed facts, the contract item reducer,
the observations, the verification flags and the committed enforcement result.
It never rebuilds history and never writes. `doctor` is now documented as
static-only: policy structure, command-id uniqueness, cwd containment, provider
registration, PATH/PATHEXT resolution, timeout and output caps, store, git
readiness. It never executes a verification command and has no `--fix`.

**Verification check set: 24 → 20.** `round_underspecified`,
`round_unverifiable`, `premature_boundary` and `contract_completion_unverified`
are replaced by `contract_items_unverified`; `intent_drift` and `subgoal_drift`
are deleted. Domains: evaluation_consistency 8, evidence_integrity 7,
plan_contract 4, progress_recovery 1.

**Convergence batch — the remaining gaps between this design and the runtime.**
Still version 3.8.0, still no compatibility carried; the protocol field set is
this version's field set.

- **An unregistered provider now yields an `unavailable` observation.** A name
  in `policy.evidence.providers` with no registered factory used to be dropped
  silently, so "the provider is configured but nothing was recorded" left no
  trace in the Vault. It now produces an `unavailable` observation like every
  other provider failure mode, in configuration order.
- **An explicit blocked declaration outranks the success claim.** The stop
  decision checked `completed` first, so `success: true` next to
  `stop_reason: "blocked"` (or `"needs_human_input"`) reported completion.
  Blocked is now decided first, and `completed` requires a `verified` closure
  specifically — a `blocked` closure no longer satisfies it. A contradicted
  item can never produce `completed` (closure is `verified` only when EVERY
  item is); that posture's reject/terminate path stays the enforcement gate's.
- **`explain` reports the contract the round EXECUTED under.** Deriving the
  walker from rounds `<= view.round` handed a closing round its successor's
  contract (or none), because the round's own proposal had already closed the
  active one. `deriveRoundContractView` is now the single derivation — executed
  contract from the rounds BEFORE this one, this round's report and
  observations folded in as the in-flight slice — and the coordinator,
  `explain`, and `audit` all call it. The reducer gained `currentOutcome`, so a
  round's own `blocked` outcome closes its contract in the live path too (the
  arm was previously unreachable there).
- **Stable MCP error codes.** `applyToolEnvelope` used to set `message` equal to
  `code`, so a free-text sentence WAS the code and a client could not branch on
  the error type. Handlers now return a `ToolErrorCode` plus a separate
  `errorMessage`; the new `ToolError` type joins the public protocol. Codes:
  `evaluation_invalid`, `contract_invalid`, `policy_invalid`,
  `session_not_found`, `round_id_required`, `round_id_mismatch`,
  `state_unavailable`, `invalid_argument`, `gate_disabled`,
  `loop_already_running`. `round_id_mismatch` is for the gate preflight, which
  has no held prompt to return; `loopforge_next` keeps its v3.0.1 held-prompt
  recovery (`ok: true` plus a warning).
- **The Round Contract declaration boundary is complete.** `contract_invalid`
  now also rejects: items, scope entries, or per-item refs over the shared
  `CONTRACT_LIMITS` (previously the parser silently truncated them); a `scope`
  that is not a string array, or an entry that leaves the workspace (checked
  with the same `containInWorkspace` boundary as every other workspace path);
  non-string `criterion_refs` entries; a `verify_with` command that is not
  after-capable (the predicate now states the phase requirement the contract
  boundary depends on); and a `subgoal_refs` id naming a sub-goal the loop does
  not have. `validateContractShape` takes a `ContractValidationContext` so each
  reference space is injected and an unobservable one fails open without
  weakening the shape checks.
- **`subgoal_refs` moved from the contract to the item.** A machine-verified
  item backs exactly the sub-goals IT names, so "item A verifies SubGoal 1,
  item B verifies SubGoal 2" is expressible and `VerifiedSubGoalFact`
  attribution is per-item instead of "every verified item backs every
  sub-goal". This changes the content-addressed `rc-`/`rci-` identity (the
  canonical text changed); a restate still keeps its ids.
- **Verified sub-goal facts survive their contract closing.** They were derived
  from the currently-ACTIVE contract, which disappears the moment its last item
  verifies — so the fact vanished exactly when it became fully true, and the
  verification-debt view accused the machine-verified sub-goal of having no
  machine backing. `deriveVerifiedSubGoals` now reads the whole committed
  history through `deriveRoundContractView`.
- **`LoopProjection` exposes `verified_subgoals`**, forwarded from the same
  `deriveCognitiveFacts` the canonical state consumes. It was computed
  internally and then dropped before reaching any projection consumer. The
  projection also reads the WHOLE committed history now: its old
  `beforeRound: session.currentRound` bound is only correct while the loop is
  running, so a stop / terminate / `max_rounds` silently dropped the loop's
  final committed round and the projection contradicted audit and explain about
  the verification it exists to report.
- **`EvidenceCapability` is a `prepare()` return fact.**
  `deriveEvidenceCapability(policy, observations)` is the one derivation;
  `RoundDriver.prepare()` returns it, MCP start/resume/next/status and the
  capability warnings read it. The split is preserved: `ConfiguredCapability`
  stays a pure function of policy in `stateHash`/`promptHash`, while provider
  registry readiness (`available`) and live statuses are rendered only and
  never hashed.
- **The backtrack prompt states restore FACTS, never commands.** All
  `git stash` / `git reset` / `git checkout` / `git clean` lines are gone from
  the prompt and from R9's `fix_instructions`: the prompt names the target HEAD
  and the files that must be reverted, says the restore is the agent's
  responsibility, and leaves the means to the agent. The regression helper now
  asserts those commands are ABSENT rather than present.
- **Audit runs on the contract item axis.** `AuditResult.contracts` reports each
  contract's active rounds, item statuses and closure; the verdict is
  `contradicted` on a contradicted item and `incomplete` on an open contract.
  The criterion axis stays, advisory, and its long-standing unit mismatch is
  fixed — `declared` was a per-round sum against a deduplicated `evidenced`
  count, so `missing` was fiction. Both are distinct-id counts now.
  `AuditRound` carries the round's executed contract, matching `explain`.

## 3.7.1 (2026-09-07)

Protocol convergence and the opt-in gate layer. No compatibility is carried:
the protocol field set is the version's field set. The single-source and
derivation rules from 3.7.0 are untouched — Vault remains the only factual
source, CanonicalLoopState the only cognitive source.

**Sub-goal protocol convergence.** The three string-array declarations
(`completed_subtasks` / `blocked_subtasks` / `canceled_subtasks`) and their
natural-language/Jaccard fallback are gone. One explicit channel replaces
them: `subgoal_updates` — `{ id, status }` references to ACTIVE sub-goals,
governed by a single closed migration matrix (in_progress from pending or
blocked — the dead state is revived through explicit declaration only;
done/canceled are terminal; re-opening means a new `emerged_subtasks` item).
`emerged_subtasks` never accepts `sg-XXXXXXXX` literals. Sub-goal status
errors — shape, unknown ID, terminal reference, illegal migration — return
`evaluation_invalid` pre-advance against the SAME compiled sub-goal set the
agent saw (single derivation, zero session state, zero rejection counters,
same-roundId retry); AGENTS.md's optional-field leniency documents this one
structural exception. Derivation replays every committed round in order, so
older transitions never regress on later compiles.

**Bounded active projections.** Prompts, the state file, and projections
render ACTIVE sub-goals only (pending/in_progress/blocked), ordered blocked →
in_progress → pending (priority, then recency) and capped at the new
`evolution.max_active_subgoals` (default 12). done/canceled items survive in
the vault, replay, and the counts lines — never as rows.

**Three-tier state file.** `.loopforge/state/<loopId>-state.md` is now grouped
Current / Recent / Historical Summary with derived metadata (`Derived: true`,
source round, attempt, state hash). Retry attempts are marked; deleting the
file and recompiling rebuilds byte-identical content (new regression test).
Recovery Briefs render in the Recent tier only inside a recovery window.

**Recovery Brief.** Backtrack directives carry a structured brief — trigger,
restore point, redo round ID, failed rounds with their approaches, and
falsified assumptions. Sourced from committed rounds above the restore point
plus the in-flight attempt; rejected payloads are not durable history and are
never a source. The facts persist with the committed rollback decision
(replay/audit readable) and the brief exits all projections by construction
once the redo commit replaces the record.

**WorkerResult convergence.** `success` is deleted; `outcome` is the single
reported fact, `subAgentType` is optional (defaults to `general-purpose`).
The array stays informational: absent/empty is always accepted, and a present
entry without a valid outcome is dropped — never derived, never a rejection.

**Gate layer becomes real — and opt-in.** `policy.gate.enabled` defaults to
false. Disabled: the two gate tools are hidden from `tools/list` and direct
calls return a stable `gate_disabled` error; history stays readable. Enabled:
`loopforge_gate_check` is a structured preflight over a `GateActionDescriptor`
(conservative classification with stable reason codes; any field change
rebinds the gate id and expires old approvals); a `user_required` verdict
persists a `gate_opened` record; a round citing an unapproved gate via
`evaluation.gate_ids` is rejected (`user_gate_unresolved`, one uniform row).
Trust model is documented: `gate_resolve` is Agent-mediated, so the layer is
process governance plus an auditable decision record — never a machine proof
that a human is present. Flat-text classification survives only for
blocked-round auto-records (record layer, never blocking).

**Version single-sourcing.** `src/version.ts` is generated from
`package.json` (`scripts/sync-version.mjs` runs before build/test/check);
CLI, MCP server info, and doctor reads it; tests and `verify:artifacts`
probe the CLI against the package version. Hardcoded copies are deleted.

## 3.7.0 (2026-09-05)

The convergence batch — verification domains, one enforcement strategy table,
and the legacy deletion. Same design philosophy: the Vault's committed round
documents remain the single factual source, CanonicalLoopState the single
cognitive source.

**Verification gate: 27 checks → 24, organized into four domains.**
The checks are grouped (documentation + CHECK_DOMAIN map only — run order and
verdict aggregation are unchanged) into evaluation consistency, evidence
integrity, plan & contract, and progress & recovery.

- `progress_regression` removed — self-report-only decoration; machine-side
  progress policing lives in the enforcement stall evaluator.
- `empty_change_with_passing` removed — covered by the success-evidence arms.
- `success_claim_conflict` merged into `outcome_success_contradiction` (error
  when outcome=success contradicts success=false; warn when success=true with
  a non-success outcome — enforcement keys on severity, so the error arm's
  trigger is unchanged).

**Success evidence is one semantic.** Enforcement rule R3 `empty_success` is
gone; its posture moved into `checkSuccessWithoutVerifiedEvidence` as an
empty/missing-evidence arm — an unconditional error evaluated BEFORE the
machine-verified early exit, so neither `machine_backed_success: "warn"` nor a
declared `no_change_reason` downgrades a success claim that recorded no work.
The claims arm keeps its v3.6 severity switch and the `no_change_reason` info
downgrade. One flag, one ladder (reject → reject+notice → terminate).

**One enforcement strategy table.** The `UNLADDERED_REJECT_CHECKS` name-set
patch (a workaround for the unreachable R6 ladder) is replaced by an
in-process RULE_TABLE — 12 rows over four action classes (evidence
contradiction, contract & scope, plan drift, progress recovery). Uniform rows
now attach the escalation notice on repeat rejections that the pre-v3.7
comment promised but never appended; actions are unchanged in every
configuration (locked by a behavior-equality compatibility matrix).

**Progress enforcement merged.** R4 stall and R5 flatline become one
`progress_stall` evaluator; exactly-flat windows are an internal diagnostic
tier of the same row (still reachable under `progress_stall_threshold <= 0`)
and the `progress_flatline` enforcement id is removed. Deadlock guard,
git-motion veto, machine fallback, and the backtrack ladder are unchanged.

**Contract framing.** Round Contract checks are documented as three stages —
Declare (proposal verifiability), Execute (scope and done_when conformance),
Close (completion machine-backing). Documentation only; no phase field.

**Legacy deletion.**

- `prepareSync`, the synchronous `captureGitFileState()`, and the synchronous
  `EvidenceCollector.collect()` are removed; `resume`/`reconcileCommittedRound`
  compile asynchronously like `unpause`.
- The legacy PromptCraft vault migration API (`migrateLegacyVault`, CLI
  `migrate`, `LoopStoreMigrationResult`) is removed.
- Round sequence stamps are mandatory: unstamped rounds are
  `sequence_invalid`; prefix gaps are `sequence_gap` for every loop shape.
- The top-level `lineage` field alias is removed (`loop_lineage` only).
- `loop_policy.json` no longer ships the ignored keys (`injection_mode`,
  `subgoal_auto_in_progress_threshold`, `subgoal_auto_complete_threshold`,
  `constraint_inactive_rounds`); loading it emits no unknown-key warnings.
- The committed `gate-test.log` artifact is deleted.

"27 checks / 14 rules" phrasing is gone from the READMEs — gates are described
by their domains and action classes, not internal counts.

## 3.6.0 (2026-09-02)

The deletion batch — self-reported data no longer buys machine verdicts or
masquerades as machine display.

- **R4/R5 stall exemptions are git-motion only.** The criteria-completion
  arm of the exculpatory cross-check (`hasNewCriteriaCompletion`) is gone:
  a self-reported criterion completion can no longer veto a stall verdict —
  claims never buy machine verdicts. The rejection reason now reads "no
  machine-observed git motion in rounds X–Y".
- **`boundary_reason` removed from RoundContract** (audit-only, never
  checked); `MachineStatus` loses its dead null arms ("unavailable" was
  unreachable — absence was already signalled by the object being absent).
- **`no_change_reason` converges on the R8 family.** It downgrades R8's
  success claim to info (the one honored site, now test-locked) and
  suppresses nothing else; `premature_boundary` no longer downgrades to
  info — declaring "no change" while silently dropping contract done_when
  items contradicts itself — and contract-facing guidance no longer
  suggests it.
- **`success_unverified` merged into R8.** `success_without_verified_evidence`
  is now keyed on the runtime `providerStatus` (tamper-aware: an
  entrypoint-tampered command is not machine evidence — the coverage that
  previously lived in `success_unverified` alone). Its warn-level
  trajectory exclusion moved with it; the check never self-skips. One
  success-without-evidence posture, one flag, one enforcement voice.
- **Round Stats columns are source-labeled** in L2 prompts: files & Δ are
  agent-reported, rejected attempts are machine-recorded, and the Machine
  (git) row above stays the machine-observed signal.
- 27 verification checks / 14 rules; docs, changelog, version 3.6.0.

## 3.5.1 (2026-09-02)

Redundancy cleanup: the display derivations now read TRUE data in the
production compile view, the contract-extraction logic exists once instead
of once-in-production-plus-a-test-mirror, and two checks no longer
double-fire on the same posture.

### Dashboard data feed (display rows are real again)

- `Round Stats` rejected-attempt counts and the `Machine (git)` dashboard
  row silently vanished in production prompts: engine hydration merges
  committed decisions onto lineage entries and never exposes raw
  `:feedback` entries, so the compile-side readers (which parse the
  feedback transaction) found nothing — the rows only rendered in unit
  tests that feed raw fixtures. Hydration now stamps
  `lineage.attempt` / `lineage.round_evidence` onto merged lineage entries
  (in-memory only — disk lineage is untouched, a fresh hydration
  re-derives the same stamp from the feedback entry), and the readers
  (`machineGitMotionSeries`, `deriveRoundStats`) fall back to the stamp.
- Regression locks: a merged-view compile fixture renders "1 rejected
  attempt" and "Machine (git): changes in 2/3…", and a real
  reject-then-commit flow leaves `lineage.attempt = 2` on the hydrated
  entry.

### One extraction, not two

- `mergedEntryEvaluation` (round-contract.ts) is the single compile-side
  merged-entry extraction; `deriveActiveContract` delegates to it and the
  view-parity test calls it directly instead of carrying a test-side copy
  that could silently drift from production.

### One posture, one flag

- `premature_boundary` no longer fires on a fully-met posture (every
  done_when claimed) — `contract_completion_unverified` owns it (it also
  fires on `success=false`, and honors the same `machine_backed_success`
  tolerance). R-C1 stays for mixed and silently-dropped success claims;
  the earlier double-flag posture had two errors where enforcement only
  ever voiced one.

## 3.5.0 (2026-09-02)

Makes Round Contract closure a machine-backed, success-class claim and
opens the revision channels around it — plus the machinery to find and
audit contracts in the first place.

### Machine-backed completion (P1a)

- **Closing a contract requires its verification commands to pass.**
  `contract_completion_unverified` (error; warn under
  `evidence.machine_backed_success: "warn"`) fires when an eval's met
  claims satisfy every `done_when` of the ACTIVE contract while a
  verification_plan command was not observed passing (after-phase
  command snapshot) in the same round — regardless of the `success`
  flag. Enforcement rejects the first occurrence and terminates on the
  second consecutive (R-C1-style ladder), registered before R-C1.
  `no_change_reason` never downgrades it (all done_when met contradicts
  "no change"); plan names no longer configured are not required (fail
  open — cannot observe).
- **Shared command evidence.** The raw-vault committed adapter
  (`committedContractRounds`) moved to round-contract.ts — one adapter +
  one walker now serve the verification gate, the session status view,
  and a new view-parity test that locks the raw-`:feedback` view and the
  engine's merged-lineage view against silent divergence.

### Revision channels after failure (P1a′)

- Backtrack prompts now tell the agent the sanctioned way to revise a
  stalled restored contract: close it with `outcome="blocked"` + blocker
  and declare the revised contract in the same submission (the walker
  activates it next round). Silent restating of the stalled contract is
  explicitly forbidden.

### Visibility and guidance (P1b)

- **Premature replacement is no longer silent.** `contract_premature`
  (warn) fires when a different contract is proposed while the ACTIVE
  contract is still open (completion and blocked rounds never warn).
- **L2 declaration nudge.** Contract-less L2 prompts suggest declaring a
  Round Contract when remaining work spans several rounds — prose only,
  policy-gated (`prompt.contract_nudge_on_l2`, default true). L0/L1
  prompts stay byte-identical to v3.4; L2 contract-less prompt hashes
  intentionally change.
- **Auditable surfaces.** `loopforge_status` (session view) exposes the
  derived `activeContract`; replay timeline rows carry each round's
  committed `proposal` — both read-only projections of the committed
  evals, no new persistence.

## 3.4.0 (2026-09-02)

Resolves the Round Contract's round-off-by-one semantics: a declared
`round_contract` is now a **proposal for the NEXT round**, and the runtime
derives the **active** contract — the one the round actually executes under
— from the committed evals of earlier rounds. The active contract drives
the Current Task and the scope/premature checks, survives rejections,
resumes, and backtracks, and is closed by the machine when a committed eval
completes or blocks it.

### Proposal → active split (round-contract.ts)

- **A submission's `round_contract` is a proposal.** It becomes the active
  contract only after the declaring round commits; until then it is checked
  only structurally (`round_underspecified` / `round_unverifiable`).
  Declaration rounds no longer produce scope/premature noise: the old
  checks compared the round's git diff and completion claims against a
  contract the round never executed under.
- **Active contracts are derived, not reported.** `deriveActiveRoundContract`
  walks committed evals (declaration round d → active from d+1) and stays
  active until a committed eval lists every done_when item in
  `success_criteria_met` (complete) or reports `outcome="blocked"`; on
  closure the closing eval's own proposal takes over, or the Current Task
  reverts to the original task text. A different proposal declared while
  the active contract is open is ignored (premature replacement). The
  declaration round's own met claims never satisfy its own proposal.
- **Checks split by target.** `round_scope_drift` (warn) and
  `premature_boundary` (error) evaluate the derived active contract —
  shared item matcher (`contractItemMatches`) with the lifecycle walker so
  compile-side closure and gate-side conformance can never disagree.
- **Retries keep the contract.** Rejection retries (L0/L2), resume, unpause,
  and backtrack compiles derive the same active contract from committed
  rounds, so the Current Task keeps showing the work item on every
  re-compile. `last_round_result.round_contract` is no longer forwarded and
  must never be read as a contract source again — the derivation is the
  single consumer of the committed proposal records.
- Contract-less rounds stay byte-identical and hash-neutral; the canonical
  `roundContract` field remains conditionally present. Per-item machine
  backing of done_when completions (beyond the round-level R-C1 model) is
  future work.

## 3.3.0 (2026-09-02)

Closes the "internally consistent fake success" structural gap: the runtime
can now tell self-reported test results (claims) apart from machine evidence
(observations the runtime made itself), and it no longer trusts a
verification command whose entrypoint the agent just rewrote.

### Machine-backed success (P0)

- **Self-reported `test_results` are claims, not evidence.** `deriveClaimView`
  (`hasMachineEvidence`) now requires a passed after-phase command snapshot
  observed by the runtime itself; a fabricated `test_results` no longer
  satisfies R8 (`success_without_verified_evidence`) or the criteria-claims
  check. This is unconditional.
- **Git observation alone is no longer "verified".** `deriveEvidenceStatus`
  (`providerStatus`) is `verified` only when a passed command was observed;
  git-only rounds are `unavailable`, so `success_unverified` fires, the
  success never enters the trajectory, and trust drops. (Previously any file
  change — even a README edit — counted as machine verification.)
- **New policy switch `evidence.machine_backed_success`** (`"required"` |
  `"warn"`, default `"required"`). `"required"` (default): a success claim
  without machine evidence is rejected (first occurrence) then terminated
  (second consecutive), forcing the agent to configure a verification
  command or declare `no_change_reason`. `"warn"`: the round commits, but its
  success stays out of the trajectory and trust drops — an audit-transition
  mode for projects migrating to machine-backed evidence. Old
  `loop_policy.json` files fall back to `"required"` via deepMerge; no
  migration needed.
- ⚠️ **Behavior change for loops without a configured verification command:**
  success claims backed only by self-reported tests are now rejected (R8)
  instead of accepted. Configure `evidence.commands` (e.g. `run-tests.sh`) or
  declare `no_change_reason`, or set `"machine_backed_success": "warn"` while
  auditing.

### Verification domain integrity (P1)

- **Command entrypoints are captured at evidence time.** `CommandEvidenceData`
  gains `entrypointFiles` — workspace files the command depends on (resolved
  from executable + args, plus `package.json`). Old persisted snapshots parse
  unchanged (missing field reads as `undefined`).
- **Entrypoint tampering is detected.** If a command's entrypoint changed in
  the same round the command ran, the runtime executed a script the agent
  just rewrote — that observation has no stable baseline: new error check
  `verification_entrypoint_modified`, the command no longer counts as machine
  evidence (`providerStatus` degrades), and a new enforcement rule
  (R-EVID-VERIFY) rejects the round with a specific reason. A freshly created
  entrypoint passes on the redo (the diff no longer contains it).
- **Test-file changes stay warn-only.** New warn check `test_files_modified`
  — normal TDD flow (implement + test changes in one round) is never blocked;
  the command result stays usable.

### Exculpatory machine cross-validation for stall detection (P0)

- **R4/R5 verdicts now require machine agreement on the evidence path.**
  When committed git snapshots cover the stall window, a delta-based
  `progress_stall` / `progress_stall_terminal` verdict fires only if the
  window shows **neither** git motion (`machineProgressSeries`, previously
  heuristic-path-only) **nor** a newly met criterion
  (`hasNewCriteriaCompletion`, ID-first matching over committed `:feedback`
  entries — the current round's uncommitted self-report never participates).
  Observed work means the round is *not* stalled — slow-but-delivering loops
  are no longer rejected or rolled back.
- **Exculpatory only.** Derived completion information can veto a stall
  verdict; it never grounds a rejection or termination. When the machine
  signal is unavailable the legacy delta verdict stands unchanged (existing
  loops and tests keep their exact behavior).
- The rejection reason annotates the missing machine signal
  (`no machine-observed git motion or criteria completion in rounds X–Y`) so
  the agent sees why a stall fired despite its self-reported progress.

### Roadmap look-ahead section (P0)

- Prompts (L1/L2) and the state file now render a forward-looking **Roadmap**
  — loop position, rounds since the last milestone boundary, met/remaining
  criteria with stable IDs, and sub-goal activity — derived from the same
  `buildRoadmap` view (`canonical-state.ts`) so prompt and state-file
  renderers cannot drift apart. Milestone labels stay out (L1 diff-collapse
  invariant); empty states render nothing and add nothing to prompt budgets.

### Round stats and reported-vs-machine comparison (P0)

- The L2 Progress Dashboard labels the self-reported estimate as unverified
  and shows the machine side: git motion over the recent committed rounds
  and committed-history criterion completions (`Machine (git)` /
  `Machine (criteria)` rows; the state file gets the same rows).
- A new L2 **Round Stats** section surfaces per-round files changed,
  rejected attempts (from the committed snapshot's attempt count), and
  self-reported progress deltas over the last five rounds — letting the
  agent calibrate its round granularity. All derived per compile, zero
  persistence, zero protocol change.

### Round Contract (V1)

- **Optional `round_contract` on every SelfEvaluation** — the agent's
  restated self-commitment for the round it executed: `work_item`,
  `done_when` (criterion IDs or text), `verification_plan` (configured
  evidence command names), `scope` (files/directories this round may
  touch), and `boundary_reason` (audit only, never checked). A declared
  contract drives the NEXT round's Current Task — the agent works the
  contract, not the whole objective — until its `done_when` items are
  satisfied; the original objective stays in the Objective section.
- **Four purely mechanical checks** (all silent without a contract):
  - `round_underspecified` (warn): contract with an empty `done_when`.
  - `round_unverifiable` (warn): `verification_plan` empty or naming
    commands that are not configured AND enabled in
    `policy.evidence.commands`.
  - `round_scope_drift` (warn): the round's fingerprint-narrowed git diff
    includes files outside the declared scope. A substantive
    `drift_clarification` (≥ 20 chars, real file/ID anchors) accepts a
    legitimately expanded scope; no/weak clarification rejects (R-C2);
    repeated unclarified drift terminates.
  - `premature_boundary` (error): success claimed while a `done_when`
    item is claimed met without round-level machine verification, or is
    silently dropped (neither met nor remaining). R-C1 rejects with
    contract-specific fix instructions; `no_change_reason` downgrades to
    info (the R8 escape-hatch family) but never exempts scope_drift.
- **Protocol surface**: `RoundContract` joined the schema $defs
  (37 → 38). Registration passes all six layers (protocol types +
  factories, lenient parser, MCP input schema, `buildLoopRequest`, the
  engine rebuild path, and the eval-merge lineage whitelist). Non-breaking:
  optional field, contract-less rounds are byte-identical everywhere.

## 3.2.0 (2026-08-29)

Two batches: the hard-compiled prompt quality improvements (verification
instructions, L1 diff-collapse, goal→criteria dashboard, lessons learned,
L1 external context) and the runtime evidence status that closes the two
structural gaps of the self-evaluation model — machine verification is now
runtime-derived, not self-reported (inspired by the v3 RoundReport design in
the legacy codebase, minus its over-engineering: no claim/evidenceRef chains,
no format enforcement, no blanket rejections).

### Machine verification is now runtime-derived, not self-reported

- New `deriveEvidenceStatus`: per round, the runtime derives
  `providerStatus` (`verified` / `unavailable` / `absent`) plus git/command
  observations from the ALREADY-collected snapshots (before/after/round
  evidence). Previously "machine verified" effectively meant "the agent said
  its tests passed" (`hasPassingTestEvidence` reads self-reported
  `test_results`); git evidence only fed an integrity warn.
- New `success_unverified` check (warn): a success claim with no
  machine-verified observation is flagged — including on the
  heuristic-extraction path, where evidence rules used to silently
  self-skip. The round still commits; its success never enters the success
  trajectory and the trust score drops. `no_change_reason` remains the
  honest escape hatch (docs-only rounds are unaffected).

### Stall detection no longer disappears when evidence is missing

- R4/R5 on the heuristic path fall back to `machineProgressSeries` —
  per-round git observations rebuilt from the committed feedback snapshots.
  Three consecutive rounds without git changes is a stall (existing
  reject/backtrack/terminate semantics preserved). No git signal → the rule
  keeps its legacy skip (the machine cannot observe).

### Verification flags become actionable instructions

- Every L1/L2 Verification Gate flag (error/warn) now carries a short
  imperative continuation line (`→ Fix:` for errors, `→ Action:` for warns),
  mapped per check name (19 checks, coverage enforced by a test). The base
  `- 🚫 [check] detail` line is byte-identical, L0 stays untouched, and info
  flags stay informational. Phrasing is deliberately shorter than the
  rejection-prompt wording.

### L1 diff-collapse with a strict state-file pointer

- L1 collapses UNCHANGED presentation (constraints, sub-goals, recent rounds)
  against the previous round's persisted presentation snapshot into one-line
  pointers at the (freshly regenerated) state file; changed content — new or
  violated constraints, sub-goal status transitions, new milestones — renders
  in full. L2 never collapses (the recovery view stays complete).
- The diff baseline is durable: `presented_constraint_ids` /
  `presented_subgoals` / `presented_milestone_ranges` are persisted on the
  lineage entry (field extension, no new format), so restart determinism holds
  (byte-identical recompiles). Old-format vaults fall back to full rendering.
- Emphasized items (`prompt_requests.emphasize`) never collapse and never
  count as demoted. L1's state-file pointer now carries `(updated round N)`.
- Kill switch: `prompt.l1_collapse_enabled` (default true).

### Goal → criteria → evidence vertical dashboard

- New derived `CriterionStatus` view: every objective criterion gets
  met/remaining/unknown status, the round it was first reported met, and any
  linked sub-goals (Jaccard). Rendered in the L2 Progress Dashboard and the
  state file. Zero persistence — re-derived each compile; IDs follow
  `constraint_id_enabled`.

### Lessons learned

- New derived `Lesson` list: constraints violated repeatedly or verification
  checks failing repeatedly across the WHOLE loop (beyond the R2 3-round
  window), with counts and rounds. Rendered in L1 Recurring Issues (≤3) and a
  new L2 Lessons Learned section (≤8) plus the state file. Presentation only —
  never feeds enforcement decisions.

### Entry-point enhancements

- `external_context` now renders in L1 too (previously L2-only).

## 3.0.1 (2026-08-29)

Version alignment and three fixes from the project audit: submissions are now
anchored to the round they report on, the round boundary stops recompiling and
re-reading the whole vault, and every version string is unified to 3.0.1.

### Submissions are anchored to a roundId

- `loopforge_next` now requires a `roundId` — the one from the most recent
  `loopforge_start` / `loopforge_next` / `loopforge_resume` /
  `loopforge_status` response. A submission whose roundId no longer matches
  the current round (the round it reported on already committed — a lost
  response, a duplicate call) is **not processed**: the held prompt is
  returned with a warning so the agent recovers the response it missed,
  without skipping a round or double-committing. Previously a retried or
  duplicate submission was evaluated against the *next* round with the
  previous round's evaluation, silently skipping the round in between.
- Rejected rounds keep the same roundId across attempts, so retries are
  unaffected. Missing roundId is rejected at the schema level (`-32602`) and
  at the handler level.
- `SERVER_INSTRUCTIONS` and the Perception skill now tell agents to pass the
  roundId back.

### Round-boundary compile cost is bounded

- The typed projection (`loopforge_status` and the per-round projection
  attached to `loopforge_next`) derives from the compile response already
  produced at the round boundary instead of recompiling the whole vault —
  one full compile per round instead of two.
- `RoundDriver.prepare` now compiles and collects before-evidence
  concurrently (the evidence spawns were the latency tail behind a serial
  compile-first order).
- The engine keeps an in-memory hydration cache per loop. A warm cache makes
  every later compile incremental: one round document read per round boundary
  instead of the full history (each round document embeds the full prompt and
  evidence snapshots, so this is the dominant cost in long loops).
  `coveredRound` counts contiguous committed rounds only — lineage-only
  entries of uncommitted rounds never advance it, and re-reads replace stale
  entries post-commit, so crash-recovery resume can never serve unmerged
  state. No persistence change: the cache is derived, and a fresh engine
  hydrates fully once.

### L1 milestone sampling — the loop's memory skeleton survives the cap

- Previously both L1 and L2 truncated milestones to `max_milestones` (10,
  newest kept) — a 100-round loop lost every early phase anchor. Now:
  - **L2 (full rehydration) keeps every milestone** — the recovery view is
    the loop's memory skeleton and is never truncated (state file included).
  - **L1 samples over the cap**: the oldest `milestone_head_count` (3,
    history anchors) and the newest `milestone_tail_count` (3, current
    progress) are always kept; the middle keeps an even sample that prefers
    `agent_declared` labels. New policy keys: `summary.milestone_head_count`
    / `summary.milestone_tail_count` (both default 3).

### Version alignment

- All version strings unified to 3.0.1 (package.json, package-lock.json,
  CLI, MCP server info, index, docs, tests).

## 2.13.0 (2026-08-28)

The round state machine moves out of `SessionManager` into a new `RoundLifecycle` class —
crash recovery, transaction execution, disposition result building, and the
advance pipeline. `SessionManager` keeps the in-memory registry, per-session
queue, lease fencing, and the public entry points. The public surface is
unchanged: `create` / `advance` / `unpause` / `resume` / `pause` / `delete` /
`save` / `get` / `list` / `getLeaseStatus` / `checkGate` / `resolveGate` /
`getProjection` / `getAudit` / `getPolicyMetrics` / `getHealth` /
`autoResumeAll` / `addTerminalSink` / `getOwnerId` / `close` /
`replayTimeline` behave identically. No storage format or protocol change.

### What changed

- New `src/mcp/round-lifecycle.ts`: `RoundLifecycle` owns the round state
  machine. It receives `LoopStore`, `SessionStateStore`, a narrow
  `SessionRegistry` view (get / upsert / values), the terminal-sink set, the
  owner token + lease duration, and a live `getContext()` accessor. No method
  logic changed — only reference paths (`this.sessions.*` → `registry.*`,
  `this.ownerId` / `this.leaseMs` / `this.contextProvider` → constructor deps).
- `src/mcp/session.ts` shrinks to the session facade: registry, per-session
  queue, lease machinery, and the public API. `create` / `advance` / `unpause`
  / `resume` become queue + lease + delegate; `delete` / `pause` / `save`
  delegate persistence to the lifecycle. `SessionManager` implements
  `SessionRegistry` so the lifecycle never holds registry state.
- `McpSession`, `McpSessionSummary`, `StartInput`, `AdvanceResult` move to
  `round-lifecycle.ts`; `session.ts` re-exports them, so the public type
  surface from `loopforge` is unchanged.
- The AGENTS.md round-processing invariant now reads SessionManager →
  RoundLifecycle → RoundDriver → RoundCoordinator (same guarantee, one new hop).
- New `round-lifecycle.test.ts` unit coverage for the crash-recovery matrix
  (`reconstructSession` field mapping, paused/stopped gating, legacy
  `quality_trajectory` fallback, save → reconstruct round-trip, cross-process
  lease conflict) and both crash windows (`reconcileCommittedRound` continue
  and stop) plus the advance commit fence — all previously reachable only
  through full MCP simulation.

### Critical fixes (project audit round)

- **Cross-round compile context restored.** `hydrateLoopContext` now merges
  each committed round's full decision (verification flags, round success,
  and the agent's SelfEvaluation from `round_transaction`) into the
  compile-time lineage entry. Previously the compiler only saw the 8
  compile-time lineage fields, silently disabling milestones (both
  `agent_declared` and `criteria_milestone` never fired), discovered
  constraint decay, sub-goal accumulation, and rolling-summary fidelity.
  Empirically verified: a round-1 eval with a checkpoint + discovered
  constraint + sub-goals now yields the `agent_declared` milestone in the
  round-2 compile.
- **Backtrack deadlock guard.** `isCleanRound` now reads verification flags
  from the committed round decision (they were never written where it
  looked), so restore-point selection sees error flags. And when a
  backtrack already committed at or after the current round, the next
  R4/R5 escalation **terminates** instead of backtracking again — a
  persistently stalled loop previously cycled reject↔backtrack forever
  because backtrack reset the consecutive-rejection counter.
- **R-EVID rule.** A new enforcement rule rejects when `required_command_failed`,
  `command_evidence_mismatch`, or `outcome_success_contradiction` error flags
  are present — a required command failure now contradicts a success claim
  before commit, per the invariant. Previously the verification gate
  produced the flags but no rule consumed them, so a lying agent's round
  was accepted.
- **Corrupt JSON surfaces; no silent repair.** `readJson` distinguishes
  missing (ENOENT → null) from corrupt (parse error → `StorageCorruptionError`
  `invalid_json`); `readRound`/`readSession` throw `invalid_format` for
  existing documents with an unexpected shape. The `writeEntry` path that
  previously overwrote a corrupted round document with a fresh empty one now
  refuses.

### Persistence consistency fixes (project audit round)

- **Load-time gap detection is wired into resume.** `checkRoundSequence` now
  runs on session reconstruction (`resume` / `unpause` / `autoResumeAll`),
  not only in the read-only audit — the AGENTS.md comment claimed it was
  consumed by resume but no load path called it. Deleting a middle round
  document now surfaces as `StorageCorruptionError` on resume instead of
  silently continuing. Auto-resume skips recoverable gaps per loop and
  continues the bulk scan; explicit resume surfaces them.
- **Prefix gaps are no longer masked as legacy imports.** A stamped loop
  WITH a session document always began at round 1 (write-time continuity),
  so missing rounds 1..N-1 are deletion — `checkRoundSequence` now flags
  them as `sequence_gap`. Loops without session documents (migration
  imports, which never write sessions) stay exempt.
- **Session-only loops are discoverable.** `writeSession` stamps
  `metadata.json` alongside the session document, so a loop created and
  crashed before its first round commit appears in `loopforge_status` /
  `autoResumeAll` instead of being orphaned (metadata was previously only
  written by the round path). `listLoopIds` additionally recovers loop IDs
  from the session document itself for pre-v2.14 orphaned dirs.
- **Lock crash window self-heals.** A process killed between `mkdir(lock)`
  and `write(owner.json)` left a lock directory without an owner that
  deadlocked every later writer until manual deletion. A lock dir without a
  readable owner is now treated as stale after a 500 ms grace (the window is
  microseconds); owner-based stale checks are unchanged.
- **`invokeFeedback` fails honestly.** Feedback is loop-scoped; a request
  without `loop_id`/`round` previously reported "## Feedback Recorded" while
  the write was silently dropped. It now returns a clear ERROR, and a failed
  persistence attempt surfaces as ERROR instead of OK.

### Semantics / state-machine fixes (project audit round)

- **Audit and metrics exclude rolled-back rounds.** Rounds committed with
  action "backtrack" are not part of the loop's final history — the audit's
  round list and verdict no longer count them (their error flags previously
  could flip the verdict to "contradicted"), and vault-derived policy
  metrics no longer count them as committed progress.
- **`terminatedRounds` is no longer structurally 0.** Terminate decisions
  never commit (documented invariant: "only accepted decisions are
  committed"), so vault-derived counts can never see them and the merge
  overwrote the live count with 0. The merged value now takes the live
  count; `roundAttempts` now includes this process's rejects/terminates,
  fixing `acceptanceRate` (3 rejects + 1 commit previously read 1.0, now
  0.25).
- **Pause race no longer skips a round.** The commit fence returns "paused"
  after `currentRound` was incremented and pause() persisted it; on resume,
  the committed-round replay incremented again and silently skipped the next
  round. The replay now advances only when the persisted counter has not
  already moved past the committed round.
- **R5 continuity guard.** Flatline ("zero motion") now requires the recent
  data points to cover the most recent rounds, mirroring R4 — rounds without
  execution evidence are unknown motion, not zero motion. Previously a loop
  whose recent rounds merely lacked progress data could be terminated.
- **R7 streak semantics unified.** The no-clarification drift branch used
  the GLOBAL rejection counter — an unrelated earlier rejection (e.g. R1)
  terminated the loop on the very first drift. It now counts toward the same
  `drift_clarification_max_streak` as weak clarifications (README: "three
  consecutive weak clarifications terminate"), giving the agent its full
  runway regardless of other rejections.
- **R9 workspace-restore loop closed + commands made consistent.** A
  non-restoring agent previously cycled R9-backtrack forever (backtracks do
  not increment the rejection counter); a second R9 on the same round now
  terminates. The backtrack prompt gained a `git reset --hard <restore-commit>`
  option, so its restore commands can actually satisfy the HEAD check the
  verification gate enforces.

### Compiler / prompt fixes (project audit round)

- **Emphasize is now a true pure reorder.** The matched items were appended
  verbatim into a new "Critical Context" section while their originals stayed
  in the source sections — duplicating content and adding token cost on every
  emphasize, contradicting the "zero token overhead" invariant. The matched
  items are now MOVED: the source sections lose them (exact-text filter over
  the four candidate arrays), the Critical Context renders them once, and
  unmatched emphasizes are dropped.
- **Empty strings no longer match everything.** `jaccardSimilarity("", x)`
  returned 1 (the comment said "empty descriptions never match anything" —
  the code did the opposite), making `completed_subtasks: [""]` mark any
  sub-goal done and `success_criteria_met: [""]` suppress criteria
  milestones. Empty sides now score 0.
- **All Jaccard thresholds are policy-driven.** `alignTask` and
  `checkLoopHealth` hardcoded 0.3/0.2 (now
  `evolution.progress_mismatch_threshold` / new
  `evolution.task_continuity_threshold`); the confusion-point section
  pointer hardcoded 0.15 (new `prompt.confusion_section_threshold`). The
  previously unread `progress_mismatch_threshold` key is finally consumed.
- **`max_confusion_points` is enforced.** L2 rendered every confusion point
  (parser cap 5) regardless of the policy cap (3); L2 now renders at most
  the policy value. L1 keeps a single alert.
- **Plan/hard constraint retractions persist for the retire window.** A
  retracted plan/hard/criteria constraint was re-merged from the request and
  objective on the very next round, so the documented "Removed from the
  active constraint set" never held. Retraction rounds are now derived from
  vault entries (no new persistence format) and the constraint stays out for
  `constraints.retire_window` rounds (default 3), then returns — hard/plan/
  criteria never auto-decay; only the retraction's memory expires.
- **Recovery boundary forces L2.** The `decidePromptLevel` recovery_boundary
  branch existed but no caller set it — a post-backtrack compile fell
  through to L1 instead of full rehydration from the restore point. A
  committed backtrack for the current round now forces L2.
- **Pending sub-goal sort matches its comment.** `(currentRound - a.declared)
  - (currentRound - b.declared)` simplified to newest-first despite the
  "oldest first" comment; now `a.declared - b.declared`.

### CLI / tools fixes (project audit round)

- **`inspect` no longer leaks prompt text.** `withoutPrompts` used the
  `\bprompt\b` word-boundary regex, which never matched any real key
  (`full_prompt`, `current_prompt`, `renderedPrompt` all fail the boundary),
  and the one key it WOULD match (`promptArtifact`) was whitelisted while
  containing the full rendered prompt — the filter was a silent no-op.
  Prompt-text fields are now filtered by substring, and prompt artifacts are
  reduced to their metadata (level, hashes); `renderedPrompt` is stripped.
  Regression test writes a committed round with a full prompt artifact and
  asserts the text never reaches `inspect` output without `--prompt`.
- **Tool outputs now enforce their declared schemas.** The outputSchemas
  advertised in tools/list were never validated — a mismatched output
  silently violated the declared contract. The MCP server now validates
  every handler output (schema unions supported, explicitly-undefined
  optional fields treated as absent) and surfaces a violation as a clean
  JSON-RPC error. The first run caught a real drift: `loopforge_resume`
  returned `roundSuccess: undefined` against a `boolean` contract — the
  contract is now `["boolean", "null"]`, matching the actual semantics.
- **Entry-point validation for start/resume.** `maxRounds` (0, negatives,
  fractions previously passed through and stopped the loop on round one) is
  now validated as a positive integer both in the input schema
  (`type: "integer", minimum: 1`) and in the handler; `loopId` is validated
  at the entry point with a clean argument error instead of exploding later
  as an internal storage error.

### Remaining audit items (doc drift + duplicate-loop guard)

- **Same-process duplicate loopId guard.** A second `loopforge_start` with
  the same loopId within one process silently overwrote the first session's
  persisted state and left two in-memory sessions pointing at one loop
  (cross-process was already fenced by the lease). `create` now returns a
  `loop_already_running` result and the tool surfaces it as a clean error;
  the first session stays intact.
- **`MemoryLoopStore.listEntries` mirrors production.** The test double
  deduped by task_id keeping the RAW entry; production routes both
  `writeSession` and raw session_state appends to the same `session.json`,
  where the document is the single copy. The double now replaces the raw
  entry with the session document and the comment describes the actual
  contract.
- **Doc drift corrected.** README's architecture diagram said "16 checks"
  (19 check constants) and "9 rules" (10 with R-EVID); the test count said
  590 (now 646).

### Redundancy cleanup (audit round)

- **Stable ID derivation consolidated.** `deriveItemId` (sha256 of
  normalized text, 8 hex) was copy-pasted in prompt-assembler and
  canonical-state; loop-compiler's deriveSubGoalId/ConstraintId/CriterionId
  duplicated the same hash via `computeGoalTextHash().slice(0, 8)`. One
  exported `deriveItemId` now lives in token-utils (the module every
  consumer already imports) — hash strategy unchanged, outputs identical.
- **Stable-ID regex consolidated.** The `/^(c|cr|sg)-[a-f0-9]{8}$/`
  pattern existed in four places (canonical-state, prompt-assembler ×2,
  enforcement-gate); one exported `STABLE_ID_RE` replaces them all.
- **Deleted dead code / fields (each verified zero-callers across src +
  tests + JSON):**
  - `max_carried_constraints` policy key (interface, defaults, loop_policy.json)
  - `taskIdPattern` option + filter branch in queryLoopEntries (legacy
    vault semantics, no caller)
  - `replaceEntries` from the LoopStore interface and both implementations
    (misleading name — it appended; zero callers)
  - `event_sequence` sort layer in auditOrder (no entry in the codebase
    ever writes that field — unreachable)
  - R4's `last3[2] > currentRound - 1` guard (always false —
    collectProgressByRound already filters `rnd < currentRound`)
  - 4 unused imports (cli readFileSync, cognitive-governance isRecord,
    enforcement-gate CHECK_INTENT_DRIFT/CHECK_SUBGOAL_DRIFT, engine
    VerificationFlag)
- **Round-lifecycle compile tails deduplicated.** reconcileCommittedRound,
  resume, and unpause each copy-pasted the apply-prepared→persist→build-
  result block; one `persistPrepared` helper now serves all three.
  Unpause's historical empty-warnings contract is preserved explicitly.
- **Kept with justification:** `lease_epoch` (displayed by getLeaseStatus),
  R5 (documented rule, shadowed by R4 but part of the stated design),
  `computeGoalTextHash` (12-char — different length, still used), render
  helpers (bulletsWithIds vs addListWithIds have different signatures and
  layers; merging risks prompt-output drift).

### Not changed (deliberate)

- The lease machinery stays in `SessionManager` — it is ~90 lines, has its own
  test file, and no second consumer exists. Splitting it would churn without a
  testability win.
- No storage format, protocol field, or on-disk layout change.

**VaultBackend → LoopStore swap.** The deprecated storage interface is gone;
`LoopStore` is now the single storage spine. Every module that previously held
a `VaultBackend` (or one of the two circular adapters that let the interfaces
impersonate each other) now depends on `LoopStore` directly. 590 → 599 tests.

### What changed

- `backends/interface.ts` is deleted. `VaultEntry` moves into `loop-store.ts`
  as the shared entry shape for session/round documents and flat list views.
- `LoopStoreBackend` (LoopStore masquerading as VaultBackend) and
  `VaultBackendLoopStore` (VaultBackend masquerading as LoopStore) are
  deleted, along with the test-only `MemoryBackend`.
- New `queryLoopEntries(store, loopId, opts)` helper preserves the legacy
  `queryEntries` semantics (`prefix` / `taskIdPattern` / `feedbackOnly`,
  feedback excluded by default) as a derived read-only view over the single
  durable truth. Production and tests now share the same filtering code —
  the test double previously implemented a different prefix-matching rule
  than the production adapter.
- Constructors accept `LoopStore` only (breaking): `LoopForgeEngine`,
  `SessionManager`, `McpServer`, `RoundDriver`, `RoundTransactionCoordinator`,
  `RoundCoordinator`, `ReplayBackend`, `VaultRoundCommitStore`.
  `LoopForgeEngine.getBackend()` → `getStore()`.
- `index.ts` exports `queryLoopEntries` and the `VaultEntry` type; the two
  adapter classes are removed from the public surface.
- No on-disk format change: session/round documents, `sequence` stamps, and
  the migration path are untouched. `FileLoopStore` behavior is identical.

### Deferred to next round

- SessionManager decomposition (the v2.12 deferral note's other half). The
  session store, lease machinery, and round lifecycle remain one class.

## 2.12.0 (2026-08-28)

**V3 essence migrated onto the V2 base.** The 3.x line's best designs were
ported and adapted to the flat V2 contract: claim provenance, event sequence
integrity, backtrack git-HEAD enforcement, CJK-aware similarity, user/agent
gates, typed projections, and a read-only audit — without changing the
agent-facing submission contract's shape. 506 → 590 tests.

### Claim provenance (internal model, zero new agent fields)

- New `evidence-claims.ts`: every reported criterion completion is a claim,
  `claimed` by default; upgraded to `verified` only by machine evidence
  (passing test results AND a passed after-phase command snapshot);
  downgraded to `contradicted` when error-level flags contradict it.
- New verification check `success_without_verified_evidence` (error) with
  the flat `no_change_reason` escape hatch (info).
- New enforcement rule **R8**: evidence-less success rejects first,
  terminates on repeat.

### Round sequence integrity (lightweight, no new storage format)

- Round documents carry a monotonic `sequence` stamp; write-time continuity
  (round N requires N-1) and load-time gap detection (`checkRoundSequence`)
  enforce crash consistency. Legacy loops without stamps are exempt.
- `StorageCorruptionError` carries kind + severity (`recoverable` vs
  `corrupted`) — the runtime never silently repairs storage.
- `atomicWrite` retries once after 500ms for transient I/O failures.

### Backtrack git-HEAD enforcement (completed half-finished v2.13 work)

- `findBacktrackTargetGitHead` reads the restore point's committed git HEAD;
  the round coordinator now actually sets `backtrackTargetGitHead` (it was
  declared but never assigned), the session persists it across crashes, and
  the verification gate checks the workspace returns to that commit
  (12-char comparison).
- New enforcement rule **R9**: `backtrack_workspace_not_restored` (previously
  produced by the gate but consumed by no rule) now backtracks again.

### Tri-state outcome (flat, backward compatible)

- Optional `outcome` (`success|partial|failed|blocked`), flat `blocker`, and
  `retroactiveClaims` on SelfEvaluation. `effectiveOutcome` derives from
  `success` when absent; `partial` is explicit-only.
- Success-class checks key off the effective outcome; declared non-success
  suppresses them even with `success=true`; contradictions and conflicts get
  their own checks.
- Stop mapping: `blocked` maps to `StopReason.blocked` without needing the
  legacy `stop_reason` field.

### Tolerant diagnostics

- `extractSelfEvaluationWithDiagnostics` (structured failure reason),
  `inferOutcomeFromText` (CJK-aware keyword inference — diagnostics only,
  the runtime never guesses state), and `collectSelfEvalGaps` (field-level
  gaps surfaced as `parseGaps` + warnings in `loopforge_next` output).

### User/Agent gates (record layer)

- `cognitive-governance.ts`: USER_EFFECTS classification, stable
  `gate-` hashes binding approvals to exact action text, flat-text
  classification via `deriveGate`.
- Tools: `loopforge_gate_check` (read-only classification) and
  `loopforge_gate_resolve` (records human decisions; changed action text
  expires old approvals automatically). Gates never block the round flow.

### Typed output surface

- `LoopProjection` (focus / todo with source+priority / phase boundaries /
  delegation record view / handoff with verified cr-IDs) attached to
  `loopforge_next` and `status` outputs — all derived, zero persistence.
- `loopforge_status` gained `view=session|loop|all|audit`; `loopforge_list`
  and `loopforge_health` are folded into it. New `buildAudit`: read-only
  end-of-loop verification view (claims, gates, verdict, sequence integrity).
- MCP tool surface stays 9 tools (schema cost ~25% lower).

### CJK-aware similarity + hygiene

- `tokenize` now produces overlapping CJK bigrams (astral-plane aware):
  Chinese similarity is graded instead of 0/1.
- `deriveSubGoalId`/`deriveConstraintId`/`deriveCriterionId` exported from
  `loop-compiler.ts`; the verification-gate duplicate copy is deleted.
- CHECK_* constants unify check names between the gates.
- Version constants unified to 2.12.0 (were 2.0.x); dead `checkpoints`
  field and empty catch blocks removed; MCP argument validation now enforces
  declared enums.

## 2.11.0 (2026-08-05)

**Stable IDs across constraints and criteria, strengthened drift clarification, and
backtrack workspace restore.** Three reinforcing improvements that eliminate
Jaccard false positives/negatives from constraint matching, prevent R7
clarification abuse, and close the state-vs-filesystem consistency gap after
backtrack.

### Constraint & Criterion ID System — v2.11

The sub-goal pattern (`sg-XXXXXXXX`, stable hash-derived IDs used for exact
matching with Jaccard fallback) is now extended to constraints and criteria.
This eliminates the four remaining Jaccard-only matching sites that caused
false positives and false negatives.

- **`ConstraintMeta.id`** — stable constraint ID (`c-XXXXXXXX`) derived from
  text hash, populated by `manageConstraintLifecycle()`.
- **`deriveConstraintId()` / `deriveCriterionId()` / `isConstraintId()` /
  `isCriterionId()`** — ID derivation and pattern-matching helpers, same hash
  strategy as `deriveSubGoalId()`.
- **ID-first matching** — `findDiscoveredRound()`, `findLastViolatedRound()`,
  `detectNewCriteria()`, and `matchEmphasize()` all try exact ID match first,
  then fall back to Jaccard for backward compatibility.
- **IDs rendered everywhere** — L1 prompts, L2 state file (Success Criteria,
  Hard Constraints, Active Constraints, Inactive Constraints), and the
  self-eval template all show IDs with `\`c-XXXXXXXX\`` / `\`cr-XXXXXXXX\`` tags.
- **`constraint_id_enabled`** — new `EvolutionPolicy` field (default `true`).
  Set to `false` to restore pre-v2.11 pure-Jaccard behavior.
- **470 tests** (was 460). IDs are deterministic — same text always produces
  same ID across rounds.

### Drift Clarification Strengthening — v2.12

R7 previously waived rejection for any `drift_clarification` ≥ 20 characters —
trivially gameable with filler text. Now requires a **semantic anchor** and
tracks consecutive weak clarifications.

- **`hasSemanticAnchor()`** — checks for constraint/criterion/sub-goal IDs
  (`c-`/`cr-`/`sg-XXXXXXXX`) or file paths in the clarification text.
- **Substantive clarification = length ≥ 20 + anchor present** → accept,
  `clarification_accepted: true` on EnforcementResult.
- **Weak clarification = length ≥ 20 but no anchor** → increment streak.
  Streak 1: reject with stronger instructions. Streak ≥
  `drift_clarification_max_streak` (default 3): terminate.
- **`driftClarificationStreak`** — new field on `McpSession`, persisted in
  vault. Reset to 0 on any round without intent_drift.
- **`drift_clarification_max_streak`** — new `EnginePolicy` field (default 3).
  Set to 0 to disable the streak limit (pre-v2.12 behavior).
- **479 tests** (was 470). Streak tracks substantiveness — genuine pivots with
  recognized IDs don't count against the agent.

### Backtrack Workspace Restore — v2.13

Backtrack previously only reset LoopForge's vault state — the physical
working directory retained changes from the failed rounds. Now the backtrack
prompt includes concrete restore instructions, and the verification gate
enforces the check on the next submission.

- **Git HEAD capture** — `GitEvidenceProvider` now captures `git rev-parse HEAD`
  as `head` in `ProviderSnapshot.data` for restore point tracking.
- **Backtrack prompt rewrite** — `buildBacktrackPrompt()` now includes a
  dedicated "Workspace Restore Required" section with concrete commands
  (`git checkout -- . && git clean -fd`, `git stash` option), affected file
  lists from skipped rounds, non-git fallback, and a verification warning.
- **`checkBacktrackWorkspaceRestore()`** — new verification gate check. Compares
  the agent's `files_changed` against skipped-round files. ≥ 3 overlap → error
  flag → enforcement reject. 1–2 overlap → warn.
- **`backtrackSkippedFiles`** — threaded through session → round driver →
  round transaction → verification gate. Persisted in vault for crash recovery.
- **`backtrack_auto_restore`** — new `EnginePolicy` field (default `false`).
  DANGEROUS: when true, LoopForge auto-executes `git stash + reset --hard`
  on backtrack. Default-off — the prompt + verification approach is the safe
  default.
- **491 tests** (was 479).

### Policy additions

```json
{
  "engine": {
    "drift_clarification_max_streak": 3,
    "backtrack_auto_restore": false
  },
  "evolution": {
    "constraint_id_enabled": true
  }
}
```

## 2.10.0 (2026-08-05)

**Prompt Requests and Backtrack.** Two interlocking mechanisms that give the
model structured influence over its own prompts and a way to recover from dead
ends without human intervention.

### Prompt Requests (`prompt_requests` — v2.9)

The model can now express information needs at the end of each round via a new
optional `prompt_requests` field in SelfEvaluation:

- **`emphasize`** — constraints, discoveries, or decisions the model needs
  highlighted. Matched via Jaccard similarity against active state, pulled into
  a "Critical Context" section. Pure reordering — zero token overhead.
- **`expand`** — structured sections (`milestones`, `sub_goals`,
  `constraint_lifecycle`, `agent_trust`, `progress`, `loop_synthesis`) the model
  needs in full L2 detail while in L1 mode. Max 1 section in L1.
- **`confusion_points`** — things the model is confused about. Rendered at the
  prompt top as "Confusion Alerts" with auto-matched state section pointers.

Level behavior: L2 honors all (emphasize ≤5, confusion ≤3). L1 honors limited
(emphasize ≤3, expand ≤1, confusion first entry only). L0 ignores all.

### Backtrack (`backtrack` — v2.10)

When the enforcement gate detects a dead end (progress stall R4, flat terminal
R5), instead of terminating the loop, the agent is now rolled back to the last
**clean round** — an accepted round with no error-level verification flags:

- **Safe restore point** — computed on-demand from vault entries. Scans
  backwards from the current round, max depth 3 (policy-controlled). Skips
  rounds with errors, rejections, or regressions.
- **Lessons injected** — the backtrack prompt includes a "Why This Happened"
  diagnosis and "What Must Change" guidance, specific to the trigger rule.
- **Preserved discoveries** — `discovered_constraints` from skipped rounds
  are merged into the restored state's active constraints.
- **Terminate fallback** — if no clean round is found within maxDepth,
  backtrack falls through to terminate.

Backtrack only triggers from R4 and R5. R6 (max rejections), R1 (fake success),
R3 (empty success), and R7 (intent drift) behavior is unchanged.

### Policy additions

```json
{
  "engine": {
    "backtrack_enabled": true,
    "backtrack_max_depth": 3,
    "backtrack_preserve_discoveries": true
  },
  "prompt": {
    "max_emphasize_l2": 5,
    "max_emphasize_l1": 3,
    "max_expand_l1": 1,
    "max_confusion_points": 3
  }
}
```

## 2.8.0 (2026-08-05)

**L2 Pointer Mode, Sub-Goal ID referencing, and Drift Clarification.** Three
independent improvements that together reduce MCP tool result size by ~60% at
L2, eliminate Jaccard-based semantic guessing for sub-goal matching, and give
the agent a way to explain intentional pivots before enforcement rejects them.

### L2 Pointer Mode (`l2_pointer_enabled`)

When an L2 prompt's full state blob (~40K chars) is returned as an MCP tool
result, it is a prime target for context compaction — and when it disappears,
the agent loses all cognitive state. The pointer mode solves this by keeping
the full state exclusively in `.loopforge/state/<loopId>-state.md` and
rendering a structured dashboard in the prompt instead.

- **New policy field `l2_pointer_enabled`** (default `true`). When enabled, L2
  prompts skip the inline `fullStateMarkdown` blob and rely on the structured
  path B sections. The state file remains the durable source of truth — it is
  written every round regardless of level.
- **Four missing sections added to L2 path B** (previously only available in
  the full state markdown):
  - **Progress Dashboard** — criteria met/remaining, completion estimate, test
    results, files changed.
  - **Retired Constraints** — constraints the agent has withdrawn, shown
    struck-through.
  - **Inactive Constraints** — discovered constraints demoted after prolonged
    inactivity, with decay metadata (last violated, rounds inactive).
  - **Agent Trust** — current trust score with visual bar, plus trend over the
    last 10 rounds.
- **L2 prompt size reduced from ~25–40K to ~15K** (60% reduction). The
  structured dashboard is small enough to survive context compaction, and the
  "⚠️ Read the full state file before acting" instruction (from P1) now has
  genuine force — the model must read the file for complete state.
- **`compileLoop()`** conditionally passes `fullStateMarkdown: undefined` when
  `l2_pointer_enabled && level === "l2"`, forcing `l2Sections()` to take the
  structured path B.
- Backward compatible: set `"l2_pointer_enabled": false` in `loop_policy.json`
  to restore the pre-2.8 inline blob behavior.

### L0 / L1 / L2 Behavior Matrix

| Level | Trigger | Prompt Content | ~Size | State File |
|-------|---------|----------------|-------|------------|
| **L0** | Retry after rejection, empty failed round | Objective + task + hard constraints + verification flags + retry requirements + optional changes | ~3K | Always written (full canonical state) |
| **L1** | Normal continuation | L0 base + active constraints + remaining criteria + blockers + compact sub-goal dashboard (max 5, with IDs) + discoveries + rolling outcomes + recurring issues + next_action | ~7K | Always written |
| **L2 (pointer)** | First round, plan boundary, recovery, periodic refresh, drift | L1 base + full structured dashboard: milestones, full sub-goal dashboard (with IDs), Progress Dashboard, Retired/Inactive Constraints, Agent Trust, loop synthesis | ~15K | Always written (sole source of full detail) |
| **L2 (blob)** | `l2_pointer_enabled: false` | L1 base + monolithic full state markdown inline | ~40K | Always written (redundant with inline blob) |

### Sub-Goal ID Referencing

Sub-goals have always had stable IDs (`sg-XXXXXXXX` derived from description
hash), but the agent never saw them — so `matchSubGoal()` had to guess which
sub-goal the agent meant using Jaccard token similarity on natural-language
descriptions. Now IDs are visible and matchable.

- **Sub-goal IDs rendered in prompts** — L1 compact dashboard, L2 full
  dashboard, and the state file all show `[\`sg-XXXXXXXX\`]` before each
  sub-goal description. The agent can copy-paste IDs into its self-evaluation.
- **`matchSubGoal()` now tries exact ID match first**, then falls back to
  Jaccard similarity on descriptions. If the agent writes `"sg-a3f2b1c0"` in
  `completed_subtasks`, it matches deterministically without any semantic guesswork.
- **`buildSelfEvalBlock()` template updated** — placeholder values for
  `completed_subtasks` / `blocked_subtasks` / `canceled_subtasks` now show the
  ID format and reference the Sub-Goal Dashboard.
- **Fully backward compatible** — the agent can still use natural-language
  descriptions; Jaccard fallback is unchanged.

### Drift Clarification

When the verification gate detects intent-action drift (the agent said it would
do X but did Y), the enforcement gate R7 would reject the round immediately —
even if the pivot was intentional and well-reasoned. Now the agent gets a chance
to explain.

- **New `drift_clarification` field** on `SelfEvaluation` and
  `LoopRoundResult`. Carried through the full pipeline: self-eval parsing →
  vault persistence → round compilation.
- **Conditional prompt injection** — `buildSelfEvalBlock()` now accepts an
  optional `prevDriftFlags` parameter. When the previous round had
  `intent_drift` or `subgoal_drift` flags, the self-eval template includes a
  `drift_clarification` field and a "⚠️ Drift Detected" notice asking the
  agent to explain the pivot.
- **R7 enforcement softened** — `enforceIntentDrift()` now checks
  `drift_clarification`. If the agent provides a substantive explanation (≥ 20
  characters), the rejection is waived. Empty, absent, or too-short
  clarifications still trigger the normal reject → terminate path.
- **Clarification is not a free pass** — consecutive drift flags without
  meaningful clarification still escalate to termination. And the verification
  gate still produces drift flags honestly; only enforcement is affected.

### File-Level Changes

| File | Changes |
|------|---------|
| `protocol.ts` | `drift_clarification` field on `SelfEvaluation` + `LoopRoundResult`; sub-goal field comments updated for ID usage |
| `self-eval.ts` | Parse `drift_clarification` in `buildSelfEvaluation()` |
| `policy.ts` | New `l2_pointer_enabled` field on `PromptPolicy` (default `true`) |
| `prompt-assembler.ts` | Sub-goal IDs in L1/L2 dashboards; 4 new sections in L2 path B (Progress, Retired, Inactive Constraints, Agent Trust) |
| `canonical-state.ts` | Sub-goal IDs in state file sub-goal dashboard |
| `loop-compiler.ts` | `matchSubGoal()` ID-first matching; `buildSelfEvalBlock()` drift injection + ID hints; `compileLoop()` L2 pointer mode |
| `enforcement-gate.ts` | R7 accepts `drift_clarification` ≥ 20 chars |
| `engine.ts` | Propagate `drift_clarification` to `LoopRoundResult` |
| `mcp/session.ts` | Propagate `drift_clarification` through session pipeline |

**429 tests (was 415). Zero new dependencies, zero new persistence formats,
zero breaking protocol changes.**

**Enforcement diagnostic feedback and human-in-the-loop escalation.** The
enforcement gate now tells the agent *exactly* which claims don't match
evidence, and escalating rules (R4/R5/R6) issue a "Seek Human Guidance"
notice before terminating — giving the agent one more chance to course-correct.

### Diagnostic Feedback

- **`buildDiagnosticGap()`** — new helper that translates `VerificationFlag[]`
  into a structured "Evidence Gap" section in the rejection prompt. Each
  error/warn flag becomes a concrete claim-vs-evidence mismatch statement
  (`🚫 [check] field — detail`), so the agent knows precisely what to fix
  instead of retrying blindly.
- **`buildRejectionPrompt()` now accepts `verificationFlags`** (optional,
  default `[]`). When flags are present, the "Evidence Gap" section is
  inserted between the enforcement reason and the required fix instructions.
- **`RoundCoordinator.processRound()`** passes verification flags through to
  `buildRejectionPrompt()` so the diagnostic gap is always populated on reject.

### Enforcement Escalation ("Soft Pause")

- **`enforcement_escalation_enabled`** — new `EnginePolicy` field (default
  `true`). When enabled, enforcement rules that would destroy the loop now
  issue one final escalated rejection urging the agent to seek human guidance.
- **`buildEscalationNotice()`** — appends a "🆘 Escalation — Seek Human
  Guidance" block to `fix_instructions`, telling the agent to pause and ask
  a human before its next attempt.
- **R4 (`enforceProgressStall`):** 2nd consecutive rejection now escalates
  instead of terminating; 3rd terminates. (Was: 2nd → terminate.)
- **R5 (`enforceProgressStallTerminal`):** now accepts `consecutiveRejections`;
  1st detection escalates, 2nd terminates. (Was: immediate terminate.)
- **R6 (`enforceMaxRejections`):** escalation on → 2 rejections escalate,
  3 terminate. (Was: 2 rejections → terminate.) Disabled mode unchanged.

Set `enforcement_escalation_enabled: false` to restore the pre-2.7 behaviour
(exact same termination thresholds as 2.6).

**412 tests (was 410). No protocol or persistence format changes.**

## 2.6.0 (2026-07-27)

**Slim-down release.** Eight redundant or dead-code areas removed — approximately
400 lines deleted with zero functional loss.

### Removed

- **`CheckpointSummary`** — superseded by `MilestoneSummary` (kind: `agent_declared`)
  since v2.5. Type, factory, and all exports deleted.
- **`interop.ts`** — experimental cognitive checkpoint bridge with zero consumers.
  `addCheckpointSink()` and all sink notification logic removed from `SessionManager`.
- **`feedbackWriteBuffer`** — batch-write buffer in `LoopForgeEngine` that was
  always flushed immediately. Replaced with direct `appendEntry()` write.
- **`circuit_breaker_count`** — dead field on `SessionState` left over from the
  v2.5 circuit breaker removal.
- **`EngineMetrics` dead fields** — `vaultWriteTimeouts`, `vaultWriteBytes`,
  `silentAnalysisErrors`, `hydrateCacheMisses` were initialised to 0 and never
  incremented. Removed from metrics snapshots and MCP status output.
- **`heuristicSelfEvaluation`** — 20-line keyword-matching fallback in
  `self-eval.ts`. If the agent can't produce a structured self-evaluation,
  the round now stalls immediately instead of guessing.
- **`ReplayBackend.diff()`** — ~100-line round-to-round diff method with no
  MCP tool or library API consumer.
- **`observability.ts` span abstraction** — `startSpan` / `TraceSink` /
  `TraceSpan` / `TraceContext` removed. The `TraceSink` pattern was called
  once in production code. `logEvent` retained for structured lifecycle events.
- **`feedbackBufferFlushes` / `feedbackBufferMaxSize`** — metrics removed along
  with the write buffer.

**410 tests (was 422). Protocol `$defs`: 29 (was 30).**

## 2.5.0 (2026-07-27)

**Code quality, documentation and functional enhancements** — six technical debt fixes plus
four feature improvements across the compiler, enforcement gate, session pipeline, and policy layer.

### Bug Fixes & Technical Debt (v2.5.0)

- **Unified Jaccard similarity** (`token-utils.ts`): single `jaccardSimilarity()` function with
  consistent CJK tokenization (`[a-z0-9㐀-鿿]+` covering Extension A). Replaces three duplicated
  implementations with diverging Unicode ranges across `loop-compiler.ts`, `verification-gate.ts`,
  and `canonical-state.ts`.
- **Shared vault helpers**: `unique()` and `entryRound()` moved to `token-utils.ts`, eliminating
  duplicated implementations across four source files.
- **MemoryBackend prefix disambiguation**: `queryEntries()` no longer matches `r10`–`r19` when
  the caller queries for `r1`. Only applies the digit-guard when the prefix itself ends with a digit.
- **`progress_stall_threshold` reads from policy**: `enforcement-gate.ts` R4 now calls
  `getPolicy().evolution.progress_stall_threshold` instead of hard-coding `0.05`.
- **`VaultBackendLoopStore.readRound()` returns complete documents**: now parses `lineage`,
  `feedback`, `transaction`, and `promptArtifact` — same structure as `FileLoopStore.readRound()`.
- **`buildLoopRequest` uses factory**: `session.ts` now calls `makeLoopRoundResult()` instead
  of inline object literal, eliminating drift risk when new `LoopRoundResult` fields are added.
- **`replay.ts` removes phantom field access**: `entry.task` fallback removed — `VaultEntry`
  does not have a top-level `task` property.
- **`evidenceLatencyAvgMs` metric added**: `PolicyMetricsSnapshot` now includes
  `evidenceLatencyAvgMs` (derived from `evidenceLatencyMs / evidenceCaptures`), replacing
  the meaningless monotonically-accumulating raw sum.
- **IEEE 754 epsilon comparison**: `enforceProgressStallTerminal()` (R5) switched from
  strict `===` to `Math.abs(a - b) < 1e-10`, preventing false negatives from JSON round-trip
  float drift.
- **Unknown policy key warning**: `deepMerge()` now logs `console.warn` for keys not present
  in the default policy — a typo like `"max_round"` instead of `"max_rounds"` is no longer silent.
- **Removed legacy circuit breaker**: `shouldBreak()` method and all call sites deleted from
  `engine.ts`. Stall detection is exclusively handled by enforcement gate R4/R5 using
  `progress_estimate` gradients. `StopReason."circuit_breaker"` retained for backward-compat.
- **`parseWarnings` replaced by structured data**: deleted the regex-based warning extractor
  in `session.ts`. Warnings now flow from `LoopCompileResponse.warnings` → `LoopForgeResponse`
  → `PreparedRound` → `McpSession.currentWarnings`. No more fragile prompt-format dependency.
- **10 similarity thresholds externalized to policy**: six new `EvolutionPolicy` fields
  (`criteria_dedup_threshold`, `subgoal_dedup_threshold`, `subgoal_match_threshold`,
  `subgoal_auto_in_progress_threshold`, `constraint_match_threshold`,
  `subgoal_drift_alignment_threshold`) replace hard-coded magic numbers in `loop-compiler.ts`
  and `verification-gate.ts`.
- **`withoutPrompts` pattern-based filtering**: replaced manual allow-list with regex
  `\bprompt\b` match — any new prompt-text field is automatically redacted from CLI output.
- **Heuristic mode partial enforcement**: `enforcement-gate.ts` now runs for ALL extractions,
  not just structured ones. R3/R4/R5 self-skip when `skipEvidenceRules=true`; R1/R2/R6/R7
  always execute, giving heuristic-mode loops minimum enforcement protection.
- **Windows PID lease detection**: `isLeaseOwnerAlive()` now accepts optional
  `leaseExpiresAt` parameter — on Windows where `process.kill(pid, 0)` returns ambiguous
  `EPERM`, an expired lease overrides the "alive" assumption. `FileLoopStore` lock recovery
  receives the same treatment.

### Functional Enhancements (v2.5.0)

- **L2 adaptive budget sub-goal factor**: formula extended to
  `base + round×200 + milestones×1000 + subGoals×100`, capped at 40000.
  Policy: `prompt.l2_adaptive_subgoal_factor` (default 100).
- **Agent trust score**: `agent_trust_score` and `agent_trust_trend` derived from
  verification gate flags each round. Formula: `1.0 - errors×0.15 - warns×0.03`.
  Rendered in state file as "## Agent Trust" bar + trend line. Zero new persistence.
- **Milestone/Checkpoint unification**: `CheckpointSummary` deprecated in favor of
  `MilestoneSummary` (kind: `agent_declared`). `checkpoint()` function removed from
  compiler (~30 lines). `canonical-state.ts` derives checkpoints from milestones.
- **Stop reason refinement**: `SelfEvaluation.stop_reason` field added
  (`"gave_up"` | `"blocked"` | `"needs_human_input"`). `"blocked"` maps to
  `StopReason."blocked"` (previously unused). Backward-compat: absent `stop_reason`
  defaults to `"failed"` behavior.

### Documentation

- Verification gate check count corrected (10 → 11) across all docs
- Enforcement gate rules listed as R1–R7 throughout
- Test count updated (417) in both README and Chinese README
- Version references in `AGENTS.md` and `loopforge/README.md`

**422 tests (was 417 in 2.4.0).**

## 2.4.0 (2026-07-27)

**Long-Horizon Task Infrastructure** — four compiler-level features that make LoopForge
viable for 100+ round, multi-session agent tasks.

### Hierarchical Summary (v2.1)

Flat rolling-window summary replaced with three-tier hierarchical summary:

- **Tier 1 — Recent Window**: detailed last N rounds (preserves existing `buildRollingSummary` behavior)
- **Tier 2 — Milestone Summaries**: phase-boundary snapshots that survive window eviction. Three trigger signals in priority order: `agent_declared` (compression_checkpoint) > `criteria_milestone` (new success criteria detected via Jaccard semantic dedup at threshold 0.45) > `auto` (safety net every 20 rounds)
- **Tier 3 — Loop Synthesis**: formulaic paragraph summarizing total rounds, phase count, overall progress, and constraint summary

Milestones are rebuilt from vault entries each round — zero new persistence. Rendered in L2 prompts and always written to state file.

**New types**: `MilestoneSummary` (label, round_range, outcome, carried/resolved constraints, progress_at_boundary, kind). Extended `RollingSummary` with `milestones` and `loop_synthesis`.

**Policy**: `summary.milestone_interval` (20), `summary.max_milestones` (10), `summary.enable_loop_synthesis` (true).

### Sub-Goal Structured Tracking (v2.2)

`emerged_subtasks` upgraded from flat `string[]` to compiler-managed `SubGoal[]` with five-state lifecycle: `pending → in_progress → done | blocked | canceled`.

- **Agent declares** via three new `string[]` fields: `completed_subtasks`, `blocked_subtasks`, `canceled_subtasks` — string arrays matched by description similarity, no structured JSON burden on agent
- **Compiler derives**: `in_progress` from `next_action` match, `done` from `completed_subtasks` or `success_criteria_met` auto-complete, `blocked`/`canceled` from agent declarations
- **Sub-Goal Dashboard**: rendered in L2 (full: in_progress + pending by age desc + blocked + recent 5 done + stats line) and L1 (compact: active only, max 5)
- **Verification Gate**: new `checkSubGoalDrift` — warns when 3+ pending sub-goals exist but `next_action` aligns with none
- **Milestone bridge**: all sub-goals done → auto `criteria_milestone` — no agent declaration needed

**New types**: `SubGoal` (id, description, status, declared_at_round, status_changed_at_round, completed_at_round, priority). Extended `SelfEvaluation` and `LoopRoundResult`.

**Policy**: `evolution.subgoal_auto_complete_threshold` (0.4), `evolution.subgoal_stale_rounds` (10), `evolution.max_subgoals_in_prompt` (10), `evolution.max_done_subgoals_in_prompt` (5).

### Time-Aware Constraint Management (v2.3)

Discovered constraints auto-demote to `inactive` after prolonged inactivity — removed from prompts but kept in state file.

- **Source classification**: `constraintSource()` identifies hard/plan/criteria/discovered origin. Only discovered constraints auto-decay
- **Inactivity detection**: scans vault entries for `last_violated_at_round`. No violation for `constraint_inactive_rounds` (default 15) → demote to inactive
- **Re-activation**: inactive constraint violated again → auto re-promote to active
- **Effect on prompts**: inactive constraints removed from `constraints_active` → automatically absent from L1/L2 prompts. State file renders full "Inactive Constraints" section with age metadata
- **Zero new persistence**: all metadata reconstructed from vault entries each round

**New types**: `ConstraintMeta` (text, discovered_at_round, last_violated_at_round, source, status). Extended `LoopCompileResponse`.

**Policy**: `evolution.constraint_inactive_rounds` (15).

### Adaptive L2 Prompt Budget (v2.4)

L2 budget scales with loop complexity instead of static 18k chars:

```
adaptiveL2 = min(base + round × 200 + milestones × 1000, cap=40000)
```

- L0 (3000) and L1 (7000) unchanged — only L2 adapts
- Short tasks (≤ 5 rounds): negligible change (19k)
- Long tasks (80 rounds, 8 milestones): 40k budget (2.2× more context)
- Hard cap at 40k prevents unbounded growth

**Policy**: `prompt.l2_adaptive_enabled` (true), `prompt.l2_adaptive_round_factor` (200), `prompt.l2_adaptive_milestone_factor` (1000), `prompt.l2_adaptive_max_chars` (40000).

### Cumulative scope

All four features are compiler-level — no new storage formats, no sub-loop execution, no agent autonomy violation. The agent still owns execution; LoopForge provides progressively better cognitive infrastructure as tasks grow longer.

**14 new protocol types, 298 tests (was 288 in 2.0.2).**

## 2.0.2 (2026-07-23)

### Changed

- **Enforcement gate: progress-based stall detection replaces binary circuit breaker.**
  The old binary-success circuit breaker (3 consecutive failures → stop) has been
  removed from `RoundCoordinator`. It is replaced by two enforcement gate rules:
  - **R4 `progress_stall`**: progress_estimate delta < 5% over 3 rounds → reject
    on first occurrence (agent gets a chance to change approach), terminate on repeat.
  - **R5 `progress_stall_terminal`**: progress_estimate delta = 0 for N consecutive
    rounds → terminate immediately (agent is making zero forward motion).
    These rules use `progress_estimate`, not the binary success flag, so they correctly
    distinguish "task not done yet" from "agent is stuck".

- **Removed `runtime` module** (`runtime.ts`) — the standalone event-driven Agent
  executor is no longer part of LoopForge. All round processing now goes through
  the MCP session path (`SessionManager → RoundDriver → RoundCoordinator`).

- **Removed `RuntimePolicy`** from `loop_policy.json`. `max_rounds` moved to
  `engine` policy section.

- **Extracted `self-eval.ts`** — self-evaluation parsing helpers (`parseExecutionEvidence`,
  `parseCriterionRevisions`, `parseWorkerResults`, `extractSelfEvaluation`,
  `buildSelfEvaluation`, `heuristicSelfEvaluation`) moved from `engine.ts` to a
  dedicated module.

- **Added `loop-extras-parser.ts`** — typed request extraction pipeline with
  structured error collection, replacing inline `Record<string, unknown>` casts in
  `engine.ts`.

- **MCP `evaluation` parameter** now includes `compression_checkpoint`, `checkpoint_label`,
  and `next_action` fields.

- **`AdvanceResult.stopDetail`** field added to provide human-readable context when a
  loop stops.

- **Intent-action drift detection** — the `next_action` field is no longer decorative.
  Verification Gate check 11 (`intent_drift`) compares the previous round's declared
  `next_action` with the current round's `output_summary` via Jaccard token similarity.
  Below the configurable threshold (`evolution.intent_drift_threshold`, default 0.15),
  a warn-level flag is raised. Enforcement Gate R7 (`intent_drift`) rejects on first
  occurrence (agent must explain the pivot), terminates on repeat. This closes the
  loop between "what I said I would do" and "what I actually did."

### Added

- **7 enforcement rules** (was 5): R1 success_with_remaining_criteria, R2 recurring_violation,
  R3 empty_success, R4 progress_stall, R5 progress_stall_terminal, R6 max_rejections,
  R7 intent_drift.

- **10 verification checks**: check `intent_drift` detects when the agent
  performs work unrelated to its declared next_action from the previous round.

- **`evolution.intent_drift_threshold`** policy field (default: 0.15) — Jaccard token
  similarity threshold for intent-action alignment.

## 2.0.1 (2026-07-21)

### Removed

- **Deprecated `quality` field** from `AdvanceResult`. The `quality` field was
  marked `@deprecated` in 2.0.0 and always derived from `roundSuccess`. MCP tool
  consumers should use `roundSuccess` instead.

### Added

- **`stopDetail` field** in `AdvanceResult`. Each stop reason now carries a
  human-readable explanation of what happened, giving the external Agent enough
  context to decide its next action without LoopForge prescribing behavior.

- **`## How to Complete This Round` section** in every compiled prompt. The
  prompt now includes explicit instructions on how to submit results via
  `loopforge_next`, what `success` and `should_continue` mean, and what to do
  when a round is rejected.

- **31 new tests** for the typed extraction pipeline (`loop-extras-parser.ts`).
- **3 new tests** covering prompt hash determinism, attempt differentiation,
  and L0 budget enforcement.

### Changed

- **Git evidence capture is now async and parallel.** Three git commands
  (`diff`, `diff --cached`, `ls-files`) run concurrently via `execFile` instead
  of sequentially via `execSync`. Wall-clock time drops from sum(3) to max(1)
  command duration. A unified `AbortController` timeout replaces per-command
  timeouts. All git commands are now shell-free (`execFile`, not `exec`).

- **`engine.ts` extras parsing** extracted to `loop-extras-parser.ts`. The
  `ExtractionContext` class provides typed field extraction with per-field
  error collection — never throws, always returns best-effort defaults.

- **`advanceUnlocked()` split** into 6 focused private methods
  (`extractEvaluation`, `executeRoundTransaction`, `buildRejectionResult`,
  `buildTerminationResult`, `buildStopResult`, `advanceToNextRound`).
  The orchestrator is now ~40 lines.

- **Self-evaluation template** now explicitly warns the Agent to replace
  placeholder values with actual data.

- `interop.ts` marked as `@experimental` in JSDoc and both README files.
- Test count: 237 → 271.

## 2.0.0 (2026-07-13)

This release changes LoopForge from a prompt-technique framework into
a recoverable cognitive state runtime driven by an external Agent.

### Breaking changes

- Replaced `loopforge-mcp` with the unified `loopforge` command. Start the MCP
  server with `loopforge mcp`.
- Removed `Technique`, `Analysis`, `vault_config`, strategy routing, the
  prompt-technique catalog, MCP Tasks, automatic memory discovery, and Markdown
  lineage recovery.
- Replaced the shared PromptCraft vault with typed per-loop JSON documents under
  `.loopforge/loops/`. Use `loopforge migrate` to import a legacy vault without
  deleting it.

### Runtime and prompts

- Added one canonical loop state and one prompt assembly pass. L0, L1, and L2
  now control state density only.
- Added stable round IDs, prompt artifacts, attempt numbers, before and after
  evidence, zero-commit rejection, and idempotent recovery of committed rounds.
- Runtime and MCP now share the same RoundDriver and round transaction path.
- Fixed pause, resume, stop, concurrent next, timeout, stalled executor, signal,
  and terminal cleanup state combinations.

### Storage, evidence, and observability

- Added atomic, locked, hash-isolated `FileLoopStore` session and round
  documents. Markdown state files remain optional derived views.
- Added async evidence isolation and explicit `CommandEvidenceProvider` support
  with shell-free execution, workspace cwd checks, output limits, abort, and
  required-command verification.
- Added structured tracing, policy metrics, renewable cross-process session
  leases, and portable checkpoint sinks without runtime dependencies.

### MCP and CLI

- Added strict runtime validation for MCP tool arguments and safe handling of
  primitive JSON-RPC input.
- MCP tools return structured output and serialized text. MCP Tasks are not
  implemented because the client Agent owns long-running execution.
- Added `init`, `doctor`, `inspect`, and `migrate` CLI commands.

## v1.19.0 (2026-07-12)

Execution Strategy Hints — L1 advisory mode gets lightweight, task-aware execution guidance
instead of the single `"direct"` label. Perception SKILL.md trimmed from 310 to 203 lines
with corrected L1 behavior description.

### Execution Strategy Hints
- **`ExecutionStrategy` type** — New type in `builder.ts`. Five strategies: `direct`,
  `investigate`, `decompose`, `compare`, `verify`. Each provides a 2–3 sentence hint
  without imposing a full reasoning technique framework.
- **`detectStrategySignals(task)`** — New function. Keyword-based signal detection returning
  `{ bug, rootCause, multiStep, compare, verify }` booleans. Uses prefix matching (`\bword`
  without trailing `\b`) so "crashes", "errors", "migration" match correctly.
- **`selectExecutionStrategy(task, override?)`** — New function. Priority-ordered heuristic:
  rootCause → investigate, multiStep → decompose, compare → compare, verify → verify,
  default → direct. `override` parameter allows users to pin a specific strategy via policy.
- **`buildStrategyHintBlock(decision)`** — New function. Formats a markdown block with
  `### Execution Strategy: [name]`, the hint text, and `"Execute the task directly.
  Do not generate another prompt."` — an anti-meta-prompt guarantee.
- **`SpecialistOpts.strategyHintBlock`** — New optional field. When provided, replaces the
  generic "Execution Instructions" block in `compileGeneric()`. Undefined by default
  (backward compatible).
- **`compileL1()` advisory block** — When `technique.mode` is `"advisory"` (default),
  computes a strategy hint via `selectExecutionStrategy()` + `buildStrategyHintBlock()`
  and passes it to `compileGeneric()`. Legacy and disabled modes are unaffected.
- **`TechniquePolicy.execution_strategy`** — New policy field. Accepts `"auto"` (default,
  heuristic-driven) or a specific strategy name (`"direct"`, `"investigate"`, etc.).
  Only applies in advisory mode; ignored in legacy and disabled modes.
- **`loop_policy.json`** — Added `"execution_strategy": "auto"` to technique block.

### Perception SKILL.md
- **P1 Fix** — L1 description corrected from "technique keyword-routed from Tier 1" to
  "direct execution (advisory mode, default) or keyword-routed Tier 1 (legacy mode)".
  L2 technique selection softened from mandatory "read" to conditional "if available, read".
  Rule 5 updated to say "follow the compiled prompt instructions" instead of "follow the
  keyword-routed technique."
- **P2 Trimming** — Trimmed from 310 lines to 203 lines. Removed marketing language,
  legacy `---loopforge-eval` block note, standalone Tool Reference table (merged into
  step-by-step). Collapsed Delegation Helpers from 44 lines to ~12 lines. Shortened
  full worked example from 47 to ~18 lines. Condensed "Why this matters" editorial
  to 2 sentences.

### Tests
- **332 tests** (was 286). 46 new tests:
  - `strategy.test.ts` (new file): 16 signal detection tests + 18 strategy selection tests
    (including priority ordering and override behavior) + 3 hint format tests.
  - `loop-compiler.test.ts`: 9 integration tests covering L1 strategy hint injection
    (investigate, direct, decompose, verify), legacy/disabled mode exclusion, policy
    override, multi-round persistence, and anti-meta-prompt guarantee.

### Documentation
- Root README.md and README.zh-CN.md: v1.19 hero banner, Philosophy block, L1 description
  in How It Works, Recompile Levels table, Execution Strategy Hints feature section,
  Agent Technique Autonomy section updated. Test count: 286 → 332.

---

## v1.18.0 (2026-07-12)

Pause/Resume + EvidenceProvider Interface — two structural improvements that build on the
Phase 2 RoundCoordinator unification and mandatory evidence enforcement.

### Pause/Resume
- **`RuntimeStatus.PAUSED`** — New runtime status. Loop is suspended at round boundary,
  signal handlers stay registered, memory writeback is skipped. Resumable from `currentRound`.
- **`LoopRuntime.pause()` / `resume()`** — Pause suspends the loop at the next iteration;
  resume re-enters via `_continue()` which picks up from `currentRound` without reset.
  Paused loops keep heartbeat and signal handlers registered.
- **SIGINT Double-Tap** — First `Ctrl+C` pauses (safe), second within `pause_double_tap_ms`
  (default 3000ms) forces stop. Configurable via policy; set to 0 to disable (always stop).
- **`SessionManager.pause()` / `unpause()`** — Pause persists session to vault with status
  `"paused"`. Unpause reconstructs from vault and compiles the next prompt. `autoResumeAll()`
  recovers both `"running"` and `"paused"` sessions on MCP server startup.
- **`loopforge_pause` MCP tool** — New tool. Pause a running session with vault persistence.
- **`loopforge_resume`** — Extended to handle both crash-recovery (running) and paused sessions.
  First tries `resume()` for crash-recovery, falls back to `unpause()` for paused sessions.
- **`McpSession.status`** — Added `"paused"` to status union. `McpSessionSummary` updated.
- **`StopReason."paused"`** — New stop reason. `STOP_REASON_OUTCOME_MAP` and
  `LoopMemoryWriteback.outcome` updated.
- **`RuntimePolicy.pause_double_tap_ms`** — New policy field (default 3000).

### EvidenceProvider Interface
- **`EvidenceProvider`** — New interface. `name: string` + `capture(): ProviderSnapshot | null`.
  Providers return null when unavailable (e.g. git not installed) — pipeline degrades gracefully.
- **`ProviderSnapshot`** — New type. `{ provider, timestamp, files, data }`. Carries structured
  evidence from each provider into the verification pipeline.
- **`EvidenceCollector`** — Runs all configured providers, silently skips unavailable ones.
  Used by both `runtime.ts` and `session.ts` instead of direct `captureGitModifiedFiles()` calls.
- **`GitEvidenceProvider`** — Built-in provider wrapping `captureGitFileState()`. Captures
  tracked, staged, and untracked file changes into a structured `ProviderSnapshot`.
- **`extractFilesFromSnapshots()`** / `diffSnapshots()`** — Utility functions. Extract merged
  file list from snapshots (backward compat with `runtimeFilesChanged`), and compute
  before→after diffs for `runtime.ts`.
- **`round-coordinator.ts`** — `RoundProcessInput` gains optional `evidenceSnapshots` field.
  Passed through to `verifySelfEvaluation()`.
- **`verification-gate.ts`** — `verifySelfEvaluation()` gains optional `evidenceSnapshots`
  parameter. New `checkEvidenceIntegrity()` cross-validates agent-reported `files_changed`
  against git provider snapshot. 7 checks total (was 6).
- **`EvidencePolicy`** — New policy section. `providers: string[]` — which providers to enable.
  Default: `["git"]`. Added to `DEFAULT_POLICY` and `loop_policy.json`.
- **`runtime.ts` / `session.ts`** — Replaced direct `captureGitModifiedFiles()` calls with
  `EvidenceCollector` + `GitEvidenceProvider`. Unused import removed from both files.

### Exports
- **`index.ts`** — New exports: `EvidenceCollector`, `GitEvidenceProvider`,
  `extractFilesFromSnapshots`, `diffSnapshots` (values), `ProviderSnapshot`,
  `EvidenceProvider` (types).

### Tests
- 286 tests (was 284). All existing tests pass without modification.

---

## v1.16.0 (2026-07-12)

Cognitive State Runtime — the project repositions from "Prompt Compiler" to
"State Runtime." Three Runtime-ification improvements make state management a
Runtime guarantee instead of a Prompt request.

### State File Inline Injection
- **`StateFilePolicy.inline_in_prompt`** — New policy field (default `true`). When
  enabled, the full state file content is prepended directly into the prompt —
  the Agent no longer needs to remember to read `.loopforge/state/{id}-state.md`.
  State injection is now a Runtime guarantee, not a Prompt request.
- **`compileL1()` / `compileL2()`** — Conditionally inline state file content
  based on `inline_in_prompt` policy. File is still written to disk as fallback.

### Git Diff Auto-Detection
- **`captureGitModifiedFiles()`** — New function in `verification-gate.ts`. Captures
  `git diff --name-only` before and after each agent execution round.
- **`checkFilesIntegrity()`** — New verification check. Compares agent-reported
  `files_changed` against git reality. Raises `warn` flag on mismatch.
  Gracefully degrades when git is unavailable (returns null → check skipped).
- **`verifySelfEvaluation()`** — New optional 5th parameter `runtimeFilesChanged`.
  Integrated into `runtime.ts` execute cycle.

### Evidence Block
- **`EvidenceSnapshot`** — New protocol type. Four categories: ✅ Verified,
  🔄 Pending, ❌ Invalidated, 💡 Discovered — aggregated from accumulated
  SelfEvaluation data.
- **`buildEvidenceSnapshot()`** — New function in `loop-compiler.ts`. Derives
  evidence from loop objective, last round result, and rolling summary.
- **`renderStateFile()`** — Renders `## Evidence` section in state file with
  four-quadrant view (empty categories hidden).

### Agent Reflection — next_action
- **`SelfEvaluation.next_action`** — New optional field. Agent declares its
  intended next step ("下一轮我要调查缓存层").
- **`LoopRoundResult.next_action`** — Carries the declaration forward.
- **`renderStateFile()`** — Renders `## Agent's Declared Next Action` in state file.
- **`compileL1()` / `compileL2()`** — Injects `### Your Declared Next Step`
  block into the prompt.

### Brand Repositioning
- README, CLAUDE.md, package.json, README.zh-CN.md, perception SKILL.md —
  repositioned from "Loop-Time Intelligence Layer / Prompt Compiler" to
  "Cognitive State Runtime."

---

## v1.15.0 (2026-07-09)

Agent Technique Autonomy at L2 — the Agent now freely chooses reasoning strategies
by reading the technique catalog instead of having LoopForge auto-select via keyword routing.

### L2 Restart Rework
- **`buildL2Prompt()`** — New function. Generates L2 prompts with a Technique Selection block
  that instructs the Agent to read `skills/prompt-techniques/SKILL.md`, freely choose the
  best technique based on loop state, read the corresponding reference file, and apply it
  directly. No technique skeleton is embedded — the skill reference files are the Agent's
  working manual.
- **`compileL2()`** — No longer calls `routeTechniqueAdaptive()` or dispatches to specialist
  compilers. Uses `buildL2Prompt()` instead. `technique_used` set to `"agent-selected"`,
  `reference_file` set to `"skills/prompt-techniques/SKILL.md"`.

### Strategy Collapse Removal
- **`strategyCollapse()`** — Removed. The "3 consecutive failures → force L2" gate in
  `decideLevel()` is gone. The decision to restart strategy belongs to the Agent (via
  checkpoint declaration), not to a failure counter.
- **`decideLevel()` Gate 4** — Removed. L2 now triggers on: Round 1, plan_source,
  checkpoint boundary, goal_id change.
- **`computeAdvisories()` strategy_collapse warning** — Removed.

### Tier Escalation Removal
- **`countConsecutiveFailures()`** — Removed from `builder.ts`.
- **`routeTechniqueAdaptive()` escalation branch** — Removed. No longer counts failures
  or forces Tier 2 techniques. Simplified to: checkpoint → all 7 techniques, normal → Tier 1 only.
- **`tier2_escalation_failures`** — Deprecated in `policy.ts`. Field retained for config
  compatibility but no longer consumed.

### Specialist Compilers
- `compileStepBack`, `compileLeastToMost`, `compileToT`, `compileGeneric` — All **preserved**.
  Still used by L1 for keyword-routed technique prompts. Only L2 no longer calls them.

### Observability
- **`tier2_escalation`** event — Deprecated. No longer emitted.

---

## v1.15.1 (2026-07-09)

Bug fixes and policy completeness for the Thin Prompt architecture.

### Bug Fixes
- **`state_file.enabled` now respected** — State files were written to disk regardless of the
  `state_file.enabled` policy flag. Fixed in `runtime.ts` and `mcp/session.ts` (3 call sites)
  to check `getPolicy().state_file.enabled` before writing.
- **`enforcement-gate.ts` git tracking** — The enforcement gate module was untracked despite
  being imported by `runtime.ts` and `mcp/session.ts`. Now staged in git.

### Policy
- **`loop_policy.json`** — Added missing `state_file` configuration section with defaults
  (`enabled: true`, `directory: ".loopforge/state"`, `max_checkpoints: 5`, `max_summary_rounds: 5`).
- **`write_on_outcomes`** — Corrected from `"completed"` to `"task_complete"` to match the
  actual `StopReason` enum value. Previously `"completed"` never matched any stop reason.

---

## v1.9.0 (2026-07-01)

Multi-Agent Delegation Support — LoopForge now tracks and injects sub-agent delegation
history into compiled prompts. Works with AgentTool sub-agents and Coordinator Workers
without requiring a separate "mode."

### Delegation Helpers (AgentTool Mode)
- **`filterConstraintsForSubTask(allConstraints, subTask, threshold?)`** — Pure function.
  Filters relevant constraints for a sub-agent task using Jaccard token similarity.
  Default threshold 0.15 (inclusive — lower than the 0.3 warn threshold).
- **`formatDelegationPrompt(subTask, subAgentType, constraints, options?)`** — Pure function.
  Produces self-contained prompts for Explore / General-purpose / Plan sub-agent types.
  All outputs are self-contained (no "based on above" references) — matching the
  AgentTool contract: "Workers can't see your conversation."
- **`recordDelegation(loopId, round, entries)`** — Engine method. Writes delegation
  journal entries to vault as `task_type: "delegation_journal"`.

### Worker Results (Coordinator / Multi-Agent)
- **`WorkerResult` interface** — `{ agentId, subAgentType, subTask, resultSummary, success, discoveredConstraints? }`.
  Added to `SelfEvaluation.worker_results` and `LoopRoundResult.worker_results`.
- **Auto-detection** — `buildSelfEvaluation()` parses `worker_results` from raw evaluation JSON.
  `autoFeedback()` automatically calls `recordDelegation()` when `worker_results` are present.
- **MCP schema** — `loopforge_next` evaluation schema updated with `worker_results` array property.
- **Cross-round injection** — `buildDelegationSummary(vaultContext)` scans vault for delegation
  journal entries and formats them as a `### Delegation History` table injected into the
  next round's compiled prompt.
- **Constraint flow** — Workers discover constraints → Coordinator reports via `worker_results` →
  LoopForge records to vault → next round's `Active Constraints` includes them →
  Coordinator passes them to future Workers.

### Design Principle
No `MultiAgentMode` enum. No `compileCoordination()` function. LoopForge does not
distinguish between single-agent and multi-agent execution. The main agent —
whether a single agent, an AgentTool user, or a Coordinator — receives compiled
prompts, executes, and reports results. LoopForge records, compresses, and injects.

### Protocol Changes (v1.8→v1.9)
- **1 new interface**: `WorkerResult`.
- **`SelfEvaluation.worker_results`** — optional array. Main agent reports sub-agent
  delegation results.
- **`LoopRoundResult.worker_results`** — optional array. Forwarded through
  `buildLoopRequest()` for compiler access.

### Tests
- 251 tests (was 241). 10 new tests: protocol factory defaults, constraint filtering
  (8 cases incl. CJK), delegation prompt formatting (6 cases incl. self-containment),
  delegation summary (null vault, multi-round table, failed delegations, backward compat,
  pipe escaping), schema count update.

## v1.8.0 (2026-07-01)

Memory System Integration — bidirectional bridge between LoopForge and Agent long-term memory.

### Memory Injection (Retrieval)
- **Tiered Injection Strategy** — injection frequency scales with loop length. Short loops (≤10 rounds)
  get 1 injection (Phase 1 only). Medium loops (11–20 rounds) get 2 injections (Phase 1 + Phase 3).
  Long loops (21+ rounds) get all 3 phases. Configurable via `round_tiers` in policy.
- **Refined Phase Thresholds** — Phase 2 fires at 40% progress (was 30% — too early).
  Phase 3 fires at 70% progress (was 60% — still in execution). Better alignment with real task cadence.
- **Jaccard Deduplication** — subsequent injections deduped against previous contexts (threshold 0.6).
  Prevents redundant retrieval when memory returns stale/similar results.
- **Phase-Aware Query Construction** — each phase uses a different query composition:
  Phase 1 queries task + constraints, Phase 2 queries current focus + failure patterns,
  Phase 3 queries remaining criteria + key lessons + edge cases.
- **Configurable Policy** — `memory_injection` section in `loop_policy.json`:
  `enabled`, `min_rounds_between_injections`, `phase_thresholds` (progress-based trigger points),
  `round_tiers` (tiered phase allowance by maxRounds), `dedup_threshold`, `max_context_length`.
- **Zero-Cost at L0/L1** — memory retrieval only fires when compiler level is L2.
  L0 (cache hit) and L1 (patch) rounds have zero memory overhead.

### Memory Writeback
- **Automatic on Loop End** — distilled knowledge written back to Agent memory on every stop reason
  (task_complete, circuit_breaker, max_rounds, stalled, stopped). Configurable via `memory_writeback.write_on_outcomes`.
- **Structured Payload** — `LoopMemoryWriteback` interface: 1 project entry (outcome + key discoveries), 
  ≤5 feedback entries (rule + Why + How to apply, matching claude-mem's feedback format), 
  1 reference entry (pointer to LoopForge vault).
- **Format Alignment** — feedback entries follow claude-mem's requirement of structured body: 
  rule statement + `**Why:**` + `**How to apply:**`. Project entries store absolute dates 
  (relative→absolute conversion on write).
- **Minimal Principle** — only writes what cannot be derived from current code state. 
  Code patterns stay in code; decisions, discoveries, and tactical lessons go to memory.

### Protocol Changes (v1.7→v1.8)
- **5 new interfaces**: `MemoryProviderContext`, `LoopMemoryWriteback`, `LoopMemoryWritebackProjectEntry`, 
  `LoopMemoryWritebackFeedbackEntry`, `LoopMemoryWritebackReferenceEntry`.
- **`LoopCompileRequest.external_context`** — optional field for memory context injection 
  (ignored by L0/L1, formatted into L2 prompt with priority disclaimer).
- **`RuntimeConfig.memoryProvider` / `memoryWriter`** — optional callbacks for custom memory system integration.
  Auto-detected when running with claude-mem; users can override.
- **`LoopPolicy.memory_injection` / `memory_writeback`** — externalized configuration.

### Compiler Changes
- **`formatExternalContext()`** — formats memory context as a marked section in L2 prompts with 
  explicit priority disclaimer: "If any insight contradicts the Loop Objective or Active Constraints, 
  LoopForge takes absolute precedence."
- **`tokenize()` / `jaccard()` exported** — for dedup use by runtime and MCP session manager.

### Runtime & MCP
- **`LoopRuntime`**: phase tracking (`injectionCount`, `lastInjectionRound`, `injectedContexts`, 
  `phase2Triggered`/`phase3Triggered`), `shouldInjectMemory()`, `buildAccumulatedContext()`, 
  `dedupAndStoreContext()`, `buildWritebackPayload()`.
- **`SessionManager`**: `memoryProvider`/`memoryWriter` callbacks, `doWriteback()` helper, 
  memory state persisted to vault via `loop_lineage` (injection_count, phase2_triggered, etc.).
- **`McpSession`**: 5 new memory tracking fields.
- **Async upgrade**: `create()`, `advance()`, and all MCP tool handlers now async. 
  `dispatch()` and stdin handler also async.

### Memory Bridge — Auto-Detection & Filesystem Integration
- **`memory-bridge.ts`** (~250 lines) — zero-config auto-detection of claude-mem via local filesystem.
  Scans `~/.claude/projects/{hash}/memory/` for project hash (computed from git root path,
  matching claude-mem's `[^a-zA-Z0-9] → -` algorithm). No REST API dependency, no auth tokens.
- **Retrieval via filesystem** — `createMemoryProvider()` reads `*.md` memory files directly,
  scores by keyword overlap against phase-aware query terms (Phase 1: task terms, Phase 2: + issues/patterns,
  Phase 3: + remaining criteria/lessons). Returns top-3 memories concatenated. Strips YAML frontmatter.
- **Writeback via filesystem** — `createMemoryWriter()` writes project/feedback/reference `.md` files
  in claude-mem's exact format (YAML frontmatter + structured body). Appends to `MEMORY.md` index.
  mkdir-based file lock prevents concurrent write corruption.
- **Two integration paths**:
  - MCP: `autoConfigureMemory(mgr)` sets `memoryProvider`/`memoryWriter` on `SessionManager`.
    Called automatically in `McpServer` constructor — zero user configuration.
  - Library: `tryAutoConfigure()` returns `{ memoryProvider?, memoryWriter? }`.
    Called automatically in `resolveConfig()` when no explicit callbacks provided.
- **Silent degradation** — if claude-mem is not installed or the project has no memory directory,
  both functions are no-ops. LoopForge continues normally without memory integration.
- **Explicit overrides** — user-provided `memoryProvider`/`memoryWriter` callbacks always take
  precedence over auto-detection.

### Design Rationale
- **LoopForge is not a memory system — it's a prompt compiler.** Agent memory answers "what did you do before"; 
  LoopForge answers "what should you do next, and how should you think about it." They are different layers 
  of the same cognitive stack: long-term memory (cross-session) vs working memory + executive control (within-task).
- **Not a replacement — a complement.** Agent memory cannot replace LoopForge's constraint lifecycle, 
  technique routing, or verification gate. LoopForge cannot replace Agent memory's cross-session semantic search. 
  Together they form a complete cognitive architecture: memory IN → LoopForge → memory OUT.

### Tests
- 227 tests (was 202 — 25 new memory-bridge tests covering detection, retrieval, writeback, edge cases).

## v1.3.1 (2026-06-27)

Session recovery, success criteria enforcement, and MCP tool expansion.

### Session Durability
- **`save()` / `resume()` in SessionManager** — session state persisted to vault as `session_state` entries (upsert per loop). Process restart → `resume(loopId)` reconstructs session from vault lineage and compiles the next round's prompt.
- **Auto-save in `create()` and `advance()`** — every state change (compile, stop, stall, task_complete) writes to vault automatically.
- **`loopforge resume <loop-id>` CLI command** — restore loop from vault and print the next-round prompt.

### MCP Tool Expansion (6 → 8 tools)
- **`loopforge_resume`** — resume a loop from vault after process restart. Returns next-round prompt or stopReason.
- **`loopforge_health`** — standalone loop health check: goal alignment, constraint integrity, drift detection, strategy stability, task continuity.
- **`loopforge_list`** — now scans vault for persisted sessions in addition to in-memory sessions. Shows all loops available for resume after a restart.

### Success Criteria as Hard Constraints
- `compileL2()` now merges `loop_objective.success_criteria` into `constraints_active` alongside `hard_constraints`. Success criteria are tracked, retired, and checked for violations like any other constraint — no longer decorative text.

### Bug Fix
- **`last_technique` was never written** — `loopforge_status` always returned `null` for `technique`. Fixed: `invokeLoopCompile` now writes `this.state.last_technique = response.technique_used`.

### Code Hygiene
- Removed 5 unused imports across `cli.ts`, `loop-compiler.ts`, `backends/fs.ts`.
- Deleted 48 stale build artifacts (36 in `src/`, 12 orphan files in `dist/`).
- Added `.gitignore` patterns for `src/**/*.{js,d.ts,js.map,d.ts.map}`.
- Annotated `globalVaultPath` and `global_vault_path` as `v2: federation (not yet implemented)`.

### New Tests
- 10 new tests: success criteria → constraints_active, session persistence (save/resume round-trip, stopped/stalled states), MCP resume/health/list-vault handlers, status technique fix.

## v1.3.0 (2026-06-26)

MCP Server — Model Context Protocol integration for AI coding agents.

### MCP Server
- **`McpServer`** — JSON-RPC over stdio transport (`node:readline`), handles `initialize` / `tools/list` / `tools/call`
- **`SessionManager`** — manages `Map<sessionId, McpSession>`, each session = one complete multi-round loop with its own `LoopForgeEngine`
- **6 MCP tools**: `loopforge_start`, `loopforge_next`, `loopforge_status`, `loopforge_stop`, `loopforge_list`, `loopforge_replay`
- **`loopforge-mcp` binary** — `npx loopforge-mcp` entry point, registers with `claude mcp add loopforge -- npx loopforge-mcp`
- **Zero new dependencies** — stdlib only (`node:readline`, `node:crypto`)
- **8 existing source files unchanged** — engine, compiler, builder, policy, replay, backends, adapter, runtime all reused directly

### New files
- `src/mcp/session.ts` — SessionManager + advance() cycle (~230 lines)
- `src/mcp/tools.ts` — 6 tool schemas + handler registry (~190 lines)
- `src/mcp/server.ts` — JSON-RPC transport (~100 lines)
- `src/mcp-server.ts` — entry point
- `src/tests/mcp.test.ts` — 9 integration tests

### Modified
- `package.json` — bin `loopforge-mcp`, exports `./mcp`
- `src/index.ts` — exports `McpServer`, `SessionManager`, `McpSession` types

## v1.2.0 (2026-06-26)

Loop Runtime — event-driven autonomous loop driver.

### Loop Runtime
- **`run()` convenience function** — 2 required fields (`task`, `execute`), everything else automatic
- **`LoopRuntime` class** (EventEmitter) — `start()`, `stop()`, `getCurrentRound()`, `getQualityTrajectory()`
- **Heartbeat monitoring** — configurable interval (`heartbeatIntervalMs`, default 30s), emits per-round elapsed/progress
- **Round timeout** — sets `ctx.signal.aborted = true` when `roundTimeoutMs` (default 10 min) exceeded
- **Stall detection** — timeout + `stallGraceMs` (default 5 min) → status becomes STALLED
- **Executor failure breaker** — `maxConsecutiveErrors` (default 3) consecutive `execute()` throws → stop
- **SIGINT/SIGTERM graceful shutdown** — stops loop, cleans up timers
- **Interactive mode** — `interactive: true` disables timeout/stall (human-in-the-loop CLI scenarios)
- **Auto loopId** — derived from task text if not provided

### Removed
- **`autonomous.ts`** — replaced by `runtime.ts`
- **`cmdHookStop`** — removed hook-stop CLI command (runtime replaces hook-based integration)
- **`loopforge/autonomous`** export path — removed from package.json `exports`

### API
- `run(config): Promise<RunResult>` — primary user-facing API
- `LoopRuntime` — advanced class with EventEmitter events: `start`, `round:start`, `round:complete`, `heartbeat`, `timeout`, `stalled`, `done`, `stop`
- 9 new protocol types: `RuntimeStatus`, `RoundContext`, `AgentExecutor`, `StopReason`, `RoundStartInfo`, `RoundCompleteInfo`, `HeartbeatInfo`, `TimeoutInfo`, `HealthWarning`, `RuntimeConfig`, `RunResult`
- `RuntimePolicy` added to `loop_policy.json` — all configurable with sensible defaults

### Tests
- 165 total (was 150). 12 new runtime tests covering: minimal config, task_complete, circuit_breaker, max_rounds, executor_failure, timeout, stall, stop(), heartbeat events, reportProgress, extraction_failure, auto-generated loopId.

## v1.0.0 (2026-06-25)

Initial TypeScript reference implementation of the LoopForge protocol v3.5.

### Core Compiler
- **4-gate hard router**: force_level → first-call/plan_source → goal_id stability → failure/constraint signals
- **L0 Fast Path**: reuses cached prompt from previous round, auto-escalates to L2 when no cache available
- **L1 Patch**: incremental constraint injection with rolling summary context
- **L2 Full Recompile**: technique routing, loop objective anchoring, meta-instruction generation

### Features
- **Constraint Retirement (v3.5)**: auto-retires stale constraints after 3 inactive rounds
- **Rolling Summary (v3.5)**: deterministic cross-round knowledge distillation from last 5 rounds
- **Adaptive Technique Routing (v3.5)**: quality-driven fallback from keyword heuristic
- **Loop Objective Anchoring**: auto-generated at round 1 from task/plan_source, checked every round
- **Task Alignment**: Jaccard-based advisory drift detection (aligned/warn/block)
- **Circuit Breaker**: stalls after 3 consecutive no-improvement iterations

### Storage
- **VaultBackend interface**: pluggable storage abstraction (9 methods)
- **FSBackend**: filesystem implementation with dual-write (JSON vault + Markdown lineage)
- **ReplayBackend**: time-travel queries — getRound, replay, timeline, diff

### CLI
- `loopforge init` — initialise vault
- `loopforge compile` — loop_compile mode (L0/L1/L2)
- `loopforge feedback` — execution recording with quality scoring
- `loopforge replay` — loop timeline with technique/quality history
- `loopforge diff` — field-level round comparison
- `loopforge review` — structural prompt audit
- `loopforge status` — vault health summary

### API
- Zero runtime dependencies — stdlib only (Node.js built-ins)
- Full TypeScript strict mode with declaration files
- Tree-shakeable exports: protocol, compiler, replay, policy, builder, engine, adapter
