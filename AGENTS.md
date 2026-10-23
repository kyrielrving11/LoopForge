# LoopForge agent instructions

This file is the working contract for agents changing this repository. The
root README explains the product; this file records the constraints that code
changes must preserve.

## Non-negotiable rules

- TypeScript only.
- Node.js 18 or newer.
- Zero runtime dependencies.
- The npm package lives in `loopforge/`; its version comes only from
  `loopforge/package.json`.
- Preserve user changes in a dirty worktree.
- Edit `loopforge/src/protocol.ts` before changing protocol fields, then run the
  build to regenerate `loopforge-protocol.json` and `loopforge/dist/`.
- Do not restore MCP Tasks, prompt-technique routing, automatic memory
  discovery, PromptCraft vault writes, Markdown lineage fallback,
  `LoopProjection`/todo/handoff, automatic phase milestones, external-context
  injection, or Agent revision/retraction of operator acceptance.

## Source-of-truth invariants

LoopForge maintains durable cognitive state and an auditable round transaction
for a task the external Agent executes. Work decomposition comes from committed
round facts and Canonical State — never from a parallel notion of progress.

LoopForge has one factual source and one cognitive source.

- The factual source is committed typed round documents in the Vault.
- `CommittedRoundView` is the shared read model over those documents.
- `derivationRounds(entries, N)` is the one history window used by compilation,
  projections, gates, audit, explain, and metrics.
- The cognitive source is `CanonicalLoopState`, compiled from committed facts.
  It is a data projection; LoopForge does not generate plans, todos, phase
  narratives, or handoff summaries.
- Each committed transaction carries `transactionId` and `branchId`. A rollback
  directive is a typed `rollback_directive` event, not a normal round; its
  `transactionId` names the child branch. `resolveBranch` is the one branch
  read model (`branchRounds`, `branchDirectives`, `pendingRollbackDirective`).
- A workspace checkpoint is recovery material, not history. Its authority is the
  `CheckpointRef` inside a transaction snapshot; the content-addressed manifest
  and blobs hold only what HEAD cannot reproduce. `redoRound` in that ref is the
  one branch fence. Checkpoints never feed Canonical State, prompts, acceptance,
  progress or stall.
- Agent conversation history and long-term memory are background, never an
  input. The prompt carries committed current-governance facts only; there is
  no external-context injection or prompt pointer to the state file.
- Replay, Audit, Metrics, and Explain are read-only views. They must not create
  a second history or independent derivation rule.

Relationships use stable IDs, explicit references, normalized-exact text, or a
content hash. Never reintroduce similarity matching or fuzzy identity.
Rejected and in-flight attempts are not committed history. A rollback directive
is never overwritten by its redo; read-only views expose it as an event while
`branchRounds` excludes the abandoned branch.

## Evaluation and submission boundary

The runtime submission boundary is in `loopforge/src/mcp/submission-boundary.ts`
and is applied by `SessionManager.advance`, before session resolution,
queueing, or lease renewal.

The four strict core evaluation fields are:

- `success`: boolean
- `output_summary`: string
- `constraint_violations`: array of strings
- `should_continue`: boolean

Missing or mistyped core fields return `evaluation_invalid`. An invalid
evaluation must not save session state, write the Vault, run verification or
enforcement, increment rejection state, or record metrics. The same `roundId`
can retry the corrected payload.

`loopforge_next` accepts a top-level `recovery: { target_checkpoint_id, reason }`
as a mutually exclusive alternative to `evaluation`. Recovery is a first-class
action, not an evaluation: it requires no core fields, never fabricates one,
and bypasses ordinary verification/enforcement of the abandoned work. It also
requires the held prompt's `roundId` and `transactionId`
(`round_id_required`/`transaction_id_required` otherwise), and the target must
resolve to a checkpoint ref visible through the held transaction or a committed
evaluation transaction on the current branch; invalid targets return
`recovery_invalid`/`recovery_unavailable`/`recovery_disabled` before any
durable effect. The checkpoint manifest records the complete Git fingerprint
boundary; LoopForge executes and verifies the restore, then issues the redo
prompt. The target is a recovery point, not a success claim: error-level
verification findings on its round do not disqualify it. The Agent's reason is
recorded verbatim and rendered in the Recovery Brief as report-only data, never
as a LoopForge instruction. `loopforge_checkpoint` creates an explicit mid-round
savepoint with the same three anchors; it adds no round, commit or progress.
The transaction snapshot's `CheckpointRef` is the ONE authority for a
checkpoint's visibility, ownership and redo round; a manifest alone is never a
restore point. Checkpoints never enter `CanonicalLoopState`, prompt governance,
acceptance, progress or stall. Operator criteria and hard constraints are immutable:
`revised_success_criteria` is retired, and `retracted_constraints` may only
name an active Agent-discovered constraint (including a discovery preserved by
a committed rollback directive). Resolution accepts the `c-` id or
normalized-exact text. Operator/plan targets are `evaluation_invalid`
(`immutable_constraint` / `not_retractable`); unknown/inactive/already-retired
targets are inert no-ops with a diagnostic, never receipt effects. There is no
rolling `retire_window`.

Optional fields are normalized and lenient. Four are structural exceptions —
`subgoal_updates`, `round_contract`, `contract_transition`, and
`execution_report.contract_item_claims` — validated BEFORE advance against the
same derived set the agent was shown, and rejected rather than normalized
(`contract_invalid` for contract shape, limits, command bindings, references,
duplicate item IDs, or transition target/successor conflicts). Everything else —
`criterion_claims`, worker results, `gate_ids` — is advisory, and malformed
entries are dropped. `scope` is deliberately NOT structural: it is optional,
report-only intent, normalized leniently and never rejected.

No optional value is dropped silently. `normalizeSelfEvaluation` returns a
stable diagnostic list (field path, reason code, handling, correction) and the
known submitted-field manifest. Unknown and retired fields are diagnosed and
dropped; they are never treated as accepted. Valid submissions persist their
diagnostics and manifest in the transaction snapshot. Strict failures return
the same diagnostic vocabulary for that attempt only and still happen before
any persistence or side effect. `worker_results.discoveredConstraints` is a
REPORT: only top-level `discovered_constraints` promotes a finding into the
global constraint stream.

Field accounting separates **attempted** from **retained**. `submittedFields`
is the attempted manifest: known paths present in the raw payload.
`deriveFieldAccounting` derives the retained set at read time from the persisted
manifest, diagnostics and normalized evaluation; it never re-parses the raw
payload and is never persisted. A committed transaction always carries its
manifest. A field is retained when it was attempted, has no exact-path
whole-field drop, and carries a value; a partial array loss remains retained
with its diagnostic visible. `attemptedFieldUsage` and `retainedFieldUsage` are
separate metrics; `retainedFieldUsage` is the adoption metric and must be shown
with its round coverage, never as a bare count.

`criterion_claims` references are matched against the criterion set the compile
rendered: a real `cr-` id or the exact normalized text. A reference the prompt
did not render is dropped with a diagnostic (`unknown_id`, or
`all_entries_dropped` when none survive), never a rejection. An unobservable
reference space fails open; an observed empty one drops every claim. The
display cap does not narrow validation.

`loopforge_start.criteria` declares the initial success criteria; they become
the objective's criteria and therefore the stable `cr-*` anchors. An empty,
duplicate (normalized-exact), or over-limit entry is diagnosed, never silently
stored; omitting the field keeps the default criterion, and a round-1 retry
recovers the initial objective from that round's persisted lineage.

Contract references are stricter than claims: `criterion_refs` must be real
`cr-*` ids from the ACTIVE criterion set the prompt rendered, and
`subgoal_refs` must name an active compiled `sg-*` shown in the current prompt
— same-round `emerged_subtasks` are referenceable only next round. Free text,
unknown ids, duplicate refs, and duplicate normalized item content are
`contract_invalid`. `CriterionMachineFact`/`VerifiedSubGoalFact` derive only
from real ids; there is no text-hash fallback.

A success claim with an empty/missing `execution_report` is a reporting gap
(warn), never an acceptance gate: acceptance is decided by machine evidence and
contract rules, not optional-field coverage. The machine-evidence warn still
keeps an unbacked success out of the success trajectory.

Reference spaces fail open only when they cannot be observed (`null`). An
observed session with no active contract is an empty reference space, not an
unobserved one.

## Round lifecycle invariants

All mutations follow:

```text
SessionManager -> RoundLifecycle -> RoundDriver -> RoundCoordinator
```

- A valid submission collects before/after evidence, validates the transaction,
  runs verification and enforcement, then applies one disposition.
- Accept or stop commits the transaction and evidence.
- Reject keeps the logical round ID, increments the attempt, and commits no
  round.
- Agent recovery or machine backtrack commits a `rollback_directive` event with
  `origin`, `reason`/`trigger_rule`, a checkpoint target (id + content hash +
  redo round), skipped files and preserved discoveries. It sets the session
  cursor to `target.redo_round`, then LoopForge executes and verifies the
  restore against the checkpoint manifest's complete Git boundary and the
  recorded HEAD. Only after verification does it compile the redo prompt; a
  failed restore persists `stalled` with no prompt and `resume` retries the
  SAME directive. The directive event is never overwritten; the redo is a
  normal evaluation on the child branch. A restore is not round progress and
  never satisfies a redo-time verification check.
- Terminate returns a terminal result without committing the rejected or
  terminating evaluation as a normal round.
- Stop decisions prioritize an explicit blocked declaration. `completed`
  requires effective success and a verified contract, or no active contract.
  A blocked or contradicted contract cannot produce `completed`.
- One definition of "this round declares itself blocked" serves every stop
  decision and the contract-closure reducer. Scope drift has no waiver and no
  enforcement path.
- The completion-truth guard runs before the transaction commits and again at
  the lifecycle end. A violation is a code defect: it downgrades to `blocked`
  and reports, rather than throwing.

Round IDs prevent lost responses and duplicate submissions; `transactionId`
(plus `branchId`) prevents a deep redo from replaying an abandoned commit at
the same numeric round. Transaction recovery must remain idempotent after
process interruption.

## Evidence and contract invariants

Verification checks are pure functions of their inputs. The enforcement gate
executes one ordered `rules` array; that array is the ONE priority order.
`RULE_TABLE` is a per-check ladder lookup, not an execution order. A row owns
its escalation ladder. Do not add a category field or revive numbered rule
semantics.

Agent reports are claims, never machine evidence. A success claim needs an
independent machine observation, normally a passed after-phase command whose
entrypoint and configuration are untampered. `no_change_reason` is an escape
only when no verification command is configured.

Progress is a set of reported FACTS, each with an explicit coverage range
(`ProgressCoverage { domain, object, scope, version }`). There is no global
provider vote: a rule passes an explicit `(kind, coverage)` selector and only
exactly matching facts participate. Git keeps its complete-boundary/HEAD rule;
a custom provider declares `progressCoverage` and persists a nested
`ProgressSnapshot` (inner schema 2) with the declared coverage, a completeness
flag and a 64-hex fingerprint; failures carry the same coverage with
`complete:false` and a null fingerprint. Command observations never provide
progress. Any selected `changed` wins; a selected `unknown` blocks an
"unchanged" verdict; a required coverage with no fact while another required
coverage has one is `unknown`; no matching fact at all is `not_applicable`.
`"any"` is display-only and MUST NOT drive a governance or prompt-density rule.
A stall requires BOTH the committed lookback window and the submitted round to
be `unchanged` under the fixed Git workspace coverage
(`STALL_PROGRESS_COVERAGE`); `unknown`/`not_applicable` never stall, and no
Agent report can create or cancel a stall. Prompt freshness uses the SAME Git
selector, so a custom provider cannot pin the loop at L1. Entrypoint trust,
files reconciliation, `evidenceIncomplete`, and contract-item Git checks remain
Git-specific and are never replaced by a generic progress signal. Scope drift
remains a Git-specific INFO report only.

The entrypoint check has two arms, unioned. The absolute arm compares each
entrypoint file's current content against a trusted baseline captured from the
FILESYSTEM when the round was prepared — git cannot see a gitignored
entrypoint, and a baseline re-derived from the current tree would compare
tampered state against itself. The baseline lives in session state, never in
committed round history; it is seeded only for a round being PREPARED, never
for a same-round retry, and its absence means "no absolute arm", never a lost
round. An entrypoint created during the round cannot back that round: restore
it, or take the rollback so the work is redone where it is part of the
starting state. Repeated non-restoration backtracks; it does not terminate.

Every configured evidence provider emits one typed observation, including
`unavailable`, `timeout`, `error`, or `aborted`. Do not silently filter failed or
unavailable observations. Transactions persist before/after observation
collections; the round delta is derived.

The Git observation is the COMPLETE boundary: every tracked path plus every
non-ignored untracked path, content-fingerprinted (regular file, symlink link
text, gitlink index commit, directory, missing, unreadable). The round delta is
the union-key comparison of the before/after maps — never the dirty-files list,
and never a re-read of the last commit. `execution_report.files_changed` uses
the same boundary meaning, including deletions; a commit alone adds no entry
when content is unchanged. An unavailable/timeout/error/aborted boundary is
unobservable and fails open; it must not read as an empty diff or an agent
omission. Gitignored paths and submodule contents are outside the declared
coverage; the filesystem entrypoint-trust baseline remains independent.

`MachineObservation.files` is observation-local display data: the Git dirty
list, always-empty command files, or provider-defined custom metadata. It is
never the round change set. The derived `ObservationDelta.changedFiles` is the
only change set. `[]` is an observed no-change; `null` is unknown and must never
be read as empty or as a pass. Git has three states: `not_applicable` (no Git
provider participated), `unknown` (a Git boundary pair cannot be compared), and
`observed`. A contract item requires `observed`; `unknown` makes a passed
command `insufficient`, while `not_applicable` leaves the entrypoint arm out.
Stall motion is tri-state: HEAD movement can prove motion, but unknown files
with no HEAD evidence produce no verdict. `evidenceIncomplete` is true for a
no-baseline Git round.

Round Contract rules:

- A proposal is item-based and becomes active only after its declaring round
  commits.
- v3.9.6: `work_item` is the bounded deliverable this slice produces (an
  outcome, not an activity). New declarations must provide it, non-empty and
  <=200 chars, at the strict boundary; the persisted type stays optional so
  legacy committed contracts remain readable.
- v3.9.9: `scope` is optional, report-only Agent intent. It takes part in
  contract content identity (a restated route is a new declaration), but it
  grants no permission, is never containment-checked, and never rejects a
  contract. Drift is an `info` fact only.
- `items[]` are acceptance conditions, not a task checklist. Each item binds
  its own `verify_with` commands; one condition may use several commands and
  one command may back several conditions. `verify_with` never moves to the
  contract/work_item level. There is no work_item-level claim: the contract is
  verified only when every item is verified (or a blocked round closes it).
- LoopForge validates structure, configured/enabled/after-capable command
  bindings and references. It never judges whether a
  `work_item` sounds like a deliverable, whether an item matches a command
  semantically, or whether a command is the "right" acceptance test. That is
  Agent/operator semantic judgment.
- Unknown top-level contract fields and unknown item fields are
  `contract_invalid`; a top-level `verify_with` is not a second binding site.
- Each item has at least one configured, enabled, after-capable evidence
  command.
- Contract and item IDs are content-addressed; restating an unchanged contract
  preserves identity.
- Item states are `pending`, `insufficient`, `contradicted`, or `verified`.
- `verified` requires a `met` claim and every bound command passing in the
  closing round with the declaration's binding intact.
- Closure priority is `blocked > superseded > verified > open`. A contract
  closes when every item is verified, a round reports `outcome: "blocked"`, or
  the Agent submits an explicit `contract_transition` whose target is THAT
  contract. A superseded contract keeps every item status for audit, activates
  its successor next round, never restores the workspace, and its round cannot
  be `completed`.
- `contract_transition` is legal only while an active contract exists; it
  requires `contract_id` (the exact active `rc-*` id), the successor
  `round_contract` in the same evaluation, changed acceptance items, no blocked
  declaration, and `should_continue=true`. A stale/other target, missing
  successor, blocked conflict, stop conflict, invalid kind, over-long reason,
  unknown field, or unchanged items is `contract_invalid`. The successor takes
  effect next round; this round's item claims may only cite the old contract.
- A different proposal while the active contract is open is ignored and
  surfaced as `contract_premature` — unless a valid transition targets the
  active contract, in which case it is the effective successor.
- A claimed-but-unbacked item is recorded as verification debt, escalated
  after a bounded run of rounds and counted on the same check's streak only. A
  superseded contract with NO `met` claim on its items produces no debt
  finding (honest abandonment); a round that still claims an old item `met`
  keeps the finding and the streak.
- `round_scope_drift` is an `info` report-only fact. It never rejects,
  terminates, backtracks, stalls, or reaches the rejection counter. A persisted
  `round_scope_drift` rejection streak from an older runtime is drained, so it
  cannot trigger the `max_rejections` catch-all.

The live coordinator, explain, and audit share one contract derivation, and
verified sub-goal facts read the whole committed history so they survive
contract closure.

## Prompt and projection invariants

Memory boundary: the prompt is a current-governance projection, not a
narrative of recent work. `output_summary` remains a strict committed report
for audit/replay/explain/backtrack, but it is never a default prompt input,
never a projection focus, and never machine evidence. `Recent Rounds`,
`Cross-Round Outcomes`, `Full Rehydrated State`, agent `Discoveries`, and
retired/failed-pattern history do not render in prompts; they remain in the
derived state file and read models. There is no prompt `Phase`/`Phase Anchors`
section and no LoopForge-generated milestone narrative; `compression_checkpoint`
is only an Agent declaration and L2 boundary reason. The fixed prompt header
carries a static authority boundary: LoopForge's current committed projection
wins for committed/verified state; Agent memory/session history is background
and may contain unsubmitted, rejected or rolled-back work; a current user
instruction defines the task. `state_file_content` remains a derived view; the
prompt may point at it as an optional history view but must label it derived
and must never call it the source of truth. `Corrections` is committed
`wrong_assumptions` only, rendered verbatim as an Agent report; fallback
`last_round_result` narrative, `prompt_requests`, agent-reported blockers,
discoveries, progress evidence and remaining criteria do not become durable
prompt/state projection input. `emphasize` moves current governance objects
(active constraints/criteria, contract/items, active sub-goals, current
findings, recovery brief) by real id or normalized-exact text; closed or
historical objects never resurrect.

`submission-guidance.ts` is the single source for evaluation-field meaning,
applicable events, legal examples and downstream effects. The tool schema,
the prompt's evaluation block, `submission_guidance` and the receipt all read
it; none owns a second copy. Prompt examples may cite only real ids rendered by
the current prompt or the live guidance — never a fabricated `sg-`/`rci-` id.

The prompt's evaluation block uses a compact trigger checklist built from the
same `GUIDES` table. `isFieldApplicable` is the one semantic applicability rule
and is independent of prompt level. `compact` is the only marker of
compact-checklist membership; `isFieldPrompted` is that marker plus
applicability. There is no hand-maintained optional-field list and no
level-specific field subset. Real criterion ids/text come from the compile's
`criterion_statuses`; the full legal shapes remain in `submission_guidance`.
Optional fields are opportunities, not a coverage checklist — omission stays
correct. `round_contract`, `contract_item_claims` and `subgoal_updates` keep
their dedicated renderers with real ids and are never compact members.

Previous-round facts are read from committed history, never from the MCP
request. One `PreviousRoundFacts` bundle (`CommittedRoundView` projection,
committed verification flags, `derivePromptFreshness`) feeds the level policy,
canonical state and the evaluation block. `request.last_round_result` is only
the in-flight/library fallback when no committed view exists. `derivePromptFreshness`
is pure and unpersisted: motion is the shared Git rule over every Git delta,
activity is an attributable after-phase command, and evolution is a committed
semantic declaration. `observableNewInformation` is false only when the
machine PROVES no activity; `null` (unknown) never downgrades to L0.
`prompt_requests` remains applicable in an L0 submission; only a NEXT prompt
that is L0 ignores the incoming requests.

`submission_guidance` and `submission_receipt` are read-only projections of
current/committed facts. They are not persisted as a second ledger. The
receipt separates saved reports, derived-state effects and machine verification;
a rejected/terminated attempt is `not_applied`, and a backtrack reports only
what it actually preserved. `submission_receipt.files_reconciliation` is the
one reported-vs-observed comparison (`deriveFilesReconciliation`) over the
shared `ObservationDelta.changedFiles`: exact path sets, `[]` = observed no
change, `null` = unknown, and `unknown`/`not_applicable` never become a
mismatch. The verification gate and the receipt use the SAME `submittedFields`
attempt basis: an omitted `files_changed` with Git-observed changes is an
`evidence_integrity` mismatch in both projections, never silence in one and a
mismatch in the other. It is receipt-only and never next-prompt input; the
next-round fix item comes from the committed verification flag, which is the
one machine-finding channel. `VerificationFlag.ref` names the concrete
command/path/stable id where one exists and is rendered by every finding
surface. `promptRequestEffects` records what the CURRENT prompt did — it must
never be read by compile or decision code as an instruction for a later
prompt.

L0, L1, and L2 select prompt density only. L0 is a same-round retry, or a
committed failed round whose freshness derivation PROVES no machine activity
and no declared evolution. An unobservable boundary stays L1. L2 is entered
for factual round conditions such as first round, plan boundary, deep or
shallow committed recovery, machine contradiction, checkpoint boundary, or
repeated rejection; there is no round-count timer. The Recovery Brief and the
recovery boundary share `pendingRollbackDirective` (matched by
`target.redo_round`), and objective/constraint evolution is bounded by the
compile window so an abandoned branch cannot leak into the redo prompt.

Every level renders the same protected normative entry set: the active
criteria, every active constraint (hard and other), the active contract and
all its items, every active sub-goal id, every current verification finding,
and the committed recovery brief. Display caps may drop descriptions but
never ids (the sub-goal overflow line keeps them). Optional narrative
sections carry no normative id. `partitionActiveConstraints` is the one
criteria/hard/other split; prompt, state file, and guidance consume it.
There is no silent active-constraint cap.

`PromptArtifact` schema 6 carries `coverage`: the active ids derived from the
same `CanonicalLoopState`, the ids the included sections declared, and any
omission. Every normative section is protected, so an omission is a `defect`,
never a level/budget decision. Coverage is per-artifact output, never a
decision input or a second fact source. A missing active id fails closed:
`ProjectionCoverageError` is rethrown by `invokeLoopCompile` (never converted
to `prompt: null`) and mapped to the non-retryable `projection_incomplete`
tool code. The prompt is never rewritten after artifact creation; a backtrack
recovery brief is a protected section inside the artifact, so the delivered
prompt equals `renderedPrompt` on every path.

One fixed section-priority table owns prompt assembly. Mandatory sections are
protected: they render first and are never dropped or truncated. Optional
sections are removed strictly from lowest priority first, with at most one
partial optional section. If the protected set exceeds the budget, render it
and record the overflow on the artifact.

The prompt artifact records the current prompt only. It must not encode what a
later prompt should do. An unparseable artifact, an unsupported transaction
or observation schema, or a missing embedded transaction snapshot is a
hard break that is reported, never silently discarded.

The optional state file is derived from committed facts and is regenerated
without depending on prompt level. Its verified sub-goals are forwarded from
the same cognitive derivation used by canonical state.

## Storage and integration invariants

Round documents carry `sequence === round`; missing or unstamped rounds are
corruption or recoverable gaps and must be reported. Derived state is separate
from committed rounds and from the session document. Round transaction schema 5
is the current envelope; schema 4 and earlier are reported as legacy, never
migrated. Observation versions are per kind: Git 2, command 1, custom base 1
with the nested progress snapshot at inner 2. A custom round without progress
remains readable; inner-1 snapshots and the retired `progressCapable` marker
are reported as observation legacy. One `observationVersionIssue` judgment is
shared by the collector, the transaction parser and the legacy reporter.
Workspace checkpoint manifests/blobs live under the runtime state directory
(`checkpoints/`, `objects/`), never inside the restored boundary.

Writes are atomic and protected by owned locks. MCP mutations are serialized per
session and fenced by renewable cross-process leases. Command evidence is
disabled by default, uses an executable plus arguments with `shell: false`, and
is restricted to the workspace. One capability derivation serves preparation,
MCP views, and `doctor`; registry readiness and live statuses do not enter
state or prompt hashes.

The store lock's three staleness rules are three DIFFERENT rules — ownerless
lock directory, dead owner, and Windows EPERM — each named separately with its
own reason. The wait budget must exceed the dead-owner grace, and it must fail
fast for a live owner. Attempts sleep between retries; the loop is never a CPU
spin.

Policy loading distinguishes "no file" from "defective file": ENOENT falls
through to the defaults, while unreadable, unparseable, or non-object
content throws with the stable `policy_invalid` code and the file path. The
`--target` flag selects the client skill location only; `--workspace` is the
runtime boundary and sets `process.cwd()` before any runtime object is
constructed.

The MCP server is synchronous JSON-RPC over stdio. Public tools are
`start`, `next`, `checkpoint`, `status`, `stop`, `pause`, `resume`, `replay`,
`gate_check`, and `gate_resolve`; gate tools are hidden and return
`gate_disabled` unless `policy.gate.enabled` is true. `next` and `checkpoint`
require `sessionId`, `roundId` and `transactionId`; recovery additionally names
`target_checkpoint_id`. Tool responses use the uniform `{ok}` envelope with a
stable error `code` and separate human `message`.

The policy schema version is a boundary: unknown keys or a mismatched version
are `policy_invalid`, and the version moves whenever the key surface changes.
Never merge an invalid policy over the defaults.

## Required commands

Run from `loopforge/`:

```bash
npm run check
npm run build
npm test
npm pack --dry-run --json
npm run verify:artifacts
git diff --check
```

Use a temporary clean mirror when `verify:artifacts` needs a HEAD comparison in
a dirty worktree. `npm pack --dry-run` runs `prepack` (`verify:artifacts` +
build), so in a dirty worktree run the inventory with `--ignore-scripts` and
run the scripted prepack in the clean mirror.

## Hotspot checklist

- Prompt changes: cover budgets, hashing, density levels, same-round retry,
  protected overflow, deterministic truncation, rendered-vs-dropped priority,
  and identical-input determinism.
- Memory-boundary changes: cover no `output_summary`/recent-round/full-state
  prompt narrative, committed-only Corrections/blockers/prompt_requests,
  Phase Anchors without outcomes, authority-header presence at L0/L1/L2,
  state-file-derived wording, no dangling state-file pointer, and that
  emphasize cannot resurrect removed history.
- Contract-semantics changes: cover required work_item, optional/report-only
  scope (lenient normalization, no containment rejection), item-level
  verify_with, unknown fields, length boundaries, semantic non-validation,
  `contract_transition` target/successor/stop/blocked/item-change validation,
  closure priority `blocked > superseded > verified > open`, successor
  activation next round, and prompt/state hierarchy rendering with rc-/rci-
  coverage.
- Prompt-coverage changes: cover the identical L0/L1/L2 active id set, every
  active id in the delivered prompt, sub-goal id overflow, emphasize moves
  into Critical Context, contract closure, recovery facts, and the
  `ProjectionCoverageError` → engine rethrow → `projection_incomplete`
  envelope chain. Assert `prompt === prompt_artifact.renderedPrompt`.
- Strict-relation changes: cover free-text/unknown/duplicate `criterion_refs`,
  non-displayed and same-round emerged `subgoal_refs`, duplicate normalized
  items, and fail-open only when the compile response is unobservable.
- Field-decision changes: cover the compact trigger checklist (max seven
  fields), level-independent applicability, the explicit `compact` marker,
  real `cr-` ids and texts, the same L0/L1/L2 trigger set, no fabricated ids,
  and omission-stays-correct.
- Prompt-level changes: cover committed-fact freshness (motion true/false/
  null × command activity × declared evolution), unknown-never-downgrades,
  live-vs-resume determinism, retry-attempt restoration, and deep-restore
  recovery.
- Criterion-claim changes: cover real-id and exact-text matches, unknown
  references dropped with diagnostics, partial/all drops, fail-open on an
  unobservable reference space, and an observed-empty space.
- Policy changes: cover schema version and unknown-key rejection.
- Protocol or evaluation changes: cover schema, handlers, lifecycle, malformed
  input, same-round retry, and unchanged state.
- Transaction changes: cover reject, backtrack, replay, concurrent next,
  pause, stop, and restart.
- Evidence changes: cover timeout, abort, unavailable provider, output caps,
  workspace boundaries, and contradictions.
- Files-reconciliation changes: cover match/mismatch/unknown/not_applicable,
  omitted vs explicit-empty reports, duplicate reported paths, multiple Git
  deltas, exact-path semantics, gate/receipt/metrics agreement, and live vs
  committed rebuilds.
- MCP changes: cover primitive JSON arguments, strict core arguments,
  structured output, uniform envelopes, stable error codes, and stdio.
- Contract changes: cover identity stability, item statuses, verified-fact
  survival after closure, coordinator/explain/audit agreement, and
  `contract_invalid` retry.
- Stop-reason changes: cover explicit blocked plus success and contradicted
  item plus success; `completed` must remain machine-true only.
- Scope-drift changes: cover the info-only severity (never reject, terminate,
  backtrack, stall, or count toward a rejection streak), lenient optional scope
  parsing/diagnostics, declared-intent rendering, and a retired
  `round_scope_drift` streak not reaching the `max_rejections` catch-all after
  an upgrade.
- Entrypoint-trust changes: cover a modified entrypoint, one created during the
  round (including a gitignored one git cannot see), restoration making the
  same round pass, backtrack on repeated non-restoration, a corrupt or absent
  baseline degrading to the git-delta arm, and the baseline surviving a
  restart.
- Store-lock timing changes: cover a lock left by a process that died moments
  ago being reclaimed, a live owner still failing fast, the ownerless grace,
  and the lock's release staying ownership-checked.
- Stall-detection changes: cover Git unchanged/HEAD-only motion, coverage
  changes/version changes/missing sides/incomplete snapshots as `unknown`, a
  custom provider changed/unchanged/unknown never affecting the Git-only
  selector, a forged Git coverage on a custom provider remaining ineligible,
  multi-selector ALL semantics, an unobservable window or submitted round
  yielding no verdict, the submitted round's own change excusing a stalled
  window, a round that moved nothing keeping the verdict, and the deadlock
  guard still terminating a stalled round that a rollback already moved.
  Prompt freshness must share the same Git selector.
- Provenance/retraction changes: cover operator precedence, discovery round,
  retirement then rediscovery, abandoned-branch exclusion, preserved rollback
  discoveries, c-id and normalized-text retraction, unknown/same-round/operator
  /plan outcomes, and live-vs-committed receipt agreement.
- Emphasis changes: cover every current object kind, real-id and exact-text
  matching, unknown/closed targets, no duplication, contract whole-block vs
  item moves, sub-goal overflow counts, finding/retry-section filtering, and
  coverage completeness.
- Checkpoint/restore changes: cover content-addressed capture (dirty tracked,
  untracked, deleted, symlink, executable, non-ASCII), clean-tracked content
  not stored, manifest/id/hash stability and tamper failure, path traversal and
  `.git`/state-dir refusal, HEAD equal/ancestor/descendant/diverged, exclusive
  file writes, post-restore exact boundary equality, directive persistence,
  stalled-after-failed-restore, restart/resume retry, and the redo's verified
  `restore` marker. A restore must never count as round progress.
- Diagnostics changes: cover unknown/retired fields, wrong types, caps,
  truncation, deterministic order, the strict-error vocabulary, unchanged
  state after a same-round retry, and the attempted→retained invariant for
  every field (partial loss, explicit empty, whole-field drop, truncated
  diagnostics).
- Field-accounting changes: cover metric coverage, receipt labels, and the
  absence of any second retained ledger.
- Observation-delta changes: cover before-only/after-only, missing before,
  non-observed statuses, malformed fingerprints, duplicate keys, non-Git
  providers, clean-worktree commits, unknown vs observed-no-change, custom
  base schema 1 + progress inner schema 2, legacy inner-1/progressCapable
  reporting, and synthetic observations using the same per-kind version table.
- Guidance/receipt changes: cover no fabricated ids, real contract/sub-goal
  ids, rejected/terminated `not_applied`, backtrack only-preserved facts,
  lost-response replay, and report-vs-verification separation.
- Boundary-observation changes: cover a committed change, amend/HEAD move,
  deletion, rename, pre-existing dirt unchanged/changed, non-ASCII path,
  gitignored coverage, non-repository, timeout and no silent omission.
- Read-view changes: every new projection consumes `readOnlyRounds` and the
  existing `derive*` functions; unsupported envelope versions are reported,
  never dropped silently.
